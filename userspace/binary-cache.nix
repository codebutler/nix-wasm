# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest via `nix-env -iA`
# exactly as real Nix does (#43 / folds in #2 + #1). The compiler tools are NOT
# in the base squashfs; they arrive here, on demand.
#
# pkgs     — the NATIVE host pkgs (mkBinaryCache, runCommand, writeText, lib)
# devPaths — the wasm toolchain DERIVATIONS (guestClang, guestCc, guestCxx,
#            makeWasm). The pkgs.nix index is GENERATED from these — one attr per
#            package, named by its real `lib.getName` (no hand-written aliases).
{
  pkgs,
  devPaths,
}:
let
  inherit (pkgs) lib;

  # Build the binary cache using the nixpkgs-blessed builder. It uses
  # exportReferencesGraph to compute full closures inside the sandbox — no
  # in-sandbox `nix copy` needed. Produces: nix-cache-info + *.narinfo + nar/*.nar.zst.
  # NOTE: mkBinaryCache's make-binary-cache.py does NOT emit a Deriver: line,
  # so narinfo will NOT carry Deriver fields (known gap; `nix profile install` won't
  # accept these paths, but `nix-env -iA` works fine — see codebutler/nix-wasm#1).
  rawCache = pkgs.mkBinaryCache {
    name = "wasm-binary-cache";
    rootPaths = devPaths;
  };

  # pkgs.nix — the guest's package catalog, i.e. its channel-substitute: the guest
  # ships no nixpkgs and cannot build (substitute-only), so `nix-env -iA <name>`
  # resolves against THIS list of the prebuilt, substitutable packages in the
  # cache. bootstrap.nix copies /nix-cache/pkgs.nix to ~/.nix-defexpr at boot.
  #
  # GENERATED from devPaths — nothing is hand-declared: one attr per package,
  # named by the package's real `lib.getName` (e.g. `guest-cc`, `make-wasm32`),
  # as a "fake derivation" (type="derivation" + name + outPath) because a bare
  # `builtins.storePath` is a path, not a derivation, and nix-env rejects it.
  entry =
    drv:
    "  ${lib.getName drv} = { "
    + ''type = "derivation"; name = "${drv.name}"; system = "wasm32-linux"; ''
    + ''outPath = "${drv.outPath}"; out = { outPath = "${drv.outPath}"; }; outputs = [ "out" ]; };'';
  pkgsNix = pkgs.writeText "pkgs.nix" ''
    {
    ${lib.concatMapStringsSep "\n" entry devPaths}
    }
  '';
in
# Wrap mkBinaryCache's output: symlink its entire tree into $out, add pkgs.nix,
# and generate manifest.json — the file index consumed by runtime/nix-cache.js.
# Without manifest.json, nix-cache.js falls back to an empty index (only the
# seeded log/nar/realisations dirs), so pkgs.nix is never visible to the guest
# and `nix-env -iA` fails with "attribute not found".
pkgs.runCommand "wasm-binary-cache" { } ''
  # Symlink the cache content (nix-cache-info + narinfo + nar/ + realisations/ + …)
  # into our $out so the caller gets a single store path for the whole cache.
  mkdir -p "$out"
  for f in ${rawCache}/*; do
    ln -s "$f" "$out/$(basename "$f")"
  done
  # Add the pkgs.nix index so the guest's ~/.nix-defexpr resolves `nix-env -iA`.
  cp ${pkgsNix} "$out/pkgs.nix"
  # Generate manifest.json: a JSON array of all relative file paths in the cache.
  # nix-cache.js fetches this on first access to build its file index; a missing
  # manifest degrades to an empty cache (nothing served, no pkgs.nix copy in guest).
  cd "$out"
  # Collect flat files + files under nar/, realisations/, log/ subdirs
  (
    for f in *; do [ -f "$f" ] && printf '"%s"\n' "$f"; done
    for sub in nar realisations log; do
      [ -d "$sub" ] && for f in "$sub"/*; do [ -f "$f" ] && printf '"%s"\n' "$f"; done
    done
  ) | paste -sd ',' - | sed 's/^/[/;s/$/]/' > "$out/manifest.json"
''
