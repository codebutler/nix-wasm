/*
 * wl-server-ffi.c — proves libwayland-server's wl_closure_invoke dispatches
 * through our raw wasm libffi backend (risk B de-risk).
 *
 * Client-side wl_closure_invoke→ffi_call is already exercised by wlhandshake
 * and wl-eyes. SERVER-side dispatch is new: when the server calls
 * wl_resource_set_implementation and a request arrives, libwayland-server
 * demarshals it into a wl_closure and calls wl_closure_invoke, which in turn
 * calls ffi_call with the handler's signature. That ffi_call is the thing under
 * test here.
 *
 * Design (single-process, NO fork — musl has no fork):
 *   1. Define a minimal "test_ffi" interface with one request: ping(value:int).
 *      The server ping handler sets g_ran = value.
 *   2. socketpair(AF_UNIX, SOCK_STREAM|SOCK_NONBLOCK) → sv[0]=server,sv[1]=client.
 *   3. wl_client_create(display, sv[0]) + wl_global_create for test_ffi.
 *   4. wl_display_connect_to_fd(sv[1]) → client connects in-process.
 *   5. Client sends get_registry + add_listener, then flushes.
 *   6. Single-threaded dispatch loop alternating server wl_event_loop_dispatch
 *      and client wl_display_prepare_read/read_events, until g_ran==42 or 50 iters.
 *
 * Print "RESULT wl-server-ffi PASS handler_ran=1" if g_ran==42, else FAIL.
 * Return 0 on PASS, 1 on FAIL.
 *
 * Single static wasm32-nommu binary; links -lwayland-server -lwayland-client -lffi.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <poll.h>
#include <wayland-server.h>
#include <wayland-client.h>

/* ---- generated protocol glue (wayland-scanner private-code + headers) ---- */
#include "test-ffi-server-protocol.h"
#include "test-ffi-client-protocol.h"

/* ---- server state ---- */
static int g_ran = -1; /* set by ping_handler to the value received */

static void ping_handler(struct wl_client *client,
			 struct wl_resource *resource,
			 int32_t value)
{
	(void)client;
	(void)resource;
	printf("wl-server-ffi: server ping_handler called value=%d\n", value);
	fflush(stdout);
	g_ran = value;
}

static const struct test_ffi_interface impl = {
	.ping = ping_handler,
};

static void bind_fn(struct wl_client *client, void *data,
		    uint32_t version, uint32_t id)
{
	(void)data;
	struct wl_resource *res = wl_resource_create(client, &test_ffi_interface,
						     (int)version, id);
	if (!res) {
		wl_client_post_no_memory(client);
		return;
	}
	wl_resource_set_implementation(res, &impl, NULL, NULL);
	printf("wl-server-ffi: test_ffi resource bound id=%u\n", id);
	fflush(stdout);
}

/* ---- client state ---- */
static struct test_ffi *g_proxy = NULL;

