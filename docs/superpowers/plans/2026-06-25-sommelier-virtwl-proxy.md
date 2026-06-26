# Sommelier on virtwl — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the byte-splice `waylandproxyd` with the real upstream Sommelier, cross-compiled to `wasm32-nommu` on the native virtwl transport (wl_shm path), fixing the order-11 buddy-fragmentation crash by construction.

**Architecture:** Sommelier runs in `--parent` virtual-context mode: it owns `wayland-0`, `posix_spawn`s a per-client worker (`sommelier --client-fd=N`) that opens its own virtwl ctx and proxies via libwayland-server's object model. Buffer destructors free virtwl allocations, so `wl_shm` pools no longer leak. The full dep closure (libxcb/libdrm/minigbm link-only; wayland/xkbcommon/pixman already cross) is built as a reusable C++ guest library closure.

**Tech Stack:** Nix crossSystem (`wasm32-unknown-linux-musl`, clang-21), meson, libwayland (client+server), libffi (raw wasm backend), the joelseverin/linux wasm kernel, Node test harness (`runtime/demo/node/`).

## Global Constraints

- Target triple `wasm32-unknown-unknown`; flags `-D__linux__ -matomics -mbulk-memory -fwasm-exceptions`; everything static `.a` into a `-shared` dylink module. (CLAUDE.md Architecture)
- **No `fork`/`vfork`** — musl has the symbols removed; any `fork()` reference fails the link. All spawning goes through `posix_spawn`. (docs/process-model.md)
- **Every overlay override MUST be guarded `prev.stdenv.hostPlatform.isWasm`** — unguarded overrides rebuild the native toolchain. (CLAUDE.md)
- No blanket `--allow-undefined`; guest links allow only the shared allow-list file (`toolchain/wasm-host-imports.nix`). (CLAUDE.md #52)
- Build/run with `sudo` + flakes: `echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#<attr> --print-out-paths`. Run each `sudo nix` as its own command (sudo loses piped password into subshells). Local sudo password is in agent memory (`sudo-password.md`).
- Kernel/runtime engine edits (`kernel-worker.js`, `vmlinux.wasm`) require a pc sync via `runtime/sync-to-pc.sh` and re-publish; in-repo node smokes use `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/`.
- Pin: `nixos-unstable` @ `9ae611a` (LLVM 21.1.8). Local builds are on aarch64 (first LLVM build is from source ~1–2 h — never kill a running build).
- PRIME DIRECTIVE: prefer providing a library over stripping upstream code; the only functional Sommelier source patch is the spawn port.

---

## File Structure

- `deps-overlay.nix` — add `isWasm`-guarded `libdrm`, `minigbm`, `libxcb` (+`libXau`/`libXdmcp`/`xcb-proto`) cross overrides.
- `userspace/wl-server-ffi.c` + `.nix` — libwayland-server `wl_closure_invoke` de-risk program (risk B).
- `patches/kernel/0018-virtwl-dmabuf-enotty.patch` — `NEW_DMABUF` → `-ENOTTY`.
- `vendor/sommelier/` — pinned upstream `vm_tools/sommelier` source subtree (CI-vendored, like `vendor/wl-eyes`).
- `patches/sommelier/0001-posix-spawn.patch` — fork→posix_spawn + `#if 0` Xwayland spawn.
- `userspace/sommelier.nix` — the Sommelier cross derivation.
- `userspace/wl-pool-churn.c` + `.nix` — the leak-regression client (risk: order-11 fragmentation).
- `flake.nix` — `.#sommelier`, `.#wl-server-ffi`, `.#wl-pool-churn` package attrs + `extraBins`.
- `userspace/init.nix` — switch `waylandLine` from `waylandproxyd` to `sommelier --parent`.
- `runtime/demo/node/sommelier-smoke.mjs`, `runtime/demo/node/sommelier-leak-smoke.mjs` — node gates.
- `docs/superpowers/notes/sommelier-visual.md` — manual browser-render note.
- `CLAUDE.md`, `MEMORY.md` — record the new proxy + library closure.

Each new cross lib resolves as `cross.<name>` (via `legacyPackages.${system} = cross`), buildable as `.#legacyPackages.<system>.<name>`.

---

## Phase 0 — De-risk the two linchpins (gate everything else)

### Task 1: minigbm cross-build (risk A)

**Files:**
- Modify: `deps-overlay.nix` (add a `minigbm` override near the `pixman`/`wayland` test-disable block, ~line 444)

**Interfaces:**
- Produces: `cross.minigbm` — a static `libgbm.a` + `gbm.h` header. Link-only; never executed at runtime.

- [ ] **Step 1: Write the failing build gate**

minigbm is in nixpkgs. The default build assumes a GPU driver set + may compile fork-using helpers. Add an `isWasm`-guarded override that disables tests/tools and keeps only the library + header. Mirror the existing `pixman`/`wayland` pattern in `deps-overlay.nix`:

```nix
  # --- minigbm: link-only libgbm for Sommelier (gbm sites are dead at runtime) --
  # Sommelier links gbm but never calls it on the wl_shm/virtwl path (ctx->gbm
  # stays null — see the design spec). We only need libgbm.a + gbm.h to satisfy
  # the linker. minigbm (chromiumos's own gbm, what Sommelier targets) is small C;
  # mesa's gbm (the GL stack) is explicitly NOT used. Disable the cros-specific
  # install bits / tools; keep the static lib.
  minigbm = whenWasm
    (prev.minigbm.overrideAttrs (old: {
      # meson/`make` flags discovered at build time; start from upstream and
      # disable any GPU-driver gating + tool binaries. Document each flag added.
      doCheck = false;
    }))
    prev.minigbm;
```

- [ ] **Step 2: Run the build to observe the real failure**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.minigbm --print-out-paths 2>&1 | tail -40
```
Expected: either success (→ Step 4) or a concrete cross error (missing header, a GPU-driver `dlopen`, a fork in a tool). Capture the exact error.

- [ ] **Step 3: Apply the documented cross fix**

For each failure, the fix follows the overlay's established kinds: drop a non-library output, disable a tool/driver that needs `dlopen`/GPU, or filter a fork-using build input. Add each flag with a one-line comment explaining *why* (per CLAUDE.md learnings index). If minigbm fundamentally resists (e.g. needs a live `/dev/dri`), fall back to the documented shim: a 3-file `userspace/libgbm-shim/` providing `gbm.h` + a `libgbm.a` whose symbols (`gbm_create_device`, `gbm_bo_import/map/unmap/destroy`, `gbm_device_get_fd`) `abort()` — provably never called. Note the fallback choice in the commit message.

- [ ] **Step 4: Verify the static lib + header exist**

```bash
OUT=$(echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.minigbm --no-link --print-out-paths)
find $OUT -name 'libgbm*.a' -o -name 'gbm.h' | sort
```
Expected: both a `libgbm*.a` and `gbm.h` printed.

- [ ] **Step 5: Commit**

```bash
git add deps-overlay.nix
git commit -m "feat(#7): cross-build minigbm (link-only libgbm for Sommelier)"
```

### Task 2: libwayland-server libffi dispatch de-risk (risk B)

**Files:**
- Create: `userspace/wl-server-ffi.c`, `userspace/wl-server-ffi.nix`
- Modify: `flake.nix` (add `wlServerFfi` attr + `.#wl-server-ffi` package)
- Create: `runtime/demo/node/wl-server-ffi-smoke.mjs`

**Interfaces:**
- Consumes: `cross.wayland` (libwayland-server), `cross.libffi` (raw backend).
- Produces: `/bin/wl-server-ffi` printing `RESULT wl-server-ffi PASS handler_ran=1` when `wl_closure_invoke` dispatches a request through our raw FFI backend.

- [ ] **Step 1: Write the failing test program**

A self-contained libwayland-**server** program: create a `wl_display`, define a tiny interface with one request whose handler sets a flag, build a `wl_resource`, and dispatch a synthetic request via the server's marshalling so `wl_closure_invoke` → `ffi_call` fires the handler. Assert the flag. (Use `wl_display_create` + `wl_global_create` + `wl_resource_create` + `wl_resource_set_implementation`, then drive a request through `wl_client`/`wl_event_loop` over a `socketpair`, mirroring `userspace/wlhandshake.c`'s client style but server-side.)

