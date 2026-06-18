/*
 * waylandproxyd.c — a thin guest-side Wayland↔virtwl bridge for the Linux/Wasm
 * guest ("pc" Wayland Phase 1, sub-step 1c — the Sommelier pivot).
 *
 * Real Sommelier cannot cross-build to wasm32-nommu (X11/xcb + gbm/mesa + libdrm
 * are structurally mandatory in sommelier.c — see p1-1c-report.md). This program
 * performs the in-scope SUBSET of Sommelier's job for the wl_shm path that
 * wl-eyes needs:
 *
 *   guest libwayland client  --AF_UNIX (wayland-0)-->  waylandproxyd
 *   waylandproxyd  --/dev/wl0 ctx (VIRTWL_IOCTL_SEND/RECV)-->  host (JS) compositor
 *
 * Design — RAW AF_UNIX + manual wire splice (NOT linked against libwayland):
 *   The proxy does not parse the Wayland object protocol or maintain any object
 *   state. Its job is to move bytes + ancillary fds verbatim between two
 *   transports, translating the fd-passing mechanism. libwayland would force its
 *   own event-loop/object model on us for zero benefit here; raw sockets + a
 *   poll() loop are smaller and exactly match what the virtwl bridge in
 *   sommelier.c does (minus all X11/gbm).
 *
 * NOMMU: single process, no fork/exec, no threads, no setjmp. One poll() loop
 *   multiplexes: the listen socket, the connected client socket, and the virtwl
 *   ctx fd (which is poll()-able — POLLIN when the host has queued bytes for the
 *   guest, POLLOUT when the OUT vq has room). For the 1c bar we handle a single
 *   client connection at a time; the loop generalizes to N clients trivially.
 *
 * fd translation (wl_shm path):
 *   Wayland passes fds over the client socket via SCM_RIGHTS (e.g.
 *   wl_shm.create_pool carries the pool's shm fd). virtwl's SEND ioctl only
 *   accepts *virtwl vfds* (kernel checks f_op == virtwl_vfd_fops), so a plain
 *   client fd must be wrapped: allocate a virtwl shm vfd (VIRTWL_IOCTL_NEW with
 *   NEW_ALLOC), mmap both it and the client's shm fd, copy the bytes across, and
 *   pass the *vfd* in the SEND's fds[]. The reverse (host→guest vfd → a plain fd
 *   the client can use) is handled by RECV returning anon-inode vfds, which we
 *   forward as-is over SCM_RIGHTS (the client mmaps the vfd directly).
 *   The registry handshake (what 1c proves) carries NO fds, so the byte splice
 *   alone exercises the host path; the fd-translation code below is built for the
 *   create_pool case but only fully exercised once the JS host speaks Wayland (1d).
 *
 * Emits "RESULT waylandproxyd PASS|FAIL ..." markers the Node runner greps.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>

/* ---- virtwl UAPI (mirror of uapi/linux/virtwl.h; kept local, like wltest.c). */
#define VIRTWL_SEND_MAX_ALLOCS 28
#define VIRTWL_IOCTL_BASE 'w'
#define VIRTWL_IO(nr) _IO(VIRTWL_IOCTL_BASE, nr)
#define VIRTWL_IOR(nr, type) _IOR(VIRTWL_IOCTL_BASE, nr, type)
#define VIRTWL_IOW(nr, type) _IOW(VIRTWL_IOCTL_BASE, nr, type)
#define VIRTWL_IOWR(nr, type) _IOWR(VIRTWL_IOCTL_BASE, nr, type)

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

struct virtwl_ioctl_txn {
	int fds[VIRTWL_SEND_MAX_ALLOCS];
	uint32_t len;
	uint8_t data[0];
};

