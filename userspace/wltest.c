/*
 * wltest.c — userspace round-trip self-test for /dev/wl0 (virtio_wl)
 * (Linux/Wasm, "pc" Wayland Phase 1 sub-step 1b — M3).
 *
 * Opens /dev/wl0 and issues a single VIRTWL_IOCTL_NEW (VIRTWL_IOCTL_NEW_CTX):
 * the request travels guest virtio_wl driver -> virtio_wasm transport -> the JS
 * wl device model -> back. On success the driver returns a context vfd in
 * ioctl_new.fd. We print a RESULT marker the Node runner greps.
 *
 * No fork/exec, no setjmp — a clean static binary the kernel exec ABI can run.
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <stdint.h>
#include <errno.h>

/* Mirror of uapi/linux/virtwl.h (kept local so the test needs no extra UAPI). */
#define VIRTWL_IOCTL_BASE 'w'
#define _VIRTWL_IOWR(nr, type) _IOWR(VIRTWL_IOCTL_BASE, nr, type)

enum virtwl_ioctl_new_type {
	VIRTWL_IOCTL_NEW_CTX = 0,
	VIRTWL_IOCTL_NEW_ALLOC,
	VIRTWL_IOCTL_NEW_PIPE_READ,
	VIRTWL_IOCTL_NEW_PIPE_WRITE,
	VIRTWL_IOCTL_NEW_DMABUF,
	VIRTWL_IOCTL_NEW_CTX_NAMED,
};

struct virtwl_ioctl_new {
	uint32_t type;
	int fd;
	uint32_t flags;
	union {
		uint32_t size;
		struct {
			uint32_t width, height, format;
			uint32_t stride0, stride1, stride2;
			uint32_t offset0, offset1, offset2;
		} dmabuf;
		char name[32];
	};
};

#define VIRTWL_IOCTL_NEW _VIRTWL_IOWR(0x00, struct virtwl_ioctl_new)

int main(void)
{
	int fd, ret;
	struct virtwl_ioctl_new ioctl_new;

	fd = open("/dev/wl0", O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		printf("RESULT virtio_wl FAIL open(/dev/wl0) failed errno=%d\n",
		       errno);
		return 1;
	}
	printf("wltest: opened /dev/wl0 fd=%d\n", fd);

	memset(&ioctl_new, 0, sizeof(ioctl_new));
	ioctl_new.type = VIRTWL_IOCTL_NEW_CTX;
	ioctl_new.fd = -1;

	ret = ioctl(fd, VIRTWL_IOCTL_NEW, &ioctl_new);
	if (ret) {
		printf("RESULT virtio_wl FAIL ioctl(NEW_CTX) ret=%d errno=%d\n",
		       ret, errno);
		close(fd);
		return 1;
	}

	if (ioctl_new.fd < 0) {
		printf("RESULT virtio_wl FAIL ioctl returned no ctx fd (%d)\n",
		       ioctl_new.fd);
		close(fd);
		return 1;
	}

	printf("RESULT virtio_wl PASS NEW_CTX ctx_fd=%d (round-trip /dev/wl0 -> JS wl device)\n",
	       ioctl_new.fd);
	close(ioctl_new.fd);
	close(fd);
	return 0;
}
