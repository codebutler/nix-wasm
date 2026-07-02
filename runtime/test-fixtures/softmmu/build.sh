#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
# Plain wasm (NOT dylink/PIC — a simple module with its own memory, so the test
# harness can drive it directly). No atomics/SIMD. Export the functions + memory.
$CC -target wasm32-unknown-unknown -O2 -nostdlib -Wl,--no-entry \
  -Wl,--export=sum_scan -Wl,--export=fill -Wl,--export=widen \
  -Wl,--export=chase -Wl,--export=dsum -Wl,--export=mixed -Wl,--export-memory \
  prog.c -o prog.wasm
