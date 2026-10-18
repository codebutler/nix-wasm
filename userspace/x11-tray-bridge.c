/* XEmbed notification area for the rootless Xwayland session. Any X11 client
 * can dock here; the pixels and button events cross AF_VSOCK to Yore's Linux
 * tray bridge. No program names or client-specific behavior belong here. */
#define _GNU_SOURCE
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xrender.h>
#include <X11/extensions/XTest.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/vm_sockets.h>
#else
struct sockaddr_vm {
  unsigned short svm_family;
  unsigned short svm_reserved1;
  unsigned int svm_port;
  unsigned int svm_cid;
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

#define TRAY_PORT 1026
#define MAX_ICONS 32
#define ICON_SIZE 24
#define PIXELS (ICON_SIZE * ICON_SIZE * 4)
#define XEMBED_EMBEDDED_NOTIFY 0
#define SYSTEM_TRAY_REQUEST_DOCK 0

struct icon {
  Window window;
  int occupied;
  int announced;
  uint8_t last[PIXELS];
};

static Display *display;
static Window manager;
static Atom opcode_atom;
static Atom xembed_atom;
static unsigned long alpha_mask;
static struct icon icons[MAX_ICONS];
static int host_fd = -1;
static uint8_t input[128];
static size_t input_size;

static int x_error(Display *unused, XErrorEvent *event) {
  (void)unused;
  /* A client can destroy its icon between a dock event and XGetImage. Do not
   * let that routine race take down the tray manager and every other icon. */
  if (event->error_code != BadWindow && event->error_code != BadDrawable)
    fprintf(stderr, "x11-tray-bridge: X error %u request %u\n",
            event->error_code, event->request_code);
  return 0;
}

static void le16(uint8_t *out, uint16_t value) {
  out[0] = (uint8_t)value;
  out[1] = (uint8_t)(value >> 8);
}

static void le32(uint8_t *out, uint32_t value) {
  for (int i = 0; i < 4; ++i) out[i] = (uint8_t)(value >> (i * 8));
}

static uint16_t read16(const uint8_t *in) {
  return (uint16_t)(in[0] | ((uint16_t)in[1] << 8));
}

static uint32_t read32(const uint8_t *in) {
  return (uint32_t)in[0] | ((uint32_t)in[1] << 8) |
         ((uint32_t)in[2] << 16) | ((uint32_t)in[3] << 24);
}

static int write_all(int fd, const uint8_t *data, size_t length) {
  while (length) {
    ssize_t count = send(fd, data, length, MSG_NOSIGNAL);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    data += count;
    length -= (size_t)count;
  }
  return 0;
}

static void disconnect_host(void) {
  if (host_fd >= 0) close(host_fd);
  host_fd = -1;
  input_size = 0;
  for (int i = 0; i < MAX_ICONS; ++i) icons[i].announced = 0;
}

static void send_frame(const uint8_t *body, uint32_t length) {
  if (host_fd < 0) return;
  uint8_t header[4];
  le32(header, length);
  if (write_all(host_fd, header, 4) || write_all(host_fd, body, length))
    disconnect_host();
}

static void send_remove(Window window) {
  uint8_t body[5] = { 'R' };
  le32(body + 1, (uint32_t)window);
  send_frame(body, sizeof body);
}

static int component(unsigned long pixel, unsigned long mask) {
  if (!mask) return 0;
  unsigned shift = 0;
  while (!(mask & 1)) { mask >>= 1; ++shift; }
  unsigned long value = (pixel >> shift) & mask;
  return (int)((value * 255 + mask / 2) / mask);
}

static void publish_icon(struct icon *icon) {
  if (host_fd < 0 || !icon->occupied) return;
  XWindowAttributes attributes;
  if (!XGetWindowAttributes(display, icon->window, &attributes) ||
      attributes.map_state != IsViewable) return;
  XImage *image = XGetImage(display, icon->window, 0, 0, ICON_SIZE,
                            ICON_SIZE, AllPlanes, ZPixmap);
  if (!image) return;
  uint8_t pixels[PIXELS];
  for (int y = 0; y < ICON_SIZE; ++y) {
    for (int x = 0; x < ICON_SIZE; ++x) {
      unsigned long color = XGetPixel(image, x, y);
      size_t offset = ((size_t)y * ICON_SIZE + x) * 4;
      pixels[offset] = (uint8_t)component(color, image->red_mask);
      pixels[offset + 1] = (uint8_t)component(color, image->green_mask);
      pixels[offset + 2] = (uint8_t)component(color, image->blue_mask);
      pixels[offset + 3] = alpha_mask && image->depth == 32
        ? (uint8_t)component(color, alpha_mask) : 255;
    }
  }
  XDestroyImage(image);
  if (icon->announced && !memcmp(icon->last, pixels, sizeof pixels)) return;
  memcpy(icon->last, pixels, sizeof pixels);

  char *name = NULL;
  if (!XFetchName(display, icon->window, &name) || !name || !*name) {
    if (name) XFree(name);
    name = NULL;
  }
  const char *label = name ? name : "Linux notification";
  size_t label_len = strlen(label);
  if (label_len > 256) label_len = 256;
  uint8_t body[9 + 256 + PIXELS];
  body[0] = 'I';
  le32(body + 1, (uint32_t)icon->window);
  body[5] = ICON_SIZE;
  body[6] = ICON_SIZE;
  le16(body + 7, (uint16_t)label_len);
  memcpy(body + 9, label, label_len);
  memcpy(body + 9 + label_len, pixels, sizeof pixels);
  send_frame(body, (uint32_t)(9 + label_len + sizeof pixels));
  if (name) XFree(name);
  icon->announced = host_fd >= 0;
}

static struct icon *find_icon(Window window) {
  for (int i = 0; i < MAX_ICONS; ++i)
    if (icons[i].occupied && icons[i].window == window) return &icons[i];
  return NULL;
}

static void resize_manager(void) {
  int slots = 1;
  for (int i = 0; i < MAX_ICONS; ++i)
    if (icons[i].occupied) slots = i + 1;
  XResizeWindow(display, manager, slots * ICON_SIZE, ICON_SIZE);
}

static void remove_icon(Window window) {
  struct icon *icon = find_icon(window);
  if (!icon) return;
  if (icon->announced) send_remove(window);
  memset(icon, 0, sizeof *icon);
  resize_manager();
}

static void dock(Window window) {
  if (!window || find_icon(window)) return;
  struct icon *icon = NULL;
  for (int i = 0; i < MAX_ICONS; ++i)
    if (!icons[i].occupied) { icon = &icons[i]; break; }
  if (!icon) return;
  icon->window = window;
  icon->occupied = 1;
  XSelectInput(display, window, StructureNotifyMask | PropertyChangeMask);
  int slot = (int)(icon - icons);
  /* Keep the mapped embedder as small as the occupied slots allow. Xwayland
   * still needs a viewable parent for XGetImage, but it need not expose an
   * empty 768-pixel strip to the compositor for a single tray icon. */
  resize_manager();
  XReparentWindow(display, window, manager, slot * ICON_SIZE, 0);
  XResizeWindow(display, window, ICON_SIZE, ICON_SIZE);
  XMapWindow(display, window);
  XEvent notice = {0};
  notice.xclient.type = ClientMessage;
  notice.xclient.window = window;
  notice.xclient.message_type = xembed_atom;
  notice.xclient.format = 32;
  notice.xclient.data.l[1] = XEMBED_EMBEDDED_NOTIFY;
  notice.xclient.data.l[3] = manager;
  XSendEvent(display, window, False, NoEventMask, &notice);
  XFlush(display);
  publish_icon(icon);
}

static void button(Window window, int number, int x, int y) {
  struct icon *icon = find_icon(window);
  if (!icon) return;
  /* GTK positions its own menu from the XEmbed window. Keep the embedder at
   * the clicked Yore tray coordinates, beneath the host taskbar, while its
   * Wayland popup opens above it. */
  XMoveWindow(display, manager,
              x - (int)(icon - icons) * ICON_SIZE - ICON_SIZE / 2,
              y - ICON_SIZE / 2);
  XSync(display, False);
  /* XSendEvent marks its events synthetic; GTK tray widgets can ignore them,
   * and the actual handler may live on a child of the docked XEmbed window.
   * XTEST injects normal pointer events through Xwayland hit testing. */
  XTestFakeMotionEvent(display, DefaultScreen(display), x, y, CurrentTime);
  XTestFakeButtonEvent(display, number, True, CurrentTime);
  XTestFakeButtonEvent(display, number, False, CurrentTime);
  /* The guest pointer is otherwise left over the docked icon indefinitely:
   * GTK opens a tooltip that can cover its own context menu. The host pointer
   * remains where the user put it; release the synthetic guest hover. */
  XTestFakeMotionEvent(display, DefaultScreen(display), 0, 0, CurrentTime);
  XFlush(display);
}

static void read_host(void) {
  ssize_t count = recv(host_fd, input + input_size, sizeof input - input_size, 0);
  if (count <= 0) { disconnect_host(); return; }
  input_size += (size_t)count;
  size_t offset = 0;
  while (input_size - offset >= 4) {
    uint32_t length = read32(input + offset);
    if (length > 32) { disconnect_host(); return; }
    if (input_size - offset < length + 4) break;
    const uint8_t *body = input + offset + 4;
    if (length == 10 && body[0] == 'B')
      button((Window)read32(body + 1), body[5],
             read16(body + 6), read16(body + 8));
    offset += length + 4;
  }
  if (offset) {
    input_size -= offset;
    memmove(input, input + offset, input_size);
  }
}

static void connect_host(void) {
  int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
  if (fd < 0) return;
  struct sockaddr_vm address = {0};
  address.svm_family = AF_VSOCK;
  address.svm_cid = VMADDR_CID_HOST;
  address.svm_port = TRAY_PORT;
  if (connect(fd, (struct sockaddr *)&address, sizeof address)) {
    close(fd);
    return;
  }
  host_fd = fd;
  for (int i = 0; i < MAX_ICONS; ++i) publish_icon(&icons[i]);
}

int main(void) {
  display = XOpenDisplay(NULL);
  if (!display) { fprintf(stderr, "x11-tray-bridge: X display unavailable\n"); return 1; }
  XSetErrorHandler(x_error);
  Window root = DefaultRootWindow(display);
  Visual *visual = DefaultVisual(display, DefaultScreen(display));
  int depth = DefaultDepth(display, DefaultScreen(display));
  XVisualInfo query = { .screen = DefaultScreen(display), .depth = 32,
                        .class = TrueColor };
  int count = 0;
  XVisualInfo *formats = XGetVisualInfo(display,
      VisualScreenMask | VisualDepthMask | VisualClassMask, &query, &count);
  for (int i = 0; i < count; ++i) {
    XRenderPictFormat *format = XRenderFindVisualFormat(display, formats[i].visual);
    if (format && format->type == PictTypeDirect && format->direct.alphaMask) {
      visual = formats[i].visual;
      depth = 32;
      alpha_mask = (unsigned long)format->direct.alphaMask << format->direct.alpha;
      break;
    }
  }
  XSetWindowAttributes attrs = {0};
  attrs.override_redirect = True;
  attrs.event_mask = StructureNotifyMask | SubstructureNotifyMask |
                     PropertyChangeMask | ExposureMask;
  attrs.colormap = XCreateColormap(display, root, visual, AllocNone);
  attrs.background_pixel = 0;
  attrs.border_pixel = 0;
  /* Map inside the root framebuffer so Xwayland keeps the icon drawables
   * alive. The host taskbar covers this transparent window; Yore presents
   * each icon from the forwarded pixels in its own tray. */
  manager = XCreateWindow(display, root, 0,
                          DisplayHeight(display, DefaultScreen(display)) - ICON_SIZE,
                          ICON_SIZE, ICON_SIZE, 0, depth,
                          InputOutput, visual, CWOverrideRedirect | CWEventMask |
                          CWColormap | CWBackPixel | CWBorderPixel, &attrs);
  if (formats) XFree(formats);
  char selection_name[40];
  snprintf(selection_name, sizeof selection_name, "_NET_SYSTEM_TRAY_S%d",
           DefaultScreen(display));
  Atom selection = XInternAtom(display, selection_name, False);
  opcode_atom = XInternAtom(display, "_NET_SYSTEM_TRAY_OPCODE", False);
  xembed_atom = XInternAtom(display, "_XEMBED", False);
  Atom manager_atom = XInternAtom(display, "MANAGER", False);
  Atom time_atom = XInternAtom(display, "_YORE_TRAY_SERVER_TIME", False);
  XChangeProperty(display, manager, time_atom, XA_INTEGER, 8, PropModeReplace,
                  (const unsigned char *)"", 0);
  XEvent time_event;
  do { XNextEvent(display, &time_event); }
  while (time_event.type != PropertyNotify ||
         time_event.xproperty.atom != time_atom);
  Time timestamp = time_event.xproperty.time;
  XSetSelectionOwner(display, selection, manager, timestamp);
  if (XGetSelectionOwner(display, selection) != manager) {
    fprintf(stderr, "x11-tray-bridge: another tray manager owns the selection\n");
    return 1;
  }
  XEvent announce = {0};
  announce.xclient.type = ClientMessage;
  announce.xclient.window = root;
  announce.xclient.message_type = manager_atom;
  announce.xclient.format = 32;
  announce.xclient.data.l[0] = timestamp;
  announce.xclient.data.l[1] = selection;
  announce.xclient.data.l[2] = manager;
  Atom visual_atom = XInternAtom(display, "_NET_SYSTEM_TRAY_VISUAL", False);
  VisualID visual_id = XVisualIDFromVisual(visual);
  XChangeProperty(display, manager, visual_atom, XA_VISUALID, 32,
                  PropModeReplace, (unsigned char *)&visual_id, 1);
  Atom orientation_atom = XInternAtom(display, "_NET_SYSTEM_TRAY_ORIENTATION", False);
  unsigned long horizontal = 0;
  XChangeProperty(display, manager, orientation_atom, XA_CARDINAL, 32,
                  PropModeReplace, (unsigned char *)&horizontal, 1);
  XSendEvent(display, root, False, StructureNotifyMask, &announce);
  XMapWindow(display, manager);
  XFlush(display);

  time_t last_connect = 0;
  for (;;) {
    while (XPending(display)) {
      XEvent event;
      XNextEvent(display, &event);
      if (event.type == ClientMessage && event.xclient.message_type == opcode_atom &&
          event.xclient.data.l[1] == SYSTEM_TRAY_REQUEST_DOCK)
        dock((Window)event.xclient.data.l[2]);
      else if (event.type == DestroyNotify)
        remove_icon(event.xdestroywindow.window);
      else if (event.type == PropertyNotify) {
        struct icon *icon = find_icon(event.xproperty.window);
        if (icon) icon->announced = 0;
      }
      else if (event.type == SelectionClear) {
        fprintf(stderr, "x11-tray-bridge: tray selection lost\n");
        return 1;
      }
    }
    time_t now = time(NULL);
    if (host_fd < 0 && now != last_connect) {
      last_connect = now;
      connect_host();
    }
    fd_set readers;
    FD_ZERO(&readers);
    int x_fd = ConnectionNumber(display);
    FD_SET(x_fd, &readers);
    int max_fd = x_fd;
    if (host_fd >= 0) { FD_SET(host_fd, &readers); if (host_fd > max_fd) max_fd = host_fd; }
    struct timeval timeout = { .tv_sec = 0, .tv_usec = 250000 };
    int ready = select(max_fd + 1, &readers, NULL, NULL, &timeout);
    if (ready < 0 && errno != EINTR) return 1;
    if (host_fd >= 0 && FD_ISSET(host_fd, &readers)) read_host();
    for (int i = 0; i < MAX_ICONS; ++i) publish_icon(&icons[i]);
  }
}
