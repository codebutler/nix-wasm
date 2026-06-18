/* ash-cb-guest.c — the wasm32-linux-musl (NOMMU) backend for the forkshell
 * ash's "cb" bridge. Replaces pc's WASI cb_spawn.c + its `cb` host-import
 * surface with NATIVE Linux syscalls: posix_spawn (clone-with-fn under the
 * hood on this NOMMU port), pipes, waitpid, dup2. No host bridge, no futex SAB,
 * no asyncify.
 *
 * The forkshell serializer (patches/busybox/ash/0003-ash-forkshell.patch) is
 * reused verbatim; only the TRANSPORT changes. ash "forks without exec" for
 * subshells / $(shell-code) / pipelines / heredocs; on NOMMU we can't clone a
 * live instance, so the parent serializes the child's shell state into a flat,
 * pointer-relocatable block and we run it as a FRESH `ash --fs` process. That
 * re-exec is an ordinary posix_spawn-of-an-executable — exactly the guest's
 * proven spawn model — so there is no fork-without-exec at the C level at all.
 *
 * Block transport: the parent writes [i32 len][block] into a tmpfile fd and the
 * child reads it from a fixed inherited fd (FS_BLOCK_FD). The child relocates
 * the block's pointers by (new_base - old_base) — unchanged from upstream; only
 * the source of the bytes (an fd, not host shared memory) differs.
 */
#include <spawn.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <errno.h>
#include <signal.h>
#include <time.h>

/* The forkshell/spawn children are REAL processes here (posix_spawn), unlike
 * pc's WASI build where the host runs them invisibly. Each delivers SIGCHLD to
 * ash; we reap it ourselves (waitpid on the specific pid). The problem: ash's
 * SIGCHLD handler then sets got_sigchld, and its next dowait() calls
 * waitpid(-1, WNOHANG) — which on this NOMMU wasm kernel BLOCKS instead of
 * returning ECHILD when there are no children (a guest-kernel bug; see
 * docs/STATUS.md), hanging the command after a $()/subshell.
 *
 * Fix without touching the kernel: temporarily set SIGCHLD to SIG_DFL around
 * spawn+reap. SIGCHLD's default action is "ignore" (child still reapable), so
 * ash's handler never runs, got_sigchld stays clear, and ash's dowait(NONBLOCK)
 * early-returns without calling the buggy waitpid. Our own waitpid(specific_pid)
 * is unaffected (the bug is only -1 + WNOHANG + no children). This also matches
 * WASI semantics, where ash never saw the (host-run) child's SIGCHLD. */
static void chld_block(struct sigaction *old)
{
	struct sigaction da;
	memset(&da, 0, sizeof(da));
	da.sa_handler = SIG_DFL;
	sigaction(SIGCHLD, &da, old);
}
static void chld_unblock(const struct sigaction *old)
{
	sigaction(SIGCHLD, old, NULL);
}

extern char **environ;

/* The forkshell child reads its serialized block from this inherited fd. It's
 * high enough to be free in a freshly-exec'd ash before it opens user fds. */
#define FS_BLOCK_FD 3

/* cb_spawn_redirect's spec — layout MUST match the typedef the m3-m4 patch
 * defines in ash.c ({int fd; int op; const char *path;}). */
typedef struct { int fd; int op; const char *path; } cb_redir_spec;

/* ---- helpers ------------------------------------------------------------- */

/* Resolve this ash binary's absolute path for re-exec as `ash --fs`. The guest
 * mounts /proc (userspace/bootstrap.nix), so /proc/self/exe is authoritative. */
static const char *self_exe(void)
{
	static char path[4096];
	if (!path[0]) {
		ssize_t n = readlink("/proc/self/exe", path, sizeof(path) - 1);
		if (n > 0) path[n] = '\0';
		else strcpy(path, "ash"); /* fallback: PATH lookup */
	}
	return path;
}

/* Reap pid; return a shell exit status (128+signo if killed). */
static int wait_status(pid_t pid)
{
	int st;
	while (waitpid(pid, &st, 0) < 0 && errno == EINTR) { }
	if (WIFEXITED(st)) return WEXITSTATUS(st);
	if (WIFSIGNALED(st)) return 128 + WTERMSIG(st);
	return 1;
}

/* A seekable fd holding `len` bytes, positioned at 0. Uses an unlinked tmpfile
 * on /tmp (tmpfs) — portable (no memfd kernel dependency), survives into the
 * child, and avoids pipe-buffer deadlock for large $() blocks. */
