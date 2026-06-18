/*
 * wlclient.c — a minimal AF_UNIX test client for waylandproxyd (Wayland Phase 1
 * 1c M3). NOT a real Wayland client (that's 1d's stock-libwayland test); it just
 * connects to $XDG_RUNTIME_DIR/wayland-0 and writes the first bytes a real
 * libwayland client would send — the wl_display.get_registry request — to prove
 * waylandproxyd accepts the connection and forwards the initial bytes to the host
 * (the JS wl device logs the resulting VIRTWL_IOCTL_SEND).
 *
 * Wayland wire format of the request we send (little-endian, 12 bytes):
 *   u32 object_id = 1            (wl_display, the well-known first object)
 *   u16 opcode    = 1            (wl_display.get_registry)
 *   u16 size      = 12           (total message size incl. this 8-byte header)
 *   u32 new_id    = 2            (the registry object the client allocates)
 *
 * Single static binary, no fork (NOMMU). Prints a RESULT marker the runner greps.
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(void)
{
	const char *dir = getenv("XDG_RUNTIME_DIR");
	if (!dir || !*dir)
		dir = "/tmp";
	char path[128];
	snprintf(path, sizeof(path), "%s/wayland-0", dir);

	int s = socket(AF_UNIX, SOCK_STREAM, 0);
	if (s < 0) {
		printf("RESULT wlclient FAIL socket() errno=%d\n", errno);
		return 1;
	}

	struct sockaddr_un addr;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
	if (connect(s, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		printf("RESULT wlclient FAIL connect(%s) errno=%d\n", path, errno);
		return 1;
	}
	printf("wlclient: connected to %s\n", path);

	/* wl_display.get_registry(new_id=2) — 12-byte wire message. */
	uint8_t msg[12];
	uint32_t *w = (uint32_t *)msg;
	w[0] = 1; /* object_id = wl_display */
	w[1] = (12u << 16) | 1u; /* size<<16 | opcode (get_registry) */
	w[2] = 2; /* new_id for the registry */

	ssize_t n = write(s, msg, sizeof(msg));
	if (n != (ssize_t)sizeof(msg)) {
		printf("RESULT wlclient FAIL write n=%zd errno=%d\n", n, errno);
		return 1;
	}

	printf("RESULT wlclient PASS sent get_registry (%zd bytes) to wayland-0\n", n);
	/* Give the proxy a moment to splice before we close. */
	usleep(200000);
	close(s);
	return 0;
}
