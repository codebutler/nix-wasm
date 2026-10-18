/* Guest session-bus SNI watcher. It projects item state to Yore over vsock;
 * D-Bus method calls and app ownership stay inside the guest. */
#define _GNU_SOURCE
#include <gio/gio.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/vm_sockets.h>
#else
struct sockaddr_vm {
  unsigned short svm_family, svm_reserved1;
  unsigned int svm_port, svm_cid;
  unsigned char svm_zero[4];
};
#endif
#ifndef AF_VSOCK
#define AF_VSOCK 40
#endif
#ifndef VMADDR_CID_HOST
#define VMADDR_CID_HOST 2
#endif
#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

#define SNI_NAME "org.kde.StatusNotifierWatcher"
#define SNI_PATH "/StatusNotifierWatcher"
#define SNI_INTERFACE "org.kde.StatusNotifierWatcher"
#define ITEM_INTERFACE "org.kde.StatusNotifierItem"
#define NOTICE_NAME "org.freedesktop.Notifications"
#define NOTICE_PATH "/org/freedesktop/Notifications"
#define TRAY_PORT 1026
#define MAX_ITEMS 64
#define MAX_ID 192
#define MAX_LABEL 256
#define MAX_ICON 64
#define HOST_MAGIC 'G'
#define HOST_VERSION 1

typedef struct {
  char *service;
  char *owner;
  char *path;
  char *id;
  guint signal_id;
  char label[MAX_LABEL + 1];
  uint8_t status;
  gboolean item_is_menu;
  uint8_t width, height;
  uint8_t pixels[MAX_ICON * MAX_ICON * 4];
} Item;

static const char watcher_xml[] =
  "<node><interface name='org.kde.StatusNotifierWatcher'>"
  "<method name='RegisterStatusNotifierItem'><arg type='s' direction='in'/></method>"
  "<method name='RegisterStatusNotifierHost'><arg type='s' direction='in'/></method>"
  "<property name='RegisteredStatusNotifierItems' type='as' access='read'/>"
  "<property name='IsStatusNotifierHostRegistered' type='b' access='read'/>"
  "<property name='ProtocolVersion' type='i' access='read'/>"
  "<signal name='StatusNotifierItemRegistered'><arg type='s'/></signal>"
  "<signal name='StatusNotifierItemUnregistered'><arg type='s'/></signal>"
  "<signal name='StatusNotifierHostRegistered'/>"
  "</interface></node>";

static const char notice_xml[] =
  "<node><interface name='org.freedesktop.Notifications'>"
  "<method name='GetCapabilities'><arg type='as' direction='out'/></method>"
  "<method name='GetServerInformation'><arg type='s' direction='out'/>"
  "<arg type='s' direction='out'/><arg type='s' direction='out'/>"
  "<arg type='s' direction='out'/></method>"
  "<method name='Notify'><arg type='s' direction='in'/><arg type='u' direction='in'/>"
  "<arg type='s' direction='in'/><arg type='s' direction='in'/>"
  "<arg type='s' direction='in'/><arg type='as' direction='in'/>"
  "<arg type='a{sv}' direction='in'/><arg type='i' direction='in'/>"
  "<arg type='u' direction='out'/></method>"
  "<method name='CloseNotification'><arg type='u' direction='in'/></method>"
  "<signal name='NotificationClosed'><arg type='u'/><arg type='u'/></signal>"
  "<signal name='ActionInvoked'><arg type='u'/><arg type='s'/></signal>"
  "</interface></node>";

typedef struct {
  char *owner;
  uint32_t id;
  char *title;
  char *body;
  char *keys[8];
  char *labels[8];
  uint8_t action_count;
  int32_t timeout;
  guint timer;
} Notice;

static GPtrArray *items;
static GPtrArray *notices;
static GDBusConnection *bus;
static guint object_id, notice_object_id, notice_name_id, owner_signal_id;
static uint32_t next_notice_id = 1;
static int host_fd = -1;
static guint host_watch_id;
static uint8_t host_input[1024];
static size_t host_input_size;

static void le16(uint8_t *out, uint16_t value) {
  out[0] = (uint8_t)value;
  out[1] = (uint8_t)(value >> 8);
}

static void le32(uint8_t *out, uint32_t value) {
  for (int i = 0; i < 4; ++i) out[i] = (uint8_t)(value >> (8 * i));
}

static uint16_t read16(const uint8_t *in) {
  return (uint16_t)(in[0] | ((uint16_t)in[1] << 8));
}