```c
/* userspace/wl-server-ffi.c — proves libwayland-server's wl_closure_invoke
 * dispatches through our raw wasm libffi backend (risk B). Server-side ffi_call
 * is new vs waylandproxyd (raw sockets). PASS = a request handler fired. */
/* … full program: socketpair, wl_display, a 1-request test interface, drive one
 *   request from the raw client end, run wl_event_loop_dispatch, assert flag … */
```

- [ ] **Step 2: Build it and run the smoke to see it (initially) unbuilt/failing**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wl-server-ffi --print-out-paths
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/wl-server-ffi-smoke.mjs; echo EXIT=$?
```
Expected before wiring: build error / no `RESULT … PASS`.

- [ ] **Step 3: Write `wl-server-ffi.nix` + flake wiring + the node smoke**

`wl-server-ffi.nix` mirrors `userspace/wlhandshake.nix` (link `cross.wayland` server lib + `cross.libffi`). The node smoke mirrors `runtime/demo/node/waylandproxyd-spike.mjs`: boot `nix:false`, run `/bin/wl-server-ffi`, grep `RESULT wl-server-ffi PASS`. Add `wlServerFfi` to `flake.nix` and to initramfs `extraBins`.

- [ ] **Step 4: Rebuild the kernel artifacts if needed, run the smoke to PASS**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --print-out-paths
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/wl-server-ffi-smoke.mjs; echo EXIT=$?
```
Expected: `RESULT wl-server-ffi PASS handler_ran=1`, EXIT=0. If the raw FFI backend aborts on a wayland handler signature, extend `patches/libffi/gen-trampolines.py` (K/M bounds) per the libffi learnings — that is the de-risk payoff.

