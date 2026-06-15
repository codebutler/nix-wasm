# Plan: build nix.wasm *with Nix*, not shell scripts (#139/#141)

## The problem we keep hitting

`nix.wasm` is currently produced by two hand-written shell scripts plus two
hand-written C stub files:

| File | What it does (by hand) | Why it keeps backfiring |
|---|---|---|
| `nixdeps/build-sysroot.sh` | `configure && make` for **14 deps** (zlib, bzip2, xz, sodium, sqlite, brotli, libarchive, openssl, editline, blake3, toml11, njson, curl, boost_url, git2) into a flat sysroot | Every dep has a flag we have to get exactly right. `xz --enable-threads` pulled pthread/static-init → **startup SIGILL**. Each divergence costs hours to bisect because the failure is a wasm trap at boot, not a build error. |
| `nixbuild/build-nix-wasm.sh` | clones nix, `sed`-patches meson, builds, **hand-collects `.o` files** with `find`, hand-links with `wcxx` | The collector silently missed 224/290 objects once (glob mismatch). `sed` meson patches are invisible and unversioned. |
| `nixbuild/misc-stubs.c` | fake `lzma_stream_encoder_mt` / `lzma_cputhreads` | Only exists because *our* liblzma was built wrong. A correctly-built liblzma has the right symbols. |
| `nixbuild/git2-stubs.c` | fake libgit2 symbols | Only exists because we didn't build real libgit2. |

Root cause: **we are hand-rolling a cross-compile toolchain + dependency
closure that Nix already knows how to produce reproducibly.** Every shortcut
in the shell scripts is a place for the wasm/musl/NOMMU divergence to hide,
and it always surfaces as an un-greppable SIGILL.

## What already works (and proves the real path)

`/home/vbvntv/nix-spike/` is a **working wasm crossSystem**. It builds real
nixpkgs package definitions, cross-compiled to `wasm32-unknown-linux-musl`,
that **run in the guest**:

- `wasm-cross.nix` — `crossSystem` + `config.replaceCrossStdenv` injects our
  prebuilt wasm `cc` into a *platform-correct* cross stdenv (cc-wrapper drops
  `-fPIE`/`-march`/`-dynamic-linker`, salted rpath suppression, baked guest
  kernel headers). nixpkgs pin: `50ab79378…` (in `flake.lock`).
- `result-sl`, `result-ncurses`, `result-busybox` → **live `/nix/store`
  paths**. `sl` and a full busybox userspace boot in the guest today.

The decisive fact: in that pkg set, **`cross.sqlite`, `cross.curl`,
`cross.boost`, `cross.libgit2`, `cross.brotli`, `cross.editline`,
`cross.libsodium`, `cross.libarchive`, `cross.nlohmann_json`, `cross.xz`,
`cross.bzip2`, `cross.openssl` are all already cross-compiled to wasm by
nixpkgs**, with the *correct* flags for the platform, for free. We don't have
to build a single one of them by hand.

## The plan

Build Nix the same way we build busybox: a derivation that takes our patched
Nix source and cross-builds it through the crossSystem stdenv, taking its
dependency closure from `cross.*`. **Zero shell scripts. Zero stub C files.**

### Step 1 — `nix-wasm.nix` (mirrors the proven `busybox-wasm.nix`)

```nix
{ cross, buildPackages, nixSrc }:
cross.stdenv.mkDerivation {
  pname = "nix"; version = "2.34.7";
  src = nixSrc;                                   # our pinned 2.34.7 tarball
  patches = [
    ./patches/nix-2.34.7-wasm32-port.patch        # EXISTING, 18KB — the real port
    ./patches/nix-2.34.7-wasm32-config.patch       # NEW: replaces the sed hacks
  ];
  nativeBuildInputs = with buildPackages; [ meson ninja pkg-config ];
  buildInputs = with cross; [                      # ← all cross-built to wasm already
    boost brotli libsodium sqlite curl libgit2
    editline libarchive nlohmann_json xz bzip2 openssl
  ];
  mesonFlags = [
    "--default-library=static"
    "-Ddoc_generation=false" "-Dtests=false"       # cut closure + link size
    # …disable the daemon / unused features we don't run in-guest
  ];
  # The wasm TLS exports the guest crt needs, as a versioned flag — not a sed:
  NIX_LDFLAGS = "-Wl,--export=__set_tls_base -Wl,--export=__libc_handle_signal "
              + "-Wl,--export-if-defined=…";
}
```

