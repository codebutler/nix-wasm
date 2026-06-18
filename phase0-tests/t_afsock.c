#include <stdio.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		printf("RESULT t_afsock FAIL socket=%d errno=%d\n", fd, errno);
		fflush(stdout);
		return 1;
	}
	close(fd);
	printf("RESULT t_afsock PASS\n");
	fflush(stdout);
	return 0;
}
