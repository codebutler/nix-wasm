# Fully Reproducible wasm32 Environment, Built With Nix — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement each phase task-by-task. This master plan maps ALL phases; Phase 1 is fully task-decomposed in its own plan (linked), Phases 2–5 are specified at design depth with exact recipes, derivation sketches, validation, and risks — each gets its own task-decomposed plan when started.

**Goal:** The ENTIRE pc-linux guest environment — the kernel (`vmlinux.wasm`), the base userspace (`initramfs.cpio.gz`), the in-guest compiler (`clang.wasm`/`wasm-ld.wasm`), and Nix itself (`nix.wasm`) — built reproducibly **from source by Nix**, with a CI job that builds the whole thing from scratch. End state: `nix build` produces every vendored `vendor/linux-wasm/*` artifact; no hand-rolled shell-script build path, no opaque pinned LLVM fork, no cached-toolchain dependency.

**Architecture:** One nixpkgs pin providing `llvmPackages_21`. A single unifying toolchain decision (below) replaces the joelseverin/llvm fork with **stock LLVM 21 + one explicit carried patch**. Five phases, each a set of idiomatic Nix derivations, every artifact validated against the known-good linux-wasm output in `~/lwbuild/ws/install` (functional + symbol-set, not byte-exact). A final CI phase runs `nix build` for all of it.

**Tech Stack:** Nix flakes, nixpkgs crossSystem + `replaceCrossStdenv`, **stock LLVM 21** (clang/lld/compiler-rt/libcxx) + a carried `wasm-ld` linker-script patch, musl 1.2.5, the out-of-tree `joelseverin/linux` wasm arch (kernel) + `joelseverin/llvm` *runtime sources only via nixpkgs*, CMake/Ninja, Meson, GitHub Actions.

---

## NON-NEGOTIABLE DIRECTIVE (applies to every phase)

**Everything is built by Nix, from source, reproducibly. No hand-rolled build
scripts. No hacks. No stubs. No opaque fork as a build input. No deferring the
hard parts.** Shell is allowed ONLY inside a derivation's phases. The known-good
`~/lwbuild` artifacts are a read-only validation oracle, never a build input. The
end state is the WHOLE environment reproducible from `nix build` + a CI that
builds it from scratch — not a tractable slice with the kernel/guest-clang left
on the old path. If a step tempts you toward a script, a stub, a cached-binary
input, or "do this part later," STOP — that is the anti-pattern this plan exists
to remove.

---

## Unifying decision: stock LLVM 21 + ONE carried patch (eliminate the fork)

The current toolchain pins **github.com/joelseverin/llvm @ wasm-18.1.2**
(`30dfc8fca8`), restored from a cached ~2.5h build asset — an opaque,
non-from-source dependency. Investigation (this session) shows the fork is **9
commits** over `llvmorg-18.1.2`, and almost all are already upstream in LLVM 21:

| Fork change | Subsystem | Upstream in LLVM 21? |
|---|---|---|
| `__cxa_init_primary_exception` wasm-EH dtor signature | libcxx/libcxxabi | ✅ since LLVM 19 (`#ifdef __wasm__`) — VERIFIED |
| 6× WasmAsmParser directives (`.section`/`.pushsection`/…) | MC/asm | ✅ upstream — VERIFIED |
| WasmObjectWriter fix (`6a7f2061`) | MC/object | ✅ upstream — VERIFIED |
| Weak-function prototype mismatch (`30dfc8fc`) | lld/wasm | ⚠️ UNKNOWN — verify on `release/21.x` |
| **GNU linker-script support in `wasm-ld`** (`fbabc9de`, ~1700 LOC, new `ScriptLexer`/`ScriptParser`) | lld/wasm | ❌ FORK-ONLY — **must carry** |

**Strategy:**
- **Plain `llvmPackages_21`** (stock nixpkgs) for the HOST compiler and for
  Phase 1 (musl, libcxx, compiler-rt, C deps, nix.wasm) — no linker script is
  used there; already proven (`cross.zlib` builds, libcxx is upstream-clean).
