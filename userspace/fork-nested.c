/* fork-nested.c — Phase 2 acceptance: nested fork().
 *
 * The parent forks a child; the CHILD then forks a grandchild. This exercises
 * fork re-entrancy from inside a fork CHILD worker (the child, itself spawned by
 * the host fork orchestration, must run the same unwind->clone->rewind machinery),
 * distinct pids at every level, and waitpid reaping up the chain. Built with the
 * musl-fork seam + asyncify (addlist), baked in as /bin/fork-nested.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  pid_t child = fork();
  if (child == 0) {
    /* Child: fork a grandchild. */
    pid_t grand = fork();
    if (grand == 0) {
      printf("NESTED GRANDCHILD pid_ok=%d\n", getpid() > 0);
      fflush(stdout);
      _exit(3);
    }
    int gst = 0;
    waitpid(grand, &gst, 0);
    printf("NESTED CHILD grand=%d gexit=%d distinct=%d\n", grand,
           WIFEXITED(gst) ? WEXITSTATUS(gst) : -1, grand != getpid());
    fflush(stdout);
    _exit(2);
  }

  int cst = 0;
  waitpid(child, &cst, 0);
  printf("NESTED PARENT child=%d cexit=%d distinct=%d\n", child,
         WIFEXITED(cst) ? WEXITSTATUS(cst) : -1, child != getpid());
  fflush(stdout);
  return 0;
}
