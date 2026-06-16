# STATUS — nix-wasm

Detailed progress log. Last updated **2026-06-15**.

Goal: build `nix.wasm` (Nix for the wasm32-linux-musl NOMMU guest) and its
toolchain entirely through Nix, as the keystone for "the pc-linux userspace is
created by Nix." The known-good reference is the old shell-script build
(`legacy/`), which produces a working `nix.wasm` via hand-built minimal libs.

---

## ✅ What works (built & committed)

### The wasm toolchain — done, validated against the known-good `~/lwbuild` oracle

All built as focused Nix derivations from **stock LLVM-21** (no joelseverin/llvm
fork — the wasm-EH patch it carried is upstream in LLVM ≥19, verified):

| Stage | Derivation | Validation |
|---|---|---|
| musl 1.2.5 (+8 patches) | `toolchain/musl.nix` | 3695 vs 3694 libc symbols; all crt + wasm-port symbols present |
| compiler-rt builtins | `toolchain/compiler-rt.nix` | core builtins (`__multi3`, …) present, none missing |
| kernel UAPI headers | `toolchain/kernel-headers.nix` | exact 1002-header match |
| libc++/libc++abi/libunwind | `toolchain/libcxx.nix` | 3 archives, `_Unwind_*` + `__cxa_throw` present, **no fork/patch** |
| sysroot (musl+headers) | `toolchain/sysroot.nix` | crt + libc + headers in one tree |

### The crossSystem cc-wrapper — works

`wasm-cross.nix`: clang-21 + a **flag-filtering `wasm-ld`** (drops ELF-only
linker flags wasm-ld rejects, wired via `clang -B$out/bin`) over the nix-built
sysroot. Proven by `cross.zlib` cross-compiling to a real wasm `libz.a`.

### Root-cause fixes (each shared across all packages)

- **crt `int main` handling** (`musl.nix` postPatch): clang lowers
  `int main(int,char**)`→`__main_argc_argv` but `int main(void)`→a 2-arg `main`
  that signature-mismatched the harness's 3-arg crt wrapper → autoconf's "C
  compiler cannot create executables" aborted, blocking *every* autoconf dep.
  Fix: weak 2-arg crt `main` wrapper + musl calls it 2-arg → all three `main`
  forms link. **High-leverage** (unblocked the autoconf ecosystem).
- **wasm reactor crt** (`musl.nix`): packages that build a `.so` make clang demand
  `crt1-reactor.o`; provide a minimal one.
- **static-only deps** (`deps-overlay.nix`): a package linking its CLI against its
  own wasm `.so` hits general-dynamic TLS → trips wasm-ld on musl's `__musl_tp`.
  Disable shared per build-system (`--disable-shared` / `-DBUILD_SHARED_LIBS=OFF`
  / `enableShared=false`). We only need the `.a`.
- **compiler-rt triple override** (`deps-overlay.nix`): nixpkgs builds the cross
  compiler-rt with `-DCMAKE_C_COMPILER_TARGET=wasm32-unknown-linux-musl`, which
  clang rejects; force `wasm32-unknown-unknown` + drop ELF crt symlinks.
- **overlay scoping** (`deps-overlay.nix`): the overlay applies to `buildPackages`
  too; overriding native `zlib`/`openssl` made the whole native toolchain
  (coreutils, python) rebuild from source. Guard every override with
  `prev.stdenv.hostPlatform.isWasm`.

---

## ✅ The C dependency closure — all 13 cross-compile

`nix build .#dep-{bzip2,xz,sqlite,openssl,curl,libgit2,brotli,libarchive,
editline,libsodium,boost,nlohmann_json,libblake3}` all build. The fixes (all
shared crossSystem/overlay, so they serve user packages too):

