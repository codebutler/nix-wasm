# binary-cache.nix — the on-demand packages (compiler toolchain + demo pkgs)
# published as a STANDARD Nix binary cache (nix-cache-info + narinfo + nar/),
# served by runtime/nix-cache.js and substituted in-guest via `nix-env -iA`
# exactly as real Nix does (#43 / folds in #2 + #1). The compiler tools are NOT
# in the base squashfs; they arrive here, on demand.
#
# pkgs        — the NATIVE host pkgs (mkBinaryCache, runCommand, buildEnv, writeText)
# devPaths    — list of cross/wasm store paths (guestClang, guestCc, guestCxx, makeWasm)
# devToolsEnv — a buildEnv/symlinkJoin of devPaths (pre-built by the caller so
#               its store path is stable for the pkgs.nix index)
{
  pkgs,
  devPaths,
  devToolsEnv,
}:
let
  # Build the binary cache using the nixpkgs-blessed builder. It uses
  # exportReferencesGraph to compute full closures inside the sandbox — no
  # in-sandbox `nix copy` needed. Produces: nix-cache-info + *.narinfo + nar/*.nar.zst.
  # NOTE: mkBinaryCache's make-binary-cache.py does NOT emit a Deriver: line,
  # so narinfo will NOT carry Deriver fields (known gap; `nix profile install` won't
  # accept these paths, but `nix-env -iA` works fine).
  rawCache = pkgs.mkBinaryCache {
    name = "wasm-binary-cache";
    rootPaths = devPaths ++ [ devToolsEnv ];
  };

  # The pkgs.nix expression file: maps attr names → substitutable store paths
  # as fake derivations so `nix-env -iA <attr>` resolves from ~/.nix-defexpr.
  # bootstrap.nix copies /nix-cache/pkgs.nix to ~/.nix-defexpr/pkgs.nix at boot.
  # Each attr uses a "fake derivation" (type="derivation" + outPath + name) —
  # plain builtins.storePath returns a path not a derivation and nix-env rejects it.
  pkgsNix = pkgs.writeText "pkgs.nix" (
    let
      mkFakeDrv = sp: name:
        ''{ type = "derivation"; name = "${name}"; outPath = "${sp}"; out = { outPath = "${sp}"; }; outputs = [ "out" ]; }'';
      clangPath    = builtins.elemAt devPaths 0;
      ccPath       = builtins.elemAt devPaths 1;
      cxxPath      = builtins.elemAt devPaths 2;
      makePath     = builtins.elemAt devPaths 3;
      devToolsPath = devToolsEnv;
      # Extract name from store path (drop "/nix/store/<32-char-hash>-")
      pname = sp: builtins.substring 44 (builtins.stringLength (toString sp) - 44) (toString sp);
    in ''
      {
        clang     = ${mkFakeDrv clangPath    (pname clangPath)};
        cc        = ${mkFakeDrv ccPath       (pname ccPath)};
        "c++"     = ${mkFakeDrv cxxPath      (pname cxxPath)};
        make      = ${mkFakeDrv makePath     (pname makePath)};
        dev-tools = ${mkFakeDrv devToolsPath (pname devToolsPath)};
      }
    ''
  );
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
