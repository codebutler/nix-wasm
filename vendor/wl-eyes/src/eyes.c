/*
 * eyes.c — a native Wayland "eyes" app.
 *
 * Pure wl_shm + xdg-shell + wl_pointer. It hand-rasterizes two eyes into a
 * shared-memory buffer (2x2 supersampled for anti-aliasing) whose pupils follow
 * the pointer. Per the Wayland security model a client only gets pointer events
 * while the cursor is over its own surface, so the eyes track the cursor when it
 * is over the window and freeze at the last position when it leaves.
 */
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define WIDTH 360
#define HEIGHT 220
#define BTN_LEFT 0x110
#define NBUF 2

/* colors (0xRRGGBB) */
#define COL_BG 0x252a34
#define COL_WHITE 0xf4f4f0
#define COL_DARK 0x12151b

struct buffer {
	struct wl_buffer *wl_buffer;
	uint32_t *data;
	int size;
	bool busy;
};

struct app {
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	struct wl_shm *shm;
	struct xdg_wm_base *wm_base;
	struct wl_seat *seat;
	struct wl_pointer *pointer;

	struct wl_surface *surface;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *xdg_toplevel;

	struct buffer buffers[NBUF];
	double mouse_x, mouse_y;
	bool have_mouse;
	bool configured;
	bool running;
};

