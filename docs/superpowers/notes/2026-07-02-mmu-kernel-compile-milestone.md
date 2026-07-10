# CONFIG_MMU=y wasm kernel — compile+link milestone (#128 Track A kernel half)

## ★ IT BOOTS (2026-07-02) ★

`runtime/demo/node/mmu-smoke.mjs` **PASSES**: a `CONFIG_MMU=y` vmlinux boots a
softmmu-INSTRUMENTED init (`userspace/mmu-init.c`) to completion under the
runtime engine (ENGINE_ABI 9). Proven bit-exact: a 16384-element
store->load->sum checksum over translated memory renders `0x98c9e000` — the
exact expected value; bulk memory.copy/fill translate; software uaccess crosses
the user boundary. The full A1 software-MMU stack works end to end:
CONFIG_MMU=y kernel -> contiguous-identity vmalloc -> MMU exec (kernel binary
buffer -> engine instantiation with pt_base -> __mmu_start) -> software uaccess
table-walk -> full stack population -> translated user execution.

The two KEYSTONE fixes, both found by BOOTING (the vmalloc hazard I predicted
in advance became empirical, then got its correct fix):

1. **vmalloc contiguous-identity** (`mm/vmalloc.c`, `#ifdef CONFIG_WASM`): the
   identity-mapped kernel cannot reach scattered vmalloc pages. The RIGHT design
   for a SOFTWARE MMU is NOMMU's vmalloc semantics — physically contiguous
   memory at its identity address (kmalloc/kfree/virt_to_page) — since the arch
   already commits to large contiguous blocks (MAX_ORDER=16). NOT a workaround:
   it is the correct completion of the identity-kernel architecture. (Option B,
   instrumenting the kernel, was REJECTED: our ~3-4x translate would tax every
   kernel memory access AND still need the uaccess soft-walk — strictly worse.)
2. **full initial-stack population at exec** (`fs/binfmt_wasm.c`): the A1
   fast-path translate has no present check, so every touchable page must be
   populated before instrumented code runs; setup_arg_pages left the stack VMA
   demand-paged, so a grown stack page silently mistranslated (caught precisely:
   one checksum nibble wrote 0x00 through a zero PTE). Runtime stack GROWTH
   beyond the initial VMA is the A2 present-check generalization.

Everything is in `patches/kernel/0023-wasm-software-mmu.patch`, wired REPRODUCIBLY:
`nix build .#kernel-mmu` builds the CONFIG_MMU=y vmlinux (kernel.nix `mmu=true`
applies 0023 + flips the config), and the mmu-smoke boots the NIX-BUILT kernel +
`nix build .#mmu-init` to PASS — even on the FULL production config (net/bpf/tty),
because contiguous-vmalloc unblocks bpf_prog_alloc too. CI gate:
`KM=$(nix build .#kernel-mmu --print-out-paths); MI=$(nix build .#mmu-init --print-out-paths);
MMU_VMLINUX=$KM/vmlinux.wasm MMU_INIT=$MI/bin/mmu-init node runtime/demo/node/mmu-smoke.mjs`.
Next: the A2 present-check in the translate for demand paging (runtime stack
growth beyond the initial VMA), then wiring mmu-smoke into nix-wasm.yml.

---


Date: 2026-07-02

## What landed (verified on the x86_64 build box)

The `arch/wasm` MMU layer now **compiles and links end-to-end** with
`CONFIG_MMU=y`, producing a `vmlinux` (4.1 MB). The default **NOMMU build is
unregressed** (still builds clean, 3.8 MB) — every edit is `#ifdef CONFIG_MMU`
guarded. The work is preserved as `mmu-wip-0023-arch-layer.patch` (validated:
reverse-applies cleanly to the patched tree; apply AFTER kernel patches
0004-0022). **NOT yet wired into `kernel.nix`** — it does not BOOT yet.

Method: empirical wall-advancing. Add `config MMU` to `arch/wasm/Kconfig`
(selectable, `default n`), enable it, `make vmlinux`, fix each compiler/linker
wall. Error surface progression: dozens (generic pgtable.h) → 8 → 947 (swap/tlb)
→ 44 → 4 → 1 → **0**. Probe env: raw kernelSrc + patches 0004-0022 + the cached
`kernel-cc` toolchain, `make ARCH=wasm ... vmlinux`.