static uint32_t read32(const uint8_t *in) {
  return (uint32_t)in[0] | ((uint32_t)in[1] << 8) |
         ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
}

static void close_host(void) {
  if (host_watch_id) {
    g_source_remove(host_watch_id);
    host_watch_id = 0;
  }
  if (host_fd >= 0) close(host_fd);
  host_fd = -1;
  host_input_size = 0;
}

static gboolean write_all(int fd, const uint8_t *bytes, size_t length) {
  while (length) {
    ssize_t n = send(fd, bytes, length, MSG_NOSIGNAL);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return FALSE;
    bytes += n;
    length -= (size_t)n;
  }
  return TRUE;
}

static void send_frame(const uint8_t *body, size_t length) {
  if (host_fd < 0 || length > 65536) return;
  uint8_t header[4];
  le32(header, (uint32_t)length);
  if (!write_all(host_fd, header, sizeof header) ||
      !write_all(host_fd, body, length))
    close_host();
}

static void publish(Item *item) {
  size_t id_len = strlen(item->id);
  size_t label_len = strlen(item->label);
  size_t pixel_len = (size_t)item->width * item->height * 4;
  if (id_len > MAX_ID || label_len > MAX_LABEL) return;
  size_t length = 10 + id_len + label_len + pixel_len;
  uint8_t *body = g_malloc(length);
  body[0] = HOST_MAGIC;
  body[1] = HOST_VERSION;
  body[2] = 1; /* upsert */
  le16(body + 3, (uint16_t)id_len);
  le16(body + 5, (uint16_t)label_len);
  body[7] = item->width;
  body[8] = item->height;
  body[9] = item->status;
  memcpy(body + 10, item->id, id_len);
  memcpy(body + 10 + id_len, item->label, label_len);
  memcpy(body + 10 + id_len + label_len, item->pixels, pixel_len);
  send_frame(body, length);
  g_free(body);
}

static void send_remove(Item *item) {
  size_t id_len = strlen(item->id);
  if (id_len > MAX_ID) return;
  uint8_t body[5 + MAX_ID];
  body[0] = HOST_MAGIC;
  body[1] = HOST_VERSION;
  body[2] = 2; /* remove */
  le16(body + 3, (uint16_t)id_len);
  memcpy(body + 5, item->id, id_len);
  send_frame(body, 5 + id_len);
}

static void notice_free(gpointer pointer) {
  Notice *notice = pointer;
  if (notice->timer) g_source_remove(notice->timer);
  g_free(notice->owner);
  g_free(notice->title);
  g_free(notice->body);
  for (guint i = 0; i < notice->action_count; ++i) {
    g_free(notice->keys[i]);
    g_free(notice->labels[i]);
  }
  g_free(notice);
}

static void publish_notice(Notice *notice) {
  size_t title_len = strlen(notice->title);
  size_t body_len = strlen(notice->body);
  size_t length = 16 + title_len + body_len;
  for (guint i = 0; i < notice->action_count; ++i)
    length += 2 + strlen(notice->keys[i]) + strlen(notice->labels[i]);
  if (length > 8192) return;
  uint8_t *frame = g_malloc(length);
  frame[0] = HOST_MAGIC; frame[1] = HOST_VERSION; frame[2] = 4;
  le32(frame + 3, notice->id);
  le16(frame + 7, (uint16_t)title_len);
  le16(frame + 9, (uint16_t)body_len);
  frame[11] = notice->action_count;
  le32(frame + 12, (uint32_t)notice->timeout);
  size_t offset = 16;
  memcpy(frame + offset, notice->title, title_len); offset += title_len;
  memcpy(frame + offset, notice->body, body_len); offset += body_len;
  for (guint i = 0; i < notice->action_count; ++i) {
    size_t key_len = strlen(notice->keys[i]);
    size_t label_len = strlen(notice->labels[i]);
    frame[offset++] = (uint8_t)key_len;
    frame[offset++] = (uint8_t)label_len;
    memcpy(frame + offset, notice->keys[i], key_len); offset += key_len;
    memcpy(frame + offset, notice->labels[i], label_len); offset += label_len;
  }
  send_frame(frame, length);
  g_free(frame);
}

static void send_notice_remove(uint32_t id) {
  uint8_t frame[7] = {HOST_MAGIC, HOST_VERSION, 5, 0, 0, 0, 0};
  le32(frame + 3, id);
  send_frame(frame, sizeof frame);
}

static Notice *find_notice(uint32_t id, guint *index) {
  for (guint i = 0; i < notices->len; ++i) {
    Notice *notice = g_ptr_array_index(notices, i);
    if (notice->id == id) {
      if (index) *index = i;
      return notice;
    }
  }
  return NULL;
}

