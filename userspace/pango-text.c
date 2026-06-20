/* pango-text.c — M3a pango-layout proof. pangocairo PangoLayout → cairo image
   surface (the GTK text rendering path). --selftest asserts non-white pixels and
   prints "PANGO-TEXT-SELFTEST: nonzero_px=<m> OK". (No wayland needed for the
   gated proof; this is a headless render like wl-text --selftest.) */
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <cairo.h>
#include <pango/pangocairo.h>

#define TW 320
#define TH 80

static long nonwhite_px(cairo_surface_t *surf) {
  unsigned char *data = cairo_image_surface_get_data(surf);
  int stride = cairo_image_surface_get_stride(surf);
  int w = cairo_image_surface_get_width(surf);
  int h = cairo_image_surface_get_height(surf);
  long nz = 0;
  for (int j = 0; j < h; j++) {
    uint32_t *row = (uint32_t *)(data + j * stride);
    for (int i = 0; i < w; i++)
      if ((row[i] & 0x00ffffff) != 0x00ffffff) nz++;
  }
  return nz;
}

static long render(cairo_surface_t *surf) {
  cairo_t *cr = cairo_create(surf);
  cairo_set_source_rgb(cr, 1, 1, 1); cairo_paint(cr);
  cairo_set_source_rgb(cr, 0, 0, 0);
  cairo_move_to(cr, 10, 10);

  PangoLayout *layout = pango_cairo_create_layout(cr);
  pango_layout_set_text(layout, "Hello, pango!", -1);
  PangoFontDescription *desc = pango_font_description_from_string("DejaVu Sans 24");
  pango_layout_set_font_description(layout, desc);
  pango_font_description_free(desc);
  pango_cairo_show_layout(cr, layout);
  cairo_surface_flush(surf);

  long nz = nonwhite_px(surf);
  g_object_unref(layout);
  cairo_destroy(cr);
  return nz;
}

int main(int argc, char **argv) {
  cairo_surface_t *surf = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, TW, TH);
  long nz = render(surf);
  cairo_surface_destroy(surf);
  int ok = (nz > 0);
  printf("PANGO-TEXT-SELFTEST: nonzero_px=%ld %s\n", nz, ok ? "OK" : "FAIL");
  fflush(stdout);
  return ok ? 0 : 1;
}
