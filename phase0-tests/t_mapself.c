#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/mman.h>

int main(int argc, char **argv) {
	char path[] = "/tmp/t_map_XXXXXX";
	int fd = mkstemp(path);
	if (fd < 0) { printf("RESULT t_mapself FAIL mkstemp errno=%d\n", errno); fflush(stdout); return 1; }
	unlink(path);
	size_t sz = 4096;
	if (ftruncate(fd, sz) < 0) { printf("RESULT t_mapself FAIL ftruncate errno=%d\n", errno); fflush(stdout); return 1; }

	char *a = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (a == MAP_FAILED) { printf("RESULT t_mapself FAIL mmap-a errno=%d\n", errno); fflush(stdout); return 1; }
	char *b = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (b == MAP_FAILED) { printf("RESULT t_mapself FAIL mmap-b errno=%d\n", errno); fflush(stdout); return 1; }
	/* On NOMMU, MAP_SHARED of the same file/offset/size returns the same
	 * physical address — that IS correct coherent sharing (one backing
	 * region, same pointer).  On MMU, two distinct virtual addresses
	 * alias the same physical pages.  Accept both; either way the write
	 * through one mapping must be visible through the other. */
	if (a == b) {
		/* NOMMU same-address case: trivially coherent — verify writes */
		memcpy(a, "SHARED42", 8);
		if (memcmp(b, "SHARED42", 8) != 0) { printf("RESULT t_mapself FAIL not-coherent b=%.8s\n", b); fflush(stdout); return 1; }
		printf("RESULT t_mapself PASS (nommu-same-addr)\n"); fflush(stdout); return 0;
	}

	memcpy(a, "SHARED42", 8);
	if (memcmp(b, "SHARED42", 8) != 0) { printf("RESULT t_mapself FAIL not-coherent b=%.8s\n", b); fflush(stdout); return 1; }
	memcpy(b, "REVERSE7", 8);
	if (memcmp(a, "REVERSE7", 8) != 0) { printf("RESULT t_mapself FAIL not-coherent-rev a=%.8s\n", a); fflush(stdout); return 1; }
	printf("RESULT t_mapself PASS\n"); fflush(stdout); return 0;
}
