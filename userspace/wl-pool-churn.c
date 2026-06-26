/*
 * wl-pool-churn.c — wl_shm buffer alloc/free leak test for Sommelier virtwl (#7).
 *
 * Connects to wayland-0 via libwayland-client (through Sommelier/virtwl) and
 * drives the FULL shm buffer path — wl_surface + wl_shm_pool + wl_buffer +
 * attach + commit — because that is what makes Sommelier issue a virtwl
 * VIRTWL_IOCTL_NEW_ALLOC (the kernel-side alloc_pages_exact shm object). A pool
 * alone does NOT allocate: sl_shm_create_host_pool just stores the fd
 * (sommelier-shm.cc) and the NEW_ALLOC happens on the surface-commit attach path
 * (sommelier-compositor.cc). So a pool-only churn would allocate nothing and
 * prove nothing — we must commit buffers.
 *
 * Test shape (self-measuring via /proc/meminfo MemFree, so the harness only
 * greps the RESULT line):
 *   1. sample MemFree (start)
 *   2. HOLD: create+attach+commit N buffers and keep them all live; sample
 *      MemFree (held). A working alloc path drops MemFree by ~N*POOL_SIZE.
 *   3. RELEASE: destroy every buffer/pool/surface; sample MemFree (released).
 *      Sommelier issues VIRTWL_IOCTL_CLOSE on destroy so MemFree returns to ~start.
 *
 * PASS requires BOTH:
 *   - alloc actually happened   (held_drop  >= N*POOL_SIZE/2)  → test is non-trivial
 *   - everything was freed      (leftover   <  N*POOL_SIZE/2)  → no leak
 * On waylandproxyd the buffers alloc but are never freed → leftover ~= held_drop
 * → FAIL (and post-test order-11 allocations fragment). On Sommelier → PASS.
 *
 * Usage:  wl-pool-churn [N]      N = number of buffers (default 32)
 * Exit 0 on PASS, 1 on FAIL. Prints: RESULT wl-pool-churn PASS|FAIL ...
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#include <wayland-client.h>

/* 1024x1024 ARGB8888 = 4 MiB per buffer. Large enough that leaked buffers
 * deplete the guest RAM and fragment the buddy allocator (order-11). */
#define WIDTH 1024
#define HEIGHT 1024
#define STRIDE (WIDTH * 4)
#define POOL_SIZE (STRIDE * HEIGHT) /* 4 MiB */
#define N_DEFAULT 32
#define N_MAX 256

