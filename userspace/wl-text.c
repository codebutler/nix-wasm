/* wl-text.c — M2 text-stack proof. fontconfig → freetype → harfbuzz → cairo-ft.
   `--selftest`: render headlessly to an image surface, print a stdout assertion,
   exit (the automated CI gate — no compositor needed). Default: blit the same
   render into a wl_shm xdg-toplevel window (the in-browser visual check; the
   display/registry/shm scaffold is copied from wl-anim.c). */
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <sys/mman.h>
#include <cairo.h>
#include <cairo-ft.h>
#include <fontconfig/fontconfig.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <hb.h>
#include <hb-ft.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

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
  if (FT_New_Face(ftlib, fontfile, 0, &face)) { FT_Done_FreeType(ftlib); free(fontfile); return 0; }
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

/* ---- default mode: blit render_text() into a wl_shm xdg-toplevel window ----
 * The display/registry/wl_shm/xdg-shell scaffold below is the established
 * shared-setup copy from wl-anim.c: same globals, registry handler, shm-file
 * helper and xdg ping/configure plumbing. The only difference is that instead of
 * an animation loop we draw a single static frame — render_text() into a cairo
 * image surface wrapped over the shm buffer — and keep dispatching so the window
 * stays up for the browser visual check. */
struct app {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	struct wl_shm *shm;
	struct xdg_wm_base *wm_base;

	struct wl_surface *surface;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *xdg_toplevel;

	struct wl_buffer *wl_buffer;
	uint32_t *data;
	int size;

	bool configured;
	bool running;
	bool drawn;
};

static int create_shm_file(off_t size)
{
	char name[] = "/tmp/wl-text-XXXXXX";
	int fd = mkstemp(name);
	if (fd < 0)
		return -1;
	unlink(name);
	if (ftruncate(fd, size) < 0) {
		close(fd);
		return -1;
	}
	return fd;
}

static bool alloc_buffer(struct app *app)
{
	int stride = TW * 4;
	int size = stride * TH;
	int fd = create_shm_file(size);
	if (fd < 0)
		return false;
	app->data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (app->data == MAP_FAILED) {
		close(fd);
		return false;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, size);
	app->wl_buffer = wl_shm_pool_create_buffer(pool, 0, TW, TH, stride, WL_SHM_FORMAT_ARGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	app->size = size;
	return true;
}

/* Draw TEXT once into the shm buffer via a cairo image surface backed by the
 * mmap'd shm pixels, then attach + damage + commit. */
static void draw(struct app *app)
{
	if (!app->configured || app->drawn)
		return;
	int stride = cairo_format_stride_for_width(CAIRO_FORMAT_ARGB32, TW);
	cairo_surface_t *surf = cairo_image_surface_create_for_data(
		(unsigned char *)app->data, CAIRO_FORMAT_ARGB32, TW, TH, stride);
	unsigned glyphs = render_text(surf);
	cairo_surface_destroy(surf);

	wl_surface_attach(app->surface, app->wl_buffer, 0, 0);
	wl_surface_damage(app->surface, 0, 0, TW, TH);
	wl_surface_commit(app->surface);
	app->drawn = true;

	printf("wl-text: drew %u glyphs\n", glyphs);
	fflush(stdout);
}

/* ---- xdg-shell ---- */
static void wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
	xdg_wm_base_pong(wm_base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = { .ping = wm_base_ping };

static void xdg_surface_configure(void *data, struct xdg_surface *xs, uint32_t serial)
{
	struct app *app = data;
	xdg_surface_ack_configure(xs, serial);
	app->configured = true;
	draw(app);
}
static const struct xdg_surface_listener xdg_surface_listener = { .configure = xdg_surface_configure };

static void toplevel_configure(void *data, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *s) {}
static void toplevel_close(void *data, struct xdg_toplevel *t)
{
	((struct app *)data)->running = false;
}
static const struct xdg_toplevel_listener toplevel_listener = {
	.configure = toplevel_configure,
	.close = toplevel_close,
};

/* ---- registry ---- */
static void registry_global(void *data, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver)
{
	struct app *app = data;
	if (strcmp(iface, wl_compositor_interface.name) == 0) {
		app->compositor = wl_registry_bind(r, name, &wl_compositor_interface, 1);
	} else if (strcmp(iface, wl_shm_interface.name) == 0) {
		app->shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
	} else if (strcmp(iface, xdg_wm_base_interface.name) == 0) {
		app->wm_base = wl_registry_bind(r, name, &xdg_wm_base_interface, 1);
		xdg_wm_base_add_listener(app->wm_base, &wm_base_listener, app);
	}
}
static void registry_global_remove(void *data, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

static int run_window(void)
{
	struct app app = { 0 };
	app.running = true;

	app.display = wl_display_connect(NULL);
	if (!app.display) {
		fprintf(stderr, "wl-text: cannot connect to display\n");
		return 1;
	}
	app.registry = wl_display_get_registry(app.display);
	wl_registry_add_listener(app.registry, &registry_listener, &app);
	wl_display_roundtrip(app.display);

	if (!app.compositor || !app.shm || !app.wm_base) {
		fprintf(stderr, "wl-text: missing globals\n");
		return 1;
	}

	if (!alloc_buffer(&app)) {
		fprintf(stderr, "wl-text: buffer alloc failed\n");
		return 1;
	}

	app.surface = wl_compositor_create_surface(app.compositor);
	app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
	xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
	app.xdg_toplevel = xdg_surface_get_toplevel(app.xdg_surface);
	xdg_toplevel_add_listener(app.xdg_toplevel, &toplevel_listener, &app);
	xdg_toplevel_set_title(app.xdg_toplevel, "text");
	xdg_toplevel_set_app_id(app.xdg_toplevel, "be.udev.text");
	wl_surface_commit(app.surface);

	printf("wl-text: running\n");
	fflush(stdout);
	while (app.running && wl_display_dispatch(app.display) != -1) {
	}

	if (app.wl_buffer)
		wl_buffer_destroy(app.wl_buffer);
	if (app.data && app.data != MAP_FAILED)
		munmap(app.data, app.size);
	if (app.xdg_toplevel)
		xdg_toplevel_destroy(app.xdg_toplevel);
	if (app.xdg_surface)
		xdg_surface_destroy(app.xdg_surface);
	if (app.surface)
		wl_surface_destroy(app.surface);
	wl_display_disconnect(app.display);
	return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();
  return run_window();
}
