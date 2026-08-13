/*
 * wl-shm-test.c — issue #11 items-2/3 wl_shm-on-MMU exercise (tracked as
 * issue #203 once mmap content is at stake — see below).
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
 * Both shm vfds are attached to the ctx via a FIRST VIRTWL_IOCTL_SEND — the
 * wire shape a real wl_shm_create_pool takes (message bytes + an
 * out-of-band fd list) — BEFORE any mmap/write is attempted, so the host
 * device model's per-SEND `_resolveShmFd` pfn->host-offset resolution
 * (issue #11 item 3; runtime/virtio/wl-device.js) is exercised and
 * observable even if the mmap/write step below turns out to be unsafe on
 * this kernel. This first SEND's fds are what the Node smoke uses for its
 * ITEM3_ADDR shape check — deliberately BEFORE the pattern is written, so
 * that check can never accidentally pass by reading post-write bytes.
 *
 * Only THEN does it mmap each vfd, do a single-byte READ probe (to tell a
 * read-fault from a write-fault if this crashes), and write a distinct
 * deterministic byte pattern into it — the only userspace-visible way to
 * place known bytes into the vfd's kernel backing (there is no write() path
 * onto shm_buf, only mmap). If (and only if) that succeeds, it issues a
 * SECOND SEND — a distinct payload, same two fds — to "commit" the drawn
 * buffer; this is the real wire shape (attach, draw, commit) and is what the
 * Node smoke's CONTENT check reads: a live host view captured AT THAT
 * SECOND SEND, after the write.
 *
 * TWO EXIT PATHS, both deliberate:
 *   - if the second SEND fails to even get issued (mmap/the read probe/the
 *     write crashes this process first — the CURRENT, reproducible state,
 *     see the smoke's own header for the exact signature), this process
 *     simply dies to a fatal signal and the shell it was run from reports
 *     that — nothing below this comment runs.
 *   - if the second SEND DOES return successfully, this process prints
 *     "WLSHM: held" and PARKS FOREVER with the fds still open, rather than
 *     printing a RESULT line and exiting normally. See the comment at that
 *     branch for why: kernel-worker.js's sendOut is an ASYNC postMessage of
 *     {byteOffset,length} — not a copy — so the fds must stay open (backing
 *     pages allocated) until the host has actually caught up and built its
 *     view, or this process exiting/closing them would race the kernel
 *     freeing/reusing that memory out from under the host.
 *
 * Every step prints a WLSHM: progress line and flushes stdout immediately,
 * so a fatal signal past mmap() leaves the preceding progress fully visible
 * to whatever waited on this process's stdout/exit status.
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

/* A union, not a bare byte buffer, so the compiler guarantees the buffer is
 * aligned for `struct virtwl_ioctl_txn`'s `int`/`uint32_t` members before we
 * alias it via a pointer cast (a plain `unsigned char[]` gives no such
 * guarantee). */
union txn_buf {
	struct virtwl_ioctl_txn txn;
	unsigned char raw[sizeof(struct virtwl_ioctl_txn) + 8];
};

#define VIRTWL_IOCTL_NEW _VIRTWL_IOWR(0x00, struct virtwl_ioctl_new)
#define VIRTWL_IOCTL_SEND _VIRTWL_IOR(0x01, struct virtwl_ioctl_txn)

#define SHM_SIZE 4096
#define SEND1_PAYLOAD "SHMPING!" /* attach, before the buffer is drawn */
#define SEND2_PAYLOAD "SHMDONE!" /* commit, after the buffer is drawn */
#define SEND_PAYLOAD_LEN 8

/* Deterministic per-buffer pattern; the Node smoke computes the SAME formula
 * to check the host-observed bytes bit-exact. Two different formulas (by
 * `which`) so the two allocations are also distinguishable from each other,
 * not just from all-zero. */
static unsigned char pattern_byte(int which, unsigned i)
{
	return (unsigned char)(which == 0 ? (i * 3 + 7) : (i * 5 + 11));
}

/* Build + issue one VIRTWL_IOCTL_SEND attaching both shm fds, with `payload`
 * as the message bytes. Returns the ioctl's return value (0 on success; a
 * negative virtwl_resp_err()-translated value on a guest-side SEND failure
 * — NOT the same axis as a host-side resolution failure, so callers must
 * check this explicitly rather than inferring failure from what the host
 * observed). */
