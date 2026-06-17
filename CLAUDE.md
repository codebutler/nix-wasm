# CLAUDE.md — nix-wasm

Build `nix.wasm` (Nix for the `wasm32-linux-musl` NOMMU guest) and its toolchain,
**entirely through Nix**. This file is the operating guide. Read `docs/STATUS.md`
for the current state before doing anything.

## PRIME DIRECTIVE (non-negotiable)

**DO THINGS CORRECTLY. No shortcuts. No hacks. No stubs.** Every artifact is a
reproducible Nix derivation. The hand-written shell scripts and fake-lib stubs in
`legacy/` are the OLD approach being replaced — they exist only as reference.

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
  overlays the served `/nix` closure and hands off to busybox-init.

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

## Current state

**It works end-to-end** (2026-06-17). `nix build .#nix-wasm` builds the wasm Nix;
the dep closure (`cross.*`), the kernel, and the curated guest userspace all build
reproducibly. In the pc harness (`scripts/linux-demo/exec-nixsystem.mjs`) the
Nix-built userspace boots — served-closure `/nix` overlay → busybox-init → getty →
autologin → root shell — and **`nix-env -iA sl` substitutes `sl` from the binary
cache and renders it** (Phase A + B both PASS). Every wasm fix is a SHARED
crossSystem/overlay or kernel-source fix, never a package-private workaround (PRIME
DIRECTIVE corollary 1).

Remaining (see `docs/plan-environment.md`): **Phase 5** (CI + binary cache — the
design goal below: build on x86_64, publish the wasm outputs, guest substitutes)
and **Phase 3** (nixify the guest `clang.wasm`/`wasm-ld.wasm` so the guest can
*compile*, not just install). Robustness long-tail: the remaining busybox vfork
applets (`tar`/`wget`/…) need the same clone-with-fn treatment as the spawn patch.

## Caching (design goal)

The **host** must build from cache, not from source: pin a fully-cached nixpkgs
(`nixos-26.05`), build/CI on `x86_64-linux` (aarch64's cache lags → from-source
LLVM), and publish the wasm outputs (`cross.*`, `nix.wasm`, user packages) to a
binary cache. The **guest** then *substitutes* pre-built wasm artifacts rather
than building in-guest — that's the "install any package" model and what makes
the crossSystem approach scale. From-source host rebuilds are a failure mode to
design out. Full detail: `docs/STATUS.md` § Caching strategy.

## Plans

- `docs/plan-environment.md` — the 5-phase master plan (toolchain → userspace →
  guest-clang → kernel → CI) for the full "NixOS in wasm" vision. Phases 1, 2, 4
  are done; 3 and 5 remain.
- `docs/plan-rationale.md` — why this replaced the shell-script approach.

(The per-task implementation plans — Phase-1 toolchain, the userspace Plans 1/2,
the kernel-nixify plan — were executed and removed; the code + `STATUS.md` are the
record. They live in git history if needed.)
