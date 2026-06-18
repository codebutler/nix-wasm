# CLAUDE.md — nix-wasm

Build `nix.wasm` (Nix for the `wasm32-linux-musl` NOMMU guest) and its toolchain,
**entirely through Nix**. This file is the operating guide AND the record of
current state and hard-won learnings — read it before doing anything.

## PRIME DIRECTIVE (non-negotiable)

**DO THINGS CORRECTLY. No shortcuts. No hacks. No stubs.** Every artifact is a
reproducible Nix derivation. The OLD approach (hand-written shell scripts +
fake-lib stubs) has been deleted — it lives in git history; the Nix derivations
are the only build path.

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

### Boot-test the built guest — in-repo runtime/ harness

nix-wasm now both *builds* the guest and *runs* it. The `runtime/` package
(kernel host + 9P server + Nix store wiring) runs in Node and the browser; pc
vendors it via `runtime/sync-to-pc.sh`.

Artifacts (`vmlinux.wasm`, `initramfs.cpio.gz`, `store.json`, `nix-cache/`) come
from `nix build` (`.#vmlinux`, `.#wasm-initramfs`, `.#wasm-store-manifest`). Point
at them via `LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/` for the Node CLI, or
symlink `web/artifacts → /path/to/artifacts` for the browser demo. Local-dev
fallback: pc's vendored set (`vendor/linux-wasm/` in a pc checkout).

Run these from the **runtime/** directory:

```sh
# Engine unit tests (79 tests, no artifacts needed):
bun run test

# Node integration tests:
node --test node/

# Full nix-system smoke: boot → 9P read/write/ls → nix-env -iA sl.
# Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/smoke.mjs

# Interactive guest root shell (Ctrl-] to quit).
# --no-nix = fast busybox-only boot when you don't need the /nix overlay.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/attach.mjs [--no-nix]

# Browser demo (serves runtime/web/ with COOP/COEP for SharedArrayBuffer):
ln -sfn /path/to/artifacts web/artifacts && node web/serve.mjs [port]
# Headless Playwright smoke (asserts WEB_OK):
node web/smoke.mjs
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

`node/` and `web/` are tooling/demo (tsc-excluded); `web/vendor/ghostty` is
vendored (excluded from all three static gates).

## Current state

**It works end-to-end** (2026-06-17). `nix build .#nix-wasm` builds the wasm Nix;
the dep closure (`cross.*`), the kernel, and the curated guest userspace all build
reproducibly. In the runtime harness (`runtime/node/smoke.mjs`) the
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
(guest-cc `--gc-sections` + a loader data-relocs guard — see the guest-compile
SIGILL note in agent memory + `toolchain/guest-cc.nix`); `c++` adds `-D__linux__`
(libc++ pthread thread-API selection on the `-unknown` triple) + `--allow-undefined`
(the host-provided `__cpp_exception` wasm-EH tag), with libc++ shipped in
`cc-sysroot` (`sys/cxx`).

**In-guest autotools also works** (2026-06-17): a real autoconf `./configure &&
make && ./prog` runs end-to-end in the guest. The guest `/bin/sh` is busybox's
**forkshell ash** (busybox-w32 lineage, NOMMU fork-without-exec over `posix_spawn`;
`userspace/ash.nix` + `userspace/ash-cb-guest.c`), promoted to `/bin/sh` in
`bootstrap.nix`. Six forkshell/spawn/shell fixes made autoconf's preamble,
`$()`/subshell/pipeline, and `config.status` work (full record in the
`userspace/ash.nix` postPatch comments + the `patches/busybox/ash/*` patches + git
history). The old "hush isn't POSIX-enough" gap is closed.

Remaining: **Phase 5** (CI + binary cache — the design goal below: build on
x86_64, publish the wasm outputs, guest substitutes; issue #2).
One known wrinkle folded into Phase 5: in-guest installs use `nix-env -iA` (the
cache index is `outPath`-only "fake derivations"); `nix profile install` rejects
those for lacking a `drvPath` — shipping real `.drv`s in the published closure
fixes it (codebutler/nix-wasm#1). Archive ops work: `tar` (czf/xzf, patched) is
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
- **crt `int main`**: a weak 2-arg crt `main` wrapper (`musl.nix`) so all of
  `int main(void)` / `(int,char**)` link — else autoconf's "C compiler cannot
  create executables" aborts every autoconf dep.

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
  parent mid-function → `fork()`/`vfork()` SIGILL/abort. Everything that "spawns"
  (busybox, ash, `make`, nix's external `sh` builder) goes through `posix_spawn` /
  clone-with-fn; this is why busybox + ash carry the clone-with-fn patches.
- **9P read-only mounts MUST be `cache=loose,ignoreqv`** (`bootstrap.nix`). Default
  `cache=none` → netfs *unbuffered* reads → `get_user_pages` on the user buffer
  (unsupported on NOMMU/wasm) → `rc=-14`. Loose = buffered page-cache + `copy_to_user`.
- **User stack 8 KiB→4 MiB** (`patches/kernel/0007`): musl `realpath()` alone
  overflows 8 KiB and NOMMU can't grow the stack (was both the "readlink -f
  corrupts long paths" bug and the nix.wasm startup "memory access out of bounds").
  4 MiB (not 8) so the alloc fits an order-11 buddy block.
- **Single-user nix** (`userspace/system.nix`): `build-users-group = ""` +
  `filter-syscalls = false` (no seccomp on wasm) — either otherwise aborts `nix-env`.
- **`store-manifest` splits large files into lazy `store-content/<sha256>` blobs**
  so the ~113 MB toolchain fetches on first exec, not at boot.

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

- **#2** — Phase 5: CI + binary cache (build wasm outputs on x86_64, guest
  substitutes). The last phase; see the Caching design goal above.
- **#3** — retire the `cc`/`c++` shell wrappers by making `clang`/`clang++`
  their own driver for the wasm target (config file / custom ToolChain), gated on
  whether LLVM's linker spawn uses `posix_spawn` on the NOMMU port.
- **#1** — `nix profile install` rejects the `outPath`-only guest index (use
  `nix-env -iA`); fix folds into #2.

(The executed per-task plans — toolchain, userspace, kernel-nixify, guest-shell
forkshell-ash — the rationale/master-plan docs, and the detailed STATUS log were
removed once done; the code, this file, and git history are the record.)
