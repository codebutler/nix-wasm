/* fork-in-thread.c — Phase 2 acceptance: fork() in a multithreaded process.
 *
 * main() spawns a pthread (the existing clone-with-fn path — a CLONE_VM child
 * worker sharing main's address space), waits for it to run, then fork()s. POSIX
 * says the child gets ONLY the calling thread, with a private copy of the shared
 * memory. So the child must: be single-threaded (the worker thread is NOT carried
 * over), see the shared `thread_started` flag the pthread set (copied memory), and
 * return 0 from fork(); the parent (still multithreaded) reaps it. Built with the
 * musl-fork seam (fork) over normal pthreads (clone-with-fn), baked in as
 * /bin/fork-in-thread.
 */
#include <unistd.h>
#include <sys/wait.h>
#include <stdio.h>
#include <stdlib.h>
#include <sched.h>
#include <pthread.h>

static volatile int thread_started = 0;

static void *worker(void *arg) {
  (void)arg;
  thread_started = 1;
  for (;;) sleep(1); /* keep the thread alive across the fork */
  return NULL;
}

int main(void) {
  pthread_t t;
  if (pthread_create(&t, NULL, worker, NULL) != 0) {
    printf("THREADFORK pthread_create failed\n");
    fflush(stdout);
    return 1;
  }
  while (!thread_started) sched_yield(); /* let the pthread run first */

  pid_t c = fork();
  if (c == 0) {
    /* Child: single-threaded, but inherited the copied memory (thread_started). */
    printf("THREADFORK CHILD thread_started=%d\n", thread_started); /* 1 */
    fflush(stdout);
    _exit(6);
  }

  int st = 0;
  waitpid(c, &st, 0);
  printf("THREADFORK PARENT cexit=%d\n", WIFEXITED(st) ? WEXITSTATUS(st) : -1);
  fflush(stdout);
  return 0;
}