static void close_notice(guint index, uint32_t reason, gboolean tell_host) {
  Notice *notice = g_ptr_array_index(notices, index);
  uint32_t id = notice->id;
  if (tell_host) send_notice_remove(id);
  if (bus) g_dbus_connection_emit_signal(bus, NULL, NOTICE_PATH, NOTICE_NAME,
    "NotificationClosed", g_variant_new("(uu)", id, reason), NULL);
  g_ptr_array_remove_index(notices, index);
}

static gboolean notice_expired(gpointer data) {
  uint32_t id = GPOINTER_TO_UINT(data);
  guint index;
  Notice *notice = find_notice(id, &index);
  if (notice) {
    notice->timer = 0;
    close_notice(index, 1, TRUE);
  }
  return G_SOURCE_REMOVE;
}

static char *item_address(Item *item) {
  return g_strconcat(item->service, item->path, NULL);
}

static void watcher_property_changed(void) {
  if (!bus) return;
  GVariantBuilder names;
  g_variant_builder_init(&names, G_VARIANT_TYPE("as"));
  for (guint i = 0; i < items->len; ++i) {
    Item *item = g_ptr_array_index(items, i);
    char *address = item_address(item);
    g_variant_builder_add(&names, "s", address);
    g_free(address);
  }
  GVariantBuilder changed;
  g_variant_builder_init(&changed, G_VARIANT_TYPE("a{sv}"));
  g_variant_builder_add(&changed, "{sv}", "RegisteredStatusNotifierItems",
                        g_variant_builder_end(&names));
  g_dbus_connection_emit_signal(bus, NULL, SNI_PATH,
    "org.freedesktop.DBus.Properties", "PropertiesChanged",
    g_variant_new("(s@a{sv}@as)", SNI_INTERFACE,
      g_variant_builder_end(&changed), g_variant_new_strv(NULL, 0)), NULL);
}

static void item_free(gpointer pointer) {
  Item *item = pointer;
  if (bus && item->signal_id)
    g_dbus_connection_signal_unsubscribe(bus, item->signal_id);
  g_free(item->service);
  g_free(item->owner);
  g_free(item->path);
  g_free(item->id);
  g_free(item);
}

static void unregister_item(guint index) {
  Item *item = g_ptr_array_index(items, index);
  char *address = item_address(item);
  send_remove(item);
  if (bus)
    g_dbus_connection_emit_signal(bus, NULL, SNI_PATH, SNI_INTERFACE,
      "StatusNotifierItemUnregistered", g_variant_new("(s)", address), NULL);
  g_ptr_array_remove_index(items, index);
  watcher_property_changed();
  g_free(address);
}

/* The SNI spec stores each pixmap in network-order ARGB32. The Yore tray API
 * expects straight RGBA bytes. Choose a bounded size nearest its 24px slot. */
static void read_pixmap(Item *item, GVariant *dict, const char *key) {
  GVariant *pixmaps = g_variant_lookup_value(dict, key, G_VARIANT_TYPE("a(iiay)"));
  if (!pixmaps) return;
  GVariantIter iter;
  g_variant_iter_init(&iter, pixmaps);
  gint width, height, best_score = G_MAXINT;
  GVariant *array;
  while (g_variant_iter_next(&iter, "(ii@ay)", &width, &height, &array)) {
    gsize n = 0;
    const uint8_t *argb = g_variant_get_fixed_array(array, &n, 1);
    if (width > 0 && width <= MAX_ICON && height > 0 && height <= MAX_ICON &&
        n == (gsize)width * height * 4) {
      int score = abs(width - 24) + abs(height - 24);
      if (score < best_score) {
        best_score = score;
        item->width = (uint8_t)width;
        item->height = (uint8_t)height;
        for (gsize j = 0; j < n; j += 4) {
          item->pixels[j] = argb[j + 1];
          item->pixels[j + 1] = argb[j + 2];
          item->pixels[j + 2] = argb[j + 3];
          item->pixels[j + 3] = argb[j];
        }
      }
    }
    g_variant_unref(array);
  }
  g_variant_unref(pixmaps);
}

/* Many SNI producers publish IconName only. Resolve common theme locations
 * inside the guest profile, then let pixbuf decode and scale the file. */