static int bytes_fd(const char *data, int len)
{
	char tmpl[] = "/tmp/.ashfsXXXXXX";
	int fd = mkstemp(tmpl);
	if (fd < 0) return -1;
	unlink(tmpl);
	int off = 0, n;
	while (off < len && (n = write(fd, data + off, len - off)) > 0) off += n;
	if (off != len) { close(fd); return -1; }
	lseek(fd, 0, SEEK_SET);
	return fd;
}

/* read exactly n bytes (until EOF) into buf; return bytes read. */
static int read_full(int fd, void *buf, int n)
{
	int off = 0, r;
	while (off < n && (r = read(fd, (char *)buf + off, n - off)) > 0) off += r;
	return off;
}

/* ===== external-command spawn family (was cb_spawn.c over the host) ======== *
 * On the guest, ash's CMDUNKNOWN external commands are real execve's via
 * posix_spawnp (PATH search) — the working NOMMU clone-with-fn spawn. */

/* Resolve argv[0] to an executable, exactly as posix_spawnp's PATH search would.
 * Returns 1 if found+executable, 0 if not. This is the command-not-found gate:
 * on this NOMMU guest, posix_spawn{,p} of a NONEXISTENT binary does NOT report
 * the child's execve failure back to the parent — instead our wait_status()
 * blocks forever (the same -1/no-child kernel wait quirk; see chld_block above).
 * autoconf probes missing commands constantly (and treats e.g. `as_var+=2` as
 * one), so a not-found command must return 127 WITHOUT ever calling posix_spawn.
 * This is just standard shell semantics — resolve before exec, 127 if absent. */
static int cmd_found(const char *name)
{
	char buf[4096];
	const char *path, *p;
	size_t nl;
	if (!name || !name[0]) return 0;
	if (strchr(name, '/'))           /* explicit path: no PATH search */
		return access(name, X_OK) == 0;
	path = getenv("PATH");
	if (!path) path = "/bin:/usr/bin";
	nl = strlen(name);
	for (p = path; ; ) {
		const char *colon = strchr(p, ':');
		size_t dl = colon ? (size_t)(colon - p) : strlen(p);
		if (dl == 0) {               /* empty entry == current directory */
			if (access(name, X_OK) == 0) return 1;
		} else if (dl + 1 + nl + 1 <= sizeof buf) {
			memcpy(buf, p, dl);
			buf[dl] = '/';
			memcpy(buf + dl + 1, name, nl + 1);
			if (access(buf, X_OK) == 0) return 1;
		}
		if (!colon) break;
		p = colon + 1;
	}
	return 0;
}

