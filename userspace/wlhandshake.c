/*
 * wlhandshake.c — a STOCK libwayland client that completes a real Wayland
 * registry handshake through the full Phase 1 transport stack (Linux/Wasm, "pc"
 * Wayland Phase 1 sub-step 1d, M2 — the Phase 1 deliverable).
 *
 * This is NOT a hand-rolled wire poke (that was 1c's wlclient.c). It links the
 * real cross-built libwayland-client and uses the canonical client API:
 *
 *   wl_display_connect(NULL)        -> connects to $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY
 *                                      (wayland-0), i.e. THROUGH waylandproxyd.
 *   wl_display_get_registry(d)      -> sends wl_display.get_registry over the wire.
 *   wl_registry_add_listener(...)   -> registers a global handler.
 *   wl_display_roundtrip(d)         -> blocks until the server's sync callback
 *                                      returns, draining all queued global events.
 *   (handler counts each wl_registry.global event)
 *   assert globals >= 1, then wl_display_disconnect(d).
 *
 * The path exercised end to end:
 *   wlhandshake (libwayland) --AF_UNIX wayland-0--> waylandproxyd
 *     --VIRTWL_IOCTL_SEND on /dev/wl0 ctx--> virtio_wl --OUT vq--> JS wl device
 *     --wl-server.js parses get_registry, emits wl_registry.global x N + (on the
 *       client's implicit sync) wl_callback.done + wl_display.delete_id--
 *     --IN vq VFD_RECV--> virtio_wl routes to ctx in_queue --VIRTWL_IOCTL_RECV-->
 *     waylandproxyd --AF_UNIX--> wlhandshake demarshals the events.
 *
 * Emits "RESULT wl-handshake PASS <n>" (n = globals seen) | "RESULT wl-handshake
 * FAIL <why>" the Node runner greps. Single static wasm32-nommu binary; no fork.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>

static int g_globals = 0;

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
		      const char *interface, uint32_t version)
{
	(void)data;
	(void)registry;
	g_globals++;
	printf("wlhandshake: global #%d name=%u interface=%s version=%u\n",
	       g_globals, name, interface ? interface : "(null)", version);
	fflush(stdout);
}

static void on_global_remove(void *data, struct wl_registry *registry,
			     uint32_t name)
{
	(void)data;
	(void)registry;
	(void)name;
}

static const struct wl_registry_listener registry_listener = {
	.global = on_global,
	.global_remove = on_global_remove,
};

int main(void)
{
	struct wl_display *display = wl_display_connect(NULL);
	if (!display) {
		printf("RESULT wl-handshake FAIL wl_display_connect returned NULL\n");
		fflush(stdout);
		return 1;
	}
	printf("wlhandshake: connected (wl_display_connect ok)\n");
	fflush(stdout);

	struct wl_registry *registry = wl_display_get_registry(display);
	if (!registry) {
		printf("RESULT wl-handshake FAIL wl_display_get_registry returned NULL\n");
		fflush(stdout);
		wl_display_disconnect(display);
		return 1;
	}
	wl_registry_add_listener(registry, &registry_listener, NULL);

	/* Blocks until the server answers the implicit sync — this is the real
	 * end-to-end roundtrip through the whole transport stack. */
	int rt = wl_display_roundtrip(display);
	if (rt < 0) {
		printf("RESULT wl-handshake FAIL wl_display_roundtrip rc=%d\n", rt);
		fflush(stdout);
		wl_display_disconnect(display);
		return 1;
	}
	printf("wlhandshake: roundtrip complete (rc=%d)\n", rt);
	fflush(stdout);

	if (g_globals < 1) {
		printf("RESULT wl-handshake FAIL saw 0 globals after roundtrip\n");
		fflush(stdout);
		wl_display_disconnect(display);
		return 1;
	}

	printf("RESULT wl-handshake PASS %d (stock libwayland registry handshake e2e)\n",
	       g_globals);
	fflush(stdout);

	wl_display_disconnect(display);
	return 0;
}
