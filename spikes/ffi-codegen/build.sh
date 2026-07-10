#!/usr/bin/env bash
# Build the target functions to wasm32. Needs clang + wasm-ld (LLVM >= 15).
set -euo pipefail
cd "$(dirname "$0")"
clang --target=wasm32 -O2 -ffreestanding -fno-builtin -nostdlib \
  -Wl,--no-entry -o targets.wasm targets.c
echo "built targets.wasm ($(wc -c < targets.wasm) bytes)"
