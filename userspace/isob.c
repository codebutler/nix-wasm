/*
 * isob.c — process B of the Task 2.4 cross-process isolation probe (acceptance
 * B1). Given A's runtime-reported absolute linear address as argv[1], B reads
 * the word at that EXACT absolute address in ITS OWN address space.
 *
 *   * Correct per-process model (Phase 1): B's Memory is a DISTINCT
 *     WebAssembly.Memory from A's. That absolute linear offset in B's OWN memory
 *     holds B's own bytes (its loaded image / fresh zero pages) — NOT A's
 *     sentinel → "ISOLATION PASS".
 *   * Hypothetical shared-Memory model (what B1 forbids): A's absolute address is
 *     a live offset in the ONE shared linear memory still holding A's sentinel
 *     (A is alive), so B reads 0xA11CE → "ISOLATION LEAK".
 *
 * The address is communicated A→B at RUNTIME (the test captures A's stdout), so
 * this is a genuine same-absolute-address read, not a compile-time constant —
 * which is exactly what makes it discriminate: it WOULD read A's sentinel if the
 * two processes shared one linear memory.
 *
 * Why the read is in-bounds in B without aliasing A: the wasm linear Memory is
 * base-0 and contiguous; a read only traps if the offset is past B's current
 * Memory size. We therefore first mmap a region covering A's address (forcing
 * B's private Memory to grow to at least that size), then read the absolute
 * offset directly — reading B's OWN memory there, never A's. We do NOT MAP_FIXED
 * over A's address: A's per-process offset is small and overlaps B's own loaded
 * segments, where MAP_FIXED is rejected; a fault would itself prove isolation but
 * we keep the read clean and deterministic.
 *
 * Single static wasm32-nommu binary, no fork. Baked into the initramfs as
 * /bin/isob.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>

#define ISO_SENTINEL 0xA11CEU

int main(int argc, char **argv)
{
	if (argc < 2) {
		printf("ISOB_FAIL usage: isob <addr>\n");
		fflush(stdout);
		return 2;
	}

	unsigned long addr = strtoul(argv[1], NULL, 0);

	/* Grow B's OWN private Memory to cover A's absolute address so the direct
	 * read below is in-bounds. The mapping lands wherever the allocator puts it
	 * (NOT at A's address) — its only job is to extend B's linear memory size. */
	size_t need = (size_t)addr + 0x10000;
	void *grow = mmap(NULL, need, PROT_READ | PROT_WRITE,
			  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (grow == MAP_FAILED) {
		printf("ISOB_FAIL mmap need=0x%zx\n", need);
		fflush(stdout);
		return 1;
	}

	/* Read the EXACT absolute address A reported, in B's own address space. */
	volatile uint32_t *w = (volatile uint32_t *)(uintptr_t)addr;
	uint32_t got = *w;

	if (got == ISO_SENTINEL)
		printf("ISOLATION LEAK addr=0x%lx got=0x%x\n", addr, got);
	else
		printf("ISOLATION PASS addr=0x%lx got=0x%x\n", addr, got);
	fflush(stdout);
	return 0;
}