`$out/bin/nix` **is** the wasm binary (our cc-wrapper + wasm-ld produce wasm).
Copy it to `scripts/linux-demo/guest-clang/nix.wasm`. One `nix-build` replaces
both shell scripts.

### Step 2 — convert the `sed`/`misc-stubs` hacks into versioned patches

Everything `build-nix-wasm.sh` did with `sed` becomes a real patch file in
`patches/` (reviewable, diffable, survives a rebuild):

- `AT_SYMLINK_NOFOLLOW` meson check → force-1 (the symlink-mtime fix that makes
  `nix-env -iA sl` succeed).
- drop `close_range` from the unix func check (NOMMU has no syscall).
- force `HAVE_UTIMENSAT` + `HAVE_DECL_AT_SYMLINK_NOFOLLOW`.

`misc-stubs.c` and `git2-stubs.c` are **deleted** — `cross.xz` (single-threaded
on this platform) and `cross.libgit2` provide the real symbols.

### Step 3 — wire it into the spike's `flake.nix` / `cross.nix`

Add `packages.nix-wasm` alongside `sl` / `busybox`. `nix build .#nix-wasm`
produces the binary reproducibly from the pinned nixpkgs + our patches.

### Step 4 — a thin extract step (the only non-Nix glue, ~5 lines)

A tiny wrapper copies `$(nix build --print-out-paths .#nix-wasm)/bin/nix` to
`guest-clang/nix.wasm`. This is a *copy*, not a build — no compile logic lives
outside Nix.

### Step 5 — verify in the guest (unchanged harnesses)

1. `exec-nix.mjs` → `nix --version` must **not** SIGILL.
2. `exec-nixenv.mjs` → `nix-env -iA sl` installs by name + runs `sl`.

### Step 6 — delete the liabilities

Once the nix-built binary passes Step 5, remove:
`nixdeps/build-sysroot.sh`, `nixdeps/out/` sysroot, `nixbuild/build-nix-wasm.sh`,
`misc-stubs.c`, `git2-stubs.c`. Replace `nixbuild/README` with the one
`nix build .#nix-wasm` command.

## Risks (honest)

1. **nixpkgs' deps may need a wasm tweak.** A few `cross.*` deps might fail to
   cross-build to wasm out of the box (ncurses already needed an overlay; so did
   busybox). Mitigation: the *same* overlay pattern we already use — and it's a
   real build error to fix, not a silent SIGILL.
2. **meson cross-detection + our LDFLAGS export flags.** Need to confirm meson
   threads `NIX_LDFLAGS` to wasm-ld. Likely; if not, it's a `mesonFlags` entry.
3. **First build is slower** than the incremental `.o` cache — but it's
   reproducible and Nix-cached after the first run. We trade minutes-once for
   not-losing-hours-per-divergence.
4. **Patch rebase** if we move off 2.34.7 (see decision below).

## Decisions for Eric

1. **Nix version source.** Build *our pinned 2.34.7 tarball + the existing 18KB
   port patch* through the cross stdenv (least patch drift — recommended), or
   override nixpkgs' own `nixVersions.*` derivation (more "blessed", but rebases
   our port patch onto whatever version nixpkgs pins)?
2. **OK to delete** `build-sysroot.sh` / `build-nix-wasm.sh` / the stub `.c`
   files / the `nixdeps/out` sysroot once `.#nix-wasm` verifies in-guest?
3. **Scope now:** do the full migration (Steps 1–6), or first prove Step 1+5
   (nix builds through the stdenv and boots) before deleting anything?
