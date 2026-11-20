#!/usr/bin/env python3
"""Explicit, synthetic-only APP acceptance; briefly rebuilds the OPA container.

Run only during infrastructure commissioning, before real rules are published.
OPA_IMAGE/NODE_IMAGE must be exported from the protected deployment image lock.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import shutil
import tempfile
from unittest.mock import patch

import manage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/data/hsbc"))
    parser.add_argument("--run-on-server", action="store_true", required=True)
    options = parser.parse_args()
    root = options.root.resolve()
    args = argparse.Namespace(opa_binary=None, opa_image=os.environ["OPA_IMAGE"],
                              node_image=os.environ["NODE_IMAGE"], network="hsbc_rules",
                              approved_by="user-approved-infrastructure-acceptance")
    evidence = {"started_at": datetime.now(timezone.utc).isoformat(),
                "opa_image": args.opa_image, "node_image": args.node_image, "checks": {}}
    with (root / "run/opa-publish.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (root / "config/opa/pending-activation.json").exists():
            raise RuntimeError("Recover the existing pending activation before acceptance")
        existing = manage.load_approved(root)
        if not existing or any(r["release_id"] not in {"demo_v1", "demo_v2"} for r in existing):
            raise RuntimeError("Acceptance requires the commissioning demo_v1/demo_v2 loadset")
        with tempfile.TemporaryDirectory(prefix="opa-acceptance-", dir=root / "tmp") as temporary:
            stage = Path(temporary)
            for release in ["demo_v2", "demo_rollback"]:
                source = stage / release
                shutil.copytree(manage.HERE / "demo", source)
                for path in source.rglob("*"):
                    if path.is_file():
                        path.write_text(path.read_text().replace("demo_v1", release))
                args.source = str(source)
                manage.prepare(args, root, manage.Opa(args))
            args.release = "demo_v2"
            manage.activate(args, root)
            evidence["checks"]["v2_activation_retains_v1"] = True
            previous = manage.snapshot(root)
            previous_releases = manage.load_approved(root)

            args.release = "demo_missing"
            try:
                manage.activate(args, root)
            except FileNotFoundError:
                pass
            else:
                raise AssertionError("A missing bundle was accepted")
            assert manage.snapshot(root) == previous
            evidence["checks"]["missing_release_rejected_without_configuration_change"] = True

            copy = stage / "tampered/demo_v1"
            shutil.copytree(root / "policies/releases/demo_v1", copy)
            artifact = copy / "bundle.tar.gz"
            os.chmod(artifact, 0o644)
            artifact.write_bytes(artifact.read_bytes() + b"synthetic-corruption")
            try:
                manage.verify_artifact(copy)
            except RuntimeError as exc:
                assert "hash mismatch" in str(exc)
            else:
                raise AssertionError("A tampered artifact was accepted")
            evidence["checks"]["tampered_artifact_rejected"] = True

            # Fail only after the real candidate container passes its HTTP probes.
            # The real rollback must then recreate and verify both old versions.
            original_verify = manage.verify_running
            calls = []

            def fail_candidate(actual_args, actual_root, releases):
                original_verify(actual_args, actual_root, releases)
                calls.append([r["release_id"] for r in releases])
                if any(r["release_id"] == "demo_rollback" for r in releases):
                    raise RuntimeError("Synthetic post-readiness activation failure")

            args.release = "demo_rollback"
            with patch.object(manage, "verify_running", side_effect=fail_candidate):
                try:
                    manage.activate(args, root)
                except RuntimeError as exc:
                    assert str(exc) == "Synthetic post-readiness activation failure"
                else:
                    raise AssertionError("Fault injection did not fail activation")
            assert calls == [["demo_v1", "demo_v2", "demo_rollback"], ["demo_v1", "demo_v2"]]
            assert manage.snapshot(root) == previous
            assert not (root / "config/opa/pending-activation.json").exists()
            evidence["checks"]["failed_activation_recreates_and_verifies_exact_previous_loadset"] = True

            # Simulate a process stopping with its recovery journal still present.
            journal = root / "config/opa/pending-activation.json"
            manage.write_json(journal, {"previous_files": previous,
                                      "previous_releases": previous_releases}, mode=0o600)
            try:
                manage.activate(args, root)
            except RuntimeError as exc:
                assert "Interrupted activation" in str(exc)
            else:
                raise AssertionError("Publication proceeded despite a recovery journal")
            manage.rollback(args, root)
            assert manage.snapshot(root) == previous
            assert not journal.exists()
            evidence["checks"]["pending_activation_blocks_publish_and_recovers"] = True

            for path in stage.rglob("*"):
                if path.is_dir():
                    os.chmod(path, 0o755)
                elif path.is_file():
                    os.chmod(path, 0o644)
        evidence["active_releases"] = manage.load_approved(root)
        evidence["finished_at"] = datetime.now(timezone.utc).isoformat()
        manage.write_json(root / "run/opa-acceptance.json", evidence)
        print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
