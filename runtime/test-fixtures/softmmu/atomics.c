// Atomic memory ops for the softmmu pass (musl pthread shape). Built with
// -matomics; exercises atomic load/store, rmw (add/xchg), and cmpxchg across
// i32/i64. Run under an identity page table → identical to uninstrumented; the
// point is the pass translates the address of each atomic without breaking it.
typedef unsigned u32;
typedef unsigned long long u64;

u32 a_load(u32 *p) { return __atomic_load_n(p, __ATOMIC_SEQ_CST); }
void a_store(u32 *p, u32 v) { __atomic_store_n(p, v, __ATOMIC_SEQ_CST); }
u32 a_add(u32 *p, u32 v) { return __atomic_fetch_add(p, v, __ATOMIC_SEQ_CST); }
u32 a_xchg(u32 *p, u32 v) { return __atomic_exchange_n(p, v, __ATOMIC_SEQ_CST); }
u32 a_cas(u32 *p, u32 expected, u32 desired) {
  __atomic_compare_exchange_n(p, &expected, desired, 0, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
  return expected; // the observed old value
}
u64 a_add64(u64 *p, u64 v) { return __atomic_fetch_add(p, v, __ATOMIC_SEQ_CST); }
