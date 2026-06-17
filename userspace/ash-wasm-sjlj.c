/* ash-wasm-sjlj.c — the wasm SjLj runtime helpers for the guest ash build.
 *
 * ash uses setjmp/longjmp for its exit/error control flow (exraise/EXEXIT).
 * musl-wasm forbids longjmp (its longjmp is literally `call abort`, setjmp a
 * no-op), so we compile ash with clang's `-mllvm -wasm-enable-sjlj`, which
 * rewrites setjmp/longjmp into calls to the runtime hooks below + a wasm
 * exception-handling throw/catch on the `__c_longjmp` tag. LLVM-21 ships no
 * standalone implementation of these (they live in Emscripten/wasi-libc), so we
 * provide them here per the WebAssembly tool-conventions SetjmpLongjmp ABI. The
 * throw/catch is entirely within the ash module (longjmp throws, the
 * compiler-generated catch in the setjmp function handles it), so `__c_longjmp`
 * is a MODULE-LOCAL tag — no host/runtime support needed.
 *
 * Compiled with the same -mllvm -wasm-enable-sjlj flags as ash (so the EH target
 * feature is on for __builtin_wasm_throw and the .tagtype directive).
 */
#include <stdint.h>

/* The `__c_longjmp` exception tag: carries one i32 (a pointer to
 * struct __WasmLongjmpArgs). Referenced by both __wasm_longjmp's throw and the
 * compiler-generated catch in every setjmp-using function. */
__asm__(
	".globl __c_longjmp\n"
	".tagtype __c_longjmp i32\n"
	"__c_longjmp:\n"
);

struct __WasmLongjmpArgs {
	void *env;
	int val;
};

/* The layout LLVM's SjLj lowering + these hooks agree on for a jmp_buf. musl's
 * __jmp_buf is unsigned long long[32] (256 bytes) — ample for these 16 bytes. */
struct jmp_buf_impl {
	void *func_invocation_id;
	uint32_t label;
	struct __WasmLongjmpArgs arg;
};

/* setjmp(env): record which function invocation owns this jmp_buf, and the
 * unique (nonzero) label of this setjmp call site. func_invocation_id is the
 * address of a per-invocation local — unique identity, not dereferenced. */
void __wasm_setjmp(void *env, uint32_t label, void *func_invocation_id)
{
	struct jmp_buf_impl *buf = env;
	buf->func_invocation_id = func_invocation_id;
	buf->label = label;
}

/* After a call that threw __c_longjmp, the catch asks: was the longjmp's target
 * jmp_buf (env) set up by a setjmp in THIS function invocation? If so return its
 * label (resume that setjmp returning val); else 0 (rethrow — not ours). */
uint32_t __wasm_setjmp_test(void *env, void *func_invocation_id)
{
	struct jmp_buf_impl *buf = env;
	return buf->func_invocation_id == func_invocation_id ? buf->label : 0;
}

/* longjmp(env, val): throw __c_longjmp carrying (env, val). C requires
 * setjmp to return 1 (not 0) when longjmp passes 0. */
_Noreturn void __wasm_longjmp(void *env, int val)
{
	struct jmp_buf_impl *buf = env;
	if (val == 0)
		val = 1;
	buf->arg.env = env;
	buf->arg.val = val;
	__builtin_wasm_throw(1 /* C_LONGJMP */, &buf->arg);
	__builtin_unreachable();
}