#define VIRTWL_IOCTL_NEW VIRTWL_IOWR(0x00, struct virtwl_ioctl_new)
#define VIRTWL_IOCTL_SEND VIRTWL_IOR(0x01, struct virtwl_ioctl_txn)
#define VIRTWL_IOCTL_RECV VIRTWL_IOW(0x02, struct virtwl_ioctl_txn)

/* ---- limits ---------------------------------------------------------------- */
#define WIRE_BUF 4096 /* max bytes spliced per direction per turn */
#define MAX_FDS VIRTWL_SEND_MAX_ALLOCS

/* A txn buffer big enough for the header + WIRE_BUF of payload. */
struct txn_buf {
	struct virtwl_ioctl_txn hdr;
	uint8_t payload[WIRE_BUF];
};

static const char *runtime_dir(void)
{
	const char *d = getenv("XDG_RUNTIME_DIR");
	return (d && *d) ? d : "/tmp";
}

/*
 * Receive up to WIRE_BUF bytes + up to MAX_FDS fds from a client AF_UNIX socket.
 * Returns byte count (>0), 0 on EOF, -1 on error/would-block (errno set).
 * Out: data[], *fds (caller array of MAX_FDS), *nfds.
 */
static ssize_t client_recv(int sock, uint8_t *data, int *fds, int *nfds)
{
	struct iovec iov = { .iov_base = data, .iov_len = WIRE_BUF };
	char cbuf[CMSG_SPACE(sizeof(int) * MAX_FDS)];
	struct msghdr msg = {
		.msg_iov = &iov,
		.msg_iovlen = 1,
		.msg_control = cbuf,
		.msg_controllen = sizeof(cbuf),
	};
	*nfds = 0;
	ssize_t n = recvmsg(sock, &msg, MSG_DONTWAIT);
	if (n <= 0)
		return n;

	for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
		if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
			int cnt = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
			int *p = (int *)CMSG_DATA(c);
			for (int i = 0; i < cnt && *nfds < MAX_FDS; i++)
				fds[(*nfds)++] = p[i];
		}
	}
	return n;
}

/* Send data + fds to the client socket over SCM_RIGHTS. Returns 0 / -1. */
static int client_send(int sock, const uint8_t *data, size_t len, int *fds, int nfds)
{
	struct iovec iov = { .iov_base = (void *)data, .iov_len = len };
	char cbuf[CMSG_SPACE(sizeof(int) * MAX_FDS)];
	struct msghdr msg = { .msg_iov = &iov, .msg_iovlen = 1 };
	if (nfds > 0) {
		msg.msg_control = cbuf;
		msg.msg_controllen = CMSG_SPACE(sizeof(int) * nfds);
		struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
		c->cmsg_level = SOL_SOCKET;
		c->cmsg_type = SCM_RIGHTS;
		c->cmsg_len = CMSG_LEN(sizeof(int) * nfds);
		memcpy(CMSG_DATA(c), fds, sizeof(int) * nfds);
	}
	return sendmsg(sock, &msg, MSG_NOSIGNAL) < 0 ? -1 : 0;
}

/*
 * Translate a plain client fd (a shm/memfd) into a virtwl shm vfd the host can
 * access: allocate a vfd of the client fd's size, copy the bytes across.
 * Returns the new vfd (>=0) or -1. The wl_shm.create_pool path; only exercised
 * once the JS host speaks Wayland (1d), but built here so the seam is complete.
 */
static int fd_to_vfd(int wl0, int client_fd)
{
	struct stat st;
	if (fstat(client_fd, &st) < 0 || st.st_size <= 0)
		return -1;

	struct virtwl_ioctl_new alloc;
	memset(&alloc, 0, sizeof(alloc));
	alloc.type = VIRTWL_IOCTL_NEW_ALLOC;
	alloc.fd = -1;
	alloc.size = (uint32_t)st.st_size;
	if (ioctl(wl0, VIRTWL_IOCTL_NEW, &alloc) || alloc.fd < 0)
		return -1;

	void *src = mmap(NULL, st.st_size, PROT_READ, MAP_SHARED, client_fd, 0);
	void *dst = mmap(NULL, st.st_size, PROT_WRITE, MAP_SHARED, alloc.fd, 0);
	if (src != MAP_FAILED && dst != MAP_FAILED)
		memcpy(dst, src, st.st_size);
	if (src != MAP_FAILED)
		munmap(src, st.st_size);
	if (dst != MAP_FAILED)
		munmap(dst, st.st_size);
	return alloc.fd;
}

