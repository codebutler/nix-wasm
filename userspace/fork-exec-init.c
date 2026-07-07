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

	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "FORK-EXEC: fork FAILED ");
		put_hex(fd, (unsigned long)-pid);
		put(fd, "\n");
		for (;;)
			pause();
	}
	if (pid == 0) {
		/* Child: exec a fresh image (throws away the forked address space). */
		char *const argv[] = { "/bin/exec-child", 0 };
		char *const envp[] = { 0 };
		execve("/bin/exec-child", argv, envp);
		put(fd, "FORK-EXEC: execve FAILED\n");
		_exit(127);
	}

	/* Parent: block in waitpid, reap the child (which exec'd then exited 7). */
	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "FORK-EXEC: parent reaped pid=");
	put_hex(fd, (unsigned long)pid);
	put(fd, " status=");
	put_hex(fd, WIFEXITED(status) ? (unsigned long)WEXITSTATUS(status) : 0xdeadUL);
	put(fd, "\n");

	put(fd, "FORK-EXEC: OK\n");
	for (;;)
		pause();
}
