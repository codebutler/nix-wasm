/* wl-input-probe.c — M0 input spike. Binds wl_seat → wl_pointer + wl_keyboard
   and logs every input event. Manual proof that browser pointer/keyboard reach a
   guest Wayland client through Greenfield. NOT baked for production — a diagnostic.
   Setup (display/registry/shm/xdg-toplevel + a blank buffer) mirrors wl-anim.c;
   only the seat/pointer/keyboard listeners below are new. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define WIDTH 240
#define HEIGHT 160

struct app {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	struct wl_shm *shm;
	struct xdg_wm_base *wm_base;
	struct wl_seat *seat;

	struct wl_surface *surface;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *xdg_toplevel;

	struct wl_buffer *buffer;
	bool configured;
	bool running;
};

/* --- the input listeners (the point of this probe) ---------------------- */
static void pt_enter(void *d, struct wl_pointer *p, uint32_t s,
                     struct wl_surface *sf, wl_fixed_t x, wl_fixed_t y) {
  printf("PROBE pointer.enter x=%d y=%d\n", wl_fixed_to_int(x), wl_fixed_to_int(y));
  fflush(stdout);
}
static void pt_leave(void *d, struct wl_pointer *p, uint32_t s, struct wl_surface *sf) {}
static void pt_motion(void *d, struct wl_pointer *p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {
  printf("PROBE pointer.motion x=%d y=%d\n", wl_fixed_to_int(x), wl_fixed_to_int(y));
  fflush(stdout);
}
static void pt_button(void *d, struct wl_pointer *p, uint32_t s, uint32_t t,
                      uint32_t button, uint32_t state) {
  printf("PROBE pointer.button button=%u state=%u\n", button, state);
  fflush(stdout);
}
static void pt_axis(void *d, struct wl_pointer *p, uint32_t t, uint32_t a, wl_fixed_t v) {}
static const struct wl_pointer_listener pt_listener = {
  .enter  = pt_enter,
  .leave  = pt_leave,
  .motion = pt_motion,
  .button = pt_button,
  .axis   = pt_axis,
};

static void kb_keymap(void *d, struct wl_keyboard *k, uint32_t fmt, int32_t fd, uint32_t sz) {}
static void kb_enter(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf,
                     struct wl_array *keys) { printf("PROBE kb.enter\n"); fflush(stdout); }
static void kb_leave(void *d, struct wl_keyboard *k, uint32_t s, struct wl_surface *sf) {}
static void kb_key(void *d, struct wl_keyboard *k, uint32_t s, uint32_t t,
                   uint32_t key, uint32_t state) {
  printf("PROBE kb.key key=%u state=%u\n", key, state);
  fflush(stdout);
}
static void kb_mods(void *d, struct wl_keyboard *k, uint32_t s, uint32_t dep,
                    uint32_t lat, uint32_t lock, uint32_t grp) {}
static void kb_repeat(void *d, struct wl_keyboard *k, int32_t rate, int32_t delay) {}
static const struct wl_keyboard_listener kb_listener = {
  .keymap      = kb_keymap,
  .enter       = kb_enter,
  .leave       = kb_leave,
  .key         = kb_key,
  .modifiers   = kb_mods,
  .repeat_info = kb_repeat,
};

static void seat_caps(void *data, struct wl_seat *seat, uint32_t caps) {
  if (caps & WL_SEAT_CAPABILITY_POINTER)
    wl_pointer_add_listener(wl_seat_get_pointer(seat), &pt_listener, NULL);
  if (caps & WL_SEAT_CAPABILITY_KEYBOARD)
    wl_keyboard_add_listener(wl_seat_get_keyboard(seat), &kb_listener, NULL);
  printf("PROBE seat.caps=0x%x\n", caps); fflush(stdout);
}
static void seat_name(void *d, struct wl_seat *s, const char *n) {}
static const struct wl_seat_listener seat_listener = {
  .capabilities = seat_caps,
  .name         = seat_name,
};

/* ---- buffer helpers (identical to wl-anim.c) ---- */
static int create_shm_file(off_t size)
{
	char name[] = "/tmp/wl-input-probe-XXXXXX";
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

static struct wl_buffer *alloc_blank_buffer(struct app *app)
{
	int stride = WIDTH * 4;
	int size = stride * HEIGHT;
	int fd = create_shm_file(size);
	if (fd < 0)
		return NULL;
	void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (data == MAP_FAILED) {
		close(fd);
		return NULL;
	}
	memset(data, 0x20, size); /* dark grey blank surface */
	munmap(data, size);
	struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, size);
	struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, WIDTH, HEIGHT,
	                                                   stride, WL_SHM_FORMAT_XRGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	return buf;
}

/* ---- xdg-shell (same as wl-anim.c) ---- */
static void wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
	xdg_wm_base_pong(wm_base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = { .ping = wm_base_ping };

static void xdg_surface_configure(void *data, struct xdg_surface *xs, uint32_t serial)
{
	struct app *app = data;
	xdg_surface_ack_configure(xs, serial);
	if (!app->configured) {
		app->configured = true;
		/* attach the blank buffer once on first configure */
		wl_surface_attach(app->surface, app->buffer, 0, 0);
		wl_surface_damage(app->surface, 0, 0, WIDTH, HEIGHT);
		wl_surface_commit(app->surface);
	}
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

/* ---- registry: bind wl_compositor, wl_shm, xdg_wm_base, wl_seat ---- */
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
	} else if (strcmp(iface, "wl_seat") == 0) {
		app->seat = wl_registry_bind(r, name, &wl_seat_interface, 1);
		wl_seat_add_listener(app->seat, &seat_listener, app);
	}
}
static void registry_global_remove(void *data, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

int main(void)
{
	struct app app = { 0 };
	app.running = true;

	app.display = wl_display_connect(NULL);
	if (!app.display) {
		fprintf(stderr, "wl-input-probe: cannot connect to display\n");
		return 1;
	}
	app.registry = wl_display_get_registry(app.display);
	wl_registry_add_listener(app.registry, &registry_listener, &app);
	wl_display_roundtrip(app.display);

	if (!app.compositor || !app.shm || !app.wm_base) {
		fprintf(stderr, "wl-input-probe: missing globals\n");
		return 1;
	}
	if (!app.seat) {
		fprintf(stderr, "wl-input-probe: no wl_seat advertised\n");
		return 1;
	}

	app.buffer = alloc_blank_buffer(&app);
	if (!app.buffer) {
		fprintf(stderr, "wl-input-probe: buffer alloc failed\n");
		return 1;
	}

	app.surface = wl_compositor_create_surface(app.compositor);
	app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
	xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
	app.xdg_toplevel = xdg_surface_get_toplevel(app.xdg_surface);
	xdg_toplevel_add_listener(app.xdg_toplevel, &toplevel_listener, &app);
	xdg_toplevel_set_title(app.xdg_toplevel, "wl-input-probe");
	xdg_toplevel_set_app_id(app.xdg_toplevel, "be.udev.wl-input-probe");
	wl_surface_commit(app.surface);

	printf("wl-input-probe: running — move/click/type in the window\n");
	fflush(stdout);
	while (app.running && wl_display_dispatch(app.display) != -1) {
	}

	if (app.buffer)
		wl_buffer_destroy(app.buffer);
	if (app.xdg_toplevel)
		xdg_toplevel_destroy(app.xdg_toplevel);
	if (app.xdg_surface)
		xdg_surface_destroy(app.xdg_surface);
	if (app.surface)
		wl_surface_destroy(app.surface);
	wl_display_disconnect(app.display);
	return 0;
}
