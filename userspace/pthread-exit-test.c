/* pthread-exit-test — regression test for detached-thread exit on wasm/NOMMU.
 *
 * A DETACHED pthread that returns/exits goes through musl __pthread_exit →
 * __unmapself, which on the generic path does a native stack-pointer switch
 * (CRTJMP) to munmap its own stack — impossible on wasm, where CRTJMP is a stub
 * that abort()s → SIGILL (exit 132). GLib GThreadPool workers (gdk-pixbuf/GTask,
 * used by GTK apps like gtk3-widget-factory) are detached threads, so this crash
 * blocked GTK rendering. patches/musl/0008 replaces __unmapself on wasm with an
 * inline munmap+exit (no stack switch). This test spawns several detached threads
 * that immediately exit; if the fix is missing the process dies with SIGILL and
 * never prints the OK line. */
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

static void *worker(void *arg) {
  (void)arg;
  return NULL; /* detached thread returns → __pthread_exit → __unmapself */
}

int main(void) {
  const int N = 16;
  for (int i = 0; i < N; i++) {
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    pthread_t t;
    int rc = pthread_create(&t, &attr, worker, NULL);
    pthread_attr_destroy(&attr);
    if (rc != 0) {
      printf("PTHREAD-EXIT-TEST: pthread_create failed rc=%d FAIL\n", rc);
      return 1;
    }
    /* stagger so threads actually reach their exit/__unmapself path */
    usleep(20000);
  }
  usleep(200000);
  printf("PTHREAD-EXIT-TEST: spawned+exited %d detached threads OK\n", N);
  fflush(stdout);
  return 0;
}
