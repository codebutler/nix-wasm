/*
 * wl-shm-test.c — issue #11 items-2/3/5 wl_shm-on-MMU exercise.
 *
 * A plain userspace program (run as an ordinary child from a shell, NOT PID
 * 1 — a fatal signal here must kill only this process, never the guest,
 * since one of the things under test is whether writing into the mmap'd
 * region is even safe on this kernel). It opens /dev/wl0, creates a
 * VIRTWL_IOCTL_NEW_CTX connection, then TWO VIRTWL_IOCTL_NEW_ALLOC shm
 * allocations (each backed by fresh guest-RAM + its own anon inode per patch
 * 0013's NEW_ALLOC/anon_inode_create_getfd path — issue #11 item 2). fstat()
 * on the two returned fds proves the per-vfd-unique-inode fix (a shared
 * global inode would collide both st_ino values).
 *
 * Both shm vfds are attached to the ctx via ONE VIRTWL_IOCTL_SEND — the wire
 * shape a real wl_shm_create_pool takes (message bytes + an out-of-band fd
 * list) — BEFORE any mmap/write is attempted, so the host device model's
 * per-SEND `_resolveShmFd` pfn->host-offset resolution (issue #11 item 3;
 * runtime/virtio/wl-device.js) is exercised and observable even if the
 * mmap/write step below turns out to be unsafe on this kernel.
 *
 * Only THEN does it mmap each vfd, do a single-byte READ probe (to tell a
 * read-fault from a write-fault if this crashes), and write a distinct
 * deterministic byte pattern into it — the only userspace-visible way to
 * place known bytes into the vfd's kernel backing (there is no write() path
 * onto shm_buf, only mmap). Every step prints a WLSHM: progress line and
 * flushes stdout immediately, so a fatal signal past mmap() leaves the
 * preceding progress fully visible to whatever waited on this process's
 * stdout/exit status. (Empirically: the read probe itself is already fatal
 * on current code — see the smoke's own header for what that means.)
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

/* Mirror of uapi/linux/virtwl.h (kept local, like wltest.c, so this test
 * needs no extra UAPI headers). */
#define VIRTWL_IOCTL_BASE 'w'
#define _VIRTWL_IOWR(nr, type) _IOWR(VIRTWL_IOCTL_BASE, nr, type)
#define _VIRTWL_IOR(nr, type) _IOR(VIRTWL_IOCTL_BASE, nr, type)

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

#define VIRTWL_SEND_MAX_ALLOCS 28

struct virtwl_ioctl_txn {
	int fds[VIRTWL_SEND_MAX_ALLOCS];
	uint32_t len;
	uint8_t data[0];
};

#define VIRTWL_IOCTL_NEW _VIRTWL_IOWR(0x00, struct virtwl_ioctl_new)
#define VIRTWL_IOCTL_SEND _VIRTWL_IOR(0x01, struct virtwl_ioctl_txn)

#define SHM_SIZE 4096
#define SEND_PAYLOAD "SHMPING!"
#define SEND_PAYLOAD_LEN 8

/* Deterministic per-buffer pattern; the Node smoke computes the SAME formula
 * to check the host-observed bytes bit-exact. Two different formulas (by
 * `which`) so the two allocations are also distinguishable from each other,
 * not just from all-zero. */
static unsigned char pattern_byte(int which, unsigned i)
{
	return (unsigned char)(which == 0 ? (i * 3 + 7) : (i * 5 + 11));
}