static int create_shm_file(off_t size)
{
	char name[] = "/tmp/wl-eyes-XXXXXX";
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

static void buffer_release(void *data, struct wl_buffer *wl_buffer)
{
	struct buffer *b = data;
	b->busy = false;
}
static const struct wl_buffer_listener buffer_listener = { .release = buffer_release };

static bool alloc_buffer(struct app *app, struct buffer *b)
{
	int stride = WIDTH * 4;
	int size = stride * HEIGHT;
	int fd = create_shm_file(size);
	if (fd < 0)
		return false;
	b->data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (b->data == MAP_FAILED) {
		close(fd);
		return false;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(app->shm, fd, size);
	b->wl_buffer = wl_shm_pool_create_buffer(pool, 0, WIDTH, HEIGHT, stride, WL_SHM_FORMAT_XRGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	wl_buffer_add_listener(b->wl_buffer, &buffer_listener, b);
	b->size = size;
	b->busy = false;
	return true;
}

static void free_buffer(struct buffer *b)
{
	if (b->wl_buffer)
		wl_buffer_destroy(b->wl_buffer);
	if (b->data && b->data != MAP_FAILED)
		munmap(b->data, b->size);
}

struct eye {
	double cx, cy, rx, ry;
};

/* classify one sub-sample point to a packed RGB color */
static uint32_t sample(double x, double y, const struct eye eyes[2], const double pup[2][2], double pr, double bw)
{
	for (int i = 0; i < 2; i++) {
		const struct eye *e = &eyes[i];
		/* pupil (filled disc) */
		double dpx = x - pup[i][0], dpy = y - pup[i][1];
		if (dpx * dpx + dpy * dpy <= pr * pr)
			return COL_DARK;
		/* inner white ellipse */
		double ix = (x - e->cx) / (e->rx - bw), iy = (y - e->cy) / (e->ry - bw);
		if (ix * ix + iy * iy <= 1.0)
			return COL_WHITE;
		/* outer ellipse -> border ring */
		double ox = (x - e->cx) / e->rx, oy = (y - e->cy) / e->ry;
		if (ox * ox + oy * oy <= 1.0)
			return COL_DARK;
	}
	return COL_BG;
}

static void paint(struct app *app, uint32_t *pixels)
{
	const double bw = 3.0;
	struct eye eyes[2] = {
		{ WIDTH * 0.28, HEIGHT * 0.5, WIDTH * 0.21, HEIGHT * 0.40 },
		{ WIDTH * 0.72, HEIGHT * 0.5, WIDTH * 0.21, HEIGHT * 0.40 },
	};
	double pr = (eyes[0].ry - bw) * 0.34; /* pupil radius */

	/* pupil centers: clamp the look direction to an inner ellipse */
	double pup[2][2];
	for (int i = 0; i < 2; i++) {
		struct eye *e = &eyes[i];
		double ax = (e->rx - bw) - pr - 1.0;
		double ay = (e->ry - bw) - pr - 1.0;
		if (app->have_mouse) {
			double nx = (app->mouse_x - e->cx) / ax;
			double ny = (app->mouse_y - e->cy) / ay;
			double d = sqrt(nx * nx + ny * ny);
			if (d > 1.0) { nx /= d; ny /= d; }
			pup[i][0] = e->cx + nx * ax;
			pup[i][1] = e->cy + ny * ay;
		} else {
			pup[i][0] = e->cx;
			pup[i][1] = e->cy;
		}
	}

	for (int y = 0; y < HEIGHT; y++) {
		for (int x = 0; x < WIDTH; x++) {
			/* 2x2 supersample for anti-aliasing */
			unsigned r = 0, g = 0, b = 0;
			for (int sy = 0; sy < 2; sy++) {
				for (int sx = 0; sx < 2; sx++) {
					double px = x + 0.25 + sx * 0.5;
					double py = y + 0.25 + sy * 0.5;
					uint32_t c = sample(px, py, eyes, pup, pr, bw);
					r += (c >> 16) & 0xff;
					g += (c >> 8) & 0xff;
					b += c & 0xff;
				}
			}
			pixels[y * WIDTH + x] = 0xff000000u | ((r >> 2) << 16) | ((g >> 2) << 8) | (b >> 2);
		}
	}
}

static struct buffer *next_buffer(struct app *app)
{
	for (int i = 0; i < NBUF; i++)
		if (!app->buffers[i].busy)
			return &app->buffers[i];
	return NULL;
}

static void redraw(struct app *app)
{
	if (!app->configured)
		return;
	struct buffer *b = next_buffer(app);
	if (!b)
		return; /* both buffers in flight; drop this frame */
	paint(app, b->data);
	wl_surface_attach(app->surface, b->wl_buffer, 0, 0);
	wl_surface_damage(app->surface, 0, 0, WIDTH, HEIGHT);
	wl_surface_commit(app->surface);
	b->busy = true;
}

/* ---- xdg-shell ---- */
static void wm_base_ping(void *data, struct xdg_wm_base *wm_base, uint32_t serial)
{
	xdg_wm_base_pong(wm_base, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = { .ping = wm_base_ping };

static void xdg_surface_configure(void *data, struct xdg_surface *xdg_surface, uint32_t serial)
{
	struct app *app = data;
	xdg_surface_ack_configure(xdg_surface, serial);
	app->configured = true;
	redraw(app);
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

/* ---- pointer ---- */
static void pointer_enter(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s,
		wl_fixed_t sx, wl_fixed_t sy)
{
	struct app *app = data;
	app->mouse_x = wl_fixed_to_double(sx);
	app->mouse_y = wl_fixed_to_double(sy);
	app->have_mouse = true;
	redraw(app);
}
static void pointer_leave(void *data, struct wl_pointer *p, uint32_t serial, struct wl_surface *s) {}
static void pointer_motion(void *data, struct wl_pointer *p, uint32_t time, wl_fixed_t sx, wl_fixed_t sy)
{
	struct app *app = data;
	app->mouse_x = wl_fixed_to_double(sx);
	app->mouse_y = wl_fixed_to_double(sy);
	app->have_mouse = true;
	redraw(app);
}
static void pointer_button(void *data, struct wl_pointer *p, uint32_t serial, uint32_t time,
		uint32_t button, uint32_t state)
{
	struct app *app = data;
	/* left-press anywhere on the body starts an interactive window move */
	if (button == BTN_LEFT && state == WL_POINTER_BUTTON_STATE_PRESSED && app->xdg_toplevel)
		xdg_toplevel_move(app->xdg_toplevel, app->seat, serial);
}
static void pointer_axis(void *data, struct wl_pointer *p, uint32_t time, uint32_t axis, wl_fixed_t value) {}
static const struct wl_pointer_listener pointer_listener = {
	.enter = pointer_enter,
	.leave = pointer_leave,
	.motion = pointer_motion,
	.button = pointer_button,
	.axis = pointer_axis,
};

static void seat_capabilities(void *data, struct wl_seat *seat, uint32_t caps)
{
	struct app *app = data;
	if ((caps & WL_SEAT_CAPABILITY_POINTER) && app->pointer == NULL) {
		app->pointer = wl_seat_get_pointer(seat);
		wl_pointer_add_listener(app->pointer, &pointer_listener, app);
	}
}
static void seat_name(void *data, struct wl_seat *seat, const char *name) {}
static const struct wl_seat_listener seat_listener = { .capabilities = seat_capabilities, .name = seat_name };

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
	} else if (strcmp(iface, wl_seat_interface.name) == 0) {
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
		fprintf(stderr, "wl-eyes: cannot connect to display\n");
		return 1;
	}
	app.registry = wl_display_get_registry(app.display);
	wl_registry_add_listener(app.registry, &registry_listener, &app);
	wl_display_roundtrip(app.display);

	if (!app.compositor || !app.shm || !app.wm_base) {
		fprintf(stderr, "wl-eyes: missing globals\n");
		return 1;
	}

	for (int i = 0; i < NBUF; i++) {
		if (!alloc_buffer(&app, &app.buffers[i])) {
			fprintf(stderr, "wl-eyes: buffer alloc failed\n");
			return 1;
		}
	}

	app.surface = wl_compositor_create_surface(app.compositor);
	app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
	xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
	app.xdg_toplevel = xdg_surface_get_toplevel(app.xdg_surface);
	xdg_toplevel_add_listener(app.xdg_toplevel, &toplevel_listener, &app);
	xdg_toplevel_set_title(app.xdg_toplevel, "eyes");
	xdg_toplevel_set_app_id(app.xdg_toplevel, "be.udev.eyes");
	wl_surface_commit(app.surface);

	printf("wl-eyes: running\n");
	while (app.running && wl_display_dispatch(app.display) != -1) {
	}

	for (int i = 0; i < NBUF; i++)
		free_buffer(&app.buffers[i]);
	if (app.xdg_toplevel)
		xdg_toplevel_destroy(app.xdg_toplevel);
	if (app.xdg_surface)
		xdg_surface_destroy(app.xdg_surface);
	if (app.surface)
		wl_surface_destroy(app.surface);
	wl_display_disconnect(app.display);
	return 0;
}
