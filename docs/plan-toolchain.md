# Nix-built wasm32 toolchain + nix.wasm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `vendor/linux-wasm/nix.wasm` (Nix 2.34.7 cross-compiled to the `wasm32-linux-musl` NOMMU guest) entirely through Nix — the wasm toolchain, every C dependency, and Nix itself — replacing the hand-maintained shell scripts that are the source of recurring guest-boot SIGILLs.

**Architecture:** A flake in `scripts/linux-demo/nixbuild/` pins one nixpkgs that provides `llvmPackages_21`. Four idiomatic per-stage derivations rebuild the wasm toolchain (musl 1.2.5 + linux-wasm's 7 patches, kernel UAPI headers, compiler-rt builtins, libc++/libc++abi/libunwind) from stock LLVM-21 — the `wasm-eh` fork patch is upstream in 21, so no fork is needed. A nixpkgs **crossSystem** (`config.replaceCrossStdenv`) wraps clang-21 over that nix-built sysroot, with a flag-filtering `wasm-ld` that drops ELF-only linker flags. The C dependency closure builds via `cross.*`. `nix-wasm.nix` compiles Nix's C++23 with clang-21 against the nix-built libc++ and the `cross.*` deps, then does the one custom `.o` link wasm requires (meson's `-r` prelink can't emit wasm TLS relocations). Each rebuilt artifact is validated against the known-good linux-wasm output still present in `~/lwbuild/ws/install`.

**Tech Stack:** Nix flakes, nixpkgs crossSystem + `replaceCrossStdenv`, LLVM 21 (clang/lld/compiler-rt/libcxx), musl 1.2.5, CMake/Ninja (runtimes), Meson (Nix), the `wasm32-unknown-unknown` clang target with `-D__linux__ -matomics -mbulk-memory -fwasm-exceptions`.

---

## NON-NEGOTIABLE DIRECTIVE (read before every task)

**Everything is built by Nix. No hand-rolled build scripts. No hacks. No stubs.**

This plan exists because the hand-written shell scripts (`build-sysroot.sh`,
`build-nix-wasm.sh`) and fake-library stubs (`misc-stubs.c`, `git2-stubs.c`)
caused recurring, un-greppable guest-boot SIGILLs — every shortcut cost hours.
The whole point is to eliminate that class of failure. Therefore:

1. **Every artifact is a Nix derivation** — the toolchain stages, every C
   dependency, and Nix itself. Inputs come from the store (pinned, reproducible),
   never from `~/lwbuild`, `/usr`, or a hand-built sysroot in the final design.
   (The known-good `~/lwbuild` artifacts are used ONLY as a read-only validation
   oracle, never as a build input.)
2. **Shell is allowed ONLY inside a derivation's phases** (`buildPhase`,
   `installPhase`, …) — that is how Nix works, and it runs sandboxed with
   store-pinned inputs. It is NOT a "build script." There must be **zero
   committed standalone `.sh` build scripts** and **zero stub `.c` files** when
   this plan is done.
3. **No stubs, no fakes, no spoofed versions.** Real `cross.libgit2`, real
   `cross.xz`. If a dependency is needed, it is built — not faked.
4. **The one necessary bespoke step — the final wasm `.o` link** (meson's `-r`
   prelink cannot emit wasm TLS relocations, a real wasm limitation, not a
   shortcut) — lives INSIDE the `nix-wasm` derivation's `buildPhase`, written
   cleanly as Nix. It is NOT copied out of the script being deleted.
5. **Deployment is a copy, not a build:** the shipped `vendor/linux-wasm/nix.wasm`
   is produced by `cp $(nix build … .#nix-wasm)/bin/nix`. No wrapper script.

If a task tempts you toward a shell script, a stub, or an `~/lwbuild` build
input — STOP; that is the exact anti-pattern this plan replaces.

---

## Background facts (do not re-derive)

- **Target ABI:** clang target triple is `wasm32-unknown-unknown` (NOT `wasm32-wasi`); `-D__linux__ -D__unix__ -D__unix` supply the OS macros musl/headers gate on. Mandatory features: `-matomics -mbulk-memory`. C++ exceptions: `-fwasm-exceptions -D__USING_WASM_EXCEPTIONS__`. Everything is `-fPIC` static archives (wasm dylink ABI).
- **Known-good artifacts** (validation oracle) live at `~/lwbuild/ws/install/`:
  - `musl-wasm32_nommu/` — `lib/{crt1,Scrt1,crti,crtn,rcrt1}.o`, `lib/libc.a` (+ libm/libpthread/… stubs), `include/`.
  - `busybox-kernel-headers-wasm32_nommu/include/linux/` — UAPI headers (`kd.h`, etc.).
  - `cxx-wasm32_nommu/` — `lib/{libc++.a,libc++abi.a,libunwind.a}`, `include/c++/v1/`.
  - `llvm/lib/clang/18/lib/wasm32-unknown-unknown/libclang_rt.builtins.a`.
