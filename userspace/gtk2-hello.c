/* gtk2-hello.c — M-X4 GTK2 proof (XChat/X11 epic). --selftest: prove GTK2
   initializes + a widget tree's classes register in-guest, print
   "GTK2-SELFTEST: <detail> OK", exit WITHOUT mapping a window — kept
   display-free for parity with gtk-hello's (GTK3/wayland) headless CI gate,
   even though GTK2's X11 backend CAN actually be screenshotted headless via
   Xvfb+xwd (unlike GTK3's wayland backend, which needs a real compositor the
   node harness doesn't have) — that live-window proof is
   runtime/demo/node/gtk2-x11-smoke.mjs, not this binary's default mode.
   Default (no args): map a real X11 window via Xvfb (or any DISPLAY) — the
   in-browser / Xvfb visual check. Built through the fpcast-emu seam (gobject
   fn-pointer casts — same class of indirect-call arity mismatch GTK3 hits). */
#include <gtk/gtk.h>
#include <stdio.h>
#include <string.h>

static int run_selftest(void) {
  /* gtk_init_check tries to open the X display named by $DISPLAY; with none
     set (or none reachable) it fails cleanly and returns FALSE — GTK2 (unlike
     GTK3's GtkStyleContext, introduced later) doesn't hard-require a display
     to construct widget objects, but keep the gate compositor/display-
     INDEPENDENT anyway for parity with gtk-hello and so this smoke can run in
     the same no-DISPLAY node harness boot as every other GTK selftest.
     g_type_class_ref(GTK_TYPE_WINDOW/LABEL) runs each class's class_init —
     the gobject-heavy path that exercises the fpcast/marshaller seam —
     without needing a display, then g_type_from_name resolves the registered
     type names. */
  int argc = 0; char **argv = NULL;
  gboolean inited = gtk_init_check(&argc, &argv);

  /* register GtkWindow + GtkLabel via their class_init (gobject fn-pointer
     casts → the fpcast seam), display-free. */
  gpointer win_class = g_type_class_ref(GTK_TYPE_WINDOW);
  gpointer label_class = g_type_class_ref(GTK_TYPE_LABEL);

  GType win_t = g_type_from_name("GtkWindow");
  GType label_t = g_type_from_name("GtkLabel");

  /* assert GTK2's type system is live and these are the real registered
     GTK types */
  int win_ok = win_class != NULL && win_t == GTK_TYPE_WINDOW
            && g_type_is_a(win_t, GTK_TYPE_WIDGET);
  int label_ok = label_class != NULL && label_t == GTK_TYPE_LABEL
            && g_type_is_a(label_t, GTK_TYPE_WIDGET);
  /* GTK2 exposes its version as plain extern globals (gtk_get_major_version()
     is a GTK3+ API), so read gtk_major_version directly. */
  int ok = win_ok && label_ok && gtk_major_version == 2;

  printf("GTK2-SELFTEST: gtk_init_check=%d window=%d label=%d major=%u %s\n",
         inited, win_ok, label_ok, gtk_major_version,
         ok ? "OK" : "FAIL");
  fflush(stdout);
  g_type_class_unref(win_class);
  g_type_class_unref(label_class);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();
  /* visual mode (Xvfb / manual browser check): gtk_init, build the tree,
     gtk_widget_show_all, gtk_main — maps a real X11 window via GTK2's gdk-x11
     backend → cairo_xlib_surface. */
  gtk_init(&argc, &argv);
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  GtkWidget *label = gtk_label_new("Hello, GTK2 on wasm!");
  gtk_container_add(GTK_CONTAINER(win), label);
  gtk_widget_show_all(win);
  gtk_main();
  return 0;
}