int main(void)
{
	printf("WLSHM: test alive\n");
	fflush(stdout);

	int wl = open("/dev/wl0", O_RDWR | O_CLOEXEC);
	if (wl < 0) {
		printf("RESULT wl_shm FAIL open(/dev/wl0) errno=%d\n", errno);
		return 1;
	}
	printf("WLSHM: open ok\n");
	fflush(stdout);

	struct virtwl_ioctl_new n;
	memset(&n, 0, sizeof(n));
	n.type = VIRTWL_IOCTL_NEW_CTX;
	n.fd = -1;
	if (ioctl(wl, VIRTWL_IOCTL_NEW, &n) || n.fd < 0) {
		printf("RESULT wl_shm FAIL NEW_CTX errno=%d\n", errno);
		return 1;
	}
	int ctx_fd = n.fd;
	printf("WLSHM: ctx ok\n");
	fflush(stdout);

	int shm_fd[2] = { -1, -1 };
	for (int i = 0; i < 2; i++) {
		memset(&n, 0, sizeof(n));
		n.type = VIRTWL_IOCTL_NEW_ALLOC;
		n.fd = -1;
		n.size = SHM_SIZE;
		if (ioctl(wl, VIRTWL_IOCTL_NEW, &n) || n.fd < 0) {
			printf("RESULT wl_shm FAIL NEW_ALLOC errno=%d\n", errno);
			return 1;
		}
		shm_fd[i] = n.fd;
	}
	printf("WLSHM: alloc ok\n");
	fflush(stdout);

	/* Item 2: each vfd must land on its OWN anon inode (anon_inode_create_getfd,
	 * not the aliasing anon_inode_getfd) so two shm pools don't collide. */
	struct stat st0, st1;
	if (fstat(shm_fd[0], &st0) || fstat(shm_fd[1], &st1)) {
		printf("RESULT wl_shm FAIL fstat errno=%d\n", errno);
		return 1;
	}
	int distinct_inode = st0.st_ino != st1.st_ino;
	printf("WLSHM: ino0=0x%lx ino1=0x%lx distinct_inode=%d\n", (unsigned long)st0.st_ino,
	       (unsigned long)st1.st_ino, distinct_inode);
	fflush(stdout);

	/* Item 3: attach BOTH shm vfds to the ctx in one SEND — the wire shape
	 * wl_shm_create_pool takes (message bytes + an out-of-band fd list). The
	 * host's _resolveShmFd runs on this SEND regardless of whether a
	 * compositor bridge is wired (runtime/virtio/wl-device.js _handle()).
	 * Deliberately done BEFORE any mmap/write below, so this evidence is on
	 * the wire even if the mmap content step turns out to be unsafe. */
	unsigned char buf[sizeof(struct virtwl_ioctl_txn) + SEND_PAYLOAD_LEN];
	struct virtwl_ioctl_txn *t = (struct virtwl_ioctl_txn *)buf;
	for (int i = 0; i < VIRTWL_SEND_MAX_ALLOCS; i++)
		t->fds[i] = -1;
	t->fds[0] = shm_fd[0];
	t->fds[1] = shm_fd[1];
	t->len = SEND_PAYLOAD_LEN;
	memcpy(buf + sizeof(struct virtwl_ioctl_txn), SEND_PAYLOAD, SEND_PAYLOAD_LEN);

	int sret = ioctl(ctx_fd, VIRTWL_IOCTL_SEND, buf);
	printf("WLSHM: send_ret=%d\n", sret);
	fflush(stdout);

	/* From here on is the part that needs guest mmap to actually reach the
	 * SAME physical page the host's pfn-derived view reads — genuinely
	 * unproven under a real (software) MMU; see the smoke's own header for
	 * why. A fatal signal past this point must not lose the WLSHM: lines
	 * already printed above (hence the fflush after every step), and must
	 * not be fatal to anything but THIS process (see main.c's caller: this
	 * runs as an ordinary child, never PID 1, for exactly this reason). */
	unsigned char *p[2];
	p[0] = mmap(NULL, SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd[0], 0);
	p[1] = mmap(NULL, SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, shm_fd[1], 0);
	if (p[0] == MAP_FAILED || p[1] == MAP_FAILED) {
		printf("RESULT wl_shm FAIL mmap errno=%d\n", errno);
		return 1;
	}
	printf("WLSHM: mmap ok\n");
	fflush(stdout);

	/* Read probe BEFORE any write, to separate a read-fault from a write-fault
	 * if this crashes. */
	volatile unsigned char rb0 = p[0][0];
	volatile unsigned char rb1 = p[1][0];
	printf("WLSHM: read_probe0=%u read_probe1=%u\n", (unsigned)rb0, (unsigned)rb1);
	fflush(stdout);

	for (int which = 0; which < 2; which++)
		for (unsigned i = 0; i < SHM_SIZE; i++)
			p[which][i] = pattern_byte(which, i);
	printf("WLSHM: pattern written\n");
	fflush(stdout);

	printf("RESULT wl_shm DONE ino_distinct=%d send_ret=%d\n", distinct_inode, sret);
	fflush(stdout);
	return 0;
}
