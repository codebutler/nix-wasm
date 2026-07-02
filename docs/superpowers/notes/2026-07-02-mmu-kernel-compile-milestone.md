# CONFIG_MMU=y wasm kernel — compile+link milestone (#128 Track A kernel half)

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

## Remaining before it BOOTS — ONLY the engine half now

3. **engine (kernel-worker.js, ENGINE_ABI bump)**: provide the
   `env.__mmu_set_pt_base` import (write the user module's `__mmu_pt_base`
   global); instrument the user binary at exec (or ship pre-instrumented
   userspace); route user `env.__mmu_fault` into the `__wasm_mmu_fault` kernel
   export on the task's context (A2): build the per-process page tables +
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
