#!/usr/bin/env bash
# Build the softmmu spike benchmark to wasm32. Needs clang + wasm-ld (LLVM >= 15).
set -euo pipefail
cd "$(dirname "$0")"
clang --target=wasm32 -O2 -ffreestanding -fno-builtin -nostdlib \
  -Wl,--no-entry -Wl,--initial-memory=134217728 \
  -o bench.wasm bench.c
echo "built bench.wasm ($(wc -c < bench.wasm) bytes)"
