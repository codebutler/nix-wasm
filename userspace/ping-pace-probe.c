/* ping-pace-probe — localizer for issue #75. Selected by argv[1]; each case
 * prints "PROBE <case>: <verdict>" and exits. A watchdog thread (its own CPU,
 * timer-ful nanosleep — reliable per sigalrm-test case 2) bounds every case so a
 * lost-timer hang yields an explicit FAIL instead of an indefinite block.
 *
 * Cases:
 *   control   — arm one-shot ITIMER_REAL, block in a single traffic-less recv;
 *               the timer must interrupt it (= sigalrm-test case 3). Baseline.
 *   xcpu      — THE discriminator. An echo thread (a DIFFERENT CPU — every user
 *               task is pinned to its own CPU here) replies to one request, so
 *               the main recv is woken by a genuine cross-CPU IPI, then RE-BLOCKS
 *               with a one-shot timer still pending (the handler only counts — NO
 *               re-arm). Does that pending one-shot fire after the cross-CPU
 *               wakeup + re-block? Isolates the bug from ping's handler-re-arm.
 *   xcpu-obs  — xcpu plus an observer thread (own CPU) that polls getitimer():
 *               tells us whether the hrtimer is still ARMED + counting down
 *               (delivery/wake bug) or frozen/disarmed (arming bug).
 *   repro     — the full busybox-ping shape (one-shot re-armed in the handler,
 *               WANT cycles). Equivalent to ping-pace-test.c.
 */
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define INTERVAL_US 150000
#define WANT 6
#define WATCHDOG_MS 6000

static int sv[2];
static volatile sig_atomic_t count_sent = 0; /* timer firings (handler runs) */
static volatile sig_atomic_t rearm = 0;      /* re-arm the one-shot in handler? */
static volatile sig_atomic_t done = 0;
static const char *casename = "?";

static void arm_oneshot(void) {
  struct itimerval it;
  memset(&it, 0, sizeof(it));
  it.it_value.tv_usec = INTERVAL_US;
  setitimer(ITIMER_REAL, &it, NULL);
}

static void on_alarm(int sig) {
  (void)sig;
  count_sent++;
  if (rearm) {
    char q = 'q';
    ssize_t w = write(sv[0], &q, 1);
    (void)w;
    signal(SIGALRM, on_alarm); /* busybox uses signal() (SA_RESTART) */
    arm_oneshot();
  }
}

/* Install SIGALRM. For the discriminator cases (no re-arm) we deliberately use
 * sa_flags=0 (NO SA_RESTART, like sigalrm-test case 3) so a firing makes the
 * blocked recv return EINTR and the loop can OBSERVE it without the handler
 * needing to generate traffic. The repro case re-installs signal() (SA_RESTART)
 * from inside the handler to match busybox exactly. */
static void install_alarm_norestart(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
}

static void *echo_host(void *a) {
  (void)a;
  for (;;) {
    char b;
    ssize_t n = read(sv[1], &b, 1);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      break;
    }
    char r = 'p';
    ssize_t w = write(sv[1], &r, 1);
    (void)w;
  }
  return NULL;
}

static void *watchdog(void *a) {
  (void)a;
  struct timespec ts = {.tv_sec = WATCHDOG_MS / 1000, .tv_nsec = 0};
  nanosleep(&ts, NULL); /* own CPU, timer-ful wait — reliable */
  if (!done) {
    printf("PROBE %s: FAIL (watchdog) sent=%d\n", casename, count_sent);
    fflush(stdout);
    _exit(1);
  }
  return NULL;
}

int main(int argc, char **argv) {
  casename = argc > 1 ? argv[1] : "control";
  int want_echo;
  if (!strcmp(casename, "control")) {
    want_echo = 0;
    rearm = 0;
  } else if (!strcmp(casename, "xcpu")) {
    want_echo = 1;
    rearm = 0;
  } else if (!strcmp(casename, "repro")) {
    want_echo = 1;
    rearm = 1;
  } else {
    printf("PROBE %s: FAIL (unknown case)\n", casename);
    return 2;
  }

  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sv) != 0) {
    perror("socketpair");
    return 2;
  }

  pthread_t wd, host;
  pthread_create(&wd, NULL, watchdog, NULL);
  if (want_echo) pthread_create(&host, NULL, echo_host, NULL);

  if (rearm)
    signal(SIGALRM, on_alarm); /* SA_RESTART, like busybox */
  else
    install_alarm_norestart(); /* EINTR-visible firings, like sigalrm-test c3 */

  if (!want_echo) {
    /* control: no traffic ever; the one-shot must interrupt the single recv. */
    arm_oneshot();
    char b;
    ssize_t n = recv(sv[0], &b, sizeof(b), 0);
    done = 1;
    if (n < 0 && errno == EINTR && count_sent >= 1) {
      printf("PROBE control: OK (one-shot interrupted recv) sent=%d\n", count_sent);
      fflush(stdout);
      return 0;
    }
    printf("PROBE control: FAIL n=%zd errno=%d sent=%d\n", n, errno, count_sent);
    fflush(stdout);
    return 1;
  }

  /* xcpu / repro: send the first request directly (it elicits an async reply
   * from the echo thread on ANOTHER cpu → a cross-cpu wakeup of recv), arm the
   * one-shot, then run the "listen for replies" loop. */
  {
    char q = 'q';
    ssize_t w = write(sv[0], &q, 1);
    (void)w;
  }
  arm_oneshot();

  /* xcpu: exactly ONE firing must occur AFTER the cross-cpu reply re-blocks the
   * recv (no re-arm). repro: WANT firings, busybox-style (re-armed in handler,
   * each generating its own reply). */
  int target = rearm ? WANT : 1;
  while (count_sent < target) {
    char b;
    ssize_t n = recv(sv[0], &b, sizeof(b), 0);
    if (n < 0) {
      if (errno == EINTR) {
        /* the one-shot fired and interrupted the re-blocked recv (xcpu path) */
        printf("PROBE %s: timer interrupted recv sent=%d\n", casename, count_sent);
        fflush(stdout);
        continue;
      }
      perror("recv");
      break;
    }
    printf("PROBE %s: reply received sent=%d\n", casename, count_sent);
    fflush(stdout);
  }

  done = 1;
  if (count_sent >= target) {
    printf("PROBE %s: OK paced sent=%d\n", casename, count_sent);
    fflush(stdout);
    return 0;
  }
  printf("PROBE %s: FAIL sent=%d\n", casename, count_sent);
  fflush(stdout);
  return 1;
}
