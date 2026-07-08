/* mmu-init-a2.c — the A2 DEMAND-PAGING PID-1 for the software MMU (#128).
 *
 * Unlike mmu-init.c (A1: every page populated at exec, no faults), this runs
 * under the A2 kernel (VM_LOCKED + full-stack-populate DROPPED) with the
 * softmmu pass in CHECKED mode: every access present-checks its PTE and, on a
 * miss, issues __wasm_syscall_2(NR_arch_specific_syscall=244, ea, kind) which
 * the kernel routes to do_page_fault -> handle_mm_fault (demand paging), then
 * the pass re-walks. So THIS binary forces real runtime faults:
 *   - a large anonymous mmap whose pages are demand-zero (untouched -> not
 *     present -> checked translate faults them in on first write/read),
 *   - deep recursion growing the stack beyond the initial VMA.
 * Correct demand paging => the checksum matches; a broken fault path =>
 * corruption or panic.
 */
#include <fcntl.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <unistd.h>

static void put(int fd, const char *s) { write(fd, s, strlen(s)); }
static void put_hex(int fd, unsigned long v) {
	put(fd, "0x");
	for (int i = 7; i >= 0; i--) {
		unsigned d = (v >> (4 * i)) & 0xf;
		char c = d < 10 ? (char)('0' + d) : (char)('a' + d - 10);
		write(fd, &c, 1);
	}
}

/* Recurse to grow the stack well beyond the initial VMA; each frame writes a
 * chunk so the pages are actually touched (faulted in). Returns a checksum. */
static unsigned long deep(int depth, unsigned acc) {
	volatile unsigned frame[256]; /* ~1KB/frame -> 4096 frames ~ 4MB+ */
	for (int i = 0; i < 256; i++)
		frame[i] = acc + depth + i;
	if (depth <= 0)
		return acc;
	acc = frame[depth & 255];
	return deep(depth - 1, acc + 1);
}

int main(void)
{
	mount("devtmpfs", "/dev", "devtmpfs", 0, "");
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	put(fd, "MMU-A2: checked init alive\n");

	/* (1) large demand-zero mmap — 8 MiB, pages NOT present until touched. */
	const unsigned long N = 8UL * 1024 * 1024;
	unsigned char *m = mmap(0, N, PROT_READ | PROT_WRITE,
				MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (m == MAP_FAILED) {
		put(fd, "MMU-A2: mmap FAIL\n");
		for (;;)
			pause();
	}
	/* Write one byte per page (each first-touch faults via the checked
	 * translate), then read them back and checksum. */
	for (unsigned long i = 0; i < N; i += 4096)
		m[i] = (unsigned char)((i >> 12) & 0xff);
	unsigned long sum = 0;
	for (unsigned long i = 0; i < N; i += 4096)
		sum += m[i];
	put(fd, "MMU-A2: mmap checksum ");
	put_hex(fd, sum);
	put(fd, "\n");

	/* (2) deep stack growth beyond the initial VMA. */
	unsigned long ds = deep(4096, 0);
	put(fd, "MMU-A2: stack-grow ");
	put_hex(fd, ds & 0xffffffff);
	put(fd, "\n");

	/* (3) COPY-ON-WRITE via the shared zero page. A first READ of a fresh
	 * anonymous MAP_PRIVATE page maps the shared zeropage READ-ONLY (present,
	 * no write bit). The subsequent WRITE must fault (the checked translate's
	 * store-permission check: present|write) into do_wp_page, which duplicates
	 * the page into a private writable one — NOT walk straight through to the
	 * shared zeropage (which would corrupt it system-wide). Proof: the read
	 * sees 0, the post-write read sees the sentinel. */
	unsigned char *c = mmap(0, 4096, PROT_READ | PROT_WRITE,
				MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (c == MAP_FAILED) {
		put(fd, "MMU-A2: cow mmap FAIL\n");
		for (;;)
			pause();
	}
	unsigned roRead = c[16]; /* first touch is a READ -> zeropage, RO */
	c[16] = 0xab; /* WRITE -> write-protect fault -> COW duplicate */
	unsigned wrRead = c[16];
	put(fd, "MMU-A2: cow ro-read ");
	put_hex(fd, roRead);
	put(fd, " wr-read ");
	put_hex(fd, wrRead);
	put(fd, "\n");

	/* (4) mprotect round-trip: narrow a writable page to PROT_READ (the kernel
	 * write-protects its PTE), read it back (a load needs only present), then
	 * widen back to PROT_READ|PROT_WRITE and write again. Each write after a
	 * re-widen resolves through the fault path; a broken protection update
	 * would loop or corrupt. */
	unsigned char *p = mmap(0, 4096, PROT_READ | PROT_WRITE,
				MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	unsigned mp_ok = 0;
	if (p != MAP_FAILED) {
		p[32] = 0x11;
		if (mprotect(p, 4096, PROT_READ) == 0 && p[32] == 0x11 &&
		    mprotect(p, 4096, PROT_READ | PROT_WRITE) == 0) {
			p[32] = 0x22;
			mp_ok = (p[32] == 0x22);
		}
	}
	put(fd, "MMU-A2: mprotect ");
	put_hex(fd, mp_ok);
	put(fd, "\n");

	put(fd, "MMU-A2: OK\n");
	for (;;)
		pause();
}
