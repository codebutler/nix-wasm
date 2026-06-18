# nix-wasm

Build the **Nix package manager** — and the entire toolchain it needs — for the
`wasm32-linux-musl` **NOMMU** guest that runs inside [pc](https://github.com/codebutler/pc)'s
in-browser Linux, **entirely through Nix derivations**. No hand-rolled build
scripts, no fake stubs: every artifact is a reproducible Nix build.

The end goal is bigger than `nix.wasm`: it's that **the pc-linux userspace is
created by Nix** — "NixOS, in the browser." `nix.wasm` is the keystone (once the
guest has a working Nix, it can install packages); this repo builds it and the
toolchain it stands on.

## Status (2026-06-17)

| Layer | State |
|---|---|
| **wasm toolchain** (musl, compiler-rt, libc++, kernel headers, sysroot) | ✅ **built & validated** against the known-good linux-wasm artifacts |
| **crossSystem cc-wrapper** (clang-21 over the nix-built sysroot) | ✅ builds C **and C++** packages |
| **C dependency closure** (zlib, sqlite, openssl, curl, libgit2, boost, …) | ✅ **all 13 cross-compile** (`nix build .#dep-…`) |
| **`nix.wasm`** (Nix 2.34.7 itself) | ✅ **builds** — `nix build .#nix-wasm` → a 19 MB wasm dylink module |
| arbitrary nixpkgs packages (`hello`, `sl`, …) | ✅ **many build with no overlay entry** — static is a platform property (`crossSystem.isStatic`) |
| **in-guest `nix --version`** (runs on the pc guest, no SIGILL) | ✅ **passes** — `nix (Nix) 2.34.7` via the pc headless-kernel harness (`exec-nix.mjs`) |
| **in-guest `nix-env -iA sl`** (install a package by name) | ✅ **passes** — substitutes `sl` from a binary cache, installs to the profile, exit 0 |
| **guest userspace** (curated NixOS-module closure + patched busybox, boots) | ✅ **boots** — served `/nix` overlay → busybox-init → getty → autologin → root shell |
| **in-guest compiler** (`cc`/`c++`, clang-21+lld→wasm, all Nix-built) | ✅ **compiles C & C++ in-browser** (`cc -O2 hello.c && ./hello`) |
| **in-guest autotools** (`./configure && make && ./prog`) | ✅ **works end-to-end** — forkshell ash is `/bin/sh` |
| **guest kernel** (`vmlinux.wasm`) | ✅ **nix-built** from the pinned joelseverin/linux wasm port |
| CI + binary cache (the host-builds-guest-substitutes model) | ⬜ planned — [issue #2](https://github.com/codebutler/nix-wasm/issues/2) |

See **[docs/STATUS.md](docs/STATUS.md)** for the detailed log: what works, what's
next, and what didn't work (the dead-ends, so they're not repeated).

## How to build

The Nix daemon here runs as root, so commands are `sudo`, and flakes must be
enabled:

```sh
export NIX_CONFIG="experimental-features = nix-command flakes"

# A toolchain stage (these all work today):
sudo -E nix build .#musl --no-link --print-out-paths
sudo -E nix build .#libcxx --no-link --print-out-paths

# A cross-compiled C dependency (the smoke test):
sudo -E nix build .#crossZlib --no-link --print-out-paths

# The goal — builds today → $out/bin/nix (a wasm dylink module):
sudo -E nix build .#nix-wasm --print-out-paths
```

> **Note:** `sudo -E` is ignored in some setups ("preserving the entire
> environment is not supported"); if so, pass the flake config inline instead:
> `sudo nix --extra-experimental-features 'nix-command flakes' build .#nix-wasm`.

LLVM 21 is the toolchain; on `aarch64-linux` the binary cache lacks the exact
LLVM build, so the **first** build compiles LLVM from source (~1–2 h, cached
after). On `x86_64-linux` (and CI) it substitutes from cache.

**Caching is a design goal, not an accident.** We want the **host** to build from
cache (cache-friendly pin + `x86_64` + a wasm-artifact cache) and the **guest** to
*substitute* pre-built wasm artifacts rather than build in-guest. From-source
host rebuilds are a failure mode to design out. See
[docs/STATUS.md § Caching strategy](docs/STATUS.md#caching-strategy-a-goal-not-just-an-observation).

## Repo layout

```
flake.nix              entry point — exposes the toolchain stages, cross set, nix-wasm
flake.lock             pinned nixpkgs (nixos-unstable @ 9ae611a, has clang 21.1.8)
wasm-cross.nix         the crossSystem: clang-21 cc-wrapper over the nix-built sysroot
deps-overlay.nix       per-dep NON-static cross fixes (musl, compiler-rt triple, kernel headers, feature trims); static is platform-level via crossSystem.isStatic in wasm-cross.nix
nix-wasm.nix           builds Nix 2.34.7 → nix.wasm (meson compile + the wasm hand-link)
toolchain/             the wasm toolchain, as focused Nix derivations:
  musl.nix             musl 1.2.5 + 8 patches (harness wasm-arch + 7 pc fixes)
  compiler-rt.nix      LLVM-21 compiler-rt builtins for wasm32
  kernel-headers.nix   joelseverin/linux wasm UAPI headers
  libcxx.nix           LLVM-21 libc++/libc++abi/libunwind for wasm
  sysroot.nix          assembles musl + kernel headers into the cc sysroot
patches/               the kernel/musl/nix source patches
docs/                  the detailed STATUS log (current state, dead-ends; future work is in GitHub issues)
```

## Two layers — important distinction

- **`nix.wasm`'s own build deps** (the ~13 libs Nix links): a closed, fixed set.
- **Packages users install in the guest** (`sl`, `hello`, …): an open set that
  comes from **nixpkgs via the crossSystem** — *not* hand-written.

The fixes in `deps-overlay.nix` override `cross.curl`/`cross.openssl`/… at the
package-set level, so they are **shared**: the same fix serves `nix.wasm` *and*
every user-installable package that uses that dep. That's why this repo builds
deps through nixpkgs (fixing the cross machinery) rather than writing private
per-package recipes — the latter wouldn't generalize to user installs.

## License

Patches under `patches/` derive from musl, the Linux kernel, LLVM,
and Nix — see their respective upstream licenses.
