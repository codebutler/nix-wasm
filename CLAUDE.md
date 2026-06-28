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
  clone-with-fn spawn — NOMMU wasm can't fork/vfork) built via the `cross`
  cc-wrapper; boots through a thin Nix-generated `/init` (`bootstrap.nix`) that
  mounts the squashfs base over a read-only virtio-blk device as the `/nix` overlay
  lowerdir and hands off to busybox-init.
- **Process model** = single shared NOMMU arena + a **`posix_spawn`-only spawn
  contract**; `fork`/`vfork` are **removed at the libc level** (`toolchain/musl.nix`)
  so callers fail to **link** (loud build error) rather than SIGILL/abort at runtime.
  Holdouts are handled by one documented rule (don't-build an unused CLI / port a
  real library to `posix_spawn` / compile out an unused return-twice symbol) — never
  a stub. See **`docs/process-model.md`**. Per-process Memory and real `fork()` are
  *measured* dead-ends (`spikes/elastic-mem/` ~124-Memory/tab cap;
  `spikes/stackswitch/` WasmFX/JSPI one-shot).

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
pointer pc resolves at runtime via `js/packages/linux-channel.js`. The full
end-to-end republish runbook lives in pc's `vendor/linux-wasm/SOURCE.md` §
"Republish the guest". The guest inittab and `/etc` live in `base.squashfs`
(via `userspace/init.nix → toplevel.nix → base-squashfs.nix`), **not** the
initramfs — an `init.nix` change republishes via `.#linux-image`'s squashfs member.

**PR previews:** every same-repo PR gets a browser preview that boots *that PR's*
guest — `.github/workflows/pr-preview.yml` builds the 3 boot artifacts (toolchain
substituted from the `nix-wasm` Cachix cache), content-addresses them into the
`nix-wasm-previews` R2 bucket's `cas/<buildhash>/`, rclone-syncs the `runtime/`
frontend into `pr-<N>/`, and comments `${PREVIEW_BASE_URL}/pr-<N>/demo/web/`. The
served Worker (`infra/preview-worker/`) stamps COOP/COEP. Boot artifacts only —
the guest `nix-cache/` substituter stays #2's concern. Setup runbook:
`infra/preview-worker/README.md`.

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

# #83 follow-up terminal-resize smoke (busybox-only boot): console(0).resize(cols,
# rows) writes the virtio-console F_SIZE config space + raises the device's
# config-change irq; the stock driver hvc_resize()s the tty. PASS = `stty size`
# in-guest reflects the new size. Also wired into nix-wasm.yml boot-smoke (gating).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/resize-smoke.mjs

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
history). The old "hush isn't POSIX-enough" gap is closed.

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

Remaining: **Phase 5** (CI + binary cache — the design goal below: build on
x86_64, publish the wasm outputs, guest substitutes; issue #2).
In-guest installs work like a real NixOS system via BOTH `nix-env -iA` and
`nix profile install` (codebutler/nix-wasm#1), and crucially the two CLIs take
DIFFERENT paths through Nix. (1) `substitute = true` in the guest nix.conf
(`system.nix`): the NEW CLI (`nix profile`/`nix build`) probes for Internet and,
finding none, sets `useSubstitutes = false` UNLESS overridden — silently disabling
substitution even for our `file:///nix-cache`. Marking it overridden leaves it on.
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
below.) Archive ops work: `tar` (czf/xzf,
patched) is
validated; `wget` is N/A on the
guest (no network — package sources arrive via the 9P-mounted Nix binary cache, not
internet fetch), so the disabled network/service vfork applets aren't needed.

## Caching (design goal)

The **host** must build from cache, not from source: pin a fully-cached nixpkgs
(`nixos-26.05`), build/CI on `x86_64-linux` (aarch64's cache lags → from-source
LLVM), and publish the wasm outputs (`cross.*`, `nix.wasm`, user packages) to a
binary cache. The **guest** then *substitutes* pre-built wasm artifacts rather
than building in-guest — that's the "install any package" model and what makes
the crossSystem approach scale. From-source host rebuilds are a failure mode to
design out (see the Environment notes under Hard-won learnings).

**Two-tier cache wiring (#2, Phase 5):** the **host build cache is Cachix**
(`nix-wasm.cachix.org`, public read; signing key
`nix-wasm.cachix.org-1:UlXbCihIfmQnzcyTQuRutvD0IPVVoHHAoIamxBJZUb0=`); the
**guest-facing cache is R2** (`nix-cache/` tree, served by `runtime/nix-cache.js`).
CI runs on **x86_64-linux** (the flake is now parameterized over build hosts —
`packagesFor system` + `genAttrs ["x86_64-linux" "aarch64-linux"]`, with
`localSystem` threaded into `wasm-cross.nix`; `nix build .#X` picks the runner's
system). Three workflows:
- `.github/workflows/nix-wasm.yml` — builds the wasm world from source on a
  build-input/patch change and pushes to Cachix. The two from-source LLVM poles
  (`guest-clang`, `kernel`) build on their own runners in a matrix (each under the
  6h job limit, both in parallel), then the cheaper `artifacts` job
  (`nix-wasm`/`wasm-binary-cache`/`wasm-base-squashfs`) **substitutes** them from
  Cachix. Cold cache pays the LLVM rebuild once; warm reruns are minutes.
  Content-addressed — a `flake.lock`/`patches/` change self-invalidates (no
  manual cache key). The `artifacts` job also builds `wasm-initramfs` + the full
  `linux-image` boot bundle (wl-eyes is vendored in-repo — #62/#63 — so the whole
  guest is reproducible from a fresh checkout).
- `.github/workflows/publish-wasm-artifacts.yml` — on master, substitutes the
  closure from Cachix and uploads `base.squashfs` + the `nix-cache/` tree to R2
  (`scripts/publish-to-r2.sh`).
- `.github/workflows/runtime-gates.yml` — runtime/ engine `test` + `typecheck`
  (the two gates green on a clean checkout). `lint`/`format:check` are red on
  pre-existing debt (no committed oxfmt/oxlint config) and deliberately unwired.

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
  `--import-memory`/`--import-table`, NOT this list. (Editing the list rebuilds only
  guest-clang + nix.wasm; the cross.* set is keyed on the byte-identical store path so
  it stays cached.)
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
  `VW_DEV_VSOCK = 7` BEFORE them (index 6 unused). So the assertion now enforces the
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

(The executed per-task plans — toolchain, userspace, kernel-nixify, guest-shell
forkshell-ash — the rationale/master-plan docs, and the detailed STATUS log were
removed once done; the code, this file, and git history are the record.)
