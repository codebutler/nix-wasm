# STATUS — nix-wasm

Detailed progress log. Last updated **2026-06-17**.

> **🎉 MILESTONE (2026-06-17): the full loop works end-to-end.**
> `pc/scripts/linux-demo/exec-nixsystem.mjs` **Phase A AND Phase B both PASS** on a
> fresh boot: the Nix-built wasm userspace boots (served-closure store overlaid at
> `/nix`, activate, busybox-init → getty → autologin → root shell, correct
> TERM/PATH/`/etc`), then `nix-env -iA sl` **substitutes `sl` from the binary
> cache** and **`sl` renders the steam locomotive**. This is the "install any
> package in the guest" model (substitute-from-cache) proven end-to-end. See
> "Userspace redesign — Plan 2 DONE" and "Root causes fixed 2026-06-17" below.

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

## ✅ Runs in-guest — `nix --version` works

Deployed to the pc guest (headless-kernel harness `exec-nix.mjs`): `nix --version`
→ `nix (Nix) 2.34.7`, exit 0, **no SIGILL**. Getting there needed three env-import
fixes (our build left symbols undefined → `env` imports the guest can't satisfy →
instantiate LinkError, surfaced as SIGILL) — all CORRECT fixes, not the legacy
fake-stubs:
- `-DBOOST_STACKTRACE_USE_NOOP` (Nix's crash-handler boost::stacktrace pulled
  `_Unwind_Backtrace`, unimplementable on wasm — NOOP backend instead of a stub);
- link the real `pcre2`/`llhttp`/`zstd` (transitive deps of libgit2/libarchive
  the link line had omitted);
- patch out llhttp's `#if defined(__wasm__)` JS-host-callback block (`wasm_on_*`),
  which is for llhttp's own wasm npm package and is dead/wrong when embedded.

## ✅ Install-by-name in-guest — `nix-env -iA sl` works

`nix-env -iA sl` on the pc guest: nix.wasm **substitutes `sl` from a binary cache**
(`nix copy --from file:///nix-cache`) and **installs it by name into the profile**
(exit 0, `sl` on the profile PATH). The "install any package in the guest" model,
proven end-to-end. Needed one fix beyond `nix --version`: cross.sqlite with
`-DSQLITE_OMIT_WAL -DSQLITE_THREADSAFE=0` (WAL's shared-memory `-shm` file is
unsupported on the wasm/NOMMU guest fs → SQLITE_IOERR on the store DB).

## ✅ Install-by-name wired into `pc-init` (clean boot, no test scaffolding)

The earlier `nix-env -iA sl` pass relied on a test harness that hand-created the
`nix-env` symlink and a package expression. Those are now provisioned by the guest
init (`pc/vendor/linux-wasm/pc-init`), so install-by-name works on a fresh boot:
- **multi-call entry points** — Nix dispatches on argv[0]; symlink
  `nix-env`/`nix-build`/`nix-store`/`nix-shell`/`nix-instantiate`/`nix-channel`/
  `nix-collect-garbage` → `/opt/bin/nix`.
- **package index** — the binary cache ships `pkgs.nix` (attr → host-built store
  path), generated by `pc/scripts/linux-demo/make-nix-cache-index.mjs`; pc-init
  installs it as `~/.nix-defexpr` so `nix-env -iA <name>` resolves by name.
- **profile on PATH** — `/etc/profile` prepends `~/.nix-profile/bin`, so an
  installed package runs as a bare command.

Verified clean (`exec-nixenv-clean.{html,mjs}`): fresh boot → `nix-env -iA sl`
exit 0, `command -v sl` → `/root/.nix-profile/bin/sl`. (Closure pre-copied with
`nix copy`; see the NOMMU 9P note below.)

---

## ⬜ What's next — full checklist

The userspace redesign (the spine) is **DONE** and the acceptance test is green.
Remaining, roughly by leverage: **Phase 5 (CI + binary cache)** — the design goal;
**Phase 3 (nixify guest-clang)** — lets the guest compile, not just install; then
robustness long-tail.

### ✅ Provisioning is now declarative (the `pc-init` hacks are retired)
Everything below USED to live in the hand-written `pc-init` shell script; the
Nix-built userspace (Plan 2) now generates it: `/etc/nix/nix.conf`, `passwd`/
`group`, `inittab`, `PATH`, the nix-env multi-call symlinks, `TERM=xterm-256color`,
and the trimmed terminfo (xterm-256color only) via `system.path`. sqlite WAL stays
disabled (`-DSQLITE_OMIT_WAL`) — a legit documented build flag.

### ✅ Root causes fixed 2026-06-17 (what made Plan 2 + Phase B actually work)
1. **busybox spawn** — stock busybox forks/vforks, impossible on the wasm NOMMU
   clone-with-fn model (a fresh wasm instance can't resume the parent mid-fn →
   SIGILL). Built a patched busybox 1.36.1 (`userspace/busybox.nix`) with
   clone-with-fn patches (`patches/busybox/0001` arch+run_pipe/init/hush, `0003`
   `$(...)` cmdsub, `0004` libbb `spawn()`/`fork_or_rexec()` + `timeout`) — **built
   via the `cross` cc-wrapper, NOT the kernel's `fake-llvm` shim**. fake-llvm left
   `-shared` as a clang driver flag → reactor crt + `--gc-sections` collected ALL
   applet code into a 700-byte empty module; the cross wrapper picks the command
   crt so `main` seeds the applets.
