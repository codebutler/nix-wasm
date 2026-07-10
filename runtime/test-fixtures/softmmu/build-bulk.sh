#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
# bulk-memory + shared-memory: memcpy/memmove/memset lower to
# memory.copy/memory.fill, and the data segment goes PASSIVE so
# __wasm_init_memory carries memory.init.
$CC -target wasm32-unknown-unknown -O2 -matomics -mbulk-memory -pthread \
  -nostdlib -Wl,--no-entry -Wl,--shared-memory -Wl,--max-memory=268435456 \
  -Wl,--export=bulk_copy -Wl,--export=bulk_move -Wl,--export=bulk_fill \
  -Wl,--export=read_data \
  -Wl,--export-memory bulk.c -o bulk.wasm
