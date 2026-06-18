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
- Create `patches/kernel/0013-wasm-uaccess-hostbridge.patch` — replace `UACCESS_MEMCPY` with an arch `raw_copy_to/from_user` + `strncpy_from_user` that call the host-bridge import; declare the import in `arch/wasm/include/asm/wasm.h`; drop `select UACCESS_MEMCPY` in `arch/wasm/Kconfig`.
- Create `patches/kernel/0014-wasm-per-process-user-as.patch` — per-process user address-space base in `mm` / `binfmt_wasm.c`: allocate user code/data/stack in the process's own base-0 space and pass a process-memory handle to the runtime on exec/clone.
- Modify `kernel.nix:29-48` — add the two patches to the `patches` list (after `0012`).
- Create `userspace/tests/isolation-probe.nix` — two tiny C programs (A writes a sentinel to a known address and sleeps; B attempts to read/clobber that address) built with `guest-cc`, plus a runner manifest.
- Modify `flake.nix` — expose `.#test-isolation-probe` (the probe initramfs/manifest) and `.#kernel` stays the build target.

**pc repo (`/home/vbvntv/Code/pc/vendor/linux-wasm/runtime`):**
- Modify `kernel-worker.js` — (a) add the host-bridge import `wasm_user_copy`/`wasm_user_copy_from`/`wasm_user_strncpy` near the syscall imports (~line 700); (b) allocate a private `WebAssembly.Memory` per user process and instantiate `user_executable_instance` against it at base 0 (~lines 298-314, 659-684); (c) point hvc/9p/console user-buffer reads at the process memory, not the shared buffer (~lines 400-438).
- Modify `kernel-host.js` — per-process memory registry + teardown (`make_task` ~208, `kill_task` ~221); console_read writes to the process memory (~140-153).
- Create `runtime/hostbridge.js` — the synchronous copy helpers + the `WASM_HOSTBRIDGE_ABI` constant, imported by both worker and host. One responsibility: bytes between a source view and a target process `Memory`.

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

## Task 2: Give each user process its own private `WebAssembly.Memory`

Now split: allocate a private `Memory` per process, instantiate the user module against it at base 0, and point the bridge resolver + driver buffer reads at the process memory. The kernel exec path allocates user code/data/stack in the process's own base-0 space.

**Files:**
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-worker.js:298-314` (`wasm_load_executable`), `659-684` (user imports), `400-438` (driver buffer reads)
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-host.js:140-153` (console_read), `208-219` (make_task registry)
- Create: `patches/kernel/0014-wasm-per-process-user-as.patch`
- Modify: `kernel.nix` (add `0014`)

**Interfaces:**
- Consumes: `makeHostBridge`/`wasm_user_copy_*` (Task 1).
- Produces: per-process `processMem.get(pid) -> WebAssembly.Memory`; user module instantiated with `env.memory = processMem`, `__memory_base = base` (process-local), data segments applied into `processMem`.