int cb_spawn(char **argv)
{
	struct sigaction old;
	posix_spawn_file_actions_t fa;
	pid_t pid;
	int rc;
	if (!cmd_found(argv[0])) return 127;   /* command not found — never spawn */
	chld_block(&old);
	/* Pass an (empty) initialized file_actions, NOT NULL: on this NOMMU wasm
	 * port posix_spawn{,p} with a NULL file-actions argument hangs, whereas a
	 * non-NULL (even empty) one works — every other cb_spawn_* here already
	 * passes &fa, and only this NULL path was broken. */
	posix_spawn_file_actions_init(&fa);
	rc = posix_spawnp(&pid, argv[0], &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	rc = (rc != 0) ? 127 : wait_status(pid);
	chld_unblock(&old);
	return rc;
}

int cb_spawn_pipeline(char ***stages, int nstages)
{
	struct sigaction old;
	pid_t pids[64];
	int prev_read = -1, i, status = 1;
	if (nstages > 64) return 126;
	chld_block(&old);
	for (i = 0; i < nstages; i++) {
		int last = (i == nstages - 1);
		int pp[2] = { -1, -1 };
		posix_spawn_file_actions_t fa;

		if (!last && pipe(pp) < 0) { chld_unblock(&old); return 126; }
		posix_spawn_file_actions_init(&fa);
		if (prev_read >= 0) {
			posix_spawn_file_actions_adddup2(&fa, prev_read, 0);
			posix_spawn_file_actions_addclose(&fa, prev_read);
		}
		if (!last) {
			posix_spawn_file_actions_adddup2(&fa, pp[1], 1);
			posix_spawn_file_actions_addclose(&fa, pp[1]);
			posix_spawn_file_actions_addclose(&fa, pp[0]);
		}
		/* not-found stage: never posix_spawn (it would hang); mark failed. */
		if (!cmd_found(stages[i][0]) ||
		    posix_spawnp(&pids[i], stages[i][0], &fa, NULL, stages[i], environ) != 0) {
			pids[i] = -1;
			if (last) status = 127;
		}
		posix_spawn_file_actions_destroy(&fa);
		if (prev_read >= 0) close(prev_read);
		if (!last) { close(pp[1]); prev_read = pp[0]; }
	}
	for (i = 0; i < nstages; i++)
		if (pids[i] > 0) { int s = wait_status(pids[i]); if (i == nstages - 1) status = s; }
	chld_unblock(&old);
	return status;
}

int cb_spawn_redirect(char **argv, const cb_redir_spec *redirs, int nredirs)
{
	struct sigaction old;
	posix_spawn_file_actions_t fa;
	pid_t pid;
	int i, rc;

	if (!cmd_found(argv[0])) return 127;   /* command not found — never spawn */
	chld_block(&old);
	posix_spawn_file_actions_init(&fa);
	for (i = 0; i < nredirs; i++) {
		int flags = redirs[i].op == 0 ? (O_WRONLY | O_CREAT | O_TRUNC)
			  : redirs[i].op == 1 ? (O_WRONLY | O_CREAT | O_APPEND)
			  : O_RDONLY;
		posix_spawn_file_actions_addopen(&fa, redirs[i].fd, redirs[i].path, flags, 0666);
	}
	rc = posix_spawnp(&pid, argv[0], &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	rc = (rc != 0) ? 127 : wait_status(pid);
	chld_unblock(&old);
	return rc;
}

int cb_spawn_capture(char **argv, char *outbuf, int outbuf_size)
{
	struct sigaction old;
	posix_spawn_file_actions_t fa;
	pid_t pid;
	int pp[2], total, n, rc;

	if (!cmd_found(argv[0])) return 0;     /* command not found — empty capture */
	chld_block(&old);
	if (pipe(pp) < 0) { chld_unblock(&old); return -1; }
	posix_spawn_file_actions_init(&fa);
	posix_spawn_file_actions_adddup2(&fa, pp[1], 1);
	posix_spawn_file_actions_addclose(&fa, pp[1]);
	posix_spawn_file_actions_addclose(&fa, pp[0]);
	rc = posix_spawnp(&pid, argv[0], &fa, NULL, argv, environ);
	posix_spawn_file_actions_destroy(&fa);
	close(pp[1]);
	if (rc != 0) { close(pp[0]); chld_unblock(&old); return -1; }
	total = 0;
	while (total < outbuf_size && (n = read(pp[0], outbuf + total, outbuf_size - total)) > 0)
		total += n;
	close(pp[0]);
	wait_status(pid);
	chld_unblock(&old);
	return total;
}

/* ===== forkshell family — "fork without exec" via re-exec `ash --fs` ======= */

/* Spawn `ash --fs` with the serialized block on FS_BLOCK_FD. stdin_from /
 * stdout_to (>=0) dup2 onto 0/1 for pipelines and $() capture; close0/close1
 * (>=0) are extra parent-side pipe fds to close in the child so the child holds
 * no stray pipe ends (else the parent never sees EOF). Returns pid. */
static pid_t spawn_fs2(int blockfd, int stdin_from, int stdout_to, int close0, int close1)
{
	const char *exe = self_exe();
	char *argv[] = { (char *)"ash", (char *)"--fs", NULL };
	posix_spawn_file_actions_t fa;
	pid_t pid;

	posix_spawn_file_actions_init(&fa);
	posix_spawn_file_actions_adddup2(&fa, blockfd, FS_BLOCK_FD);
	if (blockfd != FS_BLOCK_FD)
		posix_spawn_file_actions_addclose(&fa, blockfd);
	if (stdin_from >= 0) posix_spawn_file_actions_adddup2(&fa, stdin_from, 0);
	if (stdout_to  >= 0) posix_spawn_file_actions_adddup2(&fa, stdout_to, 1);
	/* close the raw pipe fds in the child (after the dup2s captured them). */
	if (close0 >= 0 && close0 != FS_BLOCK_FD) posix_spawn_file_actions_addclose(&fa, close0);
	if (close1 >= 0 && close1 != FS_BLOCK_FD && close1 != 1) posix_spawn_file_actions_addclose(&fa, close1);
	if (posix_spawn(&pid, exe, &fa, NULL, argv, environ) != 0)
		pid = -1;
	posix_spawn_file_actions_destroy(&fa);
	return pid;
}

static pid_t spawn_fs(int blockfd, int stdin_from, int stdout_to)
{
	return spawn_fs2(blockfd, stdin_from, stdout_to, -1, -1);
}

/* Frame a block as [i32 len][block] in a seekable fd. */
static int block_fd(const char *block, int len)
{
	char hdr[4] = { (char)(len & 0xff), (char)((len >> 8) & 0xff),
			(char)((len >> 16) & 0xff), (char)((len >> 24) & 0xff) };
	char tmpl[] = "/tmp/.ashfsXXXXXX";
	int fd = mkstemp(tmpl);
	if (fd < 0) return -1;
	unlink(tmpl);
	if (write(fd, hdr, 4) != 4 ||
	    (len && write(fd, block, len) != len)) { close(fd); return -1; }
	lseek(fd, 0, SEEK_SET);
	return fd;
}

int __cb_fork_run(const char *block, int len, int bg)
{
	struct sigaction old;
	int bf, rc;
	pid_t pid;

	chld_block(&old);
	bf = block_fd(block, len);
	if (bf < 0) { chld_unblock(&old); return -1; }
	pid = spawn_fs(bf, -1, -1);
	close(bf);
	rc = (pid < 0) ? -1 : (bg ? 0 : wait_status(pid));
	chld_unblock(&old);
	return rc;
}

int __cb_fork_capture(const char *block, int len, char *outbuf, int outbufsize, int *statusp)
{
	struct sigaction old;
	int bf, pp[2], total, n;
	pid_t pid;

	chld_block(&old);
	bf = block_fd(block, len);
	if (bf < 0) { chld_unblock(&old); return -1; }
	if (pipe(pp) < 0) { close(bf); chld_unblock(&old); return -1; }
	/* close both raw pipe fds in the child (it keeps only fd1=dup(pp[1])). */
	pid = spawn_fs2(bf, -1, pp[1], pp[0], pp[1]);
	close(bf); close(pp[1]);
	if (pid < 0) { close(pp[0]); chld_unblock(&old); return -1; }
	total = 0;
	while (total < outbufsize && (n = read(pp[0], outbuf + total, outbufsize - total)) > 0)
		total += n;
	close(pp[0]);
	{ int st = wait_status(pid); if (statusp) *statusp = st; }
	chld_unblock(&old);
	return total;
}

int __cb_fork_pipeline(const char *buf, int len, int bg)
{
	struct sigaction old;
	pid_t pids[64];
	int nstages, off, prev_read = -1, i, status = 1;
	(void)bg;

	if (len < 4) return -1;
	nstages = (unsigned char)buf[0] | ((unsigned char)buf[1] << 8)
		| ((unsigned char)buf[2] << 16) | ((unsigned char)buf[3] << 24);
	if (nstages <= 0 || nstages > 64) return -1;
	chld_block(&old);
	off = 4;
	for (i = 0; i < nstages; i++) {
		int blen, bf, last = (i == nstages - 1), pp[2] = { -1, -1 };
		pid_t pid;

		if (off + 4 > len) { pids[i] = -1; break; }
		blen = (unsigned char)buf[off] | ((unsigned char)buf[off + 1] << 8)
		     | ((unsigned char)buf[off + 2] << 16) | ((unsigned char)buf[off + 3] << 24);
		off += 4;
		if (off + blen > len) { pids[i] = -1; break; }
		bf = block_fd(buf + off, blen);
		off += blen;
		if (bf < 0) { pids[i] = -1; continue; }
		if (!last && pipe(pp) < 0) { close(bf); pids[i] = -1; continue; }
		pid = spawn_fs2(bf, prev_read, last ? -1 : pp[1], (!last ? pp[0] : -1), (!last ? pp[1] : -1));
		pids[i] = pid;
		close(bf);
		if (prev_read >= 0) close(prev_read);
		if (!last) { close(pp[1]); prev_read = pp[0]; }
	}
	for (i = 0; i < nstages; i++)
		if (pids[i] > 0) { int s = wait_status(pids[i]); if (i == nstages - 1) status = s; }
	chld_unblock(&old);
	return status;
}

/* Child side: fetch the serialized block from FS_BLOCK_FD. First call
 * (buf==NULL) returns the total length (4-byte header); second copies it in. */
int __cb_fork_block(char *buf, int len)
{
	if (buf == NULL) {
		unsigned char hdr[4];
		if (read_full(FS_BLOCK_FD, hdr, 4) != 4) return 0;
		return hdr[0] | (hdr[1] << 8) | (hdr[2] << 16) | (hdr[3] << 24);
	}
	return read_full(FS_BLOCK_FD, buf, len);
}

/* Heredoc body as a seekable fd (openhere dup2's it onto the target fd). */
int __cb_here_fd(const char *text, int len)
{
	return bytes_fd(text, len);
}

/* Pending-interrupt probe. configure doesn't rely on interactive Ctrl-C; report
 * none for now. (Future: a SIGINT handler setting a sig_atomic_t flag.) */
int __cb_poll_signal(int consume)
{
	(void)consume;
	return 0;
}
