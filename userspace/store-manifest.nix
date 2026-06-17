# .#wasm-store-manifest — the wasm-system closure exported as store.json for pc's
# createNixClosureStore to serve at REAL store paths (overlay lowerdir). Format:
#   { "store/<hash>-name/...": {t:"d"} | {t:"f",x:bool,d:"<base64>"} | {t:"l",to:"<target>"} , ... ,
#     "var/nix/profiles/system": {t:"l", to:"/nix/store/<hash>-wasm-system"} }
# Symlink targets are stored as their raw value (closure-internal symlinks are
# absolute /nix/store/... paths); the profile symlink is likewise absolute so it
# resolves in-guest. Intermediate parent dirs (store, var, var/nix, ...) are NOT
# all emitted as explicit {t:"d"} entries — the consumer (createNixClosureStore)
# creates missing parents on write (mkdir -p semantics).
# Keys are RELATIVE to /nix (pc mounts the export at /nix). Includes the full
# runtime closure (busybox, ncurses, terminfo, etc) so /run/current-system/sw
# and the /etc symlink tree resolve in-guest.
{ pkgs, toplevel }:
let
  closure = pkgs.closureInfo { rootPaths = [ toplevel ]; };
in
pkgs.runCommand "wasm-store-manifest"
  { nativeBuildInputs = [ pkgs.python3 ]; }
  ''
    mkdir -p $out
    python3 ${./store-manifest.py} \
      "${closure}/store-paths" "${toplevel}" "$out/store.json"
    # report size (eager base64 is the first cut; optimize to lazy/binary later).
    echo "store.json: $(du -h $out/store.json | cut -f1)"
  ''
