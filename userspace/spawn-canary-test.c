/* spawn-canary-test — reduced reproducer for the posix_spawn() static-memory
 * corruption found while debugging Xvfb's xkbcomp spawn on the NOMMU wasm
 * guest (worker #6, xchat-irc-setup epic).
 *
 * Evidence that led here: instrumenting a real Xvfb (~12MB .data/.bss, the
 * LARGEST parent binary to ever call posix_spawn() on this guest — busybox/
 * ash/make/sommelier are all small) showed a .data array (ProcVector[135])
 * correct immediately before Popen()'s posix_spawn() call and corrupted
 * (a broad overwrite of adjacent slots too) immediately AFTER posix_spawn()
 * returns, BEFORE the child (xkbcomp) produced any output. So the corruption
 * happens on the spawn/return path itself, not from anything the child does.
 *
 * This program isolates that: a parent with a LARGE PATTERNED static (.bss)
 * array (size is a compile-time knob, -DSPAWN_CANARY_MB=N, default 8) plus a
 * same-size heap buffer for contrast, posix_spawn()s a trivial child (itself,
 * re-invoked with argv[1]="child", which just _exit(0)s immediately — no
 * busybox/exec-of-another-binary dependency, and it isolates the spawn
 * mechanics from anything the child's own body does), waits for it, then
 * scans both buffers for pattern breakage and reports the exact corrupted
 * byte RANGE — the fingerprint of WHAT wrote there (a stack frame? an argv
 * staging buffer? a thread block?) — along with buffer addresses so the
 * overlap with whatever wrote there can be reasoned about numerically.
 *
 * Round 5 (worker #7, third shift; OPT-IN via SPAWN_CANARY_THREADED=1, see
 * main()) — a THREADED variant: a background pthread spins on its own large
 * canary array while the main thread posix_spawn()s the popen shape 16x,
 * isolating whether a second LIVE thread's stack/TLS sharing the arena
 * during __clone(CLONE_VM|CLONE_VFORK) is the hazard (Xvfb runs an input
 * thread; every prior round here is single-threaded).
 *
 * RESULT (this is a SEPARATE finding from the corruption bug above, not a
 * confirmation of it): a busy-compute loop (touch-and-verify + sched_yield()
 * per sweep) in the live thread HANGS THE WHOLE PROCESS INDEFINITELY the
 * instant it starts running concurrently with posix_spawn() — no corruption,
 * just starvation (the main thread/spawn children never get scheduled again).
 * A plain pthread_create()+join() with no ongoing loop, run right after the
 * same prior spawns, is unaffected (rc=0) — it's specifically a still-running
 * compute-bound thread that starves the rest of the process. Swapping the
 * busy loop for a usleep()-based one (same thread lifetime, same "16
 * concurrent spawns" shape, same canary-array touching — DIAG_SLEEP_LOOP,
 * used by scripts/no committed nix package; see git history for the ad hoc
 * build used to prove it) runs completely clean. This says `sched_yield()`
 * does not actually hand control to another runnable task on this engine's
 * cooperative scheduler, while a blocking syscall does — a real, reproducible
 * bug, but a SCHEDULING one, not the ProcVector-style memory corruption Xvfb
 * exhibits (Xvfb's own InputThread should mostly block on I/O, not spin).
 *
 * Round 6 (worker #7, third shift; coordinator-directed CONFIRM 1; runs by
 * DEFAULT, not opt-in — see g_init_canary's doc comment below): a REAL
 * static-initializer (.data) canary, closing the gap rounds 1-4 left (their
 * g_canary is .bss — no data segment exists there to misfire). This is
 * expected to turn this reproducer's gating boot-smoke red until the real
 * fix lands (that's the point: round 6 reproduces the actual bug in the
 * reduced fixture for the first time).
 *
 * Usage: `spawn-canary-test` (harness role) or `spawn-canary-test child`
 * (trivial child role, used internally via posix_spawn's argv).
 *
 * Prints:
 *   SPAWN-CANARY: static_base=0x.. static_end=0x.. heap_base=0x.. heap_end=0x.. stack_probe=0x..
 *   SPAWN-CANARY: clean OK
 * or, on corruption:
 *   SPAWN-CANARY-FAIL: <region> overwrite at offset 0x.., len 0x.., first_bad=0x.., expected=0x.., got=0x..
 *   SPAWN-CANARY-FAIL: FAIL
 */
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#ifndef SPAWN_CANARY_MB
#define SPAWN_CANARY_MB 8
#endif