- [ ] **Step 5: Commit**

```bash
git add userspace/wl-server-ffi.c userspace/wl-server-ffi.nix flake.nix runtime/demo/node/wl-server-ffi-smoke.mjs
git commit -m "test(#7): prove libwayland-server wl_closure_invoke dispatch over raw libffi"
```

---

## Phase 1 — Library closure

### Task 3: libxcb closure (link-only)

**Files:**
- Modify: `deps-overlay.nix` (add `xcb-proto`, `libXau`, `libXdmcp`, `libxcb` overrides, `isWasm`-guarded)

**Interfaces:**
- Produces: `cross.xorg.libxcb` (with the `composite`/`shape`/`xfixes` extension libs, which libxcb generates internally) + `cross.xorg.libXau`, `cross.xorg.libXdmcp`. Link-only — Sommelier never executes xcb (Xwayland-gated).

- [ ] **Step 1: Add the overrides**

`xcb-proto` is Python XML codegen — it must come from **native** `buildPackages` (no wasm code). `libXau`/`libXdmcp`/`libxcb` are pure C socket/protocol libs; disable docs/tests. Guard each with `isWasm`. Mirror the `wayland` test-disable override:

```nix
  # --- libxcb (+ Xau/Xdmcp): link-only for Sommelier; never executed -----------
  # Sommelier links xcb but only calls it on the Xwayland path, which we never
  # enable (no -X / --x-display) — so xcb_* is dead at runtime (design spec §3).
  # We just need the static libs to satisfy the linker. xcb-proto's codegen is
  # native (buildPackages). Disable docs/tests (no fork-using test runners).
  libXau    = whenWasm (prev.xorg.libXau.overrideAttrs    (o: { doCheck = false; })) prev.xorg.libXau;
  libXdmcp  = whenWasm (prev.xorg.libXdmcp.overrideAttrs  (o: { doCheck = false; })) prev.xorg.libXdmcp;
  libxcb    = whenWasm (prev.xorg.libxcb.overrideAttrs    (o: { doCheck = false; })) prev.xorg.libxcb;
```
(If these live under `prev.xorg`, override via `xorg = prev.xorg // { … }` — match the existing `libxcb = null;` cairo pattern at deps-overlay.nix:512.)

