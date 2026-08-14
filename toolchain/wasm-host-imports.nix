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
# capture_stack (#129 Track B, ENGINE_ABI 10) is deliberately, PERMANENTLY NOT
# here — this is not a "not yet". Do NOT add it in the Phase-2 fork-default
# flip (or any other PR), and do not read the muslFork/`fork = true` promotion
# as license to add it. Adding it to this SHARED allow-list would let ANY
# guest binary reference capture_stack without being asyncify-instrumented —
# a plain posix_spawn/pthread_create link would then still LINK (silently
# importing capture_stack) but crash at RUNTIME the first time it actually
# tried to fork(): the module was never `wasm-opt --asyncify`'d, so
# `makeCaptureStack`'s `asyncify_get_state()` call finds no asyncify state
# machine and throws a TypeError at instantiation/call time — exactly the
# opaque-runtime-failure class the #52 no-undef contract exists to convert
# into a loud link-time failure. Concretely: `toolchain/musl.nix`'s
# `fork = true` variant (muslFork) DEFINES fork()/_Fork(), and commit
# 99e7a73 (see `patches/musl/0010-fork-asyncify-seam.patch`'s header) split
# `__post_Fork` into its own TU precisely so that a plain posix_spawn/
# pthread_create link against muslFork does NOT pull in `_Fork.lo` (hence
# does not reference capture_stack) — that split is what makes "references
# capture_stack" a reliable signal of "was asyncify-instrumented for fork",
# and it only WORKS as a signal if capture_stack stays absent from this file.
# `.#musl-fork-linkcheck` (spikes/nofork/check-fork.nix) is the regression
# gate for that split; `toolchain/musl.nix`'s `fork = true` postPatch also
# asserts the split's shape directly.
#
# A fork-capable link obtains capture_stack PER-LINK instead, via one of the
# exactly TWO local-extension idioms below — do not invent a third and do not
# promote either to this shared file: (1) nix-wasm.nix's fork build copies
# this file's CONTENT and appends capture_stack to make its own
# runCommand-generated allow-list (still consumed via --allow-undefined-file,
# the file just has one extra line); (2) userspace/busybox-fork.nix links with
# a blanket --import-undefined (it can't use --allow-undefined-file at all
# here — see the comment on CONFIG_EXTRA_LDFLAGS in that file for why a
# user-supplied one would be overridden by the cc-wrapper's own) and instead
# passes capture_stack as an EXTRA argv name to scripts/wasm-check-imports.py,
# which checks it post-link against (this file's contents ∪ the extra argv
# names) without ever writing a second allow-list file to disk. Both idioms
# are only reachable from a link that is ALSO running `wasm-opt --asyncify`
# over the fork call graph (asyncify-cc.nix / wasm-fork-stdenv.nix) — the
# per-link opt-in and the asyncify instrumentation travel together by
# construction, which is exactly what a shared allow-list entry would break.
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
