#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
	int sv[2];
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) { printf("RESULT t_afunix FAIL socketpair errno=%d\n", errno); fflush(stdout); return 1; }
	if (write(sv[0], "ping", 4) != 4) { printf("RESULT t_afunix FAIL write errno=%d\n", errno); fflush(stdout); return 1; }
	char buf[8] = {0};
	if (read(sv[1], buf, sizeof buf) != 4 || memcmp(buf, "ping", 4)) { printf("RESULT t_afunix FAIL read buf=%s\n", buf); fflush(stdout); return 1; }
	if (write(sv[1], "pong", 4) != 4) { printf("RESULT t_afunix FAIL write2 errno=%d\n", errno); fflush(stdout); return 1; }
	memset(buf, 0, sizeof buf);
	if (read(sv[0], buf, sizeof buf) != 4 || memcmp(buf, "pong", 4)) { printf("RESULT t_afunix FAIL read2 buf=%s\n", buf); fflush(stdout); return 1; }
	printf("RESULT t_afunix PASS\n"); fflush(stdout); return 0;
}