- [ ] **Step 2: Build gate**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.xorg.libxcb --print-out-paths 2>&1 | tail -30
```
Expected: success, or a concrete cross error to fix (e.g. a configure probe needing the wasm-ld flag filter — already handled by the cc-wrapper; or a `--undefined-version` ELF flag — filtered).

- [ ] **Step 3: Fix per established overlay patterns; re-run Step 2 to green.**

- [ ] **Step 4: Verify the extension libs are present**

```bash
OUT=$(echo <pw> | sudo -S nix … build .#legacyPackages.aarch64-linux.xorg.libxcb --no-link --print-out-paths)
ls $OUT/lib | grep -E 'libxcb(-composite|-shape|-xfixes)?\.a'
```
Expected: `libxcb.a` and the composite/shape/xfixes extension archives.

- [ ] **Step 5: Commit**

```bash
git add deps-overlay.nix
git commit -m "feat(#7): cross-build libxcb closure (link-only for Sommelier)"
```

### Task 4: libdrm cross-build (link-only)

**Files:**
- Modify: `deps-overlay.nix` (add `libdrm` override)

**Interfaces:**
- Produces: `cross.libdrm` — static `libdrm.a` + `xf86drm.h` + `libdrm/drm_fourcc.h`. Link-only (dmabuf-gated).

- [ ] **Step 1: Add the `isWasm`-guarded override** (disable `intel`/`amdgpu`/`radeon`/`nouveau`/`valgrind`/tests — we need only the core ioctl wrappers + headers):

```nix
  # --- libdrm: link-only for Sommelier; dmabuf path is dead at runtime ---------
  libdrm = whenWasm
    (prev.libdrm.overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or []) ++ [
        "-Dintel=disabled" "-Damdgpu=disabled" "-Dradeon=disabled"
        "-Dnouveau=disabled" "-Dvmwgfx=disabled" "-Dman-pages=disabled"
        "-Dvalgrind=disabled" "-Dtests=false"
      ];
      doCheck = false;
    }))
    prev.libdrm;
```

- [ ] **Step 2: Build gate**

```bash
echo <pw> | sudo -S nix … build .#legacyPackages.aarch64-linux.libdrm --print-out-paths 2>&1 | tail -30
```
Expected: success or a concrete error.

- [ ] **Step 3: Fix to green; verify `libdrm.a` + `xf86drm.h` present.**

- [ ] **Step 4: Commit**

```bash
git add deps-overlay.nix
git commit -m "feat(#7): cross-build libdrm (link-only for Sommelier)"
```

---

## Phase 2 — Kernel: force the shm path

### Task 5: virtwl `NEW_DMABUF` → `-ENOTTY`

**Files:**
- Create: `patches/kernel/0018-virtwl-dmabuf-enotty.patch`
- Modify: `kernel.nix` (add the patch to the kernel patch list — match how 0013–0017 are listed)

**Interfaces:**
- Produces: a `vmlinux.wasm` whose `VIRTWL_IOCTL_NEW` with `type==NEW_DMABUF` returns `-ENOTTY`, so Sommelier's `init()` probe (`errno==ENOTTY`) selects the shm path.

- [ ] **Step 1: Write the patch**

In the `do_new` switch (`patches/kernel/0013` ~line 1878), replace the `NEW_DMABUF` case body with an immediate `-ENOTTY` (no host round-trip):

```c
	case VIRTWL_IOCTL_NEW_DMABUF:
		/* wasm/NOMMU: this virtwl device has no dmabuf driver. Return
		 * -ENOTTY so Sommelier's VirtWaylandChannel::init() dmabuf probe
		 * (errno==ENOTTY) cleanly selects the wl_shm path. (Design: the
		 * GPU/dmabuf path needs gbm/virtgpu we don't provide.) */
		ret = -ENOTTY;
		goto remove_vfd;
