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

## Remaining before it BOOTS

3. **exec/binfmt_wasm address-space setup**: build the per-process page tables +
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