- [ ] **Step 1: Write the failing test — a write() that crosses the split**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-split-write.mjs`: boot a minimal init that runs a `guest-cc`-built `hello` doing `write(1,"split-ok\n",9)`. Because `write()` does `copy_from_user` on the user buffer, success proves the bridge addresses the *private* memory.

```js
import { bootProbe } from "./probe-harness.mjs"; // thin reuse of exec-nixsystem boot
const out = await bootProbe({ initBinary: "hello-write" });
if (!out.includes("split-ok")) throw new Error("write() across split memory failed:\n" + out);
console.log("SPLIT-WRITE PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-split-write.mjs`
Expected: FAIL — user still instantiated against shared memory (no split yet), or `probe-harness`/`hello-write` missing.

- [ ] **Step 3: Allocate a private memory at user-load time (runtime)**

In `kernel-worker.js` `wasm_load_executable` (~298), create a per-process memory and record it:

```js
wasm_load_executable: (bin_start, bin_end, data_start, table_start) => {
  reset_syscall_trace();
  const bytes = new Uint8Array(memory.buffer).slice(bin_start, bin_end);
  user_executable = WebAssembly.compile(bytes);
  // Phase 1: private address space for this process (base 0).
  user_process_memory = new WebAssembly.Memory({
    initial: USER_AS_INITIAL_PAGES, maximum: USER_AS_MAX_PAGES, shared: false,
  });
  registerProcessMemory(current_pid, user_process_memory); // host-bridge resolver source
  user_executable_params = { data_start, table_start, table_initial: table_import_initial(bytes) };
  user_executable_instance = null;
};
```

- [ ] **Step 4: Instantiate the user module against the private memory**

In the user imports block (~659), replace `memory: memory` and the base globals so the user sees its own memory at base 0:

```js
user_executable_imports = {
  env: {
    memory: user_process_memory,                 // PRIVATE, not the shared buffer
    __memory_base: new WebAssembly.Global({ value: "i"+arch_bits, mutable:false }, Ulong(USER_AS_BASE)),
    __stack_pointer: new WebAssembly.Global({ value: "i"+arch_bits, mutable:true }, stack_pointer),
    __indirect_function_table: new WebAssembly.Table({ initial: Math.max(4096, user_executable_params.table_initial||0), element:"anyfunc" }),
    __table_base: new WebAssembly.Global({ value:"i"+arch_bits, mutable:false }, Ulong(0)),
    ...,
  },
};
```

Point the bridge resolver at the registry: `makeHostBridge(memory, (pid) => ({ u8: () => new Uint8Array(processMemFor(pid).buffer) }))`.

- [ ] **Step 5: Point driver buffer reads at the process memory**

`wasm_driver_hvc_put` (~400) and the 9p/console paths read the user buffer; they must read the process memory, not `memory.buffer`:

```js
const memory_u8 = new Uint8Array(processMemFor(current_pid).buffer);
```
Do the same in `kernel-host.js` `console_read` (~140) by routing through the host (host gets the target pid in the message and looks up its registered memory).

- [ ] **Step 6: Author the kernel per-process address-space patch**

Create `patches/kernel/0014-wasm-per-process-user-as.patch`: `binfmt_wasm.c` allocates user code/data/stack as offsets in the process's own base-0 space (a per-mm bump base starting at `USER_AS_BASE`), and `process.c` passes nothing extra (the runtime keys on `current_pid`). The user addresses the kernel records in `mm->start_code/start_data/start_brk` are now process-local (base 0), which the bridge resolves via the registry. Keep `USER_AS_BASE`/page constants in a shared header so kernel and runtime agree.

- [ ] **Step 7: Add patch, rebuild kernel + manifest, re-vendor**

```
# kernel.nix: add ./patches/kernel/0014-wasm-per-process-user-as.patch
sudo nix build .#kernel --print-out-paths
sudo nix build .#wasm-store-manifest --print-out-paths
```
Re-vendor `vmlinux.wasm` + `store.json` into `pc/vendor/linux-wasm/`.

- [ ] **Step 8: Run the split-write test**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-split-write.mjs`
Expected: PASS — `SPLIT-WRITE PASS` (write() copies from the *private* memory via the bridge).

- [ ] **Step 9: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add patches/kernel/0014-wasm-per-process-user-as.patch kernel.nix && \
  git commit -m "kernel(wasm): allocate user code/data/stack in a per-process base-0 space"
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/*.js scripts/linux-demo/test-split-write.mjs vendor/linux-wasm/vmlinux.wasm vendor/linux-wasm/store.json && \
  git commit -m "runtime: private WebAssembly.Memory per process; bridge targets it"
```

---

## Task 3: Isolation probe — process B cannot read/corrupt process A

The acceptance assertion for Phase 1: two processes in separate address spaces; B must NOT be able to observe or clobber A's sentinel.

**Files:**
- Create: `userspace/tests/isolation-probe.nix` (two C programs + manifest)
- Modify: `flake.nix` (expose `.#test-isolation-probe`)
- Create: `/home/vbvntv/Code/pc/scripts/linux-demo/test-isolation.mjs`

**Interfaces:**
- Consumes: per-process memory (Task 2); `guest-cc` to build the probes.
- Produces: a boot manifest running A then B; console output `ISOLATION PASS` or `ISOLATION LEAK`.

- [ ] **Step 1: Write the failing test**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-isolation.mjs`:

```js
import { bootProbe } from "./probe-harness.mjs";
const out = await bootProbe({ manifest: "isolation-probe" });
if (out.includes("ISOLATION LEAK")) throw new Error("B observed A's memory:\n" + out);
if (!out.includes("ISOLATION PASS")) throw new Error("probe did not complete:\n" + out);
console.log("ISOLATION PASS (harness)");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-isolation.mjs`
Expected: FAIL — `isolation-probe` manifest/`probe-harness` not built yet.

- [ ] **Step 3: Write the two probe programs**

Create `userspace/tests/isolation-probe.nix` building two `guest-cc` C programs. A writes a known 32-bit sentinel at a fixed user address and prints its own address+value, then loops; B maps/derefs the same numeric address and reports whether it sees A's sentinel:

```c
/* progA.c */ int main(void){ volatile unsigned *p=(unsigned*)0x100000; *p=0xA11CE; printf("A@%p=%x\n",p,*p); for(;;) pause(); }
/* progB.c */ int main(void){ volatile unsigned *p=(unsigned*)0x100000; unsigned v=*p; printf(v==0xA11CE?"ISOLATION LEAK\n":"ISOLATION PASS\n"); return 0; }
```

Build both with `guest-cc`, assemble an init that launches A (background) then B, and emit as a probe manifest/initramfs.

- [ ] **Step 4: Expose the probe in the flake**

In `flake.nix` add to `packages.${system}`:

```nix
        # Phase 1 acceptance: cross-process memory isolation probe.
        test-isolation-probe = import ./userspace/tests/isolation-probe.nix { inherit pkgs cross; guestCc = guestCc; };
```

- [ ] **Step 5: Build the probe + re-vendor**

```
sudo nix build .#test-isolation-probe --print-out-paths
```
Vendor the probe manifest where `probe-harness.mjs` loads it.

- [ ] **Step 6: Run the isolation test**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-isolation.mjs`
Expected: PASS — `ISOLATION PASS` (B reads its own zero page, not A's sentinel).

- [ ] **Step 7: Commit**

```bash
cd /home/vbvntv/Code/nix-wasm && git add userspace/tests/isolation-probe.nix flake.nix && \
  git commit -m "test: cross-process memory isolation probe (Phase 1 acceptance)"
cd /home/vbvntv/Code/pc && git add scripts/linux-demo/test-isolation.mjs && \
  git commit -m "harness: isolation-probe runner"
```

---

## Task 4: clone-with-fn over private memory (fast-path regression guard)

Existing spawn (`posix_spawn`/`vfork`+exec, busybox/ash/make) must still work — now each spawned process gets its own private memory. This guards that the split didn't break the only spawn path the guest currently uses.

**Files:**
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-worker.js:481-490` (clone reload path), `217-249` (`wasm_create_and_run_task`)
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-host.js:208-219` (make_task)

**Interfaces:**
- Consumes: private-memory allocation (Task 2), which already runs in `wasm_load_executable` — so a cloned task that reloads its executable gets a fresh private memory automatically.
- Produces: each child task isolated; `exec` in the child re-allocates its own memory.

- [ ] **Step 1: Write the failing test — existing userspace still spawns**

Reuse the existing acceptance: a shell pipeline + `make` that fork+exec. Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-fastpath.mjs`:

```js
import { bootNixSystem, runShell } from "./exec-nixsystem.mjs";
const run = await bootNixSystem({});
const out = await runShell(run, "echo hi | cat; sh -c 'exit 7'; echo done");
if (!/hi[\s\S]*done/.test(out)) throw new Error("fork+exec pipeline broke:\n" + out);
console.log("FASTPATH PASS");
```

- [ ] **Step 2: Run it to verify it fails (or regresses)**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-fastpath.mjs`
Expected: FAIL initially if the clone reload path still references shared-memory offsets for the child.

- [ ] **Step 3: Ensure cloned tasks reload into a fresh private memory**

In `kernel-worker.js` (~481), the clone branch already calls `host_callbacks.wasm_load_executable(...)`, which now (Task 2) allocates a private memory. Confirm the child's `current_pid` is set *before* that call so `registerProcessMemory` keys correctly; thread the new task's pid through `make_task`/the init message:

```js
if (message.user_executable) {
  current_pid = message.new_task;          // set BEFORE load so the private mem registers under the child
  host_callbacks.wasm_load_executable(
    message.user_executable.bin_start, message.user_executable.bin_end,
    message.user_executable.data_start, message.user_executable.table_start);
}
```

- [ ] **Step 4: Run the fast-path test**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-fastpath.mjs`
Expected: PASS — `FASTPATH PASS`.

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/*.js scripts/linux-demo/test-fastpath.mjs && \
  git commit -m "runtime: clone-with-fn children get their own private memory"
```

---

## Task 5: Teardown — free private memory + registry on exit/reap

Per-process `Memory` + table + registry entry must be released when a task exits, with no leak under rapid spawn/exit.

**Files:**
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-host.js:221-236` (`kill_task`)
- Modify: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/kernel-worker.js` (unregister on exit)
- Create: `/home/vbvntv/Code/pc/vendor/linux-wasm/runtime/hostbridge.js` registry (`registerProcessMemory`/`unregisterProcessMemory`/`processMemFor`)

**Interfaces:**
- Consumes: the registry from Task 2.
- Produces: `unregisterProcessMemory(pid)` called on task death; worker terminate drops the private `Memory` (GC).

- [ ] **Step 1: Write the failing test — spawn/exit loop doesn't leak or crash**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-teardown.mjs`: run `for i in $(seq 1 50); do /bin/true; done` in-guest and assert it completes and the host registry returns to its baseline size.

```js
import { bootNixSystem, runShell, registrySize } from "./exec-nixsystem.mjs";
const run = await bootNixSystem({ instrument: true });
const before = registrySize(run);
await runShell(run, "i=0; while [ $i -lt 50 ]; do /bin/true; i=$((i+1)); done; echo loop-done");
if (registrySize(run) > before) throw new Error("process memory registry leaked");
console.log("TEARDOWN PASS");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-teardown.mjs`
Expected: FAIL — registry grows (no unregister on exit) or `registrySize` not exposed.

- [ ] **Step 3: Unregister on task death**

In `kernel-host.js` `kill_task` (~221), after `task.worker.terminate(); delete tasks[dead_task];` add `unregisterProcessMemory(dead_task);`. Add `registry` map + the three functions to `hostbridge.js`; have the worker call `unregisterProcessMemory(current_pid)` on its exit syscall path.

- [ ] **Step 4: Run the teardown test**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-teardown.mjs`
Expected: PASS — `TEARDOWN PASS` (registry returns to baseline).

- [ ] **Step 5: Commit**

```bash
cd /home/vbvntv/Code/pc && git add vendor/linux-wasm/runtime/*.js scripts/linux-demo/test-teardown.mjs && \
  git commit -m "runtime: free per-process memory + registry entry on exit"
```

---

## Task 6: Full acceptance — existing boot + isolation, all green over per-process memory

Confirm the whole Phase 1 deliverable: the existing end-to-end acceptance (`exec-nixsystem.mjs` Phase A + B) still passes over per-process memory, AND the isolation probe passes — together.

**Files:**
- Modify: `/home/vbvntv/Code/pc/scripts/linux-demo/` — add a `test-phase1.mjs` aggregator
- Modify: `flake.nix` — ensure `.#kernel` + `.#test-isolation-probe` are the CI build set
- Modify: `docs/superpowers/specs/2026-06-18-mmu-fork-design.md` — tick Phase 1 acceptance

**Interfaces:**
- Consumes: Tasks 1-5.

- [ ] **Step 1: Write the aggregate acceptance test**

Create `/home/vbvntv/Code/pc/scripts/linux-demo/test-phase1.mjs`:

```js
import { execSync } from "node:child_process";
for (const t of ["test-hostbridge-smoke","test-split-write","test-isolation","test-fastpath","test-teardown"]) {
  execSync(`node scripts/linux-demo/${t}.mjs`, { stdio: "inherit" });
}
console.log("PHASE 1 ACCEPTANCE: ALL PASS");
```

- [ ] **Step 2: Run the full suite**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/test-phase1.mjs`
Expected: PASS — all five sub-tests, ending `PHASE 1 ACCEPTANCE: ALL PASS`.

- [ ] **Step 3: Run the original end-to-end acceptance unchanged**

Run: `cd /home/vbvntv/Code/pc && node scripts/linux-demo/exec-nixsystem.mjs`
Expected: PASS — Phase A (boot → shell) and Phase B (`nix-env -iA sl` renders) still green, now over per-process memory.

- [ ] **Step 4: Update the spec acceptance note + commit**

In the spec, mark Section 5 "Acceptance for Phase 1" satisfied (isolation probe + fast path + boot). Commit:

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
- §5 runtime: per-process Memory+table, base-0 instantiation → Task 2; threads share → see note below; registry/teardown → Task 5.
- §5 kernel: per-process address space, route copy_to/from_user/get_user_pages/strncpy_from_user/exec through bridge → Tasks 1-2; exec into fresh memory → Task 2.
- §5 acceptance (boot over per-process mem; isolation probe; clone-with-fn regression) → Tasks 3, 4, 6.
- §7 forward-compat rule 1 (single page-aware choke point) → Global Constraints + Task 1; rule 2 ("duplicate memory" discrete) → Phase 2.
- §8 testing: isolation probe (B1) + fast-path (B2) → Tasks 3, 4. (Imported POSIX/musl suites + B3 are Phase 2.)
- §9 risks: two-repo ABI (versioned `WASM_HOSTBRIDGE_ABI`) → Global Constraints; `get_user_pages` caller audit → Task 1 Step 5 scope + Global Constraints.

**Gap found + closed:** §5 "threads (`CLONE_VM`) share their process's memory." Phase 1 as written gives every *task* its own memory on `wasm_load_executable`; a `CLONE_VM` thread must instead **share** the parent's. Add **Task 4b** below before Task 5 in execution.

**Placeholder scan:** the kernel patch *bodies* in Tasks 1/2 Step "author the patch" give real signatures + logic but not a full unified diff (the exact diff is produced against the pinned source during implementation) — this is the honest boundary, not a TODO. All JS steps show real code; all tests are concrete and runnable.

**Type consistency:** bridge names (`wasm_user_copy_to`/`_from`/`wasm_user_strncpy`, `registerProcessMemory`/`unregisterProcessMemory`/`processMemFor`, `WASM_HOSTBRIDGE_ABI`) are used identically across Tasks 1-5. `current_pid` threading introduced in Task 2, reused in Tasks 4-5.

### Task 4b: `CLONE_VM` threads share the parent's memory

**Files:** Modify `kernel-worker.js` clone branch (~481) + `wasm_load_executable` (~298).

- [ ] **Step 1: Failing test** — `/home/vbvntv/Code/pc/scripts/linux-demo/test-threads.mjs`: a `guest-cc` pthread program where the child thread writes a global the main thread then reads; assert the value is observed (shared memory). FAIL if the thread got a private memory.
- [ ] **Step 2: Run, expect FAIL** (`node scripts/linux-demo/test-threads.mjs`).
- [ ] **Step 3:** In the clone path, branch on `CLONE_VM`: if set, instantiate the new task's user instance against `processMemFor(parent_pid)` instead of allocating a new `Memory`; register the child pid → parent memory.
- [ ] **Step 4: Run, expect PASS** (`THREADS PASS`).
- [ ] **Step 5: Commit** (`runtime: CLONE_VM threads share the parent address space`).

---

## Execution Handoff

Phase 1 is the substrate; Phase 2 (asyncify true `fork()` + imported POSIX/musl correctness suites) will be a separate plan, gated on Phase 1 passing and a `capture_stack`/`resume_stack` spike (does asyncify unwind cleanly through musl's syscall wrapper — spec risk B3).