static int send_both(int ctx_fd, int shm_fd0, int shm_fd1, const char *payload)
{
	union txn_buf b;
	memset(&b, 0, sizeof(b));
	for (int i = 0; i < VIRTWL_SEND_MAX_ALLOCS; i++)
		b.txn.fds[i] = -1;
	b.txn.fds[0] = shm_fd0;
	b.txn.fds[1] = shm_fd1;
	b.txn.len = SEND_PAYLOAD_LEN;
	memcpy(b.raw + sizeof(struct virtwl_ioctl_txn), payload, SEND_PAYLOAD_LEN);
	return ioctl(ctx_fd, VIRTWL_IOCTL_SEND, &b);
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
	 * not the aliasing anon_inode_getfd) so two shm pools don't collide. Print
	 * with %llu (not %lu — ino_t is 64-bit even on this wasm32 target, and a
	 * %lu/`unsigned long` cast would silently truncate the printed value; the
	 * != comparison above is unaffected since it compares the full-width
	 * st_ino fields directly). */
	struct stat st0, st1;
	if (fstat(shm_fd[0], &st0) || fstat(shm_fd[1], &st1)) {
		printf("RESULT wl_shm FAIL fstat errno=%d\n", errno);
		return 1;
	}
	int distinct_inode = st0.st_ino != st1.st_ino;
	printf("WLSHM: ino0=0x%llx ino1=0x%llx distinct_inode=%d\n",
	       (unsigned long long)st0.st_ino, (unsigned long long)st1.st_ino, distinct_inode);
	fflush(stdout);

	/* Item 3: attach BOTH shm vfds to the ctx (the wire shape wl_shm_create_pool
	 * takes: message bytes + an out-of-band fd list). The host's
	 * _resolveShmFd runs on this SEND regardless of whether a compositor
	 * bridge is wired (runtime/virtio/wl-device.js _handle()). Deliberately
	 * done BEFORE any mmap/write below, so this evidence is on the wire even
	 * if the mmap content step turns out to be unsafe. A negative return here
	 * is a GUEST-side ioctl failure (bad fds, host RESP_ERR, …) — print errno
	 * so it reads as that, not as "the host never resolved anything" (which
	 * is a different, host-side failure the Node smoke reports separately). */
	int send1_ret = send_both(ctx_fd, shm_fd[0], shm_fd[1], SEND1_PAYLOAD);
	printf("WLSHM: send1_ret=%d", send1_ret);
	if (send1_ret < 0)
		printf(" errno=%d", errno);
	printf("\n");
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

	/* Second SEND — the "commit" the smoke's CONTENT check reads: captured by
	 * the host AFTER the pattern write, on the SAME two fds. See the file
	 * header for why this (not a re-view of send1's fds, and not a fresh
	 * SEND after the process exits) is the correct place to read from. */
	int send2_ret = send_both(ctx_fd, shm_fd[0], shm_fd[1], SEND2_PAYLOAD);
	printf("WLSHM: send2_ret=%d", send2_ret);
	if (send2_ret < 0)
		printf(" errno=%d", errno);
	printf("\n");
	fflush(stdout);

	if (send2_ret == 0) {
		/* RACE (see the smoke's own header for the full mechanism name and
		 * the code sites): the SEND2 ioctl above already returned to us —
		 * kernel-worker.js's sendOut posts only {byteOffset,length} for
		 * these fds (NOT copies) via an ASYNC postMessage and completes the
		 * ioctl immediately; kernel-host.js re-views the shared memory at
		 * those offsets whenever it gets around to processing that message.
		 * If THIS process now closed the fds (or just exited, which closes
		 * them implicitly), the vfd's anon inode would drop its last
		 * reference, the kernel would free the backing pages
		 * (do_vfd_close), and the host could end up constructing its view
		 * over freed/reused memory — wrong bytes, not a clean failure. So:
		 * do NOT close, do NOT exit. Print a distinct witness and park with
		 * the fds STILL OPEN, keeping the backing pages allocated and
		 * untouched for as long as it takes the host to catch up. The Node
		 * smoke kills this whole guest (not a real signal to this process)
		 * once it has copied the bytes out, so parking forever here is
		 * safe, not a leak — do NOT "simplify" this into an exit(0), and do
		 * NOT re-derive a shorter sleep: the smoke's teardown, not a
		 * timer here, is what ends this. */
		printf("WLSHM: held\n");
		fflush(stdout);
		for (;;)
			pause();
	}

	printf("RESULT wl_shm DONE ino_distinct=%d send1_ret=%d send2_ret=%d\n", distinct_inode,
	       send1_ret, send2_ret);
	fflush(stdout);
	return 0;
}
