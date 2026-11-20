#!/usr/bin/env python3
"""Build immutable OPA artifacts and activate only verified load sets.

Python 3 standard library. Docker and Compose are required only for activation.
Secrets stay in the host env file and never appear in command arguments/output.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
VERSION = "1.21.1"
SAFE_BUILTINS = set("""abs all any array.concat array.reverse array.slice bits.and bits.lsh bits.negate
 bits.or bits.rsh bits.xor ceil concat contains count endswith eq equal floor format_int
 glob.match gt gte indexof is_array is_boolean is_null is_number is_object is_set
 is_string json.is_valid json.marshal json.unmarshal lower lt lte max min minus mul
 neq numbers.range object.filter object.get object.keys object.remove object.subset
 object.union object.union_n plus product regex.find_n regex.is_valid regex.match
 regex.replace regex.split rem round set_diff sort split sprintf startswith substring
 sum to_number trim trim_left trim_prefix trim_right trim_space trim_suffix type_name
 upper walk internal.member_2 internal.member_3
""".split())


def run(command, cwd=None, check=True):
    result = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        # Commands contain no credentials. Synthetic rule errors are safe to show.
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(map(str, command))}\n"
                           + result.stdout[-6000:] + result.stderr[-6000:])
    return result


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value, mode=0o644):
    atomic(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode(), mode)


def atomic(path, content, mode=0o644):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(content)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def digest_tree(path):
    return {str(p.relative_to(path)): sha(p) for p in sorted(path.rglob("*")) if p.is_file()}


class Opa:
    def __init__(self, args):
        self.binary, self.image = args.opa_binary, args.opa_image

    def call(self, args, directory):
        if self.binary:
            command = [str(Path(self.binary).resolve()), *args]
        else:
            command = ["docker", "run", "--rm", "--network", "none",
                       "--user", f"{os.getuid()}:{os.getgid()}",
                       "-v", f"{directory}:/work", "-w", "/work", self.image, *args]
        return run(command, cwd=directory).stdout

    def version(self, directory):
        result = self.call(["version"], directory)
        if f"Version: {VERSION}\n" not in result:
            raise RuntimeError(f"Expected OPA {VERSION}; found: {result.splitlines()[0]}")
        return result


def init_auth(root):
    target = root / "config/opa/authz"
    if target.exists():
        if digest_tree(target) != digest_tree(HERE / "authz"):
            raise RuntimeError("Installed authz differs; explicit reviewed authz upgrade required")
    else:
        shutil.copytree(HERE / "authz", target)
    return target


def validate_source(source):
    if not source.is_dir() or any(p.is_symlink() for p in source.rglob("*")):
        raise RuntimeError("Source must be a directory with no symbolic links")
    manifest = read_json(source / ".manifest")
    release = manifest.get("revision", "")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", release):
        raise RuntimeError("Revision must be a lower-case Rego identifier, maximum 64 characters")
    if manifest.get("roots") != [f"hsbc/releases/{release}"] or manifest.get("rego_version") != 1:
        raise RuntimeError("Bundle requires exactly its own hsbc/releases/<revision> root and Rego v1")
    probes = read_json(source / "probes.json")
    if not isinstance(probes, list) or len(probes) < 3:
        raise RuntimeError("At least three synthetic positive/negative/undefined probes are required")
    if not any(p.get("undefined") is True for p in probes):
        raise RuntimeError("An undefined-result probe is required")
    for probe in probes:
        if not isinstance(probe.get("name"), str) or not isinstance(probe.get("input"), dict):
            raise RuntimeError("Each probe requires a name and an object input")
        if ("result" in probe) == (probe.get("undefined") is True):
            raise RuntimeError("Each probe requires exactly one expected result or undefined=true")
    return release, probes


def prepare(args, root, opa):
    source = Path(args.source).resolve()
    release, probes = validate_source(source)
    releases = root / "policies/releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = releases / release
    if final.exists():
        previous = verify_artifact(final)
        if previous["source_hashes"] != digest_tree(source):
            raise RuntimeError("Immutable release already exists with different source")
        print(f"Already prepared and verified: {release}")
        return
    init_auth(root)
    temporary_root = root / "tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="opa-build-", dir=temporary_root) as directory:
        stage = Path(directory)
        os.chmod(stage, 0o755)
        shutil.copytree(source, stage / "source")
        shutil.copytree(HERE / "authz", stage / "authz")
        shutil.copytree(HERE / "tests", stage / "authz-tests")
        version = opa.version(stage)
        caps = json.loads(opa.call(["capabilities", "--current"], stage))
        caps["builtins"] = [b for b in caps["builtins"] if b["name"] in SAFE_BUILTINS]
        caps["allow_net"] = []
        write_json(stage / "capabilities.json", caps)
        opa.call(["check", "--strict", "--capabilities", "capabilities.json", "source"], stage)
        tests = json.loads(opa.call(["test", "--format=json", "--fail-on-empty", "--ignore=probes.json", "--capabilities",
                                     "capabilities.json", "source"], stage))
        auth_tests = json.loads(opa.call(["test", "--format=json", "--fail-on-empty",
                                          "authz", "authz-tests"], stage))
        if not tests or not auth_tests or any(t.get("fail") or t.get("error") for t in tests + auth_tests):
            raise RuntimeError("OPA tests must execute and all pass")
        opa.call(["build", "--bundle", "source", "--capabilities", "capabilities.json",
                  "--ignore=*_test.rego", "--ignore=probes.json", "--output=bundle.tar.gz"], stage)
        for probe in probes:
            write_json(stage / "input.json", probe["input"])
            actual = json.loads(opa.call(["eval", "--bundle", "bundle.tar.gz", "--format=json",
                                         "--input", "input.json", f"data.hsbc.releases.{release}.decision"], stage))
            results = actual.get("result", [])
            if probe.get("undefined"):
                passed = not results
            else:
                passed = bool(results) and results[0]["expressions"][0]["value"] == probe["result"]
            if not passed:
                raise RuntimeError(f"Built-bundle probe failed: {probe['name']}")
        output = stage / "release"
        output.mkdir()
        for name in ["bundle.tar.gz", "capabilities.json"]:
            shutil.copy2(stage / name, output / name)
        shutil.copytree(source, output / "source")
        write_json(output / "probes.json", probes)
        write_json(output / "tests.json", {"policy": tests, "authorization": auth_tests})
        (output / "opa-version.txt").write_text(version)
        metadata = {
            "release_id": release, "opa_version": VERSION,
            "decision_path": f"v1/data/hsbc/releases/{release}/decision",
            "bundle_sha256": sha(output / "bundle.tar.gz"),
            "source_hashes": digest_tree(source),
            "files": digest_tree(output),
            "demo_only": release.startswith("demo_"),
        }
        write_json(output / "manifest.json", metadata)
        # Rename atomically on the same /data filesystem; never overwrite.
        if final.exists():
            raise RuntimeError("Release was created concurrently")
        os.rename(output, final)
        for path in final.rglob("*"):
            os.chmod(path, 0o555 if path.is_dir() else 0o444)
        os.chmod(final, 0o555)
    print(f"Prepared immutable release: {release}; sha256={metadata['bundle_sha256']}; tests={len(tests) + len(auth_tests)}")


def verify_artifact(directory):
    metadata = read_json(directory / "manifest.json")
    if metadata["release_id"] != directory.name or metadata["opa_version"] != VERSION:
        raise RuntimeError("Release or engine version mismatch")
    for relative, expected in metadata["files"].items():
        path = directory / relative
        if not path.is_file() or path.is_symlink() or sha(path) != expected:
            raise RuntimeError(f"Artifact hash mismatch: {directory.name}/{relative}")
    if sha(directory / "bundle.tar.gz") != metadata["bundle_sha256"]:
        raise RuntimeError("Bundle hash mismatch")
    return metadata


def paths(root):
    return [root / "config/opa/registry/.manifest", root / "config/opa/registry/data.json",
            root / "deploy/compose.opa-loads.json", root / "config/opa/approved.json"]


def load_approved(root):
    file = root / "config/opa/approved.json"
    return read_json(file)["releases"] if file.exists() else []


def compose(root, args, command):
    return run(["docker", "compose", "--project-directory", str(root / "deploy"),
                "--env-file", str(root / "deploy/.env"), "-f", str(root / "deploy/compose.yaml"),
                "-f", str(root / "deploy/compose.opa-loads.json"), *command])


def write_loadset(root, releases):
    write_json(root / "config/opa/registry/.manifest",
               {"revision": "hsbc-loadset-v1", "rego_version": 1, "roots": ["hsbc/deployment"]})
    write_json(root / "config/opa/registry/data.json", {"hsbc": {"deployment": {"releases": releases}}})
    command = ["run", "--server", "--addr=0.0.0.0:8181", "--authentication=token",
               "--authorization=basic", "--skip-version-check", "--log-level=error",
               "--bundle", "/config/authz", "/config/registry"]
    command += [f"/releases/{r['release_id']}/bundle.tar.gz" for r in releases]
    write_json(root / "deploy/compose.opa-loads.json", {"services": {"opa": {"command": command}}})


def assert_pinned(image):
    if not image or not re.search(r"@sha256:[0-9a-f]{64}$", image):
        raise RuntimeError("Activation requires OPA_IMAGE and NODE_IMAGE pinned by sha256 digest")


def verify_running(args, root, releases):
    assert_pinned(args.opa_image)
    assert_pinned(args.node_image)
    for release in releases:
        metadata = verify_artifact(root / "policies/releases" / release["release_id"])
        if metadata["bundle_sha256"] != release["bundle_sha256"]:
            raise RuntimeError("Approved registry hash mismatch")
    container = compose(root, args, ["ps", "-q", "opa"]).stdout.strip()
    if not container:
        raise RuntimeError("OPA container is not running")
    inspect = json.loads(run(["docker", "inspect", container]).stdout)[0]
    if inspect["Config"]["Image"] != args.opa_image:
        raise RuntimeError("Running OPA image differs from pinned OPA_IMAGE")
    for destination, source in [("/config", root / "config/opa"), ("/releases", root / "policies/releases")]:
        mounts = [m for m in inspect["Mounts"] if m["Destination"] == destination]
        if len(mounts) != 1 or mounts[0]["RW"] or Path(mounts[0]["Source"]).resolve() != source.resolve():
            raise RuntimeError(f"OPA {destination} must use the exact read-only host mount")
    probe_file = root / "run/opa-expected.json"
    write_json(probe_file, {"opa_version": VERSION, "releases": [dict(r, probes=read_json(
        root / "policies/releases" / r["release_id"] / "probes.json")) for r in releases]})
    result = run(["docker", "run", "--rm", "--network", args.network,
                  "--env-file", str(root / "secrets/opa.env"), "--read-only", "--cap-drop=ALL",
                  "--security-opt=no-new-privileges:true", "-v", f"{HERE / 'probe.mjs'}:/probe.mjs:ro",
                  "-v", f"{probe_file}:/expected.json:ro", args.node_image, "node", "/probe.mjs"])
    print(result.stdout.strip())


def snapshot(root):
    return {str(p.relative_to(root)): base64.b64encode(p.read_bytes()).decode() if p.exists() else None for p in paths(root)}


def restore(root, old):
    for relative, encoded in old.items():
        path = root / relative
        if encoded is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, base64.b64decode(encoded))


def activate(args, root):
    assert_pinned(args.opa_image)
    assert_pinned(args.node_image)
    init_auth(root)
    journal = root / "config/opa/pending-activation.json"
    if journal.exists():
        raise RuntimeError("Interrupted activation exists; run recover before publishing")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", args.release):
        raise RuntimeError("Invalid release identifier")
    metadata = verify_artifact(root / "policies/releases" / args.release)
    previous = load_approved(root)
    releases = list(previous)
    if any(r["release_id"] == args.release for r in releases):
        verify_running(args, root, releases)
        print("Release already active and verified")
        return
    record = {k: metadata[k] for k in ["release_id", "decision_path", "bundle_sha256", "opa_version", "demo_only"]}
    record["approved_by"] = args.approved_by
    releases.append(record)
    old = snapshot(root)
    write_json(journal, {"previous_files": old, "previous_releases": previous}, mode=0o600)
    try:
        write_loadset(root, releases)
        compose(root, args, ["up", "-d", "--no-deps", "--force-recreate", "opa"])
        verify_running(args, root, releases)
        write_json(root / "config/opa/approved.json", {"releases": releases})
        journal.unlink()
        print(f"Activated and verified: {args.release}")
    except BaseException:
        rollback(args, root)
        raise


def rollback(args, root):
    journal = root / "config/opa/pending-activation.json"
    pending = read_json(journal)
    restore(root, pending["previous_files"])
    previous = pending["previous_releases"]
    # Bootstrap has no prior service: retain a deny-all loadset for safe retry.
    if not (root / "deploy/compose.opa-loads.json").exists():
        write_loadset(root, [])
    compose(root, args, ["up", "-d", "--no-deps", "--force-recreate", "opa"])
    verify_running(args, root, previous)
    journal.unlink()
    print("Previous approved loadset restored and verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/data/hsbc"))
    parser.add_argument("--opa-image", default=os.getenv("OPA_IMAGE", "openpolicyagent/opa:1.21.1"))
    parser.add_argument("--node-image", default=os.getenv("NODE_IMAGE"))
    parser.add_argument("--opa-binary", default=os.getenv("OPA_BINARY"))
    parser.add_argument("--network", default="hsbc_rules")
    sub = parser.add_subparsers(dest="action", required=True)
    build = sub.add_parser("prepare")
    build.add_argument("--source", default=str(HERE / "demo"))
    publication = sub.add_parser("activate")
    publication.add_argument("release")
    publication.add_argument("--approved-by", required=True,
                             help="Infrastructure approval reference; not business rule approval")
    sub.add_parser("verify")
    sub.add_parser("recover")
    args = parser.parse_args()
    root = args.root.resolve()
    (root / "run").mkdir(parents=True, exist_ok=True)
    with (root / "run/opa-publish.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == "prepare":
            prepare(args, root, Opa(args))
        elif args.action == "activate":
            activate(args, root)
        elif args.action == "verify":
            verify_running(args, root, load_approved(root))
        else:
            rollback(args, root)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"OPA deployment failed: {exc}", file=sys.stderr)
        sys.exit(1)
