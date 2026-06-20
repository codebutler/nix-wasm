/* fork-stress.c — Phase 2 stability: many fork/exit/reap cycles.
 *
 * Loops N times: fork(), the child _exit()s with a code derived from the
 * iteration, the parent waitpid()s and checks the status. This exercises the
 * fork double-return + the runtime's per-child worker spawn/teardown under churn:
 *   - a leak (worker or per-pid Memory not reclaimed) would accumulate and
 *     eventually wedge or OOM;
 *   - a teardown use-after-free / scheduler wedge would hang before N;
 *   - a wrong snapshot/rewind on any iteration would mismatch the exit code.
 * Reports `STRESS done forks=N ok=K` with K==N on success. The companion harness
 * (runtime/node/phase2-stress.mjs) ALSO asserts the live worker count returns to
 * baseline afterwards (no leaked task workers). Baked in as /bin/fork-stress.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>

#define N 50

int main(void) {
  int ok = 0;
  for (int i = 0; i < N; i++) {
    int code = (i & 0x3f) + 1; /* 1..64, never 0, so a missed child is visible */
    pid_t p = fork();
    if (p == 0) {
      _exit(code);
    }
    if (p < 0) {
      printf("STRESS fork FAILED at i=%d\n", i);
      fflush(stdout);
      return 2;
    }
    int st = 0;
    pid_t r = waitpid(p, &st, 0);
    if (r == p && WIFEXITED(st) && WEXITSTATUS(st) == code)
      ok++;
  }
  printf("STRESS done forks=%d ok=%d\n", N, ok);
  fflush(stdout);
  return ok == N ? 0 : 1;
}
