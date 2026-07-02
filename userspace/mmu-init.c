/* mmu-init.c — the MINIMAL PID-1 for the software-MMU smoke (#128 mmu-smoke).
 *
 * Runs as /init of a single-file initramfs under a CONFIG_MMU=y kernel, after
 * the softmmu pass has instrumented it (every load/store/atomic/bulk op walks
 * the per-process page table). Proves the whole A1 identity chain: MMU exec
 * (kernel binary buffer -> engine instantiation with pt_base), the software
 * uaccess walk (the write() payloads cross the boundary through it), VM_LOCKED
 * population, and translated user execution (the checksum loop + libc).
 *
 * PID 1 starts with no open fds: open the console first (devtmpfs is mounted
 * by the kernel when /dev exists in the cpio; fall back to /dev/hvc0).
 */
#include <fcntl.h>
#include <string.h>
#include <sys/mount.h>
#include <unistd.h>

static void put(int fd, const char *s) { write(fd, s, strlen(s)); }

static void put_hex(int fd, unsigned long v) {
	/* one byte per write — no local array initializer / no function-local
	 * static (both are fragile codegen under instrumentation; the strings
	 * + checksum loop already prove translated access, this keeps the
	 * DISPLAY of the value robust so the host can assert the exact hex). */
	put(fd, "0x");
	for (int i = 7; i >= 0; i--) {
		unsigned d = (v >> (4 * i)) & 0xf;
		char c = d < 10 ? (char)('0' + d) : (char)('a' + d - 10);
		write(fd, &c, 1);
	}
}

static volatile unsigned buf[16384]; /* 64 KiB of bss — spans 16 pages */

int main(void)
{
	/* initramfs does not automount devtmpfs — PID 1 does it (the normal
	 * boot's /init shell script does the same; ignore failure and fall
	 * back in case it raced or /dev is missing from the cpio). */
	mount("devtmpfs", "/dev", "devtmpfs", 0, "");

	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1; /* last resort */

	put(fd, "MMU-SMOKE: instrumented init is alive\n");

	/* Page-spanning translated stores + loads, then a checksum the host
	 * asserts (deterministic; wrong translation scrambles it). */
	for (unsigned i = 0; i < 16384; i++)
		buf[i] = i * 2654435761u;
	unsigned long sum = 0;
	for (unsigned i = 0; i < 16384; i++)
		sum += buf[i];
	put(fd, "MMU-SMOKE: checksum ");
	put_hex(fd, sum);
	put(fd, "\n");

	/* memcpy/memset large enough to lower to memory.copy/memory.fill —
	 * the bulk-op translate helpers in action. */
	static unsigned char a[8192], b[8192];
	memset(a, 0x5a, sizeof(a));
	memcpy(b, a, sizeof(b));
	put(fd, b[0] == 0x5a && b[8191] == 0x5a ? "MMU-SMOKE: bulk OK\n"
					       : "MMU-SMOKE: bulk FAIL\n");

	put(fd, "MMU-SMOKE: OK\n");
	for (;;)
		pause();
}
