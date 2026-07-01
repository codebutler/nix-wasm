// softmmu spike — measure the marginal cost of routing every wasm load/store
// through a software page-table translate (single-level, identity-mapped), vs a
// plain access. This is the WAVEN model reduced to a controlled microbench, run
// under V8 (the engine pc ships). See FINDINGS.md.
//
// The translate does exactly what a software MMU does per access:
//   pte  = pagetable[vaddr >> 12]      // one forced memory load (volatile → no hoist)
//   phys = pte + (vaddr & 0xfff)       // shift already done; mask + add
// With an identity page table (pte = page<<12) phys == vaddr, so results match the
// baseline and the two variants are directly comparable.
//
// Build: see build.sh.  -ffreestanding -fno-builtin -nostdlib, no libc.

typedef unsigned u32;

#define DATA_INTS (16u * 1024u * 1024u)      // 64 MB working area
#define PAGES     ((DATA_INTS * 4u) / 4096u) // one PTE per 4 KB page

static u32 data[DATA_INTS];
static u32 pgtable[PAGES + 16];

// xorshift32 — no libc rand.
static u32 rng_state = 0x9e3779b9u;
static inline u32 xrand(void) {
  u32 x = rng_state;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return rng_state = x;
}

// The software-MMU translate. The PTE load is forced (volatile) so it happens
// once per access with no compiler hoisting — the faithful "instrument every
// access" model. vaddr is a byte offset into data[].
static inline u32 xlate(u32 vaddr) {
  u32 pte = *(volatile u32 *)&pgtable[vaddr >> 12];
  return pte + (vaddr & 0xfffu);
}
// Optimizable variant: non-volatile PTE load — the compiler may hoist/CSE it
// (LLVM-after-instrumentation, as WAVEN relies on). Brackets the volatile cost.
static inline u32 xlateo(u32 vaddr) {
  u32 pte = pgtable[vaddr >> 12];
  return pte + (vaddr & 0xfffu);
}
#define IDENT(x) (x)

__attribute__((export_name("init")))
void init(void) {
  for (u32 i = 0; i < DATA_INTS; i++) data[i] = i * 2654435761u;
  for (u32 p = 0; p < PAGES; p++) pgtable[p] = p << 12; // identity mapping
}

// Sattolo's algorithm → a single cycle covering `words` nodes, stored as the
// "next" byte-offset in data[]. Latency-bound pointer chase (nix-eval-like).
__attribute__((export_name("build_chase")))
void build_chase(u32 words) {
  for (u32 i = 0; i < words; i++) data[i] = i * 4u;     // identity offsets
  for (u32 i = words - 1; i > 0; i--) {
    u32 j = xrand() % i;                                 // 0..i-1
    u32 t = data[i]; data[i] = data[j]; data[j] = t;
  }
}

// ---- sequential read: sum over `words`, `reps` passes ----
#define GEN_SEQ(NAME, XL)                                                     \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 words, u32 reps) {                                             \
    u32 s = 0, bytes = words * 4u;                                            \
    for (u32 r = 0; r < reps; r++)                                            \
      for (u32 off = 0; off < bytes; off += 4)                               \
        s += *(u32 *)((char *)data + XL(off));                               \
    return s;                                                                 \
  }
GEN_SEQ(seq_base, IDENT)
GEN_SEQ(seq_xlate, xlate)
GEN_SEQ(seq_xlateo, xlateo)

// ---- strided read: stride 64 B (one cache line), `words` span, `reps` passes ----
#define GEN_STRIDE(NAME, XL)                                                  \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 words, u32 reps) {                                            \
    u32 s = 0, bytes = words * 4u;                                            \
    for (u32 r = 0; r < reps; r++)                                            \
      for (u32 off = 0; off < bytes; off += 64)                              \
        s += *(u32 *)((char *)data + XL(off));                               \
    return s;                                                                 \
  }
GEN_STRIDE(stride_base, IDENT)
GEN_STRIDE(stride_xlate, xlate)
GEN_STRIDE(stride_xlateo, xlateo)

