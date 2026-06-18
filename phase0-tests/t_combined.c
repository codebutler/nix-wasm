#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/mman.h>

int main(int argc, char **argv) {
	int sv[2];
	if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) { printf("RESULT t_combined FAIL socketpair errno=%d\n", errno); fflush(stdout); return 1; }

	size_t sz = 64 * 64 * 4; /* a 64x64 XRGB frame */
	char path[] = "/tmp/t_pool_XXXXXX";
	int fd = mkstemp(path);
	if (fd < 0) { printf("RESULT t_combined FAIL mkstemp errno=%d\n", errno); fflush(stdout); return 1; }
	unlink(path);
	if (ftruncate(fd, sz) < 0) { printf("RESULT t_combined FAIL ftruncate errno=%d\n", errno); fflush(stdout); return 1; }
	unsigned *px = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (px == MAP_FAILED) { printf("RESULT t_combined FAIL mmap errno=%d\n", errno); fflush(stdout); return 1; }
	for (size_t i = 0; i < sz / 4; i++) px[i] = 0xFF00FF00u ^ (unsigned)i;

	char d = 'p'; struct iovec iov = { .iov_base = &d, .iov_len = 1 };
	char cb[CMSG_SPACE(sizeof(int))]; memset(cb, 0, sizeof cb);
	struct msghdr mh = {0};
	mh.msg_iov = &iov; mh.msg_iovlen = 1; mh.msg_control = cb; mh.msg_controllen = sizeof cb;
	struct cmsghdr *cm = CMSG_FIRSTHDR(&mh);
	cm->cmsg_level = SOL_SOCKET; cm->cmsg_type = SCM_RIGHTS; cm->cmsg_len = CMSG_LEN(sizeof(int));
	memcpy(CMSG_DATA(cm), &fd, sizeof(int));
	if (sendmsg(sv[0], &mh, 0) < 0) { printf("RESULT t_combined FAIL sendmsg errno=%d\n", errno); fflush(stdout); return 1; }

	char rd; struct iovec riov = { .iov_base = &rd, .iov_len = 1 };
	char rcb[CMSG_SPACE(sizeof(int))]; memset(rcb, 0, sizeof rcb);
	struct msghdr rmh = {0};
	rmh.msg_iov = &riov; rmh.msg_iovlen = 1; rmh.msg_control = rcb; rmh.msg_controllen = sizeof rcb;
	if (recvmsg(sv[1], &rmh, 0) < 0) { printf("RESULT t_combined FAIL recvmsg errno=%d\n", errno); fflush(stdout); return 1; }
	struct cmsghdr *rcm = CMSG_FIRSTHDR(&rmh);
	if (!rcm || rcm->cmsg_type != SCM_RIGHTS) { printf("RESULT t_combined FAIL no-cmsg\n"); fflush(stdout); return 1; }
	int rfd; memcpy(&rfd, CMSG_DATA(rcm), sizeof(int));
	unsigned *rpx = mmap(NULL, sz, PROT_READ, MAP_SHARED, rfd, 0);
	if (rpx == MAP_FAILED) { printf("RESULT t_combined FAIL comp-mmap errno=%d\n", errno); fflush(stdout); return 1; }
	for (size_t i = 0; i < sz / 4; i++) {
		if (rpx[i] != (0xFF00FF00u ^ (unsigned)i)) { printf("RESULT t_combined FAIL pixel-mismatch@%zu\n", i); fflush(stdout); return 1; }
	}
	printf("RESULT t_combined PASS\n"); fflush(stdout); return 0;
}
