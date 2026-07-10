#!/usr/bin/env bash
# Phase-2 Task-0 spike build — reproducible (resolves clang/lld/wasm-opt via the
# flake's pinned nixpkgs, no hard-coded store paths). Run from this directory.
set -euo pipefail
cd "$(dirname "$0")"
export NIX_CONFIG="experimental-features = nix-command flakes"

# Tools resolve from the pinned nixpkgs. On a setup where the nix daemon runs as
# root (this repo), prefix the three `nix build`s with sudo, or pre-resolve and
# pass CLANG=/… LLD=/…bin WASM_OPT=/…/wasm-opt as env overrides.
echo ">> resolving toolchain from the pinned nixpkgs"
CLANG="${CLANG:-$(nix build --no-link --print-out-paths nixpkgs#llvmPackages_21.clang-unwrapped)/bin/clang}"
LLD="${LLD:-$(nix build --no-link --print-out-paths nixpkgs#llvmPackages_21.lld)/bin}"
WO="${WASM_OPT:-$(nix build --no-link --print-out-paths nixpkgs#binaryen)/bin/wasm-opt}"
export PATH="$LLD:$PATH"

echo ">> asyncify the hand-written WAT probe"
"$WO" probe.wat --asyncify -o probe.async.wasm

echo ">> compile + asyncify the clang probe (allow-list the fork call graph: env.do_fork)"
"$CLANG" --target=wasm32-unknown-unknown -O2 -nostdlib -matomics -mbulk-memory \
  -Wl,--no-entry -Wl,--import-memory -Wl,--export=run -Wl,--allow-undefined \
  -Wl,--export-table probe.c -o probe.cc.wasm
"$WO" probe.cc.wasm --asyncify --pass-arg=asyncify-imports@env.do_fork -o probe.cc.async.wasm

echo ">> run both harnesses"
node run.mjs
node run-cc.mjs
