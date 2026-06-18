/* -----------------------------------------------------------------------
   wasm32-raw-ffi.c - a NON-emscripten FFI_WASM32 ("raw") backend.

   libffi's stock src/wasm/ffi.c is written entirely in EM_JS — it implements
   ffi_call/closures in JavaScript that the *emscripten* runtime executes
   (convertJsFunctionToWasm, getWasmTableEntry, addFunction, …). Our target is a
   non-emscripten wasm32-linux-musl guest with NO JS host, so that backend can't
   work and won't even compile (#include <emscripten/emscripten.h>).

   libffi's own ffitarget.h already anticipates this: it defines a second wasm
   ABI, FFI_WASM32 ("raw", no structures/varargs/closures), and selects it as
   FFI_DEFAULT_ABI whenever __EMSCRIPTEN__ is undefined — but upstream never
   implemented it ("not implemented!"). This file IS that implementation.

   --- Why the implementation looks the way it does --------------------------
   A fully-general ffi_call is impossible on wasm: an indirect call
   (`call_indirect`) requires a statically-known type signature (a type index)
   at the call site. emscripten escapes this only because a JS host can
   synthesise a wasm function of the right signature at runtime. Without a JS
   host the set of callable signatures must be enumerated at COMPILE time.

   So this backend enumerates the signatures that the raw wasm32 C ABI collapses
   to: on wasm32 (ILP32) every `int`/`unsigned`/`enum`/pointer/`wl_fixed_t`
   argument lowers to a single wasm `i32`, and the common scalar returns are
   void / i32 / i64 / f32 / f64. ffi_call therefore dispatches on (return-class,
   argument-count) through statically-typed trampolines — one `call_indirect`
   type per arity. This is complete and correct for any C function whose every
   parameter is an int/unsigned/enum/pointer (return void/int/pointer/long
   long/float/double) — which covers libwayland's protocol dispatch exactly
   (connection.c builds cifs of ffi_type_{sint,uint}32/pointer args returning
   ffi_type_void) and a large fraction of real C ABIs besides. It is a SHARED
   crossSystem fix, not a wayland-private one.

   What the raw wasm ABI genuinely cannot express, this backend refuses LOUDLY
   (abort with a diagnostic / FFI_BAD_ABI) rather than silently mis-call:
     - a by-value 64-bit / float / double / struct / complex ARGUMENT (the
       caller-side wasm value type then differs from i32, so a fixed i32^N
       trampoline would be the wrong call_indirect signature);
     - variadic calls (wasm passes varargs through a hidden buffer pointer — a
       different convention than fixed params);
     - closures (ffi_prep_closure_loc): they require creating a NEW callable
       wasm function at runtime, which needs host/JS support this platform does
       not have. This matches ffitarget.h's own "closures (not implemented!)".

   Scalar by-value 64-bit/float/double RETURNS are supported (the return type is
   part of each trampoline's static signature); only such ARGUMENTS are not.
   ----------------------------------------------------------------------- */

#include <ffi.h>
#include <ffi_common.h>

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

/* Max argument count we generate trampolines for. libwayland needs
   WL_CLOSURE_MAX_ARGS (20) + 2 (data, target) = 22; 24 leaves margin. */
#define WASM_FFI_MAX_ARGS 24

typedef uint32_t u32;

static void wasm_ffi_unsupported(const char *what)
{
  fprintf(stderr, "libffi(wasm32-raw): unsupported %s — this backend handles "
                  "scalar (i32) arguments only; see wasm32-raw-ffi.c\n", what);
  abort();
}

/* ---- ffi_prep_cif_machdep: validate the cif for the raw ABI -------------- */

ffi_status FFI_HIDDEN
ffi_prep_cif_machdep(ffi_cif *cif)
{
  if (cif->abi != FFI_WASM32)
    return FFI_BAD_ABI;
  /* ffi_prep_cif_machdep_var sets nfixedargs; for the fixed path it equals
     nargs (mirrors the stock emscripten backend's bookkeeping). */
  cif->nfixedargs = cif->nargs;
  if (cif->nargs > WASM_FFI_MAX_ARGS)
    return FFI_BAD_TYPEDEF;
  if (cif->rtype->type == FFI_TYPE_COMPLEX)
    return FFI_BAD_TYPEDEF;
  for (unsigned i = 0; i < cif->nargs; i++)
    if (cif->arg_types[i]->type == FFI_TYPE_COMPLEX)
      return FFI_BAD_TYPEDEF;
  return FFI_OK;
}

ffi_status FFI_HIDDEN
ffi_prep_cif_machdep_var(ffi_cif *cif, unsigned nfixedargs, unsigned ntotalargs)
{
  (void)cif; (void)nfixedargs; (void)ntotalargs;
  /* Variadic calls use a different wasm convention (hidden buffer pointer);
     a fixed i32^N trampoline would be the wrong signature. Refuse. */
  return FFI_BAD_ABI;
}

/* ---- argument loading: each scalar arg -> the i32 the wasm ABI passes ----- */

static u32 load_i32_arg(ffi_type *t, void *p)
{
  switch (t->type) {
    case FFI_TYPE_INT:
    case FFI_TYPE_UINT32:
    case FFI_TYPE_SINT32:
    case FFI_TYPE_POINTER:
      return *(u32 *)p;
    case FFI_TYPE_UINT8:  return (u32)*(uint8_t *)p;
    case FFI_TYPE_SINT8:  return (u32)(int32_t)*(int8_t *)p;
    case FFI_TYPE_UINT16: return (u32)*(uint16_t *)p;
    case FFI_TYPE_SINT16: return (u32)(int32_t)*(int16_t *)p;
    /* 64-bit / float / double / struct as a by-value ARGUMENT cannot ride the
       i32 trampoline — the caller-side wasm value type would differ. */
    default:
      wasm_ffi_unsupported("by-value argument type");
      return 0; /* unreachable */
  }
}