- **Source pins:** musl `v1.2.5` (`7fd8de89cfb515c53a554e628a34cd6e6fb108db`); kernel UAPI from `github.com/joelseverin/linux` branch `wasm-7.0` (`039e5f3e583f56f329657d1fe9945510dba10f41`); Nix `2.34.7`. LLVM comes from the nixpkgs pin (stock 21), NOT the joelseverin fork.
- **Patches** (already in `vendor/linux-wasm/patches/`): musl `0001`–`0007` (clone-tls-ctid, utmp, setxid-arity, misc-arity, per-thread-llvm-tls, **seed-page-size-before-ctors**, fork-clone-arity); the llvm `0001-wasm-eh-init-primary-exception` is **NOT needed on LLVM 21 — VERIFIED, not assumed.** That patch makes `__cxa_init_primary_exception`'s destructor param return `void*` (the wasm EH ABI: destructors return their argument). Upstream LLVM added exactly this, gated on `#ifdef __wasm__`, **in LLVM 19** — confirmed present in `release/19.x` and `release/21.x` of both `libcxxabi/src/cxa_exception.cpp` and `libcxx/include/__exception/exception_ptr.h` (the fork only carries the patch because it pins LLVM 18.1.2, which predates the fix). We build with `-fwasm-exceptions`, so `__wasm__` is defined and upstream selects the correct signature for both libcxxabi and Nix's C++. **Do NOT re-add this patch** — on LLVM 21 it is redundant and would conflict with the upstream branch.
- **Build runs as root** here (the nix daemon socket is root-owned): every `nix`/`nix-build` command is `sudo`. Password is `password` (pipe via `echo password | sudo -S …`). Enable flakes with `NIX_CONFIG="experimental-features = nix-command flakes"`.
- **wasm-ld flag filter** (already prototyped, keep): individual nixpkgs derivations inject ELF-only linker flags (`--undefined-version`, `--version-script`, `-soname`, `--build-id`, `--hash-style`) that wasm-ld hard-errors on. A forwarding `wasm-ld` that strips them, wired into clang via `-B$out/bin` (clang's wasm driver ignores `--ld-path`), fixes the whole class. Verified: `cross.zlib` builds with it.
- **Validation philosophy:** rebuilt-by-clang-21 artifacts will NOT be byte-identical to the clang-18-fork known-good. Validation is (1) artifact builds, (2) exported symbol set matches (`nm` diff), (3) the final `nix.wasm` boots + runs in-guest. Byte-exact is not a goal.

---

## File Structure

All new files under `scripts/linux-demo/nixbuild/`:

- `flake.nix` — pins nixpkgs (with `llvmPackages_21`); outputs the toolchain stages, the cross set, and `nix-wasm`. Single entry point.
- `toolchain/musl.nix` — musl 1.2.5 + 7 patches → sysroot (`lib/crt*.o`, `lib/libc.a`, `include/`).
- `toolchain/kernel-headers.nix` — joelseverin/linux UAPI headers via `make headers_install ARCH=wasm`.
- `toolchain/compiler-rt.nix` — LLVM-21 compiler-rt builtins for `wasm32-unknown-unknown`.
- `toolchain/libcxx.nix` — LLVM-21 libc++/libc++abi (+ Unwind-wasm.c shim) static archives.
- `toolchain/sysroot.nix` — assembles musl + kernel-headers + compiler-rt into one `$out` the cc-wrapper consumes; exposes `cxx` (the libc++ tree) separately.
- `wasm-cross.nix` — the crossSystem (`replaceCrossStdenv`) wrapping clang-21 + the flag-filter wasm-ld over the nix-built sysroot. (Evolved from `~/nix-spike/wasm-cross.nix`.)
- `nix-wasm.nix` — builds Nix 2.34.7 → `$out/bin/nix` (the wasm binary).
- `patches/` — copies of musl `0001`–`0007`, the nix `2.34.7-wasm32-port.patch` (from `nixbuild/patches/`), and a new `nix-2.34.7-wasm32-config.patch`.

Deployment (Task 12) is a documented one-liner — `cp $(nix build … .#nix-wasm)/bin/nix vendor/linux-wasm/nix.wasm` — recorded in `SOURCE.md`, NOT a committed shell script.

Deleted at the end: `scripts/linux-demo/nixdeps/build-sysroot.sh`, `scripts/linux-demo/nixdeps/out/`, `scripts/linux-demo/nixbuild/build-nix-wasm.sh`, `scripts/linux-demo/nixbuild/misc-stubs.c`, `scripts/linux-demo/nixbuild/git2-stubs.c`.

Docs updated: `docs/linux.md` (status), `vendor/linux-wasm/SOURCE.md` (provenance: nix.wasm now nix-built).

---

## Task 1: Scaffold the flake + pin nixpkgs with LLVM 21

**Files:**
- Create: `scripts/linux-demo/nixbuild/flake.nix`

- [ ] **Step 1: Write a minimal flake that pins a nixpkgs providing `llvmPackages_21`**

Pick a pin that ships LLVM 21 (nixos-25.11 or a 2026 unstable). Use `github:NixOS/nixpkgs/nixos-unstable` initially, then lock to the resolved rev.

```nix
{
  description = "wasm32-linux-musl NOMMU toolchain + Nix, built with Nix (#139/#141)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };
    in {
      # placeholder so `nix flake show` works before stages land
      packages.${system}.llvmCheck = pkgs.writeText "llvm" pkgs.llvmPackages_21.clang.version;
    };
}
```

- [ ] **Step 2: Lock and verify LLVM 21 resolves**

Run:
```bash
cd /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix flake lock; nix eval --raw .#packages.aarch64-linux.llvmCheck --no-write-lock-file 2>&1 | tail -1'
```
Expected: prints a `21.x.x` version string (the cat of the writeText). If `llvmPackages_21` is missing, bump the pin.

- [ ] **Step 3: Commit**

```bash
cd /home/vbvntv/Code/pc
git add scripts/linux-demo/nixbuild/flake.nix scripts/linux-demo/nixbuild/flake.lock
git commit -m "build(linux-wasm): scaffold nix-built wasm toolchain flake (LLVM 21 pin)"
```

---

## Task 2: Relocate the musl patches into the flake tree

**Files:**
- Create: `scripts/linux-demo/nixbuild/patches/musl/0001..0007-*.patch` (copied)

- [ ] **Step 1: Copy the 7 musl patches into the flake's patch dir**

```bash
cd /home/vbvntv/Code/pc
mkdir -p scripts/linux-demo/nixbuild/patches/musl
cp vendor/linux-wasm/patches/musl/000[1-7]-*.patch scripts/linux-demo/nixbuild/patches/musl/
ls scripts/linux-demo/nixbuild/patches/musl/
```
Expected: 7 `.patch` files listed.

- [ ] **Step 2: Commit**

```bash
git add scripts/linux-demo/nixbuild/patches/musl/
git commit -m "build(linux-wasm): vendor musl wasm patches into the nix flake tree"
```

---

## Task 3: `toolchain/musl.nix` — musl libc

**Files:**
- Create: `scripts/linux-demo/nixbuild/toolchain/musl.nix`
- Modify: `scripts/linux-demo/nixbuild/flake.nix` (wire the output)

Recipe (from `~/lwbuild/ws/build/musl-wasm32_nommu/config.mak`): CFLAGS `--target=wasm32-unknown-unknown -march=wasm32 -fPIC`, `--rtlib=compiler-rt`, `./configure --target=wasm --disable-shared`, malloc `mallocng`. Built with clang-21 (`llvmPackages_21.clang-unwrapped`), ar/ranlib from `llvmPackages_21.bintools-unwrapped`. compiler-rt resolves at musl link time via `--rtlib=compiler-rt` pointing at Task 5's output (musl's own build only needs it for a couple of link tests; pass `LIBCC` to the archive path).

- [ ] **Step 1: Write the derivation**

