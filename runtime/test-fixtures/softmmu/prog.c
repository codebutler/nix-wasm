// A real compiled program to instrument: a mix of scalar loads/stores across
// widths + a pointer-chase + arithmetic (the shape softmmu measures). No
// atomics/SIMD (the pass's current opcode coverage). Exports run under a test
// harness that installs an identity page table so results match uninstrumented.
typedef unsigned u32;
typedef unsigned long long u64;

// A working buffer the harness places in memory; the program is given its base.
u32 sum_scan(u32 *a, u32 n) {           // i32 loads
  u32 s = 0;
  for (u32 i = 0; i < n; i++) s += a[i];
  return s;
}
void fill(u32 *a, u32 n, u32 v) {       // i32 stores
  for (u32 i = 0; i < n; i++) a[i] = v + i;
}
u64 widen(unsigned char *p, u32 n) {    // i32.load8_u + i64 mix
  u64 s = 0;
  for (u32 i = 0; i < n; i++) s += (u64)p[i] * (i + 1);
  return s;
}
u32 chase(u32 *next, u32 start, u32 steps) {  // pointer chase (data-dependent)
  u32 p = start;
  for (u32 i = 0; i < steps; i++) p = next[p];
  return p;
}
double dsum(double *d, u32 n) {          // f64 loads
  double s = 0;
  for (u32 i = 0; i < n; i++) s += d[i];
  return s;
}

// Compute-dense: several ALU ops per load — the shape of NORMAL code (logic
// interleaved with memory), where the spike measures ~+1-8% because the
// arithmetic dilutes the per-access translate. An LCG mixed with the loaded value.
u32 mixed(u32 *a, u32 n, u32 seed) {
  u32 acc = seed;
  for (u32 i = 0; i < n; i++) {
    u32 v = a[i];
    acc = acc * 1664525u + 1013904223u;
    acc ^= v + (acc >> 13);
    acc = (acc << 7) | (acc >> 25);
    acc += v * 2654435761u;
  }
  return acc;
}
