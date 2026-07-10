#!/usr/bin/env bash
# Regenerate the dylink test fixtures. Requires clang + wasm-ld with wasm32
# support (any recent LLVM), binaryen's wasm-opt, and python3.
# The link flags mirror wasm-cross.nix's dylink model (minus --shared-memory:
# these fixtures run under plain test Memories; segment-init gating is
# exercised by the replay tests via ctor/reloc skipping, not init flags).
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-clang}"
LDFLAGS="-shared -Bsymbolic --no-entry --export-all --import-memory --import-table --allow-undefined"

fpcast() {
  wasm-opt --enable-threads --enable-bulk-memory --enable-mutable-globals \
    --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-reference-types --enable-multivalue \
    -pa max-func-params@8 --fpcast-emu "$1" -o "$2"
}

for m in main side side2; do
  "$CC" -target wasm32-unknown-unknown -fPIC -O2 -matomics -mbulk-memory -c $m.c -o $m.o
  wasm-ld $LDFLAGS $m.o -o $m.wasm
  rm $m.o
done

# main.fpcast.wasm — fpcast WITHOUT dynsym injection: documents the #33 trap
# (a raw export dynamically installed into the table mismatches the canonical
# call_indirect signature).
fpcast main.wasm main.fpcast.wasm

# *.dynsym.fpcast.wasm — the CORRECT build order for GModule/dlsym apps:
# dynsym-inject first (elem slots + the cb.dynsym map), THEN fpcast (the
# injected entries get canonical thunks; cb.dynsym keeps the name → slot map
# valid across the thunk renumbering).
for m in main side; do
  python3 ../../../scripts/wasm-dynsym-inject.py $m.wasm $m.dynsym.wasm
  fpcast $m.dynsym.wasm $m.dynsym.fpcast.wasm
done
