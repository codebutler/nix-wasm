/* deepfork-sig-child.c — #131: the MINIMAL REPRODUCTION of the busybox
 * shell-fork failure (task #5). Identical to deepfork-child.c (exec'd task,
 * DEPTH-deep recursion, fork()+wait() at the bottom, return all the way up)
 * PLUS the one ingredient hush/ash add: a SIGCHLD HANDLER (busybox hush's
 * CONFIG_HUSH_FAST installs one to count dead children) and the sigprocmask
 * block/unblock dance around the fork.
 *
 * Without the handler (deepfork-child.c) this passes deterministically. With
 * it, the parent dies racily (SIGSEGV, or a mis-rewound continuation) between
 * the fork unwind and the post-waitpid write — the busybox signature. The
 * suspected mechanism: SIGCHLD delivery lands on a software-MMU fault-syscall
 * boundary while the parent's asyncify state is UNWINDING/REWINDING (the fork
 * stack-image writes to BSS COW-fault into the kernel mid-unwind/rewind), and
 * the handler's whole-module-asyncify-instrumented prologue consumes/corrupts
 * the in-flight fork continuation. A mid-translate fault is NOT an
 * architectural between-instructions signal-delivery point.
 *
 * PASS = "DEEP3: CHILD-ALL-OK" printed (deep fork+wait+resume survived signal
 * delivery). This is the regression gate for the kernel-side fix (signal
 * delivery suppressed on the NR_MMU_FAULT syscall exit path).
 */
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef DEPTH
#define DEPTH 256
#endif

static volatile int g_sigchld;
static void on_sigchld(int sig) { (void)sig; g_sigchld++; }

static void put(int fd, const char *s) { write(fd, s, strlen(s)); }
static void put_hex(int fd, unsigned long v) {
	put(fd, "0x");
	for (int i = 7; i >= 0; i--) {
		unsigned d = (v >> (4 * i)) & 0xf;
		char c = d < 10 ? (char)('0' + d) : (char)('a' + d - 10);
		write(fd, &c, 1);
	}
}

static __attribute__((noinline)) long deep(int n, int fd) {
	volatile char pad[48];
	pad[0] = (char)n;
	pad[47] = (char)(n >> 8);
	if (n > 0) {
		long r = deep(n - 1, fd);
		return r + n + pad[0] + pad[47];
	}

	/* Mirror hush: block SIGCHLD, fork, unblock — so the child-exit SIGCHLD
	 * is delivered to the parent's handler somewhere around waitpid. */
	sigset_t chld, prev;
	sigemptyset(&chld);
	sigaddset(&chld, SIGCHLD);
	sigprocmask(SIG_BLOCK, &chld, &prev);
	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "DEEP3: fork FAILED\n");
		_exit(127);
	}
	if (pid == 0) {
		sigprocmask(SIG_SETMASK, &prev, 0);
		_exit(7);
	}
	sigprocmask(SIG_SETMASK, &prev, 0); /* unblock: handler may fire now */
	int status = 0;
	waitpid(pid, &status, 0);
	put(fd, "DEEP3: bottom fork+wait done, status=");
	put_hex(fd, (unsigned long)status);
	put(fd, " sigchld=");
	put_hex(fd, (unsigned long)g_sigchld);
	put(fd, "\n");
	return 0;
}

int main(void)
{
	int fd = open("/dev/console", O_RDWR);
	if (fd < 0)
		fd = open("/dev/hvc0", O_RDWR);
	if (fd < 0)
		fd = 1;

	signal(SIGCHLD, on_sigchld); /* the busybox ingredient (HUSH_FAST) */

	put(fd, "DEEP3: exec'd child alive, depth=");
	put_hex(fd, DEPTH);
	put(fd, "\n");

	volatile long r = deep(DEPTH, fd);

	put(fd, "DEEP3: exec'd-child returned to top r=");
	put_hex(fd, (unsigned long)r);
	put(fd, " sigchld=");
	put_hex(fd, (unsigned long)g_sigchld);
	put(fd, "\n");
	put(fd, "DEEP3: CHILD-ALL-OK\n");
	_exit(5);
}