#define CANARY_SIZE ((size_t)SPAWN_CANARY_MB * 1024u * 1024u)

/* Large static (.bss) canary — this is the region Xvfb's ProcVector[] lives
 * in the shape of (a big statically-allocated array in a huge-.data/.bss
 * binary). Deliberately NOT const-initialized in the source (that would put
 * the whole pattern literally in .data, ballooning the binary); it is filled
 * at runtime instead, so it lives in .bss but is populated before the spawn. */
static unsigned char g_canary[CANARY_SIZE];

static unsigned char pattern_byte(size_t i) {
  /* Deterministic, cheap to recompute — doesn't need to be unique per index,
   * just needs "does byte i still hold what we put there". */
  return (unsigned char)(((i * 31u) + 7u) ^ 0x5au);
}

static void fill_pattern(unsigned char *buf, size_t n) {
  for (size_t i = 0; i < n; i++) buf[i] = pattern_byte(i);
}

/* Scan for corruption; returns 1 if clean, 0 if corrupted (and fills out
 * first_bad/last_bad/first_bad_expected/first_bad_got). */
static int scan_region(const unsigned char *buf, size_t n, size_t *first_bad,
                        size_t *last_bad, size_t *n_bad,
                        unsigned char *first_bad_expected,
                        unsigned char *first_bad_got) {
  size_t fb = (size_t)-1, lb = 0, count = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char want = pattern_byte(i);
    if (buf[i] != want) {
      if (fb == (size_t)-1) {
        fb = i;
        *first_bad_expected = want;
        *first_bad_got = buf[i];
      }
      lb = i;
      count++;
    }
  }
  if (count == 0) return 1;
  *first_bad = fb;
  *last_bad = lb;
  *n_bad = count;
  return 0;
}

static void report_region(const char *name, const unsigned char *buf, size_t n) {
  size_t first_bad = 0, last_bad = 0, n_bad = 0;
  unsigned char exp = 0, got = 0;
  if (scan_region(buf, n, &first_bad, &last_bad, &n_bad, &exp, &got)) {
    printf("SPAWN-CANARY: %s clean (0x%zx bytes checked)\n", name, n);
  } else {
    printf(
        "SPAWN-CANARY-FAIL: %s overwrite at offset 0x%zx (addr=%p), "
        "extent 0x%zx..0x%zx (len 0x%zx, %zu bytes differ), "
        "first_bad_expected=0x%02x first_bad_got=0x%02x\n",
        name, first_bad, (const void *)(buf + first_bad), first_bad, last_bad,
        last_bad - first_bad + 1, n_bad, exp, got);
  }
}

/* Round 5 (worker #7, xchat-irc-setup epic, third shift): a THREADED canary —
 * the one structural difference left between this reproducer and the real
 * Xvfb. Every prior round is single-threaded; Xvfb runs a live input thread
 * (xorg's InputThread) that is touching the shared arena AT THE SAME TIME its
 * main thread calls posix_spawn() for xkbcomp. On this no-fork/CLONE_VM NOMMU
 * guest, posix_spawn's underlying __clone(CLONE_VM|CLONE_VFORK) shares the
 * WHOLE address space (and thus the whole wasm linear memory) with the
 * spawning process — including any OTHER live thread's stack/TLS — while the
 * clone-with-fn child is mid-flight. That is exactly the class of hazard
 * patches/busybox/0008 hit one level down (a shared-argv mutation racing a
 * concurrent clone), one level up: does a second thread's stack, TLS, or its
 * own static data end up sharing/colliding with whatever the spawn/exec path
 * allocates for the child?
 *
 * A second, independent large static (.bss) array — g_thread_canary — is
 * owned by a background pthread that spins verifying + re-dirtying it in a
 * tight loop (so it's provably mid-execution, not idle, across every spawn).
 * The main thread then posix_spawn()s the EXACT Popen()/xkbcomp shape
 * (round 3's dup2'd-pipe + "/bin/sh -c ...") repeatedly (NSPAWN times,
 * matching Xvfb's observed ~16 xkbcomp retries in the real bug) while the
 * thread keeps running. Both the main canary (g_canary) AND the thread's own
 * canary (g_thread_canary) are rechecked after every spawn. */
#define THREAD_CANARY_SIZE CANARY_SIZE
static unsigned char g_thread_canary[THREAD_CANARY_SIZE];
static atomic_int g_thread_stop = 0;
static atomic_int g_thread_corrupted = 0;
static atomic_long g_thread_first_bad_offset = -1;
static unsigned long g_thread_iterations = 0; /* only read after pthread_join */
static atomic_ulong g_thread_iterations_live = 0;
static void *g_thread_stack_probe = NULL;