```
Author it as a patch over the kernel source the same way 0013 is structured (it patches the same file).

- [ ] **Step 2: Verify the patch applies + kernel builds**

```bash
echo <pw> | sudo -S nix … build .#kernel --print-out-paths 2>&1 | tail -20
```
Expected: patch applies, `vmlinux.wasm` builds (patched LLVM is cached → vmlinux relink only).

- [ ] **Step 3: Behavioral check (deferred to Task 10's smoke)** — the ENOTTY path is exercised when Sommelier boots; note it here and assert it in the Task 10 leak smoke (Sommelier logs "using virtwl instead").

- [ ] **Step 4: Commit**

```bash
git add patches/kernel/0018-virtwl-dmabuf-enotty.patch kernel.nix
git commit -m "feat(#7): virtwl NEW_DMABUF -> -ENOTTY so Sommelier picks the shm path"
```

---

## Phase 3 — Sommelier

### Task 6: Vendor the Sommelier source

**Files:**
- Create: `vendor/sommelier/` (the pinned `vm_tools/sommelier` subtree)
- Create: `vendor/sommelier/SOURCE.md` (rev + provenance)

**Interfaces:**
- Produces: a local source tree `userspace/sommelier.nix` builds from (CI-vendored like `vendor/wl-eyes`, so initramfs/linux-image build without network — see commit `dbc8f1b`).

- [ ] **Step 1: Fetch the pinned subtree**

Pick a recent `chromiumos/platform2` commit; record it. Fetch only `vm_tools/sommelier` (sparse checkout or extract from a tarball) into `vendor/sommelier/`:

```bash
REV=<chosen-platform2-sha>
git clone --filter=blob:none --no-checkout https://chromium.googlesource.com/chromiumos/platform2 /tmp/platform2
git -C /tmp/platform2 sparse-checkout set vm_tools/sommelier
git -C /tmp/platform2 checkout $REV
rm -rf vendor/sommelier && mkdir -p vendor/sommelier
cp -r /tmp/platform2/vm_tools/sommelier/. vendor/sommelier/
printf 'chromiumos/platform2 vm_tools/sommelier\nrev: %s\nfetched: 2026-06-25\n' "$REV" > vendor/sommelier/SOURCE.md
```

- [ ] **Step 2: Verify the expected files are present**

```bash
ls vendor/sommelier/{meson.build,sommelier.cc,sommelier.h,virtualization/virtwl_channel.cc}
```
Expected: all present.

- [ ] **Step 3: Commit**

```bash
git add vendor/sommelier
git commit -m "feat(#7): vendor chromiumos vm_tools/sommelier source (rev $REV)"
```

### Task 7: posix_spawn patch (the only functional source patch)

**Files:**
- Create: `patches/sommelier/0001-posix-spawn.patch`

**Interfaces:**
- Consumes: `vendor/sommelier/sommelier.cc`.
- Produces: a Sommelier with zero `fork()`/`execvp()` references (links against fork-less musl).

- [ ] **Step 1: Write the patch — a `posix_spawn` helper + convert the live sites + `#if 0` Xwayland spawn**

Add `sl_spawn()` mirroring `sl_execvp` (3492) but spawning instead of replacing:

```c
/* wasm/NOMMU: musl has no fork(); spawn via posix_spawn (fork+exec atomically).
 * Mirrors sl_execvp's WAYLAND_SOCKET fd hand-off via posix_spawn_file_actions. */
static pid_t sl_spawn(const char* file, char* const argv[], int wayland_socket_fd) {
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  if (wayland_socket_fd >= 0) {
    /* child sees WAYLAND_SOCKET=<dup'd fd>; keep it open across spawn */
    putenv(sl_xasprintf("WAYLAND_SOCKET=%d", wayland_socket_fd));
    posix_spawn_file_actions_adddup2(&fa, wayland_socket_fd, wayland_socket_fd);
  }
  setenv("SOMMELIER_VERSION", SOMMELIER_VERSION, 1);
  pid_t pid = -1;
  int rv = posix_spawnp(&pid, file, &fa, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  return rv == 0 ? pid : -1;
}
```

Replace each `pid = fork(); errno_assert(pid != -1); if (pid == 0) { … sl_execvp(prog, argv, fd); _exit(…); }` block (single-client 4607; `sl_run_parent` worker 3935 and 3972→4019; runprog 3627) with `pid = sl_spawn(prog, argv, fd);`. For the `sl_run_parent` per-client re-exec (which builds `args` then `execvp(args[0], …)`), spawn those same `args`. Wrap `sl_spawn_xwayland` and its `if (ctx.xwayland) { … }` callers in `#if 0 /* wasm: no Xwayland */ … #endif` (it pulls fork+execvp and is never reached without `-X`).

- [ ] **Step 2: Confirm no fork/execvp remain after patch**