static void read_named_icon(Item *item, GVariant *dict, const char *key) {
  const char *name = NULL;
  if (!g_variant_lookup(dict, key, "&s", &name) || !*name ||
      strlen(name) > 128 || strchr(name, '/') || strstr(name, "..")) return;
  const char *theme_path = NULL;
  g_variant_lookup(dict, "IconThemePath", "&s", &theme_path);
  const char *roots[] = {
    theme_path && g_path_is_absolute(theme_path) ? theme_path : NULL,
    "/run/current-system/sw/share/icons/hicolor",
    "/run/current-system/sw/share/icons/Adwaita",
    "/run/current-system/sw/share/pixmaps",
    "/root/.nix-profile/share/icons/hicolor",
    "/root/.nix-profile/share/icons/Adwaita",
    "/root/.nix-profile/share/pixmaps",
    NULL,
  };
  const char *sizes[] = { "24x24", "32x32", "48x48", "64x64", "scalable", NULL };
  const char *contexts[] = { "status", "apps", "actions", NULL };
  const char *extensions[] = { "png", "svg", "xpm", NULL };
  for (size_t root = 0; root < G_N_ELEMENTS(roots) - 1 && !item->width; ++root) {
    if (!roots[root]) continue;
    for (size_t size = 0; sizes[size] && !item->width; ++size)
      for (size_t context = 0; contexts[context] && !item->width; ++context)
        for (size_t extension = 0; extensions[extension] && !item->width; ++extension) {
          char *file = g_strdup_printf("%s.%s", name, extensions[extension]);
          char *path = g_str_has_suffix(roots[root], "/pixmaps")
            ? g_build_filename(roots[root], file, NULL)
            : g_build_filename(roots[root], sizes[size], contexts[context], file, NULL);
          g_free(file);
          GError *error = NULL;
          GdkPixbuf *pixbuf = gdk_pixbuf_new_from_file_at_scale(path, 24, 24, TRUE, &error);
          g_clear_error(&error);
          g_free(path);
          if (!pixbuf) continue;
          int width = gdk_pixbuf_get_width(pixbuf);
          int height = gdk_pixbuf_get_height(pixbuf);
          int channels = gdk_pixbuf_get_n_channels(pixbuf);
          int stride = gdk_pixbuf_get_rowstride(pixbuf);
          const guchar *pixels = gdk_pixbuf_read_pixels(pixbuf);
          if (width > 0 && width <= MAX_ICON && height > 0 && height <= MAX_ICON &&
              (channels == 3 || channels == 4)) {
            item->width = (uint8_t)width;
            item->height = (uint8_t)height;
            for (int y = 0; y < height; ++y)
              for (int x = 0; x < width; ++x) {
                const guchar *source = pixels + y * stride + x * channels;
                uint8_t *dest = item->pixels + ((size_t)y * width + x) * 4;
                dest[0] = source[0]; dest[1] = source[1]; dest[2] = source[2];
                dest[3] = channels == 4 ? source[3] : 255;
              }
          }
          g_object_unref(pixbuf);
        }
  }
}

static void refresh_item(Item *item) {
  if (!bus) return;
  GError *error = NULL;
  GVariant *reply = g_dbus_connection_call_sync(bus, item->service, item->path,
    "org.freedesktop.DBus.Properties", "GetAll",
    g_variant_new("(s)", ITEM_INTERFACE), G_VARIANT_TYPE("(a{sv})"),
    G_DBUS_CALL_FLAGS_NONE, 2000, NULL, &error);
  if (!reply) {
    g_debug("SNI GetAll %s: %s", item->id, error->message);
    g_clear_error(&error);
    return;
  }
  GVariant *dict;
  g_variant_get(reply, "(@a{sv})", &dict);
  const char *status = NULL, *title = NULL;
  if (g_variant_lookup(dict, "Status", "&s", &status)) {
    if (g_strcmp0(status, "Passive") == 0) item->status = 0;
    else if (g_strcmp0(status, "NeedsAttention") == 0) item->status = 2;
    else item->status = 1;
  }
  if (g_variant_lookup(dict, "Title", "&s", &title))
    g_strlcpy(item->label, title, sizeof item->label);
  GVariant *tooltip = g_variant_lookup_value(dict, "ToolTip",
    G_VARIANT_TYPE("(sa(iiay)ss)"));
  if (tooltip) {
    GVariant *tooltip_title = g_variant_get_child_value(tooltip, 2);
    GVariant *tooltip_body = g_variant_get_child_value(tooltip, 3);
    const char *preferred = g_variant_get_string(tooltip_title, NULL);
    if (!*preferred) preferred = g_variant_get_string(tooltip_body, NULL);
    if (*preferred && (!title || !*title))
      g_strlcpy(item->label, preferred, sizeof item->label);
    g_variant_unref(tooltip_title);
    g_variant_unref(tooltip_body);
    g_variant_unref(tooltip);
  }
  g_variant_lookup(dict, "ItemIsMenu", "b", &item->item_is_menu);
  item->width = item->height = 0;
  read_pixmap(item, dict, item->status == 2 ? "AttentionIconPixmap" : "IconPixmap");
  if (!item->width)
    read_named_icon(item, dict, item->status == 2 ? "AttentionIconName" : "IconName");
  if (!item->width && item->status == 2)
    read_pixmap(item, dict, "IconPixmap");
  if (!item->width && item->status == 2)
    read_named_icon(item, dict, "IconName");
  publish(item);
  g_variant_unref(dict);
  g_variant_unref(reply);
}

