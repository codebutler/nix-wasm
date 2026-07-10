#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
# -matomics + shared-memory so atomic ops are emitted; export the functions + a
# shared memory. --no-entry, no libc.
$CC -target wasm32-unknown-unknown -O2 -matomics -mbulk-memory -pthread \
  -nostdlib -Wl,--no-entry -Wl,--shared-memory -Wl,--max-memory=268435456 \
  -Wl,--export=a_load -Wl,--export=a_store -Wl,--export=a_add \
  -Wl,--export=a_xchg -Wl,--export=a_cas -Wl,--export=a_add64 \
  -Wl,--export-memory atomics.c -o atomics.wasm