static void on_global(void *data, struct wl_registry *registry, uint32_t name,
		      const char *interface, uint32_t version)
{
	(void)data;
	(void)version;
	if (strcmp(interface, test_ffi_interface.name) == 0) {
		g_proxy = wl_registry_bind(registry, name, &test_ffi_interface, 1);
		printf("wl-server-ffi: client bound test_ffi name=%u proxy=%p\n",
		       name, (void *)g_proxy);
		fflush(stdout);
	}
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

/*
 * client_dispatch_nonblock — try to read pending server→client events without
 * blocking.  Uses the prepare_read / read_events / cancel_read trio (the
 * libwayland contract for concurrent/non-blocking dispatch).
 *
 * Returns the number of events dispatched, or -1 on error.
 */
static int client_dispatch_nonblock(struct wl_display *client_display)
{
	/* Attempt to enter the read phase; returns 0 on success, -1 if another
	 * thread is already reading (irrelevant here — we're single-threaded, but
	 * the API requires it). */
	if (wl_display_prepare_read(client_display) != 0) {
		/* Events already queued — dispatch them directly. */
		return wl_display_dispatch_pending(client_display);
	}

	/* Non-blocking poll: check if the server has sent us anything. */
	struct pollfd pfd = {
		.fd     = wl_display_get_fd(client_display),
		.events = POLLIN,
	};
	int n = poll(&pfd, 1, 0); /* timeout=0 → non-blocking */

	if (n > 0 && (pfd.revents & POLLIN)) {
		/* Data is available — read it into the queue. */
		wl_display_read_events(client_display);
	} else {
		/* Nothing to read. */
		wl_display_cancel_read(client_display);
	}

	return wl_display_dispatch_pending(client_display);
}

int main(void)
{
	printf("wl-server-ffi: start\n");
	fflush(stdout);

	/* ---- set up the server display ---- */
	struct wl_display *server_display = wl_display_create();
	if (!server_display) {
		printf("RESULT wl-server-ffi FAIL wl_display_create returned NULL\n");
		fflush(stdout);
		return 1;
	}

	struct wl_global *global = wl_global_create(server_display,
						    &test_ffi_interface, 1,
						    NULL, bind_fn);
	if (!global) {
		printf("RESULT wl-server-ffi FAIL wl_global_create returned NULL\n");
		fflush(stdout);
		wl_display_destroy(server_display);
		return 1;
	}

	/* ---- in-process socketpair (non-blocking so client reads don't stall) ---- */
	int sv[2];
	if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0, sv) < 0) {
		printf("RESULT wl-server-ffi FAIL socketpair failed\n");
		fflush(stdout);
		wl_display_destroy(server_display);
		return 1;
	}

	/* Create a server-side client from sv[0] */
	struct wl_client *server_client = wl_client_create(server_display, sv[0]);
	if (!server_client) {
		printf("RESULT wl-server-ffi FAIL wl_client_create returned NULL\n");
		fflush(stdout);
		wl_display_destroy(server_display);
		return 1;
	}

	/* ---- client connects to sv[1] ---- */
	struct wl_display *client_display = wl_display_connect_to_fd(sv[1]);
	if (!client_display) {
		printf("RESULT wl-server-ffi FAIL wl_display_connect_to_fd returned NULL\n");
		fflush(stdout);
		wl_display_destroy(server_display);
		return 1;
	}

	struct wl_registry *registry = wl_display_get_registry(client_display);
	if (!registry) {
		printf("RESULT wl-server-ffi FAIL wl_display_get_registry returned NULL\n");
		fflush(stdout);
		wl_display_disconnect(client_display);
		wl_display_destroy(server_display);
		return 1;
	}
	wl_registry_add_listener(registry, &registry_listener, NULL);

	/* Flush the initial get_registry request to the server */
	wl_display_flush(client_display);

	struct wl_event_loop *loop = wl_display_get_event_loop(server_display);

	/*
	 * Single-threaded dispatch loop.
	 *
	 * Each iteration:
	 *   1. Server reads+dispatches incoming bytes (wl_event_loop_dispatch with 0
	 *      timeout — non-blocking).
	 *   2. Server flushes queued replies to the client (wl_display_flush_clients).
	 *   3. Client reads+dispatches server replies non-blocking (our helper).
	 *   4. Once the client has received the globals and has g_proxy, send ping(42).
	 *
	 * The server's get_registry handling (global advertisement) happens inside
	 * step 1; the client sees it in step 3; ping is queued in step 4 and flushed
	 * immediately; the next step-1 processes the ping → calls ping_handler.
	 */
	int sent_ping = 0;
	for (int i = 0; i < 50 && g_ran != 42; i++) {
		/* Step 1: server reads+dispatches (non-blocking) */
		wl_event_loop_dispatch(loop, 0);

		/* Step 2: server flushes replies to client */
		wl_display_flush_clients(server_display);

		/* Step 3: client reads+dispatches (non-blocking) */
		client_dispatch_nonblock(client_display);

		/* Step 4: send ping(42) once we have the proxy */
		if (!sent_ping && g_proxy) {
			printf("wl-server-ffi: client sending ping(42)\n");
			fflush(stdout);
			test_ffi_ping(g_proxy, 42);
			wl_display_flush(client_display);
			sent_ping = 1;
		}
	}

	int pass = (g_ran == 42);

	if (pass) {
		printf("RESULT wl-server-ffi PASS handler_ran=1\n");
	} else {
		printf("RESULT wl-server-ffi FAIL g_ran=%d sent_ping=%d proxy=%p\n",
		       g_ran, sent_ping, (void *)g_proxy);
	}
	fflush(stdout);

	wl_registry_destroy(registry);
	wl_display_disconnect(client_display);
	wl_global_destroy(global);
	wl_display_destroy(server_display);

	return pass ? 0 : 1;
}