static gboolean refresh_registered_item(gpointer data) {
  const char *id = data;
  for (guint i = 0; i < items->len; ++i) {
    Item *item = g_ptr_array_index(items, i);
    if (g_strcmp0(item->id, id) == 0) {
      refresh_item(item);
      break;
    }
  }
  return G_SOURCE_REMOVE;
}

static void item_signal(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *signal,
  GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)parameters;
  if (g_strcmp0(interface, ITEM_INTERFACE) != 0 &&
      !(g_strcmp0(interface, "org.freedesktop.DBus.Properties") == 0 &&
        g_strcmp0(signal, "PropertiesChanged") == 0)) return;
  refresh_item(data);
}

static void name_owner_changed(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *signal,
  GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface;
  (void)signal; (void)data;
  const char *name, *old_owner, *new_owner;
  g_variant_get(parameters, "(&s&s&s)", &name, &old_owner, &new_owner);
  if (*new_owner) return;
  for (guint i = items->len; i > 0; --i) {
    Item *item = g_ptr_array_index(items, i - 1);
    if (g_strcmp0(item->owner, name) == 0 ||
        g_strcmp0(item->service, name) == 0)
      unregister_item(i - 1);
  }
  for (guint i = notices->len; i > 0; --i) {
    Notice *notice = g_ptr_array_index(notices, i - 1);
    if (g_strcmp0(notice->owner, name) == 0)
      close_notice(i - 1, 3, TRUE);
  }
}

static void call_item_action(const char *id, uint8_t action, int x, int y) {
  if (!bus || action < 1 || action > 3) return;
  for (guint i = 0; i < items->len; ++i) {
    Item *item = g_ptr_array_index(items, i);
    if (g_strcmp0(item->id, id) != 0 || item->status == 0) continue;
    const char *method = action == 1 && !item->item_is_menu ? "Activate" :
                         action == 2 ? "SecondaryActivate" : "ContextMenu";
    g_dbus_connection_call(bus, item->service, item->path, ITEM_INTERFACE,
      method, g_variant_new("(ii)", x, y), NULL, G_DBUS_CALL_FLAGS_NONE,
      2000, NULL, NULL, NULL);
    break;
  }
}

static gboolean host_input_ready(GIOChannel *channel, GIOCondition condition,
  gpointer data) {
  (void)channel; (void)data;
  if (condition & (G_IO_HUP | G_IO_ERR | G_IO_NVAL)) {
    host_watch_id = 0;
    close_host();
    return G_SOURCE_REMOVE;
  }
  ssize_t n = recv(host_fd, host_input + host_input_size,
                   sizeof host_input - host_input_size, 0);
  if (n <= 0) {
    host_watch_id = 0;
    close_host();
    return G_SOURCE_REMOVE;
  }
  host_input_size += (size_t)n;
  size_t offset = 0;
  while (host_input_size - offset >= 4) {
    uint32_t length = read32(host_input + offset);
    if (length > 5 + MAX_ID + 5) {
      host_watch_id = 0;
      close_host();
      return G_SOURCE_REMOVE;
    }
    if (host_input_size - offset < 4 + length) break;
    const uint8_t *body = host_input + offset + 4;
    if (length >= 10 && body[0] == HOST_MAGIC && body[1] == HOST_VERSION &&
        body[2] == 3 && read16(body + 3) == length - 10 &&
        read16(body + 3) <= MAX_ID) {
      char id[MAX_ID + 1];
      size_t id_len = read16(body + 3);
      memcpy(id, body + 10, id_len);
      id[id_len] = 0;
      call_item_action(id, body[5], read16(body + 6), read16(body + 8));
    }
    if (length >= 10 && body[0] == HOST_MAGIC && body[1] == HOST_VERSION &&
        body[2] == 6 && read16(body + 8) == length - 10 &&
        read16(body + 8) <= 64) {
      guint index;
      Notice *notice = find_notice(read32(body + 3), &index);
      if (notice && body[7] == 0) {
        char key[65];
        size_t key_len = read16(body + 8);
        memcpy(key, body + 10, key_len); key[key_len] = 0;
        for (guint i = 0; i < notice->action_count; ++i)
          if (g_strcmp0(notice->keys[i], key) == 0) {
            g_dbus_connection_emit_signal(bus, NULL, NOTICE_PATH, NOTICE_NAME,
              "ActionInvoked", g_variant_new("(us)", notice->id, key), NULL);
            break;
          }
      } else if (notice && body[7] >= 1 && body[7] <= 4)
        close_notice(index, body[7], FALSE);
    }
    offset += 4 + length;
  }
  memmove(host_input, host_input + offset, host_input_size - offset);
  host_input_size -= offset;
  return G_SOURCE_CONTINUE;
}

