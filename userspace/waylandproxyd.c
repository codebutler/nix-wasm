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
 *   multiplexes: the listen socket, and — for EACH connected client — the
 *   client AF_UNIX socket plus that client's own virtwl ctx fd (poll()-able:
 *   POLLIN when the host has queued bytes for that ctx). For the multi-client
 *   bar (Phase 3 3c) each accepted connection gets its OWN VIRTWL_IOCTL_NEW_CTX
 *   (its own ctx fd) → its own host Greenfield client → its own pc window. The
 *   per-client state (ctx fd + the shm pool mirrors for fd↔vfd translation) is
 *   held in a small fixed array; RECV on a ctx fd only drains THAT ctx's queue,
 *   so host→guest bytes route back to the right client socket automatically.
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
 * Optional wire-protocol trace (set WL_WIRE_TRACE=1). The proxy normally moves
 * bytes opaquely, but to debug the steady-state animation cycle (weston-flowers
 * stalls after a burst) we need to SEE the obj/opcode conversation in both
 * directions: client→host commits/attach/frame, host→client frame-done +
 * wl_buffer.release. A buffer is a Wayland wire message stream: each message is
 * [u32 object_id][u32 (size<<16)|opcode][args…] with size INCLUDING the 8-byte
 * header and 32-bit aligned. We walk the buffer and dump each message's header
 * plus its first two arg words (enough to read done(time) / new_id / buffer id).
 */
static int wire_trace_enabled(void)
{
	static int v = -1;
	if (v < 0) {
		const char *e = getenv("WL_WIRE_TRACE");
		v = (e && *e && *e != '0') ? 1 : 0;
	}
	return v;
}

static void wire_dump(const char *dir, int ctx, const uint8_t *buf, size_t len)
{
	if (!wire_trace_enabled())
		return;
	size_t off = 0;
	int n = 0;
	while (off + 8 <= len) {
		uint32_t obj, w2;
		memcpy(&obj, buf + off, 4);
		memcpy(&w2, buf + off + 4, 4);
		uint32_t size = w2 >> 16;
		uint32_t op = w2 & 0xffff;
		if (size < 8 || (size & 3) || off + size > len) {
			printf("WIRE %s ctx=%d off=%zu MALFORMED obj=%u size=%u (tail %zuB)\n",
			       dir, ctx, off, obj, size, len - off);
			break;
		}
		uint32_t a0 = 0, a1 = 0;
		if (size >= 12)
			memcpy(&a0, buf + off + 8, 4);
		if (size >= 16)
			memcpy(&a1, buf + off + 12, 4);
		printf("WIRE %s ctx=%d obj=%u op=%u size=%u a0=%u a1=%u\n", dir, ctx, obj, op, size, a0, a1);
		off += size;
		n++;
	}
	if (n > 1 || off != len)
		printf("WIRE %s ctx=%d (%d msgs, %zu/%zuB consumed)\n", dir, ctx, n, off, len);
	fflush(stdout);
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
 * Live shm pool mirrors. A wl_shm client (e.g. wl-eyes) creates its pool from a
 * tmpfs fd, mmaps THAT, and keeps drawing into it across frames — it never
 * re-sends the fd. The host (Greenfield) reads pixels out of the virtwl VFD's
 * guest-RAM buffer. So a single copy at create_pool time is stale (the client
 * paints AFTER, on configure). We keep both mappings alive for the pool lifetime
 * and re-sync src(tmpfs)→dst(vfd) on every client→host message (the commit that
 * follows a paint), so the host always sees the latest pixels.
 */
#define MAX_POOLS 16
#define MAX_CLIENTS 8
struct pool_mirror {
	int vfd; /* the virtwl vfd id (also the open fd) */
	size_t size;
	void *src; /* client tmpfs mmap (PROT_READ; survives client close(fd)) */
	void *dst; /* vfd guest-RAM mmap (PROT_WRITE) */
};

/*
 * One connected guest Wayland client. Each gets its OWN virtwl ctx (so the host
 * spins up an independent Greenfield client → its own pc window) and its OWN set
 * of shm pool mirrors (fd↔vfd translation is per-client; a second client's pool
 * must never resync into the first's vfd).
 */
struct client_state {
	int sock; /* connected AF_UNIX client socket, or -1 if the slot is free */
	int ctx; /* this client's virtwl ctx fd (VIRTWL_IOCTL_NEW_CTX) */
	struct pool_mirror pools[MAX_POOLS];
	int npools;
};

/* Re-copy this client's live pool bytes into its vfd buffers (host-visible). */
static void resync_pools(struct client_state *cl)
{
	for (int i = 0; i < cl->npools; i++) {
		struct pool_mirror *p = &cl->pools[i];
		if (p->src && p->dst) {
			memcpy(p->dst, p->src, p->size);
			printf("waylandproxyd: resync pool ctx=%d vfd=%d firstpix=0x%08x\n",
			       cl->ctx, p->vfd, *(unsigned int *)p->src);
			fflush(stdout);
		}
	}
}

/*
 * Translate a plain client fd (a shm/memfd) into a virtwl shm vfd the host can
 * access: allocate a vfd of the client fd's size, copy the bytes across, and
 * register a live mirror so later frames re-sync (see resync_pools).
 * Returns the new vfd (>=0) or -1.
 */
static int fd_to_vfd(int wl0, struct client_state *cl, int client_fd)
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
	printf("waylandproxyd: fd_to_vfd vfd=%d size=%ld src=%p dst=%p firstpix=0x%08x\n",
	       alloc.fd, (long)st.st_size, src, dst,
	       (dst != MAP_FAILED) ? *(unsigned int *)dst : 0xdeadbeef);
	fflush(stdout);

	/* Keep the mappings alive (the mmaps survive the client's close(fd)) and
	 * register the pool so resync_pools() refreshes it on every later frame. */
	if (src != MAP_FAILED && dst != MAP_FAILED && cl->npools < MAX_POOLS) {
		cl->pools[cl->npools].vfd = alloc.fd;
		cl->pools[cl->npools].size = st.st_size;
		cl->pools[cl->npools].src = src;
		cl->pools[cl->npools].dst = dst;
		cl->npools++;
	} else {
		if (src != MAP_FAILED)
			munmap(src, st.st_size);
		if (dst != MAP_FAILED)
			munmap(dst, st.st_size);
	}
	return alloc.fd;
}