```nix
{ pkgs, compilerRt }:
let
  llvm = pkgs.llvmPackages_21;
  clang = "${llvm.clang-unwrapped}/bin/clang";
  bt = llvm.bintools-unwrapped;
in
pkgs.stdenv.mkDerivation {
  pname = "musl-wasm32-nommu";
  version = "1.2.5";
  src = pkgs.fetchgit {
    url = "https://git.musl-libc.org/git/musl";
    rev = "7fd8de89cfb515c53a554e628a34cd6e6fb108db";
    hash = "";  # fill from the first build's "got:" line
  };
  patches = [
    ../patches/musl/0001-clone-varargs-tls-ctid.patch
    ../patches/musl/0002-utmp-file-backed.patch
    ../patches/musl/0003-setxid-exact-syscall-arity.patch
    ../patches/musl/0004-misc-exact-syscall-arity.patch
    ../patches/musl/0005-wasm-per-thread-llvm-tls-block.patch
    ../patches/musl/0006-wasm-seed-page-size-before-ctors.patch
    ../patches/musl/0007-fork-clone-exact-syscall-arity.patch
  ];
  nativeBuildInputs = [ bt ];
  dontStrip = true;
  configurePhase = ''
    runHook preConfigure
    ./configure \
      --target=wasm --prefix=$out --disable-shared \
      CC=${clang} AR=${bt}/bin/llvm-ar RANLIB=${bt}/bin/llvm-ranlib \
      CFLAGS="--target=wasm32-unknown-unknown -march=wasm32 -fPIC -matomics -mbulk-memory" \
      LIBCC="${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a"
    runHook postConfigure
  '';
  buildPhase = "make -j$NIX_BUILD_CORES AR=${bt}/bin/llvm-ar RANLIB=${bt}/bin/llvm-ranlib";
  installPhase = "make install";
}
```

> ORDERING (not optional): musl links against compiler-rt (`LIBCC=…/libclang_rt.builtins.a`), so **compiler-rt (Task 5) is authored and built BEFORE musl (Task 3)**. This is clean because compiler-rt has NO musl dependency (`COMPILER_RT_BAREMETAL_BUILD=Yes`). The flake threads the real `compilerRt` store path into `musl`. Do NOT pass an empty/stub `LIBCC` to dodge the dependency — that is the forbidden-stub anti-pattern; build the real compiler-rt first.

- [ ] **Step 2: Wire into flake.nix outputs**

In `flake.nix`, add inside the `let`:
```nix
      compilerRt = import ./toolchain/compiler-rt.nix { inherit pkgs; };
      musl = import ./toolchain/musl.nix { inherit pkgs compilerRt; };
```
and expose `packages.${system}.musl = musl;`.

- [ ] **Step 3: Build (capture the source hash on first run)**

```bash
cd /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#musl --no-link 2>&1 | tail -20'
```
Expected first run: a hash-mismatch error printing `got: sha256-…`. Paste that into `musl.nix` `hash = "sha256-…";` and rebuild. Expected then: builds to a store path.

- [ ] **Step 4: Validate against known-good musl**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#musl --print-out-paths --no-link 2>/dev/null')
# crt + libc present?
ls "$RESULT"/lib/crt1.o "$RESULT"/lib/libc.a
# exported symbol set matches the known-good (expect empty diff or only addr/order noise):
diff <(llvm-nm-21 --defined-only "$RESULT"/lib/libc.a 2>/dev/null | awk '{print $3}' | sort -u) \
     <(llvm-nm-21 --defined-only ~/lwbuild/ws/install/musl-wasm32_nommu/lib/libc.a 2>/dev/null | awk '{print $3}' | sort -u) | head
```
Expected: `crt1.o` and `libc.a` exist; the symbol-set diff is empty (or only trivially different). Investigate any missing libc symbol before proceeding — a missing syscall wrapper is a future SIGILL.

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/pc
git add scripts/linux-demo/nixbuild/toolchain/musl.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix derivation for musl 1.2.5 wasm32 (+7 patches)"
```

---

## Task 4: `toolchain/kernel-headers.nix` — Linux UAPI headers

**Files:**
- Create: `scripts/linux-demo/nixbuild/toolchain/kernel-headers.nix`
- Modify: `flake.nix`

Recipe (`build.sh:282-286`): `make ARCH=wasm headers_install` on joelseverin/linux `wasm-7.0`, then the exported `usr/include` tree. The kernel's `wasm` arch must exist in that tree (it does at `039e5f3e`). No kernel compile — headers only (fast).

- [ ] **Step 1: Write the derivation**

```nix
{ pkgs }:
pkgs.stdenv.mkDerivation {
  pname = "linux-wasm-uapi-headers";
  version = "wasm-7.0";
  src = pkgs.fetchgit {
    url = "https://github.com/joelseverin/linux.git";
    rev = "039e5f3e583f56f329657d1fe9945510dba10f41";
    hash = "";  # fill from first build
  };
  nativeBuildInputs = [ pkgs.gnumake pkgs.rsync pkgs.bison pkgs.flex pkgs.python3 ];
  dontConfigure = true;
  buildPhase = "make ARCH=wasm headers_install INSTALL_HDR_PATH=$out -j$NIX_BUILD_CORES";
  dontInstall = true;
  dontFixup = true;
}
```

- [ ] **Step 2: Wire `kernelHeaders = import ./toolchain/kernel-headers.nix { inherit pkgs; };` + expose it.**

- [ ] **Step 3: Build (capture hash like Task 3 Step 3).**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#kernelHeaders --no-link 2>&1 | tail -10'
```

- [ ] **Step 4: Validate `linux/kd.h` + the UAPI tree exist and match known-good**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#kernelHeaders --print-out-paths --no-link 2>/dev/null')
ls "$RESULT"/include/linux/kd.h
diff <(cd "$RESULT"/include && find linux -name '*.h' | sort) \
     <(cd ~/lwbuild/ws/install/busybox-kernel-headers-wasm32_nommu && find linux -name '*.h' | sort) | head
```
Expected: `linux/kd.h` present; the header-set diff empty (same UAPI files).

- [ ] **Step 5: Commit**

```bash
git add scripts/linux-demo/nixbuild/toolchain/kernel-headers.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix derivation for wasm UAPI kernel headers"
```

---

## Task 5: `toolchain/compiler-rt.nix` — LLVM-21 builtins

**Files:**
- Create: `scripts/linux-demo/nixbuild/toolchain/compiler-rt.nix`
- Modify: `flake.nix`

