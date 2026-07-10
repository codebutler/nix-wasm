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

   This backend enumerates those signatures via a BUILD-TIME generator
   (patches/libffi/gen-trampolines.py) that emits src/wasm/wasm-ffi-trampolines.inc,
   which this file #include's. ffi_call computes a key over the full per-argument
   wasm value-type vector (i32 / i64 / f32 / f64) and dispatches through the
   generated table — one statically-typed call_indirect trampoline per unique
   signature. The generator is bounded by two parameters:
     K = 24 (max argument count for all-i32 calls) / K = 10 (max args for mixed
         calls containing any i64/f32/f64 argument);
     M = 2  (max number of non-i32 wasm value types per call).
   Together these yield ~8375 trampolines and cover:
     • int/unsigned/enum/pointer arguments (all collapse to wasm i32) up to 24
       args — covers libwayland's protocol dispatch (ffi_type_{sint,uint}32/
       pointer returning ffi_type_void) and most C APIs;
     • by-value i64/f32/f64 scalar ARGUMENTS within the (K=10, M=2) bounds —
       covers cairo/pango doubles, GObject signal marshallers (double/int64 args),
       and the common float/double-by-value C ABI cases;
     • all scalar RETURNS (void / i32 / i64 / f32 / f64) regardless of bounds.
   It is a SHARED crossSystem fix, not a wayland-private one.

   --- The runtime fallback (nix-wasm #126 Track C / #130) ------------------
   The static table above is the fast path. Anything it cannot express —
   out-of-(K,M)-bounds scalar signatures, by-value STRUCT arguments/returns,
   and VARARGS — now falls through to a RUNTIME path instead of aborting:
   `__wasm_ffi_call`, a host import (runtime/kernel-worker.js → ffi-codegen.js)
   that GENERATES a wasm trampoline module for the exact lowered signature at
   runtime and invokes it. This is the same runtime-wasm-instantiation
   primitive dlopen uses (#130), so libffi and dlopen share one mechanism.

   The lowering to the wasm C ABI is done HERE (the host only sees wasm value
   types): a by-value struct argument is passed as an i32 POINTER to a copy; a
   struct/long-double RETURN prepends an i32 pointer parameter and makes the
   call return void; varargs are packed into a separate buffer whose i32
   pointer is the one trailing parameter (emscripten's convention). The host
   picks the trampoline ABI (raw vs the fpcast (i64×128)->i64 canonical thunk)
   from which module owns the target funcref — a function pointer IS a table
   index on wasm, so `(uintptr_t)fn` is that index.

   What still aborts LOUDLY: complex types, and closures
   (ffi_prep_closure_loc) — a closure is the INVERSE (mint a NEW callable
   funcref that dispatches to a C handler); that is also runtime codegen but a
   separate direction, and no current guest consumer needs it, so it stays a
   loud FFI_BAD_ABI rather than a silent mis-call.
   ----------------------------------------------------------------------- */

#include <ffi.h>
#include <ffi_common.h>

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

/* The runtime FFI host import (ENGINE_ABI 8): generate+invoke a trampoline for
   the lowered wasm signature at `sig` (a byte descriptor, see below). Returns 0
   on success. funcIndex = the target funcref's table index = (uintptr_t)fn. */
int __wasm_ffi_call(uint32_t funcIndex, void *argbuf, void *retbuf,
                    const void *sig, uint32_t siglen);

/* Max argument count we generate trampolines for. libwayland needs
   WL_CLOSURE_MAX_ARGS (20) + 2 (data, target) = 22; 24 leaves margin. */
#define WASM_FFI_MAX_ARGS 24

typedef uint32_t u32;

static void wasm_ffi_unsupported(const char *what)
{
  fprintf(stderr, "libffi(wasm32-raw): unsupported %s — this backend handles "
                  "i32/i64/f32/f64 scalar by-value arguments within the generated "
                  "(K,M) bounds only; see wasm32-raw-ffi.c\n", what);
  abort();
}

/* ---- ffi_prep_cif_machdep: validate the cif for the raw ABI -------------- */

ffi_status FFI_HIDDEN
ffi_prep_cif_machdep(ffi_cif *cif)
{
  if (cif->abi != FFI_WASM32)
    return FFI_BAD_ABI;
  /* nfixedargs == nargs for the non-variadic path (the var path overrides it,
     below). Structs and out-of-(K,M) scalar arities are NO LONGER rejected —
     they route to the runtime fallback (__wasm_ffi_call). Only complex stays
     unsupported (no wasm ABI for it). */
  cif->nfixedargs = cif->nargs;
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
  (void)ntotalargs;
  /* Variadic calls take the runtime fallback: the wasm convention packs the
     variadic args into a separate buffer and passes ONE trailing i32 pointer
     to it (a different shape than fixed params, which is why the static i32^N
     table can't serve them). Record the fixed/total split for ffi_call. */
  cif->nfixedargs = nfixedargs;
  if (cif->rtype->type == FFI_TYPE_COMPLEX)
    return FFI_BAD_TYPEDEF;
  return FFI_OK;
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
    /* load_i32_arg handles only the i32-class arguments above; i64/f32/f64
       by-value args are loaded by the generated trampolines via their own
       typed accessors in wasm-ffi-trampolines.inc, not this path. */
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

/* ---- the runtime fallback: lower to wasm value types + __wasm_ffi_call ----- */

/* wasm signature value-type codes in the descriptor passed to the host. */
#define WSIG_VOID 0
#define WSIG_I32  1
#define WSIG_I64  2
#define WSIG_F32  3
#define WSIG_F64  4

/* Is this a plain scalar the static i32/i64/f32/f64 accessors handle? */
static int is_scalar(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_INT: case FFI_TYPE_UINT8: case FFI_TYPE_SINT8:
    case FFI_TYPE_UINT16: case FFI_TYPE_SINT16:
    case FFI_TYPE_UINT32: case FFI_TYPE_SINT32: case FFI_TYPE_POINTER:
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64:
    case FFI_TYPE_FLOAT: case FFI_TYPE_DOUBLE:
      return 1;
    default:
      return 0;
  }
}

/* Does this call need the runtime path (struct/long-double by value, variadic,
   or a scalar arity/mix the static table doesn't cover)? */
static int needs_runtime(ffi_cif *cif) {
  if (cif->nfixedargs != cif->nargs) return 1;       /* variadic */
  if (cif->nargs > WASM_FFI_MAX_ARGS) return 1;
  if (!is_scalar(cif->rtype) && cif->rtype->type != FFI_TYPE_VOID) return 1;
  for (unsigned i = 0; i < cif->nargs; i++)
    if (!is_scalar(cif->arg_types[i])) return 1;
  /* Scalar & within count — but the static table also bounds the NON-i32 mix
     (M) and the mixed arity (K). Let the static switch's own `default` catch
     those rare cases and recurse into the runtime path. */
  return 0;
}

/* wasm value-type code for a SCALAR ffi_type (the natural wasm passing type). */
static uint8_t scalar_wcode(ffi_type *t) {
  switch (t->type) {
    case FFI_TYPE_UINT64: case FFI_TYPE_SINT64: return WSIG_I64;
    case FFI_TYPE_FLOAT:  return WSIG_F32;
    case FFI_TYPE_DOUBLE: return WSIG_F64;
    default:              return WSIG_I32; /* ints/subwords/pointer */
  }
}

/* Write a scalar arg into an 8-byte trampoline slot (little-endian; the
   trampoline loads the natural width at the slot base). */
static void write_scalar_slot(uint8_t *slot, ffi_type *t, void *p) {
  switch (scalar_wcode(t)) {
    case WSIG_I64: memcpy(slot, p, 8); break;
    case WSIG_F32: memcpy(slot, p, 4); break;
    case WSIG_F64: memcpy(slot, p, 8); break;
    default: {
      /* extend subword ints to a 32-bit value in the low 4 bytes */
      uint32_t v = load_i32_arg(t, p);
      memcpy(slot, &v, 4);
      break;
    }
  }
}

/* Max lowered wasm params: real args + a leading struct-return pointer + a
   trailing varargs-buffer pointer. WASM_FFI_MAX_ARGS is generous; add slack. */
#define WSIG_MAX (WASM_FFI_MAX_ARGS + 64)

static void wasm_runtime_ffi_call(ffi_cif *cif, void (*fn)(void),
                                  void *rvalue, void **avalue) {
  uint8_t sig[2 + WSIG_MAX];
  uint8_t args[8 * WSIG_MAX];
  unsigned np = 0;         /* lowered wasm param count */
  unsigned nfixed = cif->nfixedargs;

  int rt = cif->rtype->type;
  int struct_ret = (rt == FFI_TYPE_STRUCT || rt == FFI_TYPE_LONGDOUBLE);

  /* return code */
  uint8_t retcode = WSIG_VOID;
  if (struct_ret) {
    /* struct/long double: caller passes rvalue as a leading pointer, call
       returns void. rvalue must be non-NULL (libffi guarantees a buffer). */
    retcode = WSIG_VOID;
    ((uint32_t *)args)[0] = (uint32_t)(uintptr_t)rvalue;
    /* zero the rest of the leading slot's high word */
    ((uint32_t *)args)[1] = 0;
    sig[2 + np] = WSIG_I32;
    np++;
  } else if (rt != FFI_TYPE_VOID) {
    retcode = scalar_wcode(cif->rtype);
  }

  /* fixed args */
  for (unsigned i = 0; i < nfixed; i++) {
    ffi_type *t = cif->arg_types[i];
    uint8_t *slot = args + (size_t)np * 8;
    if (t->type == FFI_TYPE_STRUCT || t->type == FFI_TYPE_LONGDOUBLE) {
      /* by-value aggregate -> pass a pointer to the (caller-owned) storage */
      uint32_t ptr = (uint32_t)(uintptr_t)avalue[i];
      memcpy(slot, &ptr, 4);
      sig[2 + np] = WSIG_I32;
    } else {
      write_scalar_slot(slot, t, avalue[i]);
      sig[2 + np] = scalar_wcode(t);
    }
    np++;
    if (np >= WSIG_MAX) wasm_ffi_unsupported("too many lowered arguments");
  }

  /* variadic args: packed into a separate buffer, one trailing i32 pointer. */
  uint8_t varbuf[8 * WSIG_MAX];
  if (cif->nfixedargs != cif->nargs) {
    size_t off = 0;
    for (unsigned i = nfixed; i < cif->nargs; i++) {
      ffi_type *t = cif->arg_types[i];
      size_t sz, al;
      if (t->type == FFI_TYPE_STRUCT || t->type == FFI_TYPE_LONGDOUBLE) {
        /* aggregates in varargs are also passed by pointer on wasm */
        sz = 4; al = 4;
        off = (off + al - 1) & ~(al - 1);
        if (off + sz > sizeof(varbuf)) wasm_ffi_unsupported("varargs buffer overflow");
        uint32_t ptr = (uint32_t)(uintptr_t)avalue[i];
        memcpy(varbuf + off, &ptr, 4);
      } else {
        sz = t->size; al = t->alignment;
        off = (off + al - 1) & ~(al - 1);
        if (off + sz > sizeof(varbuf)) wasm_ffi_unsupported("varargs buffer overflow");
        memcpy(varbuf + off, avalue[i], sz);
      }
      off += sz;
    }
    uint8_t *slot = args + (size_t)np * 8;
    uint32_t ptr = (uint32_t)(uintptr_t)varbuf;
    memcpy(slot, &ptr, 4);
    sig[2 + np] = WSIG_I32;
    np++;
  }

  sig[0] = (uint8_t)np;
  sig[1] = retcode;

  /* retbuf: for scalar returns the host writes here; for struct returns the
     value already goes to rvalue via the leading pointer, retbuf is unused. */
  uint8_t retbuf[16];
  int rc = __wasm_ffi_call((uint32_t)(uintptr_t)fn, args, retbuf, sig,
                           (uint32_t)(2 + np));
  if (rc != 0)
    wasm_ffi_unsupported("runtime trampoline call failed");

  if (!struct_ret && rt != FFI_TYPE_VOID && rvalue) {
    switch (retcode) {
      case WSIG_I64: memcpy(rvalue, retbuf, 8); break;
      case WSIG_F32: memcpy(rvalue, retbuf, 4); break;
      case WSIG_F64: memcpy(rvalue, retbuf, 8); break;
      default: {
        /* i32-class: libffi widens sub-word integer returns to ffi_arg. */
        uint32_t v; memcpy(&v, retbuf, 4);
        *(ffi_arg *)rvalue = (ffi_arg)v;
        break;
      }
    }
  }
}

void ffi_call(ffi_cif *cif, void (*fn)(void), void *rvalue, void **avalue) {
  if (needs_runtime(cif)) {
    wasm_runtime_ffi_call(cif, fn, rvalue, avalue);
    return;
  }

  ffi_type **at = cif->arg_types;
  void **av = avalue;
  unsigned n = cif->nargs;
  uint64_t key = ((uint64_t)ret_class(cif->rtype) << 40) | ((uint64_t)n << 32);
  for (unsigned i = 0; i < n; i++)
    key |= (uint64_t)arg_class(at[i]) << (2 * i);

  switch (key) {
    #include "wasm-ffi-trampolines.inc"
    default:
      /* within scalar count but outside the (K,M) mix bound — runtime path. */
      wasm_runtime_ffi_call(cif, fn, rvalue, avalue);
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
