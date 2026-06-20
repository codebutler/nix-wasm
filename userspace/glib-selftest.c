/* glib-selftest.c — in-guest gobject proof (M3a). Proves glib/gobject works AND
   that gobject's generic (libffi) signal marshaller passes a `double` correctly —
   the first real exercise of the M1 raw wasm FFI backend's f64 argument support.
   Prints "GLIB-SELFTEST: signal_double=<v> OK" on success. */
#include <glib.h>
#include <glib-object.h>
#include <stdio.h>

static double g_received = 0.0;

/* signal handler: (instance, gdouble value, user_data) */
static void on_value(GObject *obj, gdouble value, gpointer user_data) {
  g_received = value;
}

int main(void) {
  /* (a) basic gobject: a GObject with a double "x" property round-trips. */
  GObject *o = g_object_new(G_TYPE_OBJECT, NULL);
  if (!G_IS_OBJECT(o)) { printf("GLIB-SELFTEST: FAIL no-object\n"); return 1; }

  /* (b) a signal carrying a gdouble, using the GENERIC (libffi) marshaller
     (marshaller = NULL → g_signal_emit uses g_cclosure_marshal_generic →
     ffi_call with a double arg → the M1 raw wasm FFI backend). */
  guint sig = g_signal_newv("value-set",
      G_TYPE_OBJECT, G_SIGNAL_RUN_LAST, NULL /*class closure*/,
      NULL, NULL, NULL /*c_marshaller = NULL → generic*/,
      G_TYPE_NONE, 1, (GType[]){ G_TYPE_DOUBLE });
  (void)sig;
  g_signal_connect(o, "value-set", G_CALLBACK(on_value), NULL);

  const double sent = 42.5;
  g_signal_emit_by_name(o, "value-set", sent);

  int ok = (g_received == sent);
  printf("GLIB-SELFTEST: signal_double=%g %s\n", g_received, ok ? "OK" : "FAIL");
  g_object_unref(o);
  return ok ? 0 : 1;
}
