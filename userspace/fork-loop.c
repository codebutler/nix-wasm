/* fork-loop.c — Phase 2 acceptance: several forks before any child is reaped.
 *
 * The parent forks 3 children in a loop WITHOUT waiting between forks, so up to
 * three fork children exist before the parent reaps any. This exercises the
 * runtime's per-child fork-time snapshot keying (a single staging slot would be
 * clobbered by the next fork before a lazily-spawned child consumed it) and that
 * each child gets ITS OWN private copy + distinct pid. Each child exits 10+i; the
 * parent reaps all three and reports the exit-status sum (33). Built with the
 * musl-fork seam + asyncify (addlist), baked in as /bin/fork-loop.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>

#define N 3

int main(void) {
  pid_t pids[N];
  for (int i = 0; i < N; i++) {
    pid_t p = fork();
    if (p == 0) {
      printf("LOOP CHILD i=%d pid_ok=%d\n", i, getpid() > 0);
      fflush(stdout);
      _exit(10 + i);
    }
    pids[i] = p;
  }

  int sum = 0, distinct = 1;
  for (int i = 0; i < N; i++) {
    int st = 0;
    waitpid(pids[i], &st, 0);
    sum += WIFEXITED(st) ? WEXITSTATUS(st) : 0;
    for (int j = 0; j < i; j++)
      if (pids[j] == pids[i]) distinct = 0;
  }
  printf("LOOP PARENT reaped=%d exitsum=%d distinct=%d\n", N, sum, distinct);
  fflush(stdout);
  return 0;
}
