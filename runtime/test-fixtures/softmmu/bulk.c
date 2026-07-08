// bulk.c — bulk-memory ops fixture for the softmmu pass: __builtin_memcpy/
// memset with runtime n lower to memory.copy/memory.fill (-mbulk-memory), and
// the data segment below becomes PASSIVE under --shared-memory, so
// __wasm_init_memory carries a real memory.init.
unsigned char table_data[256] = { 1, 2, 3, 4, 5, 6, 7, 8 };

void *bulk_copy(void *d, void *s, unsigned long n) {
  __builtin_memcpy(d, s, n);
  return d;
}

void bulk_move(void *d, void *s, unsigned long n) {
  __builtin_memmove(d, s, n);
}

void bulk_fill(void *d, int v, unsigned long n) {
  __builtin_memset(d, v, n);
}

unsigned char read_data(int i) {
  return table_data[i & 0xff];
}
