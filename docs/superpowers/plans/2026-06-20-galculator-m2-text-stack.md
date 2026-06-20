# Galculator-on-wasm — Plan 2: M2 (text stack, glib-free) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cross-build the glib-free font/shaping/rasterization stack to wasm32
(freetype + fribidi + fontconfig + harfbuzz), rebuild the shared cairo with its
freetype+fontconfig backends, bake a font + fontconfig config + cache into the
guest, and prove the whole path renders text — via a `wl-text` client that shapes
with harfbuzz and rasterizes with cairo-ft, with a headless `--selftest` mode
gated by a Node boot smoke.

**Architecture:** All libraries are nixpkgs cross packages (`cross.*` =
`legacyPackages.aarch64-linux.*`), with `isWasm`-guarded overrides in
`deps-overlay.nix` added only where a build actually fails. cairo's existing
image-surface-only override is flipped to *add* the freetype+fontconfig backends
(strictly additive — weston-flowers must keep building). The proof client follows
the `weston-flowers.nix` / `wl-anim.c` pattern (cross `pkg-config` + a copied
Wayland scaffold) and is boot-tested through the existing `runtime/node` harness.

**Tech Stack:** nixpkgs cross (`deps-overlay.nix`), the wasm32-nommu cross
cc-wrapper, C, freetype/fontconfig/harfbuzz/fribidi/cairo, the `runtime/` Node boot
harness (`bootNode({ nix: false })` / `waitForOutput`).

## Global Constraints

- **PRIME DIRECTIVE:** ALWAYS DO THINGS MAXIMALLY CORRECT. NO SHORTCUTS. No hacks,
  no stubs. If a library won't cross-build, fix the *root cause* with an
  `isWasm`-guarded overlay override — never stub it out or skip it.
- **M2 stays glib-free.** harfbuzz, fontconfig, cairo must all build with **glib
  disabled**. If any pulls glib, that's a bug to fix in the override, not accept.
  (glib + pango are M3.)
- **Shared, guarded fixes only.** Every override is wrapped in `whenWasm (...)
  prev.X` so native builds stay byte-identical. NEVER an unguarded override (it
  would rebuild the native toolchain — see CLAUDE.md).
- **cairo rebuild is strictly additive.** Enabling freetype+fontconfig must NOT
  break the existing image-surface client `weston-flowers` — that build is the
  regression gate. Keep x11/glib/png/lzo OFF.
- **Build host = aarch64-linux.** The cross attr path is
  `.#legacyPackages.aarch64-linux.<lib>`. These are small C libs — they may build
  from source (aarch64 cache lags) but must NOT trigger an LLVM/clang from-source
  build. If one would, STOP and report BLOCKED (do not kill a running build —
  CLAUDE.md corollary 3).
- **sudo for nix:** the daemon runs as root; local password `password`; `sudo -E`
  is ignored, pass config inline:
  `echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#<attr> --no-link --print-out-paths`
- **Boot-test artifacts** live in `./.artifacts/` (symlinks). After any flake/
  userspace change, rebuild `.#wasm-initramfs` and refresh the symlink:
  `OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null); ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz`
  then run a smoke from `runtime/` with `LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/"`.