Recipe (`compiler-rt-wasm32/CMakeCache.txt`): build `compiler-rt/lib/builtins` for `wasm32-unknown-unknown`, `CMAKE_C_FLAGS=-matomics -mbulk-memory`, `COMPILER_RT_BAREMETAL_BUILD=Yes`, `COMPILER_RT_BUILD_CRT=No`, `COMPILER_RT_HAS_FPIC_FLAG=No`, `COMPILER_RT_DEFAULT_TARGET_ONLY=Yes`, `COMPILER_RT_BUILTINS_ENABLE_PIC=ON`, `COMPILER_RT_BUILTINS_HIDE_SYMBOLS=ON`, `COMPILER_RT_EXCLUDE_ATOMIC_BUILTIN=ON`. Source = stock LLVM-21 monorepo. Output archive must land at `$out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a` (what musl + the cc-wrapper reference).

- [ ] **Step 1: Identify the LLVM-21 monorepo source attr**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix eval --raw .#packages.aarch64-linux.llvmCheck >/dev/null; nix eval nixpkgs#llvmPackages_21.compiler-rt.src.outPath 2>/dev/null || nix eval nixpkgs#llvmPackages_21.libllvm.monorepoSrc.outPath'
```
Use whichever resolves (`compiler-rt.src` is the extracted compiler-rt subtree; `libllvm.monorepoSrc` is the full tree). The derivation below assumes the monorepo `src` containing `compiler-rt/`, `cmake/`, `llvm/cmake/`.

- [ ] **Step 2: Write the derivation**

```nix
{ pkgs }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
in
pkgs.stdenv.mkDerivation {
  pname = "compiler-rt-builtins-wasm32";
  version = llvm.release_version;
  src = llvm.compiler-rt.monorepoSrc or llvm.compiler-rt.src;
  nativeBuildInputs = [ pkgs.cmake pkgs.ninja llvm.clang-unwrapped bt ];
  dontUseCmakeConfigure = true;
  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S compiler-rt/lib/builtins -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER=${llvm.clang-unwrapped}/bin/clang \
      -DCMAKE_AR=${bt}/bin/llvm-ar \
      -DCMAKE_NM=${bt}/bin/llvm-nm \
      -DCMAKE_RANLIB=${bt}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_C_FLAGS="-matomics -mbulk-memory" \
      -DCOMPILER_RT_BAREMETAL_BUILD=Yes \
      -DCOMPILER_RT_BUILD_CRT=No \
      -DCOMPILER_RT_HAS_FPIC_FLAG=No \
      -DCOMPILER_RT_DEFAULT_TARGET_ONLY=Yes \
      -DCOMPILER_RT_BUILTINS_ENABLE_PIC=ON \
      -DCOMPILER_RT_BUILTINS_HIDE_SYMBOLS=ON \
      -DCOMPILER_RT_EXCLUDE_ATOMIC_BUILTIN=ON \
      -DCMAKE_INSTALL_PREFIX=$out
    cmake --build build -j$NIX_BUILD_CORES
    runHook postBuild
  '';
  installPhase = ''
    mkdir -p $out/lib/wasm32-unknown-unknown
    cp $(find build -name 'libclang_rt.builtins*.a' | head -1) \
       $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
  '';
}
```

- [ ] **Step 3: Build (note: no source-hash step — `src` comes from nixpkgs, already fixed-output).**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#compilerRt --no-link 2>&1 | tail -15'
```
Expected: builds; the archive lands at `lib/wasm32-unknown-unknown/libclang_rt.builtins.a`.

- [ ] **Step 4: Validate the builtins symbol set vs known-good**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#compilerRt --print-out-paths --no-link 2>/dev/null')
diff <(llvm-nm-21 --defined-only "$RESULT"/lib/wasm32-unknown-unknown/libclang_rt.builtins.a | awk '{print $NF}' | sort -u) \
     <(llvm-nm-21 --defined-only ~/lwbuild/ws/install/llvm/lib/clang/18/lib/wasm32-unknown-unknown/libclang_rt.builtins.a | awk '{print $NF}' | sort -u) | head -30
```
Expected: the builtins (`__multi3`, `__divdi3`, `__ashlti3`, …) present; diff small (21 may add/rename a few). A MISSING core builtin means a future link failure — investigate.

- [ ] **Step 5: Commit**

```bash
git add scripts/linux-demo/nixbuild/toolchain/compiler-rt.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix derivation for LLVM-21 compiler-rt wasm32 builtins"
```

---

## Task 6: `toolchain/libcxx.nix` — libc++ / libc++abi / libunwind

**Files:**
- Create: `scripts/linux-demo/nixbuild/toolchain/libcxx.nix`
- Modify: `flake.nix`

Recipe (`cxx-wasm32_nommu/CMakeCache.txt` + `build.sh:459-504`). Needs musl (Task 3) + kernel headers (Task 4) for `--sysroot`/`-isystem`. CFLAGS exactly:
`-fPIC --sysroot=$MUSL -isystem $KHDR -D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory -fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ -fvisibility=hidden -fvisibility-inlines-hidden -O2 -I<llvm>/libunwind/include`. The HERMETIC/USE_COMPILER_RT/MUSL_LIBC cmake flags from the recipe. Then the libunwind shim: compile ONLY `libunwind/src/Unwind-wasm.c` with `-D_LIBUNWIND_HIDE_SYMBOLS` into `libunwind.a`. **No fork, no patch** — the wasm-EH `__cxa_init_primary_exception` signature is upstream since LLVM 19 (gated on `#ifdef __wasm__`; see Background, verified against `release/21.x`). If a build error mentions `__cxa_init_primary_exception` signature mismatch, the cause is NOT a missing patch — check that `-fwasm-exceptions` (→ `__wasm__` defined) is on the flags.

- [ ] **Step 1: Write the derivation**

