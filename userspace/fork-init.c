/* fork-init.c — the REAL-FORK PID-1 for the MMU fork smoke (#129 Track B).
 *
 * Runs as init under the A2 software-MMU kernel (.#kernel-mmu-a2 + patch 0026),
 * built through the asyncify seam (userspace/asyncify-cc.nix, forkSeam=true →
 * muslFork's 0010 _Fork → capture_stack) and instrumented CHECKED by the smoke
 * (runtime/demo/node/fork-smoke.mjs). Proves the FULL MMU-native fork:
 *   fork() → musl 0010 _Fork → capture_stack (asyncify unwind) → the engine
 *   drives wasm_fork_current (kernel_clone → generic COW dup_mmap) → the child
 *   task spawns with fork_ctl and REWINDS in its worker (fork()==0) on the SAME
 *   shared arena with its OWN pt_base → the parent rewinds with the child pid →
 *   both sides' post-fork writes COW → the parent waitpid()s and reaps the
 *   child's exit(7).
 *
 * PROVES (all boot-verified by fork-smoke.mjs):
 *   - RETURNS TWICE: a CHILD line (fork()==0) AND a PARENT line (fork()>0);
 *   - COW ISOLATION: the private `witness` at ONE virtual address diverges —
 *     child 0x10c, parent 0x1b0 — so each side's page table COW'd that page to
 *     an independent physical frame (the #128 A2 write-protect fault path);
 *   - REAP: the parent BLOCKS in waitpid() and is correctly woken + reaps the
 *     child, seeing WEXITSTATUS==7. (This exercises the pt_base-restore-on-
 *     resume fix: a blocked task's instance root, clobbered by switch_mm while
 *     it was scheduled out, is restored on resume — without it the woken parent
 *     fault-looped on its own stack against a foreign page table.)
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

	put(fd, "FORK-MMU: init alive\n");

	volatile int witness = 0x100; /* one VA, two post-fork values (COW) */

	pid_t pid = fork();
	if (pid < 0) {
		put(fd, "FORK-MMU: fork FAILED ");
		put_hex(fd, (unsigned long)-pid);
		put(fd, "\n");
		for (;;)
			pause();
	}
	if (pid == 0) {
		/* Child: fork() returned 0; mutate the PRIVATE witness (COW), exit 7. */
		witness += 0x0c;
		put(fd, "FORK-MMU: child ret=");
		put_hex(fd, 0);
		put(fd, " witness=");
		put_hex(fd, (unsigned long)witness);
		put(fd, "\n");
		_exit(7);
	}

	/* Parent: BLOCK in waitpid and reap the child, mutate the independent
	 * witness (COW), report the reaped exit status. */
	int status = 0;
	waitpid(pid, &status, 0);
	witness += 0xb0;
	put(fd, "FORK-MMU: parent pid=");
	put_hex(fd, (unsigned long)pid);
	put(fd, " witness=");
	put_hex(fd, (unsigned long)witness);
	put(fd, " status=");
	put_hex(fd, WIFEXITED(status) ? (unsigned long)WEXITSTATUS(status) : 0xdeadUL);
	put(fd, "\n");

	put(fd, "FORK-MMU: OK\n");
	for (;;)
		pause();
}
