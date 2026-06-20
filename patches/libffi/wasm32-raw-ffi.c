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

/* ---- arg/return class helpers and key-based dispatch ---------------------- */

/* arg wasm value-class: 0=i32, 1=i64, 2=f32, 3=f64. Aborts on what the raw ABI
   can't pass by value (struct/complex/long double). */
static unsigned arg_class(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_INT: case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32: case FFI_TYPE_POINTER:
      return 0;
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64: return 1;
    case FFI_TYPE_FLOAT:  return 2;
    case FFI_TYPE_DOUBLE: return 3;
    default: wasm_ffi_unsupported("by-value argument type"); return 0;
  }
}

/* return wasm value-class: 0=void,1=u32,2=i64,3=f32,4=f64. */
static unsigned ret_class(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_VOID: return 0;
    case FFI_TYPE_INT: case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32: case FFI_TYPE_POINTER:
      return 1;
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64: return 2;
    case FFI_TYPE_FLOAT:  return 3;
    case FFI_TYPE_DOUBLE: return 4;
    default: wasm_ffi_unsupported("return type"); return 0;
  }
}

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue) {
  ffi_type **at = cif->arg_types;
  void **av = avalue;
  unsigned n = cif->nargs;
  uint64_t key = ((uint64_t)ret_class(cif->rtype) << 40) | ((uint64_t)n << 32);
  for (unsigned i = 0; i < n; i++)
    key |= (uint64_t)arg_class(at[i]) << (2 * i);

  switch (key) {
    #include "wasm-ffi-trampolines.inc"
    default:
      wasm_ffi_unsupported("argument signature outside generated bounds");
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
