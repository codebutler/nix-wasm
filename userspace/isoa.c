/*
 * isoa.c — process A of the Task 2.4 cross-process isolation probe (acceptance
 * B1). Allocates one anonymous page, writes a sentinel word into it, and prints
 * the ABSOLUTE linear address it wrote to (kernel-chosen at runtime, NOT a
 * compile-time constant), then pauses so the region stays live while process B
 * reads. See isob.c and runtime/node/task2.4-isolation.test.mjs for the full
 * discrimination argument.
 *
 * The address is reported at runtime (the test captures ISOA_ADDR= from stdout
 * and hands it to B) precisely so the probe tests B reading the SAME absolute
 * address A wrote — which can only be safe-to-PASS if B has its OWN private
 * Memory (Phase-1 guarantee). A shared linear memory would let B observe this
 * sentinel.
 *
 * Single static wasm32-nommu binary, no fork. Baked into the initramfs as
 * /bin/isoa.
 */
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

#define ISO_SENTINEL 0xA11CEU
#define ISO_PAGE 4096

int main(void)
{
	/* Anonymous page; the kernel picks the absolute linear address. */
	void *p = mmap(NULL, ISO_PAGE, PROT_READ | PROT_WRITE,
		       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (p == MAP_FAILED) {
		printf("ISOA_FAIL mmap\n");
		fflush(stdout);
		return 1;
	}

	volatile uint32_t *w = (volatile uint32_t *)p;
	*w = ISO_SENTINEL;

	/* Report the absolute address as a plain hex number for B to read. */
	printf("ISOA_ADDR=0x%lx val=0x%x\n", (unsigned long)(uintptr_t)p, *w);
	fflush(stdout);

	/* Stay alive so A's region coexists with B's read (a shared model could
	 * not then hide the overlap). The test reaps us at the end. */
	for (;;)
		pause();
	return 0;
}