```nix
{ pkgs, musl, kernelHeaders, compilerRt }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
  src = llvm.libcxx.monorepoSrc or llvm.libcxx.src;
  flags = "-fPIC --sysroot=${musl} -isystem ${kernelHeaders}/include "
        + "-D__linux__ -D__unix__ -D__unix -matomics -mbulk-memory "
        + "-fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ "
        + "-fvisibility=hidden -fvisibility-inlines-hidden -O2 -I${src}/libunwind/include";
in
pkgs.stdenv.mkDerivation {
  pname = "libcxx-wasm32-nommu";
  version = llvm.release_version;
  inherit src;
  nativeBuildInputs = [ pkgs.cmake pkgs.ninja pkgs.python3 llvm.clang-unwrapped bt ];
  dontUseCmakeConfigure = true;
  buildPhase = ''
    runHook preBuild
    cmake -G Ninja -S runtimes -B build \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$out \
      -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
      -DCMAKE_C_COMPILER=${llvm.clang-unwrapped}/bin/clang \
      -DCMAKE_CXX_COMPILER=${llvm.clang-unwrapped}/bin/clang++ \
      -DCMAKE_AR=${bt}/bin/llvm-ar -DCMAKE_RANLIB=${bt}/bin/llvm-ranlib \
      -DCMAKE_C_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_CXX_COMPILER_TARGET=wasm32-unknown-unknown \
      -DCMAKE_C_FLAGS="${flags}" -DCMAKE_CXX_FLAGS="${flags}" \
      -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DLLVM_ENABLE_RUNTIMES="libcxxabi;libcxx" \
      -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_STATIC=ON \
      -DLIBCXXABI_HERMETIC_STATIC_LIBRARY=ON -DLIBCXX_HERMETIC_STATIC_LIBRARY=ON \
      -DLIBCXXABI_USE_COMPILER_RT=ON -DLIBCXXABI_USE_LLVM_UNWINDER=OFF \
      -DLIBCXXABI_ENABLE_THREADS=ON \
      -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXX_ENABLE_STATIC=ON \
      -DLIBCXX_USE_COMPILER_RT=ON -DLIBCXX_CXX_ABI=libcxxabi \
      -DLIBCXX_HAS_MUSL_LIBC=ON -DLIBCXX_ENABLE_THREADS=ON \
      -DLIBCXX_INCLUDE_BENCHMARKS=OFF -DLIBCXX_INCLUDE_TESTS=OFF
    cmake --build build -j$NIX_BUILD_CORES
    runHook postBuild
  '';
  installPhase = ''
    cmake --install build
    # libunwind: wasm-EH shim only (Unwind-wasm.c), like Emscripten.
    ${llvm.clang-unwrapped}/bin/clang ${flags} --target=wasm32-unknown-unknown \
      -D_LIBUNWIND_HIDE_SYMBOLS -I ${src}/libunwind/src \
      -c ${src}/libunwind/src/Unwind-wasm.c -o Unwind-wasm.o
    ${bt}/bin/llvm-ar rcs $out/lib/libunwind.a Unwind-wasm.o
  '';
}
```

- [ ] **Step 2: Wire `libcxx = import ./toolchain/libcxx.nix { inherit pkgs musl kernelHeaders compilerRt; };` + expose.**

- [ ] **Step 3: Build.**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#libcxx --no-link 2>&1 | tail -20'
```

- [ ] **Step 4: Validate the three archives exist + libc++abi exports the wasm-EH personality**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#libcxx --print-out-paths --no-link 2>/dev/null')
ls "$RESULT"/lib/libc++.a "$RESULT"/lib/libc++abi.a "$RESULT"/lib/libunwind.a
# the wasm-EH entry points the guest needs:
llvm-nm-21 --defined-only "$RESULT"/lib/libunwind.a | grep -i _Unwind_
llvm-nm-21 --defined-only "$RESULT"/lib/libc++abi.a | grep -i __cxa_throw
```
Expected: all three archives present; `_Unwind_*` defined in libunwind.a; `__cxa_throw` in libc++abi.a.

- [ ] **Step 5: Commit**

```bash
git add scripts/linux-demo/nixbuild/toolchain/libcxx.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix derivation for LLVM-21 libc++/libc++abi/libunwind wasm32"
```

---

## Task 7: `toolchain/sysroot.nix` — assemble the cc sysroot

**Files:**
- Create: `scripts/linux-demo/nixbuild/toolchain/sysroot.nix`
- Modify: `flake.nix`

Compose musl + kernel headers + compiler-rt into the single tree the cc-wrapper's `--sysroot` expects (musl `lib/` + `include/` overlaid with `linux/` UAPI). Expose `cxx` (libcxx tree) and `resourceDir` (compiler-rt builtins) as siblings for the cc-wrapper.

- [ ] **Step 1: Write the derivation**

```nix
{ pkgs, musl, kernelHeaders, compilerRt }:
pkgs.runCommand "wasm32-sysroot" { } ''
  mkdir -p $out/lib $out/include
  cp -a ${musl}/lib/. $out/lib/
  cp -a ${musl}/include/. $out/include/
  chmod -R u+w $out/include
  cp -a ${kernelHeaders}/include/. $out/include/
''
```
> The cc-wrapper (Task 8) references `compilerRt` for `-resource-dir` and `libcxx` for the C++ link directly, so the sysroot itself is just musl + headers.

- [ ] **Step 2: Wire `sysroot = import ./toolchain/sysroot.nix { inherit pkgs musl kernelHeaders compilerRt; };` + expose.**