```bash
# Apply against a scratch copy and grep:
grep -nE '\bfork\s*\(|\bexecvp\s*\(' vendor/sommelier/sommelier.cc | grep -v sl_spawn || echo "NONE"
```
Expected: `NONE` (only `posix_spawnp` remains). The link contract (`.#nofork-linkcheck`-style) enforces this at build time too.

- [ ] **Step 3: Commit**

```bash
git add patches/sommelier/0001-posix-spawn.patch
git commit -m "feat(#7): port Sommelier fork()+execvp to posix_spawn (no-fork musl)"
```

### Task 8: `userspace/sommelier.nix` cross derivation

**Files:**
- Create: `userspace/sommelier.nix`
- Modify: `flake.nix` (add `sommelier` attr + `.#sommelier` package)

**Interfaces:**
- Consumes: `cross.{wayland,libxkbcommon,pixman,libffi,libdrm,minigbm}`, `cross.xorg.{libxcb,libXau,libXdmcp}`, native `wayland-protocols`/`wayland-scanner`/`xcb-proto` from `buildPackages`, `patches/sommelier/0001-posix-spawn.patch`, `vendor/sommelier`.
- Produces: `/bin/sommelier` (single static wasm binary).

- [ ] **Step 1: Write the derivation**

Mirror `userspace/wl-eyes.nix` (cross meson build against the wayland stack), adding the full dep list and feature toggles. Apply the spawn patch; pass the cross deps; disable tracing/gamepad/quirks/tests:

```nix
{ cross, wayland, wayland-protocols, libxkbcommon, pixman, libffi
, libdrm, minigbm, libxcb, libXau, libXdmcp, src }:
cross.stdenv.mkDerivation {
  pname = "sommelier-wasm32-nommu";
  version = "virtwl";
  inherit src;
  patches = [ ../patches/sommelier/0001-posix-spawn.patch ];
  nativeBuildInputs = [ cross.buildPackages.meson cross.buildPackages.ninja
                        cross.buildPackages.pkg-config
                        cross.buildPackages.wayland-scanner ];
  buildInputs = [ wayland wayland-protocols libxkbcommon pixman libffi
                  libdrm minigbm libxcb libXau libXdmcp ];
  mesonFlags = [
    "-Dtracing=false" "-Dgamepad=false" "-Dquirks=false" "-Dwith_tests=false"
    # virtwl path only; no commit_loop_fix unless a smoke shows the stall.
  ];
  # The custom dylink/EH link flags + the shared allow-undefined-file come from
  # the cross cc-wrapper (wasm-cross.nix) — same as nix.wasm/wl-eyes. No
  # --fpcast-emu (Sommelier uses no glib/gobject).
  dontStrip = true;
}
```

- [ ] **Step 2: Build gate — observe the real link/compile errors**

```bash
echo <pw> | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#sommelier --print-out-paths 2>&1 | tail -60
```
Expected: a sequence of concrete cross issues to resolve (a missing protocol XML → add to `buildInputs`; a `std::` libc++ feature → already provided; an `env.fork` LinkError → a fork site missed in Task 7; an undefined symbol outside the allow-list → a real missing dep). Fix each with the smallest correct change.

- [ ] **Step 3: Iterate to a clean build; verify the binary**

```bash
OUT=$(echo <pw> | sudo -S nix … build .#sommelier --no-link --print-out-paths)
test -f $OUT/bin/sommelier && echo OK
```

- [ ] **Step 4: Wire into flake `extraBins`** (add `sommelier` to the `initramfs.nix` `extraBins` list at flake.nix:331 and a `sommelier = sommelier;` package attr near `widget-factory`).

- [ ] **Step 5: Commit**

```bash
git add userspace/sommelier.nix flake.nix
git commit -m "feat(#7): cross-build Sommelier (virtwl, wl_shm) -> /bin/sommelier"
```

---

## Phase 4 — Integration & gates

### Task 9: Boot + registry handshake through Sommelier

**Files:**
- Create: `runtime/demo/node/sommelier-smoke.mjs`

**Interfaces:**
- Consumes: `/bin/sommelier`, `/bin/wlhandshake` (stock-libwayland registry client).
- Produces: a node gate asserting a real registry handshake flows guest→Sommelier→host.

