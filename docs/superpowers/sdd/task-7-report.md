# Task 7 Report — On-demand compiler toolchain via binary cache (#43)

## What was done

Task 7 removes the compiler toolchain from the base squashfs image and proves
it installs on demand from the Nix binary cache.

### Changes

**`flake.nix`** (line ~292): removed `guestClang`, `guestCc`, `guestCxx`,
`makeWasm` from the `toolchain` list; kept only `nixWasmClean` and `wasmAsh`.
Base squashfs drops from ~79 MB to ~52 MB (-27 MB / -34%).

**`userspace/system.nix`**: changed `nix.settings.require-sigs = false` to
`nix.settings.require-sigs = lib.mkForce false` so the NixOS module evaluation
doesn't override the setting.

**`userspace/binary-cache.nix`**: fixed `pkgs.nix` to emit proper fake
derivations (not bare `builtins.storePath` values). `nix-env -iA` requires each
attribute to be a derivation record (`type = "derivation"` + `outPath` + `name`
+ `outputs`); a bare path/string was rejected with "expression does not evaluate
to a derivation". Added manifest.json generation so `runtime/nix-cache.js` can
index the cache files (without it the cache appeared empty).

**`patches/kernel/0015-wasm-futex-time64-4arg-trampoline.patch`**: changed
strategy from a 4-arg kernel-side trampoline to a host-level intercept. The
original patch registered `sys_wasm32_futex` (SYSCALL_DEFINE4, 4-arg) for
`__NR_futex_time64` (422). This fixed glib's 4-arg calls but broke nix.wasm's
musl pthread which calls futex_time64 via `__wasm_syscall_6` (6 args): the
6-arg dispatch path tried a 6-arg `call_indirect` on the 4-arg handler →
"null function or function signature mismatch" trap. Fixed by restoring
`sys_futex` (6-arg) in `syscall_table.c` and intercepting the 4-arg path at
the host level in `kernel-worker.js`.

**`runtime/kernel-worker.js`**: added a host-level intercept in the user
executable imports for `__wasm_syscall_4`: when `nr == 422` (futex_time64),
forward to `vmlinux_instance.exports.wasm_syscall_6` with two extra zero args
(uaddr2=0, val3=0). glib's `g_futex_simple` calls FUTEX_WAIT/WAKE which ignore
those two extra args. nix.wasm/musl pthread use `__wasm_syscall_6` directly and
never hit this intercept.

**`kernel.nix`**:
- `CONFIG_ARCH_FORCE_MAX_ORDER`: raised from 15 to 16 (128 MB max buddy block
  → 256 MB). `nix-env` substituting the 57MB clang NAR calls
  `malloc(~134 MB)` internally (nix's NAR extraction buffer), which via musl
  routes to `mmap(MAP_ANONYMOUS, 134352896)`. On NOMMU this needs a contiguous
  order-16 (256 MB) buddy block. The old MAX_ORDER=15 cap (128 MB) caused every
  attempt to fail with `nommu: Allocation of length 134352896 ... failed` →
  `std::bad_alloc`.
- `CONFIG_BOOT_MEM_PAGES`: raised from `0x7000` (1.75 GiB) to `0x7FFF`
  (1.99 GiB, the safe maximum below setup.c's `0x80000000` limit). With
  MAX_ORDER=16 the buddy allocator needs a physical region large enough to hold
  a 256 MB free block after boot + squashfs load (~220 MB unevictable/cache).
  1.75 GiB was too tight; 1.99 GiB provides ~1.6 GB free, which the allocator
  coalesces into 256 MB+ blocks.

**`runtime/demo/node/smoke.mjs`**: updated the smoke substitution test from
`nix-env -iA sl` (sl was not in the binary cache) to `nix-env -iA make`
(lightweight make binary, present in `.#wasm-binary-cache`).

**`runtime/demo/node/devtools-e2e.mjs`** (new): end-to-end proof harness for
Task 7. Boots the nix system, verifies `clang` is absent, installs `dev-tools`
from the cache, verifies `clang` appears, compiles `int main(){return 42;}` with
`cc`, and asserts exit 42.

### Test results

```
smoke.mjs:         PASS (8/8 checks)
devtools-e2e.mjs:  PASS (6/6 checks)
bun run test:      72 pass, 0 fail
```

### Key findings / hard-won learnings

1. **`nix-env -iA` needs fake derivations, not bare paths.** `builtins.storePath`
   returns a string path; nix-env requires `type="derivation"` + `outPath` +
   `name`. The fix: emit an attrset with those fields in `pkgs.nix`.

2. **futex_time64 split-arity trap.** glib and nix.wasm/musl both use
   `__NR_futex_time64` (422) but with different arg counts (4 vs 6). The wasm
   `call_indirect` in the kernel's `wasm_syscall_N` paths is strictly typed. A
   single kernel-side handler can only have one arity. Resolution: keep the
   6-arg `sys_futex` in the table (for musl's 6-arg path); intercept 4-arg
   callers at the JS host layer and zero-pad to 6 args before forwarding to the
   6-arg export.

3. **NOMMU buddy allocator MAX_ORDER caps large allocations.** nix's NAR
   extraction for the 57MB clang binary (96MB NAR) internally allocates
   ~134 MB contiguously. With `MAX_ORDER=15` (128 MB max block), order-16
   (256 MB) requests always fail regardless of total RAM. Raising to
   `MAX_ORDER=16` unblocks `nix-env` for all large-binary packages.

4. **Terminal echo matching pitfall in test harnesses.** Patterns like
   `/NIX_ENV_RC=/` match the ECHO of the shell command (`echo NIX_ENV_RC=$?`)
   before the actual output arrives, causing `waitForOutput` to return early.
   Fix: use `/NIX_ENV_RC=[0-9]/` which only matches actual numeric output.