- [ ] **Step 3: Build + validate the layout**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#sysroot --print-out-paths --no-link 2>/dev/null')
ls "$RESULT"/lib/crt1.o "$RESULT"/lib/libc.a "$RESULT"/include/stdio.h "$RESULT"/include/linux/kd.h
```
Expected: all four exist (crt + libc + a libc header + a kernel UAPI header in one tree).

- [ ] **Step 4: Commit**

```bash
git add scripts/linux-demo/nixbuild/toolchain/sysroot.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): assemble nix-built wasm32 sysroot (musl+headers)"
```

---

## Task 8: `wasm-cross.nix` — crossSystem cc-wrapper over the nix-built toolchain

**Files:**
- Create: `scripts/linux-demo/nixbuild/wasm-cross.nix` (evolve `~/nix-spike/wasm-cross.nix`)
- Modify: `flake.nix`

Take the proven `~/nix-spike/wasm-cross.nix` and change THREE things: (1) clang/bintools/libcxx source from `llvmPackages_21` not `_18`; (2) `libcWasm`/`resourceDir` from the nix-built `sysroot`/`compilerRt`/`libcxx` (Tasks 5-7) instead of the tarball + `~/lwbuild` path; (3) keep the flag-filter `wasm-ld` wired via `-B$out/bin` (already proven). Pass the stage derivations in as args.

- [ ] **Step 1: Author `wasm-cross.nix` taking the nix-built toolchain**

Key differences from the spike version (full file mirrors the spike's structure):
```nix
{ nixpkgs, localSystem ? "aarch64-linux", sysroot, compilerRt, libcxx, overlays ? [ ] }:
let
  native = import nixpkgs { system = localSystem; };
  mkWasmCC = pkgs:
    let
      llvm = native.llvmPackages_21;                      # was _18
      libcWasm = sysroot;                                  # nix-built (Task 7), not the tarball
      resourceDir = native.runCommand "wasm-clang-resource" { } ''
        mkdir -p $out/include $out/lib/wasm32-unknown-unknown
        cp -a ${native.lib.getLib llvm.clang-unwrapped}/lib/clang/*/include/. $out/include/
        cp ${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a \
           $out/lib/wasm32-unknown-unknown/libclang_rt.builtins.a
      '';
      filteredLd = native.writeShellScriptBin "wasm-ld" ''
        args=(); skip=
        for a in "$@"; do
          if [ -n "$skip" ]; then skip=; continue; fi
          case "$a" in
            --undefined-version|--no-undefined-version) continue;;
            --version-script=*|--dynamic-list=*|-soname=*|--soname=*) continue;;
            --version-script|--dynamic-list|-soname|--soname) skip=1; continue;;
            --build-id|--build-id=*|--eh-frame-hdr|--hash-style=*) continue;;
            --warn-shared-textrel|-z) skip=1; continue;;
            -z*) continue;;
          esac
          args+=("$a")
        done
        exec ${llvm.bintools-unwrapped}/bin/wasm-ld "''${args[@]}"
      '';
      wasmBintools = pkgs.wrapBintoolsWith {
        bintools = llvm.bintools-unwrapped; libc = libcWasm; sharedLibraryLoader = null;
      };
    in pkgs.wrapCCWith {
      cc = llvm.clang-unwrapped; bintools = wasmBintools; libc = libcWasm;
      extraBuildCommands = ''
        ln -sf ${filteredLd}/bin/wasm-ld $out/bin/wasm-ld
        cat >> $out/nix-support/cc-cflags <<EOF
         --target=wasm32-unknown-unknown -D__linux__ -D_GNU_SOURCE -D_LARGEFILE64_SOURCE -fPIC -matomics -mbulk-memory -resource-dir=${resourceDir} -B$out/bin -Wno-error=implicit-function-declaration -Wno-error=implicit-int
        EOF
        cat >> $out/nix-support/cc-ldflags <<EOF
         -shared -Bsymbolic --no-entry --export-all --import-memory --shared-memory --max-memory=4294967296 --import-table --no-merge-data-segments --export-if-defined=__set_tls_base --export-if-defined=__libc_handle_signal
        EOF
      '';
    };
in import nixpkgs {
  inherit overlays;
  localSystem = { system = localSystem; };
  crossSystem = { config = "wasm32-unknown-linux-musl"; libc = "musl"; useLLVM = true; };
  config = {
    allowUnsupportedSystem = true;
    replaceCrossStdenv = { buildPackages, baseStdenv }:
      let
        adapters = buildPackages.stdenvAdapters;
        ccStdenv = adapters.overrideCC baseStdenv (mkWasmCC buildPackages);
        salt = builtins.replaceStrings [ "-" ] [ "_" ] "wasm32-unknown-linux-musl";
      in adapters.addAttrsToDerivation {
        NIX_NO_SELF_RPATH = "1"; "NIX_DONT_SET_RPATH_${salt}" = "1";
      } ccStdenv;
  };
}
```
> The `allow-undefined-file` from the spike is dropped here — wasm-ld `--allow-undefined` (already implied for `-shared`) plus the host-import names are handled by the kernel binfmt; if a dep link reports an undefined host symbol, re-add an `--allow-undefined-file` listing it. Keep `--import-memory`/`--shared-memory` (the SAB ABI).

- [ ] **Step 2: Wire into flake: `cross = import ./wasm-cross.nix { inherit nixpkgs sysroot compilerRt libcxx; };` and expose `packages.${system}.crossZlib = cross.zlib;` for the smoke check.**

- [ ] **Step 3: Smoke-test the cc by building `cross.zlib`**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#crossZlib --no-link 2>&1 | tail -8'
```
Expected: `zlib-wasm32-unknown-linux-musl-1.3.1` builds (proves the nix-built sysroot + clang-21 + flag-filter all work together).

- [ ] **Step 4: Validate a trivial C program links to a real wasm module**

```bash
# build cross.hello-style probe via a one-off expr, or reuse cross.zlib's libz.a:
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#crossZlib --print-out-paths --no-link 2>/dev/null' | head -1)
file "$RESULT"/lib/libz.a && llvm-nm-21 "$RESULT"/lib/libz.a | grep -i deflate | head -2
```
Expected: archive of wasm objects; `deflate` symbol present.

- [ ] **Step 5: Commit**

```bash
git add scripts/linux-demo/nixbuild/wasm-cross.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): crossSystem cc-wrapper (clang-21) over nix-built sysroot"
```

---

## Task 9: Validate the full C dependency closure builds

**Files:**
- Modify: `scripts/linux-demo/nixbuild/wasm-cross.nix` (only if a dep needs an overlay/filter addition)

Nix's deps: `zlib bzip2 xz sqlite openssl curl libgit2 brotli libarchive editline libsodium boost nlohmann_json blake3`. Build each through `cross.*`; the flag-filter should clear the ELF-only-flag class. Fix stragglers by (a) extending the `filteredLd` case list for a new bad flag, or (b) a small `overlays` entry mirroring the ncurses pattern.

- [ ] **Step 1: Add a closure aggregate to the flake**

```nix
packages.${system}.depClosure = pkgs.symlinkJoin {
  name = "nix-wasm-deps";
  paths = with cross; [ zlib bzip2 xz sqlite openssl curl libgit2 brotli
                        libarchive editline libsodium boost nlohmann_json blake3 ];
};
```

- [ ] **Step 2: Build the closure; fix each failure**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#depClosure --no-link -k 2>&1 | tail -30'
```
For each `wasm-ld: error: unknown argument: <flag>` → add `<flag>` to `filteredLd`'s case list and rebuild (instant filter rebuild). For each missing host-side build tool / cross-cache-var (autotools `AC_TRY_RUN`) → add the cache var via an `overlays` `overrideAttrs` (ncurses precedent: `env.cf_cv_* = …`). Repeat until the closure builds.

- [ ] **Step 3: Validate each dep produced a static archive**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#depClosure --print-out-paths --no-link 2>/dev/null')
for l in libz libbz2 liblzma libsqlite3 libssl libcrypto libcurl libgit2 libsodium libarchive libeditline libblake3; do
  ls "$RESULT"/lib/$l.a 2>/dev/null || echo "MISSING $l"
done
```
Expected: every archive present (boost_url + nlohmann are header/limited).

- [ ] **Step 4: Commit any filter/overlay fixes**

```bash
git add scripts/linux-demo/nixbuild/wasm-cross.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix C dep closure for nix.wasm (wasm-ld flag filter + cross cache vars)"
```

---

## Task 10: Nix port + config patches

**Files:**
- Copy: `scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch` (from existing `nixbuild/patches/`)
- Create: `scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-config.patch`

The config patch replaces the `sed`/`perl` meson hacks in `build-nix-wasm.sh:196-198` (force `AT_SYMLINK_NOFOLLOW`→1 for the symlink-mtime fix; drop `close_range` from the unix func check). Generate it as a real diff against the patched 2.34.7 tree.

- [ ] **Step 1: Copy the existing port patch into the flake tree**

```bash
cp /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch \
   /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch.keep 2>/dev/null || true
# (already in place; this task just ensures it's tracked)
ls /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch
```

- [ ] **Step 2: Generate the config patch from the source tree**

```bash
cd $(mktemp -d) && git clone --depth 1 -b 2.34.7 https://github.com/NixOS/nix.git nx && cd nx
git apply /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch
git add -A && git -c user.email=pc@local -c user.name=pc commit -qm base
UM=src/libutil/unix/meson.build
sed -i "s/cxx.has_header_symbol('fcntl.h', 'AT_SYMLINK_NOFOLLOW').to_int()/1/" "$UM"
perl -0777 -i -pe "s/\s*\[\s*'close_range',\s*'[^']*',\s*\],//s" "$UM"
git diff > /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-config.patch
cat /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-config.patch
```
Expected: a small unified diff touching only `src/libutil/unix/meson.build`.

- [ ] **Step 3: Commit**

```bash
cd /home/vbvntv/Code/pc
git add scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-port.patch scripts/linux-demo/nixbuild/patches/nix-2.34.7-wasm32-config.patch
git commit -m "build(linux-wasm): nix 2.34.7 wasm32 port + config patches (versioned, replaces sed)"
```

---

## Task 11: `nix-wasm.nix` — build Nix → nix.wasm

**Files:**
- Create: `scripts/linux-demo/nixbuild/nix-wasm.nix`
- Modify: `flake.nix`

Build Nix's C++ with clang-21 against the nix-built libc++ (Task 6) + `cross.*` deps (Task 9), through meson (compile only), then the custom `.o` link (meson `-r` can't emit wasm TLS relocs). Faithfully reproduce `build-nix-wasm.sh`'s working compile/link recipe, but with deps from the store and NO stub libs (real `cross.libgit2`, real `cross.xz`). meson cross file points `cpp` at a clang-21 wrapper carrying the libc++/sysroot/EH flags; the final link collects `src/**/*.o` and links with the dep archives.

- [ ] **Step 1: Write the derivation**

Model the `cpp` wrapper + meson setup + object-collect + link on `build-nix-wasm.sh:70-250`, substituting: `CLANG21=${llvmPackages_21.clang-unwrapped}/bin/clang++`, `CXXRT=${libcxx}`, `MUSL=${sysroot}`, dep `-L${dep}/lib` from each `cross.*`. Key shape:

```nix
{ pkgs, cross, sysroot, libcxx, nixSrc }:
let
  llvm = pkgs.llvmPackages_21;
  deps = with cross; [ sqlite libsodium bzip2 xz zlib brotli libarchive
                       openssl blake3 editline boost curl libgit2 nlohmann_json ];
