// Target functions the runtime trampoline calls through the shared table.
// Signatures deliberately span cases the fixed trampoline-table backend can't:
// >24 i32 args, and >2 non-i32 args. Pure arithmetic (no memory) so they work
// as bare funcrefs regardless of instance.
typedef unsigned long long u64;

__attribute__((export_name("add")))
int add(int a, int b) { return a + b; }

__attribute__((export_name("muld")))
double muld(double a, double b) { return a * b; }

__attribute__((export_name("mixf32")))
float mixf32(float a, float b) { return a * b + 1.0f; }

__attribute__((export_name("mixi64")))
u64 mixi64(u64 a, int b) { return a * 3ull + (u64)b; }

// 4 non-i32 args (M=4 > the backend's M=2 bound) + i32 + f64 result
__attribute__((export_name("mix4d")))
double mix4d(double a, double b, double c, double d, int n) {
  return (a + b + c + d) * (double)n;
}

// 30 i32 args (K=30 > the backend's K=24 bound)
__attribute__((export_name("addmany")))
int addmany(int a0,int a1,int a2,int a3,int a4,int a5,int a6,int a7,int a8,int a9,
            int a10,int a11,int a12,int a13,int a14,int a15,int a16,int a17,int a18,int a19,
            int a20,int a21,int a22,int a23,int a24,int a25,int a26,int a27,int a28,int a29) {
  return a0+a1+a2+a3+a4+a5+a6+a7+a8+a9+a10+a11+a12+a13+a14+a15+a16+a17+a18+a19
       + a20+a21+a22+a23+a24+a25+a26+a27+a28+a29;
}
