# Pulling in all of nixpkgs — in-guest eval spike (2026-06-28)

Goal: let the guest `nix-env -iA <anything>` against **real nixpkgs** ("at least
try to install things"), instead of the 4-entry curated catalog. This note
records the live experiment, the walls found (in order), and the fix landed for
the first one.

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

## The path to "install anything" (M1)

1. **[done] Restore `fromTOML`** so nixpkgs `lib` loads in-guest.
2. **Ship nixpkgs + the crossSystem default-expr into the guest** (replacing the
   generated 4-entry `/nix-cache/pkgs.nix` that `bootstrap.nix` copies to
   `~/.nix-defexpr`). Pinned nixpkgs as a read-only volume (reuse the
   base-squashfs / virtio-blk machinery, or a substitutable store path) + a
   `default.nix` that applies our `crossSystem`/overlay; point `NIX_PATH` /
   `~/.nix-defexpr` at it.
3. **Realisation:** eval yields a `.drv`; substitute its closure if pre-built,
   else build from source (#92 path — works for simple derivations; full
   stdenv/autotools needs the cross stdenv closure as build inputs).

After (1)+(2), `nix-env -qaP` lists all of nixpkgs and `-iA <attr>` evaluates +
attempts realisation. Most packages still won't cross-build to wasm32-NOMMU, so
this is "at least try," not "everything works" — but it is the open catalog.

## `file` specifically

Cannot be installed from unmodified nixpkgs **today** — blocked at wall #1 (no
`fromTOML` → lib unevaluable), not by anything about `file`. After the toml11 fix
+ M1 crossSystem wiring it will *evaluate*; whether it *builds* then depends on
`file` (+ its deps: zlib, etc.) cross-building and/or being in the cache.

## Eval feasibility (memory) — partial

Single-attr eval forced only the relevant closure and stayed responsive within
the guest's ~2 GiB cap up to the stdenv wall; `nix-env -qaP` (forces ALL attrs)
is the heavier case and is still unmeasured.