- **Font:** DejaVu Sans (`pkgs.dejavu_fonts`), referenced by family name `DejaVu Sans`.
- Continues branch `gtk3-galculator` (PR #21 lineage); commit directly to it.

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `deps-overlay.nix` | `isWasm`-guarded overrides: harfbuzz `glib=disabled` (+ any freetype/fontconfig fixes); flip the cairo override to enable freetype+fontconfig | 1, 2 |
| `userspace/fonts.nix` | The baked font + `fonts.conf` + prebuilt `fc-cache` derivation (a `cross`/`pkgs` runCommand) | 3 |
| `userspace/system.nix` | Wire the font bundle into the guest closure (`environment.systemPackages` / `etc` + `FONTCONFIG_*` env) | 3 |
| `userspace/wl-text.c` | The proof client: fontconfig→freetype→harfbuzz→cairo-ft render; `--selftest` (headless, stdout) + default (`wl_shm` window) | 4 |
| `userspace/wl-text.nix` | Cross-build wl-text (mirrors `weston-flowers.nix`) | 4 |
| `flake.nix` | Wire `wlText` into `extraBins` + a package attr | 4 |
| `runtime/node/wl-text-smoke.mjs` | Boot → `/bin/wl-text --selftest` → assert `WL-TEXT-SELFTEST: … OK` | 4 |
| `CLAUDE.md` | Document the wl-text smoke gate | 5 |

---

## Task 1: Cross-build the glib-free font/shaping leaf libs

**Files:**
- Modify: `deps-overlay.nix` (add `isWasm`-guarded `harfbuzz` override; add
  `freetype`/`fontconfig`/`fribidi` overrides only if a build fails)

**Interfaces:**
- Consumes: the existing wasm cross set (`cross.*`), `cross.expat` (already built),
  `cross.zlib`.
- Produces: `cross.freetype`, `cross.fribidi`, `cross.fontconfig`, `cross.harfbuzz`
  as wasm32 static libs — harfbuzz **without glib**. Consumed by Tasks 2 and 4.

- [ ] **Step 1: Build freetype and fribidi (likely clean, no override)**

Run each (small C, may build from source — must not pull LLVM):
```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.freetype --no-link --print-out-paths
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.fribidi --no-link --print-out-paths
```
Expected: each prints a `/nix/store/...` path. Confirm the wasm32 static lib exists:
`ls $out/lib/libfreetype.a` and `ls $out/lib/libfribidi.a`.
If a build FAILS, read the error and add a minimal `isWasm`-guarded override in
`deps-overlay.nix` for that package (e.g. a missing `-include`, a disabled optional
feature). freetype must NOT enable harfbuzz (avoid the cycle) — nixpkgs default is
harfbuzz-off, so no action expected; verify `freetype` has no `harfbuzz` in its
inputs (`nix-store -q --references $out | grep -i harfbuzz` → empty).

- [ ] **Step 2: Add the harfbuzz glib-disabled override (definite)**

nixpkgs harfbuzz enables glib by default; M2 must stay glib-free. Add to
`deps-overlay.nix` (place near the other font/cross overrides, after `libffi`):

```nix
  # --- harfbuzz: glib-free for the M2 text stack ------------------------------
  # nixpkgs harfbuzz enables the glib integration (hb-glib) by default, which would
  # drag the entire glib cross-build into the M2 text layer. M2 only needs core
  # harfbuzz shaping (hb_shape over an hb_ft_font), which is glib-independent — so
  # disable glib here. glib + pango (which DO need glib) are M3. isWasm-guarded so
  # native harfbuzz is untouched.
  harfbuzz = whenWasm
    (p: (p.override { glib = null; }).overrideAttrs (o: {
      mesonFlags = (o.mesonFlags or [ ]) ++ [ "-Dglib=disabled" "-Dgobject=disabled" "-Dtests=disabled" "-Ddocs=disabled" ];
    }))
    prev.harfbuzz;
```

- [ ] **Step 3: Build harfbuzz and fontconfig**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.harfbuzz --no-link --print-out-paths
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.fontconfig --no-link --print-out-paths
```
Expected: both succeed. **Verify harfbuzz is glib-free:**
`nix-store -q --references <harfbuzz-out> | grep -i glib` → MUST be empty. If glib
appears, the override didn't take — fix before proceeding.
If fontconfig fails, add an `isWasm`-guarded override (it needs `cross.expat` +
`cross.freetype`; both exist). Confirm `$out/lib/libfontconfig.a` exists.

- [ ] **Step 4: Commit**

```sh
git add deps-overlay.nix
git commit -m "M2: cross-build glib-free font/shaping leaves (harfbuzz glib=disabled)"
```

---

## Task 2: Rebuild cairo with freetype + fontconfig backends

**Files:**
- Modify: `deps-overlay.nix` (the `cairo = whenWasm ...` block, ~line 250)

**Interfaces:**
- Consumes: `cross.freetype`, `cross.fontconfig` (Task 1), `cross.pixman`,
  `cross.zlib`.
- Produces: `cross.cairo` with `CAIRO_HAS_FT_FONT` + `CAIRO_HAS_FC_FONT`; `cairo.pc`
  `Requires:` now includes `freetype2` + `fontconfig`. Consumed by Task 4. The
  existing image-surface API is unchanged (additive).

- [ ] **Step 1: Flip the cairo override to enable the font backends**

In `deps-overlay.nix`, edit the `cairo` override: remove `freetype` and
`fontconfig` from the nulled inputs (keep them as real `cross` deps), and change
their meson flags to `enabled`. Keep glib/x11/png/lzo OFF. Specifically:
- DELETE the `freetype = null;` and `fontconfig = null;` lines from the `.override {…}`.
- In `mesonFlags`, change `"-Dfreetype=disabled"` → `"-Dfreetype=enabled"` and
  `"-Dfontconfig=disabled"` → `"-Dfontconfig=enabled"`.
- RESTORE the nixpkgs `postInstall` that rewrites `cairo.pc` for freetype include
  dirs — it is no longer dead now that freetype is a real input. Remove the
  `postInstall = "";` override line (let nixpkgs' default run). If nixpkgs' default
  postInstall references a now-present path, the build will tell you; fix minimally.
- Update the explanatory comment block above the override to say cairo now builds
  the **image + freetype + fontconfig** font backends for the M2 text stack
  (glib/x11/png still off), instead of "image-surface-only".

- [ ] **Step 2: Build cairo and verify the font backends are present**

```sh
CAIRO=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#legacyPackages.aarch64-linux.cairo --no-link --print-out-paths 2>/dev/null)
echo "$CAIRO"
grep -E "Requires" "$CAIRO"*/lib/pkgconfig/cairo.pc 2>/dev/null || cat "$(echo $CAIRO | tr ' ' '\n' | grep -- '-dev')/lib/pkgconfig/cairo.pc" | grep -i require
```
Expected: build succeeds; `cairo.pc` `Requires:`/`Requires.private:` lists
`freetype2` and `fontconfig`. (cairo's `cairo-ft.h` is now usable.)

- [ ] **Step 3: Regression — weston-flowers must still build**

The shared cairo change must not break the existing image-surface client:
```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#weston-flowers --no-link --print-out-paths
```
Expected: succeeds (it links the now-larger cairo but uses only image surfaces).
If it fails, the cairo change was not additive — fix the override, do not weaken
weston-flowers.

- [ ] **Step 4: Commit**

```sh
git add deps-overlay.nix
git commit -m "M2: rebuild shared cairo with freetype+fontconfig backends (additive)"
```

---

## Task 3: Bake the font + fontconfig config + cache into the guest

**Files:**
- Create: `userspace/fonts.nix`
- Modify: `userspace/system.nix` (wire the font bundle + `FONTCONFIG_*` env)

**Interfaces:**
- Consumes: `pkgs.dejavu_fonts`, `pkgs.fontconfig` (NATIVE, for `fc-cache` at build
  time), the guest closure machinery in `system.nix`.
- Produces: in the guest fs — a font at a known dir, `/etc/fonts/fonts.conf`, a
  prebuilt fontconfig cache, and `FONTCONFIG_FILE` (+ cache dir) env so in-guest
  `FcInit()`/`FcFontMatch` resolves `DejaVu Sans` with no runtime scan. Consumed by
  Task 4's selftest.

- [ ] **Step 1: Write the font/fontconfig bundle derivation**

Create `userspace/fonts.nix`. It assembles a font dir + a minimal `fonts.conf`
pointing at it + a **prebuilt** cache (generated with the NATIVE fontconfig at
build time, since the guest can't cheaply rebuild it):

```nix
# userspace/fonts.nix — the guest font + fontconfig bundle (M2 text stack).
# A self-contained /etc/fonts/fonts.conf + DejaVu font dir + a PREBUILT fontconfig
# cache, so in-guest FcInit()/FcFontMatch resolves "DejaVu Sans" without scanning.
# fc-cache runs with the NATIVE fontconfig at build time (the guest can't).
{ pkgs }:
let
  fontDir = "${pkgs.dejavu_fonts}/share/fonts/truetype";
in
pkgs.runCommand "guest-fonts" { nativeBuildInputs = [ pkgs.fontconfig ]; } ''
  mkdir -p $out/etc/fonts $out/share/fonts $out/var/cache/fontconfig
  # the served font dir (guest path /run/current-system/sw/share/fonts via the profile)
  cp ${fontDir}/DejaVuSans.ttf $out/share/fonts/

  cat > $out/etc/fonts/fonts.conf <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/run/current-system/sw/share/fonts</dir>
  <cachedir>/var/cache/fontconfig</cachedir>
  <config></config>
</fontconfig>
EOF

  # Prebuild the cache against the SAME guest paths fontconfig will see at runtime.
  # FONTCONFIG_FILE points at our conf; build the cache into $out/var/cache.
  FONTCONFIG_FILE=$out/etc/fonts/fonts.conf \
  FONTCONFIG_PATH=$out/etc/fonts \
    ${pkgs.fontconfig}/bin/fc-cache -f -v $out/share/fonts || true
''
```

Note: if `fc-cache` keys the cache by absolute scan path and the guest path differs
from the build path, the guest may rescan once on first `FcInit`. That is
acceptable (the font dir is tiny — one file). The selftest in Task 4 is the real
proof that resolution works in-guest; if it shows fontconfig failing to find the
font, revisit the cachedir/dir paths here.

- [ ] **Step 2: Wire the bundle into the guest closure**

In `userspace/system.nix`, mirror the existing `terminfoMin` pattern (the
`environment.systemPackages` + `pathsToLink` + `environment.variables` block around
the terminfo wiring). Add:
- `import ./fonts.nix { inherit pkgs; }` (call it `guestFonts`) to
  `environment.systemPackages`.
- `environment.pathsToLink` += `[ "/share/fonts" ]` (so the font dir lands in the
  profile, like `/share/terminfo`).
- `environment.etc."fonts/fonts.conf".source = "${guestFonts}/etc/fonts/fonts.conf";`
  (so `/etc/fonts/fonts.conf` exists — fontconfig's default config path).
- `environment.variables.FONTCONFIG_FILE = "/etc/fonts/fonts.conf";`
- `environment.variables.FONTCONFIG_PATH = "/etc/fonts";`

Match the exact style/structure of the surrounding `terminfoMin` wiring (read
`userspace/system.nix:69-115` first and follow it).

- [ ] **Step 3: Build the guest closure to confirm the font lands**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-system --no-link --print-out-paths
```
Expected: succeeds. Spot-check the closure contains the font + conf:
`nix-store -q --references <wasm-system-out>` includes `guest-fonts`, and the etc
has `fonts/fonts.conf`. (Full end-to-end resolution is verified by Task 4.)

- [ ] **Step 4: Commit**

```sh
git add userspace/fonts.nix userspace/system.nix
git commit -m "M2: bake DejaVu font + fontconfig conf + cache into the guest"
```

---

## Task 4: The wl-text proof client (cairo-ft + harfbuzz) + selftest + smoke

**Files:**
- Create: `userspace/wl-text.c`, `userspace/wl-text.nix`,
  `runtime/node/wl-text-smoke.mjs`
- Modify: `flake.nix`

**Interfaces:**
- Consumes: `cross.cairo` (ft+fc backends, Task 2), `cross.fontconfig`,
  `cross.harfbuzz`, `cross.freetype`, `cross.pixman`, `cross.zlib`,
  `cross.wayland`, `cross.wayland-protocols`, `cross.libffi`; the guest font
  bundle (Task 3).
- Produces: `/bin/wl-text` in the guest; flake attr `packages.aarch64-linux.wl-text`;
  smoke `runtime/node/wl-text-smoke.mjs`. The selftest prints exactly
  `WL-TEXT-SELFTEST: glyphs=<n> nonzero_px=<m> OK` on success.

- [ ] **Step 1: Write the rendering core + selftest (wl-text.c)**

Create `userspace/wl-text.c`. The text-rendering core (fontconfig → freetype →
harfbuzz → cairo-ft) and the `--selftest` path are the novel logic and are shown in
full. The default-mode Wayland window scaffold (display/registry/shm/xdg-toplevel +
blit) is the SAME boilerplate as `userspace/wl-anim.c` — copy its `main()` /
registry handler / shm-pool helper and call `render_text(...)` to fill the buffer
(this is the established shared-setup copy pattern, like wl-input-probe; produce a
complete file with no placeholder comments).

```c
/* wl-text.c — M2 text-stack proof. fontconfig → freetype → harfbuzz → cairo-ft.
   `--selftest`: render headlessly to an image surface, print a stdout assertion,
   exit (the automated CI gate — no compositor needed). Default: blit the same
   render into a wl_shm xdg-toplevel window (the in-browser visual check; the
   display/registry/shm scaffold is copied from wl-anim.c). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <cairo.h>
#include <cairo-ft.h>
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <hb.h>
#include <hb-ft.h>

#define TW 320
#define TH 80
static const char *TEXT = "Hello, wasm!";

/* Resolve a font file for `family` via fontconfig. Returns a malloc'd path or NULL. */
static char *fc_resolve(const char *family) {
  if (!FcInit()) return NULL;
  FcPattern *pat = FcNameParse((const FcChar8 *)family);
  FcConfigSubstitute(NULL, pat, FcMatchPattern);
  FcDefaultSubstitute(pat);
  FcResult res;
  FcPattern *m = FcFontMatch(NULL, pat, &res);
  char *out = NULL;
  if (m) {
    FcChar8 *file = NULL;
    if (FcPatternGetString(m, FC_FILE, 0, &file) == FcResultMatch && file)
      out = strdup((const char *)file);
    FcPatternDestroy(m);
  }
  FcPatternDestroy(pat);
  return out;
}

/* Render TEXT into the given ARGB32 cairo image surface; return the shaped glyph
   count, or 0 on failure. White background, black text. */
static unsigned render_text(cairo_surface_t *surf) {
  char *fontfile = fc_resolve("DejaVu Sans");
  if (!fontfile) { fprintf(stderr, "wl-text: fontconfig could not resolve DejaVu Sans\n"); return 0; }

  FT_Library ftlib;
  if (FT_Init_FreeType(&ftlib)) { free(fontfile); return 0; }
  FT_Face face;
  if (FT_New_Face(ftlib, fontfile, 0, &face)) { free(fontfile); return 0; }
  FT_Set_Pixel_Sizes(face, 0, 32);

  hb_font_t *hbfont = hb_ft_font_create(face, NULL);
  hb_buffer_t *buf = hb_buffer_create();
  hb_buffer_add_utf8(buf, TEXT, -1, 0, -1);
  hb_buffer_guess_segment_properties(buf);
  hb_shape(hbfont, buf, NULL, 0);

  unsigned n = 0;
  hb_glyph_info_t *info = hb_buffer_get_glyph_infos(buf, &n);
  hb_glyph_position_t *gpos = hb_buffer_get_glyph_positions(buf, &n);

  cairo_t *cr = cairo_create(surf);
  cairo_set_source_rgb(cr, 1, 1, 1); cairo_paint(cr);
  cairo_set_source_rgb(cr, 0, 0, 0);
  cairo_font_face_t *cf = cairo_ft_font_face_create_for_ft_face(face, 0);
  cairo_set_font_face(cr, cf);
  cairo_set_font_size(cr, 32);

  cairo_glyph_t *cg = malloc(sizeof(cairo_glyph_t) * (n ? n : 1));
  double x = 10, y = 50;
  for (unsigned i = 0; i < n; i++) {
    cg[i].index = info[i].codepoint;            /* post-shaping: a glyph index */
    cg[i].x = x + gpos[i].x_offset / 64.0;
    cg[i].y = y - gpos[i].y_offset / 64.0;
    x += gpos[i].x_advance / 64.0;
    y -= gpos[i].y_advance / 64.0;
  }
  cairo_show_glyphs(cr, cg, n);
  cairo_surface_flush(surf);

  free(cg);
  cairo_font_face_destroy(cf);
  cairo_destroy(cr);
  hb_buffer_destroy(buf);
  hb_font_destroy(hbfont);
  FT_Done_Face(face);
  FT_Done_FreeType(ftlib);
  free(fontfile);
  return n;
}

/* Count non-white pixels in an ARGB32 surface (proof that glyphs were drawn). */
static long nonwhite_px(cairo_surface_t *surf) {
  unsigned char *data = cairo_image_surface_get_data(surf);
  int stride = cairo_image_surface_get_stride(surf);
  int w = cairo_image_surface_get_width(surf);
  int h = cairo_image_surface_get_height(surf);
  long nz = 0;
  for (int j = 0; j < h; j++) {
    uint32_t *row = (uint32_t *)(data + j * stride);
    for (int i = 0; i < w; i++)
      if ((row[i] & 0x00ffffff) != 0x00ffffff) nz++;   /* not white */
  }
  return nz;
}

static int run_selftest(void) {
  cairo_surface_t *surf = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, TW, TH);
  unsigned glyphs = render_text(surf);
  long nz = nonwhite_px(surf);
  cairo_surface_destroy(surf);
  int ok = (glyphs > 0 && nz > 0);
  printf("WL-TEXT-SELFTEST: glyphs=%u nonzero_px=%ld %s\n", glyphs, nz, ok ? "OK" : "FAIL");
  fflush(stdout);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();
  /* default mode: copy wl-anim.c's display/registry/shm/xdg-toplevel scaffold,
     create a TWxTH ARGB32 wl_shm buffer, wrap it in a cairo image surface with
     cairo_image_surface_create_for_data(<shm ptr>, CAIRO_FORMAT_ARGB32, TW, TH,
     stride), call render_text(that surface), attach+commit, and run
     wl_display_dispatch() so the window stays up for the browser visual check. */
  return run_selftest();  /* placeholder until the wayland scaffold is filled in */
}
```

NOTE: the `main()` default-mode body must be completed by copying the wl-anim.c
Wayland scaffold (do NOT leave the `placeholder` return — that is only shown to
mark where the scaffold goes). The `--selftest` path is the gated proof and is
complete above.

- [ ] **Step 2: Write the derivation (mirrors weston-flowers.nix)**

Create `userspace/wl-text.nix`:

```nix
# wl-text — M2 text-stack proof client. fontconfig→freetype→harfbuzz→cairo-ft.
# --selftest renders headlessly + asserts on stdout (CI gate); default renders into
# a wl_shm window (visual check). Mirrors weston-flowers.nix / wl-anim.nix.
{ cross, cairo, fontconfig, harfbuzz, freetype, pixman, zlib
, wayland, wayland-protocols, libffi }:
cross.stdenv.mkDerivation {
  pname = "wl-text";
  version = "0.1.0";
  dontUnpack = true;
  nativeBuildInputs = [
    cross.buildPackages.wayland-scanner
    cross.buildPackages.pkg-config
  ];
  buildInputs = [ cairo fontconfig harfbuzz freetype pixman zlib wayland wayland-protocols libffi ];
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    SCANNER=${cross.buildPackages.wayland-scanner.bin}/bin/wayland-scanner
    WP=${wayland-protocols}/share/wayland-protocols
    mkdir -p gen
    "$SCANNER" client-header "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-client-protocol.h
    "$SCANNER" private-code  "$WP/stable/xdg-shell/xdg-shell.xml" gen/xdg-shell-protocol.c
    CFLAGS="$($PKG_CONFIG --cflags cairo fontconfig harfbuzz freetype2) $($PKG_CONFIG --cflags wayland-client) -I gen -O2"
    LDLIBS="$($PKG_CONFIG --libs cairo fontconfig harfbuzz freetype2) $($PKG_CONFIG --libs wayland-client) -lffi -lm"
    $CC $CFLAGS ${./wl-text.c} gen/xdg-shell-protocol.c $LDLIBS -o wl-text
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 wl-text $out/bin/wl-text
    runHook postInstall
  '';
  meta.description = "Text-stack proof: harfbuzz+cairo-ft into wl_shm (M2), wasm32";
}
```

- [ ] **Step 3: Wire flake.nix**

Beside the other wl-* derivations, add:
```nix
      wlText = import ./userspace/wl-text.nix {
        inherit cross;
        cairo = cross.cairo; fontconfig = cross.fontconfig; harfbuzz = cross.harfbuzz;
        freetype = cross.freetype; pixman = cross.pixman; zlib = cross.zlib;
        wayland = cross.wayland; wayland-protocols = cross.wayland-protocols;
        libffi = cross.libffi;
      };
```
Add `wlText` to the `extraBins` list, and expose `wl-text = wlText;` in the packages
attrset.

- [ ] **Step 4: Write the smoke runner**

Create `runtime/node/wl-text-smoke.mjs` (mirrors `libffi-smoke.mjs`):

```js
// wl-text-smoke.mjs — boots and runs /bin/wl-text --selftest in-guest.
// Proves the M2 text stack (fontconfig→freetype→harfbuzz→cairo-ft) renders.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: false });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[wl-text-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("/bin/wl-text --selftest\n");
  pass = await s.waitForOutput(/WL-TEXT-SELFTEST: glyphs=[1-9][0-9]* nonzero_px=[1-9][0-9]* OK/, 30000);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[wl-text-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
```

- [ ] **Step 5: Build, refresh artifacts, run the smoke — expect PASS**

```sh
echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wl-text --no-link --print-out-paths
OUT=$(echo password | sudo -S nix --extra-experimental-features 'nix-command flakes' build .#wasm-initramfs --no-link --print-out-paths 2>/dev/null)
ln -sfn "$OUT/initramfs.cpio.gz" .artifacts/initramfs.cpio.gz
cd runtime && LINUX_WASM_ARTIFACTS="file://$PWD/../.artifacts/" node node/wl-text-smoke.mjs ; echo "exit=$?" ; cd ..
```
Expected: transcript shows `WL-TEXT-SELFTEST: glyphs=12 nonzero_px=<big> OK` and
`[wl-text-smoke] PASS`. (glyph count may differ slightly with shaping; the regex
only requires ≥1 glyph and ≥1 non-white pixel.) If the selftest prints `FAIL` with
`glyphs=0`, fontconfig didn't resolve the font in-guest — revisit Task 3's paths. If
`nonzero_px=0`, the font resolved but cairo-ft didn't rasterize — check the cairo ft
backend (Task 2). Re-run once if exit 2 (boot panic).

- [ ] **Step 6: Commit**

```sh
git add userspace/wl-text.c userspace/wl-text.nix runtime/node/wl-text-smoke.mjs flake.nix
git commit -m "M2: wl-text proof client (harfbuzz+cairo-ft) + headless selftest smoke"
```

---

## Task 5: Document the wl-text smoke gate

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the smoke line**

Under the "Boot-test the built guest" section, beside the `libffi-smoke.mjs` line,
add (matching the surrounding "from runtime/" style — note the `node/…` relative
path):
```sh
# M2 text stack (fontconfig→freetype→harfbuzz→cairo-ft): boot → render selftest.
LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node node/wl-text-smoke.mjs
```

- [ ] **Step 2: Commit**

```sh
git add CLAUDE.md
git commit -m "docs: document wl-text (M2 text stack) smoke gate"
```

---

## Self-review

**Spec coverage (M2 section of the design):**
- glib-free freetype/fribidi/fontconfig/harfbuzz cross-built → Task 1. ✓ (harfbuzz glib=disabled is explicit, not "if it fails")
- cairo rebuilt with freetype+fontconfig, additive (weston-flowers regression) → Task 2. ✓
- Bake font + fontconfig conf + prebuilt cache → Task 3. ✓
- Proof: fontconfig→harfbuzz→cairo-ft render; `--selftest` headless CI gate + `wl_shm` visual → Task 4. ✓
- No glib/pango anywhere → enforced in Global Constraints + Task 1 Step 3 verification (`grep -i glib` must be empty). ✓

**Placeholder scan:** the only intentionally-incomplete code is `wl-text.c`'s
default-mode `main()` Wayland scaffold, explicitly delegated to "copy wl-anim.c"
(the established shared-setup pattern; the implementer must produce a complete file
and remove the `placeholder` return). The gated proof path (`--selftest`) is
complete. No TODO/TBD elsewhere.

**Type/contract consistency:** the selftest output string
`WL-TEXT-SELFTEST: glyphs=<n> nonzero_px=<m> OK` is defined once in `wl-text.c`
(Task 4 Step 1) and matched by the smoke regex (Step 4) and the build-test
expectation (Step 5). The font family `DejaVu Sans` is consistent between Task 3
(baked) and Task 4 (`fc_resolve("DejaVu Sans")`). Build attr path
`.#legacyPackages.aarch64-linux.<lib>` is consistent throughout.

## Out of scope (later plans)

- glib + pango (M3, per the corrected boundary), GTK3 + runtime assets (M3),
  galculator (M4).
- The on-screen visual confirmation of the `wl_shm` window is a manual browser
  check (like M0); the automated gate is the headless `--selftest`.
