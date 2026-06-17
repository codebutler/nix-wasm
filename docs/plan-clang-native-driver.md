# Plan — make `clang` itself the driver (retire the cc/c++ shell wrappers)

**Status:** future work / design note. Not started. The current shell-script
drivers (`toolchain/guest-cc.nix` → `cc`, `toolchain/guest-cxx.nix` → `c++`) work
and are validated; this documents how to replace them with clang acting as its own
driver for the `wasm32-linux-musl` NOMMU guest, and the one real unknown that gates
it.

## Why we have wrapper scripts today

The guest `clang` is built bare for `wasm32-unknown-unknown` (clang rejects the
`-linux-musl` triple). It has **no built-in knowledge** of:

- our musl sysroot location, `crt1.o`, and default library set;
- the NOMMU/dylink link model (`-shared --import-memory --shared-memory
  --max-memory=… --import-table --gc-sections --no-entry --export-all
  --allow-undefined`, library order `-lc++ -lc++abi -lunwind -lc` + builtins);
- the per-target compile flags (`-D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory
  -fwasm-exceptions`, the libc++ header path, the visibility disables).

So `cc`/`c++` are small `sh` scripts that hard-code all of the above and run
**clang (compile) and wasm-ld (link) as two separate processes** — see the next
section for why they're split. The same flag vocabulary is currently duplicated in
**four** places: `guest-cc.nix`, `guest-cxx.nix`, `make.nix` (its `CC`), and
`nix-wasm.nix`'s `wcc`/`wcxx` build wrappers. That duplication is the main cost and
the main reason to unify on a real driver.

This wrapper-over-clang pattern is itself standard for bespoke targets — Emscripten
ships `emcc`/`em++` (Python wrappers over clang+wasm-ld), and embedded SDKs ship
`<target>-gcc` wrappers. So today's design is legitimate, not a hack; the goal here
is to reduce duplication and make tools that invoke `clang`/`clang++` directly (some
build systems, CMake's compiler probe) work without going through our `cc`/`c++`.

## The gating unknown: does clang's in-process linker spawn work on NOMMU?

On a normal host, `clang foo.c -o foo` compiles **and** invokes the linker itself
by `fork`/`posix_spawn`+`exec`-ing `ld`/`wasm-ld` as a subprocess (LLVM
`sys::ExecuteAndWait`). On this wasm guest there is **no fork/vfork** — only the
clone-with-fn spawn model (one shared NOMMU memory; a child can't resume the parent
mid-call). See `docs/STATUS.md` and the fork/vfork notes.

The good news: that spawn model now works for real (busybox spawns, `make` spawns
`cc`, `nix-build` forks the external `sh` builder). The open question is **which
primitive LLVM's `sys::ExecuteAndWait` uses on this musl-wasm port** — `posix_spawn`
(works: it's clone-with-fn) or a raw `fork()`+`execvp` path (does **not** work on
NOMMU-wasm). This must be verified before relying on clang to drive the linker
in-process:

1. Build a trivial program that calls `llvm::sys::ExecuteAndWait` (or just have the
   guest `clang foo.c -o foo` attempt to spawn `wasm-ld`) and observe whether the
   sub-process launches or SIGILLs/aborts like a raw fork.
2. If it routes through `posix_spawn`, the in-process driver is viable. If it uses
   `fork`+`exec`, either patch LLVM's `Program.inc` to prefer `posix_spawn` on wasm,
   or keep link as a separate step (see "Phasing").

## Approaches (compile-flag side)

### A. Clang config file (lowest effort, supported)
Ship a config file that clang auto-loads and that injects the sysroot + per-target
compile flags. clang searches its config dir for `<triple>.cfg` and
`<argv0-stem>.cfg` (e.g. `clang.cfg`, `wasm32-unknown-unknown.cfg`); `--config` /
`@file` also work. Put into it:

```
--sysroot=<cc-sysroot>/sys/musl
-resource-dir=<cc-sysroot>/sys/clang
-isystem <cc-sysroot>/sys/clang/include
-D__linux__ -D_GNU_SOURCE -matomics -mbulk-memory
# C++ only (clang++.cfg): -fwasm-exceptions -nostdinc++ -isystem …/c++/v1 …
```

Pro: trivial, no clang patch. Con: store paths are absolute → the config file is
generated per-closure (a Nix `writeText`), and it covers compile flags cleanly but
**not** the link model well (see B).

### B. Custom clang `ToolChain` (the upstream-correct way)
clang has per-platform `ToolChain` subclasses (`clang/lib/Driver/ToolChains/
WebAssembly.cpp` handles wasi). Add/extend one for our wasm32 Linux-NOMMU target so
clang natively knows: the sysroot layout, `crt1.o`, the default lib set and order,
and the exact `wasm-ld` arguments (the dylink/import-memory/gc-sections set). Then
`clang`/`clang++` "just work" end-to-end, link included.

Pro: the real fix; eliminates all four duplicated flag sites; matches how every
other clang target works. Con: a clang source patch compiled into `guest-clang`
(adds to the ~1–2 h LLVM build), and it only buys the in-process link if the
spawn unknown above is resolved.

### C. Sysroot install + `-fuse-ld`
Install the sysroot in the GCC-style layout clang probes by default so stock clang
finds crt/libs, and select `wasm-ld` via `-fuse-ld`. In practice this overlaps with
A/B and is the least clean on its own for a bare `-unknown` triple.

## Phasing (recommended)

1. **Verify the spawn primitive** (the gating unknown). Cheap; decides everything.
2. **Config file for compile flags** (Approach A): generate `clang.cfg`/`clang++.cfg`
   in `cc-sysroot` (or a sibling derivation) and have `guest-clang` default to its
   config dir. This already lets plain `clang -c foo.c` work and removes the compile
   half of the wrappers.
3. **If the in-process link works** (posix_spawn): add the link defaults via a
   `ToolChain` patch (Approach B) and retire `cc`/`c++` entirely, plus collapse
   `make.nix`/`nix-wasm.nix` onto the same clang.
4. **If it doesn't**: keep a *thin* wrapper that only performs the separate `wasm-ld`
   link step, while clang (via the config file) owns all compile flags — still a big
   reduction in duplicated logic.

## Acceptance

- `clang hello.c -o hello && ./hello` and `clang++ hello.cpp -o hello && ./hello`
  work in-guest with **no** wrapper script on PATH (or, in the fallback, with only a
  link-only shim).
- The four duplicated flag sites collapse to one source of truth.
- `nix.wasm`, the kernel build, busybox, and a real `./configure` still build
  bit-for-bit equivalently.
