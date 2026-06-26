/* ping-pace-probe — localizer for issue #75. argv[1] selects a case; each prints
 * "PROBE <case>: <verdict>" and exits. A watchdog thread (its own CPU, timer-ful
 * nanosleep — reliable per sigalrm-test case 2) bounds every case so a lost
 * signal-handler delivery yields an explicit FAIL instead of an indefinite hang.
 *
 * The CI matrix isolated #75 to SA_RESTART (NOT cross-CPU, NOT the handler
 * re-arm): a one-shot timer's SIGALRM handler installed with SA_RESTART is never
 * delivered when it interrupts a blocking syscall — the wasm syscall-restart
 * loop (arch/wasm/kernel/traps.c WASM_SYSCALL_N) re-enters the syscall before
 * _user_mode_tail can run the queued handler. Every existing test uses
 * sigaction(sa_flags=0) (→ -EINTR, restart=false, handler delivered), so the
 * SA_RESTART path was never exercised; busybox ping installs via signal() (musl
 * → SA_RESTART), hence one packet then hang.
 *
 * Cases (all PASS on a native kernel; on the guest only the SA_RESTART ones
 * fail):
 *   control — one-shot, NO SA_RESTART (sigaction sa_flags=0), single
 *             traffic-less recv; the timer must interrupt it (= sigalrm-test
 *             case 3). Baseline.
 *   restart — one-shot, SA_RESTART (signal()), SINGLE-THREADED self-pipe: the
 *             handler writes a byte (so the SA_RESTART-restarted read returns)
 *             and re-arms. Isolates SA_RESTART with NO second thread / no
 *             cross-CPU. Expected to FAIL on the guest.
 *   xcpu    — one-shot, NO SA_RESTART, a cross-CPU echo thread replies once so
 *             recv is woken by a cross-CPU IPI and RE-BLOCKS with the one-shot
 *             still pending. Confirms cross-CPU wakeup is NOT the bug (PASS).
 *   repro   — the full busybox-ping shape: SA_RESTART + handler re-arm + echo
 *             thread. Expected to FAIL.
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
#define WANT 4
#define WATCHDOG_MS 6000

static int sv[2];                            /* socketpair (xcpu/repro) */
static int pp[2];                            /* self-pipe (restart) */
static volatile sig_atomic_t count_sent = 0; /* handler invocations observed */
static volatile sig_atomic_t use_restart = 0;
static volatile sig_atomic_t writes_pipe = 0; /* handler writes self-pipe */
static volatile sig_atomic_t writes_sock = 0; /* handler writes socket (repro) */
static volatile sig_atomic_t rearm = 0;
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
  if (writes_pipe) {
    char q = 'x';
    ssize_t w = write(pp[1], &q, 1);
    (void)w;
  }
  if (writes_sock) {
    char q = 'q';
    ssize_t w = write(sv[0], &q, 1);
    (void)w;
  }
  if (use_restart) signal(SIGALRM, on_alarm); /* SA_RESTART, like busybox */
  if (rearm) arm_oneshot();
}

static void install_alarm(void) {
  if (use_restart) {
    signal(SIGALRM, on_alarm); /* musl → SA_RESTART */
  } else {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = on_alarm; /* sa_flags=0 → no SA_RESTART (= sigalrm-test c3) */
    sigaction(SIGALRM, &sa, NULL);
  }
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
  const char *arg = argc > 1 ? argv[1] : "control";
  int want_echo = 0;
  /* Point casename at a string LITERAL (not argv[1], whose backing memory may
   * not persist across thread creation on the guest — that was the "PROBE ?:"
   * cosmetic glitch in the first matrix run). */
  if (!strcmp(arg, "control")) {
    casename = "control";
  } else if (!strcmp(arg, "restart")) {
    casename = "restart";
    use_restart = 1;
    writes_pipe = 1;
    rearm = 1;
  } else if (!strcmp(arg, "xcpu")) {
    casename = "xcpu";
    want_echo = 1;
  } else if (!strcmp(arg, "repro")) {
    casename = "repro";
    want_echo = 1;
    use_restart = 1;
    writes_sock = 1;
    rearm = 1;
  } else {
    printf("PROBE %s: FAIL (unknown case)\n", arg);
    return 2;
  }

  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sv) != 0 || pipe(pp) != 0) {
    perror("setup");
    return 2;
  }

  pthread_t wd, host;
  pthread_create(&wd, NULL, watchdog, NULL);
  if (want_echo) pthread_create(&host, NULL, echo_host, NULL);

  install_alarm();

  if (!strcmp(casename, "control")) {
    /* one-shot must interrupt a single traffic-less recv (no SA_RESTART). */
    arm_oneshot();
    char b;
    ssize_t n = recv(sv[0], &b, sizeof(b), 0);
    done = 1;
    if (n < 0 && errno == EINTR && count_sent >= 1)
      printf("PROBE control: OK (one-shot interrupted recv) sent=%d\n", count_sent);
    else
      printf("PROBE control: FAIL n=%zd errno=%d sent=%d\n", n, errno, count_sent);
    fflush(stdout);
    return (n < 0 && errno == EINTR && count_sent >= 1) ? 0 : 1;
  }

  if (!strcmp(casename, "restart")) {
    /* SA_RESTART, single-threaded: the handler writes the self-pipe so the
     * SA_RESTART-restarted read() returns; the loop counts handler firings.
     * BUG: the handler is never delivered → read() blocks forever → watchdog. */
    arm_oneshot();
    while (count_sent < WANT) {
      char b;
      ssize_t n = read(pp[0], &b, 1);
      if (n < 0) {
        if (errno == EINTR) continue;
        perror("read");
        break;
      }
    }
    done = 1;
    if (count_sent >= WANT)
      printf("PROBE restart: OK paced sent=%d\n", count_sent);
    else
      printf("PROBE restart: FAIL sent=%d\n", count_sent);
    fflush(stdout);
    return count_sent >= WANT ? 0 : 1;
  }

  /* xcpu / repro: first request directly (elicits an async cross-CPU reply),
   * arm the one-shot, then run the "listen for replies" loop. */
  {
    char q = 'q';
    ssize_t w = write(sv[0], &q, 1);
    (void)w;
  }
  arm_oneshot();

  int target = rearm ? WANT : 1;
  while (count_sent < target) {
    char b;
    ssize_t n = recv(sv[0], &b, sizeof(b), 0);
    if (n < 0) {
      if (errno == EINTR) continue; /* one-shot interrupted recv (xcpu path) */
      perror("recv");
      break;
    }
  }
  done = 1;
  if (count_sent >= target)
    printf("PROBE %s: OK paced sent=%d\n", casename, count_sent);
  else
    printf("PROBE %s: FAIL sent=%d\n", casename, count_sent);
  fflush(stdout);
  return count_sent >= target ? 0 : 1;
}