/* Splice client→host: read client wire bytes+fds, translate fds, SEND on ctx. */
static int splice_client_to_host(int wl0, int ctx, int client)
{
	uint8_t data[WIRE_BUF];
	int cfds[MAX_FDS];
	int nfds = 0;
	ssize_t n = client_recv(client, data, cfds, &nfds);
	if (n == 0)
		return 0; /* EOF */
	if (n < 0)
		return (errno == EAGAIN || errno == EWOULDBLOCK) ? 1 : -1;

	struct txn_buf txn;
	memset(&txn, 0, sizeof(txn));
	for (int i = 0; i < MAX_FDS; i++)
		txn.hdr.fds[i] = -1;

	/* Translate each client fd into a virtwl vfd for the SEND. */
	int vfds[MAX_FDS];
	int nvfds = 0;
	for (int i = 0; i < nfds; i++) {
		int vfd = fd_to_vfd(wl0, cfds[i]);
		close(cfds[i]); /* done with the client's copy */
		if (vfd < 0) {
			fprintf(stderr, "waylandproxyd: fd_to_vfd failed for fd %d\n", cfds[i]);
			continue;
		}
		txn.hdr.fds[nvfds] = vfd;
		vfds[nvfds++] = vfd;
	}

	txn.hdr.len = (uint32_t)n;
	memcpy(txn.payload, data, n);

	int ret = ioctl(ctx, VIRTWL_IOCTL_SEND, &txn);
	for (int i = 0; i < nvfds; i++)
		close(vfds[i]); /* the SEND copied them to the host */

	if (ret) {
		fprintf(stderr, "waylandproxyd: SEND failed ret=%d errno=%d\n", ret, errno);
		return -1;
	}
	printf("waylandproxyd: forwarded %zdB + %d fd(s) client->host\n", n, nvfds);
	fflush(stdout);
	return 1;
}

/* Splice host→client: RECV from ctx, forward bytes+vfds over SCM_RIGHTS. */
static int splice_host_to_client(int ctx, int client)
{
	struct txn_buf txn;
	memset(&txn, 0, sizeof(txn));
	txn.hdr.len = WIRE_BUF;

	int ret = ioctl(ctx, VIRTWL_IOCTL_RECV, &txn);
	if (ret) {
		if (errno == EAGAIN || errno == EWOULDBLOCK)
			return 1;
		fprintf(stderr, "waylandproxyd: RECV failed ret=%d errno=%d\n", ret, errno);
		return -1;
	}

	int fds[MAX_FDS];
	int nfds = 0;
	for (int i = 0; i < MAX_FDS; i++) {
		if (txn.hdr.fds[i] < 0)
			break;
		fds[nfds++] = txn.hdr.fds[i];
	}

	if (txn.hdr.len > 0 || nfds > 0) {
		if (client_send(client, txn.payload, txn.hdr.len, fds, nfds) < 0)
			fprintf(stderr, "waylandproxyd: client_send failed errno=%d\n", errno);
		else {
			printf("waylandproxyd: forwarded %uB + %d fd(s) host->client\n",
			       txn.hdr.len, nfds);
			fflush(stdout);
		}
	}
	for (int i = 0; i < nfds; i++)
		close(fds[i]);
	return 1;
}

