# libffi-on-wasm via runtime trampoline codegen — PROVEN

Proves the primitive behind the residual-gaps analysis (design doc §8) and the Track C
reframe (#130): **the libffi limitation is fixable by generating a trampoline wasm module
per call signature at runtime** and instantiating it against a shared table + memory — the
*same* runtime-instantiation primitive dlopen needs. No engine feature required; runs on
stock V8 (node).

## What it does
`gen.mjs` emits, for an arbitrary signature, a tiny wasm module whose
`trampoline(argPtr, retPtr, funcIndex)` reads typed args from linear memory, `call_indirect`s
`table[funcIndex]` with the exact signature type, and writes the result back. `run.mjs`
installs real target funcrefs (built from `targets.c`) into a shared table and calls them
through generated trampolines, caching one module per distinct signature.

## Result (`bash build.sh && node run.mjs`, node/V8)
```
ok  add(i32,i32)                       got=42 want=42
ok  muld(f64,f64)                      got=26 want=26
ok  mixf32(f32,f32)                    got=13 want=13
ok  mixi64(i64,i32)  [i64]             got=3000000000005 want=3000000000005
ok  mix4d(4×f64,i32)  [M=4 > 2]        got=100 want=100
ok  addmany(30×i32)  [K=30 > 24]       got=465 want=465
ok  cache hit on repeat signature      got=0 want=0
7/7 pass — 6 trampoline modules generated (one per distinct signature)
```

## Why it matters
- **Covers what the fixed trampoline-table backend cannot.** The current `wasm32-raw-ffi.c`
  table is bounded (K=24 all-i32, M=2 non-i32; no structs/varargs/closures). `mix4d`
  (4 non-i32) and `addmany` (30 i32) are past those bounds and work here — runtime codegen
  has **no arity/mix limit**. i64/f32/f64 all round-trip.
- **It's the Track C primitive, not a separate mechanism.** dlopen instantiates a PIC side
  module against the shared table/memory; libffi instantiates a *generated* module against
  the same shared table/memory. Build #130's API as "instantiate a module + install its
  funcrefs into the shared table" and libffi falls out — this spike is that API in miniature.
- **Caching** keeps it cheap: one module per distinct signature, reused thereafter (proven).

## Not covered here (next steps, not blockers)
- **Structs by value / varargs**: the wasm C ABI lowers structs predictably (pointer/expanded
  args) — the generator extends by lowering the struct to its scalar fields; varargs = a
  per-call-site module for the concrete arg vector. Mechanically the same, just more marshalling.
- **Closures (`ffi_closure`)**: the inverse direction — generate a wasm function that captures
  a context index and dispatches to a host handler; also runtime codegen, same primitive.
- **`WebAssembly.Function`** (type-reflection proposal) would do all this host-side with no
  generated module — cleaner, but unshipped in V8. This generate-a-module form works today.

## Scope / caveats
Trampolines here take `funcIndex` as an arg (fully general); a real integration binds it per
`ffi_call`. Arg slots are 8 bytes each (holds any scalar); a real impl packs per the ABI.
The point proven is the mechanism + unbounded signature coverage, on stock V8.