/* Splice client→host: read client wire bytes+fds, translate fds, SEND on ctx. */
static int splice_client_to_host(int wl0, struct client_state *cl)
{
	int ctx = cl->ctx;
	uint8_t data[WIRE_BUF];
	int cfds[MAX_FDS];
	int nfds = 0;
	ssize_t n = client_recv(cl->sock, data, cfds, &nfds);
	if (n == 0)
		return 0; /* EOF */
	if (n < 0)
		return (errno == EAGAIN || errno == EWOULDBLOCK) ? 1 : -1;

	wire_dump("c->h", cl->ctx, data, (size_t)n);

	/*
	 * Refresh every live shm pool before forwarding this message. The client
	 * paints into its tmpfs mapping then sends a commit; mirroring here means the
	 * vfd (host-visible) carries the just-drawn pixels by the time Greenfield
	 * processes the commit. (Cheap: a handful of ~300 KB memcpys per frame.)
	 */
	resync_pools(cl);

	struct txn_buf txn;
	memset(&txn, 0, sizeof(txn));
	for (int i = 0; i < MAX_FDS; i++)
		txn.hdr.fds[i] = -1;

	/* Translate each client fd into a virtwl vfd for the SEND. */
	int vfds[MAX_FDS];
	int nvfds = 0;
	for (int i = 0; i < nfds; i++) {
		int vfd = fd_to_vfd(wl0, cl, cfds[i]);
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
	/*
	 * Do NOT close the shm-pool vfds: the host reads pixels out of the vfd's
	 * guest-RAM buffer for the pool's lifetime, and resync_pools() keeps mirroring
	 * the client's writes into it. Closing here would free the buffer (and the
	 * host would see freed/garbage memory). Pipe/ctx vfds aren't created on this
	 * path. (Pool vfds + their mmaps are reclaimed at client disconnect.)
	 */
	(void)vfds;

	if (ret) {
		fprintf(stderr, "waylandproxyd: SEND failed ret=%d errno=%d\n", ret, errno);
		return -1;
	}
	printf("waylandproxyd: forwarded %zdB + %d fd(s) client->host (ctx=%d)\n", n, nvfds, ctx);
	fflush(stdout);
	return 1;
}

/* Splice host→client: RECV from this client's ctx, forward bytes+vfds. */
static int splice_host_to_client(struct client_state *cl)
{
	int ctx = cl->ctx;
	int client = cl->sock;
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
		wire_dump("h->c", ctx, txn.payload, txn.hdr.len);
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

/* Allocate a fresh virtwl ctx fd (one per client). Returns the fd or -1. */
static int new_ctx(int wl0)
{
	struct virtwl_ioctl_new newctx;
	memset(&newctx, 0, sizeof(newctx));
	newctx.type = VIRTWL_IOCTL_NEW_CTX;
	newctx.fd = -1;
	if (ioctl(wl0, VIRTWL_IOCTL_NEW, &newctx) || newctx.fd < 0)
		return -1;
	return newctx.fd;
}

/* Tear down a client slot: ctx fd, socket, and all its pool mirrors. */
static void close_client(struct client_state *cl)
{
	for (int i = 0; i < cl->npools; i++) {
		struct pool_mirror *p = &cl->pools[i];
		if (p->src)
			munmap(p->src, p->size);
		if (p->dst)
			munmap(p->dst, p->size);
	}
	cl->npools = 0;
	if (cl->ctx >= 0)
		close(cl->ctx);
	if (cl->sock >= 0)
		close(cl->sock);
	cl->ctx = -1;
	cl->sock = -1;
}

int main(void)
{
	/* 1. Open /dev/wl0 — the host channel. Each accepted client gets its OWN
	 *    ctx allocated lazily off this fd (see new_ctx), so N concurrent guest
	 *    Wayland clients map to N independent host Greenfield clients/windows. */
	int wl0 = open("/dev/wl0", O_RDWR | O_CLOEXEC);
	if (wl0 < 0) {
		printf("RESULT waylandproxyd FAIL open(/dev/wl0) errno=%d\n", errno);
		return 1;
	}

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
	printf("RESULT waylandproxyd PASS listening=%s (/dev/wl0 open, wayland-0 ready, multi-client)\n",
	       path);
	fflush(stdout);

	/* 3. poll() loop: the listen socket + (per live client) its socket and its
	 *    own ctx fd. Each client's host→guest bytes arrive on its ctx fd, so a
	 *    RECV there routes straight back to the matching socket. */
	struct client_state clients[MAX_CLIENTS];
	for (int i = 0; i < MAX_CLIENTS; i++) {
		clients[i].sock = -1;
		clients[i].ctx = -1;
		clients[i].npools = 0;
	}

	/* pollfd layout: [0] = lsock, then 2 entries per live client (sock, ctx).
	 * Worst case: 1 + 2*MAX_CLIENTS. */
	struct pollfd pfds[1 + 2 * MAX_CLIENTS];
	/* Parallel map from each client pollfd index back to its client slot. */
	int slot_of[1 + 2 * MAX_CLIENTS];
	int is_ctx[1 + 2 * MAX_CLIENTS];

	for (;;) {
		int n = 0;
		pfds[n].fd = lsock;
		pfds[n].events = POLLIN;
		slot_of[n] = -1;
		is_ctx[n] = 0;
		n++;

		for (int i = 0; i < MAX_CLIENTS; i++) {
			if (clients[i].sock < 0)
				continue;
			pfds[n].fd = clients[i].sock;
			pfds[n].events = POLLIN;
			slot_of[n] = i;
			is_ctx[n] = 0;
			n++;
			pfds[n].fd = clients[i].ctx;
			pfds[n].events = POLLIN; /* host has bytes for the guest */
			slot_of[n] = i;
			is_ctx[n] = 1;
			n++;
		}

		int r = poll(pfds, n, -1);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			break;
		}

		/* New client connection → allocate a fresh ctx for it. */
		if (pfds[0].revents & POLLIN) {
			int c;
			while ((c = accept(lsock, NULL, NULL)) >= 0) {
				int slot = -1;
				for (int i = 0; i < MAX_CLIENTS; i++)
					if (clients[i].sock < 0) {
						slot = i;
						break;
					}
				if (slot < 0) {
					fprintf(stderr, "waylandproxyd: no free client slot; rejecting\n");
					close(c);
					continue;
				}
				int ctx = new_ctx(wl0);
				if (ctx < 0) {
					fprintf(stderr, "waylandproxyd: NEW_CTX failed errno=%d\n", errno);
					close(c);
					continue;
				}
				int fl = fcntl(c, F_GETFL, 0);
				fcntl(c, F_SETFL, fl | O_NONBLOCK);
				clients[slot].sock = c;
				clients[slot].ctx = ctx;
				clients[slot].npools = 0;
				printf("RESULT waylandproxyd PASS accepted client fd=%d ctx_fd=%d slot=%d (splice begun)\n",
				       c, ctx, slot);
				fflush(stdout);
			}
			/* accept() drained (EAGAIN) — fall through to per-client servicing. */
		}

		/* Per-client splice. Iterate the pollfd map; a slot torn down mid-loop
		 * leaves its later pollfd entries pointing at a closed fd, so guard on
		 * the slot still being live. */
		for (int k = 1; k < n; k++) {
			int slot = slot_of[k];
			if (slot < 0)
				continue;
			struct client_state *cl = &clients[slot];
			if (cl->sock < 0)
				continue; /* torn down earlier in this pass */
			short re = pfds[k].revents;
			if (!re)
				continue;

			if (!is_ctx[k]) {
				/* Client → host. */
				if (re & (POLLIN | POLLHUP)) {
					int s = splice_client_to_host(wl0, cl);
					if (s <= 0) {
						printf("waylandproxyd: client slot=%d disconnected (splice end)\n",
						       slot);
						fflush(stdout);
						close_client(cl);
					}
				}
			} else {
				/* Host → client. */
				if (re & POLLIN) {
					if (splice_host_to_client(cl) < 0)
						close_client(cl);
				}
			}
		}
	}

	for (int i = 0; i < MAX_CLIENTS; i++)
		if (clients[i].sock >= 0)
			close_client(&clients[i]);
	close(lsock);
	close(wl0);
	unlink(path);
	return 0;
}
