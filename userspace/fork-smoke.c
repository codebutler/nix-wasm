/* fork-smoke.c — Phase 2 Task 1a smoke for the host asyncify build path.
 *
 * Minimal program whose call graph reaches the dedicated capture_stack() host
 * import — enough for wasm-opt --asyncify to instrument it and emit the asyncify
 * control exports (asyncify_start_unwind/stop_unwind/start_rewind/stop_rewind/
 * get_state). Proves the host build path produces a fork-capable module; it is
 * NOT meant to run yet (the real fork() seam lands in musl at Task 2).
 *
 * capture_stack stays an undefined import (host-provided), so the asyncified
 * module imports env.capture_stack — the single unwind point.
 */
extern int capture_stack(void);

volatile int sink; /* observable so the call isn't optimized away */

int main(void) {
  sink = capture_stack();
  return 0;
}
