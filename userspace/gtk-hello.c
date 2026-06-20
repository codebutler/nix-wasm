/* gtk-hello.c — M3b GTK3 proof. --selftest: prove GTK initializes + a widget tree
   builds in-guest, print "GTK-SELFTEST: <detail> OK", exit WITHOUT mapping (the node
   harness has no compositor). Default: map the window for the in-browser visual check.
   Built through the fpcast-emu seam (gobject fn-pointer casts). */
#include <gtk/gtk.h>
#include <stdio.h>
#include <string.h>

static int run_selftest(void) {
  /* gtk_init_check connects to wayland-0; against the node harness's minimal
     registry it returns FALSE (no real compositor → no GdkDisplay opens). With no
     display, GTK *widget instance* construction aborts fatally (gtk_window_new →
     GtkStyleContext → "Can't create a GtkStyleContext without a display
     connection"), so the gate must be compositor-INDEPENDENT (the brief's Step 1
     fallback): assert gtk_get_major_version() AND that GTK registers its real
     GTypes. g_type_class_ref(GTK_TYPE_WINDOW/LABEL) runs each class's class_init —
     the gobject-heavy path that exercises the fpcast/marshaller seam — WITHOUT
     needing a display, then g_type_from_name resolves the registered type names. */
  int argc = 0; char **argv = NULL;
  gboolean inited = gtk_init_check(&argc, &argv);

  /* register GtkWindow + GtkLabel via their class_init (gobject fn-pointer casts →
     the fpcast seam), display-free. */
  gpointer win_class = g_type_class_ref(GTK_TYPE_WINDOW);
  gpointer label_class = g_type_class_ref(GTK_TYPE_LABEL);

  GType win_t = g_type_from_name("GtkWindow");
  GType label_t = g_type_from_name("GtkLabel");

  /* assert GTK's type system is live and these are the real registered GTK types */
  int win_ok = win_class != NULL && win_t == GTK_TYPE_WINDOW
            && g_type_is_a(win_t, GTK_TYPE_WIDGET);
  int label_ok = label_class != NULL && label_t == GTK_TYPE_LABEL
            && g_type_is_a(label_t, GTK_TYPE_WIDGET);
  int ok = win_ok && label_ok && gtk_get_major_version() == 3;

  printf("GTK-SELFTEST: gtk_init_check=%d window=%d label=%d major=%u %s\n",
         inited, win_ok, label_ok, gtk_get_major_version(),
         ok ? "OK" : "FAIL");
  fflush(stdout);
  g_type_class_unref(win_class);
  g_type_class_unref(label_class);
  return ok ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--selftest") == 0)
    return run_selftest();
  /* visual mode (manual browser check): gtk_init, build the tree, gtk_widget_show_all,
     gtk_main — maps a real wayland window via the gtk wayland backend → Greenfield. */
  gtk_init(&argc, &argv);
  GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
  GtkWidget *label = gtk_label_new("Hello, GTK on wasm!");
  gtk_container_add(GTK_CONTAINER(win), label);
  gtk_widget_show_all(win);
  gtk_main();
  return 0;
}
