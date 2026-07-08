/* deepfork-exec-init.c — PID-1 for the exec'd+deep fork cell (#131).
 *
 * Forks ONE child; the child execve()s /bin/deepfork-child (which recurses deep,
 * fork()+wait()s at the bottom, and returns all the way up). Parent reaps,
 * expecting WEXITSTATUS==5, then prints "DEEP2: ALL-OK". Mirrors grandfork-init
 * but the exec'd task forks from a DEEP stack instead of a shallow main().
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

	put(fd, "DEEP2: init alive\n");

	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "DEEP2: init fork FAILED\n");
		for (;;)
			pause();
	}
	if (pid == 0) {
		char *const argv[] = { "/bin/deepfork-child", 0 };
		char *const envp[] = { 0 };
		execve("/bin/deepfork-child", argv, envp);
		put(fd, "DEEP2: execve FAILED\n");
		_exit(127);
	}

	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "DEEP2: init reaped exec'd-child status=");
	put_hex(fd, (unsigned long)status);
	put(fd, "\n");
	if (WIFEXITED(status) && WEXITSTATUS(status) == 5)
		put(fd, "DEEP2: ALL-OK\n");
	for (;;)
		pause();
}
