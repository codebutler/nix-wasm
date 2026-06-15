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
  over the nix-built sysroot. No joelseverin/llvm fork — the wasm-EH patch is
  upstream in LLVM ≥19; the toolchain is stock-21 throughout.
- **Deps** = nixpkgs packages via `cross.*`, with cross-wasm fixes in
  `deps-overlay.nix` (all wasm-guarded so native packages stay stock/cached).
- **`nix.wasm`** = `nix-wasm.nix`: meson compiles Nix's C++ with clang-21 against
  the nix-built libc++ + the `cross.*` deps, then a custom `.o` link (meson's
  `-r` prelink can't emit wasm TLS relocs — a real wasm limit, not a shortcut).

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

## Current blocker + strategy

The dep closure (`cross.curl`/`libgit2`/`boost` and their transitive tree) is
where nixpkgs' cross machinery fights the wasm target. **The fix is always a
shared crossSystem/overlay fix, never a package-private workaround.** Known gaps,
several already fixed (see STATUS for the full list):

- ✅ shared-lib general-dynamic TLS (`__musl_tp`) → build deps static-only
- ✅ overlay leaking to `buildPackages` (native rebuild cascade) → guard with `isWasm`
- ✅ nixpkgs cross compiler-rt built with the rejected triple → override to `wasm32-unknown-unknown`
- 🔧 cross stdenv pulls **stock** Linux kernel headers (no wasm arch) → override `linuxHeaders` to ours (in `deps-overlay.nix`, just added, untested)
- ⬜ `runtimeShell` leak (a wasm `bash` gets built) → point at native shell
- ⬜ per-dep feature trims / inline-asm (curl http3 done; openssl asm, etc.)

After the closure builds: `nix build .#nix-wasm` → deploy → verify in-guest
(no SIGILL, `nix-env -iA sl`). Then phases 2–5 (`docs/plan-environment.md`).

## Plans

- `docs/plan-toolchain.md` — the 13-task toolchain+nix.wasm plan.
- `docs/plan-environment.md` — the 5-phase master plan (toolchain → userspace →
  guest-clang → kernel → CI) for the full "NixOS in wasm" vision.
- `docs/plan-rationale.md` — why this replaced the shell-script approach.