struct registry_state {
	struct wl_compositor *compositor;
	struct wl_shm *shm;
};

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
			    const char *iface, uint32_t ver)
{
	struct registry_state *st = data;
	if (strcmp(iface, wl_compositor_interface.name) == 0)
		st->compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 1);
	else if (strcmp(iface, wl_shm_interface.name) == 0)
		st->shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
}
static void registry_global_remove(void *data, struct wl_registry *reg, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

/* MemFree in kB from /proc/meminfo, or -1 on error. */
static long read_memfree_kb(void)
{
	FILE *f = fopen("/proc/meminfo", "r");
	if (!f)
		return -1;
	char line[256];
	long kb = -1;
	while (fgets(line, sizeof(line), f)) {
		if (sscanf(line, "MemFree: %ld kB", &kb) == 1)
			break;
	}
	fclose(f);
	return kb;
}

/* Anonymous /tmp tmpfile of the given size. */
static int create_shm_file(off_t size)
{
	char name[] = "/tmp/wl-pool-churn-XXXXXX";
	int fd = mkstemp(name);
	if (fd < 0) {
		perror("wl-pool-churn: mkstemp");
		return -1;
	}
	unlink(name);
	if (ftruncate(fd, size) < 0) {
		perror("wl-pool-churn: ftruncate");
		close(fd);
		return -1;
	}
	return fd;
}

struct live {
	struct wl_surface *surface;
	struct wl_shm_pool *pool;
	struct wl_buffer *buffer;
};

int main(int argc, char **argv)
{
	int n = N_DEFAULT;
	if (argc > 1) {
		n = atoi(argv[1]);
		if (n <= 0 || n > N_MAX) {
			fprintf(stderr, "wl-pool-churn: bad N '%s' (1..%d)\n", argv[1], N_MAX);
			return 1;
		}
	}

	struct wl_display *display = wl_display_connect(NULL);
	if (!display) {
		printf("RESULT wl-pool-churn FAIL wl_display_connect\n");
		return 1;
	}
	struct registry_state st = { 0 };
	struct wl_registry *registry = wl_display_get_registry(display);
	wl_registry_add_listener(registry, &registry_listener, &st);
	wl_display_roundtrip(display);

	if (!st.shm || !st.compositor) {
		printf("RESULT wl-pool-churn FAIL missing globals (shm=%p compositor=%p)\n",
		       (void *)st.shm, (void *)st.compositor);
		return 1;
	}

	struct live *live = calloc(n, sizeof(*live));
	if (!live) {
		printf("RESULT wl-pool-churn FAIL calloc\n");
		return 1;
	}

	long mem_start = read_memfree_kb();

	/* ── HOLD: create + attach + commit N buffers, keep them all live ── */
	int created = 0;
	for (int i = 0; i < n; i++) {
		int fd = create_shm_file(POOL_SIZE);
		if (fd < 0)
			break;
		struct wl_shm_pool *pool = wl_shm_create_pool(st.shm, fd, POOL_SIZE);
		close(fd);
		if (!pool)
			break;
		struct wl_buffer *buffer = wl_shm_pool_create_buffer(
			pool, 0, WIDTH, HEIGHT, STRIDE, WL_SHM_FORMAT_ARGB8888);
		struct wl_surface *surface = wl_compositor_create_surface(st.compositor);
		if (!buffer || !surface) {
			if (buffer)
				wl_buffer_destroy(buffer);
			if (surface)
				wl_surface_destroy(surface);
			wl_shm_pool_destroy(pool);
			break;
		}
		/* Attach + commit: this is what makes Sommelier NEW_ALLOC the host buffer. */
		wl_surface_attach(surface, buffer, 0, 0);
		wl_surface_damage(surface, 0, 0, WIDTH, HEIGHT);
		wl_surface_commit(surface);
		live[i].surface = surface;
		live[i].pool = pool;
		live[i].buffer = buffer;
		created++;
	}
	wl_display_roundtrip(display);

	long mem_held = read_memfree_kb();

	/* ── RELEASE: destroy everything; Sommelier CLOSEs each vfd ── */
	for (int i = 0; i < created; i++) {
		if (live[i].buffer)
			wl_buffer_destroy(live[i].buffer);
		if (live[i].pool)
			wl_shm_pool_destroy(live[i].pool);
		if (live[i].surface)
			wl_surface_destroy(live[i].surface);
	}
	wl_display_roundtrip(display);

	long mem_released = read_memfree_kb();

	free(live);
	wl_shm_destroy(st.shm);
	wl_compositor_destroy(st.compositor);
	wl_registry_destroy(registry);
	wl_display_disconnect(display);

	if (created != n || mem_start < 0 || mem_held < 0 || mem_released < 0) {
		printf("RESULT wl-pool-churn FAIL created=%d/%d mem=%ld/%ld/%ld\n",
		       created, n, mem_start, mem_held, mem_released);
		return 1;
	}

	/* Deltas in kB. held_drop = how much RAM the N live buffers consumed.
	 * leftover = RAM still gone after releasing them (the leak). */
	long held_drop = mem_start - mem_held;
	long leftover = mem_start - mem_released;
	long expect_kb = (long)n * (POOL_SIZE / 1024); /* N * 4 MiB */
	long half = expect_kb / 2;

	int alloc_ok = held_drop >= half; /* buffers actually allocated (non-trivial) */
	int freed_ok = leftover < half; /* and were freed (no leak) */

	printf("RESULT wl-pool-churn %s pools=%d held_drop=%ldkB leftover=%ldkB expect=%ldkB\n",
	       (alloc_ok && freed_ok) ? "PASS" : "FAIL", n, held_drop, leftover, expect_kb);
	fflush(stdout);
	return (alloc_ok && freed_ok) ? 0 : 1;
}
