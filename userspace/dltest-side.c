/* dltest-side — the side module dltest.c dlopens (#126 Track C / #130).
 * Deliberately self-contained (no libc, no cross-module imports): guest
 * side-module links go through the no-undef allow-list, and cross-module
 * import resolution is covered by the engine unit tests (runtime/
 * dylink.test.js); what THIS exercises in-guest is load / elem / dlsym /
 * ctor / data-symbol resolution end to end. */

int side_ctor_ran = 0;

__attribute__((constructor)) static void side_init(void) { side_ctor_ran = 1; }

int side_answer(int x) { return x * 20 + 2; }

/* Address-taken so the plain build also has an elem slot to serve. */
int (*side_answer_ptr)(int) = side_answer;