- **musl = OUR musl** (`deps-overlay.nix`): nixpkgs' cross musl is built during
  the libc bootstrap by the default cc-wrapper, which embeds an `llvmPackages`
  compiler-rt compiled with the rejected `wasm32-unknown-linux-musl` triple — a
  stage **neither `overlays` nor `crossOverlays` reach**, so it can't be fixed in
  place and fails, cascading to everything (pulled transitively via `libiconv`).
  Overriding `musl` to wrap our own nix-built musl eliminates that bad bootstrap
  compiler-rt entirely. (This *replaced* the earlier `linuxHeaders`-override idea,
  which didn't address the bootstrap.)
- **compiler-rt triple** for the *deps* that link it (curl/libarchive/boost):
  override `llvmPackages_21.compiler-rt` via `overrideScope` (the top-level
  `compiler-rt` attr doesn't exist here — the old override was dead code).
- **bintools ar/ranlib** (`wasm-cross.nix`): the wrapper only symlinked
  target-prefixed tools, but stock LLVM ships them unprefixed → empty
  `$AR`/`$RANLIB`. Add the prefixed symlinks (+ a working strip).
- **libc++ wiring** (`wasm-cross.nix`): thread our libcxx into the cc-wrapper so
  cross C++ (boost; cmake's CXX probe in C deps) resolves `-lc++`.
- **wasm-ld flag filter**: also drop `--compress-debug-sections` (was silently
  failing every sqlite autosetup link probe → bogus "Cannot find libm").
- **runtimeShell → native** (bash/gnugrep): helper scripts no longer drag in a
  cross-built bash/grep that fails and the guest doesn't need at build time.
- **static everywhere = a PLATFORM flag** (`wasm-cross.nix`): `crossSystem` sets
  `isStatic = true` (+ `hasSharedLibraries = true` forced back on, so
  `extensions.sharedLibrary` stays defined → no sqlite eval-abort). nixpkgs then
  applies `makeStatic` (--disable-shared / -DBUILD_SHARED_LIBS=OFF /
  -Ddefault_library=static everywhere) AND packages read `hostPlatform.isStatic`
  for their own static logic (zlib `shared=!isStatic`, openssl `static`, sqlite
  `--disable-tcl`, zstd `static`, llhttp `LLHTTP_BUILD_*_LIBS`, …). The
  `__musl_tp` TLS reloc *only* trips when linking a separate `.so` (cross-module
  GD-TLS); fully-static links — incl. stdio — are fine (same model as
  `nix.wasm`), and `makeStatic`'s `-static` is a harmless no-op on wasm (our
  modules are `-shared` dylink). This REPLACED the whole per-dep static layer in
  `deps-overlay.nix`; what's left there is genuinely non-static, package-specific
  cross fixes (openssl `-U_GNU_SOURCE`, boost b2 `architecture=wasm`, curl/libgit2
  feature trims, libarchive acl, zlib errno) + the platform plumbing.
- **libc++abi self-contained unwinder** (`toolchain/libcxx.nix`): libc++abi's
  wasm-EH `cxa_exception` calls `_Unwind_RaiseException`/`_Unwind_DeleteException`
  (defined in our `Unwind-wasm.c` shim). nix.wasm's hand-link adds `-lunwind`,
  but cc-wrapper consumers can't reliably inject it after clang's auto `-lc++abi`.
  Fold `Unwind-wasm.o` INTO `libc++abi.a` so it resolves internally — every
  C++-exception package is now self-contained.

## ✅ `nix.wasm` — builds

`nix build .#nix-wasm` → `$out/bin/nix`, a **19 MB wasm dylink module** (38860
functions, 53 host imports, START + EXPORT sections — complete Nix 2.34.7).
`nix-wasm.nix` fixes: `dontUseMesonConfigure` (the meson hook ran a native
configure first), `pkgPath` += `share/pkgconfig` (nlohmann_json), `bison`+`flex`
in `nativeBuildInputs` (libexpr), and a `-resource-dir` so raw clang finds our
wasm builtins at the final link.

## ✅ Arbitrary nixpkgs packages — many build with ZERO overlay entry

Because every wasm fix is now platform-level (toolchain + `isStatic` + the
unwinder/runtimeShell/musl/compiler-rt plumbing), nixpkgs packages cross-compile
just by being in `cross.*` — no `deps-overlay.nix` entry. Proven:

- `cross.hello` → a wasm module, untouched.
- `cross.sl` (the train) → builds untouched, pulling `cross.ncurses` (whose C++
  binding drove the libc++abi unwinder fix above).

This is the intended "install any package in the guest" model (PRIME DIRECTIVE
corollary 1): a snag becomes one *shared* toolchain/overlay fix, not a per-package
patch. Complex packages can still need fixes (their own `.so`-linked CLIs that we
keep static, x86/arm inline asm, hard platform assumptions), but the floor is now
"try it, frequently works."

---

## ⬜ What's next

1. **In-guest verification**: deploy `nix.wasm` and run `nix --version` (no
   SIGILL), then `nix-env -iA sl`. Needs the pc harnesses `exec-nix.mjs` /
   `exec-nixenv.mjs` (not in this repo).
2. Phases 2–5 (`docs/plan-environment.md`): userspace, guest-clang, kernel, CI —
   the full "NixOS in wasm" vision.

---

## ❌ What didn't work (dead-ends — don't repeat)

- **`crossSystem.hasSharedLibraries = false`** — too aggressive: makes
  `stdenv.hostPlatform.extensions.sharedLibrary` missing, which sqlite reads
  unconditionally → eval abort. Use per-dep static flags instead.
- **`stdenvAdapters.makeStaticLibraries`** — doesn't compose with our custom
  `replaceCrossStdenv` (`dontAddStaticConfigureFlags` resolves to `null` → eval
  error). Use per-build-system static flags in the overlay.
- **Unscoped overlay** — overriding native `zlib`/`openssl` poisoned
  `buildPackages` → the entire native toolchain (coreutils, python, …) rebuilt
  from source instead of substituting. **Always guard overlay overrides with
  `isWasm`.**
- **Minimal per-dep derivations (Approach B)** — rejected: would build `nix.wasm`
  but a user package sharing those deps would still pull the broken nixpkgs cross
  dep and fail. The fix must be a **shared** crossSystem fix.
- **`nixos-26.05` pin** — switched to it for cache coverage, but it triggered an
  LLVM-21-from-source rebuild on aarch64 (the aarch64 cache lacks the exact build,
  and the locally-built unstable LLVM was pin-specific). Reverted to
  `nixos-unstable` (reuses local clang). **26.05 IS the right pin for CI**
  (x86_64 fully cached); the aarch64 gap is a local-dev cost only.
- **Killing builds to restart** — repeatedly killing the dep build mid-LLVM-rebuild
  restarted the ~1–2 h LLVM compile from scratch. Cost hours. Leave builds alone.

---

## Caching strategy (a GOAL, not just an observation)

We **want the host to build from cache, not from source** — on two levels:

1. **Pull nixpkgs deps from a binary cache.** The host build of the toolchain +
   deps should *substitute* nixpkgs (LLVM, coreutils, cmake, …) from a binary
   cache, never recompile them. This is a hard requirement for CI and a strong
   want for local dev. Implications:
   - **Pin a fully-cached nixpkgs** — `nixos-26.05` (clang 21.1.8, Hydra-complete
     on x86_64). The current `nixos-unstable` pin is a local-dev convenience only.
   - **Build/CI on `x86_64-linux`**, where `cache.nixos.org` is complete. The
     `aarch64-linux` cache lags and lacks heavy builds (LLVM → ~1–2 h from source);
     that from-source cost should never happen in CI.
   - If aarch64 host builds are needed, stand up a supplementary cache (cachix /
     a self-hosted store) that holds the aarch64 LLVM + toolchain.

2. **Publish the wasm builds to a binary cache the guest substitutes from.** The
   toolchain, the cross-compiled deps, `nix.wasm`, and (eventually) user packages
   are built **on the host** and pushed to a binary cache. The guest's `nix.wasm`
   then **substitutes** pre-built wasm artifacts — it should rarely build in-guest.
   This is the realistic "install any package in the guest" model (host builds,
   guest downloads) and what makes the crossSystem approach scale.
   - Not yet built. Needs: a binary-cache store of the wasm `cross.*` outputs +
     `nix.wasm`, served same-origin to the guest, with `nix.wasm`'s substituter
     config pointed at it. (CI job to populate it; see `docs/plan-environment.md`
     Phase 5.)

**TL;DR:** host = cached builds (cache-friendly pin + x86_64 + a wasm artifact
cache); guest = substitute-only. From-source rebuilds on the host are a failure
mode to design out, not a normal cost.

## Environment notes

- **Pin**: `nixos-unstable` @ `9ae611a` (2026-06-10), default LLVM **21.1.8**.
  For CI, prefer `nixos-26.05` (same clang-21.1.8, fully cached on x86_64).
- **aarch64 cache reality**: nixpkgs' aarch64 binary cache lags x86_64 and lacks
  heavy builds (LLVM). First local build compiles LLVM from source (~1–2 h, then
  cached locally). x86_64/CI substitutes everything.
- **Known-good oracle**: `~/lwbuild/ws/install/*-wasm32_nommu` (the linux-wasm
  toolchain build). Read-only; validate against it, don't rebuild it here.
- The legacy shell-script build (`legacy/`) still produces a working `nix.wasm`
  via hand-built minimal libs — the proven fallback / reference for flags.