- **`llvm21-wasm`** = `llvmPackages_21` **+ the rebased `fbabc9de` linker-script
  patch** (+ `30dfc8fc` if the verify shows it's not upstream) — used ONLY by
  guest-clang (Phase 3) and the kernel (Phase 4), which link through GNU linker
  scripts (`vmlinux.lds`). Carry the patch with a header documenting it as a
  to-be-upstreamed delta; the rebase risk is LOW (it adds new files, no
  conflicts). File an LLVM upstreaming issue so the carried patch is temporary.
- **No joelseverin/llvm fork as a build input anywhere.** Runtime *sources*
  (libcxx, compiler-rt) come from nixpkgs' LLVM-21; the wasm Linux *arch* (an
  out-of-tree kernel arch, genuinely not upstreamable to Linux) comes from
  `joelseverin/linux` pinned by commit — that is source, not a binary toolchain.

**Open verify items (resolve during Phase 3/4, not assumed):**
1. Is `30dfc8fc` (weak-proto) in `release/21.x`? If not, add to `llvm21-wasm`.
2. Does guest-clang's own link actually require the linker-script patch, or only
   the kernel? (The kernel definitely does — `vmlinux.lds`. Guest-clang's cmake
   recipe shows no `-T` script; build it on plain 21 first, fall back to
   `llvm21-wasm` only if its link needs a script.)

---

## Phase 1 — `nix.wasm` + wasm toolchain + C dep closure

**Status:** fully task-decomposed in `docs/superpowers/plans/2026-06-15-nix-wasm-toolchain.md` (13 tasks).

**Delivers (all via Nix, plain `llvmPackages_21`):** musl 1.2.5 (+7 patches),
kernel UAPI headers, compiler-rt builtins, libc++/libc++abi/libunwind, the
crossSystem cc-wrapper (clang-21 + flag-filter `wasm-ld`), the C dep closure
(`cross.*`), and `nix.wasm` (Nix 2.34.7). Deletes `build-sysroot.sh`,
`build-nix-wasm.sh`, `misc-stubs.c`, `git2-stubs.c`.

**Validated:** symbol-set diffs vs `~/lwbuild` per stage; in-guest `nix --version`
no-SIGILL; `nix-env -iA sl` installs by name.

> This phase establishes `flake.nix` + the `toolchain/` derivations that Phases
> 2–4 reuse (musl, kernel-headers, sysroot, the cc-wrapper, and the `llvm21-wasm`
> overlay are all defined here or alongside).

---

## Phase 2 — Userspace via Nix → `initramfs.cpio.gz`

**Goal:** the base userspace (PID 1 + shell + coreutils) built entirely by Nix,
producing the shipped `vendor/linux-wasm/initramfs.cpio.gz`. This is the "entire
userspace created by Nix" milestone.

**Files (new):**
- `nixbuild/userspace/busybox.nix` — evolve `~/nix-spike/busybox-wasm.nix`: nixpkgs
  busybox 1.36.1 cross-built through the Phase-1 cc-wrapper, with the linux-wasm
  busybox patches (`0001` harness wasm port from `vendor/linux-wasm/.build`, `0002`
  hush cmdsub→clone) and the signal-export LDFLAGS
  (`-Wl,--export=__libc_handle_signal -Wl,--export=__set_tls_base`).
