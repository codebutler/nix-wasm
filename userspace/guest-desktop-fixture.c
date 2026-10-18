/* Manual acceptance fixture for the guest SNI watcher and notifications.
 * Run with DISPLAY unset; no X11 service or host console setup is needed. */
#include <gio/gio.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define ITEM_PATH "/StatusNotifierItem"
#define ITEM_IFACE "org.kde.StatusNotifierItem"
#define WATCHER "org.kde.StatusNotifierWatcher"
#define NOTICE "org.freedesktop.Notifications"

static GDBusConnection *bus;
static guint phase;
static uint8_t icon[16 * 16 * 4];

static const char item_xml[] =
  "<node><interface name='org.kde.StatusNotifierItem'>"
  "<method name='Activate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
  "<method name='SecondaryActivate'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
  "<method name='ContextMenu'><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
  "<method name='Scroll'><arg type='i' direction='in'/><arg type='s' direction='in'/></method>"
  "<property name='Category' type='s' access='read'/>"
  "<property name='Id' type='s' access='read'/>"
  "<property name='Title' type='s' access='read'/>"
  "<property name='Status' type='s' access='read'/>"
  "<property name='IconPixmap' type='a(iiay)' access='read'/>"
  "<property name='AttentionIconPixmap' type='a(iiay)' access='read'/>"
  "<property name='ItemIsMenu' type='b' access='read'/>"
  "<signal name='NewStatus'><arg type='s'/></signal>"
  "</interface></node>";

static const char *status(void) {
  if (phase == 1) return "NeedsAttention";
  if (phase == 2) return "Passive";
  return "Active";
}

static void publish_notice(void) {
  const char *actions[] = {"default", "Open", "reply", "Reply", NULL};
  GVariantBuilder hints;
  g_variant_builder_init(&hints, G_VARIANT_TYPE("a{sv}"));
  g_dbus_connection_call(bus, NOTICE, "/org/freedesktop/Notifications",
    NOTICE, "Notify",
    g_variant_new("(susss@as@a{sv}i)", "SNI fixture", 0u, "",
      "Guest notification", "Action keys return to the guest bus",
      g_variant_new_strv(actions, -1), g_variant_builder_end(&hints), 8000),
    NULL, G_DBUS_CALL_FLAGS_NONE, 2000, NULL, NULL, NULL);
}

static void item_method(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *method,
  GVariant *parameters, GDBusMethodInvocation *invocation, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface;
  (void)parameters; (void)data;
  g_print("SNI action: %s\n", method);
  if (g_strcmp0(method, "Activate") == 0 ||
      g_strcmp0(method, "SecondaryActivate") == 0)
    publish_notice();
  g_dbus_method_invocation_return_value(invocation, NULL);
}

static GVariant *item_property(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *name,
  GError **error, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface;
  (void)error; (void)data;
  if (g_strcmp0(name, "Category") == 0) return g_variant_new_string("Communications");
  if (g_strcmp0(name, "Id") == 0) return g_variant_new_string("yore-sni-fixture");
  if (g_strcmp0(name, "Title") == 0) return g_variant_new_string("Guest SNI fixture");
  if (g_strcmp0(name, "Status") == 0) return g_variant_new_string(status());
  if (g_strcmp0(name, "ItemIsMenu") == 0) return g_variant_new_boolean(FALSE);
  if (g_strcmp0(name, "IconPixmap") == 0 ||
      g_strcmp0(name, "AttentionIconPixmap") == 0) {
    GVariantBuilder pixmaps;
    g_variant_builder_init(&pixmaps, G_VARIANT_TYPE("a(iiay)"));
    g_variant_builder_add(&pixmaps, "(ii@ay)", 16, 16,
      g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, icon, sizeof icon, 1));
    return g_variant_builder_end(&pixmaps);
  }
  return NULL;
}

static gboolean cycle_status(gpointer data) {
  (void)data;
  phase = (phase + 1) % 3;
  g_print("SNI status: %s\n", status());
  g_dbus_connection_emit_signal(bus, NULL, ITEM_PATH, ITEM_IFACE,
    "NewStatus", g_variant_new("(s)", status()), NULL);
  return G_SOURCE_CONTINUE;
}

static void notice_signal(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *signal,
  GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface; (void)data;
  gchar *value = g_variant_print(parameters, TRUE);
  g_print("Notification %s %s\n", signal, value);
  g_free(value);
}

int main(void) {
  GError *error = NULL;
  bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
  if (!bus) { g_printerr("Guest bus: %s\n", error->message); return 1; }
  for (int y = 0; y < 16; ++y)
    for (int x = 0; x < 16; ++x) {
      size_t offset = ((size_t)y * 16 + x) * 4;
      icon[offset] = 255;
      icon[offset + 1] = (x < 8) ? 55 : 100;
      icon[offset + 2] = (y < 8) ? 150 : 220;
      icon[offset + 3] = 255;
    }
  GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(item_xml, &error);
  if (!node) { g_printerr("SNI XML: %s\n", error->message); return 1; }
  const GDBusInterfaceVTable vtable = { item_method, item_property, NULL, {0} };
  guint object = g_dbus_connection_register_object(bus, ITEM_PATH,
    node->interfaces[0], &vtable, NULL, NULL, &error);
  if (!object) { g_printerr("SNI object: %s\n", error->message); return 1; }
  GVariant *reply = g_dbus_connection_call_sync(bus, WATCHER,
    "/StatusNotifierWatcher", WATCHER, "RegisterStatusNotifierItem",
    g_variant_new("(s)", ITEM_PATH), NULL, G_DBUS_CALL_FLAGS_NONE,
    5000, NULL, &error);
  if (!reply) { g_printerr("SNI register: %s\n", error->message); return 1; }
  g_variant_unref(reply);
  g_print("Registered guest SNI item; status: Active\n");
  g_dbus_connection_signal_subscribe(bus, NOTICE, NOTICE, NULL,
    "/org/freedesktop/Notifications", NULL, G_DBUS_SIGNAL_FLAGS_NONE,
    notice_signal, NULL, NULL);
  g_timeout_add_seconds(5, cycle_status, NULL);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_main_loop_run(loop);
  g_main_loop_unref(loop);
  g_dbus_connection_unregister_object(bus, object);
  g_dbus_node_info_unref(node);
  g_object_unref(bus);
  return 0;
}
