// A side module: imports main symbols (direct call + GOT data + GOT function
// address), exports its own function/data, has a data reloc + a ctor.
extern int main_helper(int x);      // direct env.main_helper import
extern int main_data;               // GOT.mem.main_data
extern int not_taken(int x);        // GOT.func: address taken below

int side_data = 42;
int *side_reloc_ptr = &side_data;   // needs __wasm_apply_data_relocs
int (*imported_fn_ptr)(int) = not_taken; // GOT.func.not_taken

int ctor_ran = 0;
__attribute__((constructor)) static void init(void) { ctor_ran = 1; }

int side_fn(int a, int b) { return a + b + side_data; }

int call_main(int x) { return main_helper(x) + main_data; }

int call_through_ptr(int x) { return imported_fn_ptr(x); }

// Address-taken local -> elem slot; dlsym("side_taken") must return that slot.
int side_taken(int x) { return x - 5; }
int (*side_taken_ptr)(int) = side_taken;