- [ ] **Step 1: Write the failing smoke** (adapt `runtime/demo/node/waylandproxyd-spike.mjs`): boot, `export XDG_RUNTIME_DIR=/tmp`, launch `/bin/sommelier --parent &`, wait for its `wayland-0` listen line, run `/bin/wlhandshake`, assert the registry globals round-trip (the existing `wlhandshake` PASS marker) AND the host (JS wl device) logs a SEND.

```js
// sommelier-smoke.mjs — boot busybox guest, run `sommelier --parent`, then the
// stock-libwayland handshake client; PASS = registry handshake through Sommelier.
```

- [ ] **Step 2: Run it — expect FAIL until artifacts include the new initramfs**

```bash
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/sommelier-smoke.mjs; echo EXIT=$?
```

- [ ] **Step 3: Rebuild artifacts, run to PASS**

```bash
echo <pw> | sudo -S nix … build .#wasm-initramfs --print-out-paths
echo <pw> | sudo -S nix … build .#kernel --print-out-paths   # picks up Task 5
# refresh the artifacts dir the smoke points at, then:
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/sommelier-smoke.mjs; echo EXIT=$?
```
Expected: EXIT=0; Sommelier logs the virtwl dmabuf "using virtwl instead" line (confirms Task 5).

- [ ] **Step 4: Commit**

```bash
git add runtime/demo/node/sommelier-smoke.mjs
git commit -m "test(#7): registry handshake through Sommelier (replaces waylandproxyd-spike)"
```

### Task 10: Leak regression — the bug's failing test

**Files:**
- Create: `userspace/wl-pool-churn.c`, `userspace/wl-pool-churn.nix`
- Create: `runtime/demo/node/sommelier-leak-smoke.mjs`
- Modify: `flake.nix` (attr + extraBins)

**Interfaces:**
- Consumes: `cross.wayland` (client) + `/bin/sommelier`.
- Produces: `/bin/wl-pool-churn` — connects to `wayland-0`, creates+destroys N≫16 `wl_shm` pools (each ~4 MB), then prints `RESULT wl-pool-churn PASS pools=N`. The smoke asserts guest `MemFree` stays bounded and a post-churn order-11 allocation still succeeds.

- [ ] **Step 1: Write `wl-pool-churn.c`** — a libwayland-client loop: `wl_shm_create_pool(fd, size)` then `wl_shm_pool_destroy` (and `wl_buffer_destroy`) for N iterations (N=64, size≈4 MB), `wl_display_roundtrip` each iter. Mirror `userspace/wl-anim.c`'s shm setup.

- [ ] **Step 2: Write the smoke** — boot full system, run `sommelier --parent`, capture `cat /proc/meminfo | grep MemFree` before, run `/bin/wl-pool-churn`, capture MemFree after; assert `(before - after) < 64 MB` (i.e. NOT N×8 MB leaked) and no `page allocation failure: order:11` in the kernel log. On **`waylandproxyd`** this assertion fails (leak); on Sommelier it passes.

```js
// sommelier-leak-smoke.mjs — the order-11 fragmentation regression. Churn N shm
// pools through Sommelier; assert guest MemFree bounded + no order-11 failure.
```

- [ ] **Step 3: Build + run to PASS**

```bash
echo <pw> | sudo -S nix … build .#wasm-initramfs --print-out-paths
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/sommelier-leak-smoke.mjs; echo EXIT=$?
```
Expected: EXIT=0; MemFree delta small; no order-11 failure.

- [ ] **Step 4: Commit**

```bash
git add userspace/wl-pool-churn.c userspace/wl-pool-churn.nix flake.nix runtime/demo/node/sommelier-leak-smoke.mjs
git commit -m "test(#7): wl_shm pool-churn leak regression (order-11 fragmentation)"
```

### Task 11: Switch autostart, retire waylandproxyd, document

**Files:**
- Modify: `userspace/init.nix` (the `waylandLine`, ~line 34)
- Modify: `flake.nix` (drop `wasmWaylandProxyd` from `extraBins`; keep the source for one release? — remove per the spec decision after green smokes)
- Delete: `userspace/waylandproxyd.c`, `userspace/waylandproxyd.nix`, `userspace/wlclient.{c,nix}`, `runtime/demo/node/waylandproxyd-spike.mjs` (superseded)
- Create: `docs/superpowers/notes/sommelier-visual.md`
- Modify: `CLAUDE.md`, memory

