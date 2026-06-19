# weston-flowers — the REAL upstream weston demo client (clients/flower.c on the
# weston "toytoolkit", clients/window.c + shared/*), cross-compiled to wasm32.
# Wayland Phase 2 (4b M2): the first cairo-backed Wayland client on the stack.
#
# We don't run weston's meson build (it wants the full compositor + EGL/GL +
# pango/fontconfig + libdrm). Instead we compile the MINIMAL toytoolkit subset
# that flower.c links, modeled on wl-eyes.nix:
#   - wayland-scanner runs on the BUILD host (the wasm scanner can't exec) and
#     generates the 7 client-protocol headers + private-code .c that window.c
#     #includes (xdg-shell, viewporter, pointer-constraints, relative-pointer,
#     tablet-v2 from wayland-protocols; color-management-v1 + text-cursor-position
#     from weston's own protocol/).
#   - the cross pkg-config resolves the TARGET .pc files (cairo, pixman, zlib,
#     wayland-client, wayland-cursor, xkbcommon) → static .a + libm.
#
# What we cut (all behind #ifdef or dead code, see the report):
#   - HAVE_PANGO undefined  → no pango/fontconfig/freetype. Decoration title text
#     uses cairo's toy font API against a font-backend-less cairo → silently
#     no-ops. The flower itself is pure vector cairo (what we render).
#   - image-loader.c NOT compiled (needs png/jpeg/webp). cairo-util.c's
#     load_cairo_surface() refs weston_image_load/destroy but is never called →
#     2-line no-op stub satisfies the linker.
#   - frame.c's decoration-button PNGs: our cairo is built WITHOUT png
#     (CAIRO_HAS_PNG_FUNCTIONS undefined), so cairo_image_surface_create_from_png
#     isn't even declared → postPatch guards frame_button_create to return NULL
#     (buttons render blank — fine, this is window chrome, not the flower).
#   - libweston.h (config-parser.c includes it but uses ZERO symbols) → empty stub.
{ cross, cairo, pixman, zlib, wayland, wayland-protocols, libxkbcommon, libffi, src }:
cross.stdenv.mkDerivation {
  pname = "weston-flowers";
  version = "14.0.1";
  inherit src;

  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner # native protocol code generator
    cross.buildPackages.pkg-config      # resolves the TARGET .pc files
  ];
  buildInputs = [ cairo pixman zlib wayland wayland-protocols libxkbcommon libffi ];

  # No meson — we drive the compile by hand in buildPhase.
  dontConfigure = true;

  postPatch = ''
    # frame.c loads decoration-button icons via cairo's PNG reader, which our
    # png-less cairo doesn't provide (CAIRO_HAS_PNG_FUNCTIONS undefined → the
    # function isn't even declared). Skip the load: buttons just don't render
    # (decoration chrome only; the flower itself is unaffected).
    substituteInPlace shared/frame.c \
      --replace-fail \
        'icon = cairo_image_surface_create_from_png(icon_name);' \
        '(void)icon_name; icon = NULL; goto error;'
  '';

  buildPhase = ''
    runHook preBuild

    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner
    WP=${wayland-protocols}/share/wayland-protocols
    # Build from the UNPACKED (postPatch'd) source tree — the cwd in buildPhase —
    # NOT ${src} (the pristine store path), so the frame.c PNG patch is in effect.
    WS=./protocol

    mkdir -p gen
    gen() { # gen <name> <xml>
      "$SCANNER" client-header "$2" "gen/$1-client-protocol.h"
      "$SCANNER" private-code  "$2" "gen/$1-protocol.c"
    }
    # weston-local protocols
    gen color-management-v1   "$WS/color-management-v1.xml"
    gen text-cursor-position  "$WS/text-cursor-position.xml"
    # upstream wayland-protocols
    gen xdg-shell                          "$WP/stable/xdg-shell/xdg-shell.xml"
    gen viewporter                         "$WP/stable/viewporter/viewporter.xml"
    gen pointer-constraints-unstable-v1    "$WP/unstable/pointer-constraints/pointer-constraints-unstable-v1.xml"
    gen relative-pointer-unstable-v1       "$WP/unstable/relative-pointer/relative-pointer-unstable-v1.xml"
    gen tablet-unstable-v2                 "$WP/unstable/tablet/tablet-unstable-v2.xml"

    # Minimal hand-rolled config.h (weston generates this via meson). Leave the
    # optional HAVE_* undefined → simplest/most-portable code paths (musl libc
    # has strchrnul, so define HAVE_STRCHRNUL to avoid os-compatibility.c's
    # redefinition).
    cat > gen/config.h <<'EOF'
