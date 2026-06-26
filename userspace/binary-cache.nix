# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest, exactly as real Nix
# does against cache.nixos.org. The compiler tools are NOT in the base squashfs;
# they arrive here, on demand.
#
# pkgs     — the NATIVE host pkgs (mkBinaryCache, runCommand, writeText, lib)
# devPaths — the wasm toolchain DERIVATIONS (guestClang, guestCc, guestCxx,
#            makeWasm). The pkgs.nix catalog is GENERATED from these — one attr per
#            package, named by its real `lib.getName` (no hand-written aliases).
#
# REAL-NIXOS MODEL (codebutler/nix-wasm#1): this cache serves package OUTPUTS
# only. The catalog entries are REAL derivations (they carry the real `drvPath`,
# not just an `outPath`), so the new CLI forms a Built{drvPath} and substitutes
# the already-built output — identical to how a normal machine installs from
# cache.nixos.org. Two pieces make this work on the network-less guest, neither a
# bespoke workaround:
#   • `substitute = true` in the guest nix.conf (userspace/system.nix) — the new
#     CLI (`nix profile`/`nix build`) otherwise disables substitution when its
#     Internet probe fails, even for a `file://` cache that needs no network.
#   • the catalog packages' DERIVER (.drv) closures are seeded into the guest
#     store and registered VALID at boot (flake.nix `wasmDrvSeed` →
#     base-squashfs.nix → bootstrap.nix `nix-store --load-db`). Nix NEVER
#     substitutes a .drv from a cache (src/libstore/misc.cc queryMissing marks a
#     non-local .drv "unknown" → the #1 "failed to obtain derivation" error), so
#     the .drv must be present locally — exactly like a real system after eval.
#     With the .drv local, the new CLI reads it and substitutes the cache-valid
#     output WITHOUT building. (Publishing .drv closures in THIS cache would be
#     useless — Nix never fetches them; that earlier approach was a dead end.)
# `nix-env -iA <name>` and `nix profile install <name>` both work against this.
{
  pkgs,
  devPaths,
}:
let
  inherit (pkgs) lib;

  # Build the binary cache using the nixpkgs-blessed builder. It uses
  # exportReferencesGraph to compute full closures inside the sandbox — no
  # in-sandbox `nix copy` needed. Produces: nix-cache-info + *.narinfo + nar/*.nar.zst.
  #
  # rootPaths = the package OUTPUTS only. The cache substitutes outputs; the .drv
  # files are NOT served here (Nix never fetches a .drv from a cache — see the
  # header). The derivers reach the guest a different way: they are seeded VALID
  # into the guest store at boot (flake.nix `wasmDrvSeed`), so `nix profile install`
  # finds the local .drv and substitutes the matching output from this cache.
  rawCache = pkgs.mkBinaryCache {
    name = "wasm-binary-cache";
    rootPaths = devPaths;
  };

  # pkgs.nix — the guest's package catalog (its channel substitute). The guest
  # ships no nixpkgs to evaluate, so this generated attrset stands in for one:
  # `nix-env -iA <name>` / `nix profile install -f /nix-cache/pkgs.nix <name>`
  # resolve a package against it. bootstrap.nix copies it to ~/.nix-defexpr at boot.
  #
  # GENERATED from devPaths — one attr per package, named by its real
  # `lib.getName` (e.g. `guest-cc`, `make-wasm32`). Each entry is a REAL derivation
  # value: `type = "derivation"` + name + system + the real `drvPath` + `outPath` +
  # outputs — the same shape Nix's own generated channel/manifest expressions use.
  # The earlier catalog omitted `drvPath` (an "outPath-only fake derivation"), which
  # is exactly why `nix profile install` rejected it with "is not a derivation";
  # carrying the real drvPath makes it a normal derivation both CLIs accept.
  #
  # drvPath/outPath are emitted as plain store-path strings (not `builtins.storePath`)
  # so guest evaluation never has to realise them up front — Nix coerces + substitutes
  # them lazily when it actually installs, the same way the outPath has always been
  # carried. The paths come from the SAME drv objects the cache is built from, so the
  # catalog and the cache can never disagree on a hash.
  entry =
    drv:
    "  ${lib.getName drv} = { "
    + ''type = "derivation"; name = "${drv.name}"; system = "wasm32-linux"; ''
    + ''drvPath = "${drv.drvPath}"; ''
    + ''outPath = "${drv.outPath}"; out = { outPath = "${drv.outPath}"; }; outputs = [ "out" ]; };'';
  pkgsNix = pkgs.writeText "pkgs.nix" ''
    {
    ${lib.concatMapStringsSep "\n" entry devPaths}
    }
  '';
in
# Wrap mkBinaryCache's output: symlink its entire tree into $out and add pkgs.nix.
# This is a PLAIN STANDARD Nix cache (nix-cache-info + *.narinfo + nar/ + pkgs.nix)
# — there is NO bespoke `manifest.json` file index. runtime/nix-cache.js resolves
# files by on-demand HEAD probe (404 → ENOENT), exactly as it would against any
# standard cache, so nothing here enumerates the tree for it (epic #60, Phase 1).
# pkgs.nix is reachable by its exact path (the guest reads /nix-cache/pkgs.nix
# directly at boot — bootstrap.nix copies it to ~/.nix-defexpr).
pkgs.runCommand "wasm-binary-cache" { } ''
  # Symlink the cache content (nix-cache-info + narinfo + nar/ + realisations/ + …)
  # into our $out so the caller gets a single store path for the whole cache.
  mkdir -p "$out"
  for f in ${rawCache}/*; do
    ln -s "$f" "$out/$(basename "$f")"
  done
  # Add the pkgs.nix catalog so the guest's ~/.nix-defexpr resolves installs.
  cp ${pkgsNix} "$out/pkgs.nix"

  # Assert the cache actually SERVES each catalog package's OUTPUT (the narinfo for
  # /nix/store/<hash>-name is <hash>.narinfo). The new CLI realises Built{drvPath}
  # from the locally-seeded .drv, then substitutes THIS output; a missing output
  # narinfo would be a 30-minutes-later boot failure, so catch it at build time.
  miss=0
  for p in ${lib.concatMapStringsSep " " (drv: "${drv}") devPaths}; do
    h=$(basename "$p"); h=''${h%%-*}
    if [ ! -e "$out/$h.narinfo" ]; then
      echo "ERROR: output narinfo $h.narinfo ($p) is NOT in the cache — nix" \
           "profile install / nix-env cannot substitute it." >&2
      miss=1
    fi
  done
  [ "$miss" = 0 ] || { echo "wasm-binary-cache: output narinfos missing — see above" >&2; exit 1; }
  echo "wasm-binary-cache: all catalog output narinfos present"
''
