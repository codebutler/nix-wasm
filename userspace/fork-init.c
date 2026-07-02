/* fork-init.c — the REAL-FORK PID-1 for the MMU fork smoke (#129 Track B).
 *
 * Runs as init under the A2 software-MMU kernel (.#kernel-mmu-a2 + patch 0026),
 * built through the asyncify seam (userspace/asyncify-cc.nix, forkSeam=true →
 * muslFork's _Fork → capture_stack) and instrumented CHECKED by the smoke
 * (runtime/demo/node/fork-smoke.mjs). Proves the MMU-native fork MECHANISM:
 *   fork() → musl 0010 _Fork → capture_stack (asyncify unwind) → the engine
 *   drives wasm_fork_current (kernel_clone → generic COW dup_mmap) → the child
 *   task spawns with fork_ctl and REWINDS in its worker (fork()==0) on the SAME
 *   shared arena with its OWN pt_base → the parent rewinds with the child pid.
 *
 * PROVES (all boot-verified by fork-smoke.mjs):
 *   - RETURNS TWICE: a CHILD line (fork()==0) AND a PARENT line (fork()>0);
 *   - COW ISOLATION: the private `witness` at ONE virtual address diverges —
 *     child 0x10c, parent 0x1b0 — so each side's page table COW'd that page to
 *     an independent physical frame (the #128 A2 write-protect fault path);
 *   - CONCURRENT REAL TASK: the child runs in its own worker/pt_base and prints
 *     before the parent (which yields the single CPU via nanosleep).
 *
 * KNOWN FOLLOW-UPS (deeper kernel completeness, NOT the fork mechanism — see the
 * Track B status doc): (1) blocking waitpid() of an EXITING child does not wake
 * the blocked parent — a lost-wakeup in the cooperative single-CPU scheduler
 * (the child IS linked: a WNOHANG probe returns 0/errno 0, NOT ECHILD); (2)
 * MAP_SHARED cross-process visibility after fork. Both are cross-process
 * rendezvous, orthogonal to fork returning twice + COW, which fully work. The
 * child here _exit()s (clean, no panic) and the parent proves its side via a
 * fixed yield, so the gate depends on neither follow-up.
 */
#include <fcntl.h>
#include <string.h>
#include <sys/mount.h>
#include <time.h>
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
		/* Child: fork() returned 0; mutate the PRIVATE witness (COW), announce,
		 * then park. No _exit — the exiting-child→parent reap wakeup is the
		 * documented follow-up; this gate proves the fork MECHANISM only. */
		witness += 0x0c;
		put(fd, "FORK-MMU: child ret=");
		put_hex(fd, 0);
		put(fd, " witness=");
		put_hex(fd, (unsigned long)witness);
		put(fd, "\n");
		for (;;)
			pause();
	}

	/* Parent: fork() returned the child pid. Independent witness (COW). Announce
	 * IMMEDIATELY — no blocking syscall (the rewound parent can run + write but
	 * a block-then-wake, nanosleep/waitpid, is the documented follow-up), then
	 * park so the single CPU yields to the child, which announces + parks too.
	 * Both lines appearing in one boot == fork returned twice; the diverging
	 * witness (child 0x10c / parent 0x1b0) at one VA == COW isolation. */
	witness += 0xb0;
	put(fd, "FORK-MMU: parent pid=");
	put_hex(fd, (unsigned long)pid);
	put(fd, " witness=");
	put_hex(fd, (unsigned long)witness);
	put(fd, "\n");
	put(fd, "FORK-MMU: OK\n");
	for (;;)
		pause();
}
