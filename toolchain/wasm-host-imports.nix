# The single source of truth for the wasm guest's host-provided imports — the
# ONLY symbols a guest dylink module is allowed to leave undefined (they're
# satisfied by the kernel/runtime bridge at WebAssembly.instantiate time, never
# linked into the module).
#
# Every guest link site passes this file to wasm-ld via `--allow-undefined-file`
# instead of a blanket `--allow-undefined`. The difference is the whole point of
# the no-undef contract (#52): with the blanket flag ANY unresolved symbol
# silently becomes an `env.*` import — that's exactly how #36's removal of
# `fork` from musl turned into a dangling `env.fork` import that trapped at
# instantiation (#50) instead of failing the link. With the allow-list, a stray
# `fork`/`exec`/`system` reference fails the link loudly (restoring #36's
# "callers fail to link" contract) while the legitimate host imports below still
# resolve.
#
# The list is empirically the exact superset of the env imports of every guest
# binary built today (clang, wasm-ld, nix.wasm, and the whole cross.* userspace
# via wasm-cross.nix) — verified with `wasm-objdump -x`. Memory/table/base and
# `__indirect_function_table` are NOT here: they come from --import-memory /
# --import-table / the dylink model, not from this allow-list.
#
# __wasm_dl_probe / __wasm_dlopen / __wasm_dlsym (#126 Track C / #130,
# ENGINE_ABI 8): the dlopen host surface — provided by runtime/kernel-worker.js
# (the runtime/dylink.js side-module loader), consumed by musl's wasm dlopen
# port (patches/musl/0009).
#
# __wasm_ffi_call (#126 Track C / #130): the runtime-libffi host surface —
# runtime/kernel-worker.js → runtime/ffi-codegen.js generates a trampoline
# module for a call signature the static wasm32-raw-ffi.c table can't express
# (structs/varargs/out-of-bounds arity). Consumed by patches/libffi/
# wasm32-raw-ffi.c's runtime fallback.
#
# To intentionally add a host-provided symbol: add it here (one name per line)
# with a comment explaining who provides it. Do NOT re-introduce a blanket
# --allow-undefined to "make a link pass" — that defeats the contract.
{ pkgs }:
pkgs.writeText "wasm-allow-undefined.txt" ''
  __wasm_abort
  __cpp_exception
  logAPIs
  __dlsym_time64
  __cxa_thread_atexit_impl
  __wasm_syscall_0
  __wasm_syscall_1
  __wasm_syscall_2
  __wasm_syscall_3
  __wasm_syscall_4
  __wasm_syscall_5
  __wasm_syscall_6
  __wasm_dl_probe
  __wasm_dlopen
  __wasm_dlsym
  __wasm_ffi_call
''
