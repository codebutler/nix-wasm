/* libffi-selftest.c — in-guest unit test for the raw wasm FFI_WASM32 backend.
   Proves f32/f64/i64 by-value ARGUMENTS call correctly (M1). Prints exactly
   "LIBFFI-SELFTEST: ALL PASS" on success. */
#include <ffi.h>
#include <stdint.h>
#include <stdio.h>

static int failed = 0;
#define CHECK(name, cond) do { \
  if (!(cond)) { printf("LIBFFI-SELFTEST: FAIL %s\n", name); failed = 1; return; } \
} while (0)

/* ---- target functions covering the arg/return classes ------------------ */
static int      t_iii(int a, int b, int c)            { return a + b + c; }
static double   t_pdi(void *p, double d, int i)       { return (double)((intptr_t)p) + d + i; }
static double   t_dd(double a, double b)              { return a + b; }
static int64_t  t_Ii(int64_t a, int i)                { return a + i; }
static float    t_fpf(float a, void *p, float b)      { return a + b + (float)((intptr_t)p); }
static int64_t  t_pId(void *p, int64_t a, double d)   { return (int64_t)((intptr_t)p) + a + (int64_t)d; }
static double   t_only_d(double a)                    { return a * 2.0; }

/* ---- cases ------------------------------------------------------------- */
static void c_iii(void) {
  ffi_cif cif; ffi_type *at[3] = { &ffi_type_sint32, &ffi_type_sint32, &ffi_type_sint32 };
  CHECK("prep_iii", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint32, at) == FFI_OK);
  int a=2,b=3,c=4,r=0; void *av[3]={&a,&b,&c};
  ffi_call(&cif,(void(*)(void))t_iii,&r,av);
  CHECK("iii", r == 9);
}
static void c_pdi(void) {
  ffi_cif cif; ffi_type *at[3] = { &ffi_type_pointer, &ffi_type_double, &ffi_type_sint32 };
  CHECK("prep_pdi", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_double, at) == FFI_OK);
  void *p=(void*)100; double d=1.5; int i=2, r_ok; double r=0; void *av[3]={&p,&d,&i};
  ffi_call(&cif,(void(*)(void))t_pdi,&r,av);
  r_ok = (r == 103.5); CHECK("pdi", r_ok);
}
static void c_dd(void) {
  /* two adjacent double args — within the M=MAX_NON_I32(=2) generated bound.
     (NB: a 4-double call would exceed M and is the boundary that aborts loud;
     proving multi-double-arg dispatch needs only 2 within bounds.) */
  ffi_cif cif; ffi_type *at[2]={&ffi_type_double,&ffi_type_double};
  CHECK("prep_dd", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_double, at) == FFI_OK);
  double a=3.5,b=6.5,r=0; void *av[2]={&a,&b};
  ffi_call(&cif,(void(*)(void))t_dd,&r,av);
  CHECK("dd", r == 10.0);
}
static void c_Ii(void) {
  ffi_cif cif; ffi_type *at[2]={&ffi_type_sint64,&ffi_type_sint32};
  CHECK("prep_Ii", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 2, &ffi_type_sint64, at) == FFI_OK);
  int64_t a=5000000000LL; int i=7; int64_t r=0; void *av[2]={&a,&i};
  ffi_call(&cif,(void(*)(void))t_Ii,&r,av);
  CHECK("Ii", r == 5000000007LL);
}
static void c_fpf(void) {
  ffi_cif cif; ffi_type *at[3]={&ffi_type_float,&ffi_type_pointer,&ffi_type_float};
  CHECK("prep_fpf", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_float, at) == FFI_OK);
  float a=1.5f,b=2.0f; void *p=(void*)0; float r=0; void *av[3]={&a,&p,&b};
  ffi_call(&cif,(void(*)(void))t_fpf,&r,av);
  CHECK("fpf", r == 3.5f);
}
static void c_pId(void) {
  ffi_cif cif; ffi_type *at[3]={&ffi_type_pointer,&ffi_type_sint64,&ffi_type_double};
  CHECK("prep_pId", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 3, &ffi_type_sint64, at) == FFI_OK);
  void *p=(void*)1; int64_t a=2; double d=3.9; int64_t r=0; void *av[3]={&p,&a,&d};
  ffi_call(&cif,(void(*)(void))t_pId,&r,av);
  CHECK("pId", r == 6); /* 1 + 2 + (int64_t)3.9 */
}
static void c_only_d(void) {
  ffi_cif cif; ffi_type *at[1]={&ffi_type_double};
  CHECK("prep_only_d", ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_double, at) == FFI_OK);
  double a=21.0, r=0; void *av[1]={&a};
  ffi_call(&cif,(void(*)(void))t_only_d,&r,av);
  CHECK("only_d", r == 42.0);
}

int main(void) {
  c_iii(); c_pdi(); c_dd(); c_Ii(); c_fpf(); c_pId(); c_only_d();
  if (!failed) printf("LIBFFI-SELFTEST: ALL PASS\n");
  return failed;
}
