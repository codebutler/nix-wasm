/* exec-child.c — the exec target for the MMU fork+exec+wait smoke (#131/#129).
 *
 * A fork child execve()s this. It runs as a FRESH image in a NEW mm/pgd (exec
 * throws away the forked address space), writes a marker to the console, and
 * exits 7 so the parent's waitpid() sees WEXITSTATUS==7. Built raw (the engine
 * instruments it at load under the MMU kernel). No libc spawn machinery — just
 * open/write/_exit.
 */
#include <fcntl.h>
#include <string.h>
#include <unistd.h>

int main(void)
{
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;
	static const char msg[] = "FORK-EXEC: child exec'd a fresh image, exiting 7\n";
	write(fd, msg, sizeof msg - 1);
	_exit(7);
}
