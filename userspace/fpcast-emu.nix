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
#   1. `hook` — a nixpkgs SETUP HOOK (the libxml2-setupHook idiom), AUTO-APPLIED
#      to every gtk3 consumer: the cross `gtk3` override (deps-overlay.nix) puts
#      this hook in its `propagatedNativeBuildInputs`, so any derivation that
#      links gtk3 sources it with ZERO per-package lines. In a single idempotent
#      `postFixupHooks` step it:
#        (a) fpcasts every wasm executable the derivation installs under any
#            output's `bin/` — the correctness pass every gobject binary needs,
#            now impossible to forget on a new GTK app; and
#        (b) IF the derivation opts in with `wasmLeafApp = true`, strips its
#            `$out/nix-support` served-closure dead weight (the #43 cleanup).
#
#      WHY fpcast is default-ON but leaf-clean is opt-IN: the hook reaches gtk3
#      *libraries* too (anything linking gtk3), and fpcast is a correct/no-op on
#      any gobject binary — safe to apply universally. But the nix-support strip
#      would delete a LIBRARY's real propagated-build-inputs metadata that
#      downstream builds need, so it must NEVER fire by default — only a leaf
#      APP (nothing links it) sets `wasmLeafApp = true`.
#
#      Escape hatches:
#      • `dontFpcastEmu = true` — a derivation that fpcasts its OWN binary (a
#        mid-buildPhase temp object, a non-`bin` artifact, or a hand-ordered
#        dynsym+fpcast sequence) sets this so the auto pass does not DOUBLE-apply
#        on top of its manual one. Every currently-manual gtk3-linking consumer
#        (gtk-hello/gtk-demo/widget-factory/gcalctool/galculator/the games) sets
#        it and keeps its existing manual fpcast unchanged.
#      • `wasmLeafApp = true` — opt IN to the leaf nix-support strip (l3afpad,
#        librsvg, gcolor3, …).
#
#      ORDERING with dynsym-inject (dynsym.nix): the auto pass runs in
#      `postFixupHooks`, which `runHook` fires AFTER the derivation's own
#      `postFixup` env-var body (the guarantee autoPatchelfHook relies on). So a
#      GModule app that does NOT set `dontFpcastEmu` can keep just its
#      `dynsym_inject … $out/bin/x` in `postFixup` and the auto pass fpcasts the
#      injected binary afterwards — dynsym-FIRST / fpcast-SECOND preserved. (The
#      existing games/gcalctool instead set `dontFpcastEmu` and keep their whole
#      manual dynsym+fpcast, unchanged, until each is boot-verified onto the
#      auto path one at a time — PRIME DIRECTIVE: no blind glib/gtk3 flip.)
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

  # The setup-hook script: define fpcast_emu, then register an idempotent
  # postFixup hook that (1) fpcasts every wasm executable installed under each
  # output's bin/ unless `dontFpcastEmu`, and (2) strips $out/nix-support only
  # when the derivation opts in with `wasmLeafApp`. Propagated from gtk3, so it
  # can be registered more than once (transitive dep paths) — the run guard
  # makes a second invocation a no-op.
  hookScript = cross.buildPackages.writeText "wasm-gtk-app-setup-hook.sh" ''
    ${fpcastEmuFn}

    _wasmGtkAppFinalize() {
      # Idempotency: propagation can source/register this hook twice.
      if [ -n "''${__wasmGtkAppFinalizeDone:-}" ]; then return 0; fi
      __wasmGtkAppFinalizeDone=1

      # (1) fpcast every installed wasm executable. `dontFpcastEmu` opts out
      #     (a derivation that runs the pass itself — manual/dynsym consumers).
      if [ -z "''${dontFpcastEmu:-}" ]; then
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
      fi

      # (2) LEAF-app closure hygiene (the #43 lesson): $out/nix-support/
      #     propagated-build-inputs records gtk+3-dev, dragging the whole X11 /
      #     glibc-locale `-dev` tree into the SERVED store closure for an app
      #     nothing ever links against. OPT-IN via `wasmLeafApp` — a LIBRARY
      #     that links gtk3 also sources this hook and MUST keep its propagation
      #     metadata, so this never fires by default. Only $out is touched (a
      #     $dev output's nix-support is real downstream link metadata).
      if [ -n "''${wasmLeafApp:-}" ] && [ -e "''${out:-}/nix-support" ]; then
        rm -rf "$out/nix-support"
      fi
    }

    # runHook fires the derivation's own `postFixup` body BEFORE this array, so
    # a dynsym_inject step in postFixup lands before we fpcast (order preserved).
    postFixupHooks+=(_wasmGtkAppFinalize)
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

  # The auto hook. Lives in cross gtk3's propagatedNativeBuildInputs
  # (deps-overlay.nix), so every gtk3 consumer fpcasts its wasm bins with no
  # per-package line. `dontFpcastEmu` opts a manual consumer out; `wasmLeafApp`
  # opts a leaf app INTO the $out/nix-support strip. A non-gtk3 gobject binary
  # (librsvg) still adds it explicitly to nativeBuildInputs.
  inherit hook;

  # Raw `fpcast_emu <in> <out>` function, for buildPhase / non-bin / hand-ordered
  # callers. Sourced via `${fpcast.shellFn}`.
  shellFn = fpcastEmuFn;
}
