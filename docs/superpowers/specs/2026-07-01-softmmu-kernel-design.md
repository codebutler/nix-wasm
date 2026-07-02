# Software-MMU kernel design (Track A1 kernel half, #128)

Date: 2026-07-01
Status: Design — the kernel-arch spec the instrumentation pass (done,
`runtime/softmmu-pass.js`) feeds into. Companion to the umbrella
`2026-07-01-software-mmu-asyncify-design.md` and the process/table contract
`2026-07-01-process-model-track0-design.md`.
Baseline: the NOMMU `arch/wasm` port (joelseverin/linux) + the single-shared-
arena process model.

> The toolchain half of Track A is built + measured (`runtime/softmmu-pass.js`,
> `spikes/softmmu/REAL-BINARY.md`): every guest load/store is rewritten to an
> inlined single-level page-table translate reading a per-process `pt_base`
> global. This note specifies the OTHER half — the wasm-arch kernel layer that
> flips `CONFIG_MMU=y`, builds those page tables, sets `pt_base` on context
> switch, and services faults. It is the piece that needs the kernel source +
> nix/LLVM builds (the teleported box / CI), not the sandbox this was written in.

## 0. The division of labor

| Concern | Where | Status |
|---|---|---|
| Per-access translate (the instrumentation) | `runtime/softmmu-pass.js` — a post-link wasm pass over the guest `.wasm` | **DONE**, tested + measured |
| `pt_base` global (page-table root) | emitted by the pass; **set by the kernel** on context switch | pass side done; kernel side below |
| Page tables (populate/walk) | kernel `arch/wasm` MM | design below |
| Fault handling (COW, demand page, mprotect) | kernel `arch/wasm` fault path → Track A2 | design below |
| `CONFIG_MMU=y` wiring | kernel arch Kconfig + the generic MM it unlocks | design below |

The pass and the kernel meet at exactly two ABI points: **(1) the `pt_base`
global** the pass reads per access, and **(2) the page-table entry format** the
pass's inlined walk assumes. Both are fixed here.

## 1. The two ABI points (frozen)

**`__mmu_pt_base`** — an `i32` mutable wasm global, appended by the pass and
exported under `exportControls`. It holds the **physical byte offset, within the
one shared Memory, of the current process's page-table root**. The kernel writes
it in `switch_mm`/`switch_to` (see §4). Value 0 is a valid identity-ish base only
in the bootstrap window; the kernel must set a real per-process table before the
first user access.

**PTE format** — the pass's inlined walk is exactly:
```
pte  = u32[ pt_base + (va >>> 12) << 2 ]      // single-level, 4-byte PTEs
phys = pte + (va & 0xfff)
```
So a PTE is a **4-byte physical page BASE address** (page-aligned; the low 12
bits are ignored — reserved for permission/present bits, see §3). `va >>> 12` is
the page number; the table is a flat array of `2^20` PTEs for a 32-bit space
(4 MiB per full table — but see §2 on sparse/multi-level). This matches the
single-level model `spikes/softmmu/` measured (a software TLB measured *worse*,
so there is none).

**Extending to permission bits (Track A2):** the reserved low 12 bits of a PTE
carry present/writable/user flags. The pass's fast path ignores them (pure
translate); a SECOND pass variant (or an extended inline sequence, gated by a
build flag) adds the `present`/`writable` check + a `call $__mmu_fault(va, kind)`
host trap on violation. Keep the fault check OUT of the default fast path until
A2 — it doubles the per-access work and the A0/real-binary measurements are for
the no-check translate.

## 2. Page-table layout (kernel side)

**Single-level is fine for correctness + the measurement, but a full 4 MiB table
per process is wasteful.** The kernel MM should use the standard **multi-level**
pgd/pmd/pte the generic Linux MM already provides, and the pass's *single-level*
inline walk reads a **flattened shadow** the kernel keeps in sync — OR the pass
grows to a two-level walk. Decision for A1: **start single-level flat** (simplest,
matches the measured pass), accept the per-process table cost (COW the table
pages themselves), and only move to multi-level if memory pressure demands it
(the softmmu spike kept it flat deliberately). The flat table lives in the shared
arena ("physical RAM"); `pt_base` points at it.

**Who allocates the table:** `pgd_alloc`/`pte_alloc` on the wasm arch allocate
pages from the arena (the same allocator NOMMU uses today, now backing "physical"
pages). `mm_struct` gains the table root; `pt_base` = that root's arena offset.

## 3. What `CONFIG_MMU=y` unlocks (and the arch must supply)

Flipping the wasm arch from NOMMU to MMU means the generic Linux MM (which is
huge and battle-tested) comes online — but it needs the arch to supply the
per-arch MMU primitives. The wasm arch must implement:

- **`asm/pgtable.h`** — the pgd/pmd/pte types + accessors (`set_pte`, `pte_none`,
  `pte_present`, `pte_write`, `mk_pte`, `pte_mkwrite`, …) over the §1 PTE format.
- **`asm/pgalloc.h`** — `pgd_alloc`/`pte_alloc_one`/… over the arena allocator.
- **`asm/tlbflush.h`** — `flush_tlb_*`. There is no hardware TLB; these are
  **no-ops** (the pass re-reads the PTE on every access, so a mapping change is
  visible immediately — this is the *upside* of no software TLB, and why the
  spike measured a TLB as pure overhead).
- **`asm/mmu_context.h`** — `switch_mm`: **write `pt_base` = `next->pgd`'s arena
  offset** (the single ABI action per context switch, §4).
