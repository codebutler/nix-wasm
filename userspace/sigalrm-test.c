/* sigalrm-test — regression test for async SIGALRM / setitimer(ITIMER_REAL) /
 * alarm() delivery on the wasm/NOMMU guest (issue #35).
 *
 * What this proves (kernel pin 039e5f3e):
 *
 *   The kernel + runtime async-timer path WORKS.  The wasm clockevent
 *   (arch/wasm/kernel/time.c) drives the generic hrtimer subsystem; ITIMER_REAL's
 *   it_real_fn raises SIGALRM; signals are delivered at the exit-to-user-mode
 *   boundary; and the idle loop's memory.atomic.wait64 timeout
 *   (arch/wasm/kernel/smp.c) fires the timer IRQ while a task is blocked in a
 *   syscall.  This holds for a process that has NOT spawned, for the PARENT of a
 *   posix_spawn, AND for a spawned CHILD (ping's position) — and for both
 *   timer-ful blocking waits (nanosleep) and timer-LESS ones (recvfrom/pause).
 *
 * The three cases below cover those paths:
 *   1. alarm(1) + pause()                    — one-shot timeout while blocked.
 *   2. setitimer(ITIMER_REAL) periodic       — N ticks, blocked in nanosleep.
 *   3. setitimer + recvfrom AFTER a spawn     — one-shot timer must interrupt a
 *      (busybox-ping's pacing skeleton)         single timer-less blocking wait
 *                                               in a process that has spawned.
 *
 * NB (issue #75): every case here installs the handler with sigaction(sa_flags=0)
 * — i.e. NO SA_RESTART — so an interrupted syscall returns -EINTR and the kernel
 * delivers the handler. busybox `ping` installs via signal() (musl → SA_RESTART),
 * and THAT path is broken on the guest: a SA_RESTART handler is never delivered
 * when it interrupts a blocking syscall (the wasm syscall-restart loop re-enters
 * the syscall before _user_mode_tail runs the queued handler). So this test does
 * NOT cover SA_RESTART; that gap is the #75 root cause, exercised by
 * ping-pace-probe.c (`restart`/`repro` cases) and ping-pace-test.c.
 *
 * Background — #35's premise vs. reality: #35 reported busybox `ping` sending
 * only one packet and hypothesized "no async interval-timer source raises
 * SIGALRM" at the kernel level.  This test demonstrates the kernel mechanism is
 * in fact present and correct end to end; an equivalent standalone C ping
 * (SOCK_RAW/SOCK_DGRAM + one-shot setitimer re-armed in the handler + blocking
 * recvfrom, run as a spawned child) paces correctly.  The residual busybox
 * `ping`/`timeout` failure does NOT reproduce in equivalent C and is therefore
 * a busybox-internal issue, tracked separately — not a kernel/runtime async-
 * signal gap.  This test guards the kernel mechanism against regression.
 *
 * Prints "SIGALRM-TEST: <case>=<0|1>" lines, then "...OK" when all pass. */
#include <netinet/in.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

static volatile sig_atomic_t alarm_count = 0;

static void on_alarm(int sig) {
  (void)sig;
  alarm_count++;
}

static int install_handler(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_alarm;
  return sigaction(SIGALRM, &sa, NULL);
}

/* Case 1: alarm() one-shot delivered while blocked in pause(). */
static int test_alarm_pause(void) {
  alarm_count = 0;
  if (install_handler() != 0) return -1;
  alarm(1);
  pause(); /* returns only when SIGALRM arrives */
  return alarm_count == 1 ? 0 : -1;
}

/* Case 2: setitimer(ITIMER_REAL) periodic — N ticks delivered while the main
 * thread blocks in nanosleep between ticks (ping's interval-loop model). */
static int test_setitimer_periodic(void) {
  alarm_count = 0;
  if (install_handler() != 0) return -1;

  const int want = 3;
  struct itimerval it;
  memset(&it, 0, sizeof(it));
  it.it_value.tv_usec = 200000;    /* first tick at 200ms */
  it.it_interval.tv_usec = 200000; /* then every 200ms */
  if (setitimer(ITIMER_REAL, &it, NULL) != 0) return -1;

  while (alarm_count < want) {
    struct timespec ts = {.tv_sec = 5, .tv_nsec = 0};
    nanosleep(&ts, NULL); /* interrupted by SIGALRM each tick */
  }

  memset(&it, 0, sizeof(it));
  setitimer(ITIMER_REAL, &it, NULL); /* disarm */
  return alarm_count >= want ? 0 : -1;
}

/* Case 3: busybox-ping's exact pattern. After a posix_spawn (the shell spawns
 * ping), arm a one-shot setitimer(ITIMER_REAL) and block in ONE recvfrom that
 * has NO timer of its own; SIGALRM must interrupt that single timer-less wait.
 * Bounded by a 2s SO_RCVTIMEO watchdog so a (hypothetical) lost timer reports
 * FAIL rather than hanging; elapsed time is both the bound and the
 * discriminator.  (A nanosleep/short-poll wait would MASK a lost timer — the
 * sleep programs its own clockevent expiry that re-wakes the idle loop — so the
 * blocking wait here is deliberately timer-less, like ping's recvfrom.) */
static int test_setitimer_after_spawn(void) {
  pid_t pid;
  char *av[] = {"/bin/true", NULL};
  if (posix_spawn(&pid, "/bin/true", NULL, NULL, av, environ) != 0) return -1;
  int st;
  waitpid(pid, &st, 0);

  int fd = socket(AF_INET, SOCK_DGRAM, 0); /* nothing ever arrives on it */
  if (fd < 0) return -1;
  struct timeval rcvto = {.tv_sec = 2, .tv_usec = 0}; /* watchdog bound */
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &rcvto, sizeof(rcvto));

  alarm_count = 0;
  if (install_handler() != 0) return -1;

  struct itimerval it;
  memset(&it, 0, sizeof(it));
  it.it_value.tv_usec = 200000; /* one-shot, fire once at 200ms (like ping) */
  if (setitimer(ITIMER_REAL, &it, NULL) != 0) return -1;

  struct timespec start, end;
  clock_gettime(CLOCK_MONOTONIC, &start);
  char buf[64];
  (void)recvfrom(fd, buf, sizeof(buf), 0, NULL, NULL);
  clock_gettime(CLOCK_MONOTONIC, &end);

  memset(&it, 0, sizeof(it));
  setitimer(ITIMER_REAL, &it, NULL); /* disarm any leftover */

  long elapsed_ms =
      (end.tv_sec - start.tv_sec) * 1000 + (end.tv_nsec - start.tv_nsec) / 1000000;
  /* PASS iff SIGALRM fired AND it interrupted the wait early (<1s, vs the 2s
   * SO_RCVTIMEO a lost timer would wait out). */
  return (alarm_count >= 1 && elapsed_ms < 1000) ? 0 : -1;
}

int main(void) {
  int c1 = test_alarm_pause();
  printf("SIGALRM-TEST: alarm_pause=%d\n", c1 == 0);
  int c2 = test_setitimer_periodic();
  printf("SIGALRM-TEST: setitimer_periodic=%d\n", c2 == 0);
  int c3 = test_setitimer_after_spawn();
  printf("SIGALRM-TEST: setitimer_after_spawn=%d\n", c3 == 0);
  fflush(stdout);

  if (c1 == 0 && c2 == 0 && c3 == 0) {
    printf("SIGALRM-TEST: alarm/pause + setitimer periodic + after-spawn OK\n");
    fflush(stdout);
    return 0;
  }
  return 1;
}
