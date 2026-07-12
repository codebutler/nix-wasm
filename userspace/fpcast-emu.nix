# fpcast-emu — the SHARED binaryen post-link seam for glib/gobject/GTK binaries.
#
# WHY this exists (the strict-call_indirect cast theme):
#   glib/gobject (and everything built on it — pango, GTK) relies on C
#   function-pointer casts. The canonical case is
#   `(GClassInitFunc) g_object_do_class_init` (gobject.c), where a 1-arg
#   `(GObjectClass*)` function is stored into a GTypeInfo and later invoked as
#   the 2-arg `GClassInitFunc(g_class, class_data)`. On a normal native ABI the
#   surplus argument is harmless; wasm's `call_indirect` is STRICTLY typed, so a
#   1-arg callee reached through a 2-arg `call_indirect` traps with "null
#   function or function signature mismatch" — inside the very first
#   `g_object_new → type_class_init_Wm`. LLVM-21's bitcast-fixup pass can't see
#   the cast (opaque pointers leave no IR bitcast to rewrite), and there is no
#   clang/wasm-ld flag for it.
#
#   binaryen's `--fpcast-emu` rewrites every `call_indirect` to a canonical wide
#   signature with adapter thunks, so the mismatched indirect call dispatches
#   correctly. (Validated: it preserves the dylink imports/exports —
#   __memory_base/__table_base, the syscall imports, __wasm_apply_data_relocs —
#   and the libffi raw f64 marshaller path.)
#
# WHY it is a per-binary POST-LINK pass and NOT a cc-wrapper / global default:
#   --fpcast-emu rewrites the module's call_indirect ABI. Applying it globally
#   (in the cross cc-wrapper) would rewrite EVERY guest binary's indirect-call
#   ABI — including non-glib programs that have no such casts — needlessly
#   changing their ABI and table layout. It belongs only on the gobject/GTK
#   binaries that actually need it, applied as the last link step.
#
# HOW TO APPLY IT — two supported forms, ONE pass definition (`passCmd` below):
#
#   1. `hook` — a nixpkgs SETUP HOOK (the wrapGAppsHook / autoPatchelfHook
#      idiom). Add `fpcast.hook` to a derivation's `nativeBuildInputs` and every
#      wasm executable it installs under `$out/bin` (any output) is fpcast'd
#      automatically in a `postFixupHooks` step — no per-package bash. This is
#      the preferred form for the common "one or more installed binaries" case
#      (l3afpad, librsvg, gcolor3, the games …). It replaces the copy-pasted
#      `postFixup` wasm-opt blocks that used to live in every consumer.
#
#      • Escape hatch: set `dontFpcastEmu = true` to suppress the auto pass
#        (e.g. a derivation that fpcasts a non-`bin` artifact itself).
#      • ORDERING with dynsym-inject (dynsym.nix): the hook runs in
#        `postFixupHooks`, which `runHook` fires AFTER the derivation's own
#        `postFixup` env-var body (the same guarantee autoPatchelfHook relies
#        on). So a GModule binary keeps ONLY its `dynsym_inject … $out/bin/x`
#        step in `postFixup` and the hook fpcasts the injected binary
#        afterwards — the required dynsym-FIRST / fpcast-SECOND order (see
#        dynsym.nix) is preserved with no manual fpcast call. (Converting an
#        already-working dynsym'd override to this form changes its build, so
#        per the PRIME DIRECTIVE it must be BOOT-verified, not flipped blind —
#        migrate one override at a time behind its selftest gate.)
#
#   2. `shellFn` — the raw `fpcast_emu <in.wasm> <out.wasm>` shell function, for
#      derivations that must run the pass at a specific point a postFixup hook
#      can't express: mid-`buildPhase` on a temp object before install
#      (gtk-hello, pango-text, gtk-demo, the *-selftest binaries), or on a
#      non-`bin` artifact / in a hand-ordered dynsym+fpcast sequence
#      (dltest's side .so, widget-factory). Source it with `${fpcast.shellFn}`.
#
#   BOTH forms call the SAME `passCmd`, so the exact wasm-opt invocation (its
#   feature set, the max-func-params width) lives in exactly one place here.
#
# NOTE: the --enable-* set matches what pure-C cross binaries (glib/pango/GTK)
# contain. A future C++/`-fwasm-exceptions` GTK binary that needs this seam must
# also add `--enable-exception-handling` (and `--enable-tail-call` if used),
# else wasm-opt errors on the un-enabled feature present in the binary — extend
# `passCmd` below (the ONE place) if that day comes.
{ cross }:
let
  binaryen = cross.buildPackages.binaryen;

  # THE pass — the single source of truth for the fpcast-emu invocation.
  # Absolute wasm-opt path so neither form depends on binaryen being on PATH.
  # Args: $1 = input wasm, $2 = output wasm.
  passCmd = ''
    ${binaryen}/bin/wasm-opt \
      --enable-threads --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-reference-types --enable-multivalue \
      -pa max-func-params@128 --fpcast-emu \
      "$1" -o "$2"'';

  # The shell-function form (`fpcast_emu in out`), for manual callers.
  fpcastEmuFn = ''
    fpcast_emu() {
      ${passCmd}
    }
  '';

  # The setup-hook script: define fpcast_emu, then register a postFixup hook
  # that fpcasts every wasm executable installed under each output's bin/.
  hookScript = cross.buildPackages.writeText "fpcast-emu-setup-hook.sh" ''
    ${fpcastEmuFn}

    _fpcastEmuAllBins() {
      # Escape hatch for derivations that run the pass themselves.
      if [ -n "''${dontFpcastEmu:-}" ]; then return 0; fi
      local outName outDir exe
      for outName in $outputs; do
        outDir="''${!outName}/bin"
        [ -d "$outDir" ] || continue
        for exe in "$outDir"/*; do
          [ -f "$exe" ] || continue
          # Only touch actual wasm modules (magic "\0asm" = 00 61 73 6d).
          # Skips shell wrappers / config scripts a package may install in bin.
          [ "$(dd if="$exe" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "0061736d" ] || continue
          fpcast_emu "$exe" "$exe.fpcast.tmp"
          mv "$exe.fpcast.tmp" "$exe"
          chmod +x "$exe"
        done
      done
    }

    # runHook fires the derivation's own `postFixup` body BEFORE this array, so
    # a dynsym_inject step in postFixup lands before we fpcast (order preserved).
    postFixupHooks+=(_fpcastEmuAllBins)
  '';

  hook = cross.buildPackages.makeSetupHook
    { name = "wasm-fpcast-emu-hook"; }
    hookScript;
in
{
  # The native binaryen build input (provides `wasm-opt`). Kept exported for
  # back-compat; `shellFn`/`hook` already call wasm-opt by absolute path, so a
  # consumer using either form no longer needs this in nativeBuildInputs.
  inherit binaryen;

  # Preferred form: add to nativeBuildInputs → auto-fpcast every wasm bin.
  inherit hook;

  # Raw `fpcast_emu <in> <out>` function, for buildPhase / non-bin / hand-ordered
  # callers. Sourced via `${fpcast.shellFn}`.
  shellFn = fpcastEmuFn;
}