in
pkgs.stdenv.mkDerivation {
  pname = "nix-wasm"; version = "2.34.7";
  src = nixSrc;
  patches = [ ./patches/nix-2.34.7-wasm32-port.patch ./patches/nix-2.34.7-wasm32-config.patch ];
  nativeBuildInputs = [ pkgs.meson pkgs.ninja pkgs.pkg-config llvm.clang-unwrapped
                        llvm.bintools-unwrapped pkgs.python3 ];
  # … write the wcxx wrapper (CXX_COMMON flags from build-nix-wasm.sh:70-98 with
  #   --sysroot=${sysroot} -isystem ${kernelHeaders}/include
  #   -nostdinc++ -isystem ${libcxx}/include/c++/v1 -L${libcxx}/lib -lc++ -lc++abi -lunwind),
  #   the meson cross .ini, pkg-config files pointing at each ${dep},
  #   meson setup build-wasm (flags from build-nix-wasm.sh:217-221),
  #   ninja -k0, collect objects (build-nix-wasm.sh:236-238), link with deps,
  #   install $out/bin/nix.
  buildPhase = '' … '';   # full body mirrors build-nix-wasm.sh, deps from the store
  installPhase = ''mkdir -p $out/bin; cp nix.wasm $out/bin/nix'';
  dontStrip = false;
}
```
> Implementation note: the `wcxx`/meson/collect/link sequence is written FRESH as the derivation's `buildPhase` — clean Nix, deriving its inputs from the store. `build-nix-wasm.sh:70-252` may be READ as a reference for the exact compile/link flags that are known to work (the `CXX_COMMON` EH flag set, the meson `-Dunit-tests=false …` flags, the object-collect glob, the export-roots), but nothing is copied out of it — the script is being deleted. Differences from that reference are intentional and required by the directive: dep `-L`/`-l` come from `${dep}` store paths (real `cross.libgit2`, real `cross.xz`), and there are **no `-lmiscstub`/`-lgit2`-stub** — stubs are forbidden. The `--export-if-defined=__set_tls_base`/`__libc_handle_signal`/`_start` export roots stay (the host signal/TLS ABI).

- [ ] **Step 2: Wire `nixWasm = import ./nix-wasm.nix { inherit pkgs cross sysroot libcxx; nixSrc = …; };` + expose `packages.${system}.nix-wasm = nixWasm;`. Pin `nixSrc` via `fetchgit` of the 2.34.7 tag (capture hash).**

- [ ] **Step 3: Build**

```bash
echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#nix-wasm --no-link 2>&1 | tail -25'
```
Expected: builds `$out/bin/nix` (a wasm binary, ~16 MB). Fix link errors by checking the dep `-L`/`-l` set against `build-nix-wasm.sh:246-250`.

- [ ] **Step 4: Validate it's a wasm module of the right shape**

```bash
RESULT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#nix-wasm --print-out-paths --no-link 2>/dev/null')
file "$RESULT"/bin/nix      # → WebAssembly (wasm) binary module
llvm-nm-21 "$RESULT"/bin/nix 2>/dev/null | grep -E "__set_tls_base|__libc_handle_signal|_start" | head
```
Expected: `WebAssembly … module`; the export roots present (the host signal/TLS ABI).

- [ ] **Step 5: Commit**

```bash
git add scripts/linux-demo/nixbuild/nix-wasm.nix scripts/linux-demo/nixbuild/flake.nix
git commit -m "build(linux-wasm): nix-wasm.nix builds Nix 2.34.7 → nix.wasm via Nix"
```

---

## Task 12: Deploy + verify in-guest (no SIGILL, then install-by-name)

**Files:**
- Modify: `vendor/linux-wasm/nix.wasm` (the shipped artifact)

- [ ] **Step 1: Deploy via a one-line copy (NO script — Nix builds, `cp` ships)**

```bash
cd /home/vbvntv/Code/pc/scripts/linux-demo/nixbuild
OUT=$(echo password | sudo -S bash -c 'export NIX_CONFIG="experimental-features = nix-command flakes"; nix build .#nix-wasm --print-out-paths --no-link 2>/dev/null')
install -m644 "$OUT/bin/nix" /home/vbvntv/Code/pc/vendor/linux-wasm/nix.wasm
du -h /home/vbvntv/Code/pc/vendor/linux-wasm/nix.wasm
```
Expected: ~16 MB written to `vendor/linux-wasm/nix.wasm`. (This exact one-liner gets recorded in `SOURCE.md` in Task 13 — it is the documented deploy command, not a committed script.)

- [ ] **Step 2: Verify `nix --version` does NOT SIGILL in-guest**

```bash
cd /home/vbvntv/Code/pc/scripts/linux-demo
node exec-nix.mjs 2>&1 | tail -20
```
Expected: prints a `nix (Nix) 2.34.7` line; NO `SIGILL`/`Aiee`/`panic`. If it SIGILLs, the toolchain diverged — bisect by checking which stage's symbol-set diff (Tasks 3-6) was non-empty; the page-size seeding (musl 0006) and TLS (0005) patches are the usual suspects.

- [ ] **Step 3: Verify install-by-name end-to-end**

```bash
cd /home/vbvntv/Code/pc/scripts/linux-demo
node exec-nixenv.mjs 2>&1 | tail -25
```
Expected: `*** sl INSTALLED BY NAME (nix-env -iA sl) ***` (substitutes sl from the cache, builds the user-env profile — the symlink-mtime config patch lets it succeed).

- [ ] **Step 4: Commit the artifact**

```bash
cd /home/vbvntv/Code/pc
git add vendor/linux-wasm/nix.wasm
git commit -m "build(linux-wasm): nix.wasm now built by Nix; verified no-SIGILL + nix-env -iA sl in-guest"
```

---

## Task 13: Delete the shell-script build path + update docs

**Files:**
- Delete: `scripts/linux-demo/nixdeps/build-sysroot.sh`, `scripts/linux-demo/nixdeps/out/`, `scripts/linux-demo/nixbuild/build-nix-wasm.sh`, `scripts/linux-demo/nixbuild/misc-stubs.c`, `scripts/linux-demo/nixbuild/git2-stubs.c`
- Modify: `docs/linux.md`, `vendor/linux-wasm/SOURCE.md`, `scripts/linux-demo/nixbuild/PLAN-nix-via-nix.md` (supersede)

- [ ] **Step 1: Remove the dead shell-script build path**

```bash
cd /home/vbvntv/Code/pc
git rm -r scripts/linux-demo/nixdeps/build-sysroot.sh scripts/linux-demo/nixbuild/build-nix-wasm.sh \
          scripts/linux-demo/nixbuild/misc-stubs.c scripts/linux-demo/nixbuild/git2-stubs.c
