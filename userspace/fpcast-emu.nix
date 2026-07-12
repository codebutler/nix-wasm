# fpcast-emu — binaryen --fpcast-emu post-link pass for glib/gobject/GTK binaries.
# gobject stores a 1-arg fn in a 2-arg slot and calls it indirectly; wasm's strict
# call_indirect traps on the arity mismatch. --fpcast-emu canonicalises indirect
# calls so it dispatches. Applied per-binary (not in the cc-wrapper — it rewrites
# the whole call_indirect ABI). Two forms, one pass (`passCmd`):
#   hook    — rides gtk3's propagatedNativeBuildInputs, so every gtk3 consumer
#             auto-fpcasts its $out/bin wasm executables, no per-package line.
#             `dontFpcastEmu = true` opts out a consumer that fpcasts its own
#             binary. A non-gtk3 gobject binary (librsvg) adds it explicitly.
#             Runs in postFixupHooks (after the derivation's postFixup, so a
#             dynsym_inject step lands first). Idempotent.
#   shellFn — raw `fpcast_emu <in> <out>` for buildPhase / hand-ordered callers.
# A C++/-fwasm-exceptions binary would also need --enable-exception-handling in
# passCmd; all current guest gobject binaries are pure C.
{ cross }:
let
  binaryen = cross.buildPackages.binaryen;

  # The pass — single source of truth. $1 = in.wasm, $2 = out.wasm.
  passCmd = ''
    ${binaryen}/bin/wasm-opt \
      --enable-threads --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-reference-types --enable-multivalue \
      -pa max-func-params@128 --fpcast-emu \
      "$1" -o "$2"'';

  fpcastEmuFn = ''
    fpcast_emu() {
      ${passCmd}
    }
  '';

  hookScript = cross.buildPackages.writeText "wasm-fpcast-setup-hook.sh" ''
    ${fpcastEmuFn}

    _fpcastEmuAllBins() {
      if [ -n "''${__fpcastEmuDone:-}" ]; then return 0; fi   # propagation can register twice
      __fpcastEmuDone=1
      if [ -n "''${dontFpcastEmu:-}" ]; then return 0; fi
      local outName outDir exe
      for outName in $outputs; do
        outDir="''${!outName}/bin"
        [ -d "$outDir" ] || continue
        for exe in "$outDir"/*; do
          [ -f "$exe" ] || continue
          # wasm magic "\0asm"; skips shell wrappers / config scripts in bin.
          [ "$(dd if="$exe" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "0061736d" ] || continue
          fpcast_emu "$exe" "$exe.fpcast.tmp"
          mv "$exe.fpcast.tmp" "$exe"
          chmod +x "$exe"
        done
      done
    }

    postFixupHooks+=(_fpcastEmuAllBins)
  '';

  hook = cross.buildPackages.makeSetupHook { name = "wasm-fpcast-emu-hook"; } hookScript;
in
{
  inherit binaryen hook;
  shellFn = fpcastEmuFn;
}
