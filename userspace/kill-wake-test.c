/* kill-wake-test — diagnostic reproducer for issue #35's `timeout 2 sleep 10`
 * hang, reduced to a tiny standalone C program with NO busybox and NO
 * networking.
 *
 * #35 background: continuous busybox `ping` sends one packet then hangs, and
 * `timeout 2 sleep 10` hangs too. The committed sigalrm-test.c proves the
 * kernel's async SIGALRM / setitimer path works for a SELF-armed timer (one-shot
 * alarm, periodic itimer, and a one-shot itimer that interrupts a recvfrom after
 * a posix_spawn). What that test does NOT cover is the OTHER shared ingredient
 * of both failing commands: an asynchronous signal delivered by ANOTHER process
 * (`kill()`), waking a target that is already blocked in a syscall.
 *
 * `timeout 2 sleep 10` depends on exactly that and on NOTHING SIGALRM-related:
 * timeout_wait() is a plain `sleep(1)` loop (coreutils/timeout.c) and the
 * deadline is enforced by a re-exec'd watcher grandchild doing
 * `kill(parent, SIGTERM)`. So the decisive question is: does a signal sent by a
 * sibling/child process wake a process parked in a blocking `nanosleep`, both
 * for the DEFAULT terminate action (timeout's exact path) and for a handler
 * (EINTR)?  This program tests both, all self-reported by a harness that
 * posix_spawn()s itself in three roles (no fork — clean-NOMMU spawn contract).
 *
 *   Case A (default_sigterm): victim blocks in nanosleep(LONG) with NO handler;
 *     a killer sibling kills it with SIGTERM after SHORT. PASS iff the victim is
 *     SIGTERM-terminated at ~SHORT (not LONG, and not never). This is timeout's
 *     exact mechanism (`sleep 10` has no SIGTERM handler).
 *   Case B (handler_sigterm): victim installs a SIGTERM handler and blocks in
 *     nanosleep(LONG); the killer SIGTERMs it after SHORT. PASS iff nanosleep
 *     returns EINTR early and the victim exits 42 at ~SHORT.
 *
 * A 15s SIGALRM watchdog in the harness turns a hang (the #35 symptom) into a
 * loud "WATCHDOG" FAIL line rather than an indefinite block, so the node smoke
 * harness gets a definite verdict.
 *
 * Prints "KILL-WAKE-TEST: <case>=<0|1>" lines, then "...OK" iff both pass. */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

#define LONG_MS 8000 /* the "sleep 10" — must be cut short by the kill */
#define SHORT_MS 300 /* the "timeout 2" — when the killer fires */
#define BOUND_MS 2000 /* a wake counts only if well under LONG_MS */
#define WATCHDOG_S 15 /* harness watchdog: a hang -> FAIL, not an infinite block */

static volatile sig_atomic_t got_term = 0;

static void on_term(int sig) {
  (void)sig;
  got_term = 1;
}

static void nsleep_ms(long ms) {
  struct timespec ts = {.tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL); /* may return early (EINTR) — that is the point */
}

static long ms_since(struct timespec *start) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - start->tv_sec) * 1000 + (now.tv_nsec - start->tv_nsec) / 1000000;
}

/* ---- role: victim with the DEFAULT SIGTERM action (no handler) ---- */
static int run_victim_default(void) {
  nsleep_ms(LONG_MS);
  /* Reached only if SIGTERM never arrived (or did not terminate us): report a
   * non-signal exit so the harness sees the failure. */
  return 0;
}

/* ---- role: victim with a SIGTERM HANDLER (expects EINTR) ---- */
static int run_victim_handler(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_term; /* sa_flags=0 -> no SA_RESTART -> nanosleep EINTRs */
  if (sigaction(SIGTERM, &sa, NULL) != 0) return 1;
  nsleep_ms(LONG_MS);
  return got_term ? 42 : 0; /* 42 iff the async kill woke us early */
}

/* ---- role: killer — wait SHORT, then SIGTERM the target pid ---- */
static int run_killer(pid_t target) {
  nsleep_ms(SHORT_MS);
  kill(target, SIGTERM);
  return 0;
}

static const char *self_path;

static pid_t spawn_self(char *const extra[]) {
  /* argv = { self_path, extra..., NULL } */
  char *argv[5];
  int n = 0;
  argv[n++] = (char *)self_path;
  for (int i = 0; extra[i]; i++) argv[n++] = extra[i];
  argv[n] = NULL;
  pid_t pid;
  if (posix_spawn(&pid, self_path, NULL, NULL, argv, environ) != 0) return -1;
  return pid;
}

/* Run one case: spawn a victim in `role`, spawn a killer targeting it, wait for
 * the victim and classify how/when it ended.  Returns 1 on PASS, 0 on FAIL. */
static int run_case(const char *role, int expect_signal, int expect_exit) {
  char *vrole[] = {(char *)role, NULL};
  pid_t vpid = spawn_self(vrole);
  if (vpid < 0) return 0;

  char pidbuf[16];
  snprintf(pidbuf, sizeof(pidbuf), "%d", (int)vpid);
  char *krole[] = {(char *)"killer", pidbuf, NULL};
  pid_t kpid = spawn_self(krole);
  if (kpid < 0) return 0;

  struct timespec start;
  clock_gettime(CLOCK_MONOTONIC, &start);
  int st = 0;
  if (waitpid(vpid, &st, 0) != vpid) return 0; /* a hang here trips the watchdog */
  long elapsed = ms_since(&start);
  int kst;
  waitpid(kpid, &kst, 0);

  if (elapsed >= BOUND_MS) return 0; /* woke too late (or only via LONG_MS) */
  if (expect_signal)
    return (WIFSIGNALED(st) && WTERMSIG(st) == SIGTERM) ? 1 : 0;
  return (WIFEXITED(st) && WEXITSTATUS(st) == expect_exit) ? 1 : 0;
}

static void on_watchdog(int sig) {
  (void)sig;
  static const char msg[] =
      "KILL-WAKE-TEST: WATCHDOG — a victim never woke from the cross-process "
      "kill (this is #35)\nKILL-WAKE-TEST: FAIL\n";
  ssize_t w = write(1, msg, sizeof(msg) - 1);
  (void)w;
  _exit(1);
}

int main(int argc, char **argv) {
  self_path = argv[0];

  if (argc > 1) {
    if (strcmp(argv[1], "victim-default") == 0) return run_victim_default();
    if (strcmp(argv[1], "victim-handler") == 0) return run_victim_handler();
    if (strcmp(argv[1], "killer") == 0) return run_killer((pid_t)atoi(argv[2]));
    fprintf(stderr, "kill-wake-test: unknown role '%s'\n", argv[1]);
    return 2;
  }

  /* Harness watchdog: SIGALRM is proven to work after a spawn (sigalrm-test
   * case 3), so use it to bound a hang into a definite FAIL. */
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_watchdog;
  sigaction(SIGALRM, &sa, NULL);
  alarm(WATCHDOG_S);

  int a = run_case("victim-default", /*expect_signal=*/1, 0);
  printf("KILL-WAKE-TEST: default_sigterm=%d\n", a);
  fflush(stdout);

  int b = run_case("victim-handler", /*expect_signal=*/0, 42);
  printf("KILL-WAKE-TEST: handler_sigterm=%d\n", b);
  fflush(stdout);

  alarm(0);
  if (a && b) {
    printf("KILL-WAKE-TEST: default + handler cross-process SIGTERM wake OK\n");
    fflush(stdout);
    return 0;
  }
  printf("KILL-WAKE-TEST: FAIL\n");
  fflush(stdout);
  return 1;
}
