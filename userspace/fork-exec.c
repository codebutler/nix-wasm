/* fork-exec.c — Phase 2: the classic fork-then-exec pattern.
 *
 * A fork() child (born via the asyncify rewind in its own worker) immediately
 * execve()s a DIFFERENT program (/bin/echo, a non-asyncified busybox applet).
 * This exercises the interaction the matrix hadn't: a fork child tearing down its
 * (asyncified) image and loading a fresh one via exec — the path every shell uses
 * to run a command. The child's echo prints a marker; the parent reaps it and
 * reports the exit status. Built with the musl-fork seam; baked in as
 * /bin/fork-exec.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>

int main(void) {
  pid_t p = fork();
  if (p == 0) {
    execl("/bin/echo", "echo", "FORKEXEC CHILD_RAN", (char *)0);
    _exit(127); /* only reached if exec failed */
  }
  int st = 0;
  waitpid(p, &st, 0);
  printf("FORKEXEC PARENT cexit=%d\n", WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  fflush(stdout);
  return 0;
}
