/* ping-pace-test — faithful no-network reproducer for issue #75 (busybox FANCY
 * `ping` sends one ICMP echo, receives its reply, then never sends packet #2).
 *
 * ROOT CAUSE (confirmed by ping-pace-probe's control/restart/xcpu/repro matrix):
 * the bug was SA_RESTART, not the I/O-woken-recv sequence theorized below. A
 * SIGALRM handler installed with SA_RESTART (this repro uses signal(), like
 * busybox) was never delivered when it interrupted a blocking syscall — the wasm
 * syscall-restart loop (arch/wasm/kernel/traps.c WASM_SYSCALL_N) re-entered the
 * syscall before _user_mode_tail could run the queued handler. FIXED by
 * patches/kernel/0021 (deliver the handler at the FOOT, return -EINTR — this arch
 * has no transparent restart); this is now a passing regression gate. The
 * rationale below is the pre-matrix hypothesis, kept for history.
 *
 * It mirrors busybox ping's EXACT pacing structure WITHOUT networking, so it
 * runs in the busybox-only boot-smoke (kernel + initramfs, nix:false):
 *
 *   - the SIGALRM handler IS the sender (busybox `sendping4`): it transmits a
 *     "request", bumps the counter, and RE-ARMS a ONE-SHOT setitimer(ITIMER_REAL)
 *     from inside itself (busybox `sendping_tail`: signal()+setitimer), with the
 *     handler installed via signal() — musl gives it SA_RESTART, exactly as
 *     busybox relies on;
 *   - a separate agent (an echo thread = "the host") replies to every request
 *     ASYNCHRONOUSLY, so the main "listen for replies" loop's blocking recv() is
 *     woken by I/O, processes the reply, RE-BLOCKS, and the NEXT one-shot timer
 *     must fire during that re-blocked, timer-LESS wait.
 *
 * This is precisely the sequence sigalrm-test case 3 does NOT cover. Case 3
 * fires a one-shot timer during a SINGLE recv with no traffic ever arriving;
 * here each cycle is
 *     [timer fires -> handler sends req + re-arms one-shot]
 *  -> [reply I/O-wakes recv, recv re-blocks]
 *  -> [next one-shot timer must fire].
 * That intervening async-I/O wakeup + re-block (the CPU goes idle, is woken by
 * the device/IPI, then goes idle AGAIN with the timer still pending) is exactly
 * what differs between `ping -c1` / `for i in 1 2 3; do ping -c1; done` (both
 * work) and continuous `ping` (hangs after one packet).
 *
 * PASS: the one-shot timer keeps firing across I/O-woken, re-blocked recvs and
 *       WANT requests pace out -> prints "...OK", exit 0.
 * BUG (reproduced): only the first (direct) request is ever sent; the timer
 *       never fires again after the first reply I/O-wakes recv -> the loop
 *       blocks forever at sent=1. No in-guest watchdog is used on purpose: a
 *       second timer in this process would reprogram the CPU clockevent and
 *       could MASK the lost ITIMER (the same hazard sigalrm-test case 3 calls
 *       out for nanosleep/short-poll waits). The hang is the signal -- the
 *       smoke harness' own timeout catches it, and the transcript shows the
 *       progress stalling at "sent=1", i.e. the real-world symptom verbatim.
 *
 * Prints "PING-PACE-TEST: sent=<n>" as each reply is processed, then
 * "PING-PACE-TEST: ... OK" when WANT requests have paced out. */
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define WANT 6              /* require this many timer-paced sends */
#define INTERVAL_US 150000  /* one-shot interval (busybox default is 1s; shorter
                             * here only to keep the smoke fast -- the mechanism
                             * is identical) */

static int sv[2];                            /* sv[0]=ping end, sv[1]=host end */
static volatile sig_atomic_t count_sent = 0; /* requests transmitted so far */

/* busybox `sendping4` + `sendping_tail`: send a request, then re-arm a one-shot
 * ITIMER_REAL from within the handler (this very function is the handler). */
static void sendping(int sig) {
  (void)sig;
  char q = 'q';
  ssize_t w = write(sv[0], &q, 1); /* async-signal-safe transmit of "echo req" */
  (void)w;
  count_sent++;

  signal(SIGALRM, sendping); /* musl: re-installs with SA_RESTART, like busybox */
  struct itimerval it;
  memset(&it, 0, sizeof(it));
  it.it_value.tv_usec = INTERVAL_US; /* one-shot: it_interval stays 0 */
  setitimer(ITIMER_REAL, &it, NULL);
}

/* "The host": replies to every request the guest sends, asynchronously, so the
 * main loop's blocking recv is woken by genuine I/O (not data-already-present). */
static void *echo_host(void *arg) {
  (void)arg;
  for (;;) {
    char b;
    ssize_t n = read(sv[1], &b, 1);
    if (n <= 0) {
      if (n < 0 && errno == EINTR) continue;
      break;
    }
    char r = 'p';
    ssize_t w = write(sv[1], &r, 1); /* the echo reply */
    (void)w;
  }
  return NULL;
}

int main(void) {
  if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sv) != 0) {
    perror("socketpair");
    return 2;
  }

  pthread_t host;
  if (pthread_create(&host, NULL, echo_host, NULL) != 0) {
    perror("pthread_create");
    return 2;
  }

  /* busybox ping4: the FIRST request is sent directly from the main flow
   * (arming the first one-shot timer); thereafter the handler paces them. */
  sendping(0);

  /* busybox ping4's "listen for replies" loop: a timer-LESS blocking recv. */
  while (count_sent < WANT) {
    char b;
    ssize_t n = recv(sv[0], &b, sizeof(b), 0);
    if (n < 0) {
      if (errno == EINTR) continue; /* (SA_RESTART usually avoids this) */
      perror("recv");
      break;
    }
    printf("PING-PACE-TEST: sent=%d\n", count_sent);
    fflush(stdout);
  }

  if (count_sent >= WANT) {
    printf("PING-PACE-TEST: paced %d one-shot timers re-armed-in-handler "
           "across I/O-woken recv OK\n",
           count_sent);
    fflush(stdout);
    return 0;
  }
  return 1;
}
