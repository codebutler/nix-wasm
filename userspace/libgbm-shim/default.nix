# libgbm-shim — abort-stub libgbm.a + gbm.h for Sommelier on wasm32-nommu.
#
# minigbm (chromiumos gbm) is NOT in the pinned nixpkgs (9ae611a).
# Mesa's libgbm IS in nixpkgs but is the full GL stack — explicitly wrong here.
#
# Sommelier links libgbm but NEVER calls it on the wl_shm/virtwl path:
# ctx->gbm stays null and every call site is guarded by that check.
# We only need libgbm.a + gbm.h to satisfy the linker. All symbols abort() —
# provably unreachable at runtime (ctx->gbm is never set without a /dev/dri).
#
# This is the documented fallback from the task-1 brief.
{ stdenv }:
stdenv.mkDerivation {
  pname = "libgbm-shim";
  version = "0.1.0";

  src = ./.;

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    # Compile the shim: one .c → .o → static archive
    $CC -c gbm-shim.c -o gbm-shim.o -I.
    $AR rcs libgbm.a gbm-shim.o
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm644 libgbm.a  $out/lib/libgbm.a
    install -Dm644 gbm.h     $out/include/gbm.h
    # Provide a pkg-config file so Sommelier's meson can find -lgbm
    mkdir -p $out/lib/pkgconfig
    cat > $out/lib/pkgconfig/gbm.pc <<EOF
prefix=$out
exec_prefix=$out
libdir=$out/lib
includedir=$out/include

Name: gbm
Description: Generic Buffer Management (wasm32 abort-stub)
Version: 0.1.0
Libs: -L$out/lib -lgbm
Cflags: -I$out/include
EOF
    runHook postInstall
  '';

  meta = {
    description = "Minimal gbm abort-stub shim for Sommelier link (wasm32-nommu)";
  };
}
