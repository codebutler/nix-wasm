/* grandfork-init.c — PID-1 for the second-generation-fork diagnosis (#131).
 *
 * Forks ONE child; the child execve()s /bin/grandfork-child (which itself forks
 * a grandchild and waits). Parent reaps the child, expecting WEXITSTATUS==5.
 * Proves the full three-generation chain: PID1 fork → exec → the exec'd task
 * fork → wait. Built through the asyncify seam.
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

	put(fd, "GRANDFORK: init alive\n");

	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "GRANDFORK: init fork FAILED\n");
		for (;;)
			pause();
	}
	if (pid == 0) {
		char *const argv[] = { "/bin/grandfork-child", 0 };
		char *const envp[] = { 0 };
		execve("/bin/grandfork-child", argv, envp);
		put(fd, "GRANDFORK: execve FAILED\n");
		_exit(127);
	}

	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "GRANDFORK: init reaped exec'd-child status=");
	put_hex(fd, (unsigned long)status);
	put(fd, "\n");
	if (WIFEXITED(status) && WEXITSTATUS(status) == 5)
		put(fd, "GRANDFORK: ALL-OK\n");
	for (;;)
		pause();
}
