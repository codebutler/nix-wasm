#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
WASM_OPT="${WASM_OPT:-wasm-opt}"
# Dylink-style (-fPIC -shared) with SHARED memory + atomics/bulk-memory,
# matching real guest binaries: imports env.memory (shared), env.__memory_base,
# env.__stack_pointer — the surface the softmmu checked mode requires — and,
# critically, --shared-memory makes data segments PASSIVE, applied by
# __wasm_init_memory behind an atomic once-guard. Without it wasm-ld emits BSS
# as an ACTIVE zero-fill segment that a child instantiation would replay over
# the parent's live memory (exactly the clobber the real engine avoids). The
# softmmu pass then strips that start section into __mmu_start so placement
# runs AFTER pt_base is set, through the page tables.
# --allow-undefined for the three declared host imports (capture_stack, log_i,
# __wasm_syscall_2). Then asyncify with capture_stack as the SOLE unwind import
# (the musl 0010 seam contract), so only the fork call graph is instrumented.
# The softmmu pass (instrument({checked:true})) is applied at TEST time.
$CC -target wasm32-unknown-unknown -O2 -nostdlib -fPIC \
  -matomics -mbulk-memory \
  -Wl,--no-entry -Wl,--shared -Wl,--allow-undefined \
  -Wl,--shared-memory -Wl,--max-memory=67108864 \
  fork-probe.c -o fork-probe.pre.wasm
$WASM_OPT fork-probe.pre.wasm --asyncify \
  --pass-arg=asyncify-imports@env.capture_stack -o fork-probe.wasm
rm -f fork-probe.pre.wasm
echo "built fork-probe.wasm ($(stat -c%s fork-probe.wasm) bytes)"
