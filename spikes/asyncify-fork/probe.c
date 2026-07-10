/* Phase-2 Task-0 spike probe (clang-compiled, freestanding — no libc/kernel).
 *
 * Same double-return proof as probe.wat, but through REAL clang codegen so the
 * spike exercises what Task 2 (musl fork) actually hits: a C shadow stack in
 * linear memory (managed by the __stack_pointer global) with live locals across
 * the fork point, plus a helper call frame on the stack at the moment of unwind.
 *
 * `do_fork` and `log` are host imports. The counter lives in linear memory
 * (static storage) so the verbatim memory copy carries it; post-fork mutation
 * must diverge between the two independent memories.
 *
 * The nested helper (deep()) puts a second C frame on the shadow stack at the
 * unwind point — verifying asyncify rewinds through multiple real frames and
 * lands exactly at the do_fork() call site (B3), not at run()'s entry.
 */
extern int do_fork(void);
extern void log_i(int);

/* volatile: model observable memory state (heap/globals) written BEFORE the
 * fork point. Without it, -O2 folds the pre-fork store into the post-fork one
 * (the file-static is invisible to the extern do_fork/log_i), so "500" would
 * never be in memory at copy time — a real fork-correctness lesson: the child
 * must inherit memory exactly as of the fork call, not a re-derived value. */
static volatile int counter; /* .bss in linear memory — copied verbatim on fork */

/* a live local + a real call frame must survive the unwind/rewind */
__attribute__((noinline)) static int deep(int seed) {
  log_i(1111 + seed); /* pre-fork marker — must fire exactly once */
  int pid = do_fork(); /* the fork point, one frame deep */
  return pid;
}

__attribute__((export_name("run"))) void run(void) {
  volatile int salt = 7; /* live local across the fork point */
  counter = 500;
  int pid = deep(salt - 7);
  counter += pid + 1;
  log_i(pid);     /* RET: parent=token, child=0 */
  log_i(counter); /* isolation witness */
  log_i(salt);    /* live-local survived: must be 7 on both sides */
}
