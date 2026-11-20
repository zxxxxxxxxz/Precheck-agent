# DOCX conversion runtime

This is a one-shot executable bundle for the existing Worker, not another service.
Build on Linux with `docker build --output type=local,dest=./runtime infra/docx`.
Keep the generated `manifest.json` and SHA-256 as the release lock; do not silently
rebuild it during deployment. The first package resolution uses signed Debian
repositories. Its exact package versions, actual installed font files, file hashes,
and actual `fc-match` results are frozen in that manifest. Rebuilding is a new
runtime release and requires a new manifest hash and validation.

Mount the bundle read-only at `/opt/p2-docx`, then set:

- `P2_DOCX_RUNTIME_ROOT=/opt/p2-docx`
- `P2_DOCX_RUNTIME_MANIFEST_SHA256=<actual manifest SHA-256>`
- `P2_DOCX_BWRAP_PATH=/opt/p2-docx/rootfs/usr/bin/bwrap`
- `P2_DOCX_TEMP_ROOT=/tmp` (bounded tmpfs, at most 512 MiB; no shared document data)

Direct bwrap execution was verified in the exact pinned Node image; its existing
GLIBC/libcap dependencies match this bundle. The alternate `rootfs/opt/p2-docx/bwrap`
loader wrapper is retained for diagnosis but is not the validated production path.
Use the same pinned Node image, UID 10001, read-only container, no capabilities,
and `no-new-privileges` as the Worker. Linux must permit unprivileged user/mount/
PID/network namespaces through the Worker-specific seccomp/AppArmor profiles.
The default Docker policy rejects namespace setup. Use the pinned
`seccomp-worker.json` plus the `hsbc-docx-worker` profile from `apparmor-worker`.
The seccomp delta permits namespace clone only with CLONE_NEWUSER, unshare only
for CLONE_NEWUSER, and mount/umount2/pivot_root/chroot. All other default deny and
capability-conditioned rules remain. The AppArmor delta replaces deny mount with
mount/pivot_root while retaining the default proc/sys/network-family protections.
Its source and exact changes are recorded in the adjacent source JSON files.

A parent-to-converter Px transition was tested and rejected by the kernel under
`no-new-privileges`; there is no claimed separate AppArmor child domain. The
validated design keeps NNP and empty host capabilities, confines the whole Worker,
and relies on bubblewrap's private namespaces for the converter. It never uses
`privileged`, unconfined seccomp, or unconfined AppArmor. The startup probe and
actual conversion use exactly the same namespace builder.

Only the generated rootfs, input file, and per-job private output/work directory
are mounted inside conversion. The same private job work directory is bound to
`/work` and `/tmp`; it never exposes the Worker-wide temporary directory. No `/app`, `/run/secrets`, host process tree,
network interfaces, DB/OSS credentials or Worker environment is inherited.
`/proc` is an empty read-only directory: Docker's masked proc paths prohibit a
nested user namespace from mounting a fresh proc filesystem. This design keeps
Docker's system-path protection, never binds the Worker's proc tree, and still
creates a private PID namespace. The probe verifies an empty proc, a namespace
local PID, and no non-loopback interface.
The fixed Python helper invokes `soffice.bin` directly with the runtime library
directory; the distribution launcher requires proc. Normal first-profile restart
status 81 permits exactly one retry, within the same total wall-clock timeout.
Both child output streams are discarded. This follows the upstream
[LibreOffice launcher restart contract](https://github.com/LibreOffice/core/blob/libreoffice-7-4/desktop/unx/source/start.c).
Conversion is serial, abort/timeout kills the entire process group, stdout/stderr
are discarded, and the output PDF is bounded to 50 MiB / 500 pages by default.
The writable volume is size bounded and CPU/address space/open files/file size
also have limits. Original DOCX remains separate from the derivative PDF.
Source XML text is bounded to 5,000,000 characters by default; the sum of all
node text/visibleText values is separately capped at twice that budget before
hashing or serialization, so ancestor aggregation cannot multiply it without limit.

Installed Debian font packages carry their redistributable licenses in
`rootfs/usr/share/doc/<package>/copyright`. Noto CJK/Symbols, Liberation and
Carlito are used. No macOS/commercial fonts are copied. Font family substitution
(including FangSong/KaiTi/STKaiti calligraphic styles replaced with Noto Serif)
does not preserve the original letterforms or prove glyph or pagination equivalence. In particular Wingdings private
codes remain source symbols requiring rendered verification.

Native macOS LibreOffice can be explicitly injected with `mode: 'validation',
isolatedReplay: true, validationExecutable: <absolute path>` for synthetic replay.
That result is always `sandboxed:false`, `productionEligible:false`, has no
verified runtime/font hash, and cannot satisfy production startup.