int main(void)
{
	/* 1. Open /dev/wl0 and establish a virtwl context (the host channel). */
	int wl0 = open("/dev/wl0", O_RDWR | O_CLOEXEC);
	if (wl0 < 0) {
		printf("RESULT waylandproxyd FAIL open(/dev/wl0) errno=%d\n", errno);
		return 1;
	}

	struct virtwl_ioctl_new newctx;
	memset(&newctx, 0, sizeof(newctx));
	newctx.type = VIRTWL_IOCTL_NEW_CTX;
	newctx.fd = -1;
	if (ioctl(wl0, VIRTWL_IOCTL_NEW, &newctx) || newctx.fd < 0) {
		printf("RESULT waylandproxyd FAIL NEW_CTX errno=%d\n", errno);
		close(wl0);
		return 1;
	}
	int ctx = newctx.fd;
	printf("waylandproxyd: /dev/wl0 ctx established ctx_fd=%d\n", ctx);
	fflush(stdout);

	/* 2. Create + listen() on $XDG_RUNTIME_DIR/wayland-0. */
	char path[128];
	snprintf(path, sizeof(path), "%s/wayland-0", runtime_dir());
	unlink(path); /* stale socket from a prior run */

	int lsock = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
	if (lsock < 0) {
		printf("RESULT waylandproxyd FAIL socket() errno=%d\n", errno);
		return 1;
	}
	struct sockaddr_un addr;
	memset(&addr, 0, sizeof(addr));
	addr.sun_family = AF_UNIX;
	strncpy(addr.sun_path, path, sizeof(addr.sun_path) - 1);
	if (bind(lsock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
		printf("RESULT waylandproxyd FAIL bind(%s) errno=%d\n", path, errno);
		return 1;
	}
	if (listen(lsock, 4) < 0) {
		printf("RESULT waylandproxyd FAIL listen() errno=%d\n", errno);
		return 1;
	}
	printf("RESULT waylandproxyd PASS ctx_fd=%d listening=%s (/dev/wl0 ctx up, wayland-0 ready)\n",
	       ctx, path);
	fflush(stdout);

	/* 3. poll() loop: listen socket + (one) client + the virtwl ctx fd. */
	int client = -1;
	for (;;) {
		struct pollfd pfds[3];
		int n = 0;
		int li = n;
		pfds[n].fd = lsock;
		pfds[n].events = POLLIN;
		n++;
		int ci = -1, xi = -1;
		if (client >= 0) {
			ci = n;
			pfds[n].fd = client;
			pfds[n].events = POLLIN;
			n++;
			xi = n;
			pfds[n].fd = ctx;
			pfds[n].events = POLLIN; /* host has bytes for the guest */
			n++;
		}

		int r = poll(pfds, n, -1);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			break;
		}

		/* New client connection. */
		if (pfds[li].revents & POLLIN) {
			int c = accept(lsock, NULL, NULL);
			if (c >= 0) {
				if (client < 0) {
					client = c;
					int fl = fcntl(client, F_GETFL, 0);
					fcntl(client, F_SETFL, fl | O_NONBLOCK);
					printf("RESULT waylandproxyd PASS accepted client fd=%d (splice begun)\n",
					       client);
					fflush(stdout);
				} else {
					/* 1c bar: one client at a time. */
					close(c);
				}
			}
		}

		/* Client → host. */
		if (ci >= 0 && (pfds[ci].revents & (POLLIN | POLLHUP))) {
			int s = splice_client_to_host(wl0, ctx, client);
			if (s <= 0) {
				printf("waylandproxyd: client disconnected (splice end)\n");
				fflush(stdout);
				close(client);
				client = -1;
				continue;
			}
		}

		/* Host → client. */
		if (xi >= 0 && (pfds[xi].revents & POLLIN)) {
			if (splice_host_to_client(ctx, client) < 0) {
				close(client);
				client = -1;
			}
		}
	}

	if (client >= 0)
		close(client);
	close(lsock);
	close(ctx);
	close(wl0);
	unlink(path);
	return 0;
}
