# Phase 1 — Per-Process Address Spaces (Isolation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each user process its own base-0 `WebAssembly.Memory` so processes are memory-isolated from each other and the kernel, over the existing clone-with-fn spawn — no true `fork()` yet (that is Phase 2).

**Architecture:** Today one shared `WebAssembly.Memory` holds the kernel + every process, with each process relocated to an offset (`__memory_base = data_start`); `copy_to_user` is a plain `memcpy` (`UACCESS_MEMCPY`). Phase 1 splits each process into its own private `Memory`, and replaces the direct-memcpy uaccess with an arch-specific path that calls a **host-bridge** import — a synchronous in-worker copy between the kernel's shared memory and the target process's private memory. The bridge is the single page-aware choke point for all kernel↔user access (forward-compat for future paging). clone-with-fn keeps working; each spawned process simply gets its own private memory.

**Tech Stack:** joelseverin/linux wasm port (kernel C, authored here as `patches/kernel/*.patch` applied by `kernel.nix`); the `pc` JS runtime (`/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/*.js`); Nix flake build (`nix build .#kernel`, `.#wasm-store-manifest`); the pc test harness (`scripts/linux-demo/exec-nixsystem.mjs` + playwright multitty harness).

## Global Constraints

- **PRIME DIRECTIVE:** no shortcuts/hacks/stubs. Every nix-wasm artifact is a reproducible derivation; kernel changes are authored as numbered `patches/kernel/00NN-*.patch` files referenced in `kernel.nix`, never ad-hoc edits to a checkout.
- **Wasm-guard everything shared.** No change may alter native-package builds; kernel/runtime changes are wasm-arch only.
- **Single choke point.** ALL kernel↔user memory access (`raw_copy_to_user`, `raw_copy_from_user`, `strncpy_from_user`, `get_user`/`put_user`, `get_user_pages` callers, `arch/wasm/kernel/signal.c`) must flow through the one host-bridge import. Never reintroduce a direct memcpy on a user pointer. (Forward-compat rule 1 from the spec.)
- **Host-bridge ABI is a versioned contract** between `nix-wasm` (kernel) and `pc` (runtime). Bump a shared `WASM_HOSTBRIDGE_ABI` constant on any change; the two repos must match (echoes the exec-ABI-skew failure mode).
- **Reference, don't rebuild oracle.** Kernel source for reading is at `/home/vbvntv/lwbuild/ws/src/kernel` (rev `039e5f3e`); the build fetches its own pinned copy via `toolchain/kernel-src.nix`. Author changes as patches against that rev.
- **Build invocation:** `export NIX_CONFIG="experimental-features = nix-command flakes"`; run each `sudo nix` as its own command (piped sudo password — see agent memory). Don't `nix store gc`; don't kill running LLVM builds.
- **No new from-source LLVM.** Phase 1 touches neither `guest-clang` nor `kernel-llvm`; the kernel rebuild reuses the cached patched LLVM. Only `vmlinux.wasm` recompiles (fast).

---

## File Structure

**nix-wasm repo (`/home/vbvntv/Code/nix-wasm`):**
- Create `patches/kernel/0013-wasm-uaccess-hostbridge.patch` — replace `UACCESS_MEMCPY` with an arch `raw_copy_to/from_user` + `strncpy_from_user` that call the host-bridge import; declare the import in `arch/wasm/include/asm/wasm.h`; drop `select UACCESS_MEMCPY` in `arch/wasm/Kconfig`. (Task 1)
- Create `patches/kernel/0015-wasm-uaccess-residual.patch` — close residual direct-deref uaccess: `__clear_user` → `wasm_user_memzero`, `strnlen_user` → bridge reads, `binfmt_wasm.c:101` auxv `memcpy` → `wasm_user_copy_to`. (Task 2.0)
- Create `patches/kernel/0016-wasm-per-mm-allocator-dark.patch` — `mm_context_t` allocator fields, `do_mmap_private` gate, anon-zero → `wasm_user_memzero`, `exit_mmap` → `wasm_user_mem_free`, `load_wasm_file` → `wasm_user_mem_create`. (Task 2.2)
- Modify `kernel.nix:29-48` — add the three new patches to the `patches` list (after `0012`, in order 0013/0015/0016; 0014 was the old per-process patch, now replaced by 0015/0016).
- Create `userspace/tests/isolation-probe.nix` — two tiny C programs (A writes a sentinel to a known address and sleeps; B attempts to read/clobber that address) built with `guest-cc`, plus a runner manifest. (Task 2.4)
- Modify `flake.nix` — expose `.#test-isolation-probe` (the probe initramfs/manifest) and `.#kernel` stays the build target.

**pc repo (`/home/vbvntv/Code/pc/vendor/linux-wasm/runtime`):**
- Modify `kernel-worker.js` — (a) add the host-bridge imports (`wasm_user_copy_to/from/strncpy`, `wasm_user_memzero`, `wasm_user_mem_create/grow/free`) near the syscall imports (~line 700); (b) wire private `WebAssembly.Memory` into `user_executable_imports.env.memory` at base `USER_AS_BASE=0x10000` (`kernel-worker.js:846`); (c) update R1 resolver at `:333`. (Tasks 1, 2.1, 2.3, 2.5)
- Modify `kernel-host.js` — `create_user_mem` main-thread handler mints `WebAssembly.Memory` and transfers it; teardown unregisters `userMems` on `kill_task`. (Tasks 2.1, 2.4)
- Create `runtime/hostbridge.js` — the synchronous copy helpers + `WASM_HOSTBRIDGE_ABI` constant + `userMems` map + four `wasm_user_mem_*` helpers. `WASM_HOSTBRIDGE_ABI=2` after T2.1.

**Test harness (pc):**
- Modify/add under `scripts/linux-demo/` — an isolation-probe runner (boot the probe manifest, scan console for PASS/leak), reusing the `exec-nixsystem.mjs` boot scaffolding.

