// The "main program" of the dylink loader tests — plays the role a real guest
// binary (built by wasm-cross.nix) plays: exports everything (--export-all),
// owns the malloc arena, and defines symbols side modules import.
int main_data = 1000;

int main_helper(int x) { return x + main_data; }

// Address-taken at build time -> lands in the elem segment (has a table slot).
static int taken_cb(int x) { return x * 3; }
int (*main_cb)(int) = taken_cb;

// Exported but NOT address-taken -> no elem slot; dlsym must dynamic-install.
int not_taken(int x) { return x + 7; }

// A trivial bump allocator standing in for musl malloc (the guest allocates
// side-module memoryBase itself). Grows from a fixed arena offset.
static unsigned long brk_at = 0x10000;
unsigned long alloc(unsigned long n, unsigned long align) {
  unsigned long a = (brk_at + align - 1) & ~(align - 1);
  brk_at = a + n;
  return a;
}