static gboolean connect_host(gpointer data) {
  (void)data;
  if (host_fd >= 0 || !bus) return G_SOURCE_CONTINUE;
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return G_SOURCE_CONTINUE;
  struct sockaddr_vm address = {0};
  address.svm_family = AF_VSOCK;
  address.svm_port = TRAY_PORT;
  address.svm_cid = VMADDR_CID_HOST;
  if (connect(fd, (struct sockaddr *)&address, sizeof address) < 0) {
    close(fd);
    return G_SOURCE_CONTINUE;
  }
  host_fd = fd;
  GIOChannel *channel = g_io_channel_unix_new(fd);
  host_watch_id = g_io_add_watch(channel, G_IO_IN | G_IO_HUP | G_IO_ERR,
                                 host_input_ready, NULL);
  g_io_channel_unref(channel);
  for (guint i = 0; i < items->len && host_fd >= 0; ++i)
    publish(g_ptr_array_index(items, i));
  for (guint i = 0; i < notices->len && host_fd >= 0; ++i)
    publish_notice(g_ptr_array_index(notices, i));
  return G_SOURCE_CONTINUE;
}

static void watcher_method(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *method,
  GVariant *parameters, GDBusMethodInvocation *invocation, gpointer data) {
  (void)path; (void)interface; (void)data;
  const char *argument;
  g_variant_get(parameters, "(&s)", &argument);
  if (g_strcmp0(method, "RegisterStatusNotifierHost") == 0) {
    g_dbus_method_invocation_return_value(invocation, NULL);
    g_dbus_connection_emit_signal(connection, NULL, SNI_PATH, SNI_INTERFACE,
      "StatusNotifierHostRegistered", NULL, NULL);
    return;
  }
  if (g_strcmp0(method, "RegisterStatusNotifierItem") != 0) return;
  const char *service = argument[0] == '/' ? sender : argument;
  const char *item_path = argument[0] == '/' ? argument : "/StatusNotifierItem";
  if (!g_dbus_is_name(service) || !g_variant_is_object_path(item_path) ||
      items->len >= MAX_ITEMS) {
    g_dbus_method_invocation_return_dbus_error(invocation,
      "org.freedesktop.DBus.Error.InvalidArgs", "Invalid SNI item or watcher full");
    return;
  }
  char *owner = NULL;
  if (argument[0] == '/') owner = g_strdup(sender);
  else {
    GError *error = NULL;
    GVariant *reply = g_dbus_connection_call_sync(connection,
      "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
      "GetNameOwner", g_variant_new("(s)", service), G_VARIANT_TYPE("(s)"),
      G_DBUS_CALL_FLAGS_NONE, 2000, NULL, &error);
    if (reply) {
      g_variant_get(reply, "(s)", &owner);
      g_variant_unref(reply);
    } else g_clear_error(&error);
  }
  if (!owner || g_strcmp0(owner, sender) != 0) {
    g_free(owner);
    g_dbus_method_invocation_return_dbus_error(invocation,
      "org.freedesktop.DBus.Error.AccessDenied", "Item name must belong to caller");
    return;
  }
  char *id = g_strconcat(owner, ":", item_path, NULL);
  if (strlen(id) > MAX_ID) {
    g_free(owner); g_free(id);
    g_dbus_method_invocation_return_dbus_error(invocation,
      "org.freedesktop.DBus.Error.InvalidArgs", "SNI item ID too long");
    return;
  }
  for (guint i = 0; i < items->len; ++i) {
    Item *existing = g_ptr_array_index(items, i);
    if (g_strcmp0(existing->id, id) == 0) {
      g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, refresh_registered_item,
        g_strdup(id), g_free);
      g_free(owner); g_free(id);
      g_dbus_method_invocation_return_value(invocation, NULL);
      return;
    }
  }
  Item *item = g_new0(Item, 1);
  item->service = g_strdup(service);
  item->owner = owner;
  item->path = g_strdup(item_path);
  item->id = id;
  item->status = 1;
  g_strlcpy(item->label, "Linux application", sizeof item->label);
  item->signal_id = g_dbus_connection_signal_subscribe(connection, owner,
    NULL, NULL, item_path, NULL, G_DBUS_SIGNAL_FLAGS_NONE, item_signal,
    item, NULL);
  g_ptr_array_add(items, item);
  char *address = item_address(item);
  g_dbus_method_invocation_return_value(invocation, NULL);
  g_dbus_connection_emit_signal(connection, NULL, SNI_PATH, SNI_INTERFACE,
    "StatusNotifierItemRegistered", g_variant_new("(s)", address), NULL);
  watcher_property_changed();
  g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, refresh_registered_item,
    g_strdup(id), g_free);
  g_free(address);
}