---

## Task 1: Host-bridge indirection over the SAME shared memory (no behavior change)

De-risk the ABI and wiring first: introduce the `wasm_user_copy*` host-bridge import and route the kernel's uaccess through it, but have the runtime service it against the existing **shared** buffer. Zero semantic change — the existing boot must still pass. This proves the choke point and the two-repo ABI before any memory split.

**Files:**
- Create: `patches/kernel/0013-wasm-uaccess-hostbridge.patch`
- Modify: `kernel.nix:29-48` (add patch to list)
- Create: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/hostbridge.js`
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-worker.js` (~700, syscall import block)

**Interfaces:**
- Produces (kernel→runtime import ABI, version `WASM_HOSTBRIDGE_ABI = 1`):
  - `wasm_user_copy_to(pid, dst_uaddr, src_kaddr, n) -> n_uncopied` — copy `n` bytes from kernel addr `src_kaddr` to user addr `dst_uaddr` in process `pid`'s address space.
  - `wasm_user_copy_from(pid, dst_kaddr, src_uaddr, n) -> n_uncopied` — reverse direction.
  - `wasm_user_strncpy(pid, dst_kaddr, src_uaddr, count) -> len_or_neg` — bounded string copy; returns length copied or `-EFAULT`.
  - In Task 1, `pid` is ignored and all three address the shared buffer (current behavior).
- Consumes: existing `vmlinux_instance.exports.wasm_syscall_N` import pattern (kernel-worker.js:700-706) as the placement model.

- [ ] **Step 1: Write the failing test — assert the bridge import is present and boot still works**

Add to the harness a pre-boot assertion that the user import object exposes the bridge, then run the existing boot. Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-hostbridge-smoke.mjs`:

```js
// Boots the existing wasm-system and asserts (a) the kernel imports the
// host-bridge, (b) Phase A/B still pass (no behavior change in Task 1).
import { bootNixSystem, assertPhaseAB } from "./exec-nixsystem.mjs";
import { WASM_HOSTBRIDGE_ABI } from "../../vendor/linux-wasm/runtime/hostbridge.js";

