# Pulling in all of nixpkgs — in-guest `nix-env -iA nixpkgs.<pkg>` (2026-06-28)

Goal: let the guest `nix-env -iA nixpkgs.<pkg>` against **real nixpkgs**, exactly
like a real NixOS system, instead of only the 4-entry curated catalog.

## STATUS: DONE — validated end-to-end in the booted guest

On the **shipped flake artifacts** (real `.#wasm-binary-cache` + `.#wasm-base-squashfs`
+ `.#wasm-initramfs`, published kernel), booted headless on an aarch64 host:

```
# nix-env -iA nixpkgs.file        → installs, substituting the wasm output from the cache
# file --version                  → file-5.47   (magic file from /nix/store/…-file-…/share/misc/magic)
# nix-env -iA nixpkgs.hello       → installs
# hello                           → Hello, world!
# nix-env -iA wasm-tools.guest-cc → installs the toolchain channel
# cc --version                    → clang version 21.1.8
# nix-env -q                      → file-static-…-5.47 / guest-cc / hello-static-…-2.12.3
```

i.e. the guest evaluates nixpkgs against the wasm crossSystem, substitutes the
prebuilt wasm output from the cache, installs into the profile, and runs it — the
real-NixOS `nix-env -iA nixpkgs.<pkg>` flow. Two `nix-env` channels:
`nixpkgs.<pkg>` (any package, evaluated vs the cross) and `wasm-tools.<tool>` (the
toolchain), addressed + lazy per channel like real NixOS.

What's installable = what the host publishes (`wasmPublishedPkgs` in flake.nix —
currently file + hello). The channel can EVALUATE any nixpkgs package; only
published outputs SUBSTITUTE — the rest fail to realise, exactly like an uncached
package on a real machine. Most packages won't cross-build to wasm32-NOMMU, so the
published set is curated; grow it as packages are confirmed.

The original spike (below) recorded the walls in order; all are resolved.

## How the experiment was run (no host Nix required)

This box has no Nix, but the published guest is downloadable:

1. `linux.iso` from the `linux` channel
   (`pc-previews…/packages/linux/<ver>/linux.iso`, sha256 == the version hash)
   → extracted `vmlinux.wasm` / `initramfs.cpio.gz` / `base.squashfs` with pc's
   pure-JS `js/vfs/iso9660.js` parser.
2. Booted headless in plain Node via `runtime/index.js` `bootNixSystem`
   (baseUrl-mode over a tiny local HTTP server — avoids Node's missing
   `file:`/`blob:` fetch). Guest reaches a root shell, `nix (Nix) 2.34.7`.
3. Mounted the **pinned nixpkgs source** (rev `9ae611a`, matching `flake.lock`,
   52840 files) into the guest at `/mnt/pc/nixpkgs` by seeding the 9P `MemVfs`
   from the on-disk tree. Eval reads it lazily over 9P (`cache=loose`).

Throwaway harness lives outside the repo (`/home/user/exp/*.mjs`); not committed.

## Walls found, in order

### 1. `builtins.fromTOML` is MISSING from nix.wasm  ← FIXED here

`nix-instantiate /mnt/pc/nixpkgs -A hello` dies immediately:

```
error: undefined variable 'fromTOML'
   at /mnt/pc/nixpkgs/lib/trivial.nix:841:22
```

`lib/default.nix` force-evaluates `trivial.nix`, whose `importTOML = path:
fromTOML (readFile path)` references the **`fromTOML` global builtin**. Nix
resolves free variables against the static env at file-load (bindVars) time, so
a missing global aborts loading `lib` itself — meaning **no nixpkgs package can
be evaluated at all**. Confirmed directly: `builtins ? fromTOML` → false,
`builtins.fromTOML "x=1"` → `error: attribute 'fromTOML' missing`.

Root cause: the wasm port patch (`patches/nix-2.34.7-wasm32-port.patch`) replaces
libexpr's `toml11 = dependency('toml11', method:'cmake', …)` with an empty
`declare_dependency()` — because `method:'cmake'` needs a `cmake` + the toml11
CMake package, neither of which is in the cross sandbox. But that leaves no
`<toml.hpp>` on the include path, so `fromTOML.cc` fails to compile; the build's
`ninja -k0` + "collect whatever `.o` exist" strategy then **silently drops the
TU**, and the `fromTOML` primop is never registered.

**Fix (landed):** toml11 is header-only and architecture-independent, so the
native `pkgs.toml11` (4.4.0) headers work for the wasm target:
- `nix-wasm.nix`: append `-isystem ${pkgs.toml11}/include` to `cxxCommon`.
- patch: `declare_dependency()` → `declare_dependency(version: '4.4.0')` so
  libexpr's `HAVE_TOML11_4 = toml11.version().version_compare('>= 4.0.0')`
  resolves to 1 (selects the toml11-v4 API path in `fromTOML.cc`).

NOT yet rebuilt/validated here (no host Nix) — correct-by-construction, to be
confirmed by a `.#nix-wasm` rebuild + re-running the eval probe (lib should load
past `trivial.nix`). `fromTOML` is the **only** missing builtin on the lib-load
path: with a diagnostic `fromTOML` stub, eval proceeds through all of `lib` into
the stdenv bootstrap (next wall) without any other `undefined variable`.

### 2. Native eval → `error: unsupported libc` (expected — needs crossSystem)

With `fromTOML` stubbed, `nix-instantiate /mnt/pc/nixpkgs -A file` evaluates all
of `lib` and into `pkgs/stdenv/booter.nix`, then fails:

```
error: unsupported libc
   at …/pkgs/stdenv/booter.nix (default stdenv selection)
```