static GVariant *watcher_property(GDBusConnection *connection,
  const char *sender, const char *path, const char *interface,
  const char *property, GError **error, gpointer data) {
  (void)connection; (void)sender; (void)path; (void)interface;
  (void)error; (void)data;
  if (g_strcmp0(property, "IsStatusNotifierHostRegistered") == 0)
    return g_variant_new_boolean(TRUE);
  if (g_strcmp0(property, "ProtocolVersion") == 0)
    return g_variant_new_int32(0);
  if (g_strcmp0(property, "RegisteredStatusNotifierItems") != 0) return NULL;
  GVariantBuilder names;
  g_variant_builder_init(&names, G_VARIANT_TYPE("as"));
  for (guint i = 0; i < items->len; ++i) {
    Item *item = g_ptr_array_index(items, i);
    char *address = item_address(item);
    g_variant_builder_add(&names, "s", address);
    g_free(address);
  }
  return g_variant_builder_end(&names);
}

static const GDBusInterfaceVTable watcher_vtable = {
  watcher_method, watcher_property, NULL, {0}
};

static void notice_method(GDBusConnection *connection, const char *sender,
  const char *path, const char *interface, const char *method,
  GVariant *parameters, GDBusMethodInvocation *invocation, gpointer data) {
  (void)connection; (void)path; (void)interface; (void)data;
  if (g_strcmp0(method, "GetCapabilities") == 0) {
    const char *capabilities[] = {"actions", "body", NULL};
    g_dbus_method_invocation_return_value(invocation,
      g_variant_new("(^as)", capabilities));
    return;
  }
  if (g_strcmp0(method, "GetServerInformation") == 0) {
    g_dbus_method_invocation_return_value(invocation,
      g_variant_new("(ssss)", "Yore", "Yore", "1.0", "1.2"));
    return;
  }
  if (g_strcmp0(method, "CloseNotification") == 0) {
    uint32_t id;
    g_variant_get(parameters, "(u)", &id);
    guint index;
    Notice *notice = find_notice(id, &index);
    if (notice && g_strcmp0(notice->owner, sender) == 0)
      close_notice(index, 3, TRUE);
    g_dbus_method_invocation_return_value(invocation, NULL);
    return;
  }
  if (g_strcmp0(method, "Notify") != 0) return;
  const char *app_name, *icon, *title, *body;
  uint32_t replaces;
  int32_t timeout;
  GVariant *actions, *hints;
  g_variant_get(parameters, "(&su&s&s&s@as@a{sv}i)",
    &app_name, &replaces, &icon, &title, &body, &actions, &hints, &timeout);
  (void)app_name; (void)icon;
  gsize action_strings = 0;
  const gchar **values = g_variant_get_strv(actions, &action_strings);
  Notice *replacement = replaces ? find_notice(replaces, NULL) : NULL;
  if (replacement && g_strcmp0(replacement->owner, sender) != 0)
    replacement = NULL;
  gboolean valid = strlen(title) <= 256 && strlen(body) <= 4096 &&
    g_utf8_validate(title, -1, NULL) && g_utf8_validate(body, -1, NULL) &&
    action_strings <= 16 && action_strings % 2 == 0 &&
    (replacement || notices->len < 128);
  for (gsize i = 0; valid && i < action_strings; ++i)
    valid = strlen(values[i]) > 0 && strlen(values[i]) <= 64;
  if (!valid) {
    g_dbus_method_invocation_return_dbus_error(invocation,
      "org.freedesktop.DBus.Error.LimitsExceeded", "Notification exceeds Yore limits");
    g_free(values); g_variant_unref(actions); g_variant_unref(hints);
    return;
  }
  Notice *notice = replacement;
  if (notice) {
    if (notice->timer) g_source_remove(notice->timer);
    notice->timer = 0;
    g_free(notice->title); g_free(notice->body);
    for (guint i = 0; i < notice->action_count; ++i) {
      g_free(notice->keys[i]); g_free(notice->labels[i]);
    }
  } else {
    notice = g_new0(Notice, 1);
    notice->owner = g_strdup(sender);
    do {
      notice->id = next_notice_id++;
    } while (!notice->id || find_notice(notice->id, NULL));
    g_ptr_array_add(notices, notice);
  }
  notice->title = g_strdup(title);
  notice->body = g_strdup(body);
  notice->action_count = (uint8_t)(action_strings / 2);
  for (guint i = 0; i < notice->action_count; ++i) {
    notice->keys[i] = g_strdup(values[i * 2]);
    notice->labels[i] = g_strdup(values[i * 2 + 1]);
  }
  notice->timeout = timeout < 0 ? 4500 : MIN(timeout, 86400000);
  if (notice->timeout > 0)
    notice->timer = g_timeout_add((guint)notice->timeout,
      notice_expired, GUINT_TO_POINTER(notice->id));
  publish_notice(notice);
  g_dbus_method_invocation_return_value(invocation,
    g_variant_new("(u)", notice->id));
  g_free(values); g_variant_unref(actions); g_variant_unref(hints);
}

