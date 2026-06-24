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
  # so `nix-env -iA <attr>` resolves from ~/.nix-defexpr.
  # bootstrap.nix copies /nix-cache/pkgs.nix to ~/.nix-defexpr/pkgs.nix at boot.
  pkgsNix = pkgs.writeText "pkgs.nix" ''
    {
      clang    = builtins.storePath "${builtins.elemAt devPaths 0}";
      cc       = builtins.storePath "${builtins.elemAt devPaths 1}";
      "c++"    = builtins.storePath "${builtins.elemAt devPaths 2}";
      make     = builtins.storePath "${builtins.elemAt devPaths 3}";
      dev-tools = builtins.storePath "${devToolsEnv}";
    }
  '';
in
# Wrap mkBinaryCache's output: symlink its entire tree into $out and add pkgs.nix.
pkgs.runCommand "wasm-binary-cache" { } ''
  # Symlink the cache content (nix-cache-info + narinfo + nar/ + realisations/ + …)
  # into our $out so the caller gets a single store path for the whole cache.
  mkdir -p "$out"
  for f in ${rawCache}/*; do
    ln -s "$f" "$out/$(basename "$f")"
  done
  # Add the pkgs.nix index so the guest's ~/.nix-defexpr resolves `nix-env -iA`.
  cp ${pkgsNix} "$out/pkgs.nix"
''
