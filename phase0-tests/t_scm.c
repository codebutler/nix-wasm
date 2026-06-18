#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/socket.h>

int main(int argc, char **argv) {
	int sv[2];
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) { printf("RESULT t_scm FAIL socketpair errno=%d\n", errno); fflush(stdout); return 1; }

	char path[] = "/tmp/t_scm_XXXXXX";
	int fd = mkstemp(path);
	if (fd < 0) { printf("RESULT t_scm FAIL mkstemp errno=%d\n", errno); fflush(stdout); return 1; }
	unlink(path);
	if (write(fd, "SCMOK", 5) != 5) { printf("RESULT t_scm FAIL seedwrite errno=%d\n", errno); fflush(stdout); return 1; }

	char d = 'x';
	struct iovec iov = { .iov_base = &d, .iov_len = 1 };
	char cb[CMSG_SPACE(sizeof(int))]; memset(cb, 0, sizeof cb);
	struct msghdr mh = {0};
	mh.msg_iov = &iov; mh.msg_iovlen = 1; mh.msg_control = cb; mh.msg_controllen = sizeof cb;
	struct cmsghdr *cm = CMSG_FIRSTHDR(&mh);
	cm->cmsg_level = SOL_SOCKET; cm->cmsg_type = SCM_RIGHTS; cm->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(cm), &fd, sizeof(int));
	if (sendmsg(sv[0], &mh, 0) < 0) { printf("RESULT t_scm FAIL sendmsg errno=%d\n", errno); fflush(stdout); return 1; }

	char rd; struct iovec riov = { .iov_base = &rd, .iov_len = 1 };
	char rcb[CMSG_SPACE(sizeof(int))]; memset(rcb, 0, sizeof rcb);
	struct msghdr rmh = {0};
	rmh.msg_iov = &riov; rmh.msg_iovlen = 1; rmh.msg_control = rcb; rmh.msg_controllen = sizeof rcb;
	if (recvmsg(sv[1], &rmh, 0) < 0) { printf("RESULT t_scm FAIL recvmsg errno=%d\n", errno); fflush(stdout); return 1; }
	struct cmsghdr *rcm = CMSG_FIRSTHDR(&rmh);
	if (!rcm || rcm->cmsg_type != SCM_RIGHTS) { printf("RESULT t_scm FAIL no-cmsg\n"); fflush(stdout); return 1; }
	int rfd; memcpy(&rfd, CMSG_DATA(rcm), sizeof(int));
	if (rfd < 0) { printf("RESULT t_scm FAIL rfd=%d\n", rfd); fflush(stdout); return 1; }

	char vbuf[8] = {0};
	if (lseek(rfd, 0, SEEK_SET) < 0) { printf("RESULT t_scm FAIL lseek errno=%d\n", errno); fflush(stdout); return 1; }
	if (read(rfd, vbuf, 5) != 5 || memcmp(vbuf, "SCMOK", 5)) { printf("RESULT t_scm FAIL read buf=%s\n", vbuf); fflush(stdout); return 1; }
	printf("RESULT t_scm PASS\n"); fflush(stdout); return 0;
}