static const GDBusInterfaceVTable notice_vtable = {
  notice_method, NULL, NULL, {0}
};

static void bus_acquired(GDBusConnection *connection, const char *name,
  gpointer data) {
  (void)name; (void)data;
  bus = connection;
  GError *error = NULL;
  GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(watcher_xml, &error);
  if (!node) g_error("SNI watcher introspection: %s", error->message);
  object_id = g_dbus_connection_register_object(connection, SNI_PATH,
    node->interfaces[0], &watcher_vtable, NULL, NULL, &error);
  g_dbus_node_info_unref(node);
  if (!object_id) g_error("SNI watcher export: %s", error->message);
  node = g_dbus_node_info_new_for_xml(notice_xml, &error);
  if (!node) g_error("Notifications introspection: %s", error->message);
  notice_object_id = g_dbus_connection_register_object(connection, NOTICE_PATH,
    node->interfaces[0], &notice_vtable, NULL, NULL, &error);
  g_dbus_node_info_unref(node);
  if (!notice_object_id) g_error("Notifications export: %s", error->message);
  notice_name_id = g_bus_own_name_on_connection(connection, NOTICE_NAME,
    G_BUS_NAME_OWNER_FLAGS_NONE, NULL, NULL, NULL, NULL);
  owner_signal_id = g_dbus_connection_signal_subscribe(connection,
    "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
    "/org/freedesktop/DBus", NULL, G_DBUS_SIGNAL_FLAGS_NONE,
    name_owner_changed, NULL, NULL);
}

static void name_lost(GDBusConnection *connection, const char *name,
  gpointer data) {
  (void)name; (void)data;
  close_host();
  if (connection && owner_signal_id)
    g_dbus_connection_signal_unsubscribe(connection, owner_signal_id);
  if (connection && object_id)
    g_dbus_connection_unregister_object(connection, object_id);
  if (connection && notice_object_id)
    g_dbus_connection_unregister_object(connection, notice_object_id);
  if (notice_name_id) g_bus_unown_name(notice_name_id);
  owner_signal_id = object_id = notice_object_id = notice_name_id = 0;
  g_ptr_array_set_size(items, 0);
  g_ptr_array_set_size(notices, 0);
  bus = NULL;
}

int main(void) {
  items = g_ptr_array_new_with_free_func(item_free);
  notices = g_ptr_array_new_with_free_func(notice_free);
  guint owner = g_bus_own_name(G_BUS_TYPE_SESSION, SNI_NAME,
    G_BUS_NAME_OWNER_FLAGS_NONE, bus_acquired, NULL, name_lost, NULL, NULL);
  g_timeout_add_seconds(1, connect_host, NULL);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_main_loop_run(loop);
  g_main_loop_unref(loop);
  g_bus_unown_name(owner);
  close_host();
  g_ptr_array_unref(items);
  g_ptr_array_unref(notices);
  return 0;
}