**Interfaces:**
- Produces: the guest auto-starting Sommelier; `waylandproxyd` gone from tree.

- [ ] **Step 1: Switch the inittab line** in `userspace/init.nix`:

```nix
  waylandLine = "::respawn:/bin/sh -c 'mkdir -p /tmp; [ -e /dev/wl0 ] && XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /bin/sommelier --parent >>/var/log/sommelier.log 2>&1; sleep 5'";
```

- [ ] **Step 2: Rebuild base squashfs (inittab lives in `base.squashfs`) + smokes still green**

```bash
echo <pw> | sudo -S nix … build .#wasm-base-squashfs --print-out-paths
echo <pw> | sudo -S nix … build .#wasm-initramfs --print-out-paths
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/sommelier-smoke.mjs; echo EXIT=$?
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node runtime/demo/node/sommelier-leak-smoke.mjs; echo EXIT=$?
```
Expected: both EXIT=0.

- [ ] **Step 3: Remove `waylandproxyd` + dead test client** from `extraBins`/flake attrs and delete the files (the byte-splice MVP is superseded; its history is in git).

- [ ] **Step 4: Run the four runtime/ CI gates + the wl smokes**

```bash
cd runtime && bun run test && bun run lint && bun run format:check && bun run typecheck
```
Expected: all pass.

- [ ] **Step 5: Write `docs/superpowers/notes/sommelier-visual.md`** — the MANUAL browser check: `gtk3-widget-factory` renders **and survives** (the original crash) via Greenfield; record steps + that `sync-to-pc.sh` is needed if any `runtime/` engine file changed.

- [ ] **Step 6: Update CLAUDE.md** — replace the `waylandproxyd` references with the Sommelier-on-virtwl proxy; add the library-closure entry (libxcb/libdrm/minigbm link-only) and the `NEW_DMABUF→ENOTTY` learning to the hard-won index. Update the `gtk-wayland-render-blocker` memory.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(#7): autostart Sommelier, retire waylandproxyd; docs + CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- Lib closure (wayland/xkbcommon/pixman existing; libxcb/libdrm/minigbm new) → Tasks 1, 3, 4 ✓
- libffi server-dispatch risk B → Task 2 ✓
- Kernel NEW_DMABUF→ENOTTY → Task 5 ✓
- Sommelier source + posix_spawn patch + cross derivation → Tasks 6, 7, 8 ✓
- `--parent`+posix_spawn worker model → Task 7 (spawn helper) + Task 11 (inittab) ✓
- Host transparency (risk C) → Task 9 (registry handshake reaches host) ✓
- Leak fixed by lifecycle → Task 10 (regression) ✓
- Retire waylandproxyd after validation → Task 11 ✓
- Visual gtk3-widget-factory survival → Task 11 Step 5 (manual note) ✓
- Reusable closure exposed as flake attrs → `legacyPackages = cross` (Tasks 1/3/4) ✓

**Placeholder scan:** The cross-derivation flag sets (minigbm, libdrm, libxcb) and the full `wl-server-ffi.c`/`wl-pool-churn.c`/smoke bodies are bring-up-discovered — each task gives the starting derivation/program shape, the exact build/run command, the expected failure, and the *named* fix pattern from the overlay/CLAUDE.md learnings, which is the honest unit of work for Nix cross bring-up (not a deferred placeholder). Sommelier meson flag names (`tracing`/`gamepad`/`quirks`/`with_tests`) are verbatim from `meson_options.txt`.

**Type consistency:** `sl_spawn(file, argv, wayland_socket_fd)` used consistently (Task 7). `cross.minigbm`/`cross.libdrm`/`cross.xorg.libxcb` naming consistent across Tasks 1/3/4/8. `RESULT <prog> PASS` marker convention matches existing smokes.

**Sequencing:** Tasks 1–2 (de-risk) gate 3–11; Task 5 (kernel) must land before Task 9/10 smokes; Task 8 consumes Tasks 1/3/4/6/7; Task 11 last (after both smokes green).
