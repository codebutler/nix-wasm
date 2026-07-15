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

	/* (5) LARGE FRAGMENTED POINTER-CHASE — the nix-env Config::set "bina" repro.
	 * The full-nix boot faults reading a std::string data-pointer that holds
	 * CONTENT bytes: a stored VIRTUAL pointer that mistranslates to the wrong
	 * physical page AT SCALE. The 8 MiB mmap above is only 2 pgd entries
	 * (PGDIR_SHIFT=22 -> 4 MiB/entry); nix-env's data+heap spans dozens, so a
	 * multi-pgd page-table bug (pte-table alloc / pgd indexing) never shows in
	 * the small smoke. Reproduce it here: map several SEPARATE large regions
	 * (fragmented -> many pgd entries at different bases), thread a per-page
	 * linked list across ALL of them (each node stores a POINTER to the next,
	 * exactly like a data-reloc, plus a position-dependent tag; the rest of each
	 * page is filled with 'b' CONTENT, like a std::string body), then TRAVERSE
	 * it, dereferencing every ->next (exactly like Config::set walking the
	 * settings map). A page that mistranslates reads content-as-pointer/tag.
	 * The traversal reads each node's ->tag BEFORE ever following its ->next, so
	 * a mistranslated page is caught by the tag mismatch (-> clean hang, a real
	 * FAIL + transcript) rather than a wild ->next deref (-> SIGSEGV in PID 1 ->
	 * panic -> "inconclusive", which would hide the signal). 0x62='b', so a
	 * mistranslated ->next would read 0x62626262 — the direct analogue of the
	 * nix-env "bina" (0x616e6962) fault. */
	struct node {
		struct node *next;
		unsigned long tag;
	};
	enum { NREG = 4 };
	const unsigned long RSZ = 32UL * 1024 * 1024; /* 32 MiB * 4 = 128 MiB, ~32 pgd entries */
	struct node *head = 0, *prev = 0;
	unsigned long nodes = 0, tagsum = 0;
	for (int r = 0; r < NREG; r++) {
		unsigned char *rg = mmap(0, RSZ, PROT_READ | PROT_WRITE,
					 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (rg == MAP_FAILED) {
			put(fd, "MMU-A2: chase mmap FAIL\n");
			for (;;)
				pause();
		}
		for (unsigned long off = 0; off + 4096 <= RSZ; off += 4096) {
			struct node *nd = (struct node *)(rg + off);
			unsigned long tag = ((unsigned long)nd ^ 0x9e3779b1UL) + nodes;
			memset((unsigned char *)nd + sizeof(*nd), 'b',
			       4096 - sizeof(*nd));
			nd->tag = tag;
			nd->next = 0;
			if (prev)
				prev->next = nd;
			else
				head = nd;
			prev = nd;
			nodes++;
			tagsum += tag;
		}
	}
	unsigned long seen = 0, chksum = 0, bad = 0;
	for (struct node *nd = head; nd; nd = nd->next) {
		unsigned long want = ((unsigned long)nd ^ 0x9e3779b1UL) + seen;
		if (nd->tag != want) {
			bad = (unsigned long)nd;
			break;
		}
		chksum += nd->tag;
		seen++;
	}
	put(fd, "MMU-A2: chase nodes ");
	put_hex(fd, nodes);
	put(fd, " seen ");
	put_hex(fd, seen);
	put(fd, " sumok ");
	put_hex(fd, chksum == tagsum);
	if (bad) {
		put(fd, " BAD@");
		put_hex(fd, bad);
	}
	put(fd, "\n");
	if (bad || seen != nodes || chksum != tagsum) {
		put(fd, "MMU-A2: chase CORRUPT\n");
		for (;;)
			pause();
	}

	/* (6) LOW-VA .bss pointer-chase — the discriminating control for the nix-env
	 * fault. Section (5) exonerated HIGH-VA (mmap, 0x40000000+) translation. But
	 * nix::Config::set faults reading a pointer field of a _settings std::map
	 * node / string, which lives on the brk heap or .data/.bss — all LOW VA
	 * (contiguous up from data_start), a DIFFERENT VMA and pgd range that the
	 * mmap chase never touched, and the exec-time large-data-segment mapping path
	 * (fs/binfmt_wasm.c) the mmap runtime path doesn't model. A large STATIC .bss
	 * array is exec-mapped at low VA exactly like nix.wasm's data segment; chase
	 * it identically (one node per page, store ->next, then traverse
	 * dereferencing). If (6) CORRUPTS while (5) passed, the bug is LOW-VA /
	 * exec-data translation. If both pass, translation is fully exonerated (high
	 * AND low VA) and the fault is a store-corruption / memory.init-content /
	 * __memory_base / nix-latent issue. */
	static unsigned char bss_region[128u * 1024 * 1024]; /* 128 MiB .bss, LOW VA */
	struct node *bhead = 0, *bprev = 0;
	unsigned long bnodes = 0, btagsum = 0;
	for (unsigned long off = 0; off + 4096 <= sizeof(bss_region); off += 4096) {
		struct node *nd = (struct node *)(bss_region + off);
		unsigned long btag = ((unsigned long)nd ^ 0x9e3779b1UL) + bnodes;
		memset((unsigned char *)nd + sizeof(*nd), 'b', 4096 - sizeof(*nd));
		nd->tag = btag;
		nd->next = 0;
		if (bprev)
			bprev->next = nd;
		else
			bhead = nd;
		bprev = nd;
		bnodes++;
		btagsum += btag;
	}
	unsigned long bseen = 0, bchk = 0, bbad = 0;
	for (struct node *nd = bhead; nd; nd = nd->next) {
		unsigned long want = ((unsigned long)nd ^ 0x9e3779b1UL) + bseen;
		if (nd->tag != want) {
			bbad = (unsigned long)nd;
			break;
		}
		bchk += nd->tag;
		bseen++;
	}
	put(fd, "MMU-A2: bsschase nodes ");
	put_hex(fd, bnodes);
	put(fd, " seen ");
	put_hex(fd, bseen);
	put(fd, " sumok ");
	put_hex(fd, bchk == btagsum);
	if (bbad) {
		put(fd, " BAD@");
		put_hex(fd, bbad);
	}
	put(fd, "\n");
	if (bbad || bseen != bnodes || bchk != btagsum) {
		put(fd, "MMU-A2: bsschase CORRUPT\n");
		for (;;)
			pause();
	}

	put(fd, "MMU-A2: OK\n");
	for (;;)
		pause();
}