/* ---- the trampolines: one static call_indirect signature per arity -------- */

/* Parameter-type lists (N copies of u32) and argument lists (a[0..N-1]). */
#define P0  void
#define P1  u32
#define P2  P1,u32
#define P3  P2,u32
#define P4  P3,u32
#define P5  P4,u32
#define P6  P5,u32
#define P7  P6,u32
#define P8  P7,u32
#define P9  P8,u32
#define P10 P9,u32
#define P11 P10,u32
#define P12 P11,u32
#define P13 P12,u32
#define P14 P13,u32
#define P15 P14,u32
#define P16 P15,u32
#define P17 P16,u32
#define P18 P17,u32
#define P19 P18,u32
#define P20 P19,u32
#define P21 P20,u32
#define P22 P21,u32
#define P23 P22,u32
#define P24 P23,u32

#define A0
#define A1  a[0]
#define A2  A1,a[1]
#define A3  A2,a[2]
#define A4  A3,a[3]
#define A5  A4,a[4]
#define A6  A5,a[5]
#define A7  A6,a[6]
#define A8  A7,a[7]
#define A9  A8,a[8]
#define A10 A9,a[9]
#define A11 A10,a[10]
#define A12 A11,a[11]
#define A13 A12,a[12]
#define A14 A13,a[13]
#define A15 A14,a[14]
#define A16 A15,a[15]
#define A17 A16,a[16]
#define A18 A17,a[17]
#define A19 A18,a[18]
#define A20 A19,a[19]
#define A21 A20,a[20]
#define A22 A21,a[21]
#define A23 A22,a[22]
#define A24 A23,a[23]

/* For a given return type RT and result-receiving statement RECV, expand the
   full arity switch. RECV is applied to the call expression. */
#define CASE(N, RT, RECV) case N: RECV( ((RT (*)(P##N))fn)(A##N) ); break;

#define DISPATCH(RT, RECV)                                              \
  switch (n) {                                                          \
    CASE(0,  RT, RECV) CASE(1,  RT, RECV) CASE(2,  RT, RECV)            \
    CASE(3,  RT, RECV) CASE(4,  RT, RECV) CASE(5,  RT, RECV)            \
    CASE(6,  RT, RECV) CASE(7,  RT, RECV) CASE(8,  RT, RECV)            \
    CASE(9,  RT, RECV) CASE(10, RT, RECV) CASE(11, RT, RECV)            \
    CASE(12, RT, RECV) CASE(13, RT, RECV) CASE(14, RT, RECV)           \
    CASE(15, RT, RECV) CASE(16, RT, RECV) CASE(17, RT, RECV)           \
    CASE(18, RT, RECV) CASE(19, RT, RECV) CASE(20, RT, RECV)           \
    CASE(21, RT, RECV) CASE(22, RT, RECV) CASE(23, RT, RECV)           \
    CASE(24, RT, RECV)                                                  \
    default: wasm_ffi_unsupported("argument count"); break;            \
  }

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue)
{
  unsigned n = cif->nargs;
  u32 a[WASM_FFI_MAX_ARGS];

  for (unsigned i = 0; i < n; i++)
    a[i] = load_i32_arg(cif->arg_types[i], avalue[i]);

  switch (cif->rtype->type) {
    case FFI_TYPE_VOID: {
      #define RECV_VOID(call) call
      DISPATCH(void, RECV_VOID)
      #undef RECV_VOID
      break;
    }
    case FFI_TYPE_INT:
    case FFI_TYPE_UINT8:  case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32:
    case FFI_TYPE_POINTER: {
      u32 r = 0;
      #define RECV_U32(call) r = (u32)(call)
      DISPATCH(u32, RECV_U32)
      #undef RECV_U32
      /* libffi widens sub-word integer returns to ffi_arg. */
      if (rvalue) *(ffi_arg *)rvalue = (ffi_arg)r;
      break;
    }
    case FFI_TYPE_UINT64:
    case FFI_TYPE_SINT64: {
      uint64_t r = 0;
      #define RECV_U64(call) r = (uint64_t)(call)
      DISPATCH(uint64_t, RECV_U64)
      #undef RECV_U64
      if (rvalue) *(uint64_t *)rvalue = r;
      break;
    }
    case FFI_TYPE_FLOAT: {
      float r = 0;
      #define RECV_F32(call) r = (call)
      DISPATCH(float, RECV_F32)
      #undef RECV_F32
      if (rvalue) *(float *)rvalue = r;
      break;
    }
    case FFI_TYPE_DOUBLE: {
      double r = 0;
      #define RECV_F64(call) r = (call)
      DISPATCH(double, RECV_F64)
      #undef RECV_F64
      if (rvalue) *(double *)rvalue = r;
      break;
    }
    default:
      wasm_ffi_unsupported("return type");
  }
}

/* ---- closures: not expressible without runtime function synthesis --------- */

ffi_status
ffi_prep_closure_loc(ffi_closure *closure, ffi_cif *cif,
                     void (*fun)(ffi_cif *, void *, void **, void *),
                     void *user_data, void *codeloc)
{
  (void)closure; (void)cif; (void)fun; (void)user_data; (void)codeloc;
  /* A closure is a freshly-made callable function pointer; wasm cannot mint one
     at runtime without host support. ffitarget.h marks this "not implemented".
     libwayland does not use closures, so this path is never taken there. */
  return FFI_BAD_ABI;
}
