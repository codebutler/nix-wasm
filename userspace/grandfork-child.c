/* grandfork-child.c — the exec target that ITSELF forks (#131 diagnosis).
 *
 * Isolates the one path the busybox-fork boot exposed and the fork-exec gate
 * never covered: a task that was created by fork()+exec() then calls fork()
 * AGAIN and resumes as the parent. (fork-exec-init only forks from the ORIGINAL
 * PID-1 task; its children exec and never re-fork.) A fork child execve()s this;
 * this then fork()s a GRANDCHILD, the grandchild _exit(9)s, and this (the
 * exec'd parent) waitpid()s, reaps, and _exit(5)s so its own parent sees
 * WEXITSTATUS==5. Built through the asyncify seam so its fork() returns twice.
 */
#include <fcntl.h>
#include <string.h>
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
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	put(fd, "GRANDFORK: exec'd child alive, about to fork a grandchild\n");

	pid_t pid = fork(); /* the SECOND-generation fork — from an exec'd task */
	if (pid < 0) {
		put(fd, "GRANDFORK: fork FAILED\n");
		_exit(127);
	}
	if (pid == 0) {
		put(fd, "GRANDFORK: grandchild alive, exiting 9\n");
		_exit(9);
	}

	/* Exec'd-parent path: must RESUME here after fork() and reap. */
	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "GRANDFORK: exec'd-parent resumed + reaped grandchild status=");
	put_hex(fd, (unsigned long)status);
	put(fd, "\n");
	if (WIFEXITED(status) && WEXITSTATUS(status) == 9)
		put(fd, "GRANDFORK: OK\n");
	_exit(5);
}