static void *canary_thread_fn(void *arg) {
  (void)arg;
  printf("SPAWN-CANARY: canary_thread_fn: entered\n");
  fflush(stdout);
  int local_probe;
  g_thread_stack_probe = (void *)&local_probe;
  fill_pattern(g_thread_canary, THREAD_CANARY_SIZE);
  printf("SPAWN-CANARY: canary_thread_fn: fill_pattern done, entering loop "
         "(DIAG_SLEEP_LOOP=%d)\n",
#ifdef DIAG_SLEEP_LOOP
         1
#else
         0
#endif
  );
  fflush(stdout);
#ifdef DIAG_SLEEP_LOOP
  /* Diagnostic build (worker #7): a sleep-based loop instead of a tight
   * compute+sched_yield() loop, to isolate whether it's SPECIFICALLY a busy
   * compute loop that starves the rest of the process, vs ANY long-lived
   * joinable secondary thread doing so. */
  while (!atomic_load(&g_thread_stop)) {
    unsigned char want = pattern_byte(0);
    if (g_thread_canary[0] != want && atomic_load(&g_thread_corrupted) == 0) {
      atomic_store(&g_thread_first_bad_offset, 0);
      atomic_store(&g_thread_corrupted, 1);
    }
    g_thread_canary[0] = want;
    atomic_fetch_add(&g_thread_iterations_live, 1);
    usleep(2000);
  }
#else
  while (!atomic_load(&g_thread_stop)) {
    /* Touch every page (not every byte — this loop must spin fast enough to
     * overlap many spawns), verify-then-redirty so the array is provably
     * live/dirty, not merely allocated. */
    for (size_t i = 0; i < THREAD_CANARY_SIZE; i += 4096) {
      unsigned char want = pattern_byte(i);
      if (g_thread_canary[i] != want && atomic_load(&g_thread_corrupted) == 0) {
        atomic_store(&g_thread_first_bad_offset, (long)i);
        atomic_store(&g_thread_corrupted, 1);
      }
      g_thread_canary[i] = want;
    }
    atomic_fetch_add(&g_thread_iterations_live, 1);
    /* Yield after each full sweep. A real Xvfb InputThread spends most of
     * its time blocked (not spinning uncontested on the single wasm CPU) —
     * without this, an initial version of this test HUNG indefinitely the
     * instant round 5 started (pthread_create() + spin, standalone
     * pthread-exit-test still passed cleanly beforehand — see the commit
     * message / session notes), consistent with a purely cooperative
     * scheduler that never preempts a tight compute loop to run the
     * clone()d spawn child or wake the waitpid()ing main thread. Keep the
     * yield: it's what makes "a thread is genuinely live across the spawn"
     * observable without starving the very mechanism under test. */
    sched_yield();
  }
#endif
  return NULL;
}

/* Run round 5: NSPAWN popen-shaped spawns with canary_thread_fn live. Returns
 * 1 pass, 0 fail. `heap` is the same scratch heap buffer the other rounds
 * use (rescanned here too, for a 4-way simultaneous check). */
static void *trivial_thread_fn(void *arg) {
  (void)arg;
  return NULL;
}

