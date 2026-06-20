/*
 * wl-anim.c — a minimal SELF-ANIMATING Wayland client (pure wl_shm + xdg-shell),
 * cross-built to wasm32-nommu. Phase 4f animation VERIFICATION.
 *
 * Why this exists: weston-flowers (the prior "animation" probe) is a STATIC
 * client — clients/flower.c draws one random flower and idles; it has no
 * frame-callback loop, so it can never prove a self-sustaining animation cycle.
 * wl-anim closes that gap. It runs the canonical animation pattern:
 *
 *     configure -> redraw -> [attach + request wl_surface.frame(cb) + commit]
 *     compositor renders -> wl_callback.done(time) -> redraw -> ... (forever)
 *
 * The ONLY thing that advances a frame is the compositor's frame-callback `done`
 * event arriving at the (otherwise idle, CPU-parked) guest. So if the box keeps
 * moving with NO shell activity, the host-side self-wake (raised_irqs IRQ +
 * async IN-vring delivery) is driving a real steady-state render loop end to end
 * — exactly what GTK and every animating toolkit need. It prints "wl-anim: frame
 * N" each frame so a driver can count frames during a no-pump idle window.
 *
 * Double-buffered (NBUF=2) with wl_buffer.release tracking, same as wl-eyes: a
 * frame is skipped only if both buffers are still in flight, which also exercises
 * the release path under continuous load.
 */
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
#define NBUF 2

#define COL_BG 0xff202830u
#define COL_BOX 0xfff0a020u

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

	struct wl_surface *surface;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *xdg_toplevel;

	struct buffer buffers[NBUF];
	bool configured;
	bool running;
	uint32_t frame; /* monotonically increasing frame counter */
};

static int create_shm_file(off_t size)
{
	char name[] = "/tmp/wl-anim-XXXXXX";
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
	((struct buffer *)data)->busy = false;
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

static struct buffer *next_buffer(struct app *app)
{
	for (int i = 0; i < NBUF; i++)
		if (!app->buffers[i].busy)
			return &app->buffers[i];
	return NULL;
}

/* A box that slides left<->right; its X is a triangle wave of the frame count. */
static void paint(struct app *app, uint32_t *px)
{
	const int bw = 48, bh = 48;
	int span = WIDTH - bw;
	int phase = app->frame % (2 * span);
	int bx = phase < span ? phase : (2 * span - phase);
	int by = (HEIGHT - bh) / 2;

	for (int y = 0; y < HEIGHT; y++)
		for (int x = 0; x < WIDTH; x++) {
			bool in = (x >= bx && x < bx + bw && y >= by && y < by + bh);
			px[y * WIDTH + x] = in ? COL_BOX : COL_BG;
		}
}

static void redraw(struct app *app);

/* The frame callback: the compositor fires this once it has presented the last
 * commit. We destroy the spent callback and draw the next frame — this is the
 * heartbeat of the animation. */
static void frame_done(void *data, struct wl_callback *cb, uint32_t time)
{
	wl_callback_destroy(cb);
	redraw((struct app *)data);
}
static const struct wl_callback_listener frame_listener = { .done = frame_done };

static void redraw(struct app *app)
{
	if (!app->configured || !app->running)
		return;
	struct buffer *b = next_buffer(app);
	if (!b) {
		/* Both buffers in flight — request a callback so we retry next frame
		 * instead of stalling the loop. */
		struct wl_callback *cb = wl_surface_frame(app->surface);
		wl_callback_add_listener(cb, &frame_listener, app);
		wl_surface_commit(app->surface);
		return;
	}

	paint(app, b->data);

	/* Request the next frame callback BEFORE committing (so the compositor
	 * arms it against this very commit), then attach + damage + commit. */
	struct wl_callback *cb = wl_surface_frame(app->surface);
	wl_callback_add_listener(cb, &frame_listener, app);

	wl_surface_attach(app->surface, b->wl_buffer, 0, 0);
	wl_surface_damage(app->surface, 0, 0, WIDTH, HEIGHT);
	wl_surface_commit(app->surface);
	b->busy = true;

	if ((app->frame % 10) == 0) {
		printf("wl-anim: frame %u\n", app->frame);
		fflush(stdout);
	}
	app->frame += 4; /* advance the box a few px per frame */
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
	bool first = !app->configured;
	app->configured = true;
	if (first)
		redraw(app); /* kick off the self-sustaining loop */
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

int main(void)
{
	struct app app = { 0 };
	app.running = true;

	app.display = wl_display_connect(NULL);
	if (!app.display) {
		fprintf(stderr, "wl-anim: cannot connect to display\n");
		return 1;
	}
	app.registry = wl_display_get_registry(app.display);
	wl_registry_add_listener(app.registry, &registry_listener, &app);
	wl_display_roundtrip(app.display);

	if (!app.compositor || !app.shm || !app.wm_base) {
		fprintf(stderr, "wl-anim: missing globals\n");
		return 1;
	}

	for (int i = 0; i < NBUF; i++) {
		if (!alloc_buffer(&app, &app.buffers[i])) {
			fprintf(stderr, "wl-anim: buffer alloc failed\n");
			return 1;
		}
	}

	app.surface = wl_compositor_create_surface(app.compositor);
	app.xdg_surface = xdg_wm_base_get_xdg_surface(app.wm_base, app.surface);
	xdg_surface_add_listener(app.xdg_surface, &xdg_surface_listener, &app);
	app.xdg_toplevel = xdg_surface_get_toplevel(app.xdg_surface);
	xdg_toplevel_add_listener(app.xdg_toplevel, &toplevel_listener, &app);
	xdg_toplevel_set_title(app.xdg_toplevel, "anim");
	xdg_toplevel_set_app_id(app.xdg_toplevel, "be.udev.anim");
	wl_surface_commit(app.surface);

	printf("wl-anim: running\n");
	fflush(stdout);
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
