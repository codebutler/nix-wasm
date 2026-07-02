/* fork-returns-twice.c — Phase 2 acceptance: the minimal real fork() program.
 *
 * Exercises the whole seam end to end in the guest: main() -> fork() -> _Fork()
 * -> capture_stack() (asyncify unwind) -> host duplicates the address space +
 * drives the kernel clone -> both sides rewind. Built host-side by
 * userspace/asyncify-cc.nix with forkSeam=true (links musl-fork's seam _Fork and
 * runs wasm-opt --asyncify over the fork call graph), baked into the initramfs as
 * /bin/fork-returns-twice.
 *
 * It prints two DISTINCT lines — one per side of the double return — so the
 * harness (runtime/node/phase2-acceptance.mjs) can assert all of:
 *   - returns twice: a CHILD line (fork()==0) AND a PARENT line (fork()>0);
 *   - private memory: each side's `witness` diverges (child 0x10C, parent 0x1B0)
 *     after the verbatim copy, proving the address spaces are independent;
 *   - waitpid/status: the parent reaps the child and sees WEXITSTATUS == 7.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  volatile int witness = 0x100; /* private to each side after the dup */

  pid_t pid = fork();
  if (pid == 0) {
    /* Child: fork() returned 0. Mutate the private witness and exit(7). */
    witness += 0x0C;
    printf("FORK CHILD ret=0 witness=0x%x\n", witness); /* 0x10c */
    fflush(stdout);
    _exit(7);
  }

  /* Parent: fork() returned the child pid. Independent witness; reap the child. */
  int status = 0;
  waitpid(pid, &status, 0);
  witness += 0xB0;
  printf("FORK PARENT child_pid=%d witness=0x%x childexit=%d\n", pid, witness,
         WIFEXITED(status) ? WEXITSTATUS(status) : -1); /* 0x1b0, 7 */
  fflush(stdout);
  return 0;
}