- **the fault entry** — a `__mmu_fault(va, kind)` host import the pass calls on a
  permission violation (A2), routed into `do_page_fault(va, flags)` → the generic
  `handle_mm_fault`, which does COW / demand-paging / SIGSEGV exactly like any
  arch. `kind` = read/write/exec.

Because the *translate* is in the instrumented guest code (not a hardware walker),
the arch's job shrinks to: keep the page tables in the §1 format, set `pt_base`,
and service faults. The generic MM does the rest (`mmap`, `mprotect`, `fork` COW,
demand paging) — which is the whole point: **run normal MMU Linux.**

### 3a. Empirical hook surface (measured, not guessed)

`config MMU` was added to `arch/wasm/Kconfig` (a selectable `bool default n`) and
survives `olddefconfig` with `CONFIG_MMU=y` — the arch Kconfig graph accepts MMU.
Building `vmlinux` with `CONFIG_MMU=y` (full patch stack, `make -k`) then names
the **exact** arch surface the generic `include/linux/pgtable.h` requires — this
is the executable checklist for `asm/pgtable.h` (replacing the NOMMU
`pgtable-nopmd.h` + no-op stubs). First wall, in order:

- **Layout constants:** `PGDIR_SHIFT`, `PTRS_PER_PGD`, `PTRS_PER_PTE`,
  `PFN_PTE_SHIFT`.
- **PTE constructors/queries:** `set_pte`, `pte_clear`, `pte_none`, `pte_present`,
  `pte_young`/`pte_mkold`, `pte_dirty`/`pte_mkclean`/`pte_mkdirty`,
  `pte_write`/`pte_mkwrite`/`pte_wrprotect`, `pte_mkyoung`, `mk_pte`, `pte_page`,
  `pte_pfn`/`pfn_pte`.
- **PMD side (folded via `pgtable-nopmd.h`):** `pmd_none`, `pmd_present`,
  `pmd_bad`, `pmd_page_vaddr`, `pmd_clear`, `set_pmd`.

The `PGTABLE_LEVELS=2` arch config + `pgtable-nopmd.h` gives a PGD→PTE fold. To
match the §1 SINGLE-level flat walk (`u32[pt_base + (va>>12)<<2]`), reconcile by
making the flat 2^20-entry PTE table the level the pass reads: `PGDIR_SHIFT=12`
region so `pt_base` (set by `switch_mm` = the incoming mm's flat table) is what
`va>>12` indexes. A 4 MiB flat table per process (the accepted A1 cost, §2).
`PAGE_SHIFT` MUST be 12 (the pass hard-codes `>>12`); select the 4KB page size,
not 64KB. Probe tree: `scratch-mmu-probe/` (not committed).

## 4. Context switch — the one hot action

On every `switch_to`/`switch_mm` the kernel must set the `pt_base` global to the
incoming process's page-table root. The wasm arch exposes a tiny host import the
kernel calls, `__mmu_set_pt_base(u32)`, OR — cleaner — the kernel writes the
global directly if the vmlinux module imports it. Since the pass appends
`__mmu_pt_base` to the USER modules (each process image), and the kernel is a
SEPARATE module, the kernel sets it via a host trampoline the runtime provides:
`runtime/kernel-worker.js` already owns the user instance, so it exposes
`set_pt_base(v)` that writes `user_executable_instance.exports.__mmu_pt_base`.
(Kernel → host import → user global. One store. No TLB flush — §3.)

This is the ONE new engine-side action; it is small and belongs with the exec/
clone ABI in `kernel-worker.js`. It does NOT need a per-access host call (that
was the rejected helper-call design — see `spikes/softmmu/REAL-BINARY.md`).

## 5. Sequencing against the rest of Track A

1. **A1 pass** — done (`runtime/softmmu-pass.js`).
2. **A1 kernel** — this note: `asm/pgtable.h` + friends, `CONFIG_MMU=y`, flat
   single-level tables, `switch_mm` sets `pt_base`. Boot the guest with the
   instrumented userspace + a kernel that identity-maps at first, then real
   per-process tables. **Needs the kernel source + nix/LLVM build.**
3. **A2** — permission bits in the PTE + the `__mmu_fault` path → COW fork,
   demand paging, mprotect (the extended pass variant + `do_page_fault`).
4. **Atomics in the pass** — DONE (`runtime/softmmu-pass.js`, commit for #128).
   The guest's musl pthread is atomics-heavy, so this gated instrumenting any
   real guest binary. An atomic (`0xfe` prefix) translates its address the same
   way (the translate is a pure read: an aligned `i32.load` of the PTE, which
   cannot tear), then re-emits the RAW atomic at `phys` keeping the ORIGINAL
   alignment (atomics require natural alignment; the translate preserves it) and
   folding the offset into `phys`. Operands above the address are stashed
   top-first into disjoint scratch locals across the translate, then restored.
   Verified with an `atomics.wasm` fixture (load/store/add/xchg/cas/i64 add):
   instrumented == original under an identity table, and a remapped page
   redirects the atomic. `scanUnhandled` now refuses only SIMD (a documented
   follow-up — the guest has no SIMD memory ops today).

## 6. What stays true regardless (the honest floor)

Per the umbrella §9: after this the guest is **MMU** wasm32-linux-musl, but the
LLVM triple stays `wasm32-unknown-unknown` and the cross-build tail is unchanged
— the MMU work fixes the *process model*, not the *build*. Perf is ~1.05–1.9×
(measured) until the `memory-control` proposal ships a hardware-backed page
protection that replaces the software translate at ~0 cost — at which point the
`pt_base`/PTE ABI here is swapped for engine-managed protection behind the same
`asm/pgtable.h` interface (keep the arch MM behind that interface so only the
backend changes).