- `nixbuild/userspace/initramfs.nix` — assemble musl (Phase 1) runtime bits +
  busybox + `pc-init` (the `/init` that mounts pc's VFS over 9P) into a cpio.gz,
  using `pkgs.cpio` + `gzip` in a derivation. Mirror the upstream harness's
  `build-initramfs` layout (the `/bin`, `/sbin` busybox symlinks, inittab,
  `/init`).
- Reuse `vendor/linux-wasm/pc-init` as the init source (already in repo).

**Recipe specifics (from `build.sh:314-372` + the upstream harness):**
- busybox `make ARCH=wasm wasm_defconfig` then build through the cc-wrapper
  toolchain (clang→cc-wrapper, `ld.lld`→wasm-ld wrapper, `llvm-*` native).
- initramfs: busybox `--install -s`, `/bin/{sh,login}`, `/sbin/{init,getty,
  syslogd}` symlinks, `/init` = `pc-init`, then `find . | cpio -o -H newc | gzip`.

**Validation:** boot the nix-built `initramfs.cpio.gz` in the Linux app
(`scripts/linux-demo/smoke.mjs`): reaches a shell prompt as PID 1, `ls`/mount/
read/write over 9P all pass. The busybox `setup_heredoc` double-vfork gap
(existing task #10) is tracked separately and not a Phase-2 blocker.

**Risk:** the upstream harness `0001` busybox patch lives under
`vendor/linux-wasm/.build/` (a build artifact dir) — vendor it into
`nixbuild/patches/busybox/` so the derivation doesn't depend on a transient path.

---

## Phase 3 — Guest compiler `clang.wasm` / `wasm-ld.wasm` via Nix

**Goal:** the in-guest clang+lld (cross-compiled to wasm32) built by Nix from
stock LLVM-21 source, producing `vendor/linux-wasm/clang.wasm` + `wasm-ld.wasm`.

**Files (new):**
- `nixbuild/guest-clang.nix` — `stdenv.mkDerivation` building LLVM `clang`+`lld`
  cross-compiled to `wasm32-unknown-unknown`, src = `llvmPackages_21` monorepo
  (use `llvm21-wasm` source iff the link needs the linker-script patch — verify),
  host compiler = the Phase-1 cc-wrapper, runtime = the Phase-1 libcxx.

**Recipe (exact, from `build.sh:602-668`):**
- FLAGS: `-fPIC --sysroot=${sysroot} -isystem ${kernelHeaders}/include -D__linux__
  -D__unix__ -D__unix -matomics -mbulk-memory -fwasm-exceptions
  -D__USING_WASM_EXCEPTIONS__ -fvisibility=hidden -fvisibility-inlines-hidden
  -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS`;
  CXX adds `-nostdinc++ -isystem ${libcxx}/include/c++/v1`.
- Link: `-nostdlib++ -L${libcxx}/lib -lc++ -lc++abi -lunwind -Wl,-shared
  -Wl,-Bsymbolic -Wl,--no-entry -Wl,--export=_start
  -Wl,--export-if-defined={__wasm_apply_data_relocs,__wasm_call_ctors,
  __set_tls_base,__libc_clone_callback,__libc_handle_signal} -Wl,--strip-all
  -Wl,--import-memory -Wl,--shared-memory -Wl,--max-memory=4294967296
  -Wl,--import-table -Wl,--no-merge-data-segments
  -Wl,--allow-undefined-file=<allow.txt>` where allow.txt = `__wasm_abort
  __cpp_exception logAPIs __wasm_syscall_0..6`.
- cmake: `-DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_ENABLE_PROJECTS="clang;lld"
  -DLLVM_HOST_TRIPLE=wasm32-unknown-linux-musl
  -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown -DLLVM_ENABLE_THREADS=OFF
  -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DCMAKE_SKIP_INSTALL_RPATH=ON` + the full `-DLLVM_ENABLE_{ZLIB,ZSTD,LIBXML2,
  TERMINFO,LIBEDIT,PLUGINS,BINDINGS,BACKTRACES,CRASH_OVERRIDES}=OFF` /
  `-DLLVM_INCLUDE_{EXAMPLES,TESTS,BENCHMARKS,DOCS}=OFF` /
  `-DCLANG_ENABLE_{ARCMT,STATIC_ANALYZER}=OFF` set. Build targets `clang lld`;
  install `clang-21`→`clang.wasm`, `lld`→`wasm-ld.wasm`, `lib/clang` resource dir.

**Validation:** in-guest `clang` compiles + links a hello world (the #139 Gate 0.3
in-guest-compile probe — `exec-clang.mjs`/`exec-cc.mjs`), and `nix.wasm`'s own
in-guest `nix build` of a C package works end-to-end.

**Risk:** this is a large LLVM cross-build (long, but reproducible + nix-cached).
The Nix store cache (Phase 5) keeps CI from paying it every run. The `fake-llvm`
Python wrapper (`vendor/linux-wasm/tools/fake-llvm/`) is version-agnostic (it
rewrites wasm flags + delegates to stock LLVM) — Phase 3 doesn't need it (the
derivation passes flags directly); Phase 4 may reuse its flag-rewriting as a
small Nix-wrapped script or inline the flags into the kernel Makefile vars.

---

## Phase 4 — Kernel `vmlinux.wasm` via Nix

**Goal:** the wasm Linux kernel built by Nix from pinned source + pc's patches,
producing `vendor/linux-wasm/vmlinux.wasm`. Uses `llvm21-wasm` (the linker-script
patch is REQUIRED here — `vmlinux.lds`).

**Files (new):**
- `nixbuild/kernel.nix` — `stdenv.mkDerivation`, src = `joelseverin/linux` @
  `039e5f3e583f56f329657d1fe9945510dba10f41` (branch `wasm-7.0`), patches = pc's
  11 kernel patches (`vendor/linux-wasm/patches/[0-9]*.patch` — 9P `trans_cb`, hvc
  multi-console, hvc winsize, single-CPU pin, 16K→64K stacks, 128MB buddy order),
  toolchain = `llvm21-wasm`.
- Vendor the 11 kernel patches into `nixbuild/patches/kernel/` (apply
  all-or-nothing — they overlap in `hvc_wasm.c`, per `.claude/rules/linux-build.md`).

**Recipe (from `build.sh:256-295`):**
- `make ARCH=wasm LLVM=<nix-llvm-wrapper>/ CROSS_COMPILE=wasm32-unknown-unknown-
  HOSTCC=${pkgs.gcc}/bin/gcc ${VARIANT}_defconfig` → `scripts/config` enables
  `CONFIG_NET CONFIG_NET_9P CONFIG_NET_9P_CB CONFIG_9P_FS CONFIG_DEVTMPFS
  CONFIG_DEVTMPFS_MOUNT CONFIG_FILE_LOCKING CONFIG_SCHED_STACK_END_CHECK` and
  `--set-val CONFIG_ARCH_FORCE_MAX_ORDER 15` → `olddefconfig` → `make … vmlinux`.
- The kernel's `LLVM=` wrapper: replace the `tools/fake-llvm` Python rig with a
  small Nix `runCommand` that exposes `clang`/`ld.lld`/`llvm-*` symlinks onto
  `llvm21-wasm` + the cc-wrapper flags (the kbuild `LLVM=<dir>/` convention), OR
  pass `REAL_LLVM=` + the flag set directly. The wrapper only rewrites wasm flags;
  it is version-agnostic.
- Output: `cp $KBUILD/vmlinux vmlinux.wasm`.

**Validation:** the nix-built `vmlinux.wasm` boots in the Linux app
(`scripts/linux-demo/smoke.mjs` / `probe.mjs`): kernel comes up, mounts 9P, runs
the Phase-2 userspace. Compare boot log + a checksum-of-behavior against the
current vendored kernel.

**Risk:** (1) the `30dfc8fc`/linker-script patches must land cleanly on LLVM 21 —
verify early (Phase-3 builds the same LLVM). (2) kernel `ARCH=wasm` may surface a
build issue under LLVM 21 codegen that the fork's LLVM 18 masked — this is the
genuine research risk; mitigate by diffing the produced `vmlinux.wasm` behavior
against known-good and bisecting any boot regression to a specific config/patch.

---

## Phase 5 — CI: `nix build` the whole environment from scratch

**Goal:** a GitHub Actions workflow that builds EVERY artifact via `nix build`
from source and commits them — replacing the fragile cached-LLVM-toolchain CI
(`linux-wasm-*.yml`) that the user reports is "NOT working." This is what makes
"reproducible from scratch" real and testable.

**Files (new):**
- `.github/workflows/nix-wasm.yml` — on `claude/**` push touching
  `scripts/linux-demo/nixbuild/**` or a `.rebuild-request`: install Nix
  (`DeterminateSystems/nix-installer-action` or `cachix/install-nix-action`,
  pinned), restore/save the **Nix store** cache (GHA cache or Cachix — this caches
  the heavy LLVM/guest-clang builds so reruns are minutes, while staying
  from-source-reproducible: a cold cache rebuilds everything), run
  `nix build .#{nix-wasm,initramfs,guest-clang,kernel}`, copy outputs into
  `vendor/linux-wasm/`, and commit them back to the branch. Share the
  `gh-pages-writes`-style concurrency discipline from existing workflows.

**Recipe specifics:**
- Use the same `claude/**` push-trigger + commit-back pattern as
  `.github/workflows/linux-wasm-kernel.yml` (the sanctioned token-less rebuild
  path; the GitHub MCP can't dispatch workflows from a session — push triggers
  only).
- Pin all actions to version tags (repo convention).
- Cache key = the flake.lock hash + the patches dir hash, so a toolchain/patch
  change self-invalidates and rebuilds.

**Validation:** a cold-cache CI run produces byte-stable (per the flake's
fixed-output inputs) `vendor/linux-wasm/*` artifacts; a warm-cache run is fast;
the committed artifacts boot in the Linux app via the existing harnesses.

**Risk:** cold-cache CI runtime (the LLVM + guest-clang builds). Mitigate with the
Nix store cache; document that a `flake.lock`/patch bump pays the full rebuild
once, then caches. This is strictly better than the current opaque
toolchain-asset restore.

---

## Cross-cutting

- **Validation oracle:** `~/lwbuild/ws/install` (known-good musl/cxx/headers) +
  the current vendored `vmlinux.wasm`/`initramfs.cpio.gz`/`clang.wasm` are the
  read-only comparison targets. Validation is functional (boots + runs) + symbol
  diffs, NOT byte-exact (clang-21 vs the clang-18-fork won't match bytes).
- **Provenance:** update `vendor/linux-wasm/SOURCE.md` + `docs/linux.md` as each
  phase lands (artifact now nix-built; per-stage source pins; the carried lld
  patch + its upstreaming issue link).
- **Build environment:** Nix runs as root here (daemon socket root-owned) — every
  `nix`/`nix-build` is `sudo` (`echo password | sudo -S …`), flakes enabled via
  `NIX_CONFIG`.
- **Sequencing (build order, NOT priority — all phases ship):** Phase 1 lays the
  flake + shared toolchain. Phases 2/3/4 each consume it; the shared `llvm21-wasm`
  overlay (Phase-3/4 LLVM + linker-script patch) is the one cross-phase artifact —
  define it once. Phase 5 (CI) lands after 1–4 build locally, then runs them from
  scratch. No phase is optional; the deliverable is all five.

## Self-review

- **Vision coverage:** kernel (P4), userspace (P2), guest-clang (P3), nix.wasm
  (P1), CI-from-scratch (P5) — all mapped. The "fully reproducible environment"
  question is answered: YES at end state, via stock LLVM-21 + 1 carried patch, no
  fork, no cached-toolchain input.
- **Fork elimination:** verified 9-commit fork; 1 carried patch (lld linker
  scripts) + 1 verify item (`30dfc8fc`); everything else upstream in 21.
- **No shortcuts:** no phase deferred or stubbed; the directive bans the
  defer-the-hard-part pattern explicitly.
- **Open research (flagged, not hidden):** kernel `ARCH=wasm` under LLVM-21
  codegen (P4 risk); whether guest-clang needs the linker-script patch (P3 verify).
  These are real unknowns to resolve by building + validating, not assumptions.
