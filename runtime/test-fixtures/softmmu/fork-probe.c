/* fork-probe.c — the MMU-native fork ENGINE-mechanism fixture (#129 Track B).
 *
 * Adapted from spikes/asyncify-fork/probe.c for the software-MMU foundation
 * (#128): where the spike proved the asyncify double-return against a VERBATIM
 * memory copy (the NOMMU model), this probe proves it against the MMU model —
 * parent and child are two instances on the SAME shared linear memory, isolated
 * only by per-process page tables with COW (the harness plays the kernel:
 * dup-the-tables + write-protect on "fork", copy-on-write-fault after).
 *
 * Built dylink-style (-fPIC -shared) exactly like real guest binaries, so it
 * imports env.__stack_pointer / env.memory / env.__memory_base — the same
 * import surface the softmmu checked mode requires — then asyncified
 * (`wasm-opt --asyncify --pass-arg=asyncify-imports@env.capture_stack`, the
 * REAL seam import from patches/musl/0010) at build time; the softmmu pass
 * (`instrument({checked:true})`) is applied at TEST time like the other softmmu
 * fixtures, proving the asyncify->softmmu pass ORDER composes: asyncify's own
 * stack-image loads/stores are translated, so the ctl buffer + captured stack
 * live in VIRTUAL space and COW-isolate per side after the fork.
 *
 * Mirrors the musl 0010 seam shape: a BSS {cur,end} ctl over a BSS stack-image
 * region, armed immediately before capture_stack(). `counter` is the COW
 * isolation witness: written pre-fork (500), incremented post-fork on both
 * sides (parent += pid+1, child += 0+1) — with correct COW the two sides read
 * back different values through the same virtual address.
 *
 * The checked-mode contract needs: import __wasm_syscall_2 (the fault syscall
 * — poke_syscall() keeps the import alive; never called at runtime), import
 * __stack_pointer (dylink gives it), export __get_tls_base (the constant stub
 * below, mirroring the hand-built checked fixtures).
 */
extern int capture_stack(void *ctl);
extern void log_i(int);
extern int __wasm_syscall_2(int sp, int tp, int nr, int a, int b);

__attribute__((export_name("__get_tls_base"))) int __get_tls_base(void) { return 0x1234; }
__attribute__((export_name("poke_syscall"))) int poke_syscall(void) {
	return __wasm_syscall_2(0, 0, -1, 0, 0);
}

/* All state is BSS-only (no active data segments), so instantiating the child
 * on the same memory clobbers nothing — same property the real guest relies on
 * (__wasm_init_memory's atomic once-guard; here there is simply no data). */
static volatile int counter; /* COW isolation witness */
static struct {
	unsigned cur, end;
} fork_ctl; /* asyncify control buffer (musl 0010 shape) */
static char fork_stack[4096] __attribute__((aligned(16)));

__attribute__((noinline)) static int do_fork(void) {
	fork_ctl.cur = (unsigned)(unsigned long)fork_stack;
	fork_ctl.end = (unsigned)(unsigned long)fork_stack + sizeof fork_stack;
	return capture_stack(&fork_ctl);
}

/* a live local + a real call frame must survive the unwind/rewind */
__attribute__((noinline)) static int deep(int seed) {
	log_i(1111 + seed); /* pre-fork marker — must fire exactly once, parent only */
	return do_fork(); /* the fork point, one frame deep */
}

__attribute__((export_name("run"))) void run(void) {
	volatile int salt = 7; /* live local (shadow stack) across the fork point */
	counter = 500;
	int pid = deep(salt - 7);
	counter += pid + 1; /* the COW write: faults RO -> private copy per side */
	log_i(pid); /* parent: child pid; child: 0 */
	log_i(counter); /* parent: 500+pid+1; child: 501 — DIFFERENT via one VA */
	log_i(salt); /* live-local survived the rewind: 7 on both sides */
}
