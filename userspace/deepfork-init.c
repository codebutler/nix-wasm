/* deepfork-init.c — #131 diagnosis: does fork()+wait() from a DEEP call stack
 * resume correctly all the way back UP?
 *
 * The busybox shell forks from deep inside hush (run_pipe -> ... -> fork);
 * grandfork-child forks from a shallow main() and PASSES. This isolates the one
 * remaining variable: stack DEPTH at the fork point. PID1 recurses DEPTH frames
 * deep (each frame kept live — it consumes the callee's result and touches a
 * volatile stack pad so the optimizer can't tail-call/elide it), fork()+wait()s
 * at the bottom, then returns ALL THE WAY back up through every frame and prints
 * a witness from main(). If "DEEP: ALL-OK" prints, a deep-stack fork+wait+resume
 * works; if only "DEEP: bottom" prints, the parent mis-rewinds the deep stack.
 *
 * Built through the asyncify seam (forkSeam=true) so fork() returns twice.
 */
#include <fcntl.h>
#include <string.h>
#include <sys/mount.h>
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

/* Recurse n frames deep, fork+wait at the bottom, return a checksum back up.
 * `pad` + the use of `r` keep each frame genuinely live across the recursive
 * call (no tail-call, no inlining) so the deep stack really exists at fork time. */
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
		put(fd, "DEEP: fork FAILED\n");
		_exit(127);
	}
	if (pid == 0)
		_exit(7);
	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "DEEP: bottom fork+wait done, status=");
	put_hex(fd, (unsigned long)status);
	put(fd, "\n");
	return 0;
}

int main(void)
{
	mount("devtmpfs", "/dev", "devtmpfs", 0, "");
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	put(fd, "DEEP: init alive, depth=");
	put_hex(fd, DEPTH);
	put(fd, "\n");

	volatile long r = deep(DEPTH, fd);

	put(fd, "DEEP: returned to main r=");
	put_hex(fd, (unsigned long)r);
	put(fd, "\n");
	put(fd, "DEEP: ALL-OK\n");
	for (;;)
		pause();
}
