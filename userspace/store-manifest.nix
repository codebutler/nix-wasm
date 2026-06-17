# .#wasm-store-manifest — the wasm-system closure exported for pc's
# createNixClosureStore to serve at REAL store paths (overlay lowerdir). Outputs:
#   $out/store.json       — the manifest:
#     { "store/<hash>-name/...": {t:"d"}
#                              | {t:"f",x:bool,d:"<base64>"}        (small, inline)
#                              | {t:"f",x:bool,s:<size>,h:"<sha256>"} (large, lazy)
#                              | {t:"l",to:"<target>"} , ... ,
#       "var/nix/profiles/system": {t:"l", to:"/nix/store/<hash>-wasm-system"} }
#   $out/store-content/<sha256>  — content-addressed blobs for the large files,
#     fetched LAZILY by the closure store on first read (toolchain binaries, etc),
#     so boot doesn't download the whole toolchain (~145MB) up front.
# Symlink targets are stored as their raw value (closure-internal symlinks are
# absolute /nix/store/... paths); the profile symlink is likewise absolute so it
# resolves in-guest. Intermediate parent dirs (store, var, var/nix, ...) are NOT
# all emitted as explicit {t:"d"} entries — the consumer (createNixClosureStore)
# creates missing parents on write (mkdir -p semantics).
# Keys are RELATIVE to /nix (pc mounts the export at /nix). Includes the full
# runtime closure (busybox, ncurses, terminfo, the toolchain, etc) so
# /run/current-system/sw and the /etc symlink tree resolve in-guest.
{ pkgs, toplevel }:
let
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "wasm-store-manifest"
  { nativeBuildInputs = [ pkgs.python3 ]; }
  ''
    mkdir -p $out
    python3 ${./store-manifest.py} \
      "${closure}/store-paths" "${toplevel}" "$out/store.json" "$out/store-content"
    echo "store.json: $(du -h $out/store.json | cut -f1)"
    echo "store-content: $(du -sh $out/store-content 2>/dev/null | cut -f1) ($(ls $out/store-content 2>/dev/null | wc -l) blobs)"
  ''
