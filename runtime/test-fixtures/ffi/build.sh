#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
LD="-shared -Bsymbolic --no-entry --export-all --import-memory --import-table --allow-undefined"
$CC -target wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -c targets.c -o targets.o
wasm-ld $LD targets.o -o targets.wasm
rm targets.o
python3 ../../../scripts/wasm-dynsym-inject.py targets.wasm targets.dynsym.wasm
wasm-opt --enable-threads --enable-bulk-memory --enable-mutable-globals \
  --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-reference-types --enable-multivalue \
  -pa max-func-params@128 --fpcast-emu targets.dynsym.wasm -o targets.fpcast.wasm
