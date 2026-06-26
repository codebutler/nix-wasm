# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest, exactly as real Nix
# does against cache.nixos.org. The compiler tools are NOT in the base squashfs;
# they arrive here, on demand.
#
# pkgs     — the NATIVE host pkgs (mkBinaryCache, runCommand, writeText, lib)
# devPaths — the wasm toolchain DERIVATIONS (guestClang, guestCc, guestCxx,
#            makeWasm). The catalogs below are GENERATED from these — one attr per
#            package, named by its real `lib.getName` (no hand-written aliases).
#
# REAL-NIXOS MODEL (codebutler/nix-wasm#1): the cache serves package OUTPUTS and
# their DERIVER (.drv) closures — exactly like a real machine substituting from
# cache.nixos.org. The guest never builds. The two install CLIs take DIFFERENT
# paths through Nix, so there are two catalogs next to the cache:
#   • pkgs.nix — REAL derivation entries (type="derivation" + drvPath + outPath),
#     for `nix-env -iA <name>`. nix-env's realisation SUBSTITUTES the .drv from the
#     cache (then the output) — so the .drv closures MUST be in the cache (that is
#     why rootPaths below includes the drvPaths). This is the smoke-test path.
#   • paths.nix — `builtins.storePath "<outPath>"` entries, for the NEW CLI
#     (`nix profile install -f /nix-cache/paths.nix <name>`). The new CLI turns a
#     *derivation* into a Built{drvPath} and then can NOT obtain a non-local .drv —
#     its queryMissing marks it "unknown" (src/libstore/misc.cc → the #1 "failed to
#     obtain derivation" error), UNLIKE nix-env which substitutes it. So the new
#     CLI installs the OUTPUT path directly (Opaque), sidestepping the .drv: the
#     genuine "install a prebuilt store path" operation, source-free.
# Both require `substitute = true` in the guest nix.conf (userspace/system.nix):
# the new CLI disables substitution when its Internet probe fails unless the
# setting is overridden, even for a `file://` cache that needs no network.
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
  # rootPaths = the package OUTPUTS *and* their DERIVERS (`drv.drvPath`). The
  # output closures back the Opaque installs (paths.nix / nix profile install) AND
  # nix-env's output substitution; the .drv closures back nix-env -iA, which
  # substitutes the .drv from the cache before the output (the new CLI can't, so it
  # never touches them — see the header). The .drv closures live ONLY here, served
  # lazily over 9P — NOT baked into base.squashfs (that seeding was the ~6.7 GB
  # blowup; the cache is fetched on demand, so its size is not a boot cost).
  rawCache = pkgs.mkBinaryCache {
    name = "wasm-binary-cache";
    rootPaths = devPaths ++ map (drv: drv.drvPath) devPaths;
  };

  # pkgs.nix — the `nix-env -iA <name>` catalog (the guest ships no nixpkgs, so
  # this generated attrset is its channel substitute; bootstrap.nix copies it to
  # ~/.nix-defexpr at boot). One attr per package, named by `lib.getName`
  # (`guest-cc`, `make-wasm32`). Each is a REAL derivation value (type="derivation"
  # + drvPath + outPath) — nix-env -iA needs a derivation, and its realisation
  # SUBSTITUTES the .drv from the cache, then the output. (The new CLI can NOT use
  # this file: it forms a Built{drvPath} and then can't obtain a non-local .drv —
  # its queryMissing gives up where nix-env substitutes — so it uses paths.nix
  # below instead.) Emitted as plain store-path strings (not builtins.storePath) so
  # eval never realises them up front; the paths come from the SAME drv objects the
  # cache is built from.
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

  # paths.nix — the `nix profile install -f /nix-cache/paths.nix <name>` catalog.
  # Each attr is the package's OUTPUT path wrapped in `builtins.storePath`, so it
  # carries store-path context and the new CLI resolves it to a DerivedPath::Opaque
  # (an output store path) — NOT a Built{drvPath}. That sidesteps the .drv wall
  # entirely: the install just substitutes the prebuilt output (+ its closure) from
  # the cache, exactly like `nix profile install /nix/store/<hash>-guest-cc`. No
  # sources, no .drv, source-free and substitute-only. (`-f file` eval is impure,
  # so `builtins.storePath` is permitted; it substitutes the output at eval via the
  # same `file:///nix-cache` substituter nix-env uses.)
  pathEntry = drv: ''  ${lib.getName drv} = builtins.storePath "${drv}";'';
  pathsNix = pkgs.writeText "paths.nix" ''
    {
    ${lib.concatMapStringsSep "\n" pathEntry devPaths}
    }
  '';
in
# Wrap mkBinaryCache's output: symlink its entire tree into $out and add the two
# catalogs. This is a PLAIN STANDARD Nix cache (nix-cache-info + *.narinfo + nar/ +
# pkgs.nix + paths.nix) — there is NO bespoke `manifest.json` file index.
# runtime/nix-cache.js resolves files by on-demand HEAD probe (404 → ENOENT),
# exactly as it would against any standard cache (epic #60, Phase 1). Both catalogs
# are reachable by exact path (the guest reads /nix-cache/{pkgs,paths}.nix
# directly; bootstrap.nix copies pkgs.nix to ~/.nix-defexpr for bare `nix-env -iA`).
pkgs.runCommand "wasm-binary-cache" { } ''
  # Symlink the cache content (nix-cache-info + narinfo + nar/ + realisations/ + …)
  # into our $out so the caller gets a single store path for the whole cache.
  mkdir -p "$out"
  for f in ${rawCache}/*; do
    ln -s "$f" "$out/$(basename "$f")"
  done
  # Add the catalogs: pkgs.nix (nix-env -iA) + paths.nix (nix profile install).
  cp ${pkgsNix} "$out/pkgs.nix"
  cp ${pathsNix} "$out/paths.nix"

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