## The layer (all in the WIP patch)

- **`asm/pgtable.h`** — classic 32-bit 2-level (PGDIR_SHIFT=22, 1024/1024) over
  the §1 PTE format (bits 0-11 flags, 12-31 phys base). Full PTE/PMD accessor
  set, swap-entry encoding, `update_mmu_cache` no-ops. Kept the NOMMU stub path
  under `#else`.
- **`asm/pgalloc.h`** (new) — `pmd_populate{,_kernel}`, `__pte_free_tlb`,
  `pgd_alloc` (extern). Modeled on nios2 (a 2-level MMU arch in the same tree).
- **`asm/tlbflush.h`** (new) — all flushes are no-ops (no hardware TLB; the
  instrumentation pass re-reads the PTE every access, so mapping changes are
  visible immediately — the design's stated upside).
- **`asm/mmu_context.h`** — (still nommu_context; switch_mm→pt_base is the NEXT
  step, see below).
- **`mm/pgtable.c`** (new) — `swapper_pg_dir`, `pgd_alloc` (user half zeroed,
  kernel half copied from swapper), `paging_init` (no-op: zones come from the
  generic `free_area_init` → the existing `arch_zone_limits_init`).
- **`asm/processor.h`** — `STACK_TOP`/`STACK_TOP_MAX`/`TASK_UNMAPPED_BASE` (MMU).
- **`asm/io.h`** — identity `ioremap`/`iounmap` (kernel runs in physical space).
- **`asm/elf.h`** — `elf_check_arch`(=1), `ELF_HWCAP`/`ELF_PLATFORM`/
  `ELF_EXEC_PAGESIZE`, `ELF_ET_DYN_BASE`.
- Config: `--disable CONFIG_BINFMT_ELF` (the guest execs wasm via binfmt_wasm,
  not ELF; binfmt_elf's `START_THREAD` wants a 3-arg `start_thread` the arch
  doesn't have).

## Update (2026-07-02, second pass): items 1+2 are IN the WIP patch

1. **`switch_mm` → set `pt_base`** — DONE (kernel side): `asm/mmu_context.h`
   defines `switch_mm`/`activate_mm` calling a `__mmu_set_pt_base(pgd)` host
   import (the kernel links `--import-undefined`, and the import is VERIFIED
   present in the built vmlinux's import section as `env.__mmu_set_pt_base`).
   The ENGINE half (kernel-worker.js providing it + writing the user module's
   `__mmu_pt_base` global) is still to come, WITH an ENGINE_ABI bump.
2. **uaccess table-walk** — DONE (kernel side): `select UACCESS_MEMCPY if !MMU`;
   `asm/uaccess.h` (MMU branch) + `arch/wasm/mm/uaccess.c` implement
   `raw_copy_{to,from}_user`/`__clear_user` as a software walk of the current
   mm's 2-level table, page-chunked, write-protect-aware; unmapped → remaining
   bytes (the raw_copy fault contract). Kernel-nofault access stays identity.
   A2 will route misses through handle_mm_fault for demand paging.

## Update (third pass): exec-path findings + uaccess fault-in

- **The upstream loader is already MMU-READY**: `fs/binfmt_wasm.c` carries
  `#ifdef CONFIG_MMU` branches (`setup_arg_pages(bprm, STACK_TOP, …)` +
  `create_wasm_tables(bprm, bprm->p)`) vs the NOMMU `transfer_args_to_stack`.
  One real bug in that (never-exercised) MMU branch is FIXED in the WIP patch:
  the auxv block was written with a raw `memcpy(sp, …)` to a USER pointer —
  now `copy_to_user` (correct on both configs).
- **uaccess fault-in**: the software walk now retries through
  `fixup_user_fault` (FAULT_FLAG_KILLABLE|WRITE) on a miss — the software
  analog of a hardware uaccess fault + fixup, demand-paging/COW-aware (futex's
  API). Without it, exec's `put_user`s to the freshly-created stack VMA (not
  yet faulted in) would EFAULT.
- **The remaining exec seam is the ENGINE handoff**: `__switch_to` /
  `start_thread` pass `(bin_start=mm->start_code, bin_end, data_start)` to
  `wasm_create_and_run_task` / `wasm_load_executable`. On NOMMU those are
  physical (contiguous file mmap). Under MMU `vm_mmap(file)` yields a
  demand-paged USER VMA — the engine cannot read the binary bytes at those
  addresses. Correct shape: under MMU the kernel reads the binary into a
  KERNEL buffer (physical; the host "makes its copy" anyway per the loader
  comment, so the buffer can be freed after wasm_load_executable) and passes
  that; `data_start` (the user module's __memory_base) becomes a USER VA —
  correct, since the instrumented module translates every access through the
  page table the kernel built for that VMA.

## Update (fourth pass): exec handoff + A2 fault entry — KERNEL SIDE COMPLETE

- **Exec engine handoff — DONE (kernel side).** Engine-source audit
  (kernel-worker.js): `wasm_load_executable` copies the bytes synchronously,
  BUT the dlopen loader re-reads the live `user_executable_range` lazily and
  clone first-run re-reads `mm->start_code` — so the bytes must stay valid for
  the mm's LIFETIME. Under MMU exec therefore reads the binary into a
  physically-contiguous kernel buffer (`alloc_pages_exact` + `kernel_read`)
  owned by the new `mm_context_t` (`asm/mmu.h`) and freed in
  `destroy_context`; `mm->start_code/end_code` point at it (the engine reads
  identity); dylink.0 meminfo parses from the kernel copy
  (`parse_dylink0_meminfo`); the file is never user-mapped. **A1 lever:**
  `mm->def_flags |= VM_LOCKED` — every VMA (data, stack, future user mmaps) is
  populated at creation, because the A1 fast translate has NO present check.
- **A2 fault entry — DONE (kernel side).** `arch/wasm/mm/fault.c`
  `__wasm_mmu_fault(addr, kind)` (kind: 0=read 1=write 2=exec) →
  `lock_mm_and_find_vma` (+`select LOCK_MM_AND_FIND_VMA if MMU`) →
  `handle_mm_fault` with retry/COMPLETED/OOM/SIGBUS/SIGSEGV handling — the
  standard modern arch fault shape. Verified EXPORTED in the built vmlinux.
  Return 0 = retry the translate; nonzero = fatal signal queued.

## Update (fifth pass): ENGINE HALF WIRED (ENGINE_ABI 9)

The engine handoff is implemented in `runtime/kernel-worker.js` (ABI 8→9):

- **pt_base rides the exec ABI**: `wasm_load_executable` and
  `wasm_create_and_run_task` grew a trailing `pt_base` arg (kernel passes
  `mm->pgd` under MMU, 0 on NOMMU — extra trailing args are ignored by JS, so
  NOMMU images stay compatible both directions); clone task-creation messages
  carry it to the child worker.
- **Applied at instantiation**: a softmmu-instrumented image exports the
  mutable `__mmu_pt_base` global — the engine sets it right after
  `user_executable_instance` is created. **Per-task instances each carry their
  own root**, so context switches swap nothing (the engine-model insight:
  there is no shared MMU register — `switch_mm` becomes a write-through via
  the new `env.__mmu_set_pt_base` kernel import, provided unconditionally and
  imported only by MMU vmlinux builds).
- **Userspace is instrumented at BUILD time** (a softmmu nix seam like
  fpcast/dynsym), NOT by the engine at exec — no per-exec instrumentation cost
  on a 57 MB clang. The engine only reacts to the `__mmu_pt_base` export.
- **A2 fault routing decision (recorded, not yet wired)**: user
  `env.__mmu_fault` must enter the kernel through the SYSCALL ENTRY machinery
  (entry.S kernel-SP setup) — a raw call to the `__wasm_mmu_fault` kernel
  export from user context would run kernel C on a stale kernel stack pointer
  (the kernel instance's `__stack_pointer` global is not set up for this
  task). Reserve an arch-private nr or a dedicated entry.S stub; A2 work.

## FIRST FULL-STACK BOOT ATTEMPT (2026-07-02) — the stack runs; vmalloc is the wall

`runtime/demo/node/mmu-smoke.mjs` + `userspace/mmu-init.{c,nix}`: a `CONFIG_MMU=y`
vmlinux boots a single-file initramfs whose /init is the softmmu-pass-INSTRUMENTED
`mmu-init` (built uninstrumented via `nix build .#mmu-init`, instrumented by the
smoke). Two real kernel bugs found + fixed on the way to a clean instantiate:

- **`vm_get_page_prot` undefined** → the MMU vmlinux failed to INSTANTIATE
  (LinkError; `--import-undefined` turned the missing symbol into a dangling env
  import). Fixed: a `protection_map[16]` + `DECLARE_VM_GET_PAGE_PROT` in
  `mm/pgtable.c` (the software MMU has no HW exec distinction; 16 vm_flags combos
  map onto none/RO/shared-W/private-copy). **Lesson: diff the MMU vs NOMMU import
  sections after any kernel-symbol change** — a missing def is silent until boot.
- **`virtio_wl.c` `.mmap_capabilities`** — that `file_operations` field exists
  ONLY under `!CONFIG_MMU` (fs.h). Guarded the field + its function `#ifndef
  CONFIG_MMU` (patch 0013 created the file; the guard rides the WIP patch).

With those, the MMU vmlinux **instantiates and boots** — setup_arch, mm init,
all virtio/console probe — then panics. TWO confirmed vmalloc-path faults
(`memory access out of bounds`):
  1. `sock_init → ptp_classifier_init → bpf_prog_create → bpf_prog_alloc` (BPF
     program memory is vmalloc). Dodged for the minimal smoke by `--disable
     CONFIG_NET/PACKET/…`.
  2. `tty_open → n_tty_open`: `vzalloc(sizeof(struct n_tty_data))` —
     UNCONDITIONAL pure vmalloc (drivers/tty/n_tty.c:1890, not kvzalloc), so
     EVERY console open faults. Not dodgeable by config.

**This is the documented vmalloc-under-identity-kernel hazard, now EMPIRICAL and
PERVASIVE.** The uninstrumented (identity) kernel reads a vmalloc address as a
linear-memory offset, but vmalloc mapped scattered physical pages at
`VMALLOC_START+` — garbage. It is NOT a corner case; core subsystems (tty, bpf,
and any large kvmalloc) use vmalloc. Resolution (next sub-task), in preference
order:
  A. **vmalloc → contiguous identity alloc (arch override).** Under the software
     MMU the kernel is identity, so vmalloc need not scatter: back it with a
     physically-contiguous allocation mapped 1:1 (like NOMMU's
     `vmalloc = __vmalloc` contiguous path, or `ARCH_HAS_...` hooks +
     `VMALLOC_START = PAGE_OFFSET`). Smallest change; keeps the kernel identity.
     Risk: contiguity pressure (the reason NOMMU raised MAX_ORDER).
  B. **Instrument the kernel too** (the correct-in-general endpoint): run the
     softmmu pass over vmlinux with `pt_base = init_mm` (linear map identity,
     vmalloc regions genuinely mapped). Biggest change; removes the identity
     asymmetry entirely and is what real MMU HW does.
Decision pending the next iteration; (A) is the pragmatic A1 unblock.

The harness (`mmu-smoke.mjs`, `mmu-init`) and both kernel fixes are committed;
the vmalloc resolution is the one thing between here and a shell.: build the per-process page tables +
   VMAs mapping the user image; the engine instantiates the softmmu-instrumented
   user module.
4. **fault entry** (A2): `__mmu_fault(va,kind)` host import → `do_page_fault` →
   `handle_mm_fault` (demand paging / COW / SIGSEGV).
5. **pass 2-level walk update** (`runtime/softmmu-pass.js`): the frozen pass does
   a single-level walk; the standard 2-level kernel layout needs the two-load
   translate (design §2 revised). Small, separable, re-measure.
6. **engine**: instrument the user module at exec; set `pt_base` on switch.

Boot gate: a new `mmu-smoke` (boot the instrumented userspace under the MMU
kernel — identity map first, then per-process tables).

## HAZARD (found by analysis, must be resolved before/at first boot): vmalloc

The design keeps the KERNEL uninstrumented — every kernel access is raw =
identity (VA==PA). That is sound for kmalloc/linear-map memory, but under
`CONFIG_MMU=y` the generic `mm/vmalloc.c` comes online (NOMMU's
`vmalloc = kmalloc` in `mm/nommu.c` is compiled out): vmalloc allocates
SCATTERED physical pages and maps them at `VMALLOC_START+` via kernel page
tables (swapper_pg_dir) — which nothing walks for kernel code. An
uninstrumented kernel dereferencing a vmalloc'd address reads unmapped linear
memory → silent corruption, only observable at boot.

Resolution paths (decide empirically at first boot):
1. **A1 identity boot**: many vmalloc users are configured out of this guest
   (no modules, no VMAP_STACK, no BPF); if early boot doesn't exercise
   vmalloc, boot first and instrument later. Add a loud arch warning in
   vmalloc paths (e.g. arch_vmap hooks / a boot-time pr_warn) so any use is
   VISIBLE, never silent.
2. **The correct-in-general endpoint: instrument the KERNEL too** — real MMU
   hardware translates kernel accesses as well. Run the softmmu pass over
   vmlinux with `pt_base = init_mm`'s tables, where the linear map is identity
   (kmalloc cost = the measured mixed ~1.01×) and vmalloc regions genuinely
   map scattered pages. This also removes the "kernel must be identity"
   asymmetry from uaccess (though the soft walk stays, since user tables
   differ per-mm). Bigger step: pass over vmlinux + engine pt_base for the
   kernel instance + raw-exemption audit of the kernel's own PT accesses
   (they're raw by construction — the pass only instruments translated
   modules' own code; the kernel walking user tables through identity is
   correct since PTE tables live in linear memory).

## A2 execution spec — present-checked translate (demand paging / stack growth)

The A1 boot proves correctness on a FULLY-POPULATED address space. Real
programs grow the stack / fault in mmap+heap pages at runtime, which the
no-present-check fast translate cannot do (it silently writes through a zero
PTE — proven by the checksum-nibble bug). A2 adds the check. Execution-ready:

1. **Pass (`runtime/softmmu-pass.js`), a build-gated CHECKED variant** (keep the
   A1 no-check emit for fully-populated images; the checked one is the default
   for real userspace). In `emitTranslate`, after loading the level-2 PTE:
   - test `pte & _PAGE_PRESENT (bit 0)`; if set, proceed (common path — one
     `i32.const 1; i32.and; br_if` over the fault call).
   - if clear: `call $__mmu_fault_sc(ea, kind)` then RE-LOAD pgd_e+pte and
     recompute phys (a small `loop`/`block`). `kind` = 0 read / 1 write, known
     statically per op (loads=0, stores=1, rmw/cmpxchg=1).
   - the level-1 pgd_e can also be 0 (no PTE table) — same fault call handles it
     (the kernel allocates the PTE table in handle_mm_fault).
2. **Fault routing = a syscall, NOT a raw host import.** User code already
   imports `__wasm_syscall_2`; route the fault as `__wasm_syscall_2(NR, ea, kind)`
   with a wasm-private `NR` (e.g. an arch `__NR_wasm_mmu_fault`). This REUSES the
   entire kernel-entry machinery (entry.S kernel-SP setup, signal delivery) —
   avoiding the "kernel C on a stale kernel SP" hazard a direct kernel-export
   call would hit. The kernel's syscall table maps NR → the existing
   `__wasm_mmu_fault(addr, kind)` (arch/wasm/mm/fault.c). Ensure the pass ADDS
   the `__wasm_syscall_2` import if a module lacks it.
3. **Then `fs/binfmt_wasm.c` can DROP the full-stack populate** (mm_populate) —
   demand paging handles stack growth; keep VM_LOCKED off the def_flags too
   (real demand paging). The A2 pass makes exec's own `put_user`s fault in
   naturally as well (uaccess already faults via fixup_user_fault).
4. **Verify:** an mmu-smoke variant whose init recurses deep / touches a large
   mmap region to force runtime faults (the A1 smoke stays as the
   populated-path regression). Confirm no checksum-nibble corruption without the
   populate hack.

Perf: the common (present) path adds one `and+br_if` per access over A1 —
measure via `spikes/softmmu/measure-real.mjs` (add a checked-variant column).
