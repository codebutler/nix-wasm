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
# Usage in a derivation:
#   { ..., fpcast ? import ./fpcast-emu.nix { inherit cross; } }:
#   { nativeBuildInputs = [ ... fpcast.binaryen ];
#     buildPhase = ''
#       $CC ... -o prog.pre
#       ${fpcast.shellFn}
#       fpcast_emu prog.pre prog
#     ''; }
{ cross }:
let
  binaryen = cross.buildPackages.binaryen;
in
{
  # The native binaryen build input (provides `wasm-opt`). Add to nativeBuildInputs.
  inherit binaryen;

  # A shell function `fpcast_emu <in.wasm> <out.wasm>` running the exact pass.
  # Sourced into a buildPhase via `${fpcast.shellFn}`.
  # NOTE: the --enable-* set matches what pure-C cross binaries (glib/pango) contain.
  # A future C++/`-fwasm-exceptions` GTK binary that needs this seam must also add
  # `--enable-exception-handling` (and `--enable-tail-call` if used), else wasm-opt
  # errors on the un-enabled feature present in the binary.
  shellFn = ''
    fpcast_emu() {
      wasm-opt \
        --enable-threads --enable-bulk-memory --enable-mutable-globals \
        --enable-nontrapping-float-to-int --enable-sign-ext \
        --enable-reference-types --enable-multivalue \
        -pa max-func-params@128 --fpcast-emu \
        "$1" -o "$2"
    }
  '';
}
