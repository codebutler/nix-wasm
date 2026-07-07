/* fork-exec-init.c — fork + EXEC + wait PID-1 for the MMU smoke (#131/#129).
 *
 * The capstone primitive every real multi-process system needs, and exactly
 * what busybox init does: fork(), the CHILD execve()s a program (a fresh
 * image in a new mm/pgd), the PARENT blocks in waitpid() and reaps the child's
 * exit. Built through the asyncify seam (asyncify-cc, forkSeam) so fork()
 * returns twice; the engine instruments both this and the exec target at load
 * under the MMU kernel (.#kernel-mmu-a2 + patch 0026).
 *
 * Proves, on the software MMU: fork (returns twice) → exec (the child discards
 * the COW'd address space for a fresh one) → wait (the parent reaps across the
 * child's exec+exit). Prints:
 *   FORK-EXEC: init alive
 *   FORK-EXEC: child exec'd a fresh image, exiting 7   (from exec-child)
 *   FORK-EXEC: parent reaped pid=0x.. status=0x7
 *   FORK-EXEC: OK
 */
#include <fcntl.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/wait.h>
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

int main(void)
{
	mount("devtmpfs", "/dev", "devtmpfs", 0, "");
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	put(fd, "FORK-EXEC: init alive\n");

	/* Spawn N children CONCURRENTLY (fork all, then reap all) — the pattern a
	 * real init uses. This stresses N live user tasks each with its OWN page
	 * table, the pt_base-restore across many context switches, and N reaps.
	 * Each child execs a fresh image (exec-child, exit 7). */
	enum { N = 3 };
	pid_t kids[N];
	for (int i = 0; i < N; i++) {
		pid_t pid = fork();
		if (pid < 0) {
			put(fd, "FORK-EXEC: fork FAILED ");
			put_hex(fd, (unsigned long)-pid);
			put(fd, "\n");
			for (;;)
				pause();
		}
		if (pid == 0) {
			char *const argv[] = { "/bin/exec-child", 0 };
			char *const envp[] = { 0 };
			execve("/bin/exec-child", argv, envp);
			put(fd, "FORK-EXEC: execve FAILED\n");
			_exit(127);
		}
		kids[i] = pid;
	}

	/* Parent: reap all N, count the successful exit(7)s. */
	int reaped = 0;
	for (int i = 0; i < N; i++) {
		int status = 0;
		waitpid(kids[i], &status, 0);
		if (WIFEXITED(status) && WEXITSTATUS(status) == 7)
			reaped++;
	}
	put(fd, "FORK-EXEC: parent reaped ");
	put_hex(fd, (unsigned long)reaped);
	put(fd, " of ");
	put_hex(fd, (unsigned long)N);
	put(fd, " children status=0x00000007\n");

	put(fd, "FORK-EXEC: OK\n");
	for (;;)
		pause();
}
