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
''