This is **not** a Nix bug — a plain `import <nixpkgs> {}` evaluates for the
guest's native `system` (wasm32-linux), for which nixpkgs has no stdenv. The
project already solves this on the host via the **crossSystem** config
(`wasm-cross.nix` + `deps-overlay.nix` + `config.replaceCrossStdenv` injecting the
prebuilt clang stdenv). So in-guest eval must import nixpkgs the SAME way:
`import nixpkgs { crossSystem = wasm; localSystem = …; overlays = [deps-overlay];
config.replaceCrossStdenv = …; }`.

## crossSystem eval PROVEN in-guest (the M1 make-or-break)

The key question for M1 — does `wasm-cross.nix`'s `cross.<pkg>` actually *evaluate*
in-guest, within memory? — is answered **yes**. Shipping the repo's cross config
(`wasm-cross.nix` + `deps-overlay.nix` + `toolchain/` + `patches/`) alongside the
fromTOML-stubbed nixpkgs into the guest (over the 9P `/mnt/pc` mount) and pinning
`localSystem = "x86_64-linux"`, the guest evaluated:

```
nix-instantiate <channel> -A hello → …-hello-static-wasm32-unknown-linux-musl-2.12.3.drv   (17.5s)
nix-instantiate <channel> -A file  → …-file-static-wasm32-unknown-linux-musl-5.47.drv      (15.5s)
```

real wasm32 `.drv`s, no OOM/panic, only the benign no-`--add-root` GC warning.
This works because `wasm-cross.nix` takes an explicit `localSystem` and the cross
derivations are host-agnostic, so **eval is pure and architecture-independent** —
pinning `localSystem` to the build host makes the guest compute the SAME `.drv`
hashes the host builds (so it can substitute the host's prebuilt output). `hello`
/`file` don't touch `importTOML`, so the diagnostic stub does not perturb their
`.drv` hashes — these match the real (fromTOML-fixed) eval and the host.

## The path to "install anything" (M1)

1. **[done] Restore `fromTOML`** so nixpkgs `lib` loads in-guest (the toml11 fix).
2. **[landed — needs a nix build to validate] The channel artifact.**
   `userspace/wasm-nixpkgs-channel.nix` → `.#wasm-nixpkgs-channel`: a small store
   path with the cross config + a generated `default.nix` that returns
   `cross // { guest-cc/guest-cxx/guest-clang/make-wasm32 }`. nixpkgs is reached via
   `<nixpkgs>` (NOT an absolute store-path ref), so the channel closure stays small
   and a plain `nix-env -iA guest-cc` doesn't drag nixpkgs in (lazy `//` access);
   only a nixpkgs attr (`-iA file`) forces it. `binary-cache.nix` gains
   `extraRootPaths` so the channel + the pinned nixpkgs source are published for
   on-demand substitution. **Validate:** `nix build .#wasm-nixpkgs-channel`, then
   `nix eval --raw -f <out>/default.nix file.drvPath` should print a wasm `file.drv`.
3. **[DONE] Two `nix-env` channels in `~/.nix-defexpr` (bootstrap.nix) + NIX_PATH
   (system.nix).** Real-NixOS addressing: `nixpkgs.<pkg>` (the cross set) and
   `wasm-tools.<tool>` (the toolchain pkgs.nix), lazy per channel so a tool install
   never forces the nixpkgs eval/fetch. The CI smokes were updated to the
   `wasm-tools.` prefix.
4. **[DONE] Realisation = substitute the published output.** `wasmPublishedPkgs`
   (flake.nix) roots each curated package's outputs into the cache; `nix-env -iA
   nixpkgs.<pkg>` substitutes + installs. Unpublished packages eval but fail to
   realise (the guest can't run the x86_64 build inputs) — like an uncached package.

### Two extra fixes found ONLY by booting the guest (not by eval/correct-by-construction)

- **Channel delivery — squashfs, not the nix-cache 9P.** The channel is a DIRECTORY
  tree; `runtime/nix-cache.js` serves only the flat binary-cache protocol (HEAD/GET
  files, `list` only for seeded dirs), so `stat(/nix-cache/channel)` 404'd and the
  guest could not traverse it (`import /nix-cache/channel` → "No such file or
  directory"). Fix: bake the ~1.3 MB channel into the **base squashfs** (a real
  on-disk dir) and have bootstrap point the `nixpkgs` defexpr at that store path.
  nixpkgs stays in the cache (a flat store path → standard substitution works).
- **Publish ALL of a package's outputs.** nix-env installs `meta.outputsToInstall`
  (e.g. `[out man]` for file). Rooting only the default `out` left `man` unsubstitutable,
  so nix fell back to BUILDING `file.drv` → its 587-derivation build closure → fetch
  bash/python/autoconf sources → no network → fail. `allOutputs` in flake.nix roots
  every output of each published package.

The substitute-on-access assumption held: `<nixpkgs>` (a missing store path in
NIX_PATH) substitutes the 470 MB nixpkgs source from the cache the first time a
nixpkgs attribute is evaluated, in the guest's RAM-backed store, within the cap.

## `file` specifically

Cannot be installed from unmodified nixpkgs **today** — blocked at wall #1 (no
`fromTOML` → lib unevaluable), not by anything about `file`. After the toml11 fix
+ M1 crossSystem wiring it will *evaluate*; whether it *builds* then depends on
`file` (+ its deps: zlib, etc.) cross-building and/or being in the cache.

## Eval feasibility (memory) — partial

Single-attr eval forced only the relevant closure and stayed responsive within
the guest's ~2 GiB cap up to the stdenv wall; `nix-env -qaP` (forces ALL attrs)
is the heavier case and is still unmeasured.