static int run_threaded_round(unsigned char *heap) {
  if (access("/bin/sh", X_OK) != 0) {
    printf("SPAWN-CANARY: threaded round SKIPPED (no /bin/sh)\n");
    return 1;
  }

  /* Probe: after rounds 1-4's several posix_spawn()s, does even a TRIVIAL
   * joinable pthread_create()+join() (no spin, no shared array) still work?
   * Isolates "any thread creation after prior spawns" from "this specific
   * spinning/atomic canary thread". */
  printf("SPAWN-CANARY: threaded round: probing trivial pthread_create+join post-spawns...\n");
  fflush(stdout);
  pthread_t probe_th;
  int prc0 = pthread_create(&probe_th, NULL, trivial_thread_fn, NULL);
  if (prc0 != 0) {
    printf("SPAWN-CANARY-FAIL: threaded round: trivial pthread_create failed rc=%d\n", prc0);
    return 0;
  }
  int jrc0 = pthread_join(probe_th, NULL);
  printf("SPAWN-CANARY: threaded round: trivial pthread_create+join post-spawns "
         "OK (join rc=%d)\n",
         jrc0);
  fflush(stdout);

  pthread_t th;
  int prc = pthread_create(&th, NULL, canary_thread_fn, NULL);
  if (prc != 0) {
    printf("SPAWN-CANARY: threaded round SKIPPED (pthread_create failed rc=%d)\n", prc);
    return 1;
  }
  /* Give the thread a moment to actually start spinning before the first
   * spawn, so it's genuinely mid-execution, not still in pthread_create(). */
  usleep(50000);
  printf("SPAWN-CANARY: threaded round: g_thread_canary=[%p..%p] thread_stack_probe=%p\n",
         (void *)g_thread_canary, (void *)(g_thread_canary + THREAD_CANARY_SIZE - 1),
         g_thread_stack_probe);

  /* Probe 2: does the SPINNING thread alone (no concurrent posix_spawn) join
   * back down cleanly? Isolates "a live spinning thread, full stop" from "a
   * live spinning thread AT THE SAME TIME AS a posix_spawn call". */
  printf("SPAWN-CANARY: threaded round: probing spin-thread stop+join with NO "
         "concurrent spawn...\n");
  fflush(stdout);
  atomic_store(&g_thread_stop, 1);
  int jrc1 = pthread_join(th, NULL);
  printf("SPAWN-CANARY: threaded round: spin-thread stop+join with no spawn OK "
         "(join rc=%d, iters=%lu)\n",
         jrc1, (unsigned long)atomic_load(&g_thread_iterations_live));
  fflush(stdout);

  /* Re-launch a fresh spin thread for the actual concurrent-with-spawn test
   * below. */
  atomic_store(&g_thread_stop, 0);
  atomic_store(&g_thread_iterations_live, 0);
  prc = pthread_create(&th, NULL, canary_thread_fn, NULL);
  if (prc != 0) {
    printf("SPAWN-CANARY: threaded round SKIPPED (2nd pthread_create failed rc=%d)\n", prc);
    return 1;
  }
  usleep(50000);
  printf("SPAWN-CANARY: threaded round: relaunched spin thread; starting %d "
         "concurrent spawns...\n",
         16);
  fflush(stdout);

  const int NSPAWN = 16; /* matches Xvfb's observed xkbcomp Popen() retry count */
  int ok = 1;
  for (int i = 0; i < NSPAWN && ok; i++) {
    fill_pattern(g_canary, CANARY_SIZE);
    fill_pattern(heap, CANARY_SIZE);

    int pdes[2];
    if (pipe(pdes) != 0) {
      fprintf(stderr, "spawn-canary-test[threaded/iter%d]: pipe failed: %s\n", i,
              strerror(errno));
      ok = 0;
      break;
    }
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    if (pdes[1] != 1) posix_spawn_file_actions_adddup2(&fa, pdes[1], 1);
    posix_spawn_file_actions_addclose(&fa, pdes[0]);
    if (pdes[1] != 1) posix_spawn_file_actions_addclose(&fa, pdes[1]);

    char *sh_argv[] = {(char *)"sh", (char *)"-c", (char *)"true", NULL};
    pid_t pid;
    int rv = posix_spawn(&pid, "/bin/sh", &fa, NULL, sh_argv, environ);
    posix_spawn_file_actions_destroy(&fa);
    close(pdes[1]);
    if (rv != 0) {
      fprintf(stderr, "spawn-canary-test[threaded/iter%d]: posix_spawn failed: %s\n", i,
              strerror(rv));
      close(pdes[0]);
      ok = 0;
      break;
    }
    char buf[256];
    while (read(pdes[0], buf, sizeof(buf)) > 0) {
    }
    close(pdes[0]);
    int st = 0;
    waitpid(pid, &st, 0);

    size_t fb = 0, lb = 0, nb = 0;
    unsigned char e = 0, g = 0;
    int sc = scan_region(g_canary, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
    int hc = scan_region(heap, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
    int tc = !atomic_load(&g_thread_corrupted);
    if (!sc || !hc || !tc) {
      printf("SPAWN-CANARY-FAIL: threaded/iter%d main_static=%d main_heap=%d "
             "thread_canary=%d thread_first_bad=0x%lx main_first_bad=0x%zx "
             "thread_iters_so_far=%lu\n",
             i, sc, hc, tc, (long)atomic_load(&g_thread_first_bad_offset), fb,
             (unsigned long)atomic_load(&g_thread_iterations_live));
      report_region("threaded/main-static", g_canary, CANARY_SIZE);
      report_region("threaded/main-heap", heap, CANARY_SIZE);
      report_region("threaded/thread-canary", g_thread_canary, THREAD_CANARY_SIZE);
      ok = 0;
    }
  }

  atomic_store(&g_thread_stop, 1);
  pthread_join(th, NULL);
  g_thread_iterations = atomic_load(&g_thread_iterations_live);
  if (ok) {
    printf("SPAWN-CANARY: threaded (%d spawns, %lu thread iters) clean\n", NSPAWN,
           g_thread_iterations);
  }
  return ok;
}

/* Round 6 (worker #7, third shift; coordinator-directed CONFIRM 1): a REAL
 * static-initializer (.data) FUNCTION-POINTER canary — ProcVector[]-shaped.
 *
 * FIRST CUT (superseded, kept as a lesson): a plain `uint32_t[]` with a GNU
 * range-designated nonzero static initializer ran 16 spawns completely
 * clean — no reversion. That is NOT a refutation of the xkbdbg finding; it
 * is a design bug in the canary. Every guest executable here links as a
 * `-shared` dylink module (PIC), and `__wasm_apply_data_relocs()` only has
 * anything to *reapply* where the compiler emitted an actual RELOCATION
 * entry into the data segment — which only happens for POINTER-valued
 * initializers (an embedded address, fixed up relative to `__memory_base`
 * at instantiation). A segment of plain integers has zero relocations, so
 * calling that function again is a genuine no-op for it. `ProcVector[]` is
 * exactly the pointer-valued case: `dix/tables.c` statically initializes it
 * to an array of FUNCTION POINTERS (`ProcBadRequest` repeated), and
 * `AddExtension()` mutates individual slots to other function pointers
 * (`ProcXkbDispatch`) at runtime — so g_init_canary below mirrors that
 * shape precisely: a static array of `canary_fn_t` (function pointers),
 * default-initialized to `canary_func_a`, mutated to `canary_func_b` right
 * before each spawn, rescanned after. Reverting to `canary_func_a` is the
 * exact Xvfb mechanism, reproduced here for the first time. */
typedef void (*canary_fn_t)(void);
static void canary_func_a(void) {}
static void canary_func_b(void) {}

#define INIT_CANARY_COUNT (64u * 1024u) /* 64K fn ptrs = 256KB on wasm32 (4-byte ptrs) */
static canary_fn_t g_init_canary[INIT_CANARY_COUNT] = {
    [0 ... INIT_CANARY_COUNT - 1] = canary_func_a};

static int run_init_canary_round(void) {
  if (access("/bin/sh", X_OK) != 0) {
    printf("SPAWN-CANARY: init-canary round SKIPPED (no /bin/sh)\n");
    return 1;
  }
  printf(
      "SPAWN-CANARY: init-canary round: g_init_canary=[%p..%p] "
      "canary_func_a=%p canary_func_b=%p (0x%x bytes)\n",
      (void *)g_init_canary, (void *)(g_init_canary + INIT_CANARY_COUNT - 1),
      (void *)canary_func_a, (void *)canary_func_b,
      (unsigned)(INIT_CANARY_COUNT * sizeof(canary_fn_t)));

  const int NSPAWN = 16; /* matches Xvfb's observed xkbcomp Popen() retry count */
  int ok = 1;
  for (int i = 0; i < NSPAWN && ok; i++) {
    /* Mutate away from the static default — the "AddExtension() mutates
     * ProcVector[] away from ProcBadRequest" step. */
    for (size_t j = 0; j < INIT_CANARY_COUNT; j++) g_init_canary[j] = canary_func_b;

    int pdes[2];
    if (pipe(pdes) != 0) {
      fprintf(stderr, "spawn-canary-test[init-canary/iter%d]: pipe failed: %s\n", i,
              strerror(errno));
      ok = 0;
      break;
    }
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    if (pdes[1] != 1) posix_spawn_file_actions_adddup2(&fa, pdes[1], 1);
    posix_spawn_file_actions_addclose(&fa, pdes[0]);
    if (pdes[1] != 1) posix_spawn_file_actions_addclose(&fa, pdes[1]);

    char *sh_argv[] = {(char *)"sh", (char *)"-c", (char *)"true", NULL};
    pid_t pid;
    int rv = posix_spawn(&pid, "/bin/sh", &fa, NULL, sh_argv, environ);
    posix_spawn_file_actions_destroy(&fa);
    close(pdes[1]);
    if (rv != 0) {
      fprintf(stderr, "spawn-canary-test[init-canary/iter%d]: posix_spawn failed: %s\n", i,
              strerror(rv));
      close(pdes[0]);
      ok = 0;
      break;
    }
    char buf[256];
    while (read(pdes[0], buf, sizeof(buf)) > 0) {
    }
    close(pdes[0]);
    int st = 0;
    waitpid(pid, &st, 0);

    size_t n_reverted = 0, n_other_wrong = 0;
    size_t first_reverted = (size_t)-1, first_other_wrong = (size_t)-1;
    for (size_t j = 0; j < INIT_CANARY_COUNT; j++) {
      canary_fn_t got = g_init_canary[j];
      if (got != canary_func_b) {
        if (got == canary_func_a) {
          n_reverted++;
          if (first_reverted == (size_t)-1) first_reverted = j;
        } else {
          n_other_wrong++;
          if (first_other_wrong == (size_t)-1) first_other_wrong = j;
        }
      }
    }
    if (n_reverted || n_other_wrong) {
      printf(
          "SPAWN-CANARY-FAIL: init-canary/iter%d REVERTED-TO-STATIC-INIT=%zu "
          "other-wrong=%zu first_reverted_index=%zd (addr=%p) "
          "first_other_wrong_index=%zd (addr=%p)\n",
          i, n_reverted, n_other_wrong, (ssize_t)first_reverted,
          first_reverted == (size_t)-1 ? NULL : (void *)&g_init_canary[first_reverted],
          (ssize_t)first_other_wrong,
          first_other_wrong == (size_t)-1 ? NULL : (void *)&g_init_canary[first_other_wrong]);
      ok = 0;
    }
  }
  if (ok) {
    printf("SPAWN-CANARY: init-canary (%d spawns) clean\n", NSPAWN);
  }
  return ok;
}

/* Run one spawn/waitpid/rescan round. `label` tags the report lines;
 * `path`/child_argv describe what to posix_spawn(). Returns 1 pass, 0 fail. */
static int run_round(const char *label, const char *path, char *const child_argv[],
                      unsigned char *heap) {
  fill_pattern(g_canary, CANARY_SIZE);
  fill_pattern(heap, CANARY_SIZE);

  pid_t pid;
  int rc = posix_spawn(&pid, path, NULL, NULL, child_argv, environ);
  if (rc != 0) {
    fprintf(stderr, "spawn-canary-test[%s]: posix_spawn failed: %s\n", label,
            strerror(rc));
    return 0;
  }

  int st = 0;
  if (waitpid(pid, &st, 0) != pid) {
    fprintf(stderr, "spawn-canary-test[%s]: waitpid failed: %s\n", label,
            strerror(errno));
    return 0;
  }
  if (!(WIFEXITED(st))) {
    printf("SPAWN-CANARY[%s]: child did not exit cleanly (status=0x%x)\n", label, st);
  }

  char sname[64], hname[64];
  snprintf(sname, sizeof(sname), "%s/static", label);
  snprintf(hname, sizeof(hname), "%s/heap", label);
  report_region(sname, g_canary, CANARY_SIZE);
  report_region(hname, heap, CANARY_SIZE);

  size_t sfb = 0, slb = 0, snb = 0, hfb = 0, hlb = 0, hnb = 0;
  unsigned char se = 0, sg = 0, he = 0, hg = 0;
  int static_clean = scan_region(g_canary, CANARY_SIZE, &sfb, &slb, &snb, &se, &sg);
  int heap_clean = scan_region(heap, CANARY_SIZE, &hfb, &hlb, &hnb, &he, &hg);
  return static_clean && heap_clean;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "child") == 0) {
    /* Trivial child — deliberately does almost nothing, so any corruption
     * observed by the parent is attributable to the spawn/return mechanics,
     * not to anything the child computes. */
    _exit(0);
  }

  unsigned char *heap = malloc(CANARY_SIZE);
  if (!heap) {
    fprintf(stderr, "spawn-canary-test: malloc failed\n");
    return 2;
  }

  int stack_probe_local;
  printf(
      "SPAWN-CANARY: static_base=%p static_end=%p heap_base=%p heap_end=%p "
      "stack_probe=%p size=0x%zx\n",
      (void *)g_canary, (void *)(g_canary + CANARY_SIZE - 1), (void *)heap,
      (void *)(heap + CANARY_SIZE - 1), (void *)&stack_probe_local, CANARY_SIZE);
  fflush(stdout);

  /* Round 1: self-exec — the child execve()s a fresh copy of THIS binary
   * (same size static image), then _exit(0)s immediately via the "child"
   * argv[1] role. Isolates the clone()/posix_spawn() child-stack-setup
   * mechanics from cross-binary exec. */
  char *self_argv[] = {argv[0], (char *)"child", NULL};
  int r1 = run_round("self", argv[0], self_argv, heap);

  /* Round 2: cross-binary exec — the child execve()s into /bin/busybox
   * (a real, differently-sized binary, argv[0]="busybox" argv[1]="true"),
   * matching Xvfb's real xkbcomp shape more closely: the child's exec()
   * replaces its image with a DIFFERENT program, which is exactly where
   * the Xvfb corruption was observed to already have happened by the time
   * posix_spawn() returned. Skipped if busybox isn't present (e.g. a
   * standalone build without it). */
  int r2 = 1;
  if (access("/bin/busybox", X_OK) == 0) {
    char *bb_argv[] = {(char *)"busybox", (char *)"true", NULL};
    r2 = run_round("busybox-exec", "/bin/busybox", bb_argv, heap);
  } else {
    printf("SPAWN-CANARY: busybox-exec round SKIPPED (no /bin/busybox)\n");
  }

  /* Round 3: the EXACT shape of Xvfb's Popen() (patches/xserver/0001-popen-
   * posix-spawn.patch, os/utils.c): posix_spawn_file_actions dup2'ing a pipe
   * fd onto stdout, spawning "/bin/sh -c <command>" — which, since /bin/sh is
   * busybox's forkshell ash (NOT a plain exec target), itself clone-with-fns
   * a grandchild to run <command>. Two levels of clone/exec plus file-action
   * fd surgery, unlike rounds 1/2's plain single-level spawn. This is where
   * the real Xvfb bug (xkbcomp via Popen) actually lives. */
  int r3 = 1;
  if (access("/bin/sh", X_OK) == 0) {
    fill_pattern(g_canary, CANARY_SIZE);
    fill_pattern(heap, CANARY_SIZE);

    int pdes[2];
    if (pipe(pdes) != 0) {
      fprintf(stderr, "spawn-canary-test[popen]: pipe failed: %s\n", strerror(errno));
      r3 = 0;
    } else {
      posix_spawn_file_actions_t fa;
      posix_spawn_file_actions_init(&fa);
      if (pdes[1] != 1) posix_spawn_file_actions_adddup2(&fa, pdes[1], 1);
      posix_spawn_file_actions_addclose(&fa, pdes[0]);
      if (pdes[1] != 1) posix_spawn_file_actions_addclose(&fa, pdes[1]);

      char *sh_argv[] = {(char *)"sh", (char *)"-c",
                          (char *)"echo spawn-canary-popen-child; true", NULL};
      pid_t pid;
      int rv = posix_spawn(&pid, "/bin/sh", &fa, NULL, sh_argv, environ);
      posix_spawn_file_actions_destroy(&fa);
      close(pdes[1]);

      if (rv != 0) {
        fprintf(stderr, "spawn-canary-test[popen]: posix_spawn failed: %s\n",
                strerror(rv));
        close(pdes[0]);
        r3 = 0;
      } else {
        char buf[256];
        ssize_t n;
        while ((n = read(pdes[0], buf, sizeof(buf))) > 0) {
          fwrite(buf, 1, (size_t)n, stdout);
        }
        close(pdes[0]);
        int st = 0;
        waitpid(pid, &st, 0);

        report_region("popen/static", g_canary, CANARY_SIZE);
        report_region("popen/heap", heap, CANARY_SIZE);
        size_t fb = 0, lb = 0, nb = 0;
        unsigned char e = 0, g = 0;
        int sc = scan_region(g_canary, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
        int hc = scan_region(heap, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
        r3 = sc && hc;
      }
    }
  } else {
    printf("SPAWN-CANARY: popen round SKIPPED (no /bin/sh)\n");
  }

  /* Round 4: fragment the heap/VMA space first (many varied mallocs, half
   * freed in an interleaved pattern — approximating the allocator state a
   * long-running, heavily-mmap'ing process like Xvfb has built up by the
   * time it reaches Popen(), unlike this program's otherwise-pristine
   * address space), then repeat the popen-shaped spawn several times: if
   * the bug depends on allocator/VMA state rather than sheer .data size, a
   * single clean pristine-heap run (rounds 1-3) would miss it. */
  int r4 = 1;
  if (access("/bin/sh", X_OK) == 0) {
#define NFRAG 256
    void *frag[NFRAG];
    for (int i = 0; i < NFRAG; i++) {
      size_t sz = (size_t)((i * 4177 + 131) % 65536) + 16;
      frag[i] = malloc(sz);
      if (frag[i]) memset(frag[i], 0x33, sz);
    }
    for (int i = 0; i < NFRAG; i += 2) {
      free(frag[i]);
      frag[i] = NULL;
    }
    for (int i = 1; i < NFRAG; i += 4) {
      free(frag[i]);
      frag[i] = NULL;
    }

    for (int iter = 0; iter < 20 && r4; iter++) {
      fill_pattern(g_canary, CANARY_SIZE);
      fill_pattern(heap, CANARY_SIZE);

      int pdes[2];
      if (pipe(pdes) != 0) {
        r4 = 0;
        break;
      }
      posix_spawn_file_actions_t fa;
      posix_spawn_file_actions_init(&fa);
      if (pdes[1] != 1) posix_spawn_file_actions_adddup2(&fa, pdes[1], 1);
      posix_spawn_file_actions_addclose(&fa, pdes[0]);
      if (pdes[1] != 1) posix_spawn_file_actions_addclose(&fa, pdes[1]);

      char *sh_argv[] = {(char *)"sh", (char *)"-c", (char *)"true", NULL};
      pid_t pid;
      int rv = posix_spawn(&pid, "/bin/sh", &fa, NULL, sh_argv, environ);
      posix_spawn_file_actions_destroy(&fa);
      close(pdes[1]);
      if (rv != 0) {
        close(pdes[0]);
        r4 = 0;
        break;
      }
      char buf[256];
      while (read(pdes[0], buf, sizeof(buf)) > 0) {
      }
      close(pdes[0]);
      int st = 0;
      waitpid(pid, &st, 0);

      /* Also churn the fragmented allocations between iterations, so the
       * allocator's free-list/VMA layout keeps shifting run to run. */
      int idx = (iter * 7 + 3) % NFRAG;
      free(frag[idx]);
      frag[idx] = malloc((size_t)((iter * 9973 + 17) % 131072) + 16);

      size_t fb = 0, lb = 0, nb = 0;
      unsigned char e = 0, g = 0;
      int sc = scan_region(g_canary, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
      int hc = scan_region(heap, CANARY_SIZE, &fb, &lb, &nb, &e, &g);
      if (!sc || !hc) {
        printf("SPAWN-CANARY-FAIL: fragmented/iter%d static=%d heap=%d "
               "first_bad_static=0x%zx\n",
               iter, sc, hc, fb);
        report_region("fragmented/static", g_canary, CANARY_SIZE);
        report_region("fragmented/heap", heap, CANARY_SIZE);
        r4 = 0;
      }
    }
    if (r4) printf("SPAWN-CANARY: fragmented (20 iters) clean\n");
#undef NFRAG
  } else {
    printf("SPAWN-CANARY: fragmented round SKIPPED (no /bin/sh)\n");
  }

  /* Round 5: threaded canary — see run_threaded_round's doc comment. OPT-IN
   * via SPAWN_CANARY_THREADED=1: this round found a REAL, separate bug (a
   * busy-compute+sched_yield() loop in a live secondary thread starves the
   * rest of the process — scheduler starvation, not memory corruption; see
   * the doc comment). That hang is NOT the Xvfb corruption bug this
   * reproducer targets, and spawn-canary-test's plain invocation is a GATING
   * regression test (nix-wasm.yml boot-smoke) — a hang here would turn an
   * unrelated finding into a false CI failure. Default: skipped (rounds 1-4
   * only, unchanged behavior). */
  int r5 = 1;
  if (getenv("SPAWN_CANARY_THREADED")) {
    r5 = run_threaded_round(heap);
  } else {
    printf("SPAWN-CANARY: threaded round SKIPPED (set SPAWN_CANARY_THREADED=1 "
           "to run it — see spawn-canary-test.c's round-5 doc comment; it can "
           "HANG, it's a separate scheduler-starvation finding, not this "
           "reproducer's target)\n");
  }

  /* Round 6: static-initializer canary — runs by DEFAULT (see its doc
   * comment above run_init_canary_round and the round-6 file-header note:
   * this is expected to turn the gating boot-smoke red until the real fix
   * lands — that's the point). */
  int r6 = run_init_canary_round();

  fflush(stdout);
  if (r1 && r2 && r3 && r4 && r5 && r6) {
    printf("SPAWN-CANARY: clean OK\n");
    fflush(stdout);
    return 0;
  }
  printf("SPAWN-CANARY-FAIL: FAIL\n");
  fflush(stdout);
  return 1;
}