// ---- sequential write ----
#define GEN_STORE(NAME, XL)                                                   \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 words, u32 reps) {                                            \
    u32 bytes = words * 4u;                                                   \
    for (u32 r = 0; r < reps; r++)                                            \
      for (u32 off = 0; off < bytes; off += 4)                               \
        *(u32 *)((char *)data + XL(off)) = off + r;                          \
    return data[words - 1];                                                   \
  }
GEN_STORE(store_base, IDENT)
GEN_STORE(store_xlate, xlate)
GEN_STORE(store_xlateo, xlateo)

// ---- pointer chase: follow the cycle for `steps` ----
#define GEN_CHASE(NAME, XL)                                                   \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 steps) {                                                       \
    u32 off = 0, s = 0;                                                       \
    for (u32 i = 0; i < steps; i++) {                                         \
      off = *(u32 *)((char *)data + XL(off));                                 \
      s += off;                                                               \
    }                                                                         \
    return s;                                                                 \
  }
GEN_CHASE(chase_base, IDENT)
GEN_CHASE(chase_xlate, xlate)
GEN_CHASE(chase_xlateo, xlateo)

// ---- nix-eval shape: lazy value-graph interpreter ----
// A node is 4 u32 at byte offset i*16: [child0_off, child1_off, val, pad].
// build_graph links each node to two random nodes (the value DAG); the walk
// forces/looks-up along data-dependent pointers (defeats prefetch, like thunk
// forcing), does a small primop per node, and memoizes a store back — the real
// nix-eval cost shape: alloc + pointer-chase + modest compute + write-back.
__attribute__((export_name("build_graph")))
void build_graph(u32 nodes) {
  for (u32 i = 0; i < nodes; i++) {
    data[i * 4 + 0] = (xrand() % nodes) * 16u; // child0 byte offset
    data[i * 4 + 1] = (xrand() % nodes) * 16u; // child1 byte offset
    data[i * 4 + 2] = i;                        // val
    data[i * 4 + 3] = 0;                        // pad
  }
}
#define GEN_NIXEVAL(NAME, XL)                                                 \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 steps) {                                                       \
    u32 off = 0, acc = 1, s = 0;                                              \
    for (u32 i = 0; i < steps; i++) {                                         \
      u32 c0 = *(u32 *)((char *)data + XL(off));                              \
      u32 c1 = *(u32 *)((char *)data + XL(off + 4));                          \
      u32 v = *(u32 *)((char *)data + XL(off + 8));                           \
      acc = acc * 31u + v;                                                    \
      *(u32 *)((char *)data + XL(off + 8)) = acc ^ (c0 + c1);                 \
      off = (acc & 1u) ? c0 : c1;                                             \
      s += off;                                                               \
    }                                                                         \
    return s ^ acc;                                                           \
  }
GEN_NIXEVAL(nixeval_base, IDENT)
GEN_NIXEVAL(nixeval_xlate, xlate)
GEN_NIXEVAL(nixeval_xlateo, xlateo)

// ---- mixed: several arithmetic ops per load (realistic dilution) ----
#define GEN_MIXED(NAME, XL)                                                   \
  __attribute__((export_name(#NAME)))                                         \
  u32 NAME(u32 words, u32 reps) {                                            \
    u32 s = 1, bytes = words * 4u;                                            \
    for (u32 r = 0; r < reps; r++)                                            \
      for (u32 off = 0; off < bytes; off += 4) {                             \
        u32 v = *(u32 *)((char *)data + XL(off));                             \
        s = s * 1664525u + 1013904223u;                                      \
        s ^= v; s = (s << 7) | (s >> 25); s += v * 3u;                       \
      }                                                                       \
    return s;                                                                 \
  }
GEN_MIXED(mixed_base, IDENT)
GEN_MIXED(mixed_xlate, xlate)
GEN_MIXED(mixed_xlateo, xlateo)
