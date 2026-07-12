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
# TWO ways to apply it, ONE pass definition (`passCmd` below) so the exact
# wasm-opt invocation lives in a single place:
#
#   1. `hook` — a nixpkgs SETUP HOOK, auto-applied to every gtk3 consumer: the
#      cross `gtk3` override (deps-overlay.nix) puts it in its
#      `propagatedNativeBuildInputs`, so any derivation linking gtk3 fpcasts its
#      installed $out/bin wasm executables with ZERO per-package lines — the
#      correctness pass can't be forgotten on a new GTK app. It runs in an
#      idempotent `postFixupHooks` step (propagation can register it twice).
#      A consumer that fpcasts its OWN binary (a mid-buildPhase temp object, a
#      non-`bin` artifact, or a hand-ordered dynsym+fpcast sequence) sets
#      `dontFpcastEmu = true` so the auto pass does not double-apply. fpcast is
#      a correct/no-op on any gobject binary, so it is safe to apply to gtk3
#      libraries too. A non-gtk3 gobject binary (librsvg) adds `hook` to its own
#      nativeBuildInputs explicitly.
#
#      ORDERING with dynsym-inject (dynsym.nix): the auto pass runs in
#      `postFixupHooks`, which `runHook` fires AFTER the derivation's own
#      `postFixup` body, so a GModule app that does NOT set `dontFpcastEmu` can
#      keep just its `dynsym_inject … $out/bin/x` in `postFixup` and the pass
#      fpcasts the injected binary afterwards (dynsym-first / fpcast-second).
#
#   2. `shellFn` — the raw `fpcast_emu <in.wasm> <out.wasm>` shell function for
#      the manual callers above (gtk-hello, gtk-demo, widget-factory, gcalctool,
#      galculator, the games, dltest, the *-selftests). Source it with
#      `${fpcast.shellFn}`.
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

  # The setup-hook script: define fpcast_emu, then register an idempotent
  # postFixup hook that fpcasts every installed wasm executable, unless the
  # derivation fpcasts its own (`dontFpcastEmu`).
  hookScript = cross.buildPackages.writeText "wasm-fpcast-setup-hook.sh" ''
    ${fpcastEmuFn}

    _fpcastEmuAllBins() {
      # Idempotency: propagation can source/register this hook twice.
      if [ -n "''${__fpcastEmuDone:-}" ]; then return 0; fi
      __fpcastEmuDone=1
      if [ -n "''${dontFpcastEmu:-}" ]; then return 0; fi
      local outName outDir exe
      for outName in $outputs; do
        outDir="''${!outName}/bin"
        [ -d "$outDir" ] || continue
        for exe in "$outDir"/*; do
          [ -f "$exe" ] || continue
          # Only touch actual wasm modules (magic "\0asm" = 00 61 73 6d).
          # Skips shell wrappers / config scripts a package installs in bin.
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
  # back-compat; `shellFn`/`hook` already call wasm-opt by absolute path.
  inherit binaryen;

  # The auto hook. Lives in cross gtk3's propagatedNativeBuildInputs
  # (deps-overlay.nix), so every gtk3 consumer fpcasts its wasm bins with no
  # per-package line. `dontFpcastEmu` opts a manual consumer out. A non-gtk3
  # gobject binary (librsvg) adds it explicitly to nativeBuildInputs.
  inherit hook;

  # Raw `fpcast_emu <in> <out>` function, for buildPhase / non-bin / hand-ordered
  # callers. Sourced via `${fpcast.shellFn}`.
  shellFn = fpcastEmuFn;
}