2. **8 KiB user stack → 4 MiB** (`patches/kernel/0007`, `binfmt_wasm.c`). musl
   `realpath()` alone uses 8 KiB of stack buffers and overflowed it (NOMMU can't
   grow the stack) — this was BOTH the "readlink -f corrupts long paths" bug AND
   the nix.wasm "memory access out of bounds" startup crash. 4 MiB (not 8) so the
   alloc+arg-extra fits an available order-11 buddy block.
3. **9P buffered reads** — `cache=loose,ignoreqv` (see Platform/kernel above).
4. **single-user nix** (`userspace/system.nix`): `build-users-group=""` (no nixbld
   members) + `filter-syscalls=false` (wasm has no seccomp) — both otherwise abort
   `nix-env`.

### ✅ Userspace redesign — Plan 1 (the system closure) DONE
The spike chose **Approach B** (curated `lib.evalModules`; Approach A pulled
systemd/perl/python — rejected). Prior art that validated the shape: **NixNG**
(NixOS sibling, no systemd, pluggable minimal init), `nixos-init-freedom` (the
`boot.systemdExecutable` PID-1 seam). systemd is out (no MMU/cgroups); the guest
has no services so no service manager is built (YAGNI); PID 1 = busybox-init.

`nix build .#wasm-system` now produces a **host-built guest system closure** (9
store paths, ~7.25 MB, **no systemd/perl/python**) generated by real NixOS module
code — `docs/superpowers/{specs,plans}/2026-06-16-nix-userspace-*`:
- `userspace/system.nix` — curated `evalModules` → `/etc` (nix.conf, shells,
  set-environment), the system profile (busybox + ncurses/terminfo), `/etc/profile`.
- `userspace/passwd.nix` — static passwd/group (empty pw, autologin root).
- `userspace/init.nix` — busybox-init inittab (8 hvc getty lines) + autologin.
- `userspace/toplevel.nix` — assembles the boot layout (`etc` + `sw` + `init`).
- Shared fix: generalized the `compiler-rt` triple override (unblocks busybox).
- **TERM=xterm-256color + terminfo are now declarative** (the two hacks this
  redesign was triggered by): getty termtype arg + ncurses terminfo linked into
  the profile + `TERMINFO_DIRS`.

### ✅ Userspace redesign — Plan 2 (bootstrap + in-guest) DONE
The thin initramfs `/init` (`userspace/bootstrap.nix`, generated by Nix — replaces
the hand-written `pc-init`) mounts the pseudofs + the 9P exports, overlays the
served `wasm-system` closure at `/nix`, runs `$sys/activate`, links the guest-tool
seam, then `exec $sys/init`. The served closure is delivered by pc's
`createNixClosureStore` over 9P (real store paths preserved) + the `store.json`
manifest from `userspace/store-manifest.nix`. **Verified end-to-end** (the
acceptance test above): boot → getty → autologin → shell → `nix-env -iA sl` → `sl`
renders. The `pc-init` shell script is retired.

### ⬜ Platform / kernel
- **NOMMU 9P substitution — FIXED (2026-06-17).** The `netfs: Couldn't get user
  pages (rc=-14)` I/O error was 9P `cache=none` (default) + the JS server's
  `qid.version==0` forcing `P9L_DIRECT` → netfs UNBUFFERED reads → `get_user_pages`
  on the user buffer (unsupported on NOMMU/wasm). Fix: mount the read-only exports
  `cache=loose,ignoreqv` (`userspace/bootstrap.nix`) → buffered page-cache reads +
  `copy_to_user`. One-shot `nix-env -iA sl` now substitutes reliably.
- ✅ Kernel is nixified (`kernel.nix`, `.#kernel` → `vmlinux.wasm`); 2026-06-17
  added patch 0007 (user stack 8KiB→4MiB — see below).
- ⬜ **Guest-clang** (`clang.wasm`/`wasm-ld.wasm`) still vendored prebuilt in pc;
  nixify it (Phase 3) so the guest can *compile*, not just install.

### ⬜ Caching / CI (the design goal — see § Caching strategy below)
- Binary cache at scale: publish host-built `cross.*` + user packages; guest
  substitutes arbitrary packages without building in-guest.
- CI on `x86_64-linux` to populate the cache (avoid from-source LLVM on aarch64).

### ⬜ Robustness long-tail (not blocking the acceptance test)
- **Remaining busybox vfork applets** — `tar`, `wget`, `crond`, `runit`, `script`
  still `vfork` (SIGILL if used). Same clone-with-fn pattern as 0001/0003/0004.
- **`timeout` watcher quirk** — `timeout PROG` execs PROG (sl renders), but its
  re-exec'd *watcher* mis-parses the injected `-pPID` (getopt `+` stops at the
  duration first) so the timeout isn't enforced. Benign for self-exiting progs.
- **Bigger user stack** — 4 MiB is capped by the 512 MiB guest's largest free
  buddy order; more guest RAM would allow 8 MiB (Linux default) for heavy progs.

### ⬜ Housekeeping
- Branch `nix-userspace-boot` (nix-wasm) holds this session's work — decide merge
  to `master`. pc work is on its linux-wasm branch.
- `flake.nix` still carries the `spawn-test-initramfs` diagnostic — drop when tidy.

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
