# glib-selftest — in-guest gobject proof (M3a). Links cross glib/gobject and
# exercises a generic-marshaller double signal (validates the M1 libffi f64 path).
{ cross, glib, libffi, pcre2, zlib }:
cross.stdenv.mkDerivation {
  pname = "glib-selftest";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [ cross.buildPackages.pkg-config cross.buildPackages.binaryen ];
  buildInputs = [ glib libffi pcre2 zlib ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    CFLAGS="$($PKG_CONFIG --cflags gobject-2.0) -O2"
    LDLIBS="$($PKG_CONFIG --libs gobject-2.0) -lffi -lm"
    $CC $CFLAGS ${./glib-selftest.c} $LDLIBS -o glib-selftest.pre

    # M3a (gobject blocker): glib relies on function-pointer casts — e.g.
    # `(GClassInitFunc) g_object_do_class_init` (gobject.c:904), where
    # g_object_do_class_init is a 1-arg `(GObjectClass*)` function stored into a
    # GTypeInfo and later called as the 2-arg `GClassInitFunc(g_class,class_data)`.
    # On a normal ABI the extra arg is harmless; wasm's call_indirect is STRICTLY
    # typed, so the 1-arg callee invoked through a 2-arg call_indirect traps with
    # "null function or function signature mismatch" inside the very first
    # g_object_new → type_class_init_Wm. LLVM-21's bitcast-fixup pass can't see
    # the cast (opaque pointers leave no IR bitcast to rewrite), and there is no
    # clang/wasm-ld flag for it. binaryen's --fpcast-emu rewrites every
    # call_indirect to a canonical wide signature with adapter thunks, so the
    # mismatched indirect call dispatches correctly. (Validated: it preserves the
    # dylink imports/exports — __memory_base/__table_base, the syscall imports,
    # __wasm_apply_data_relocs — and the libffi raw f64 marshaller path.)
    wasm-opt \
      --enable-threads --enable-bulk-memory --enable-mutable-globals \
      --enable-nontrapping-float-to-int --enable-sign-ext \
      --enable-reference-types --enable-multivalue \
      -pa max-func-params@128 --fpcast-emu \
      glib-selftest.pre -o glib-selftest
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 glib-selftest $out/bin/glib-selftest
    runHook postInstall
  '';
  meta.description = "gobject + libffi-marshaller selftest (M3a), wasm32";
}
