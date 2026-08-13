# CLAUDE.md — nix-wasm

Build `nix.wasm` (Nix for the `wasm32-linux-musl` NOMMU guest) and its toolchain,
**entirely through Nix**. This file is the operating guide AND the record of
current state and hard-won learnings — read it before doing anything.

## PRIME DIRECTIVE (non-negotiable)

**ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks. No stubs.** There is
no "good enough for now," no tactical workaround, no deferred-correctness. If two
paths exist, take the one that is *correct in general*, not the one that is merely
sufficient for the task in front of you — even when it is harder, slower, or larger.
Every artifact is a reproducible Nix derivation. The OLD approach (hand-written
shell scripts + fake-lib stubs) has been deleted — it lives in git history; the Nix
derivations are the only build path.

Hard-won corollaries (each was a real mistake; don't repeat them):

1. **Don't propose a fix that solves the immediate task but not the actual goal.**
   Minimal per-dep derivations would build `nix.wasm` but a *user* package sharing
   those deps (e.g. `git` → `curl`/`libgit2`) would still pull the broken nixpkgs
   cross dep and fail. The CORRECT path fixes the **crossSystem** (overlay
   overrides on `cross.*` + the platform bugs) so nixpkgs packages cross-compile
   — those fixes are **shared** across `nix.wasm` AND every user-installable
   package. Stay on nixpkgs-via-crossSystem; never fork off package-private recipes.
2. **Don't recommend "do the easy slice now, defer the hard part."** The goal is
   the whole environment built reproducibly; carving off the tractable piece and
   calling it done is a shortcut in disguise.
3. **Don't kill a running build to "restart cleanly."** On `aarch64` the first
   build compiles LLVM/clang from source (~1–2 h); killing it mid-way restarts it
   from scratch. Leave builds alone; they notify on completion.
4. **If disk runs out (ENOSPC), STOP and ask for more disk — do NOT `nix store
   gc`.** GC forces re-realizing derivations (slow recompiles).
5. Report progress, not questions. Once the correct path is clear, execute.
6. **Guest login-shell env and daemons belong in this image, never in the host
   typing into a console.** `DISPLAY`, `GDK_USE_XSHM`, `QT_X11_NO_MITSHM`,
   `WAYLAND_DISPLAY`, Sommelier — `userspace/system.nix` + `userspace/init.nix`.
   pc `kernel-service.ts` writing `export DISPLAY=…` onto an hvc, waiting for a
   `# ` prompt to inject keystrokes, or appending `/root/.profile` is
   **forbidden** (pc `.claude/rules/linux.md`). A stale published ISO is a
   `publish-linux-channel` republish, not a keystroke. If a login shell doesn't
   have it, the image is wrong. Same for Xwayland's `-noreset`: 24.1 defaults
   to `-terminate` (exit ~1s after the last X client), which is why Ctrl-C of
   `xeyes` used to take `:1` down until inittab respawned. That flag is
   `patches/sommelier/0005-xwayland-noreset.patch`, not a typed restart.

## Workflow

The session-level "do NOT create a pull request unless explicitly asked" default
does **not** apply here — it's lifted for this repo. Opening a PR is a normal part
of finishing work; use your judgment about when to open one, the same as any other
step. (No standing requirement to always open one either — this only removes the
prohibition.)

## Architecture

A real nixpkgs **crossSystem** whose stdenv targets `wasm32-unknown-linux-musl`,
with a prebuilt **clang-21** cc-wrapper injected via the supported
`config.replaceCrossStdenv` seam (`wasm-cross.nix`). nixpkgs' own package
definitions then cross-compile.

- **Toolchain** = focused Nix derivations (NOT nixpkgs packages), built from
  stock LLVM-21 + pinned musl/kernel sources: `toolchain/{musl,compiler-rt,
  libcxx,kernel-headers,sysroot}.nix`. This layer is **done and validated**.
- **cc-wrapper** = `clang-unwrapped` (LLVM 21) + a **flag-filtering `wasm-ld`**
  (drops ELF-only flags like `--undefined-version`, wired via `clang -B$out/bin`)
  over the nix-built sysroot. Stock LLVM-21 for all of userspace — no joelseverin/
  llvm fork (the wasm-EH patch is upstream in LLVM ≥19).
- **Deps** = nixpkgs packages via `cross.*`, with cross-wasm fixes in
  `deps-overlay.nix` (all wasm-guarded so native packages stay stock/cached).
- **`nix.wasm`** = `nix-wasm.nix`: meson compiles Nix's C++ with clang-21 against
  the nix-built libc++ + the `cross.*` deps, then a custom `.o` link (meson's
  `-r` prelink can't emit wasm TLS relocs — a real wasm limit, not a shortcut).
- **Guest kernel** = `kernel.nix`: `vmlinux.wasm` from the pinned joelseverin/linux
  wasm port. The ONLY patched-LLVM consumer (`kernel-llvm.nix`: a libllvm patch for
  `EXPORT_SYMBOL` inline-asm + an lld patch for the `vmlinux.lds` linker script —
  real toolchain features, not flag massaging), exposed as a plain `symlinkJoin`
  (`kernel-cc.nix`). The wasm cc/ld/objcopy flags live in the kernel SOURCE
  (`patches/kernel/0008-0012`) — there is **no fake-llvm wrapper** (deleted).
- **Guest userspace** = `userspace/*.nix`: a curated `lib.evalModules` NixOS
  closure (no systemd/perl/python) + a patched busybox (`userspace/busybox.nix`:
  clone-with-fn spawn — the default toolchain is `posix_spawn`-only) built via the `cross`
  cc-wrapper; boots through a thin Nix-generated `/init` (`bootstrap.nix`) that
  mounts the squashfs base over a read-only virtio-blk device as the `/nix` overlay
  lowerdir and hands off to busybox-init.
- **Process model** = single shared NOMMU arena + a **`posix_spawn`-only spawn
  contract**; `fork`/`vfork` are **removed at the libc level** (`toolchain/musl.nix`)
  so callers fail to **link** (loud build error) rather than SIGILL/abort at runtime.
  Holdouts are handled by one documented rule (don't-build an unused CLI / port a
  real library to `posix_spawn` / compile out an unused return-twice symbol) — never
  a stub. See **`docs/process-model.md`**. Per-process Memory is a *measured*
  dead-end (`spikes/elastic-mem/` ~124-Memory/tab cap), and WasmFX/JSPI are
  one-shot (`spikes/stackswitch/`) — but real `fork()` is **NOT** a dead-end:
  the **asyncify fork seam** (PR #20: `toolchain/musl.nix` `forkSeam` +
  `guest-cc-fork.nix` + `userspace/asyncify-cc.nix`) delivers real
  fork-without-exec as a **per-binary opt-in** (returns twice, private memory,
  reaps — 8 `fork-*` acceptance programs), and Track A COW made the copy cheap,
  so **#129 (Track B)** is generalizing it into a flag and will eventually
  retire the forkshell/`posix_spawn`-only accommodations. Until then the
  DEFAULT contract stays `posix_spawn`-only — don't describe fork as
  impossible, describe it as opt-in.

LLVM target triple is `wasm32-unknown-unknown` (clang rejects
`wasm32-unknown-linux-musl`); `-D__linux__ -matomics -mbulk-memory
-fwasm-exceptions` supply the rest. Everything links static `.a` into the final
`-shared` dylink wasm module.

## Build / test

Nix daemon runs as root here → `sudo`; enable flakes via `NIX_CONFIG`:

```sh
export NIX_CONFIG="experimental-features = nix-command flakes"
sudo -E nix build .#musl --no-link --print-out-paths        # a toolchain stage
sudo -E nix build .#crossZlib --no-link --print-out-paths    # cc-wrapper smoke test
sudo -E nix build .#dep-openssl --no-link --print-out-paths  # a dependency
sudo -E nix build .#nix-wasm --print-out-paths               # the goal
```

- `sudo` loses a piped password into `$(sudo …)` subshells — run each `sudo nix`
  as its own command, or `echo <pw> | sudo -S …` per call. (Local password noted
  in agent memory, not here.)
- **Validate toolchain stages against the known-good** linux-wasm artifacts at
  `~/lwbuild/ws/install/{musl,cxx,llvm}-wasm32_nommu` (symbol-set diffs). Don't
  build those from this repo — they're the read-only oracle.
- The eval cache is a single SQLite db — concurrent `nix` invocations race
  ("database is busy"); don't run a status check against a live build.

### Boot-test the built guest — in-repo runtime/ harness

nix-wasm now both *builds* the guest and *runs* it. The `runtime/` package
(kernel host + 9P server + Nix store wiring) runs in Node and the browser; pc
vendors it via `runtime/sync-to-pc.sh`. **Any change to a runtime engine file
(e.g. `kernel-worker.js` — the loader gained glib `GOT.func`/`__lsan_*` stubs in
M3a) requires re-running `runtime/sync-to-pc.sh <pc-checkout>`, or pc boots a stale
engine that fails to instantiate glib/GTK binaries.**

**ABI-BUMP RULE (non-negotiable):** any change to the kernel↔engine contract —
the 9P/virtio transport, the exec ABI, the virtio/9P device models, syscall/loader
stubs — MUST bump `ENGINE_ABI` in `runtime/abi.js` **in the same change**. That
constant is the single source of truth for the guest↔engine ABI version (pc#315):
`.#linux-image` stamps it as the published image's `minEngine`, and pc refuses to
boot an image whose `minEngine` exceeds the vendored engine's `ENGINE_ABI`
(surfacing "reload pc" instead of a silent boot crash). Forgetting the bump
defeats the guard — a `master`-based channel republish would silently brick the
deployed engine (this is exactly what #61 caught for #59's virtio-9p migration).
A `master`-based `linux` channel can only ship **after** the matching engine is
synced into pc (`runtime/sync-to-pc.sh`) and pc is deployed; until then the higher
`minEngine` correctly shows "reload pc".

Artifacts (`vmlinux.wasm`, `initramfs.cpio.gz`, `base.squashfs`, `nix-cache/`) come
from `nix build` (`.#kernel`, `.#wasm-initramfs`, `.#wasm-base-squashfs`, `.#wasm-binary-cache`). Point
at them via `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/` for the Node CLI, or
symlink `demo/web/artifacts → /path/to/artifacts` for the browser demo.

**pc-facing delivery:** the versioned `linux` channel — `nix build .#linux-image`
bundles kernel + initramfs + squashfs into a channel image uploaded to R2 under
`packages/linux/<v>/`; `packages/linux/latest.json` (served `no-cache`) is the
pointer pc resolves at runtime via `js/packages/linux-channel.js`.
**To ship a guest change to pc, just run the `publish-linux-channel` workflow**
(GitHub Actions → *Run workflow* — it's `workflow_dispatch`-only since a
live-channel flip is a deliberate release; pass `dry_run: true` first to build +
print the exact wrangler commands and `latest.json` without touching R2). It runs
`scripts/publish-linux-channel.sh`, which builds `.#linux-image` + `.#wasm-binary-cache`
(substituting from Cachix), uploads under a new immutable version (= the image
**content hash**, so no manual version bump), and flips `latest.json`. **No
`runtime/sync-to-pc.sh` and no pc deploy are needed for a normal guest change**
(new initramfs binary, userspace, kernel) — only when `ENGINE_ABI`
(`runtime/abi.js`, which the script stamps as `minEngine`) moves does the engine
JS also need syncing + a pc deploy, ordered per the runbook. The full end-to-end
republish runbook lives in pc's `vendor/linux-wasm/SOURCE.md` § "Republish the
guest". The guest inittab and `/etc` live in `base.squashfs`
(via `userspace/init.nix → toplevel.nix → base-squashfs.nix`), **not** the
initramfs — an `init.nix` change republishes via `.#linux-image`'s squashfs member.

**PR previews:** every same-repo PR gets a browser preview that boots *that PR's*
guest — `.github/workflows/pr-preview.yml` builds the 3 boot artifacts (toolchain
substituted from the `nix-wasm` Cachix cache), content-addresses them into the
`nix-wasm-previews` R2 bucket's `cas/<buildhash>/`, rclone-syncs the `runtime/`
frontend into `pr-<N>/`, and comments `${PREVIEW_BASE_URL}/pr-<N>/demo/web/`. The
served Worker (`infra/preview-worker/`) stamps COOP/COEP, serves the R2 preview
bucket, and proxies the guest toolchain cache from Cachix (the `/cachix/<v>` route
the `linux` channel's `nixCacheBaseUrl` points at). That Worker is deployed by
`.github/workflows/deploy-preview-worker.yml` — `workflow_dispatch` (run once to
mint the `*.workers.dev` URL → set it as the `PREVIEW_BASE_URL` repo variable) and
auto-redeploy on a push to `infra/preview-worker/**` on master; it runs the
Worker unit tests (`src/index.test.js`) before `bunx wrangler deploy`. Boot
artifacts only — the guest `nix-cache/` catalog tree stays #2's concern. Setup
runbook: `infra/preview-worker/README.md`.

**PR CI boots the MERGE REF (branch + master merged), not the branch tip —
a parallel master commit can change what an open PR's own boot-smoke sees**
(#193/#194). PR #194 baked `DISPLAY=:1` into `/etc/profile` (the "GDK_USE_XSHM"
learnings entry below) and landed on master while PR #193 was still open;
#193's next CI run built the merge of its own branch + that master commit,
so its `gtk2-smoke` — a display-free `--selftest` gate that assumes no
`DISPLAY` is set — inherited a real `DISPLAY` from the now-merged environment
and hung in `gtk_init_check` waiting for a compositor that was never going to
answer. Nothing in #193's own diff caused this. Fixed by making the smoke
itself robust (`env -u DISPLAY` before invoking the selftest, `c80e08d`)
rather than trying to pin CI off the merge ref — the lesson is to write
display-free smokes so they don't *inherit* ambient guest env from whatever
else happens to be on master at merge time, since that environment is not
under the PR's control.

Run these from the **runtime/** directory:

```sh
# Engine unit tests (72 tests, no artifacts needed):
bun run test

# Node integration tests:
node --test demo/node/

# Full nix-system smoke: boot → 9P read/write/ls → nix-env -iA sl.
# Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/smoke.mjs

# Interactive guest root shell (Ctrl-] to quit).
# --no-nix = fast busybox-only boot when you don't need the /nix overlay.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/attach.mjs [--no-nix]

# libffi raw-backend unit test (f32/f64/i64 by-value args): boot → run selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/libffi-smoke.mjs

# M2 text stack (fontconfig→freetype→harfbuzz→cairo-ft): boot full nix system → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/wl-text-smoke.mjs

# M3a glib/gobject (+ libffi double marshaller): boot full nix system → gobject selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/glib-smoke.mjs

# M3a pango layout (pango_cairo_show_layout → fontconfig → cairo-ft): boot → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/pango-smoke.mjs

# M3b GTK3 (gtk_init + GtkWindow/GtkLabel widget tree, gobject through fpcast seam):
# boot full nix system → gtk-hello --selftest (headless gate; visual window is a
# MANUAL browser check — docs/superpowers/notes/m3b-gtk-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/gtk-smoke.mjs

# M4 galculator (GTK3 calculator: --selftest parses the real .ui files from
# PACKAGE_UI_DIR + runs the GTK widget gobject classes through the fpcast seam,
# display-free; visual click-7x6=42 is a MANUAL browser check —
# docs/superpowers/notes/m4-galculator-visual.md).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/galculator-smoke.mjs

# gtk3-demo (GTK's demo browser — the first REAL, non-showcase GTK3 app: a full
# GtkApplication whose main window wires every signal in C with g_signal_connect
# and never calls gtk_builder_connect_signals, so NO GModule dependency, unlike
# galculator. --selftest walks the generated gtk_demos[] dispatch table + runs
# browser-chrome widget class_init through the fpcast seam, display-free; the
# full browser window is a MANUAL browser check).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/gtk-demo-smoke.mjs

# l3afpad (GTK3 leafpad fork — the first real GTK3 PRODUCTIVITY app, #122: a
# Notepad-class open/edit/save text editor. Signals wired in C like gtk3-demo
# (GtkActionEntry/G_CALLBACK + g_signal_connect, never
# gtk_builder_connect_signals) → NO GModule dependency. --selftest class_inits
# the editor widget classes + fires a GtkTextBuffer "changed" signal into an
# address-taken C handler through the fpcast seam, display-free; the editor
# window + an open/edit/save round-trip to /mnt/pc are a MANUAL browser check).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/l3afpad-smoke.mjs

# #35 async-signal smokes (busybox-only boot, nix:false — kernel+initramfs only):
#   sigalrm-smoke   — self-armed SIGALRM/itimer/alarm (kernel mechanism, #55).
#   kill-wake-smoke — cross-process kill() async-signal wake (a reduced C
#                     reproducer for #35; no busybox, no networking).
#   timeout-repro-smoke — the actual busybox `timeout 2 sleep 10` (the #35
#                     headline command). PASS = sleep is killed at ~2s (busybox
#                     exit 143 = 128+SIGTERM, NOT GNU's 124).
#   ping-pace-smoke / ping-pace-probe-smoke — #75 (busybox `ping` one-packet-then-
#                     hang), now FIXED by patches/kernel/0021. ROOT CAUSE =
#                     SA_RESTART (see the learnings entry below): a SIGALRM handler
#                     installed with SA_RESTART (busybox ping uses signal()) was
#                     never delivered when it interrupted a blocking syscall — the
#                     wasm syscall-restart loop re-entered the syscall before
#                     _user_mode_tail ran the queued handler. The fix lifts the
#                     restart loop to the asm FOOT: deliver the handler, then
#                     re-invoke the syscall (transparent SA_RESTART, real replies,
#                     no -EINTR). ping-pace-probe runs a
#                     control/restart/xcpu/repro matrix (all PASS with the fix). No
#                     networking — both run in the busybox-only boot-smoke.
# ping-pace-smoke is GATING (regression guard); ping-pace-probe-smoke is the
# non-gating detailed breakdown behind it. All are in the nix-wasm.yml `boot-smoke`
# CI job (substitutes the artifacts from Cachix and boots them on x86_64) — the
# first CI job that BOOTS the guest rather than just building images.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/sigalrm-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/kill-wake-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/timeout-repro-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/ping-pace-smoke.mjs
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/ping-pace-probe-smoke.mjs

# #60 Phase 2 /Ctl-over-vsock smoke (busybox-only boot): the guest agent `pcctl`
# (socket(AF_VSOCK)+connect(host:1024)) ↔ a host /Ctl listener registered via the
# vsock.onReady hook. PASS = open/notify/clipset reach the host seams and clipget
# round-trips the reply back to the guest. Also wired into nix-wasm.yml boot-smoke.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/vsock-ctl-smoke.mjs

# Guest wall-clock smoke (busybox-only boot): patches/kernel/0028's
# read_persistent_clock64 must give the guest real wall time (not the 1970
# epoch, which breaks TLS "not yet valid" → Cachix substitution). PASS =
# in-guest `date +%s` within 15 min of the host clock. Wired into
# nix-wasm.yml boot-smoke (gating).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/clock-smoke.mjs

# #83 follow-up terminal-resize smoke (busybox-only boot): console(0).resize(cols,
# rows) writes the virtio-console F_SIZE config space + raises the device's
# config-change irq; the stock driver hvc_resize()s the tty. PASS = `stty size`
# in-guest reflects the new size. Also wired into nix-wasm.yml boot-smoke (gating).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/resize-smoke.mjs

# #145 guest-audio smoke (busybox-only boot): virtio-snd (kernel patch 0027,
# CONFIG_SND_VIRTIO) + cross alsa-lib. `alsa-tone` plays a deterministic 440Hz
# sine through snd_pcm_open/set_params/writei/drain; PASS = the host device
# model saw SET_PARAMS(48k/2ch)+START and received the full tone BIT-EXACT.
# Also wired into nix-wasm.yml boot-smoke (gating).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/snd-smoke.mjs

# #11 items 2/3 (wl_shm-on-MMU) parity check (issue #203; busybox-fork boot on
# .#kernel-mmu-a2, no compositor needed): userspace/wl-shm-test.c drives
# virtio_wl's NEW_ALLOC/anon-inode/SEND-fds path directly; a `wayland.sendOut`
# bridge hook captures the host device model's resolution bit-exact.
# ITEM2_INODE/ITEM3_ADDR reliably PASS (the wire-level accommodations work);
# CONTENT reliably FAILS with a reproducible SIGBUS (virtwl_vfd_mmap was never
# given real MMU semantics — tracked as issue #203, not a regression). Wired
# into nix-wasm.yml boot-smoke's `mmu` shard as a non-gating step (see its own
# comment for the promotion criterion).
MMU_VMLINUX=$(nix build .#kernel-mmu-a2 --print-out-paths)/vmlinux.wasm \
  BUSYBOX_FORK=$(nix build .#userspace-busybox-fork --print-out-paths)/bin \
  WL_SHM_TEST=$(nix build .#wl-shm-test --print-out-paths)/bin/wl-shm-test \
  node demo/node/wl-shm-mmu-smoke.mjs

# Browser demo (serves runtime/demo/web/ with COOP/COEP for SharedArrayBuffer):
ln -sfn /path/to/artifacts demo/web/artifacts && node demo/web/serve.mjs [port]
# Headless Playwright smoke (asserts WEB_OK):
node demo/web/smoke.mjs
```

`makeConsoleSession` wraps a boot handle's console with session conveniences:
`write`, `onData`, `resize`, `kill`, `hangup`.

**Four CI gates for runtime/** (all must pass before pushing):

```sh
bun run test          # engine unit tests
bun run lint          # oxlint, zero warnings tolerated
bun run format:check  # oxfmt
bun run typecheck     # tsc
```

`demo/node/` and `demo/web/` are tooling/demo (tsc-excluded); `demo/web/vendor/ghostty` is
vendored (excluded from all three static gates).

## Current state

**It works end-to-end** (2026-06-17). `nix build .#nix-wasm` builds the wasm Nix;
the dep closure (`cross.*`), the kernel, and the curated guest userspace all build
reproducibly. In the runtime harness (`runtime/demo/node/smoke.mjs`) the
Nix-built userspace boots — served-closure `/nix` overlay → busybox-init → getty →
autologin → root shell — and **`nix-env -iA sl` substitutes `sl` from the binary
cache and renders it** (Phase A + B both PASS). Every wasm fix is a SHARED
crossSystem/overlay or kernel-source fix, never a package-private workaround (PRIME
DIRECTIVE corollary 1).

**Phase 3 is also done** (2026-06-17): the in-guest compiler is nixified —
`.#guest-clang` (LLVM-21 clang+lld cross-built to wasm32), `.#cc-sysroot`,
`.#guest-cc` (the `cc` driver), and `.#guest-cxx` (the `c++` driver). The guest now
COMPILES C **and C++** in-browser entirely from Nix-built artifacts (`cc -O2 hello.c
&& ./hello` and `c++` building std::string/vector/exceptions/iostream both validated
in-guest). Enabling clang needed a shared kernel fix: `CONFIG_BOOT_MEM_PAGES`
0x2000→0x4000 (512MiB→1GiB) so the 57MB clang.wasm can be mmap'd contiguously after
the sysroot unpack fragments the NOMMU heap. C startup needed two link/loader fixes
(`--gc-sections` + a loader data-relocs guard — see the guest-compile SIGILL note in
agent memory); `c++` adds `-D__linux__` (libc++ pthread thread-API selection on the
`-unknown` triple) + the `__cpp_exception` wasm-EH tag (allow-listed), with libc++
shipped in `cc-sysroot` (`sys/cxx`).

**clang is its own driver — the `cc`/`c++` shell wrappers are retired** (#3,
2026-06-24): the wrappers existed only because bare clang for the `wasm32-unknown-unknown`
target didn't know our sysroot/dylink link model. clang's STOCK wasm driver already
emits the exact link `cc` hand-rolled (crt1.o, `-L`s, `-lc`, builtins) from
`--sysroot`+`-resource-dir`; the only missing pieces (target features, the dylink/
shared-memory link, the libc++/EH set) now live ONCE in **`toolchain/wasm-clang-config.nix`**
as `clang.cfg`/`clang++.cfg`, installed next to the `clang` binary in `guest-clang`
(+ a `clang++` symlink). clang **auto-loads `<driver>.cfg` only from the REAL binary's
dir** (it resolves argv[0] symlinks first — a downstream symlink-farm package does NOT
work, which is why the config lives in `guest-clang`), so bare `clang hello.c -o hello`
/ `clang++ …` are complete drivers and in-process-link via `wasm-ld` + `posix_spawn`
(`patches/llvm/0001`, #48/#50). `guest-cc`/`guest-cxx` collapse to thin
`exec clang/clang++` aliases (kept as packages so the `nix-env -iA guest-cc` catalog
names from #48 are unchanged). The four duplicated flag sites (guest-cc, guest-cxx,
plus the host-side `make.nix`/`nix-wasm.nix` `wcc`/`wcxx`) now share one vocabulary;
the host-side two still inline it (they use the host clang-unwrapped raw, not the
guest config). Validated in-guest (`runtime/demo/node/wrapperless-cc-e2e.mjs`): bare
`clang`/`clang++` and the `cc`/`c++` aliases all compile+run.

**In-guest autotools also works** (2026-06-17): a real autoconf `./configure &&
make && ./prog` runs end-to-end in the guest. The guest `/bin/sh` is busybox's
**forkshell ash** (busybox-w32 lineage, NOMMU fork-without-exec over `posix_spawn`;
`userspace/ash.nix` + `userspace/ash-cb-guest.c`), promoted to `/bin/sh` in
`bootstrap.nix`. Six forkshell/spawn/shell fixes made autoconf's preamble,
`$()`/subshell/pipeline, and `config.status` work (full record in the
`userspace/ash.nix` postPatch comments + the `patches/busybox/ash/*` patches + git
history). The old "hush isn't POSIX-enough" gap is closed. **Caveat (2026-08-11,
UPDATED 2026-08-12, 2026-08-13):
this milestone was a HAND-RUN session (its record was `docs/STATUS.md`, since
deleted). Two things were measured on the MMU/fork guest while scoping a
regression gate for it, both worth knowing before touching shells: (1) stock
busybox **ash** cannot replace forkshell ash on wasm at all — not for
fork reasons but because the wasm musl's `longjmp` is an `abort()` stub
(`patches/musl/0000-harness-wasm-arch.patch` → `src/setjmp/wasm/longjmp.S`), and
ash unwinds through `longjmp` on its normal path, so every `$()`/subshell child
dies SIGABRT and reports exit status 134 while still printing correct stdout
(nix-wasm#188). So #131 slice 1 retires forkshell ash in favor of HUSH, not stock
ash. (2) **"hush isn't POSIX-enough" is a NOMMU statement, not a hush
statement — but the original #189 measurement matrix's "every autoconf idiom
clean" claim was ITSELF too broad, corrected here.** The matrix tested every
idiom against LITERAL fds only (`{ …; echo >&5; } >out` — a literal `>&5`) and
found the fork guest's stock hush clean on all of them. A REAL autoconf-generated
`configure`'s own `as_fn_error` diagnostic-logging helper redirects to a
**VARIABLE** fd instead (`>&$4` — the fd number is a shell variable), which
hush's parser does NOT accept — and THIS, not anything NOMMU-specific, is the
actual, reproducible source of the classic "hush: ambiguous redirect" / "hush:
syntax error at 'fi'" failures. Confirmed two ways: (a) a real generated
`configure` (`userspace/autotools-fixture.nix`, added 2026-08-12) hits it in its
own preamble under stock busybox hush, hermetically, on the HOST — see
`userspace/autotools-fixture-hush-check.nix`; (b) the same generated
`configure`'s in-guest run (`runtime/demo/node/autotools-fork-smoke.mjs`, also
added 2026-08-12 — **the first automated autotools regression gate on ANY
guest**, closing the "nothing regression-gates it" gap this caveat used to cite)
hit its CFGRC step with the identical signature. **RESOLVED in the same
change** (`patches/busybox/0009-hush-variable-fd-redirect.patch` +
`0010-hush-internally-opened-fd0.patch` — the second an independent,
still-unfixed-upstream `<&0` bug found while verifying the first against a
real `configure`; full record in the "hush can't run a real autoconf
`configure` at all without three independent fixes" learnings entry below):
`.#autotools-fixture-hush-check` is now a HARD gate (native, ~2 min, wired
into `nix-wasm.yml` alongside `.#autotools-fixture`) asserting the full
`configure`/`config.status`/`make`/`./prog` chain succeeds under exactly this
hush. The host-side proof is the NECESSARY half — it confirms the hush.c fix
itself, in isolation — but the shell risk this item existed to retire is only
fully retired once the in-guest `autotools-fork-smoke.mjs` soak (the
2026-08-05 parity-plan doc's "Real-fork autotools proof" item) records its
own green CFGRC on the real MMU/fork guest: that CLOSES the claim, exercising
the booted guest's full 9P-staging + in-guest cc/make path the host build
never touches — see the two UPDATEs below: the first (2026-08-13, #193) found
one more hush bug the soak's own first run surfaced, and the second
(2026-08-13, same day, PR #199) records that once that bug and an unrelated
kernel bug (#192) were both fixed, the soak recorded its first-ever green
CFGRC and was promoted to a hard gate — closing this claim in full.
**UPDATE (2026-08-13, #193): that first
in-guest soak found a THIRD hush bug** the host-side gate's happy-path-only
checks could not have caught — a genuinely fatal `configure` (hit an
unrelated in-guest cc bug, #192) still reported `CFGRC=0` to the harness,
because a bare `exit` run from inside autoconf's universal `ac_exit_trap`
EXIT-trap handler resumed the trap body's own last exit status (0, from a
successful cleanup `rm`) instead of the real, pending one. Fixed by
`patches/busybox/0011-hush-exit-trap-status.patch` (merged via PR #197; full
record in the learnings entry below); `.#autotools-fixture-hush-check` gained
a hard NEGATIVE case (a sabotaged always-failing compiler) so this class of
bug is now gated on the host side too, not just discoverable by an in-guest
soak. **This closes the SHELL half of the item for good** — no known hush
defect stands between autoconf and this guest's `/bin/sh` any more. **UPDATE
(2026-08-13, same day, PR #199): the compiler/#192 half is closed too.**
Issue #192 (a kernel exec-image-buffer fragmentation bug — large repeated
execs, e.g. clang's driver+cc1, failed around the 6th with `page allocation
failure: order:14`) is fixed by a refcounted per-inode exec-image cache
(`patches/kernel/0030`). The very next `autotools-fork-smoke.mjs` boot
recorded the first-ever green CFGRC (workflow run 31697211801) and the smoke
is now a `run_smoke` hard gate in `nix-wasm.yml`'s `nix-boot-smoke-mmu`
`core` shard — no soak step remains for it. **This closes the item in
full: no known blocker stands between autoconf and the real-fork MMU guest.**
Full record (compaction-hypothesis refutation, the per-inode-cache fix,
the fixture-`configure` data point, the CI promotion):
`docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md`'s "Real-fork
autotools proof" item.

**#43 is done** (2026-06-24): the guest `/nix` is now a squashfs image served over
a read-only virtio-blk device (`base.squashfs` → `.#wasm-base-squashfs`); the
compiler toolchain is no longer in the base — it's substituted on demand via the
Nix binary cache (`nix-env -iA wasm-tools.guest-cc`). Phase 5 CI wiring (Task 9,
issue #2) follows.

**In-guest nixpkgs channel is done** (2026-06-28): the guest installs packages
exactly like a real NixOS system via TWO `nix-env` channels in `~/.nix-defexpr`
(set up by `bootstrap.nix`): **`nixpkgs.<pkg>`** — the pinned nixpkgs evaluated
against the wasm crossSystem (`userspace/wasm-nixpkgs-channel.nix` → `cross`,
baked into the squashfs as `<store path>`; reaches nixpkgs via `<nixpkgs>` =
`NIX_PATH` baked in `system.nix`, substituted on demand) — and **`wasm-tools.<tool>`**
— the toolchain `pkgs.nix` catalog. Validated end-to-end in the booted guest:
`nix-env -iA nixpkgs.file` → substitutes the prebuilt wasm output from the cache →
`file --version` → `file-5.47`; same for `nixpkgs.hello` → `Hello, world!` and
`wasm-tools.guest-cc` → `cc --version` → `clang 21.1.8`. Key design points (all
hard-won by BOOTING the guest, not eval alone): the channel is a DIRECTORY tree so
it must live in the squashfs (the flat nix-cache 9P export has no directory
traversal); `wasmPublishedPkgs` (flake.nix) roots **all** outputs of each curated
published package (nix-env installs `meta.outputsToInstall`, e.g. `[out man]` —
rooting only `out` makes nix build the package's whole from-source closure); the
two channels are addressed + lazy per channel so a `wasm-tools` install never pulls
nixpkgs. What's installable = `wasmPublishedPkgs` (curated; the channel EVALUATES
any package but only published outputs SUBSTITUTE — most won't cross-build to
wasm32-NOMMU). Full record: `docs/superpowers/notes/2026-06-28-nixpkgs-in-guest-eval.md`.

**Guest substitution is Cachix-over-the-uplink** (#82/#167, 2026-07-21; trust
anchors 2026-07-22): the shipped guest substitutes from
`https://nix-wasm.cachix.org` — a real, signed HTTP binary cache — over its OWN
TCP/IP (virtio-net NIC → pc's vnet bridge → the wan0 Wisp uplink), exactly like
a real machine that ran `cachix use nix-wasm`. `require-sigs` is back to the
real-NixOS default (true) with the cache's public key pinned. The
`file:///nix-cache` substituter is RETIRED from the shipped config — no offline
substitution, by design (a package not already in the store needs the uplink up,
same as a real offline machine; the store/base squashfs still works offline).
What remains of the 9P `/nix-cache` mount: the two catalogs
(`pkgs.nix`/`paths.nix`, still read from `/nix-cache/…`), and the offline CI
smokes, which re-point substitution at it via a TEST-ONLY user-level nix.conf
(`primeLocalNixCache` in `runtime/demo/node/boot-node.mjs`) — the baked config
stays Cachix-only. Two operational consequences: (1) `nix-env -iA` substitutes
the `.drv` first, and cachix-action's post-build-hook pushes only OUTPUTS — so
`nix-wasm.yml` has a master-only step that `cachix push`es the `.drv` closures
(`.#wasm-cache-drv-roots`); (2) real HTTPS needs real **CA trust anchors**,
which the guest closure never carried — see the learnings entry ("HTTPS
substitution needs baked trust anchors") for the failure signature and the
`security/ca.nix` + `SSL_CERT_FILE`/`NIX_SSL_CERT_FILE` fix in `system.nix`.

Remaining: **Phase 5** (CI + binary cache — the design goal below: build on
x86_64, publish the wasm outputs, guest substitutes; issue #2).
In-guest installs work like a real NixOS system via BOTH `nix-env -iA` and
`nix profile install` (codebutler/nix-wasm#1), and crucially the two CLIs take
DIFFERENT paths through Nix. (1) `substitute = true` in the guest nix.conf
(`system.nix`): the NEW CLI (`nix profile`/`nix build`) probes for Internet and,
finding none, sets `useSubstitutes = false` UNLESS overridden — silently disabling
substitution even for a local `file://` cache (the substituter at the time; the
shipped config is Cachix-only now). Marking it overridden leaves it on.
(2) TWO catalogs next to the cache (`userspace/binary-cache.nix`): `pkgs.nix`
(REAL derivation entries) for `nix-env -iA <name>`, and `paths.nix` (a plain
name → output-path map) for the new CLI: read the path (`nix eval --raw -f
/nix-cache/paths.nix <name>`) and `nix profile install --option substitute true
<outPath>` (positional Opaque install). Two catalogs, not one,
because **`nix-env -iA` substitutes the `.drv` from the cache** (its realisation
fetches the deriver, then the output) — so the cache MUST publish the `.drv`
closures (`rootPaths = devPaths ++ map drvPath devPaths`) — whereas the **new CLI
forms a `Built{drvPath}` and then can NOT obtain a non-local `.drv`**: its
`queryMissing` marks it "unknown" (`src/libstore/misc.cc` → the "failed to obtain
derivation of …guest-cc.drv" error), so it installs the OUTPUT path directly
(Opaque, source-free) instead. The new CLI install passes `--option substitute
true` because its offline-Internet probe (`src/nix/main.cc`) sets
`useSubstitutes = false` unless overridden, and the `nix.conf` form of the
override isn't taking effect at the `getWorkerSettings()` level the check reads — a
command-line `--option` overrides for certain. **DEAD END (removed):** seeding the `.drv` closure
into the **base squashfs** (`wasmDrvSeed` + `nix-store --load-db`) — a `.drv`
closure pulls ~6.7 GB of build sources (a real system has none), overflowing the
boot harness's 2 GiB file cap. (The `.drv` closures DO belong in the binary cache,
served lazily over 9P — that is what nix-env substitutes; only *baking them into
the squashfs* was wrong.) **In-guest nixpkgs eval is now DONE** — `nix-env -iA
nixpkgs.<pkg>` evaluates ANY nixpkgs package against the wasm crossSystem and
substitutes the prebuilt wasm output (the `nixpkgs` channel; see "In-guest nixpkgs
channel" below + `docs/superpowers/notes/2026-06-28-nixpkgs-in-guest-eval.md`).
(Building derivations FROM SOURCE in-guest is a separate axis and works — see #92
below.) Archive ops work: `tar` (czf/xzf, patched) is validated. (The busybox
network/service applets stay compiled out for their vfork use — a process-model
matter, not a network one: the guest HAS real egress now, see the
Cachix-over-the-uplink entry above.)

## Caching (design goal)

The **host** must build from cache, not from source: pin a fully-cached nixpkgs
(`nixos-26.05`), build/CI on `x86_64-linux` (aarch64's cache lags → from-source
LLVM), and publish the wasm outputs (`cross.*`, `nix.wasm`, user packages) to a
binary cache. The **guest** then *substitutes* pre-built wasm artifacts rather
than building in-guest — that's the "install any package" model and what makes
the crossSystem approach scale. From-source host rebuilds are a failure mode to
design out (see the Environment notes under Hard-won learnings).

**Cache wiring (#2, Phase 5):** `nix-wasm.cachix.org` is BOTH the host build
cache AND the guest's substituter (public read; signing key
`nix-wasm.cachix.org-1:UlXbCihIfmQnzcyTQuRutvD0IPVVoHHAoIamxBJZUb0=`). Since
#82/#167 the shipped guest substitutes from it DIRECTLY over its own TCP/IP
(the wan0 Wisp uplink — see "Guest substitution is Cachix-over-the-uplink" in
Current state); the former guest-facing tier — the preview Worker's
`/cachix/<v>` route (`runtime/nix-cache.js` resolves one baseUrl; nars +
`*.narinfo` proxied from Cachix, nix-wasm#78) feeding the 9P-mounted
`/nix-cache` — now backs only the two catalogs (`pkgs.nix`/`paths.nix`, not in
Cachix, uploaded to R2) and the offline CI smokes' test-only local substituter
(`primeLocalNixCache`). Both `publish-to-r2.sh` and `publish-linux-channel.sh`
upload **only** the catalogs and point `nixCacheBaseUrl` at `/cachix/<v>` —
never the raw nar tree. CI runs on **x86_64-linux** (the flake is now parameterized over build hosts —
`packagesFor system` + `genAttrs ["x86_64-linux" "aarch64-linux"]`, with
`localSystem` threaded into `wasm-cross.nix`; `nix build .#X` picks the runner's
system). Four workflows:
- `.github/workflows/nix-wasm.yml` — builds the wasm world from source on a
  build-input/patch change and pushes to Cachix. The two from-source LLVM poles
  (`guest-clang`, `kernel`) build on their own runners in a matrix (each under the
  6h job limit, both in parallel), then the cheaper `artifacts` job
  (`nix-wasm`/`wasm-binary-cache`/`wasm-base-squashfs`) **substitutes** them from
  Cachix. Cold cache pays the LLVM rebuild once; warm reruns are minutes.
  Content-addressed — a `flake.lock`/`patches/` change self-invalidates (no
  manual cache key). The `artifacts` job also builds `wasm-initramfs` + the full
  `linux-image` boot bundle (wl-eyes is vendored in-repo — #62/#63 — so the whole
  guest is reproducible from a fresh checkout). A master-only step `cachix push`es
  the `.drv` closures (`.#wasm-cache-drv-roots`) — `nix-env -iA` substitutes the
  `.drv` before the output, and cachix-action's post-build-hook pushes only
  outputs (#82/#167).
- `.github/workflows/publish-wasm-artifacts.yml` — on master, substitutes the
  closure from Cachix and uploads `base.squashfs` + the `nix-cache/` tree to R2
  (`scripts/publish-to-r2.sh`).
- `.github/workflows/runtime-gates.yml` — runtime/ engine `test` + `typecheck`
  (the two gates green on a clean checkout). `lint`/`format:check` are red on
  pre-existing debt (no committed oxfmt/oxlint config) and deliberately unwired.
- `.github/workflows/publish-linux-channel.yml` — **the one-button guest
  republish to pc** (`workflow_dispatch`-only, `dry_run` input). Builds
  `.#linux-image` + `.#wasm-binary-cache`, uploads under a new content-hash
  version, flips `packages/linux/latest.json` (`scripts/publish-linux-channel.sh`).
  This is how a merged guest change (new app, userspace, kernel) reaches the live
  Linux app — see the `publish-linux-channel` pointer in "pc-facing delivery" above.

**Secret required:** add `CACHIX_AUTH_TOKEN` (a push token for `nix-wasm.cachix.org`)
to repo secrets so CI can push. Without it the jobs still substitute from the
public cache; they just don't populate it. (The R2 publish also needs
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.)

## ccache (opt-in compile cache — dev iteration only)

ccache is **not** the caching design goal above (that's the Nix binary cache,
which works at derivation granularity). ccache is orthogonal: it speeds up the
*dev loop* on the two from-source LLVM builds — `guest-clang` and the kernel's
patched LLVM (`kernel-llvm`) — where tweaking a flag or patch changes the
derivation hash and forces a full ~1–2 h rebuild even though almost every C++ TU
is identical. ccache reuses those object files, turning the rebuild into minutes.

It is **off by default** (PRIME DIRECTIVE: the standard build is fully hermetic;
the default `.#guest-clang` / `.#kernel` derivation hashes are unchanged). The
cache dir is an impure `extra-sandbox-path`, so it's gated behind separate flake
attrs and explicit host setup. ccache (daemonless) is used, not sccache (its
background server doesn't fit the per-derivation Nix sandbox; its distributed
backend would only duplicate the Nix binary cache).

**One-time host setup** (the cache dir + exposing it into the build sandbox):

```sh
echo password | sudo -S install -d -m 0770 -o root -g nixbld /nix/var/cache/ccache
# Expose the dir into the sandbox (the daemon reads /etc/nix/nix.conf):
echo password | sudo -S sh -c \
  "echo 'extra-sandbox-paths = /nix/var/cache/ccache' >> /etc/nix/nix.conf"
echo password | sudo -S systemctl restart nix-daemon   # reload the daemon
```

**Build with ccache** (cold first build still compiles from source — it *populates*
the cache; the speedup is on the *next* rebuild after a source change):

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#guest-clang-ccache --print-out-paths      # in-guest clang+lld
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' \
  build .#kernel-ccache --print-out-paths           # vmlinux.wasm (patched LLVM cached)
```

Inspect hit rate with `ccache -s -d /nix/var/cache/ccache`. The ccache outputs
are deterministic (bit-identical to the hermetic builds) but carry a different
input-addressed store path — they're for iteration, not for publishing as the
canonical `.#guest-clang` / `.#kernel` artifacts. The wiring is a `useCcache`
arg on `toolchain/{guest-clang,kernel-llvm}.nix` (cmake `COMPILER_LAUNCHER`).

## Hard-won learnings (gotchas & dead-ends)

Each was a real bug or a rejected approach; the detailed root-cause narrative
lives in the relevant `.nix`/patch comment + git history. This is the index of
*why* the non-obvious flags exist so they aren't "cleaned up" and re-broken.

**Cross-build (shared crossSystem/overlay — what makes nixpkgs packages
cross-compile; all in `wasm-cross.nix` / `deps-overlay.nix`):**
- **Static is a PLATFORM flag, not per-dep.** `crossSystem.isStatic = true` AND
  force `hasSharedLibraries = true` back on (else sqlite reads the now-missing
  `extensions.sharedLibrary` → eval abort). nixpkgs then applies `makeStatic`
  everywhere; the `__musl_tp` general-dynamic-TLS reloc only trips when linking a
  separate `.so`, so keeping everything static (incl. stdio) is correct, and
  `-static` is a harmless no-op on our `-shared` dylink modules.
- **`musl` must be OUR nix-built musl** (override the `musl` attr). nixpkgs'
  cross-musl bootstrap embeds a compiler-rt built with the clang-rejected
  `wasm32-unknown-linux-musl` triple, in a stage *neither `overlays` nor
  `crossOverlays` reach* → cascades to everything (via `libiconv`). Wrapping our
  own musl eliminates that bad bootstrap compiler-rt.
- **compiler-rt triple** = force `wasm32-unknown-unknown` (clang rejects
  `-linux-musl`); override `llvmPackages_21.compiler-rt` via `overrideScope` (the
  top-level `compiler-rt` attr doesn't exist here — that override was dead code).
- **ALWAYS guard overlay overrides with `prev.stdenv.hostPlatform.isWasm`** — the
  overlay hits `buildPackages` too; an unguarded `zlib`/`openssl` override rebuilds
  the *entire native toolchain* (coreutils, python) from source.
- **libc++abi self-contained**: fold `Unwind-wasm.o` INTO `libc++abi.a`
  (`toolchain/libcxx.nix`) so `_Unwind_*` resolves internally — cc-wrapper
  consumers can't reliably inject `-lunwind` after clang's auto `-lc++abi`.
- **bintools**: stock LLVM ships `ar`/`ranlib` *unprefixed* → add the
  target-prefixed symlinks or `$AR`/`$RANLIB` come up empty.
- **wasm-ld flag filter** must also drop `--compress-debug-sections` (silently
  failed every sqlite autosetup link probe → bogus "Cannot find libm") alongside
  the ELF-only flags (`--undefined-version`, …).
- **`-fvisibility=hidden` in the cc-wrapper** (`wasm-cross.nix`; #7): C++ standard
  library stream objects (`std::cout`, `std::cin`, …) have vtable/typeinfo symbols
  that clang emits as `default` visibility even in `-fvisibility=hidden` builds. When
  those symbols flow through the cc-wrapper WITHOUT `-fvisibility=hidden`, wasm-ld
  emits them as `env.*` imports (external undefined), causing a `LinkError` at
  instantiation. Fix: pass `-fvisibility=hidden` in the cc-wrapper's `$NIX_CFLAGS_COMPILE`
  so ALL cross-compiled objects get it — the vtable/typeinfo definitions are then
  hidden and wasm-ld keeps them internal instead of emitting import stubs.
- **Sommelier virtwl `NEW_DMABUF→-ENOTTY` shm-path selection** (`patches/kernel/0013`):
  the kernel's `virtwl_ioctl_new` must return `-ENOTTY` (not `-EINVAL`) when the
  `VIRTWL_IOCTL_NEW_DMABUF` subtype is unsupported. Sommelier's `virtwl_channel.cc`
  probes for dmabuf support with that ioctl; a `−EINVAL` response means "bad args, try
  again" (infinite retry / crash), whereas `-ENOTTY` means "not implemented, use plain
  virtwl" — which triggers the `"using virtwl instead"` fallback and lets wl_shm
  operate normally. The probe result is logged at Sommelier startup.
- **Sommelier link-only cross closure (libxcb/libdrm/minigbm)** (`userspace/sommelier.nix`;
  `deps-overlay.nix`): Sommelier's build system unconditionally links `libxcb`, `libdrm`,
  and `minigbm` even on the wayland-only/no-GPU path. None of these are used at runtime
  on the NOMMU wasm guest (no X11, no DRM, no GBM). Cross them as **link-only stubs**:
  `libxcb` via `cross.xorg.libxcb` (nixpkgs, cross-builds fine for headers); `libdrm`
  via `cross.libdrm` (nixpkgs); `minigbm` via a minimal `userspace/minigbm.nix` stub
  that provides the `gbm.h` header and an empty `libgbm.a` (the GPU entry points are
  never called — any call aborts via the allow-list contract). Do NOT pull in the full
  GPU stack (mesa, EGL, DRM device nodes); these are purely link-time satisfiers.
- **crt `int main`**: a weak 2-arg crt `main` wrapper (`musl.nix`) so all of
  `int main(void)` / `(int,char**)` link — else autoconf's "C compiler cannot
  create executables" aborts every autoconf dep.
- **No-undef contract = `--allow-undefined-file`, NEVER blanket `--allow-undefined`**
  (`toolchain/wasm-host-imports.nix`; #52): every guest dylink link — the crossSystem
  cc-wrapper (`wasm-cross.nix`), `guest-clang`/`guest-cxx`/`guest-cc`, and nix.wasm's
  `wcxx` (`nix-wasm.nix`) — allows undefined ONLY the documented host-provided imports
  via the **one shared allow-list file** (`__wasm_abort`, `__cpp_exception`, `logAPIs`,
  `__dlsym_time64`, `__cxa_thread_atexit_impl`, `__wasm_syscall_0..6` — empirically the
  exact superset of every guest binary's `env.*` imports). A **blanket
  `--allow-undefined` (or `--import-undefined`) silently turns ANY unresolved symbol
  into an `env.*` import** — exactly how #36's removal of `fork` from musl became the
  #50 dangling `env.fork` LinkError instead of a build failure. The allow-list restores
  #36's "callers fail to link" contract: a stray `fork`/`exec`/`system` fails the link
  loudly. `.#nofork-linkcheck` is the gate; memory/table/base come from
  `--import-memory`/`--import-table`, NOT this list. (Editing the list rebuilds
  guest-clang + nix.wasm + `.#userspace-busybox-fork` → the fork initramfs → the
  fork squashfs, since #131 slice-1 PR-2 wired `busybox-fork.nix`'s post-link
  `wasm-check-imports.py` check to consume the same generated file as an
  argument; the cross.* set is keyed on the byte-identical store path so it
  stays cached.)
- **Startup-export contract = the shared `toolchain/wasm-host-exports.nix`; a link
  without `--export-all` MUST name every engine-called startup export** (#179; the
  mirror image of the allow-list entry above). The host bridge calls
  `__wasm_apply_data_relocs` → `__wasm_early_tp_init` → `__wasm_call_ctors` → `_start`
  on each fresh instance, each behind a permissive `if (instance.exports.__X)` (so an
  older guest libc still boots) — which makes a MISSING export **silent in the
  engine**. Most links get the set for free from `--export-all`; the two that don't —
  `toolchain/guest-clang.nix` (dropping `--export-all` lets wasm-ld's default
  `--gc-sections` strip a ~100MB module) and `nix-wasm.nix`'s `wcxx` — used to spell
  it out by hand, and the copies DRIFTED: guest-clang's never gained
  `__wasm_early_tp_init`, so `--gc-sections` deleted the (now unreferenced) thread-
  pointer seed and clang/wasm-ld ran their ctors with `__musl_tp == 0` → `errno` stored
  through a null `struct pthread` at VA **0x1c** → fine on NOMMU, SIGSEGV before
  `_start` under CONFIG_MMU. So `--export-if-defined=<name>` here is doing TWO jobs
  (export AND root-against-gc) — don't "clean up" a name that looks unused. Both
  non-`--export-all` links now read the ONE list; the `--export-all` ones deliberately
  do NOT (they satisfy it by construction, and touching `wasm-cross.nix` costs a full
  `cross.*` world rebuild). Gate: `guest-clang.nix`'s `installPhase` asserts the
  shipped `clang`/`wasm-ld` really export the required set via
  `scripts/wasm-check-exports.py` — which parses the **export section**, because these
  binaries are `--strip-all`ed (no name section) and a plain `grep` for the symbol
  would also match a data string. The engine additionally logs loudly when an MMU
  image (`pt_base != 0`) lacks the seed.
  **Second half of the same contract — `-u` FORCES, `--export-all` does not**
  (`forcedNames`/`ldFlagsForce`; also #179): `--export-all` and
  `--export-if-defined` only act on what the link ALREADY CONTAINS.
  `__get_tls_base`/`__set_tls_base` live in musl's `src/thread/wasm/clone.S`, a
  **lazy archive member** pulled only when something references `__clone`. Every
  real guest program (busybox, nix.wasm, clang — they all spawn) pulls it
  incidentally, but a trivial `int main(){return 42;}` compiled **in the guest**
  does not — and the software-MMU pass HARD-REQUIRES `__get_tls_base` at `execve`
  (its fault call needs musl's `tp` operand, and `__tls_base` is an internal
  global it cannot read; passing a dummy 0 would be WRONG, not lenient — the
  syscall FOOT restores user tls from pt_regs, so it would clobber the live
  thread pointer, and `__musl_tp` is itself `_Thread_local`). So
  `toolchain/wasm-clang-config.nix` (the IN-GUEST `clang.cfg`, the one link that
  produces minimal user programs) passes `-Wl,-u,` for both accessors. Without
  it, `cc h.c -o h` succeeds and `./h` **panics the guest kernel** on the MMU
  guest (`Aiee, killing interrupt handler!` — the pass's exec-time throw becomes
  `raise_exception()` → `make_task_dead` in kernel context). Boot-verified both
  ways. The remaining hardening gap: an unsupported user binary should fail
  `execve` with `-ENOEXEC`, not panic — that needs the exec host import to return
  a status the kernel checks (an ENGINE_ABI change), so it is deliberately NOT
  done here.
- **libffi raw wasm backend** (`deps-overlay.nix` / `patches/libffi/`): the
  upstream `src/wasm/ffi.c` is emscripten-only; we drop in `wasm32-raw-ffi.c`
  which dispatches `ffi_call` through a build-time generated trampoline table
  (`gen-trampolines.py`, ~8375 entries) keyed on the per-arg wasm value-type
  vector (i32/i64/f32/f64). Supports i32/i64/f32/f64 by-value scalar arguments
  up to K=24 all-i32 / K=10 mixed, M=2 non-i32 per call (covers libwayland's
  i32/ptr dispatch AND GObject signal marshallers with double/int64 args); aborts
  loud past the (K,M) bounds or on struct args/varargs/closures — never a silent
  mis-call. Bump K/M in gen-trampolines.py to extend coverage if needed.
- **M2 text stack** (`deps-overlay.nix` / `userspace/fonts.nix`): **harfbuzz** is
  forced glib-free (`glib=null` + `-Dglib=disabled -Dgobject=disabled`) — nixpkgs
  enables hb-glib by default, which drags the whole glib cross-build into M2 (glib
  + pango are M3); also drop the `devdoc` output (`outputs=["out" "dev"]`) since
  `-Ddocs=disabled` means the gtk-doc devdoc dir is never created and the builder
  errors on the missing output. **cairo** is rebuilt with freetype+fontconfig
  backends strictly additive: un-null freetype/fontconfig + flip the meson flags to
  `enabled`; glib/x11/png/lzo stay off; weston-flowers (image-surface-only) is the
  regression gate. **Guest font lives in the Nix system profile** (`userspace/
  fonts.nix` + `system.nix` bake DejaVu + `/etc/fonts/fonts.conf` +
  `FONTCONFIG_FILE`): the wl-text/M2 smoke MUST boot `nix:true` (served `/nix`
  closure) — a busybox-only boot has no font config and fontconfig `FcInit` fails.
  Rebuild `.#wasm-base-squashfs` after any `fonts.nix`/`system.nix` change so
  the new store path is included in the served `base.squashfs`.
- **M3a glib/gobject** (`deps-overlay.nix` glib override): disable
  `selinux`/`libmount`/`sysprof`/`man-pages`/`dtrace`/`documentation` + `tests`
  (nixpkgs glib drags libselinux/libsepol + util-linux/libmount + libsysprof-capture
  — none cross to NOMMU wasm, none needed). `util-linuxMinimal` can't be `null`ed
  (an `isLinux` assert) → filter it out of build/propagated inputs post-override;
  drop **target** `gnum4` (m4 won't cross — gnulib `stackvma.c` has no wasm path; the
  guest never uses glib's m4 macros); drop the `devdoc` output (like harfbuzz). gio
  modules build **into libgio** (the NOMMU guest can't dlopen). Codegen tools
  (glib-genmarshal/compile-schemas/…) come from native `buildPackages` via meson cross.
- **futex_time64 arity** (`patches/kernel/0015`; `runtime/kernel-worker.js`): `__NR_futex_time64`
  (422) stays mapped to the **6-arg `sys_futex`** in the kernel syscall table — this is
  correct because nix.wasm's **musl pthread** issues 6-arg futex calls and a 4-arg kernel
  entry trapped them under heavy threading (large on-demand `nix-env` installs). Glib's raw
  `syscall()` (`g_futex_simple`) calls with only **4** args (`uaddr,op,val,utime`) for
  FUTEX_WAIT/WAKE → strict wasm `call_indirect` on the 6-arg handler would trap. Fix =
  a **host shim in `runtime/kernel-worker.js`** that intercepts `__wasm_syscall_4` with
  `nr==422` and forwards to `wasm_syscall_6` zero-padding `uaddr2/val3` (safe for
  FUTEX_WAIT/WAKE). Patch 0015 keeps an unregistered `SYSCALL_DEFINE4(wasm32_futex)` for
  reference only — the syscall table entry is the 6-arg handler. (This host edit, like all
  `kernel-worker.js` edits, needs a pc sync via `sync-to-pc.sh`.)
- **Host imports that take USER pointers must translate under the software MMU**
  (`runtime/mmu-uaccess.js` + the dl/ffi imports in `kernel-worker.js`; found by #184's
  first MMU soak cycle, tracked to done via nix-wasm#185). THREE parties touch user
  memory under CONFIG_MMU=y: instrumented guest code (the softmmu pass's inline walk),
  the kernel (patch 0023's soft uaccess), and HOST IMPORTS — and the third was missed
  when the ABI-8 dlopen/dlsym surface landed (#130 predates the first MMU boot).
  `__wasm_dlsym` read the symbol NAME at the raw user VA → garbage → GModule's
  "Could not find signal handler 'wf_on_buf_changed'" (the widget-factory soak
  failure — NOT a missing dynsym seam, widget-factory has one); `__wasm_dl_probe`/
  `__wasm_dlopen` read the module IMAGE raw → "not a wasm dylink module". Correct on
  NOMMU purely because VA == linear-memory offset there. Fix: `mmu-uaccess.js`, a
  host-side soft-uaccess walk (same 2-level format as the pass and `mm/uaccess.c` —
  per-LEVEL present tests per the A2 keystone, `_PAGE_WRITE` enforced on stores so a
  host write can't corrupt a COW page, page-wise gather/scatter since user buffers
  aren't physically contiguous, NO fault-and-retry: a host import can't re-enter the
  kernel's fault path, so a non-present page is a loud clean per-call failure).
  Boot-verified: widget-factory-smoke PASS on `.#kernel-mmu-a2`, dltest `self=1`,
  NOMMU byte-identical (identity path). The OTHER half of the same finding —
  runtime-instantiated side modules and ffi trampolines are UN-instrumented guest
  code — is refused loudly for now (`-ENOEXEC` dlerror / the C `wasm_ffi_unsupported`
  abort, never silent corruption; the checked pass needs imports a side module
  doesn't have — full design constraints in #185). New host-import rule going
  forward: any import taking a guest pointer must state whether it's a KERNEL
  (identity) or USER (translate via mmu-uaccess) address, and use the walk for user
  ones. (Engine edits → pc sync via `sync-to-pc.sh` before any pc deploy, as ever.)
- **glib/GTK `__lsan_*` loader stubs — DO NOT "clean up"** (`runtime/kernel-worker.js`):
  wasm-ld emits glib's weak-undef `__lsan_enable`/`__lsan_ignore_object` as BOTH an
  `env` import AND a `GOT.func` import. Instantiation FAILS if the `env` no-op stub is
  absent even though the function is never called (its `GOT.func` address resolves to 0
  → the call guard is false). The `GOT.func`/`GOT.mem` Proxy is scoped to those two
  import namespaces ONLY — it can't touch `env.*` or the internal `GOT.func.internal.*`
  defined globals (those carry real function-pointer relocs and are untouched). **M3b
  GTK adds `__lsan_disable`** — the 14.6MB libgtk references the full disable/enable
  bracket pair (not just glib's enable/ignore_object); same weak-undef mechanism, same
  no-op `env` stub. (kernel-worker.js host edits need a `pc` sync — `runtime/sync-to-pc.sh`.)
- **gobject class_init trap = wasm strict-`call_indirect` SIGNATURE cast, NOT a reloc
  bug** (third instance of this theme, with libffi/M1 + futex): glib casts
  `g_object_do_class_init` (1-arg) to the 2-arg `GClassInitFunc` and calls it through
  that type; strict wasm traps, and LLVM-21's opaque pointers leave no IR bitcast for
  `WebAssemblyFixFunctionBitcasts` (no clang/wasm-ld flag). Fix = a **binaryen post-link
  pass** `wasm-opt -pa max-func-params@128 --fpcast-emu` (emscripten's
  `EMULATE_FUNCTION_POINTER_CASTS` equivalent; `max-func-params@128` because the 18
  default is too narrow). Apply it **per-binary** to each glib/GTK-linking executable
  (a shared seam) — NOT globally in the cc-wrapper, which would rewrite the calling
  convention of EVERY guest binary (nix.wasm, busybox, the libffi backend). No-op for
  the libffi raw `ffi_call` path (that `call_indirect` already has the right arity).
  The seam lives in **`userspace/fpcast-emu.nix`** (`{ binaryen, shellFn }`); glib/GTK
  binaries add `fpcast.binaryen` to `nativeBuildInputs` and run `fpcast_emu in out`
  post-link. **pango** cross-builds clean with NO override (stock nixpkgs, once glib +
  the M2 text stack exist) and the same seam covers its gobject casts — proven by
  `pango-text` (`pango_cairo_show_layout` → fontconfig → cairo-ft).
- **M3b GTK3 cross-build** (`deps-overlay.nix` gtk3 override): **wayland-only** —
  force `x11Support`/`cupsSupport`/`vulkanSupport`/`broadwaySupport`/`trackerSupport`
  off and `wayland` on (the heavies — cups, avahi, X11/xorg, vulkan-loader — don't
  cross to NOMMU wasm and aren't needed); GObject-introspection off (no typelib
  consumer on the guest). **gdk-pixbuf** uses its **built-in loaders** (no
  `loaders.cache`/runtime dlopen — NOMMU can't dlopen modules); **libepoxy** builds
  with **no GL/EGL/GLX** (`-Degl=no -Dglx=no -Dx11=false`, EGL headers absent — GTK's
  wayland backend uses the cairo software path, no GL); **atk** ships with **no a11y
  bridge** (no at-spi/dbus). GTK needs the **baked GSettings schemas** — Task 3 compiles
  `org.gtk.Settings.*` with NATIVE `glib-compile-schemas` into `gtk-assets` and points
  `GSETTINGS_SCHEMA_DIR` at them (`system.nix`); without them GLib aborts at
  `gtk_settings`. **`gtk-hello`** is the proof, built through the shared **fpcast-emu
  seam** (gtk is gobject-heavy → fn-pointer casts; the 14.6MB libgtk has many). The
  `--selftest` gate is **compositor-independent**: the node harness has only a minimal
  `wl` registry (no compositor), so `gtk_init_check` returns FALSE (no GdkDisplay) and
  GTK *instance* construction (`gtk_window_new`) aborts ("Can't create a
  GtkStyleContext without a display connection"). The gate instead `g_type_class_ref`s
  `GTK_TYPE_WINDOW`/`GTK_TYPE_LABEL` (runs each class_init through the fpcast seam,
  display-free) and asserts `g_type_from_name` + `gtk_get_major_version()==3`. The full
  window *render* **now works in the browser** (a real GTK window with the label
  draws via Greenfield) — it was gated on the `/dev/shm` mount, see the Guest
  runtime/kernel learnings below (`docs/superpowers/notes/m3b-gtk-visual.md`).
- **Served-store bloat: drop galculator's `nix-support` ONLY — do NOT strip binary refs**
  (`deps-overlay.nix` galculator override `postFixup`; issue #43). galculator is in
  `environment.systemPackages` (for its `.ui` files), so it's in the served `/nix` closure.
  The catastrophic bloat (~26MB→**345MB** served closure / 3.2k→22.5k files) was
  galculator's `$out/nix-support/propagated-build-inputs` recording `gtk+3-dev`, which
  propagates `pango-dev → libxft-dev → the whole X11 + glibc-locale -dev tree`. galculator
  is a LEAF app (nothing builds against it), so that propagation metadata is pure dead
  weight the ref scanner still follows. **Fix: `rm -rf $out/nix-support`** → ~127MB / 7.5k
  files, X11/glibc/locale gone. **DEAD-END (caused a regression, reverted):** also running
  `remove-references-to` over gtk3/glib/gdk-pixbuf/pango/xkeyboard-config/… to shrink
  further (→28MB) looks safe for a static binary but **breaks GTK at runtime** — those
  binary refs include REAL runtime data deps that ride the served closure for ALL GTK
  wayland apps, notably **xkeyboard-config** (libxkbcommon loads `…/etc/X11/xkb` at startup
  to build the XKB keymap; gdk treats a keymap failure as FATAL → every app died with
  `Gdk-ERROR: Failed to create XKB keymap`). So keep ONLY the `nix-support` removal; the
  remaining gtk3/glib data is the legitimate cost of shipping a GTK app, not bloat. The
  squashfs format (#43) resolved the deeper format issue.
- **M4 galculator packaging** (`deps-overlay.nix` `galculator` override): galculator
  2.1.4 is a plain GTK3 autotools app (`pkg_modules = "gtk+-3.0"`); packaged via an
  `isWasm`-guarded nixpkgs override (NOT a from-scratch `userspace/galculator.nix` —
  reuses nixpkgs' own recipe + its three patches, corollary 1) that applies the
  shared `--fpcast-emu` post-link pass in `postFixup` (gobject casts) and **appends a
  `--selftest` source patch** (`patches/galculator/0001-add-selftest.patch`) to
  nixpkgs' patch list. No GSettings schema (galculator uses
  `~/.config/galculator/galculator.conf`). `.ui` files ride the served `/nix` closure
  as filesystem data (`$out/share/galculator/ui/`), loaded at runtime from the
  hardcoded `PACKAGE_UI_DIR` — so galculator must be in `environment.systemPackages`
  (`userspace/system.nix`), NOT just the initramfs `extraBins`, or only the binary
  reaches the guest and the `.ui` files are absent. Two build fixes required: (1)
  **graphite2 .la file** — cmake emits `library_names=libgraphite2.so` on a static
  build (no `.so` produced); downstream libtool-based autotools (galculator) try to
  link the nonexistent `.so`. Fix: `postInstall` sed rewrites the `.la` to clear
  `library_names` and set `old_library=libgraphite2.a`. (2) **autopoint xz PATH** —
  `autoreconfHook` runs `autopoint` (inside `autoconf`) which decompresses
  `archive.dir.tar.xz` with a bare `xz` call; with `strictDeps=false` (needed for
  `AM_GLIB_GNU_GETTEXT` m4 macro lookup) the cross `xz` wasm binary shadows the
  native one. Fix: `preAutoreconf` creates `$TMPDIR/native-xz-bin/xz` symlink →
  native `xz`, prepended to PATH. **`--selftest` is the headless gate**: it must be
  **display-free** — the cross GTK3 is wayland-only and the node harness has no
  compositor, so `GtkBuilder` CANNOT instantiate the `.ui` widgets (GtkWindow
  construction needs a GdkDisplay → fatal `Gtk-ERROR: Can't create a GtkStyleContext
  without a display connection`). Like the M3b `gtk-hello` gate, the selftest instead
  parses the real `.ui` files (`MAIN_GLADE_FILE` = `main_frame.ui`,
  `BASIC_GLADE_FILE` = `basic_buttons_gtk3.ui`) with GLib's GMarkup XML parser —
  asserting `GtkWindow "main_window"` + `GtkToggleButton "button_7"` — and
  `g_type_class_ref`s those widget classes (display-free gobject class_init through
  the fpcast seam), printing `GALCULATOR-SELFTEST: main_window=1 button_7=1
  gtk_types=1 OK`. Gate: `node demo/node/galculator-smoke.mjs` matches
  `/GALCULATOR-SELFTEST: .* OK/`. The full click-to-42 compute is a MANUAL browser
  check (PENDING, `docs/superpowers/notes/m4-galculator-visual.md`). **CAVEAT — the
  real galculator window is GATED by the GModule wall below**: its `--selftest`
  passes but `gtk_builder_connect_signals(NULL)` over its 115 `.ui` handlers needs
  a working GModule, which the static guest lacks. The visual headline moved to
  gtk3-widget-factory (next entry).
- **GtkBuilder signal autoconnect on the static guest = `add_callback_symbol`, NOT
  a runtime `dlsym`** (`userspace/widget-factory.nix`, `patches/widget-factory/`,
  issue #33). `gtk_builder_connect_signals(builder, NULL)` resolves `.ui` `<signal
  handler="...">` names via `g_module_open(NULL)`/`g_module_symbol` → musl
  `dlopen(NULL)`/`dlsym`, which the statically-linked guest stubs to NULL →
  `Gtk-ERROR: requires working GModule`. **A host-side `dlsym` CANNOT fix this** (a
  full impl was built + world-rebuild-tested, then reverted — see #33): `--fpcast-emu`
  rewrites every indirect call to a canonical `(i64×128)→i64` sig, so a fn-pointer
  must be a canonical *thunk* (made only for address-taken fns); the host can neither
  synthesize one (`WebAssembly.Function` absent in Node/browsers) nor locate one by
  name (binaryen exports no thunks). Only `&function` in C yields the fpcast-correct
  thunk → resolution MUST be guest-side. The GTK-sanctioned static path
  (`gtk_builder_connect_signals_default` source: `g_error`s only for an *unregistered*
  handler) is `gtk_builder_add_callback_symbol(builder,"on_foo",G_CALLBACK(on_foo))`
  per handler — `&on_foo` is the fpcast canonical thunk, and a fully-registered scope
  never opens GModule (the NULL `g_module_open` is harmless). **fork was never the
  blocker here** (orthogonal to #25/#29). **Headline app = gtk3-widget-factory**
  (GTK's own showcase, no new deps, built standalone against cross gtk3 so gtk3
  itself stays cached): it registers 17/18 handlers upstream; the patch adds the one
  it leaves to GModule (`gtk_widget_hide_on_delete`) so the real app autoconnects
  fully, and adds a display-free `--selftest` (a `GtkTextBuffer` `.ui` signal:
  register → `connect_signals` → emit → assert the handler fired through fpcast).
  Gate: `node demo/node/widget-factory-smoke.mjs` matches `/WIDGET-FACTORY-SELFTEST:
  .* OK/` (`buf=1 connected_no_gmodule=1 handler_ran=1 major=3`). The full window
  **RENDERS in the browser** (complete widget showcase, Adwaita theme) once the
  /dev/shm mount + musl `__unmapself` + 1.75 GiB RAM fixes are in.
- **gtk3-demo — the first REAL (non-showcase) GTK3 app, and the proof that the
  GModule wall is a SIGNAL-WIRING-STYLE issue, not a GTK-app issue**
  (`userspace/gtk-demo.nix`, `patches/gtk-demo/0001-add-selftest.patch`). Where
  galculator/widget-factory load a `.ui` and resolve its `<signal handler="…">`
  names at runtime — galculator via `gtk_builder_connect_signals(NULL)` →
  `g_module_open(NULL)`/`dlsym` (the GModule wall the static guest can't cross),
  widget-factory via the `add_callback_symbol` workaround — **gtk3-demo's main
  window never calls `gtk_builder_connect_signals` at all**: `main.c` loads
  `main.ui`/`appmenu.ui` with `gtk_builder_add_*_from_resource`, fetches objects
  by id, and wires every signal in C with `g_signal_connect`. So a full
  GtkApplication browser (GtkTreeView demo list + source viewer + run pane) runs
  with NO GModule dependency — the "real GTK app" that galculator couldn't be.
  Built standalone against the cross gtk3 (gtk3's library build stays cached;
  demos=false there), reproducing `demos/gtk-demo/meson.build` by hand like
  widget-factory.nix: native `geninclude.py` → `demos.h` (the `do_<demo>`
  dispatch table), native `glib-compile-resources` (embeds every `.ui`/`.css`/
  image + the demo `.c` sources for the in-app source viewer), `$CC` over every
  demo `.c` (all `*.c` EXCEPT `application.c` — the separate gtk3-demo-application
  program's own `main()` — `gtkfishbowl.c` the helper, and `main.c`) + the two
  generated `.c`, then the shared `--fpcast-emu` post-link pass. Resources are
  EMBEDDED in the binary, so it ships as an initramfs extraBin (no share dir),
  needing only gtk's own runtime data (gtk-assets, fonts) already in the system —
  and no GSettings schema (main never calls `g_settings_new`). `--selftest` is
  the display-free gate: it walks the generated `gtk_demos[]` table asserting
  >10 rows and >10 non-NULL `do_<demo>` fn-pointers (group rows carry func==NULL
  by design — assert thresholds, not equality — every non-NULL func is a real
  address-taken fpcast canonical thunk), runs a few browser-chrome widget
  `class_init`s through the fpcast seam (`g_type_class_ref`, no display), and
  checks `gtk_get_major_version()==3`. Gate: `node demo/node/gtk-demo-smoke.mjs`
  matches `/GTK-DEMO-SELFTEST: .* OK/`. The full browser window is a MANUAL
  browser check (it reuses the same /dev/shm + `__unmapself` + RAM fixes
  widget-factory needs). Caveat: a couple of individual demos won't work at
  runtime on this guest — the `builder` demo would hit the GModule wall if its
  own `.ui` autoconnect path is exercised, and `glarea` needs GL (libepoxy is
  built no-GL) — but the browser itself and the bulk of the demos do.
- **l3afpad — the first real productivity app** (`userspace/l3afpad.nix`,
  `patches/l3afpad/`, `deps-overlay.nix` `l3afpad`; issue #122). The GTK3 fork
  of leafpad — a Notepad-class open/edit/save text editor, the follow-through
  on the gtk3-demo lesson: it wires every signal in C (menu.c's
  `GtkActionEntry` tables with `G_CALLBACK` fn pointers + `g_signal_connect`
  in window.c) and never calls `gtk_builder_connect_signals`, so NO GModule
  wall and NO dynsym inject — just the shared `--fpcast-emu` post-link pass.
  nixpkgs dropped l3afpad before our pin, so it is a from-scratch derivation
  like gcalctool (in the overlay as `cross.l3afpad`), pinned to the same
  rev+hash nixpkgs last shipped (24.05). The source is a git checkout (no
  pre-generated ./configure, no po/Makefile.in.in), so the build runs
  `autoreconfHook` **plus `intltoolize` in `preAutoreconf`** (the step
  upstream's autogen.sh and Debian's dh_autoreconf run — autoreconf alone does
  not invoke intltoolize). Its 2013-era `AM_CONFIG_HEADER` / two-arg
  `AM_INIT_AUTOMAKE` are fine: automake 1.17 still accepts both
  (obsolete-warning only — verified in automake's m4/obsolete.m4 + init.m4).
  `--disable-print` + **patch 0002 compile out gtkprint.c entirely**: upstream
  guards every print *use* with `#if ENABLE_PRINT` but left the definitions
  unconditional, and the wayland-only/no-cups cross gtk3 has no unix-print
  layer (the gtk3-demo pagesetup.c gap) — the unconditional TU would pull
  missing libgtk members at link. `strictDeps=false` for glib's
  `AM_GLIB_DEFINE_LOCALEDIR` m4 (same as galculator's `AM_GLIB_GNU_GETTEXT`).
  Ships via `environment.systemPackages` ONLY (NOT initramfs `extraBins` — the
  gcalctool tmpfs lesson: the binary loads from the evictable squashfs, and
  its `share/pixmaps/l3afpad.png` window icon — loaded at runtime from the
  baked ICONDIR store path — rides the served closure). `--selftest` is the
  display-free gate: widget `class_init`s (menubar/textview/scrolled-window)
  through the fpcast seam, a real `GtkTextBuffer` "changed" signal fired into
  an address-taken C handler (buffers, unlike widgets, are instantiable
  without a display), `gtk_get_major_version()==3`. Gate:
  `node demo/node/l3afpad-smoke.mjs` matches `/L3AFPAD-SELFTEST: .* OK/` (in
  the `nix-boot-smoke` CI job, one-per-boot like its GTK siblings). The
  open/edit/save-a-file-to-/mnt/pc flow is a MANUAL browser check.

**`nix.wasm` link/build (`nix-wasm.nix`):**
- `-DBOOST_STACKTRACE_USE_NOOP` (Nix's crash handler pulls unimplementable
  `_Unwind_Backtrace`); `dontUseMesonConfigure` (the meson hook ran a native
  configure first); patch out llhttp's `#if defined(__wasm__)` JS-host-callback
  block (dead/wrong when embedded). The meson `-r` prelink can't emit wasm TLS
  relocs → the custom `.o` link (a real wasm limit; see Architecture).
- **`nuke-refs` the closure** (`nixWasmClean`): `nix.wasm` embeds dead build-path
  refs (openssl/boost-dev/json → transitively native glibc + locales) that balloon
  the served closure to ~258 MB / 18k files; strip them post-build.
- **sqlite `-DSQLITE_OMIT_WAL -DSQLITE_THREADSAFE=0`**: WAL's `-shm` shared-memory
  file is unsupported on the NOMMU guest fs → `SQLITE_IOERR` on the store DB.

**Guest runtime / kernel:**
- **No fork/vfork — clone-with-fn only.** A fresh wasm instance can't resume the
  parent mid-function, so `fork()`/`vfork()` are unimplementable. The `fork`/`vfork`
  symbols are **removed from the nix-built musl** (`toolchain/musl.nix`) → a caller
  fails to **link** in its Nix build (loud, traceable) rather than SIGILL/abort at
  runtime. Everything that "spawns" (busybox, ash, `make`, nix's external `sh`
  builder, glib's `g_spawn`) goes through `posix_spawn` / clone-with-fn; this is why
  busybox + ash + glib carry the spawn-port patches. Holdouts follow one documented
  rule (don't-build an unused CLI / port a library to `posix_spawn` / compile out an
  unused return-twice symbol). **Full contract: `docs/process-model.md`.**
- **SA_RESTART: deliver the handler at the FOOT, then re-invoke the syscall
  (transparent restart)** (`patches/kernel/0021-wasm-sa-restart-deliver-signal.patch`
  on `arch/wasm/kernel/{traps.c,entry.S}`; **#75, FIXED**). The bug: a blocking
  syscall interrupted by a signal whose handler was installed with `SA_RESTART`
  (e.g. `signal()`, which musl maps to `SA_RESTART`) returns `-ERESTARTSYS`;
  `handle_signal()` (signal.c) keeps it (will restart) and `setup_rt_frame()`
  queues the handler (`_TIF_DELIVER_SIGNAL`). But the queued handler is only run by
  `_user_mode_tail` in the asm FOOT (`entry.S`), which runs AFTER `__wasm_syscall_N`
  returns — and the C restart `do/while` re-entered the syscall in-place on
  `-ERESTARTSYS`, re-blocking before the FOOT ever ran. So the handler never fired
  and the syscall hung. With `sigaction(sa_flags=0)`, `handle_signal` rewrites to
  `-EINTR` (`restart=false`) → loop exits → handler delivered, which is why every
  signal test (`sigalrm-test`, `kill-wake-test`, all `sa_flags=0`) passed and only
  `signal()`/`SA_RESTART` users hung. Headline symptom: busybox FANCY `ping` sent
  one ICMP echo then hung (its interval SIGALRM handler `sendping4`, armed via
  `signal()`, never ran). **Fix:** the restart loop is lifted from C to the asm
  FOOT. `traps.c` keeps its in-loop restart for the NO-handler cases (incl. the
  `-ERESTART_RESTARTBLOCK → __NR_restart_syscall` nr-switch), but when a handler is
  queued for a would-be restart it stops looping and RETURNS with `syscall_ret`
  still holding the internal `ERESTART` code (-516..-512, never seen by userspace).
  `entry.S` wraps `call __wasm_syscall_N` in a loop: after the call it runs
  `WASM_SYSCALL_FOOT_SYNC` (sync user sp/tls from pt_regs, then `call
  _user_mode_tail` to deliver the queued handler + its sigreturn at the FOOT — the
  only safe context), and if the saved return is an `ERESTART` code it
  re-establishes the kernel C-frame SP (`WASM_SYSCALL_RESET_SP`) and branches back
  to re-run the syscall. So the restart happens AFTER the handler → full
  transparent `SA_RESTART` (busybox ping's `recv` returns real replies, no
  `-EINTR`; restartable syscalls restart and return their real result). In-kernel
  change only (`__wasm_syscall_N` signatures + the kernel↔engine import surface are
  unchanged) → no `ENGINE_ABI` bump / no pc sync. **DEAD-ENDS (both CI-validated):**
  (1) returning `-EINTR` instead of restarting (an earlier accepted fix) works but
  is NOT transparent — restartable syscalls leak `EINTR` to callers; superseded by
  this FOOT-loop. (2) delivering the handler in-loop by calling `_user_mode_tail()`
  from inside `__wasm_syscall_N` PANICS (`RuntimeError: null function or function
  signature mismatch` in `__libc_handle_signal`): handler delivery + the nested
  sigreturn need the FOOT context (kernel C frame popped, kernel SP reset, user
  sp/tls synced from pt_regs), NOT a nested mid-C-frame call. Gate: `ping-pace-smoke`
  (+ the `ping-pace-probe` control/restart/xcpu/repro matrix), no networking, in the
  boot-smoke job.
- **virtio device-enum patches (0017-0020) must apply with ZERO fuzz** (`kernel.nix`
  `postPatch` assertion). Patches 0018 (9p), 0019 (console), 0020 (vsock) each insert
  into the SAME enum + `virtio_wasm_transport_init()` regions of
  `drivers/virtio/virtio_wasm.c`. When `drivers/virtio/virtio_wasm.c` (created by
  0013) drifts, `patch`'s fuzzy matching can SILENTLY mis-apply a stacked hunk — no
  reject, no error. This bit hard: a ~65-line drift made `patch` silently DROP 0018's
  `VW_DEV_9P_ROOT/9P_NIXCACHE` `virtio_wasm_register()` calls and (0020, authored
  pre-0019) land `VW_DEV_VSOCK` before `VW_DEV_CONSOLE` (CONSOLE 6→8). The guest then
  registered every virtio device EXCEPT 9P, so `9pnet_virtio: no channels available
  for device pcroot/nixcache` — the pc VFS root + /nix-cache never mounted (a nix:true
  boot reached a shell but `nix` couldn't read /nix-cache). It went unseen because no
  CI booted nix:true headless (the wayland browser path differs). Fix: keep these
  patches regenerated against the current tree (`patch -p1 --fuzz=0` must apply all of
  0017-0020 cleanly), and the `kernel.nix` `postPatch` assertion now dumps + checks
  the post-patch enum order + every device registration, failing the build LOUDLY in
  `patchPhase` instead of shipping a subtly-broken kernel. Runtime gate: the
  `nix-boot-smoke` CI job (`smoke.mjs` — reads `/mnt/pc` + `nix-env -iA`) exercises
  both 9P channels end to end. **NOTE (#83 single-port console pivot):** the
  canonical layout changed — the console is now **8 single-port virtio-console
  devices** at an explicit `VW_DEV_CONSOLE_BASE = 8` (host idx 8..15, registered by a
  `for (i<8) virtio_wasm_register(VW_DEV_CONSOLE_BASE + i, …)` loop), with
  `VW_DEV_VSOCK = 7` BEFORE them (index 6 = `VW_DEV_SND` since #145 — the
  virtio-snd sound card, patch 0027; the postPatch assertion pins SND=6 too). So the assertion now enforces the
  OPPOSITE order from #87's "bug" framing above — `VW_DEV_VSOCK(7) < CONSOLE_BASE(8)`
  is CORRECT now — and checks the `VW_DEV_CONSOLE_BASE + i` loop (not a single
  `VW_DEV_CONSOLE` call) plus the pinned `=7`/`=8` values. Multiport was abandoned:
  its async control-vq port handshake races init to death on single-CPU wasm boot
  (the single-port probe path registers each hvc line synchronously instead). The
  console loop now calls `virtio_wasm_register_cfg(…, VW_CONSOLE_CONFIG_IRQ_BASE + i)`
  (the resize variant, next entry), so the assertion greps `register_cfg`.
- **Terminal resize = virtio config-change interrupt + VIRTIO_CONSOLE_F_SIZE**
  (`patches/kernel/0013` transport + `0019` console loop; `runtime/virtio/{console-device,shared-queues}.js`;
  ENGINE_ABI 7). A single-port virtio-console has NO control vq, so the multiport
  `VIRTIO_CONSOLE_RESIZE` message is unavailable — the ONLY size channel is the stock
  driver's `F_SIZE` path: read cols/rows from config space at probe + on a **config-change
  interrupt**, then `hvc_resize()`. The minimal `virtio_wasm` transport had no config-change
  path, so resize was a no-op. Fix: (1) the transport grew a generic config-change irq — a
  SECOND per-device irq whose handler calls `virtio_config_changed()`; consoles use
  `VW_CONSOLE_CONFIG_IRQ_BASE + idx` (24..31, disjoint from used-buffer irqs 8..23, low
  word of `raised_irqs` so the host self-wake is unchanged), wired via a
  `virtio_wasm_register_cfg(dev,id,config_irq)` variant (the old `virtio_wasm_register`
  is a `config_irq=0` wrapper, so 0017/0018/0020 are untouched). (2) the host console
  device offers `F_SIZE` (getFeatures `1n`) and serves cols/rows from config space.
  The size crosses the worker/main inversion (set on main by `console_resize`, read by
  the worker's `configRead`) via a per-device word in the cross-worker shared-queues SAB
  (`setConfigSize`/`getConfigSize`) — written before the irq is raised, race-free. Gated
  by `resize-smoke.mjs` (boot → `console.resize` → `stty size`). It's a GENERAL transport
  feature (any future config-change device can use it), console is just the first user.
- **Guest audio = virtio-snd (patch 0027, `VW_DEV_SND=6`) + cross alsa-lib; the
  device's completion model is LOAD-BEARING** (#145; `runtime/virtio/snd-device.js`,
  `deps-overlay.nix` alsa-lib/libcanberra, `patches/alsa-lib/0001`,
  `patches/libcanberra/0001`). Stock mainline driver (CONFIG_SND_VIRTIO) over the
  wasm transport; the host serves ONE s16/48kHz playback stream and hands PCM to a
  pluggable sink (`snd.onReady(device)` boot hook → `device.setSink(…)`; pc's
  AudioWorklet in `js/linux/guest-audio.js`). THREE rules found by BOOTING, not
  spec-reading — all three produced `-EIO` in alsa-lib with no kernel error:
  (1) tx buffers queued BEFORE `R_PCM_START` must stay HELD in the vring (the
  driver pre-queues its whole ALSA buffer and counts period-elapsed only on
  completions while running — early completion starves the accounting, writei
  hangs to its 10s timeout); (2) running completions must be PACED against a
  real-time playback clock (a whole buffer completing in one burst wraps hw_ptr
  exactly onto itself → "stalled" pointer → same -EIO; pacing is also what makes
  writei block like real hardware); (3) the driver submits only FULL periods
  (`virtio_pcm_msg.c` accumulates to period_bytes), so a playback app must
  silence-pad its final period before `snd_pcm_drain` (aplay does; alsa-tone
  does) or drain times out (~buffer_size*1.1/rate ms). alsa-lib cross needs
  `--without-versioned` PLUS patches/alsa-lib/0001 (the no-versioning alias
  fallback and link_warning are module-level `.symver`/`.weak`/`.set`/`.section`
  inline asm — no wasm encoding; the patch swaps in C weak-alias attributes) and
  compiles out the fork() holdouts per the process-model rule (dmix/dshare/
  dsnoop + shm/aserver, ladspa, UCM). libcanberra builds `--with-builtin=alsa`
  (the dso loader is ltdl dlopen; builtin compiles the ALSA driver INTO the lib —
  the gio-modules posture) against our wayland-only gtk3 via patches/libcanberra/
  0001 (guards the X11-metadata code behind GDK_WINDOWING_X11; nixpkgs' runtime-
  check patch still needs gdkx.h) + an anchored configure sed dropping the ltdl
  hard-require (builtin builds never use it). The cc-wrapper wasm-ld filter also
  grew `--as-needed` (libcanberra's Makefile passes it; ELF-DSO-only). Gate:
  `snd-smoke.mjs` (bit-exact PCM at the sink). ENGINE_ABI 11.
- **busybox `timeout` — `-pPID` must precede the operands (musl getopt ≠ glibc)**
  (`patches/busybox/0008`; #35). `timeout PROG` spawns a watcher that re-execs
  itself with a hidden `-pPID` (the grandparent pid to SIGTERM after the timeout),
  then the parent execs PROG. Stock busybox builds the re-exec argv by overwriting
  the SHARED argv (`argv[optind]="-pPID"` → `["timeout","SECS","-pPID"]`) and relies
  on **glibc getopt PERMUTING** that trailing option back past the `SECS` operand.
  **musl's getopt does NOT permute** — the leading operand stops option scanning, so
  `-pPID` is never parsed, the watcher runs with `parent==0`, treats `-pPID` as PROG
  (`can't execute '-p50'`) and never fires → `timeout 2 sleep 10` runs the full 10s
  and exits 0. #35 was filed as an async-SIGALRM/signal gap; it is **not** — the
  kernel async-signal path is proven by `.#sigalrm-test` + `.#kill-wake-test` (the
  latter a reduced C cross-process-kill reproducer). Fix: the clone child builds a
  PRIVATE argv (don't mutate the CLONE_VM-shared parent argv) with `-pPID` **before**
  the operands. busybox `timeout` replaces itself with PROG, so a fired timeout exits
  **128+SIGTERM = 143**, NOT GNU's 124 — the `timeout-repro-smoke` gate asserts 143.
  (DEAD-END: the first 0008 only stopped the parent-argv mutation — necessary but not
  sufficient; the watcher-side getopt order was the real bug, found via an in-guest
  `TMODBG` argv trace over the ~3-min Cachix-substituted boot-smoke CI loop.)
- **hush can't run a real autoconf `configure` at all without three
  independent fixes** (`patches/busybox/0009-hush-variable-fd-redirect.patch`
  + `0010-hush-internally-opened-fd0.patch` + `0011-hush-exit-trap-status.patch`;
  all three wired into FOUR consumers — `busybox-fork.nix`, `busybox.nix`,
  `ash.nix`, AND `userspace/autotools-fixture-hush-check.nix` (the host-side,
  hermetic native-busybox proof itself, not a wasm consumer — see its own
  header) — for source-tree consistency, but only TWO of the four
  derivations actually COMPILE `shell/hush.c` into their shipped/tested
  binary as `/bin/sh`-relevant hush: `busybox-fork.nix` (hush is its
  `/bin/sh`) and `autotools-fixture-hush-check.nix` (a native, non-cross
  busybox built purely to run this hush through a real `configure`
  hermetically on the host). `busybox.nix` (NOMMU) also compiles
  `shell/hush.c` — hush is present there as the `hush` applet even though
  forkshell ash is the guest's actual `/bin/sh` (see `bootstrap.nix`) — so it
  is a THIRD derivation that genuinely builds hush.c, just not as the
  default shell. `ash.nix` builds via `allnoconfig` + an ASH-only enable list
  that never sets `CONFIG_SHELL_HUSH=y` (only `ASH`/`SHELL_ASH`/`SH_IS_ASH`),
  and busybox's `shell/Kbuild` gates `hush.o` behind exactly that symbol
  (`lib-$(CONFIG_SHELL_HUSH) += hush.o ...`) — so `ash.nix`'s copy of
  `shell/hush.c` is patched (the postPatch guards below still run and still
  catch a dropped hunk) but never actually compiled into that derivation's
  busybox binary; it's wired there purely to keep the source tree — and the
  guard machinery — identical across all four. (A dropped hunk in ANY of the
  four would go unnoticed by the other three's guards — this is why the
  count matters: a future agent touching only `busybox-fork.nix`'s patch list
  and forgetting `autotools-fixture-hush-check.nix` would silently desync the
  host-side hard gate from the guest it's supposed to be proving.) All
  three fixes are ORIGINAL fixes for still-unfixed-upstream bugs (confirmed
  against `mirror/busybox @ master`, commit
  `371fe9f71d445d18be28c82a2a6d82115c8af19d` as checked 2026-08-13 for 0011 —
  see its patch header), found while making the fork/MMU guest's default
  `/bin/sh` (stock hush) capable of autoconf — the earlier "hush isn't
  POSIX-enough" framing (see the Current-state autotools caveat) turned out
  to be THREE specific, narrow hush bugs, not a general conformance gap:
  1. **0009 — parse-time rejection of variable fd redirects (`>&$fd`).**
     autoconf's `as_fn_error()` does `printf ... >&$4` (a *variable* dup
     target — `$4`, a function arg — not a literal digit/`-`). hush's
     `parse_redir_right_fd()` resolves `&N`/`&-` by peeking raw characters
     off the input stream at PARSE time; anything else (incl. the first
     char of a `$var`) was a hard "ambiguous redirect" parse error that
     desyncs the rest of the parse ("syntax error at 'fi'") — so NO real
     generated `configure` could even be parsed. POSIX requires the
     redirect target word to undergo the same expansions as any other word;
     bash/dash/ash all accept this. Fix: defer via a new `REDIRFD_TO_FD_VAR`
     sentinel — nothing is consumed at parse time, so the ordinary
     word-scanner picks up the target as a normal (unexpanded) redirect
     word, and `setup_redirects()` expands + resolves it at redirect-SETUP
     time (all-digits → dup like a literal `N>&M`; `-` → close; anything
     else → "ambiguous redirect", now raised at RUN time like bash).
  2. **0010 — `<&0` (dup FROM stdin) misfires even on a plain, valid stdin.**
     Found immediately after 0009, from the SAME real-configure run:
     autoconf's universal preamble `exec 7<&0 </dev/null` failed with a
     bogus `can't duplicate file descriptor`, before ever reaching the
     `>&$4` construct 0009 fixes. Root cause: `internally_opened_fd()`
     tests `fd == G_interactive_fd` with no guard for `G_interactive_fd`'s
     "not interactive" SENTINEL value of 0 — so any non-interactive `N<&0`
     (script/`-c`/shebang execution, i.e. every autoconf run) is
     misidentified as touching hush's own interactive tty fd. The sibling
     `save_fd_on_redirect()` a few lines above already carries the correct
     `fd != 0` guard (with a comment naming this exact ambiguity); the fix
     just mirrors it into `internally_opened_fd()`. Does NOT change (and
     correctly still traps) `sh < ./configure` — there fd 0 genuinely IS
     the script being read (`fd_in_HFILEs`, a different mechanism).
  3. **0011 — a bare `exit` inside the EXIT (`trap ... 0`) handler, AND a
     `$?` read anywhere inside that handler's body, both resume/reflect the
     WRONG status (#193; completed in a follow-up review pass, P2-1).**
     Found by #193's first in-guest autotools soak: the fixture `configure`,
     under 0009+0010-patched hush, hit a genuinely fatal error mid-run
     (`cannot compute suffix of executables: cannot compile and link` — an
     unrelated in-guest cc bug, #192), printed the error correctly, stopped
     — and the harness still captured `CFGRC=0`. Root cause: every autoconf
     `configure` installs `trap 'ac_exit_trap $?' 0`, and `ac_exit_trap`
     deliberately does `exit_status=` (left empty) then `... && exit
     $exit_status` — word-splitting drops the empty word, so this is a
     completely bare `exit`. POSIX/bash/dash give a bare `exit` run FROM
     INSIDE a trap a special meaning: resume the status that was PENDING
     before the trap fired (here, `as_fn_exit`'s real status, e.g. 77), NOT
     the status of whatever the trap body's own commands (a successful `rm
     -f -r ...`) last left in `$?`. hush already implements this correctly
     for every ORDINARY signal trap, and does so in TWO halves —
     `check_and_run_traps()` both saves `G.last_exitcode` into
     `G.pre_trap_exitcode` AND leaves `G.last_exitcode` itself holding that
     pending value before invoking the trap, so `builtin_exit()`'s no-arg
     path can prefer `G.pre_trap_exitcode` (`>= 0`) for the bare-`exit` case
     AND a `$?` read from the very first statement of the trap body already
     reflects the pending status — but the EXIT pseudo-trap (signal 0) is
     run by a SEPARATE code path, `hush_exit()` itself, which calls
     `builtin_eval()` directly and (before this fix) touched NEITHER half —
     so `G.pre_trap_exitcode` stayed at its startup -1 sentinel (breaking
     bare `exit`) and `G.last_exitcode` stayed whatever the pre-exit command
     left it at (breaking a `$?` read, e.g. the equally common `trap
     'rc=$?; cleanup; exit $rc' 0` idiom — autoconf's own `config.status`
     generates exactly this shape, coincidentally unaffected today only
     because `as_fn_exit` happens to pre-arrange a matching `$?`, not
     because the bug doesn't apply). CONFIRMED pre-existing, NOT introduced
     by 0009/0010 — both minimal repros (`trap 'ac_exit_trap $?' 0; exit 5`
     with a bare `exit`, and `trap 'exit_status=$?; exit $exit_status' 0;
     exit 77` reading `$?` first) reproduce byte-for-byte on PRISTINE,
     unpatched busybox-1.36.1 hush too (no variable-fd redirect or `<&0`
     involved at all), and are still present, unfixed, in busybox git as of
     2026-08-13 (`github.com/mirror/busybox` commit
     `371fe9f71d445d18be28c82a2a6d82115c8af19d`, fetched and checked directly
     in-session). Fix: `hush_exit()` sets BOTH `G.pre_trap_exitcode` AND
     `G.last_exitcode` to `exitcode & 0xff` (its own real, precise argument)
     immediately before invoking the EXIT trap's `builtin_eval()`, mirroring
     `check_and_run_traps()`'s own two-field precedent; no restore needed
     (`hush_exit()` never returns). Verified host-side (native, hermetic)
     against a full matrix cross-checked with bash/dash ground truth: both
     minimal repros; the real fixture `configure` against a sabotaged
     always-failing `cc`/`gcc` (CFGRC=0 pre-fix -> 77 post-fix, matching
     bash/dash exactly) and against a working compiler (0 throughout); the
     P1 dangling-redirect negative probe; a trap body whose last command
     FAILS before its own bare `exit` (resumes the real pending status, not
     the failing command's); an EXIT trap calling `exit N` explicitly; a
     script with no EXIT trap; explicit `exit 9`/`exit -2` (->254); an EXIT
     trap that itself fails without calling exit (pending status wins); and
     fall-off-end / EOF-after-`false` / `set -e` (all unaffected). Also
     recorded (not designed, a consequence of fork() copying hush's global
     state): a bare `exit` in a CHILD spawned FROM the trap body (`$()`,
     pipeline, subshell) now inherits the outer pending status too — matches
     both bash and dash for `$()`/pipeline children, and matches dash (not
     bash, a pre-existing bash/dash divergence, not something this patch
     invents) for a `(cmd; exit)` subshell child; this inheritance is a
     property of a REAL fork() and does NOT apply to the NOMMU
     busybox.nix/ash.nix guest's re-exec'd subshells (a fresh process image,
     not copied memory — confirmed structurally, no `!BB_MMU` code path
     touches `pre_trap_exitcode`), though ash.nix's `/bin/sh` is ash, not
     hush, either way. Full matrix + patch text: the 0011 patch header.
     `.#autotools-fixture-hush-check` gained a hard NEGATIVE case (sabotaged
     `cc`/`gcc` on PATH, `unset CC CXX`) asserting a genuinely-failing
     `./configure` exits EXACTLY 77 (not merely nonzero — a regression
     elsewhere, e.g. in 0009's own `>&$4` handling, could fail configure
     early with some OTHER nonzero and this gate would still wrongly declare
     the exit-trap fix "holds") AND that the captured output names "C
     compiler cannot create executables", so a pass is attributable
     specifically to the compiler-probe -> as_fn_error -> exit-trap path —
     every check before it only proved the happy path, which could not have
     caught this class of bug; the new case fails loudly (as expected) when
     0011 is reverted, confirmed by temporarily dropping it and re-running
     the gate. All FOUR consumers' postPatch guards are similarly
     tightened: they check the two assignment lines' positions PRECEDE
     `hush_exit()`'s `builtin_eval(argv)` call (not merely that they're
     present somewhere in the function), so a fuzzy stacked-patch apply that
     landed them AFTER it (a no-op position — the trap body has already run
     by then) fails the build loudly too; verified by manufacturing that
     exact mis-apply and confirming the tightened guard (and not the
     original bare-presence one) catches it.
  **The P1 lesson (from review, worth generalizing):** the FIRST version of
  0009 was verified only against the constructs it was DESIGNED to fix — it
  omitted the same `rd_filename == NULL` guard its sibling REDIRFD_TO_FILE
  branch in `setup_redirects()` starts with, so a dangling/malformed target
  (`>&<x`, `>&>x`, `>&#c`, or `cmd >&` at EOF — none of them exotic, any one
  reachable by a typo) SIGSEGV'd the shell (`expand_string_to_string(NULL)`
  → `strchr(NULL,...)`), and inside `$(...)` the crash was invisible —
  the substitution silently returned empty with rc=0. **A new redirect-
  parsing code path needs its NEGATIVE-space cases (dangling/malformed
  target, not just the happy path) in the verification matrix from the
  start, not discovered after merge.** A second review pass also caught
  the initial error-handling shape being wrong on BOTH axes at once:
  `syntax_error()`+`continue` let the bad command run anyway with the
  redirect silently dropped (interactively) while killing the WHOLE script
  on the very first ambiguous redirect (non-interactively) — backwards from
  bash (which fails only the one command, script continues, in both modes).
  Fixed to the `bb_error_msg(...); return 1;` shape this function's other
  runtime redirect failures (the "fd#%d is not open"/`dup2()` checks) were
  already using — matching a shape upstream itself later converged on
  elsewhere in `setup_redirects()`, just not (yet) here.
- **`wasm_error()` must bail out BEFORE touching a V8 termination exception,
  and its guard must never RESOLVE the `.catch()` it's installed as**
  (#196, commit `705e832`). TRIGGER: `worker.terminate()` mid-wasm —
  `kernel-host.js`'s `kill_task`/`stop_secondary` (`stop_secondary` terminates
  a secondary-CPU worker UNCONDITIONALLY, mid-`_start_secondary` if need be —
  the strongest in-engine repro) and the test harness's hard-kill teardown
  (`runtime/demo/node/web-shims.mjs`'s `terminateAllWorkers()`, which every
  smoke's `s.kill()` drives) can land a V8 "termination exception" on
  whichever promise chain is in flight — seen 2× in CI **on the GTK shard**
  (not the autotools soak, and not a step timeout: a normal, deliberate
  worker-kill during teardown). FAILURE: a termination exception has no real
  JS representation; `wasm_error()` used to touch it further
  (`describe_cpp_exception()`'s `WebAssembly.Exception` probes,
  `console.error()`'s stringification), which **aborted the isolate outright**
  — SIGTRAP, node exit 133 — AFTER the smoke had already printed PASS, turning
  a green run red. FIX, two load-bearing parts, both worth stating explicitly
  because a future "simplify this" pass could break either: (a) a structural
  allow-list — `error instanceof Error || error instanceof
  WebAssembly.Exception` — checked BEFORE touching `error` any further, so
  the termination exception is never inspected at all; (b) on that guard's
  bail-out path, `return new Promise(() => {})` — a Promise that never
  settles — NOT a bare `return`. `wasm_error` is used directly as a
  `.catch()` handler (`.catch(wasm_error).then(user_executable_chain)`), and
  pre-fix it always threw, so that `.then()` was never reached on the error
  path; a bare `return` makes the `.catch()` RESOLVE instead, firing the
  trailing `.then()` and starting a FRESH `user_executable_chain()` inside an
  isolate that is already terminating (concrete repro: `stop_secondary()`
  lands directly on this chain). The odd-looking never-settling Promise IS
  the fix, not incidental scaffolding. Engine-only change — no `ENGINE_ABI`
  bump (no import added, removed, or retyped) — but it IS a
  `kernel-worker.js` edit, so it carries the standing `runtime/sync-to-pc.sh
  <pc-checkout>` obligation before any pc deploy, same as every other
  engine-file change (see the ABI-BUMP RULE above).
- **9P read-only mounts MUST be `cache=loose,ignoreqv`** (`bootstrap.nix`). Default
  `cache=none` → netfs *unbuffered* reads → `get_user_pages` on the user buffer
  (unsupported on NOMMU/wasm) → `rc=-14`. Loose = buffered page-cache + `copy_to_user`.
- **`/dev/shm` MUST be mounted (ramfs) for GTK/wl_shm clients** (`bootstrap.nix`).
  gdk's wayland backend allocates each window's `wl_shm` buffer via
  `open_shared_memory()` → `memfd_create()` (ENOSYS on the wasm kernel) →
  `shm_open("/dev/shm/…")` fallback; with `/dev/shm` unmounted that fails ENOENT →
  `create_shm_pool` returns NULL → an empty **0×0** window + a per-frame
  `Gdk-CRITICAL` in `_gdk_wayland_display_create_shm_surface` (looks like a render
  crash but is a missing mount). Use **ramfs**, NOT tmpfs: ramfs has explicit NOMMU
  `MAP_SHARED` mmap support (`fs/ramfs/file-nommu.c`) — the same backing `/tmp` uses
  (proven by `wl-anim`'s `mkstemp` shm path) — whereas shmem/tmpfs lacks reliable
  shared-writable mmap on NOMMU. With the mount, `gtk-hello` renders a real window
  ("Hello, GTK on wasm!"); same fix unblocks galculator/widget-factory (identical
  gdk shm path). Rebuilds only the initramfs. (`memfd_create` is still ENOSYS — a
  future kernel could implement it as the more standard primary path.)
- **X11 MIT-SHM is ENOSYS — export `GDK_USE_XSHM=0` (and `QT_X11_NO_MITSHM=1`)
  in the image, never from the host.** The kernel has no SysV IPC, so `shmget`
  returns ENOSYS. GDK does **not** fall back to core-protocol PutImage: after
  the GTK "running as root" warning it dies with `Fatal IO error 11 on X
  server :1`. `DISPLAY=:1` (sommelier `-X --x-display=1`) plus those two flags
  belong in `userspace/system.nix` `environment.variables` **and** the explicit
  `environment.etc."profile".text` exports (login ash sources `/etc/profile`).
  FORBIDDEN: pc typing `export DISPLAY=:1 GDK_USE_XSHM=0` into a user Terminal
  or hidden hvc to paper over a stale ISO. Republish the linux channel.
- **GTK cursors: a theme on disk is necessary but the real blocker is musl's
  `posix_fallocate`** (`toolchain/musl.nix` + `userspace/gtk-assets.nix` +
  `system.nix`). GTK's `Gdk-Message: Unable to load <name> from the cursor theme`
  (default/text/pointer/`*-resize`/col-resize, EVERY name) has TWO independent
  causes; both must be fixed:
  1. **No cursor theme on disk + no `XCURSOR_*`.** GDK's wayland backend draws
     pointer shapes from an Xcursor theme via libwayland-cursor; the guest's
     default search path (`/usr/share/icons`, …) is empty. Fix: bake the Adwaita
     Xcursor theme into `gtk-assets` (`gnome-themes-extra`'s `share/icons/Adwaita`
     is a symlink to `adwaita-icon-theme-50.0`, which DOES ship the full cursor
     set — default/text/pointer/all `*-resize` as real `Xcur` files incl. size
     24; `cp -r` follows the symlink and the ref scanner pulls the theme into the
     closure) + a `default` theme that `Inherits=Adwaita`, then set
     `XCURSOR_PATH=/run/current-system/sw/share/icons` + `XCURSOR_THEME=Adwaita`
     (+ `XCURSOR_SIZE=24`) in `system.nix` `environment.variables` (reaches apps
     via `/etc/profile`→`/etc/set-environment`, like `FONTCONFIG_FILE`).
  2. **`wl_cursor_theme_load` can't size its `wl_shm` pool.** Even with a valid
     theme present, libwayland-cursor allocates its image pool with wayland's
     `os_create_anonymous_file`, which sizes the file via **`posix_fallocate`**.
     The pool lives on ramfs (`/tmp`/`/dev/shm` — ramfs is mandatory for NOMMU
     shared mmap; CONFIG_SHMEM is gated off behind MMU so tmpfs falls back to
     ramfs too), and **ramfs has no `->fallocate`** → the syscall returns
     EOPNOTSUPP. **musl forwards that error; glibc (every real system) emulates**
     → so it works on stock NixOS and not here. GDK's *window* buffers dodge it
     by using `ftruncate`, which is why the window renders but cursors don't. Fix
     = make musl's `posix_fallocate` emulate like glibc (ensure the file size on
     EOPNOTSUPP/ENOSYS) — `toolchain/musl.nix` `postPatch`. Shared across every
     guest binary; a musl change → world rebuild. Verified the diagnosis by
     booting the guest headless (`runtime/demo/node/boot-node.mjs`) and running
     `fallocate` on `/tmp` + `/dev/shm` → both "Not supported", `truncate` → ok.
     **The emulation MUST call the `fallocate()` wrapper, NOT a raw
     `__syscall(SYS_fallocate, …)`:** musl's stock `posix_fallocate.c` issues
     `fallocate` (nr=47) through a 4-arg `__wasm_syscall_4`, but `sys_fallocate`'s
     `loff_t` args make that a `call_indirect` signature mismatch ("null function
     or function signature mismatch") that PANICS the guest — the same arity
     hazard the kernel-worker futex shim (nr=422) documents. The `fallocate()`
     wrapper splits the 64-bit args into the 6-arg `__wasm_syscall_6` form the
     kernel expects (proven safe: busybox's `fallocate` returns a clean
     EOPNOTSUPP). The first cut used the raw `__syscall` and panicked busybox
     forkshell's `posix_fallocate` (on its spawn temp file) → `nix-env`/GTK
     kernel-panic, caught by CI's `nix-boot-smoke`; captured the exact `nr=47`
     trap by booting the preview headless via Playwright with `trace_syscalls` on.
  Rebuilds the world (musl) + `.#wasm-base-squashfs` (theme/env data change).
- **Detached-thread exit needs a wasm `__unmapself`** (`patches/musl/0008`). A
  DETACHED pthread that exits runs musl `__pthread_exit` → `__unmapself`, whose
  generic path does a native stack-pointer switch (`CRTJMP`) to `munmap` its own
  stack — but the wasm arch stubs `CRTJMP(pc,sp)` to `abort()` → SIGILL (exit 132).
  GLib **GThreadPool** workers (gdk-pixbuf/GTask, so any non-trivial GTK app like
  gtk3-widget-factory) are detached threads, so they crashed on exit; gtk-hello has
  no threads and never hit it. Fix: on wasm, `__unmapself` does `munmap`+`exit`
  inline (no stack switch) — safe because NOMMU `munmap` does NOT invalidate the
  wasm linear-memory bytes the C shadow stack occupies. Validated by
  `.#pthread-exit-test` (spawn+exit 16 detached threads). A musl change → world
  rebuild (musl → stdenv → all guest binaries relink). SAME class as the libffi /
  futex / fpcast wasm-can't-do-native-asm theme.
- **Guest RAM = 1.75 GiB for large GTK windows** (`kernel.nix`
  `CONFIG_BOOT_MEM_PAGES 0x7000`). A GTK app mapping a large window allocates an
  **order-11 (8 MB) GFP_HIGHUSER** `wl_shm` buffer; after the served `/nix` closure
  + glib/gdk init fragment the NOMMU buddy heap below 8 MB, that mmap fails
  (`page allocation failure: order:11`) → no window (gtk3-widget-factory). More RAM
  keeps order-11 blocks whole. MUST stay **under `0x8000` (2 GiB)** — setup.c
  positive-address limit. vmlinux-only rebuild; same NOMMU contiguous-mmap class as
  the 1 GiB bump for the 57 MB clang exec.
- **User stack 8 KiB→4 MiB** (`patches/kernel/0007`): musl `realpath()` alone
  overflows 8 KiB and NOMMU can't grow the stack (was both the "readlink -f
  corrupts long paths" bug and the nix.wasm startup "memory access out of bounds").
  4 MiB (not 8) so the alloc fits an order-11 buddy block.
- **Base `/nix` = squashfs over virtio-blk** (#43; `userspace/base-squashfs.nix`,
  `runtime/virtio/blk-device.js`): the guest's `/nix` lowerdir is a squashfs image
  (`base.squashfs`) served to the guest over a read-only virtio-blk device. Kernel
  needs `CONFIG_SQUASHFS`/`CONFIG_SQUASHFS_ZSTD`/`CONFIG_BLOCK`/`CONFIG_VIRTIO_BLK` +
  `CONFIG_MISC_FILESYSTEMS` (gates squashfs — silently dropped without it) + patch 0017
  (`VW_DEV_BLK=3`). The squashfs image is a `SharedArrayBuffer` shared to all workers;
  `BlkDevice` is built lazily in the task worker. Block size `-b 131072` (128 KiB) works
  on NOMMU. mmap-exec off squashfs relies on patch 0016 (RO file mmap copy).
  See `docs/superpowers/notes/squashfs-nommu-spike.md` for the spike notes. The
  compiler toolchain is NOT in the base squashfs — it is substituted on demand via the
  Nix binary cache (`wasm-binary-cache` → `nix-env -iA guest-cc`).
- **`CONFIG_ARCH_FORCE_MAX_ORDER` 16 + `CONFIG_BOOT_MEM_PAGES` 0x7FFF** (`kernel.nix`):
  `nix-env` extracting a large on-demand package needs a contiguous ~134 MB allocation
  from the NOMMU buddy allocator. `ARCH_FORCE_MAX_ORDER=16` allows 256 MB buddy blocks;
  `BOOT_MEM_PAGES=0x7FFF` gives ~2 GiB RAM (under the 0x8000 positive-address limit).
  Without this, large on-demand installs fail with `page allocation failure`.
- **Single-user nix** (`userspace/system.nix`): `build-users-group = ""` +
  `filter-syscalls = false` (no seccomp on wasm) — either otherwise aborts `nix-env`.
- **Guest wall clock = read_persistent_clock64 off the epoch-anchored monotonic
  import** (`patches/kernel/0028`; the layer BELOW the trust-anchors entry
  next). The wasm arch registered only a clocksource/clockevent — no
  persistent clock — so CLOCK_REALTIME booted at the weak default of 0:
  in-guest `date` said `Thu Jan 1 1970` + uptime, and the moment the CA bundle
  made TLS verification real, every certificate was "not yet valid" (curl 60
  this time, not 77) and substitution failed all over again. Fix: implement
  `read_persistent_clock64` from the engine's EXISTING
  `wasm_cpu_clock_get_monotonic` import — kernel-worker.js anchors it at the
  UNIX epoch (`performance.timeOrigin + performance.now()` ns), so its
  absolute value IS wall time while the timekeeping core keeps consuming only
  deltas via the clocksource. That anchoring is now LOAD-BEARING (comment at
  the formula); an engine returning 0-based monotonic degrades to the 1970
  boot, no crash — wire surface unchanged, so NO ENGINE_ABI bump and no pc
  sync (pc's vendored engine uses the identical formula). vmlinux-only
  rebuild. Gate: `clock-smoke.mjs` (`date +%s` within 15 min of host).
- **HTTPS substitution needs baked trust anchors** (`userspace/system.nix`:
  `security/ca.nix` in the module list + `SSL_CERT_FILE`/`NIX_SSL_CERT_FILE`).
  Retiring `file:///nix-cache` for direct Cachix substitution (#82/#167) made
  nix's curl do real TLS for the first time — and the guest closure carried NO
  CA bundle (nothing ever needed one before). Failure signature: every fetch
  warns `unable to download 'https://nix-wasm.cachix.org/…': Problem with the
  SSL CA cert (path? access rights?) (77) error adding trust anchors from
  file:` and nix, treating the cache as empty, "falls back" to planning a
  1321-drv from-source bootstrap that dies on `platform mismatch` (the drvs'
  `system` is the x86_64 build host; wasm32-linux can't build) — the SSL line
  is the root cause, the platform-mismatch wall is noise. Fix = the real NixOS
  `security/ca.nix` module (PRIME DIRECTIVE: reuse module code, don't hand-roll
  etc entries): `pkgs.cacert` is data-only (native `buildcatrust` over NSS
  certdata — a trivial cross build) → `/etc/ssl/certs/ca-certificates.crt`,
  which nix's `getDefaultSSLCertFile` probes by itself; the env vars cover
  every other openssl consumer (the cross openssl's compiled-in OPENSSLDIR is
  its own cert-less store path). Rebuilds `.#wasm-base-squashfs` (the /etc tree
  + env live in the squashfs) — republish via `.#linux-image`, no engine change.
**Dead-ends — do NOT retry:**
- `crossSystem.hasSharedLibraries = false` — too aggressive; sqlite eval abort.
- `stdenvAdapters.makeStaticLibraries` — doesn't compose with our
  `replaceCrossStdenv` (`dontAddStaticConfigureFlags` → `null` → eval error).
- Unscoped overlay overrides — poison `buildPackages` (see the `isWasm` guard above).
- `nixos-26.05` pin *locally on aarch64* — triggers from-source LLVM (the aarch64
  cache lacks the exact build). 26.05 is the right pin for **x86_64 CI** only.
- Minimal per-dep derivations — see PRIME DIRECTIVE corollary 1.

**Environment:**
- Pin: `nixos-unstable` @ `9ae611a` (LLVM **21.1.8**); CI should prefer
  `nixos-26.05` (same clang-21.1.8, fully cached on x86_64).
- aarch64 cache lags x86_64 and lacks heavy builds → first local build compiles
  LLVM from source (~1–2 h, then cached locally). Hence corollary 3.
- Known-good oracle: `~/lwbuild/ws/install/*-wasm32_nommu` (read-only; validate
  against it, never rebuild it here).

## #126 epic — software MMU + asyncify + dlopen (off NOMMU)

The umbrella effort to run the guest as normal MMU Linux and delete the
NOMMU/no-fork/no-dlopen accommodation layer (#126; sub-issues #127–#131; design
`docs/superpowers/specs/2026-07-01-software-mmu-asyncify-design.md`). What has
LANDED on-branch (node-tested where testable; nix/kernel halves build-gated to
CI / the linux box, per the design's "ship what works" scope):

- **Track C — dlopen / dynamic linking (#130): DONE + BOOT-VERIFIED.** `runtime/demo/node/dlopen-smoke.mjs` passes in a real booted guest (both the raw and the dynsym+fpcast canonical-thunk dl paths run dlopen(NULL)/dlsym + side-module load off the guest FS + ctors); galculator builds with the dynsym seam (carries a `cb.dynsym` section) and its selftest passes. The general
  runtime side-module loader is `runtime/dylink.js` (`DynamicLoader`:
  instantiate PIC `SIDE_MODULE`s against the process Memory + shared table, GOT
  resolution, elem-slot `dlsym` per the fpcast rule, fork/clone REPLAY per Track
  0 §4). Host surface `__wasm_dl_probe`/`__wasm_dlopen`/`__wasm_dlsym` in
  `kernel-worker.js`; guest side is musl **patch 0009** (`src/ldso/wasm/`), which
  also finally DEFINES `__dlsym_time64` (was a dangling stub). `dlsym` of a
  function returns a **canonical-thunk elem slot** — so a fpcast'd binary whose
  handlers are resolved BY NAME (GtkBuilder/GModule) needs the **dynsym-inject
  seam** (`userspace/dynsym.nix` + `scripts/wasm-dynsym-inject.py`, run BEFORE
  fpcast): it appends every exported function to the elem segment + records a
  `cb.dynsym` name→slot map the loader treats as authoritative. Wired into
  galculator. Gate: `runtime/demo/node/dlopen-smoke.mjs` + `userspace/dltest*`.
  **ENGINE_ABI bumped 7→8** for the dl host surface (needs `sync-to-pc.sh`).
- **Track C — libffi runtime codegen: DONE + tested.** `runtime/ffi-codegen.js`
  generates a wasm trampoline module per call signature at runtime (the same
  instantiate-into-the-shared-table primitive dlopen uses), removing the fixed
  `wasm32-raw-ffi.c` table's K/M bound + adding structs/varargs. Two ABIs: raw,
  and the **canonical (i64×128)→i64** path for fpcast'd targets (marshals via
  binaryen's exact toABI/fromABI). `wasm32-raw-ffi.c` keeps the static table as
  the fast path and FALLS THROUGH to `__wasm_ffi_call` on out-of-bounds/struct/
  varargs. `DynamicLoader.isCanonicalSlot` (structural fpcast fingerprint: a
  `(i64×128)→i64` type) picks the ABI per call.
- **Track A1 — software-MMU pass: DONE + measured (toolchain half).**
  `runtime/softmmu-pass.js` rewrites every guest load/store to an INLINED
  single-level page-table translate reading a per-process `__mmu_pt_base` global.
  Correct on a real binary across all scalar widths + pointer-chase + real
  page-table redirection; aborts loud on atomics/SIMD (follow-up). **Measured**
  (`spikes/softmmu/REAL-BINARY.md`): compute-mixed code ≈free, pure-memory loops
  ~2.2× — the spike's poles, on real compiler output. **The load-bearing lesson:
  INLINE the translate, never a helper call** (a helper-call-per-access measured
  ~12× under V8). The pass also translates **atomics** (0xfe) + **bulk-memory**
  (memory.copy/fill/init, page-chunked) and does the standard 2-level walk
  matching the kernel tables; it strips the wasm start section → `__mmu_start`
  (init-memory must run after `pt_base` is set).
- **Track A1 — CONFIG_MMU=y kernel half: DONE + IT BOOTS (2026-07-02).**
  `nix build .#kernel-mmu` builds the software-MMU vmlinux (`kernel.nix`
  `mmu=true` applies `patches/kernel/0023-wasm-software-mmu.patch`); the
  `runtime/demo/node/mmu-smoke.mjs` gate boots the NIX-BUILT kernel + a
  softmmu-instrumented init (`.#mmu-init`) to completion and PASSES with a
  bit-exact translated checksum (`0x98c9e000`), bulk ops, and uaccess across the
  boundary — on the FULL production config. Arch layer: `asm/{pgtable,pgalloc,
  tlbflush,mmu_context,mmu}.h` (2-level over the §1 PTE format; `switch_mm` →
  `env.__mmu_set_pt_base`; init/destroy_context own the kernel binary buffer),
  software uaccess table-walk (`mm/uaccess.c` + `fixup_user_fault`), A2 fault
  entry (`mm/fault.c __wasm_mmu_fault`), `protection_map`. **Two keystone fixes
  found by BOOTING:** (1) **`mm/vmalloc.c` contiguous-identity under
  CONFIG_WASM** — an identity-mapped kernel can't reach scattered vmalloc pages,
  so vmalloc == NOMMU's contiguous `kmalloc`/`kfree`/`virt_to_page` (the arch
  already commits to MAX_ORDER=16 blocks). This is the RIGHT design for a
  *software* MMU, not a workaround — and strictly better than instrumenting the
  kernel (Option B), which would tax every kernel memory access at ~3-4× AND
  still need the uaccess soft-walk. Unblocked bpf/tty/all vmalloc users. (2)
  **full initial-stack population at exec** (`fs/binfmt_wasm.c`) — the A1
  fast-path translate has no present check, so a demand-paged (grown) stack page
  silently mistranslated (caught: one checksum nibble wrote 0x00 through a zero
  PTE). Engine half: ENGINE_ABI 9 — `pt_base` rides the exec ABI, applied to the
  instrumented image's `__mmu_pt_base` global at instantiation (per-task
  instances each carry their own root). Design +
  `docs/superpowers/notes/2026-07-02-mmu-kernel-compile-milestone.md`.
- **Track A2 — demand paging / present-checked translate: DONE + BOOT-VERIFIED
  (2026-07-02).** `checked: true` instruments the SAME inline walk with a
  present test after each level; on a miss it calls
  `env.__wasm_syscall_2(NR_arch_specific_syscall=244, ea, kind)` — reusing the
  existing syscall entry (NO new ABI; still ENGINE_ABI 9) — routed to
  `sys_wasm_mmu_fault → __wasm_mmu_fault → handle_mm_fault`, then RE-WALKS. The
  kernel half drops the A1 full-populate (`patches/kernel/0024`, `a2=true`:
  removes `VM_LOCKED` def_flags + the initial-stack `mm_populate`) so pages
  fault in for real. `nix build .#kernel-mmu-a2` + `runtime/demo/node/
  mmu-smoke-a2.mjs` boots a CHECKED-instrumented init that demand-zero-mmaps
  8 MiB (per-page write/read/checksum), grows the stack via deep recursion, and
  PASSES all three (alive + bit-exact mmap checksum + stack-grow). **The
  keystone fix, found by BOOTING (an infinite refault loop, addr `0x400002c0`
  handler-returns-0-but-re-walk-still-faults):** the present TEST DIFFERS BY
  LEVEL. The kernel's folded 2-level tables store the bare pte-page PHYSICAL
  address in the pgd/pmd slot with NO flag bits (`pmd_present(pmd)=pmd_val`,
  `pmd_none=!pmd_val`), and only the LEAF pte carries `_PAGE_PRESENT` in bit 0.
  The pass originally tested `& 1` at BOTH levels, so a validly-populated pgd
  entry (`0x206ed000`, bit 0 clear) read as not-present and faulted forever.
  Fix: level-1 present = `entry != 0` (`i32.eqz`), leaf present = `pte & 1` —
  in both the inline `emitTranslate` and the bulk-op `checkedTranslateBody`.
  Diagnosed via a gated debug kernel (`.#kernel-mmu-a2-dbg`,
  `patches/kernel/0025`, `debugTrace=true`) that raw-walks `mm->pgd` after
  `handle_mm_fault` exactly as the pass does. Same wasm-can't-do-hardware theme:
  the software walk must match the kernel's PTE/PMD format bit-for-bit. **COW +
  mprotect DONE too:** the leaf present test is PERMISSION-AWARE — a LOAD needs
  `_PAGE_PRESENT` (bit 0), a STORE/RMW needs `_PAGE_PRESENT|_PAGE_WRITE` (bits
  0+1). Testing the write bit on stores is what makes COW work: a copy-on-write
  page is mapped present-but-read-only, so a store must fault into do_wp_page to
  duplicate it rather than walking straight through to the shared page (which
  would corrupt it — e.g. the global zeropage). Boot-verified in mmu-smoke-a2:
  a first-READ of a fresh anon page maps the zeropage RO (reads 0x00), the WRITE
  write-protect-faults and COWs (reads back 0xab); an mprotect narrow→read→widen
  →write round-trip returns 1. Unit-tested in softmmu-pass.test.js (store to a
  present-RO page faults kind=1 then succeeds; load from it never faults). Both
  the inline `emitTranslate` (compile-time kind) and the bulk-op
  `checkedTranslateBody` (runtime `need = 1 | (kind<<1)`) enforce it. Both
  mmu-smoke + mmu-smoke-a2 are now GATED in `nix-wasm.yml`'s boot-smoke job.
  **REMAINING for Track A:** none — demand paging + COW + mprotect all boot-
  verified and gated; the fork COW replay is exercised by Track B.
- **Track B — REAL fork() BOOTS on the software MMU (returns twice + COW).**
  The MMU-native fork is DONE and boot-verified — NOT PR #20's retired NOMMU
  per-process-Memory model. Three parts: (1) **musl** — the fork-asyncify seam
  (`_Fork`→`capture_stack`) as `patches/musl/0010`, a `fork ? false` variant of
  `musl.nix` (`.#musl-fork`); (2) **kernel** — `patches/kernel/0026-wasm-mmu-fork
  .patch` (applied with 0023): `wasm_fork_current(user_sp,user_tls,fork_ctl)`
  stamps the fork-time SP/TLS into pt_regs (fork bypasses syscall entry), arms
  `fork_ctl` on `current`'s switch_stack (copy_thread's copy carries it to the
  child), runs `kernel_clone(SIGCHLD, no CLONE_VM)` → generic COW `dup_mmap`;
  `copy_thread` forces `CPUFLAGS_USER_TASK_DEFAULT` on the child; `__switch_to`
  passes `fork_ctl` via `wasm_create_and_run_task`'s new trailing arg; (3)
  **engine** — `kernel-worker.js` (ENGINE_ABI 10): `env.capture_stack` per
  worker, `run_user_entry` drives the fork loop (parent unwind →
  `wasm_fork_current` → dual rewind on the SAME shared arena with per-process
  `pt_base`), a fork child REWINDS the captured stack at first run.
  **FULL POSIX fork()+wait() (one boot, `fork-smoke.mjs`, gated in `nix-wasm.yml`):**
  `child ret=0 witness=0x10c` AND `parent pid=0x1e witness=0x1b0 status=0x7` —
  fork returned twice, the private witness at one VA COW-diverged, and the parent
  BLOCKED in `waitpid()`, was woken, and reaped the child's `exit(7)`. Mechanism
  also unit-proven in `softmmu-fork.test.js` (asyncify×softmmu×COW, two instances
  on one Memory).
  **The keystone engine fix (a GENERAL software-MMU correctness bug, not
  fork-specific):** the kernel's `switch_mm` calls `__mmu_set_pt_base(next->pgd)`
  on every context switch, running in whatever worker executes the scheduler —
  including a task's OWN worker when it schedules out (`switch_mm(self, next)`
  writes `next`'s pgd into self's instance `__mmu_pt_base`, then self parks).
  Nothing cross-worker restored it, so a woken task walked the WRONG page table
  and fault-looped on its own stack (found via a fault-rate boot trace: 130M+
  faults at one stack addr). A worker's instance `pt_base` is IMMUTABLE after
  instantiation, so `kernel-worker.js` remembers it as `own_pt_base` and
  re-applies it in `serialize_me` after each wake. Single-task A2 smokes never
  switch between two user tasks, so never hit it — the fork smoke is the first
  two-user-task test. This unblocks the **#131 slice-1 payoff** (retire forkshell
  ash, busybox spawn patches, glib's posix_spawn-only patch; #93). Full record:
  `docs/superpowers/specs/2026-07-01-track-b-fork-seam-status.md` (UPDATE
  2026-07-02 final). ENGINE_ABI 10 needs `runtime/sync-to-pc.sh` before a pc deploy.
- **#131 cleanup** — the payoff. Slice 2 (dlopen accommodations) is unblocked by
  Track C; slices 1/3 gated on Track B/A world builds. Execution-ready audit
  (each box + exact edit + verify gate): `docs/superpowers/specs/
  2026-07-01-cleanup-131-audit.md`. NOT executed blind — the glib/gtk3 overrides
  need a boot to verify (PRIME DIRECTIVE).
- **MMU ship plan, Phase 1 (parity-proof CI wiring) landed** (2026-08-05):
  `nix-wasm.yml` gained a `nix-boot-smoke-mmu` `gtk` shard that boots the same
  one-per-boot GTK app set (gtk-hello/galculator/widget-factory/gtk3-demo/
  gcalctool/l3afpad) NOMMU's own `nix-boot-smoke` runs, on `.#kernel-mmu-a2` +
  the fork initramfs/squashfs — and `boot-smoke` gained a third `mmu-devices`
  shard re-booting the async-signal + virtio-device regression set
  (vsock/resize/snd/blk-rw/…) on the same pair. **These are first-ever boots
  against this kernel+initramfs pair, so almost all of the smokes in both
  shards run NON-GATING** — each affected job splits into a "hard gates" step
  (`run_smoke`, fails the job on a real error) and a SEPARATE
  `continue-on-error: true` "soak" step whose `check()` wrapper records a real
  failure, prints an `::error::` annotation, and still lets the step's own
  exit code go nonzero — so a soak failure shows up as a genuinely red (but
  non-blocking) step in the Checks UI, not a silently-swallowed `return 0`. An
  earlier draft used exactly that — a `run_smoke_soft` bash helper whose every
  path ended `return 0` — and it was caught in review: the step's own exit code
  was always 0 regardless of what ran inside it, indistinguishable from every
  smoke actually passing, so the step could never go non-green no matter what
  broke. `continue-on-error` fixes that at the STEP level instead, preserving
  the script's real exit code while still keeping the JOB green (the soak
  period). Full rationale: the SOAK NOTE comments on both jobs in
  `nix-wasm.yml`. **PROMOTION (the #131 soak-flip) is COMPLETE — 19/19**: PR
  #184's first soak cycle recorded first-attempt greens for all ten
  `mmu-devices` smokes (whole shard ~2.5 min, no panic-retries), `core`'s
  three new e2es, and five of the six `gtk` smokes — each moved to a
  `run_smoke` hard gate (`ping-pace-probe-smoke` stays the always-non-gating
  diagnostic it is on NOMMU). The 19th — `widget-factory-smoke` — was the
  cycle's one REAL finding: the ABI-8 dl host surface read USER pointers
  untranslated (see the "Host imports that take USER pointers" learnings
  entry above; engine fix `runtime/mmu-uaccess.js`); PR #186's soak recorded
  its post-fix CI green and it took the last promotion. NO soak step remains
  from THAT promotion cycle — all 19 hard-gate, and a regression on any of
  them turns the JOB red (the soak idiom's rationale lives in git history +
  pr-preview.yml's MMU-preview step comment for the next first-ever-boot
  shard that needs it). (One soak WAS added to the same `core` shard later,
  2026-08-12: `autotools-fork-smoke.mjs`'s acceptance soak, non-gating until
  issue #192 was fixed — see the autotools caveat above and the 2026-08-05
  parity-plan note. It postdated this 19/19 flip and was not one of the 19;
  it was itself promoted to a `run_smoke` hard gate on 2026-08-13 once #192
  was fixed, so no soak step remains in this job at all now.) That shard
  verifies issue #11 item
  1 ONLY — device models still work
  when USER pages are translated (the kernel's soft uaccess walk + the
  instrumented user binary's own buffer accesses); the vring/pfn addressing
  itself runs in kernel/driver context, identity-mapped under CONFIG_MMU=y, so
  it was never actually "under translation" — NOT the Wayland/`wl_shm` half of
  #11: every gtk-shard smoke is a display-free `--selftest` (no compositor in
  the node harness → `wl_shm` is never allocated), so items 2/3/5 (the
  virtio_wl per-vfd/shm-fd/proxy accommodations) stayed unverified on MMU from
  THIS shard's evidence alone. **UPDATE (issue #203): items 2 and 3 are now
  verified**, by a dedicated non-compositor smoke
  (`runtime/demo/node/wl-shm-mmu-smoke.mjs`, `boot-smoke`'s `mmu` shard,
  non-gating) that drives virtio_wl's NEW_ALLOC/anon-inode/SEND-fds sequence
  directly against a bespoke test binary (`userspace/wl-shm-test.c`) — no
  compositor needed. Item 2 (per-vfd anon inode) and item 3 (the host device
  model's pfn→host-offset `_resolveShmFd` resolution) both PASS reliably.
  A THIRD thing this smoke found while proving that: the mmap CONTENT
  round-trip (can the guest actually WRITE into the vfd and have the host
  read the same bytes) reliably FAILS with a clean SIGBUS — `virtwl_vfd_mmap`
  /`virtwl_vfd_get_unmapped_area` (`patches/kernel/0013`) were written for
  NOMMU's `do_mmap` direct-mapping and were never given real MMU page-fault
  semantics; patch 0023 only ADDED an `#ifndef CONFIG_MMU` guard around the
  NOMMU-only `virtwl_vfd_mmap_capabilities` hook (compiling it OUT under
  CONFIG_MMU, since that fops field doesn't exist there at all) while
  `.mmap`/`.get_unmapped_area` stay registered unchanged and un-ported (no
  `vm_ops`, no `remap_pfn_range`; `get_unmapped_area` returns the shm
  buffer's KERNEL address as if it were a valid USER mapping address). Filed
  as **issue #203**, tracked as a real, reproducible kernel gap (not part of
  this smoke's own scope to fix) — the smoke's CONTENT check and the CI
  step's XFAIL design document the exact signature so a future fix is
  provably detected. Item 5 (waylandproxyd's mmap+copy resync) is STILL
  unverified — that logic lives in the Sommelier Wayland-client bridge path,
  unreached without a real compositor boot. Items 4 (the dropped upstream
  `vmalloc`/`find_vm_area` large-buffer-send branch) and 6 (waylandproxyd's
  single-process/no-fork design) aren't addressed by this shard set at all (a
  restore-or-keep call and a Track-B-fork follow-on, respectively — full
  six-item disposition in the parity-plan doc's close-out map). Every
  same-repo PR preview also now
  publishes a SECOND artifact set (`pr-preview.yml` + `runtime/demo/web/
  main.js`'s `?variant=mmu`), so a human CAN boot the MMU/fork guest in a real
  browser from any PR — the closest thing to a wl_shm-on-MMU check today, and
  it's a manual one, not a CI gate. None of this touches
  `.#linux-image`/`.#kernel`/`ENGINE_ABI` — it is additive coverage on the
  existing `-mmu`/`-fork`-suffixed attrs only. Full 4-phase plan (this parity
  proof → #131 slice-1 default-flip, a batched world rebuild → the ship flip
  with its MANDATORY `ENGINE_ABI` bump + ordered `sync-to-pc.sh`→pc-deploy
  →`publish-linux-channel` rollout → #131 slices 2/3 cleanup), the #11/#131/#126
  ticket close-out map, and the two open risks (browser instrument-at-load
  memory for `nix.wasm` — the `-lg`-runner OOM lesson from #175 — and the
  permanent ~2-3× per-access-walk cost): `docs/superpowers/notes/
  2026-08-05-mmu-phase1-parity-plan.md`.

The new `runtime/*.js` modules (`dylink.js`, `ffi-codegen.js`, `softmmu-pass.js`,
`asyncify.js`) are pure + unit-tested (`bun test`); like all `kernel-worker.js`
edits, the ABI-8 host surface needs a `sync-to-pc.sh` before a pc deploy.

## Plans & future work

Phases 1–4 of the "NixOS in wasm" vision are done (toolchain → userspace →
guest-clang/cc → kernel); the code + this file + git history are the record.
Remaining work and design notes live as GitHub issues, not in-repo plan files:

- **#2** — Phase 5: CI + binary cache. **Cachix is wired** as the host build
  cache (`nix-wasm.cachix.org`) and the flake builds on x86_64-linux; the three
  workflows + the two-tier (Cachix host / R2 guest) design are documented under
  the Caching section above. `wl-eyes` is vendored (#62/#63) so initramfs +
  linux-image build in CI too. Remaining to fully close: add the
  `CACHIX_AUTH_TOKEN` repo secret and run the cold-cache build once to populate
  Cachix.
- **#3** — DONE (2026-06-24): the `cc`/`c++` shell wrappers are retired; clang is
  its own driver via the auto-loaded `clang.cfg`/`clang++.cfg` (config-file
  approach A — `toolchain/wasm-clang-config.nix`). The `posix_spawn` gate is
  satisfied (#48/#50). See the "clang is its own driver" note in Current state.
- **#1** — DONE: `nix profile install` (new CLI) works like a real NixOS system by
  installing the package's OUTPUT path (Opaque) — source-free, substitute-only. Two
  real pieces, no nix patch / no fake derivation: (1) substitution must stay ON —
  the new CLI disables it offline (`src/nix/main.cc`) unless overridden, so the
  install passes `--option substitute true` (a command-line override the offline
  block honors; the `nix.conf substitute = true` form doesn't take effect at the
  `getWorkerSettings()` level the check reads); (2) a `paths.nix` name → output-path
  map, so `nix profile install <outPath>` (path read via `nix eval --raw -f
  /nix-cache/paths.nix <name>`) installs a store path (Opaque) and substitutes the
  prebuilt output (+ closure). `nix-env -iA` keeps
  using the derivation catalog `pkgs.nix`: its realisation SUBSTITUTES the `.drv`
  from the cache (then the output), so the cache publishes the `.drv` closures
  (`rootPaths = devPaths ++ map drvPath devPaths`). The new CLI can't use that path
  — it forms `Built{drvPath}` and can NOT obtain a non-local `.drv` (`misc.cc
  queryMissing` marks it "unknown" → "failed to obtain derivation"), so it installs
  the output path instead. DEAD END: seeding the `.drv` closure into the base
  SQUASHFS (not the cache) — a `.drv` closure is ~6.7 GB of build sources (a real
  system has none), overflowing the boot harness's 2 GiB cap. The `.drv` closures
  belong in the lazily-served cache (what nix-env fetches), just not baked into the
  squashfs. Full by-name deriver parity for ARBITRARY packages via the new CLI
  needs in-guest eval. Validator: `runtime/demo/node/profile-install-e2e.mjs`
  (the `nix-boot-smoke` CI job). FOLLOW-UP (DONE): `nix-env -iA guest-cc` also
  needed `always-allow-substitutes = true` in the guest nix.conf — guest-cc /
  guest-cxx are trivial builders (`writeShellScriptBin`, `allowSubstitutes =
  false` + `preferLocalBuild = true`), so nix-env realised the deriver and tried
  to BUILD them ("platform mismatch") instead of substituting the cached output;
  the build-incapable guest must always substitute. (`nix profile install
  <outPath>` was unaffected — an Opaque install never consults `allowSubstitutes`.)
- **#96** — DONE: the "freshly-compiled binary hangs on exec in the Node harness"
  was a HARNESS bug, not an exec hang. `profile-install-e2e`'s run marker `CC_RC`
  is a substring of step 4's `WHICH_CC_RC`, so `waitForOutput(/CC_RC=[0-9]/)`
  matched the stale `WHICH_CC_RC=0` instantly, saw rc≠42, and reported the healthy
  run as hung ("transcript ends at the compile"). Fixed with a collision-free
  `PROG_EXIT` sentinel; step 6 is now gating. The exec itself is fine (cold
  first-exec ~1-4s — each exec recompiles the module from shared memory, no host
  module cache; warm execs instant). Lesson: harness markers must use `=$?`
  (matches the expanded value in OUTPUT, not the echoed command) AND not be a
  substring of any earlier marker.
- **#92** — in-guest `nix build` from source: the BUILD path WORKS. nix's
  `local-derivation-goal` (fork/exec a builder) runs on the NOMMU wasm guest via
  `posix_spawn` (no fork/vfork), with sandbox/namespaces off (`sandbox = false`,
  `filter-syscalls = false`). Proven + gated by
  `runtime/demo/node/build-from-source-e2e.mjs` (in `nix-boot-smoke`): a trivial
  `/bin/sh` builder, a multi-util builder with `PATH=/bin` (the cleared build env
  needs PATH — busybox applets are otherwise "command not found"; normal Nix, not
  a wasm limit), and a derivation that COMPILES inline C with the in-guest
  toolchain (`guest-cc`) → a wasm binary that then RUNS → exit 42. REMAINING (the
  larger lift): full nixpkgs-stdenv / autotools (`./configure && make`) builds need
  the cross-built stdenv closure (bash/coreutils/make/cc-wrapper) substituted as
  build INPUTS — a separate effort; and memory ceilings for big builds are
  unmeasured (the toolchain itself stays substitute-only).
- **#175** — DONE: in-guest **build-from-source works on the software-MMU guest**
  (it SIGSEGV'd because nix's spawn breaks under the MMU). The shipped default
  guest is `posix_spawn`-only (nix's builder spawn is fine there — #92); this is
  about the **MMU fork variant** (`.#nix-wasm-fork` / `.#wasm-base-squashfs-fork`),
  where nix uses **real `fork()`+`exec`** over muslFork's asyncify seam (Track B).
  Two parts, both **confined to the fork variant** (shipped NOMMU guest byte-identical,
  NO `ENGINE_ABI` bump, NO pc sync):
  1. **`clone(CLONE_VM|CLONE_VFORK)` → real `fork()`.** nix's `startProcess`
     spawned the builder with a parent-mmap'd child stack; under the software MMU
     the `CLONE_VM` child gets a **private pgd**, so the parent-mmap'd stack is
     unmapped in the child → SIGSEGV. Fix = the upstream `else pid = fork();` path,
     gated `#if defined(__wasm__) && !defined(WASM_REAL_FORK)` in the nix port patch;
     the fork variant defines `WASM_REAL_FORK`. The fork nix.wasm is **bounded-asyncify'd**
     over the fork call graph ONLY (whole-module asyncify 2.9×'d it → OOM'd the
     softmmu load): `asyncify-ignore-indirect` + a demangled-name **addlist** of every
     indirect-boundary frame (`_Fork` seed, the crt chain, `nix::startProcess`/
     `handleExceptions`/`mainWrapped`, the C++20-coroutine goal stack, `std::__1::function`
     machinery — NOTE our libc++ is `std::__1`, not emscripten's `std::__2`) +
     `propagate-addlist`; size + decision-count **build gates** guard the addlist,
     and the fork binary ships **unstripped** (symbolized traces; softmmu passes
     custom sections through). `nix-wasm.nix` (`realFork`), `patches/nix-*.patch`.
  2. **exec stack-collapse must be an UNCATCHABLE wasm trap** (`wasm_collapse`,
     `patches/kernel/0026` + `runtime/kernel-worker.js` + `runtime/exec-collapse-trap.test.js`).
     The engine collapsed the post-`exec()` user stack by having the
     `wasm_user_mode_tail` host import `throw` a JS `Trap`. A JS throw crossing back
     into wasm is a **foreign exception**, which wasm-EH `catch_all` CATCHES — and
     nix's real-fork child wraps `execve` in `catch(...)` (`-fwasm-exceptions`), so
     the collapse was SWALLOWED → stale nix code ran on the freshly-exec'd (busybox)
     address space → SIGSEGV inside the fault syscall (silent in CI). Fix: MMU-fork
     kernels export `wasm_collapse()` (`__builtin_trap` → `unreachable`); the engine
     **feature-detects** it and, when present, collapses via that GENUINE wasm trap.
     A real trap is NOT catchable by `catch/catch_all`, and stays uncatchable across
     the `__wasm_syscall_N` + `wasm_user_mode_tail` JS import frames (pinned by the
     unit test — verified in V8). NOMMU kernels have no `wasm_collapse` export → the
     engine keeps the byte-identical JS-throw path, so `ENGINE_ABI` stays 11
     (documented in `abi.js`, incl. the deferred bump obligation if the MMU/fork
     guest ever becomes the published image). NO `entry.S`/FOOT surgery.
  Proven by `build-from-source-e2e` on `.#kernel-mmu-a2` + the fork squashfs:
  BUILD1/BUILD2 (the forked `/bin/sh` builder fork+execs and runs — the exact
  SIGSEGV path) both pass, with no NOMMU regression. **BUILD3** (a derivation that
  execs `guest-cc` — the 57MB clang — to compile C) was split off as **#179** and is
  now FIXED too (see below), so all three are gating on both jobs.
- **#179** — DONE: the in-guest clang SIGSEGV on the software-MMU guest. It was
  **NOT** the softmmu translate (the issue's own framing, and mine until the guest
  was booted): `cc --version` — no derivation, no forked builder, no compile — died
  the same way, and NO `NR_MMU_FAULT` ever returned a failure. **Root cause: a
  missing STARTUP EXPORT.** `toolchain/guest-clang.nix` is the one guest link that
  deliberately drops `--export-all` (so wasm-ld's default `--gc-sections` can strip a
  ~100MB module), and its hand-written list of engine-called startup exports never
  gained `__wasm_early_tp_init` when #166 added it. Unexported, the seed is also
  UNROOTED, so `--gc-sections` deleted it outright; the engine's call site is a
  permissive `if (instance.exports.__wasm_early_tp_init)` (deliberately, for older
  NOMMU libcs), so the absence was **silent**. clang's ctors therefore ran with
  `__musl_tp == 0`: libc++'s `ios_base::Init` `lseek`s stderr, gets ESPIPE, and
  stores `errno` through the null `struct pthread` — a WRITE to VA **0x1c**
  (`offsetof(struct pthread, errno_val)`), which page 0 makes harmless on NOMMU and
  fatal under CONFIG_MMU. Localized by logging every syscall during
  `__wasm_call_ctors` from the engine: the last two were `lseek(2,…)` then
  `nr=244 (fault) va=0x1c kind=1`. **Fix** (PRIME DIRECTIVE corollary 1 — fix the
  shared thing, not the one binary): a single source of truth
  **`toolchain/wasm-host-exports.nix`** for the engine-called startup exports,
  consumed by BOTH non-`--export-all` links (`guest-clang.nix` — this is the actual
  bug fix — and `nix-wasm.nix`'s `wcxx`, which had the right set but a second copy of
  it). The `--export-all` links (`wasm-cross.nix`, `make.nix`, `guest-cc-fork.nix`,
  `wasm-clang-config.nix`) deliberately do NOT consume it: they export the set by
  construction, and touching `wasm-cross.nix` would force a full `cross.*` world
  rebuild for nothing. Guards, because the engine's guard cannot be one:
  `guest-clang.nix` `installPhase` now ASSERTS the shipped `clang`/`wasm-ld` export
  the required set (`scripts/wasm-check-exports.py`, which parses the export section
  — the binaries are `--strip-all`ed so objdump/name-section tricks and `grep` both
  lie), and the engine now logs LOUDLY when an MMU guest image (`pt_base != 0`) lacks
  the seed. Verified by BOOTING, without the ~1–2 h clang rebuild: one C++ program
  with a `lseek(2)`-in-a-static-ctor probe, linked twice with guest-clang's exact
  flags differing ONLY in `--export-if-defined=__wasm_early_tp_init`, run on
  `.#kernel-mmu-a2` — unexported → SIGSEGV/139 (clang's exact signature), exported →
  `ctor_errno=29` (ESPIPE, i.e. the very store that faulted) and exit 0. Also fixed a
  harness bug that hid the evidence for a week: `build-from-source-e2e`'s
  `==B3ERR-START==` marker appeared in the ECHOED command line too, so the capture
  returned the command text instead of the builder's stderr (the #96 lesson again —
  match the EXPANSION, never the echo; the markers now come from a shell variable).
  **Hardening landed with it (the second half of #179):** a host-REJECTED exec
  image now kills only the execing task instead of PANICKING the guest. The
  softmmu pass's refusal used to be a THROW out of `wasm_load_executable`, which
  escaped into the kernel's own wasm frames and only landed later — with no kernel
  context — in `raise_exception()` → `make_task_dead()` → `panic("Aiee, killing
  interrupt handler!")`. One unsupported user binary took down the system, and that
  is how #179 first presented. Fix: `wasm_load_executable` RETURNS a status
  (0 = loaded) and `start_thread` does `force_fatal_sig(SIGSEGV)` + **skips
  `_TIF_RELOAD_PROGRAM`** (the load-bearing half — the engine holds no image, so
  asking it to reload would crash it). We are past `begin_new_exec()` there, so
  `-ENOEXEC` is unreachable and killing the task is exactly what `bprm_execve()`
  does for a late `load_binary` failure. **NOT an ENGINE_ABI bump** — no import is
  added or removed, only an existing import's RESULT type moves, which is
  compatible BOTH ways (new kernel + old engine: JS `undefined` → i32 `0` =
  "loaded"; old kernel + new engine: a `() -> ()` import discards the value). Both
  coercion rules are pinned by `runtime/exec-reject-abi.test.js` — the whole
  no-bump argument rests on them. The kernel half is wired as **config-independent
  `substituteInPlace` + asserts in `kernel.nix` postPatch**, NOT a patch hunk:
  patches 0023/0026 already rewrite that region of `arch/wasm/kernel/process.c`
  (and only under mmu/a2), which is exactly the silent fuzzy-apply hazard the
  0017-0020 entry documents. Gate: `exec-reject-smoke.mjs` (in BOTH the NOMMU
  boot-smoke and the MMU job) boots busybox-only and execs
  `userspace/exec-reject-test.nix`'s fixture — a real guest program with the
  `__get_tls_base` export STRIPPED (`scripts/wasm-strip-export.py`; it has to be
  manufactured that way now, since the toolchain forces those exports into every
  link) — asserting the conforming twin runs, the stripped one does not, there is
  NO panic, and **the shell survives**. Still bounded, deliberately: only
  SYNCHRONOUS rejections are reported (the instrument pass + table probe run
  inline; `WebAssembly.compile` is a promise, so a malformed-module compile error
  keeps the old late path) — #179's class is exactly the synchronous one.

(The executed per-task plans — toolchain, userspace, kernel-nixify, guest-shell
forkshell-ash — the rationale/master-plan docs, and the detailed STATUS log were
removed once done; the code, this file, and git history are the record.)