const run = await bootNixSystem({ instrument: true });
if (WASM_HOSTBRIDGE_ABI !== 1) throw new Error("ABI mismatch");
if (!run.userImportsSawBridge) throw new Error("kernel did not import wasm_user_copy_to");
await assertPhaseAB(run); // existing acceptance: boot → shell → nix-env -iA sl renders
console.log("HOSTBRIDGE-SMOKE PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: FAIL — `hostbridge.js` does not exist / `userImportsSawBridge` undefined.

- [ ] **Step 3: Create the runtime bridge helper**

Create `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/hostbridge.js`:

```js
// Synchronous in-worker copy between kernel memory and a process's memory.
// Task 1: every process resolves to the shared buffer (no split yet).
export const WASM_HOSTBRIDGE_ABI = 1;

// resolveMem(pid) -> { u8: Uint8Array } for the target address space.
export function makeHostBridge(kernelMemory, resolveMem) {
  const kbuf = () => new Uint8Array(kernelMemory.buffer);
  return {
    wasm_user_copy_to(pid, dst_uaddr, src_kaddr, n) {
      const dst = resolveMem(pid).u8();
      dst.set(kbuf().subarray(src_kaddr, src_kaddr + n), dst_uaddr);
      return 0;
    },
    wasm_user_copy_from(pid, dst_kaddr, src_uaddr, n) {
      const src = resolveMem(pid).u8();
      kbuf().set(src.subarray(src_uaddr, src_uaddr + n), dst_kaddr);
      return 0;
    },
    wasm_user_strncpy(pid, dst_kaddr, src_uaddr, count) {
      const src = resolveMem(pid).u8();
      let i = 0;
      for (; i < count; i++) {
        const b = src[src_uaddr + i];
        kbuf()[dst_kaddr + i] = b;
        if (b === 0) return i;
      }
      return i;
    },
  };
}
```

- [ ] **Step 4: Wire the bridge into the kernel imports (Task 1: shared resolver)**

In `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-worker.js`, near the `__wasm_syscall_N` block (~700), add to the vmlinux import object:

```js
// host-bridge (Phase 1): kernel↔user copies. Task 1 resolver = shared buffer.
...(() => {
  const bridge = makeHostBridge(memory, (_pid) => ({ u8: () => new Uint8Array(memory.buffer) }));
  return {
    wasm_user_copy_to: bridge.wasm_user_copy_to,
    wasm_user_copy_from: bridge.wasm_user_copy_from,
    wasm_user_strncpy: bridge.wasm_user_strncpy,
  };
})(),
```

Add `import { makeHostBridge, WASM_HOSTBRIDGE_ABI } from "./hostbridge.js";` at the top, and set `userImportsSawBridge`/expose `WASM_HOSTBRIDGE_ABI` through the boot result the harness reads.

- [ ] **Step 5: Author the kernel patch that calls the bridge**

Create `patches/kernel/0013-wasm-uaccess-hostbridge.patch` against rev `039e5f3e`. It must: (a) in `arch/wasm/Kconfig` remove `select UACCESS_MEMCPY`; (b) add `arch/wasm/include/asm/uaccess.h` overriding `raw_copy_to_user`/`raw_copy_from_user`/`__strncpy_from_user` to call the imports; (c) declare the imports in `arch/wasm/include/asm/wasm.h`. The override body (real logic, current-process pid from `current`):

```c
/* arch/wasm/include/asm/uaccess.h (new) */
extern unsigned long wasm_user_copy_to(int pid, unsigned long dst,
                                       unsigned long src, unsigned long n);
extern unsigned long wasm_user_copy_from(int pid, unsigned long dst,
                                         unsigned long src, unsigned long n);

static inline unsigned long
raw_copy_to_user(void __user *to, const void *from, unsigned long n)
{
    return wasm_user_copy_to(task_pid_nr(current), (unsigned long)to,
                             (unsigned long)from, n);
}
static inline unsigned long
raw_copy_from_user(void *to, const void __user *from, unsigned long n)
{
    return wasm_user_copy_from(task_pid_nr(current), (unsigned long)to,
                              (unsigned long)from, n);
}
#include <asm-generic/uaccess.h>  /* keep get_user/put_user wrappers over the above */
```

- [ ] **Step 6: Add the patch to the kernel build**

In `kernel.nix`, after `./patches/kernel/0012-wasm-vmlinux-o-no-group.patch` (line 47), add:

```nix
    # Phase 1: route copy_to/from_user through the host-bridge import (drops
    # UACCESS_MEMCPY) so the kernel can reach a process's private memory.
    ./patches/kernel/0013-wasm-uaccess-hostbridge.patch
```

- [ ] **Step 7: Build the kernel and regenerate the served manifest**

Run (each as its own sudo command):
```
sudo nix build .#kernel --print-out-paths
sudo nix build .#wasm-store-manifest --print-out-paths
```
Copy the new `vmlinux.wasm` + `store.json` into `pc/vendor/linux-wasm/` as the harness expects (mirror the existing re-vendor step).
Expected: kernel builds (only `vmlinux` recompiles; LLVM cached).

- [ ] **Step 8: Run the smoke test — boot unchanged**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: PASS — `HOSTBRIDGE-SMOKE PASS` (kernel imports the bridge; Phase A/B unchanged because the resolver still targets the shared buffer).

- [ ] **Step 9: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add patches/kernel/0013-wasm-uaccess-hostbridge.patch kernel.nix && \
  git commit -m "kernel(wasm): route uaccess through host-bridge import (no behavior change)"
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/hostbridge.js vendor/linux-wasm/runtime/kernel-worker.js scripts/linux-demo/test-hostbridge-smoke.mjs vendor/linux-wasm/vmlinux.wasm vendor/linux-wasm/store.json && \
  git commit -m "runtime: host-bridge uaccess indirection (shared-buffer resolver)"
```

---

## Task 2.0: Close residual direct-deref uaccess holes

Prerequisite for all per-process-memory work. Close the three remaining sites that
still read/write user pointers directly through the shared buffer — before the split,
these silently work; after T2.3 they would crash. No behavior change; verifiable
against the shared resolver from Task 1. (Refined design §6, §8 `strnlen_user`
prerequisite; design §2 gate sites.)

**Files:**
- Create: `patches/kernel/0015-wasm-uaccess-residual.patch`
  - `arch/wasm/kernel/process.c` — `__clear_user`: replace inline `memset` to user
    pointer with `wasm_user_memzero(task_pid_nr(current), addr, n)`.
  - `arch/wasm/lib/string.c` (or wherever `__strnlen_user` lives) — `strnlen_user`:
    replace direct byte scan with bridge reads (loop `wasm_user_copy_from` one byte
    at a time, or add a dedicated `wasm_user_strnlen` import if perf matters).
  - `fs/binfmt_wasm.c:101` — `create_wasm_tables` raw `memcpy(sp, wasm_auxv, …)` to
    user pointer: replace with `wasm_user_copy_to(task_pid_nr(current), (unsigned
    long)sp, (unsigned long)wasm_auxv, sizeof(wasm_auxv))`.
- Modify: `kernel.nix` — add patch `0015` after `0014`.

**Interfaces:**
- Consumes: `wasm_user_copy_to`/`wasm_user_copy_from` (Task 1 ABI v1) + the
  `wasm_user_memzero` import declared in this task (ABI still v1; `memzero` is
  forward-declared here, the runtime wires it in T2.1).
- Produces: zero direct user-pointer derefs remaining in `arch/wasm`; all three
  sites route through the bridge.

- [ ] **Step 1: Write the failing test — assert the three bridge imports are present at boot**

In `/home/vbvntv/Code/pc/scripts/linux-demo/test-hostbridge-smoke.mjs` (from Task 1),
extend the import-presence assertion to also check `wasm_user_memzero` and that the
`create_wasm_tables` path doesn't crash on exec. Run the existing boot:

```js
if (!run.userImportsSawBridge) throw new Error("kernel did not import wasm_user_copy_to");
if (!run.userImportsSawMemzero) throw new Error("kernel did not import wasm_user_memzero");
await assertPhaseAB(run);
console.log("UACCESS-RESIDUAL PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: FAIL — `wasm_user_memzero` not declared / import absent.

- [ ] **Step 3: Add `wasm_user_memzero` stub to the runtime (Task 1 shared resolver)**

In `runtime/hostbridge.js`, extend `makeHostBridge` with:
```js
wasm_user_memzero(pid, uaddr, n) {
  const dst = resolveMem(pid).u8();
  dst.fill(0, uaddr, uaddr + n);
  return 0; // bytes not zeroed
},
```
Wire it into the vmlinux import object in `kernel-worker.js` alongside the existing bridge imports.

- [ ] **Step 4: Author the kernel patch**

Create `patches/kernel/0015-wasm-uaccess-residual.patch` against rev `039e5f3e`.
Patch `__clear_user`, `strnlen_user`, and `create_wasm_tables` as described in the
Files block above. Declare `wasm_user_memzero` in `arch/wasm/include/asm/wasm.h`
beside the existing bridge imports. Add `extern unsigned long wasm_user_memzero(int
pid, unsigned long uaddr, unsigned long n);` — the runtime services it against the
shared buffer for now.

- [ ] **Step 5: Add the patch, rebuild kernel + manifest, re-vendor**

In `kernel.nix`, after the Task 1 patch, add:
```nix
    # T2.0: close residual direct-deref uaccess (clear_user, strnlen_user, auxv memcpy).
    ./patches/kernel/0015-wasm-uaccess-residual.patch
```
Run:
```
sudo nix build .#kernel --print-out-paths
sudo nix build .#wasm-store-manifest --print-out-paths
```
Re-vendor `vmlinux.wasm` + `store.json` into `pc/vendor/linux-wasm/`.

- [ ] **Step 6: Run the smoke test — boot unchanged**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: PASS — `UACCESS-RESIDUAL PASS` (all bridge imports present; Phase A/B green;
no behavior change on shared resolver).

- [ ] **Step 7: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add patches/kernel/0015-wasm-uaccess-residual.patch kernel.nix && \
  git commit -m "kernel(wasm): T2.0 — close residual direct-deref uaccess (clear_user/strnlen_user/auxv)"
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/hostbridge.js vendor/linux-wasm/runtime/kernel-worker.js vendor/linux-wasm/vmlinux.wasm vendor/linux-wasm/store.json && \
  git commit -m "runtime: T2.0 — wire wasm_user_memzero into bridge (shared-buffer stub)"
```

---

## Task 2.1: ABI v2 scaffolding — four lifecycle imports + `userMems` map

Wire the four `wasm_user_mem_*` imports and the pid-keyed `userMems` registry into
the runtime. `create` mints a `WebAssembly.Memory` (on the main thread) but does NOT
yet wire it into user-module instantiation. Bump `WASM_HOSTBRIDGE_ABI` to 2. Boot
unaffected — the registry exists but is never consulted during instantiation.
(Refined design §3.)

**Files:**
- Modify: `runtime/hostbridge.js` — add `userMems` map + four `wasm_user_mem_*`
  helpers; bump `WASM_HOSTBRIDGE_ABI = 2`.
- Modify: `runtime/kernel-worker.js:341` (lifecycle imports block) — expose the four
  imports to the vmlinux import object; update the resolver to return
  `userMems.get(pid).memory.buffer` when an entry exists, else fall back to the
  shared `memory.buffer`.
- Modify: `runtime/kernel-host.js` — add a `create_user_mem` message handler that
  mints `new WebAssembly.Memory({initial, maximum, shared:false})` on the main
  thread and `postMessage`-transfers the memory to the requesting worker.
- Declare in `arch/wasm/include/asm/wasm.h` the four imports (no new kernel patch
  needed if 0015 already opened the `wasm.h` slot; add a `WASM_HOSTBRIDGE_ABI`
  `#define 2` constant the kernel can assert).

**Interfaces:**
- Consumes: Task 1 bridge ABI v1 + T2.0 `wasm_user_memzero`.
- Produces: `WASM_HOSTBRIDGE_ABI = 2`; four imports callable but `create` only mints
  (never used in instantiation yet); resolver falls back to shared buffer for any pid
  not in `userMems`.

- [ ] **Step 1: Write the failing test — assert ABI version and registry ping**

Extend `test-hostbridge-smoke.mjs`:
```js
if (WASM_HOSTBRIDGE_ABI !== 2) throw new Error("ABI not bumped to 2");
if (!run.userImportsSawMemCreate) throw new Error("wasm_user_mem_create import missing");
await assertPhaseAB(run); // boot still green
console.log("ABI-V2-SCAFFOLD PASS");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: FAIL — `WASM_HOSTBRIDGE_ABI` is 1 / `wasm_user_mem_create` absent.

- [ ] **Step 3: Add the four imports to `hostbridge.js`**

```js
export const WASM_HOSTBRIDGE_ABI = 2;
// userMems: pid -> { memory: WebAssembly.Memory, table: WebAssembly.Table }
export const userMems = new Map();

export function makeHostBridge(kernelMemory, resolveMemFn) {
  const kbuf = () => new Uint8Array(kernelMemory.buffer);
  const resolveMem = (pid) => {
    const e = userMems.get(pid);
    const buf = e ? e.memory.buffer : kernelMemory.buffer;
    return { u8: () => new Uint8Array(buf) };
  };
  return {
    // ... existing copy_to/copy_from/strncpy/memzero (unchanged) ...
    wasm_user_mem_create(pid, init_pages) {
      // Minting happens on main thread via kernel-host.js; this import signals it.
      // The actual Memory arrives via postMessage transfer before data vm_mmap.
      return 0; // 0 = ok (fulfilled asynchronously by main thread handler)
    },
    wasm_user_mem_grow(pid, delta_pages) {
      const e = userMems.get(pid);
      if (!e) return -1;
      return e.memory.grow(delta_pages); // returns new page count or -1
    },
    wasm_user_mem_free(pid) {
      userMems.delete(pid);
    },
  };
}
```

- [ ] **Step 4: Add the `create_user_mem` handler to `kernel-host.js`**

In `kernel-host.js`, add a message handler for `type: "create_user_mem"`:
```js
case "create_user_mem": {
  const mem = new WebAssembly.Memory({
    initial: msg.init_pages, maximum: msg.max_pages, shared: false,
  });
  // Transfer to the requesting worker; the worker registers it in userMems.
  worker.postMessage({ type: "user_mem_ready", pid: msg.pid, memory: mem }, [mem]);
  break;
}
```
The worker side receives `user_mem_ready` and calls `userMems.set(pid, { memory, table: null })`.

- [ ] **Step 5: Update the resolver in `kernel-worker.js`**

At resolver site (`kernel-worker.js:333`), update to the R1 pattern (refined design §4):
```js
const _bridge = makeHostBridge(
  { get buffer() { return memory.buffer; } },
  (pid) => {
    const e = userMems.get(pid);
    const buf = e ? e.memory.buffer : memory.buffer;
    return { u8: () => new Uint8Array(buf) };
  });
```
Expose the four new imports in the vmlinux import block beside the existing three.

- [ ] **Step 6: Build kernel (no new patch needed) + run smoke test**

No new kernel patch for T2.1 (imports declared in `wasm.h` by T2.0; runtime ABI
bump is runtime-only). Rebuild is not required if only runtime files changed; re-run
the boot test:

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-hostbridge-smoke.mjs`
Expected: PASS — `ABI-V2-SCAFFOLD PASS`; boot still green.

- [ ] **Step 7: Commit**

```bash
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/hostbridge.js vendor/linux-wasm/runtime/kernel-worker.js vendor/linux-wasm/runtime/kernel-host.js && \
  git commit -m "runtime: T2.1 — ABI v2 scaffolding (wasm_user_mem_* imports + userMems map)"
```

---

## Task 2.2: Kernel gate + per-`mm` allocator, landed dark

Add the kernel-side allocator and gate (`mm_context_t` fields, `user_as_live` flag,
`do_mmap_private` routing) plus wire `wasm_user_mem_create` at exec and
`wasm_user_mem_free` at `exit_mmap`. The allocator is **feature-flagged**: addresses
are recorded, but instantiation still uses the shared memory (dark). Test:
`data_start`/`start_stack` are now small (`>=0x10000`); `create` and `free` fire once
per exec/exit; boot remains green. Also audits file-backed `mmap` (see risks §9).
(Refined design §1, §2, §5; critical files `mm/nommu.c`, `fs/binfmt_wasm.c`,
`arch/wasm/include/asm/mmu.h`.)

**Files:**
- Create: `patches/kernel/0016-wasm-per-mm-allocator-dark.patch`
  - `arch/wasm/include/asm/mmu.h` — add to `mm_context_t`: `user_as_size`,
    `user_as_brk`, `user_as_free` (list_head), `user_as_live` (bool).
  - `mm/nommu.c:914` (`do_mmap_private`) — when `user_as_live`, route to the
    per-mm allocator (bump/free-list). **Dark:** allocate but return the shared
    kernel address until T2.3 flips the instantiation.
  - `mm/nommu.c:1187` (anon-zero) — when `user_as_live`, call
    `wasm_user_memzero(pid, uaddr, n)` instead of `memset`.
  - `mm/nommu.c:1426` (`do_munmap`) — when `user_as_live`, free back to the
    free-list (coalesce extents).
  - `mm/nommu.c:1508` (`exit_mmap`) — call `wasm_user_mem_free(pid)` after VMA loop.
  - `fs/binfmt_wasm.c:240` (`load_wasm_file`) — after `setup_new_exec`, call
    `wasm_user_mem_create(pid, init_pages)` and set `mm->context.user_as_live = 1`
    before the data `vm_mmap` at `:346`. Code `vm_mmap` at `:247` stays shared.
- Modify: `kernel.nix` — add `0016` after `0015`.

**Interfaces:**
- Consumes: T2.0 `wasm_user_memzero`, T2.1 `wasm_user_mem_create/free`.
- Produces: `mm->context.user_as_{size,brk,live}` populated; `create`/`free` fire at
  exec/exit; allocator returns user-space offsets (unused by instantiation until T2.3).

- [ ] **Step 1: Write the failing test — verify create/free fire + addresses are small**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-allocator-dark.mjs`: boot the
system, intercept `wasm_user_mem_create`/`wasm_user_mem_free` calls via an instrumented
bridge wrapper, run one `exec` + exit, assert both fired and that the reported
`data_start` is `>= 0x10000` (small offset in the private space, not a shared-memory
large address).

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-allocator-dark.mjs`
Expected: FAIL — `create`/`free` not called (kernel not patched yet); addresses large.

- [ ] **Step 3: Author the kernel patch**

Create `patches/kernel/0016-wasm-per-mm-allocator-dark.patch` against rev `039e5f3e`
with the changes described in the Files block. The per-mm allocator logic (bump +
first-fit free-list) lives in a new `arch/wasm/mm/user_as.c` (or inline in
`nommu.c`); page granularity = 64 KiB (wasm page). Guard all new paths with
`if (mm->context.user_as_live)` so kernel threads and early boot take the existing
shared path. **Audit `do_mmap_private` call sites** for any file-backed target
reaching the allocator; if found, add the bounce-buffer path (file content via
`kernel_read` into a kernel buffer then `wasm_user_copy_to`). Log outcome in a
comment — fulfills the T2.2 file-backed mmap audit.

- [ ] **Step 4: Add patch, rebuild kernel + manifest, re-vendor**

```nix
    # T2.2: per-mm base-0 allocator + gate, landed dark (create/free fire; instantiation unchanged).
    ./patches/kernel/0016-wasm-per-mm-allocator-dark.patch
```
Run:
```
sudo nix build .#kernel --print-out-paths
sudo nix build .#wasm-store-manifest --print-out-paths
```
Re-vendor `vmlinux.wasm` + `store.json`.

- [ ] **Step 5: Run the dark-allocator test + full boot**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-allocator-dark.mjs`
Expected: PASS — `create`/`free` fire; `data_start >= 0x10000`; boot Phase A/B green.

- [ ] **Step 6: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add patches/kernel/0016-wasm-per-mm-allocator-dark.patch kernel.nix && \
  git commit -m "kernel(wasm): T2.2 — per-mm base-0 allocator + gate, dark (create/free wired)"
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/vmlinux.wasm vendor/linux-wasm/store.json && \
  git commit -m "runtime: T2.2 — re-vendor kernel with dark per-mm allocator"
```

---

## Task 2.3: The flip — instantiate against private memory

Remove the dark flag. Wire the private `Memory` (delivered by `create_user_mem` from
T2.1) into `wasm_load_executable` at `kernel-worker.js:846` as `env.memory`; set
`__memory_base = USER_AS_BASE` (`0x10000`); route allocator-overflow to
`wasm_user_mem_grow`; route anon-zero to `wasm_user_memzero` (already wired in T2.2
kernel patch). This is the first real isolation. (Refined design §3–§5; critical
files `runtime/kernel-worker.js:844–858`, `runtime/kernel-host.js:211`.)

**Files:**
- Modify: `runtime/kernel-worker.js:844–858` — change `user_executable_imports.env.memory`
  from the shared `memory` to `userMems.get(current_pid).memory`; set
  `__memory_base = USER_AS_BASE`; move `__indirect_function_table` into
  `userMems.get(current_pid).table` (refined design §4).
- Modify: `runtime/kernel-host.js:211` — the shared `Memory` at line 211 stays
  (kernel-side); it is no longer the user `env.memory`.
- No new kernel patch — T2.2 already removed the dark flag condition from the
  allocator and anon-zero paths; T2.3 is a pure runtime change.

**Interfaces:**
- Consumes: T2.1 `userMems` map (memory present after `create_user_mem` fires);
  T2.2 kernel sends correct small `data_start`/`stack_pointer` offsets.
- Produces: user module instantiated against the per-pid private `Memory`; first
  real isolation; `wasm_user_mem_grow` called on allocator overflow; `wasm_user_memzero`
  zeroes BSS into private memory.

- [ ] **Step 1: Write the failing test — full boot to shell + malloc-heavy program**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-private-mem.mjs`: boot the
system to a shell and run a `guest-cc`-built program that does heavy `malloc`/`free`
(exercises musl mallocng via `mmap` → allocator → `wasm_user_mem_grow`), then prints
`PRIVATE-MEM PASS`:

```c
/* malloc-stress.c */
#include <stdlib.h>
#include <stdio.h>
int main(void) {
  for (int i = 0; i < 1000; i++) { void *p = malloc(4096); if (!p) return 1; free(p); }
  printf("PRIVATE-MEM PASS\n");
  return 0;
}
```

```js
import { bootNixSystem, runShell } from "./exec-nixsystem.mjs";
const run = await bootNixSystem({});
const out = await runShell(run, "/usr/bin/malloc-stress");
if (!out.includes("PRIVATE-MEM PASS")) throw new Error("private memory boot failed:\n" + out);
console.log("PRIVATE-MEM PASS");
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-private-mem.mjs`
Expected: FAIL — user module still instantiated against shared memory; malloc-stress
may crash or produce wrong output.

- [ ] **Step 3: Wire private memory into user instantiation**

In `runtime/kernel-worker.js` near line 846, change:
```js
// Before (shared):
env: { memory: memory, __memory_base: ... }
// After (private):
env: {
  memory: userMems.get(current_pid).memory,
  __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, USER_AS_BASE),
  __indirect_function_table: userMems.get(current_pid).table,
  // ... rest unchanged ...
}
```
`USER_AS_BASE = 0x10000`. Ensure `wasm_user_mem_grow` is routed from the allocator
overflow site (T2.2 kernel patch calls it; runtime `hostbridge.js` already implements
it via `userMems.get(pid).memory.grow(delta_pages)`).

- [ ] **Step 4: Verify guard-page-at-0 tolerance**

In the running test, confirm that `__memory_base = 0x10000` is accepted by the
dylink relocator (data segments land at correct offsets in the private memory, not at
address 0). This fulfils the T2.3 guard-page-at-0 risk from §9.

- [ ] **Step 5: Run the private-memory test + full boot**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-private-mem.mjs`
Expected: PASS — `PRIVATE-MEM PASS`; boot Phase A/B still green; `malloc-stress`
runs without crash.

- [ ] **Step 6: Commit**

```bash
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/kernel-worker.js vendor/linux-wasm/runtime/kernel-host.js scripts/linux-demo/test-private-mem.mjs && \
  git commit -m "runtime: T2.3 — instantiate user module against per-pid private WebAssembly.Memory"
```

---

## Task 2.4: Isolation probe (acceptance B1) + teardown/leak test

Acceptance B1: process B cannot read or corrupt process A's memory. Teardown: the
`userMems` registry returns to baseline after process exit; free fires before kill;
no use-after-free. (Refined design §5 teardown ordering; §8 teardown ordering risk.)

**Files:**
- Create: `userspace/tests/isolation-probe.nix` (two C programs + init manifest)
- Modify: `flake.nix` — expose `.#test-isolation-probe`
- Create: `/home/vbvntv/Code/pc/scripts/linux-demo/test-isolation.mjs` — isolation probe runner
- Create: `/home/vbvntv/Code/pc/scripts/linux-demo/test-teardown.mjs` — teardown/leak runner

**Interfaces:**
- Consumes: per-process private memory (T2.3); `userMems` map accessible for size instrumentation.
- Produces: isolation PASS/LEAK signal; registry-size-before == registry-size-after under rapid spawn/exit.

- [ ] **Step 1: Write the isolation probe test**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-isolation.mjs`:
```js
import { bootProbe } from "./probe-harness.mjs";
const out = await bootProbe({ manifest: "isolation-probe" });
if (out.includes("ISOLATION LEAK")) throw new Error("B observed A's memory:\n" + out);
if (!out.includes("ISOLATION PASS")) throw new Error("probe did not complete:\n" + out);
console.log("ISOLATION PASS (harness)");
```

- [ ] **Step 2: Write the teardown/leak test**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-teardown.mjs`:
```js
import { bootNixSystem, runShell, registrySize } from "./exec-nixsystem.mjs";
const run = await bootNixSystem({ instrument: true });
const before = registrySize(run);
await runShell(run, "i=0; while [ $i -lt 50 ]; do /bin/true; i=$((i+1)); done; echo loop-done");
if (registrySize(run) > before) throw new Error("process memory registry leaked");
console.log("TEARDOWN PASS");
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-isolation.mjs`
Expected: FAIL — isolation-probe manifest / probe-harness not yet built.
Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-teardown.mjs`
Expected: FAIL — registry grows (no unregister on exit yet) or `registrySize` not exposed.

- [ ] **Step 4: Write the two probe programs + expose the probe in the flake**

Create `userspace/tests/isolation-probe.nix` building two `guest-cc` C programs:
```c
/* progA.c */ int main(void){ volatile unsigned *p=(unsigned*)0x100000; *p=0xA11CE; printf("A@%p=%x\n",p,*p); for(;;) pause(); }
/* progB.c */ int main(void){ volatile unsigned *p=(unsigned*)0x100000; unsigned v=*p; printf(v==0xA11CE?"ISOLATION LEAK\n":"ISOLATION PASS\n"); return 0; }
```
Build both with `guest-cc`, assemble an init that launches A (background) then B, emit as probe manifest/initramfs.

In `flake.nix`:
```nix
test-isolation-probe = import ./userspace/tests/isolation-probe.nix { inherit pkgs cross; guestCc = guestCc; };
```

- [ ] **Step 5: Implement teardown in the runtime**

In `runtime/kernel-host.js` `kill_task` (near line 221), after `task.worker.terminate()`,
call `userMems.delete(dead_task)` (imported from `hostbridge.js`). Expose `registrySize`
through the harness instrumentation. Validate `exit_mmap` → `wasm_user_mem_free` fires
before `release_task` kills the worker (ordering from refined design §5).

- [ ] **Step 6: Build the probe + run both tests**

```
sudo nix build .#test-isolation-probe --print-out-paths
```
Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-isolation.mjs`
Expected: PASS — `ISOLATION PASS` (B reads its own zero page, not A's sentinel).
Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-teardown.mjs`
Expected: PASS — `TEARDOWN PASS` (registry returns to baseline).

- [ ] **Step 7: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add userspace/tests/isolation-probe.nix flake.nix && \
  git commit -m "test: T2.4 — cross-process isolation probe (acceptance B1) + teardown nix build"
cd /home/vbvntv/Code/pc && git add scripts/linux-demo/test-isolation.mjs scripts/linux-demo/test-teardown.mjs vendor/linux-wasm/runtime/hostbridge.js vendor/linux-wasm/runtime/kernel-host.js && \
  git commit -m "runtime: T2.4 — registry teardown on exit + isolation/teardown test runners"
```

---

## Task 2.5: clone-with-fn regression guard (acceptance B2)

`posix_spawn`/`vfork`+exec spawn must still work over per-process memory. Each
spawned child gets its own `create_user_mem` + private memory via the normal exec
path (T2.2/T2.3 already wired it). This task adds the explicit regression test and
confirms the `current_pid` is set before `wasm_load_executable` so the child's
private memory registers under the correct pid. (Refined design §7 T2.5; acceptance
B2 from the main spec §8; plan Task 4b thread note.)

**Files:**
- Modify: `runtime/kernel-worker.js` clone branch (~481) — confirm `current_pid =
  message.new_task` is set **before** `host_callbacks.wasm_load_executable(...)` in
  the clone/exec path, so `userMems.set(pid, ...)` keys under the child pid.
- Create: `/home/vbvntv/Code/pc/scripts/linux-demo/test-fastpath.mjs`

**Interfaces:**
- Consumes: per-process memory (T2.3); exec path wires `create_user_mem` per T2.2.
- Produces: `posix_spawn`/pipe/`sh -c` all work over private memories; B2 acceptance met.

- [ ] **Step 1: Write the failing test — existing userspace spawn pipeline**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-fastpath.mjs`:
```js
import { bootNixSystem, runShell } from "./exec-nixsystem.mjs";
const run = await bootNixSystem({});
const out = await runShell(run, "echo hi | cat; sh -c 'exit 7'; echo done");
if (!/hi[\s\S]*done/.test(out)) throw new Error("fork+exec pipeline broke:\n" + out);
console.log("FASTPATH PASS");
```

- [ ] **Step 2: Run to verify it fails (or passes as a regression check)**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-fastpath.mjs`
Expected: FAIL if clone path still references wrong pid for memory lookup; PASS if
T2.3 already threaded it correctly (making this a green regression guard).

- [ ] **Step 3: Verify and fix `current_pid` ordering in the clone path**

In `kernel-worker.js` near line 481, confirm:
```js
if (message.user_executable) {
  current_pid = message.new_task;  // set BEFORE load so private mem registers under child
  host_callbacks.wasm_load_executable(
    message.user_executable.bin_start, message.user_executable.bin_end,
    message.user_executable.data_start, message.user_executable.table_start);
}
```
If already correct from T2.3, no change needed — the test is the guard.

- [ ] **Step 4: Run the fast-path test**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-fastpath.mjs`
Expected: PASS — `FASTPATH PASS`; B2 acceptance met.

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/kernel-worker.js scripts/linux-demo/test-fastpath.mjs && \
  git commit -m "runtime: T2.5 — clone-with-fn regression guard (acceptance B2) over private memory"
```

---

## Task 3: Full acceptance — existing boot + isolation, all green over per-process memory

Confirm the whole Phase 1 deliverable: the existing end-to-end acceptance (`exec-nixsystem.mjs` Phase A + B) still passes over per-process memory, AND the isolation probe passes — together.

**Files:**
- Modify: `/home/vbvntv/Code/pc/scripts/linux-demo/` — add a `test-phase1.mjs` aggregator
- Modify: `flake.nix` — ensure `.#kernel` + `.#test-isolation-probe` are the CI build set
- Modify: `docs/superpowers/specs/2026-06-18-mmu-fork-design.md` — tick Phase 1 acceptance

**Interfaces:**
- Consumes: Task 1 + Tasks 2.0–2.5.

- [ ] **Step 1: Write the aggregate acceptance test**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-phase1.mjs`:

```js
import { execSync } from "node:child_process";
for (const t of ["test-hostbridge-smoke","test-allocator-dark","test-private-mem","test-isolation","test-teardown","test-fastpath"]) {
  execSync(`node scripts/linux-demo/${t}.mjs`, { stdio: "inherit" });
}
console.log("PHASE 1 ACCEPTANCE: ALL PASS");
```

- [ ] **Step 2: Run the full suite**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-phase1.mjs`
Expected: PASS — all six sub-tests, ending `PHASE 1 ACCEPTANCE: ALL PASS`.

- [ ] **Step 3: Run the original end-to-end acceptance unchanged**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/exec-nixsystem.mjs`
Expected: PASS — Phase A (boot → shell) and Phase B (`nix-env -iA sl` renders) still green, now over per-process memory.

- [ ] **Step 4: Update the spec acceptance note + commit**

In the spec, mark Section 5 "Acceptance for Phase 1" satisfied (isolation probe B1 + fast path B2 + boot). Commit:

```bash
cd /home/vbvntv/Code/nix-wasm && git add docs/superpowers/specs/2026-06-18-mmu-fork-design.md flake.nix && \
  git commit -m "docs: Phase 1 (per-process isolation) acceptance met"
cd /home/vbvntv/Code/pc && git add scripts/linux-demo/test-phase1.mjs && \
  git commit -m "harness: Phase 1 aggregate acceptance suite"
```

---

## Self-Review

**Spec coverage (Phase 1 portions of `2026-06-18-mmu-fork-design.md`):**
- §4 host-bridge (single choke point) → Task 1 (+ Global Constraints).
- §4 double-return seam → **Phase 2, out of scope here** (correctly deferred).
- §5 runtime: per-process Memory+table, base-0 instantiation → Tasks 2.1–2.3; threads share → see Task 4b note below; registry/teardown → Task 2.4.
- §5 kernel: per-process address space, route copy_to/from_user/get_user_pages/strncpy_from_user/exec through bridge → Tasks 1, 2.0, 2.2; close residual direct-deref uaccess → Task 2.0; exec into fresh memory + allocator → Tasks 2.2–2.3.
- §5 substrate: per-`mm` base-0 allocator + `wasm_user_mem_*` ABI v2 → Tasks 2.1–2.3; R1 registry + main-thread minting → Task 2.1.
- §5 acceptance (boot over per-process mem; isolation probe; clone-with-fn regression) → Tasks 2.3 (boot), 2.4 (B1), 2.5 (B2), 3 (aggregate).
- §7 forward-compat rule 1 (single page-aware choke point) → Global Constraints + Task 1; rule 2 ("duplicate memory" discrete) → Phase 2.
- §8 testing: isolation probe (B1) + fast-path (B2) → Tasks 2.4, 2.5. (Imported POSIX/musl suites + B3 are Phase 2.)
- §9 risks: two-repo ABI (`WASM_HOSTBRIDGE_ABI`) → Global Constraints; `get_user_pages` caller audit → Task 1 Step 5 + Global Constraints; new T2 risks (strnlen_user, teardown ordering, guard-page, cross-pid, file-backed mmap) → Tasks 2.0–2.4.

**Old Task 2 Step 5 (point driver buffer reads at process memory) — REMOVED.** Drivers (9p, hvc, random) read from **kernel** buffers allocated in the shared pool; `get_user_pages` populates a kernel bounce buffer, not a user-memory reference. Routing driver reads at a per-process memory was wrong. The host-bridge is the sole path that touches user bytes; drivers reach user data only via `copy_to/from_user` → bridge.

**Task 2 re-decomposed into T2.0–T2.5** (replaces the original single Task 2 in its entirety). Patch 0014 from the old plan is replaced by 0015 (T2.0 residual uaccess) and 0016 (T2.2 per-mm allocator dark). The `WASM_HOSTBRIDGE_ABI` bumps from 1 (Task 1) to 2 (T2.1).

**Placeholder scan:** kernel patch *bodies* give real signatures + insertion-point file:line refs from the refined design doc but not a full unified diff (produced against the pinned source at implementation time). All JS steps show real code; all tests are concrete and runnable.

**Type consistency:** bridge names (`wasm_user_copy_to`/`_from`/`wasm_user_strncpy`/`wasm_user_memzero`, `wasm_user_mem_create/grow/free`, `userMems`, `WASM_HOSTBRIDGE_ABI`) are used identically across Tasks 1–2.5. `current_pid` threading introduced in Task 1, reused in Tasks 2.1–2.5.

### Task 4b: `CLONE_VM` threads share the parent's memory

**Files:** Modify `kernel-worker.js` clone branch (~481) + `wasm_load_executable` (~298).

- [ ] **Step 1: Failing test** — `/home/vbvntv/Code/pc/scripts/linux-demo/test-threads.mjs`: a `guest-cc` pthread program where the child thread writes a global the main thread then reads; assert the value is observed (shared memory). FAIL if the thread got a private memory.
- [ ] **Step 2: Run, expect FAIL** (`node scripts/linux-demo/test-threads.mjs`).
- [ ] **Step 3:** In the clone path, branch on `CLONE_VM`: if set, instantiate the new task's user instance against `userMems.get(parent_pid).memory` instead of allocating a new `Memory`; register the child pid → parent memory entry.
- [ ] **Step 4: Run, expect PASS** (`THREADS PASS`).
- [ ] **Step 5: Commit** (`runtime: CLONE_VM threads share the parent address space`).

---

## Execution Handoff

Phase 1 is the substrate; Phase 2 (asyncify true `fork()` + imported POSIX/musl correctness suites) will be a separate plan, gated on Phase 1 passing and a `capture_stack`/`resume_stack` spike (does asyncify unwind cleanly through musl's syscall wrapper — spec risk B3).
