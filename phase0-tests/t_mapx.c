#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <sys/mman.h>

#define PATH "/tmp/t_mapx.bin"
#define SZ 4096

static void msleep(int ms) { struct timespec ts = { ms / 1000, (long)(ms % 1000) * 1000000L }; nanosleep(&ts, 0); }

int main(int argc, char **argv) {
	if (argc < 2) { printf("RESULT t_mapx FAIL no-role\n"); fflush(stdout); return 1; }

	if (!strcmp(argv[1], "srv")) {
		int fd = open(PATH, O_RDWR | O_CREAT | O_TRUNC, 0600);
		if (fd < 0) { printf("RESULT t_mapx FAIL srv-open errno=%d\n", errno); fflush(stdout); return 1; }
		if (ftruncate(fd, SZ) < 0) { printf("RESULT t_mapx FAIL srv-trunc errno=%d\n", errno); fflush(stdout); return 1; }
		char *m = mmap(NULL, SZ, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
		if (m == MAP_FAILED) { printf("RESULT t_mapx FAIL srv-mmap errno=%d\n", errno); fflush(stdout); return 1; }
		memcpy(m, "PARENT01", 8);
		for (int i = 0; i < 60; i++) {
			if (!memcmp(m + 16, "CHILDOK!", 8)) { printf("RESULT t_mapx PASS\n"); fflush(stdout); return 0; }
			if (!memcmp(m + 16, "CHILDBAD", 8)) { printf("RESULT t_mapx FAIL child-saw-wrong-parent-data\n"); fflush(stdout); return 1; }
			msleep(100);
		}
		printf("RESULT t_mapx FAIL timeout (child write not visible to parent)\n"); fflush(stdout); return 1;
	}

	/* cli */
	int fd = -1;
	for (int i = 0; i < 60 && fd < 0; i++) { fd = open(PATH, O_RDWR); if (fd < 0) msleep(50); }
	if (fd < 0) { printf("t_mapx cli open-fail errno=%d\n", errno); fflush(stdout); return 1; }
	char *m = MAP_FAILED;
	for (int i = 0; i < 60 && m == MAP_FAILED; i++) { m = mmap(NULL, SZ, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0); if (m == MAP_FAILED) msleep(50); }
	if (m == MAP_FAILED) { printf("t_mapx cli mmap-fail errno=%d\n", errno); fflush(stdout); return 1; }
	for (int i = 0; i < 60; i++) { if (!memcmp(m, "PARENT01", 8)) break; msleep(50); }
	memcpy(m + 16, memcmp(m, "PARENT01", 8) == 0 ? "CHILDOK!" : "CHILDBAD", 8);
	return 0;
}