#ifndef CONFIG_H
#define CONFIG_H
#define HAVE_STRCHRNUL 1
/* file-util.c datadir fallback. No weston install dir exists in the guest; the
 * value only builds a path that won't resolve (graceful no-op). */
#define DATADIR "/usr/share"
#endif
EOF

    # config-parser.c includes <libweston/libweston.h> for the MODIFIER_* enum
    # (used only by weston_config_get_binding_modifier, dead code for flower).
    # Stub it with just that enum to avoid the full libweston header tree
    # (pixman/wayland-server/drm/...).
    mkdir -p gen/libweston
    cat > gen/libweston/libweston.h <<'EOF'
#ifndef WESTON_FLOWERS_LIBWESTON_STUB_H
#define WESTON_FLOWERS_LIBWESTON_STUB_H
enum weston_keyboard_modifier {
  MODIFIER_CTRL  = (1 << 0),
  MODIFIER_ALT   = (1 << 1),
  MODIFIER_SUPER = (1 << 2),
  MODIFIER_SHIFT = (1 << 3),
};
#endif
EOF

    # The image-loader stubs: cairo-util.c's load_cairo_surface() (dead code for
    # flower) references these; provide no-op definitions instead of compiling
    # image-loader.c (png/jpeg/webp).
    cat > gen/image-loader-stub.c <<'EOF'
#include <stdint.h>
struct weston_image;
struct weston_image *weston_image_load(const char *f, uint32_t flags) {
  (void)f; (void)flags; return 0;
}
void weston_image_destroy(struct weston_image *image) { (void)image; }
EOF

    # -DHAVE_XKBCOMMON_COMPOSE: we have xkbcommon-compose (header on the xkbcommon
    #   include path + the lib's compose objects) → compile the compose-key path
    #   so the struct member refs in window.c line up.
    # (DATADIR is defined in gen/config.h — quoting it on the command line via the
    #  CFLAGS string mangles the embedded quotes when re-split by the shell.)
    CFLAGS="$($PKG_CONFIG --cflags cairo pixman-1 zlib wayland-client wayland-cursor xkbcommon) \
      -D_GNU_SOURCE -DHAVE_CONFIG_H -DHAVE_XKBCOMMON_COMPOSE \
      -I gen -I gen/libweston \
      -I ./include -I ./shared -I ./clients -I . \
      -O2 -Wno-implicit-function-declaration -Wno-error"
    # libwayland-cursor.a bundles its OWN os-compatibility.c (it also defines
    # os_create_anonymous_file) → duplicate-symbol with weston's shared/
    # os-compatibility.c. Our object files come first on the link line, so
    # --allow-multiple-definition makes WESTON's version win — the
    # XDG_RUNTIME_DIR(/tmp)+mkstemp+ftruncate path that wl-eyes already proved
    # works through our kernel/proxy (HAVE_MEMFD_CREATE/HAVE_MKOSTEMP undefined).
    LDLIBS="$($PKG_CONFIG --libs cairo pixman-1 zlib wayland-client wayland-cursor xkbcommon) -lffi -lm -lpthread -Wl,--allow-multiple-definition"

    SRCS="
      ./clients/flower.c
      ./clients/window.c
      ./shared/cairo-util.c
      ./shared/frame.c
      ./shared/file-util.c
      ./shared/os-compatibility.c
      ./shared/config-parser.c
      ./shared/matrix.c
      gen/image-loader-stub.c
      gen/color-management-v1-protocol.c
      gen/text-cursor-position-protocol.c
      gen/xdg-shell-protocol.c
      gen/viewporter-protocol.c
      gen/pointer-constraints-unstable-v1-protocol.c
      gen/relative-pointer-unstable-v1-protocol.c
      gen/tablet-unstable-v2-protocol.c
    "

    echo "Compiling weston-flowers (CC=$CC)..."
    $CC $CFLAGS $SRCS $LDLIBS -o weston-flowers

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 weston-flowers $out/bin/weston-flowers
    runHook postInstall
  '';

  meta.description = "weston-flowers demo (cairo toytoolkit) cross-built to wasm32";
}
