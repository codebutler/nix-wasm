/* dltest — in-guest acceptance for the wasm dlopen/dlsym port (#126 Track C /
 * #130): musl patch 0009 → the __wasm_dl_* host imports → runtime/dylink.js.
 *
 * Exercises, inside the booted guest:
 *   1. dlopen(NULL) + dlsym of one of the program's OWN exported functions
 *      (the GModule g_module_open(NULL) path GtkBuilder autoconnect uses),
 *      then a call through the returned pointer;
 *   2. dlopen of a real side module file (read off the guest FS), dlsym of a
 *      function + a data symbol, ctor execution;
 *   3. dlerror on a missing symbol.
 *
 * The fpcast'd variant of this program (built with dynsym-inject + fpcast-emu,
 * opening the fpcast'd side module) proves the canonical-thunk path — the same
 * binary source, so PASS output is identical.
 *
 * PASS line: `DLTEST: self=1 side=1 ctor=1 err=1 OK`
 */
#include <dlfcn.h>
#include <stdio.h>

#ifndef SIDE_PATH
#define SIDE_PATH "/nix-missing-side-path"
#endif

/* Exported (--export-all), NOT address-taken anywhere: dlsym must still
 * resolve it (raw install on the plain build; injected thunk slot on the
 * dynsym/fpcast build). */
int dltest_self_fn(int x) { return x * 2 + 1; }

int main(void)
{
	int self_ok = 0, side_ok = 0, ctor_ok = 0, err_ok = 0;

	void *self = dlopen(NULL, RTLD_NOW | RTLD_GLOBAL);
	if (self) {
		int (*fn)(int) = (int (*)(int))dlsym(self, "dltest_self_fn");
		if (fn && fn(20) == 41) self_ok = 1;
		else fprintf(stderr, "dltest: self dlsym failed: %s\n", dlerror());
	} else {
		fprintf(stderr, "dltest: dlopen(NULL) failed: %s\n", dlerror());
	}

	void *side = dlopen(SIDE_PATH, RTLD_NOW);
	if (side) {
		int (*answer)(int) = (int (*)(int))dlsym(side, "side_answer");
		if (answer && answer(2) == 42) side_ok = 1;
		else fprintf(stderr, "dltest: side dlsym/call failed: %s\n", dlerror());

		int *ctor_ran = (int *)dlsym(side, "side_ctor_ran");
		if (ctor_ran && *ctor_ran == 1) ctor_ok = 1;
		else fprintf(stderr, "dltest: side ctor did not run\n");

		if (!dlsym(side, "no_such_symbol_xyz") && dlerror()) err_ok = 1;
	} else {
		fprintf(stderr, "dltest: dlopen(%s) failed: %s\n", SIDE_PATH, dlerror());
	}

	printf("DLTEST: self=%d side=%d ctor=%d err=%d %s\n", self_ok, side_ok,
	       ctor_ok, err_ok,
	       (self_ok && side_ok && ctor_ok && err_ok) ? "OK" : "FAIL");
	return !(self_ok && side_ok && ctor_ok && err_ok);
}