rm -rf scripts/linux-demo/nixdeps/out
git rm -r --cached scripts/linux-demo/nixdeps/out 2>/dev/null || true
```

- [ ] **Step 2: Update `docs/linux.md` + `SOURCE.md`**

Add to `docs/linux.md` (#141 running log): nix.wasm is now built entirely by Nix (`scripts/linux-demo/nixbuild/flake.nix`); the wasm toolchain (musl/headers/compiler-rt/libc++) and the C dep closure are nix-built; bump **Last updated**. In `vendor/linux-wasm/SOURCE.md`: record nix.wasm provenance = `nix build .../nixbuild#nix-wasm` (LLVM-21 pin, musl 1.2.5, Nix 2.34.7) and the per-stage source pins.

- [ ] **Step 3: Verify nothing references the deleted scripts**

```bash
grep -rn "build-sysroot.sh\|build-nix-wasm.sh\|misc-stubs\|git2-stubs\|nixdeps/out" \
  scripts docs vendor --include='*.sh' --include='*.md' --include='*.mjs' | grep -v PLAN-nix-via-nix
```
Expected: empty (or only this plan / the superseded PLAN doc).

- [ ] **Step 4: Commit**

```bash
git add -u docs/linux.md vendor/linux-wasm/SOURCE.md scripts/linux-demo/nixbuild/PLAN-nix-via-nix.md
git commit -m "build(linux-wasm): retire hand-rolled nix.wasm shell-script build path"
```

---

## Self-Review notes (author-checked)

- **Spec coverage:** musl (T3), kernel headers (T4), compiler-rt (T5), libc++ (T6), sysroot (T7), crossSystem cc (T8), C deps (T9), nix patches (T10), nix.wasm (T11), in-guest verify (T12), delete shell scripts (T13) — all present. Clang-21 unification decision recorded in Background. Validation-against-known-good is in T3-T6 + T12.
- **Ordering caveat:** compiler-rt (T5) has NO musl dependency and must build BEFORE musl (T3) needs `LIBCC` — the flake wires `compilerRt` into `musl`. If executing strictly top-to-bottom, build `.#compilerRt` during T3 Step 3 first. Flagged in T3's NOTE.
- **Known open items needing live resolution (not placeholders — verifiable at build):** the exact nixpkgs attr for the LLVM monorepo source (`compiler-rt.monorepoSrc` vs `.src`) — T5 Step 1 resolves it via `nix eval`; the source `hash` fields — captured from the first build's `got:` line. These are standard Nix first-build steps, not gaps.
- **Risk:** stock LLVM-21 libc++ may differ from the clang-18-fork known-good; caught by functional validation (T12) + symbol diffs (T6). **Resolution is fix-forward on LLVM 21+** — debug and fix any divergence in the LLVM-21 derivations (a flag, a build option, a real upstream patch carried forward). There is NO fallback to the old 18.1.2 fork; reaching for it would reintroduce the exact maintenance-of-a-fork burden this plan eliminates.
