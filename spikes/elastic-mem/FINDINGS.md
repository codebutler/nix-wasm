# Task 0.2: Non-shared Memory VA Reservation

## Hypothesis (ASSUMPTION 2)
A non-shared `WebAssembly.Memory` without an explicit `maximum` should grow lazily — its virtual address space (VmSize) should track committed pages, not a declared maximum.

## Measurements (Node.js v24.16.0, Linux /proc/self/status VmSize)

### Test with N=64 memories:

**Non-shared memories:**
- 64 × `new WebAssembly.Memory({ initial: 4 }); m.grow(8);`
- Per-memory: 12 pages committed (~768 pages total, ~0.75 MiB/memory committed)
- VmSize delta: **524288 MB** total → **8192 MB per memory**
- This represents 0x20000 pages (8 GiB implicit max per memory)

**Shared memories:**
- 64 × `new WebAssembly.Memory({ initial: 4, maximum: 0x2000, shared: true })`
- Per-memory: 0x2000 pages declared max (512 MiB)
- VmSize delta: **524288 MB** total → matches non-shared delta!

### Single-memory verification:

```
1 non-shared (no explicit max):
  VmSize delta: 8388608 kB = 8192 MB = 8 GiB
  → Implicit maximum: 0x20000 pages = 8 GiB

1 shared (maximum: 0x2000):
  VmSize delta: 524288 kB = 512 MB = 512 MiB
  → Explicit maximum: 0x2000 pages = 512 MiB
```

### RSS (resident memory):
- Non-shared RSS delta: 1 MB (for ~768 committed pages)
- Shared RSS delta: 0 MB
- Confirms: VA reserved ≠ pages resident; both reserve VA upfront

## Verdict

**ASSUMPTION 2: REFUTED**

WebAssembly.Memory (both shared and non-shared) reserves a large fixed virtual address space immediately, NOT according to **committed pages**:

1. Every memory reserves ~8 GiB of VA upfront (see follow-up: this is independent of the declared maximum — a 4 GiB addressable + 4 GiB guard region for trap-based bounds checking)
2. Both non-shared and shared reserve their full VA immediately upon creation
3. Committed/resident pages do not affect VA reservation

**Implication:** The elastic-memory design premise (VA ∝ committed, shrinking/growing dynamically) cannot be achieved with WebAssembly.Memory as currently implemented in V8.

---

## Follow-up: does an EXPLICIT SMALL maximum reserve only that much VA?

**Question:** With `maximum: 0x400` (1024 pages = 64 MiB), does VA reservation == the declared maximum, for both memory types?

**Test:** N=64 of each, all `initial:4`, `grow(8)`, `maximum: 0x400`:
- non-shared: `new WebAssembly.Memory({ initial: 4, maximum: 0x400 })`
- shared:     `new WebAssembly.Memory({ initial: 4, maximum: 0x400, shared: true })`

**Result (per memory):**
```
nonShared64MaxDeltaMB_perMem: 8192   (8 GiB)
shared64MaxDeltaMB_perMem:    8192   (8 GiB)
```

**Single-memory cross-checks (varying the declared max):**
```
non-shared, max=0x400  (64 MiB):  VmSize delta = 8192 MB (8 GiB)
shared,     max=0x400  (64 MiB):  VmSize delta = 8192 MB (8 GiB)
shared,     max=0x10   (1 MiB):   VmSize delta = 8192 MB (8 GiB)
```

**Critical observation:** The VA reservation is a **FIXED 8 GiB per WebAssembly.Memory, independent of the declared maximum** (64 MiB, 1 MiB — all reserve 8 GiB). This is V8's wasm32 trap-based bounds-checking guard region: 4 GiB addressable space + 4 GiB guard region. The `maximum` property is even hard-capped at 65536 pages (4 GiB) — `maximum: 0x40000` throws RangeError. The declared maximum does NOT shrink the reservation.

**Verdict:** SMALL-MAX RESERVATION: reservation≈max REFUTED

The reservation is NOT equal to the declared maximum. It is a fixed ~8 GiB guard region per memory regardless of `maximum` (or `shared`). This *strengthens* the ASSUMPTION 2 refutation: not only does VA fail to track committed pages, but it also fails to track the declared maximum — every WebAssembly.Memory costs a fixed 8 GiB of VA on this V8 build (Node v24.16.0, x86-64). The only lever to reduce total VA footprint is to reduce the *number* of memories, not their declared size.
