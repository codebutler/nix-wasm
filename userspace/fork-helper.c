/* fork-helper.c — Phase 2: fork() called from a HELPER frame, not directly from
 * main. This is the case the hardcoded addlist (_start..main,fork,_Fork) does NOT
 * cover: main -> level2 -> level1 -> fork(). If asyncify only instruments the
 * fixed libc/crt frames, the unwind escapes at the un-instrumented helper frames
 * and the double-return breaks. Used to validate a GENERIC asyncify config (pure
 * reachability from the capture_stack import) that handles arbitrary call depth.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline)) static pid_t level1(volatile int *w) {
  *w += 1; /* mutate a live local up the chain so we can see it survive */
  return fork();
}

__attribute__((noinline)) static pid_t level2(volatile int *w) {
  *w += 0x10;
  return level1(w);
}

int main(void) {
  volatile int w = 0x300;
  pid_t pid = level2(&w); /* w == 0x311 by the time fork() is reached */

  if (pid == 0) {
    w += 0x0C;
    printf("HELPER CHILD ret=0 w=0x%x\n", w); /* 0x31d */
    fflush(stdout);
    _exit(8);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  w += 0xB0;
  printf("HELPER PARENT pid=%d w=0x%x cexit=%d\n", pid, w,
         WIFEXITED(st) ? WEXITSTATUS(st) : -1); /* 0x3c1 */
  fflush(stdout);
  return 0;
}
