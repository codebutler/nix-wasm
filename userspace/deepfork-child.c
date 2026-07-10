/* deepfork-child.c — #131 diagnosis: the EXEC'd + DEEP fork cell (PASSES).
 *
 * The matrix: primary+deep (deepfork-init) PASSES, exec'd+shallow (grandfork-
 * child) PASSES, exec'd+deep (THIS) PASSES too — yet the busybox shell (exec'd +
 * deep fork + blocking wait) FAILS. So the generic fork+wait+deep-rewind
 * mechanism is sound at every depth in both primary and exec'd tasks; the
 * busybox failure is something busybox-specific in its fork+WAIT path (a plain
 * `cmd &` background fork WITHOUT wait succeeds even from hush's deep stack).
 * This binary is kept as regression coverage documenting that negative space.
 *
 * An init fork()s a child that execve()s THIS; it then recurses DEPTH deep,
 * fork()+wait()s at the bottom, and returns all the way back up to print
 * "DEEP2: CHILD-ALL-OK". Built through the asyncify seam so fork() returns twice.
 */
#include <fcntl.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef DEPTH
#define DEPTH 256
#endif

static void put(int fd, const char *s) { write(fd, s, strlen(s)); }
static void put_hex(int fd, unsigned long v) {
	put(fd, "0x");
	for (int i = 7; i >= 0; i--) {
		unsigned d = (v >> (4 * i)) & 0xf;
		char c = d < 10 ? (char)('0' + d) : (char)('a' + d - 10);
		write(fd, &c, 1);
	}
}

static __attribute__((noinline)) long deep(int n, int fd) {
	volatile char pad[48];
	pad[0] = (char)n;
	pad[47] = (char)(n >> 8);
	if (n > 0) {
		long r = deep(n - 1, fd);
		return r + n + pad[0] + pad[47];
	}
	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "DEEP2: fork FAILED\n");
		_exit(127);
	}
	if (pid == 0)
		_exit(7);
	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "DEEP2: bottom fork+wait done, status=");
	put_hex(fd, (unsigned long)status);
	put(fd, "\n");
	return 0;
}

int main(void)
{
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	put(fd, "DEEP2: exec'd child alive, depth=");
	put_hex(fd, DEPTH);
	put(fd, "\n");

	volatile long r = deep(DEPTH, fd);

	put(fd, "DEEP2: exec'd-child returned to top r=");
	put_hex(fd, (unsigned long)r);
	put(fd, "\n");
	put(fd, "DEEP2: CHILD-ALL-OK\n");
	_exit(5);
}
