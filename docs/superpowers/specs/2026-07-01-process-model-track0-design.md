# Track 0 — the unified process + function-table model (design note)

Date: 2026-07-01
Status: Design — the shared contract for #127 (Track 0). Deliverable of the epic #126.
Parent plan: `2026-07-01-software-mmu-asyncify-design.md`.

> Purpose: pin **what a process is** on the post-NOMMU guest, and the **fork-clone /
> dlopen-mutate contract** over it, *before* Track A (address space), Track B (execution),
> and Track C (modules/table) diverge. All three read/write one substrate; decide it once
> here or rebuild the process abstraction twice.

Grounding: the current loader (`runtime/kernel-worker.js`) already places the main module
at `data_start → __memory_base` and resolves `GOT.func`/`GOT.mem`; every guest binary is
emitted PIC/dylink (`-shared -Bsymbolic --import-memory --import-table` + GOT +
`__wasm_apply_data_relocs`, `wasm-cross.nix`). This note extends that from *one module per
process* to *a process = address space + execution + a set of modules over a table*.

---

## 1. A process is three things `fork()` must clone

| Leg | State | Lives in | Owner track |
|---|---|---|---|
| **Address space** | page table (virtual → physical) | linear memory (the page table) + engine (the Memory) | A |
| **Execution** | asyncify stack + shadow-stack ptr | linear memory (copyable) | B |
| **Code/modules** | main + `dlopen`'d side-module instances, and their **function-table entries** | **engine objects OUTSIDE linear memory** | C |

The third is the load-bearing subtlety: **module instances and the wasm table are engine
state the MMU's linear-memory snapshot does NOT capture.** So the process record must own
the *module set* explicitly, and fork must **replay** it (not copy it).

## 2. The process record (proposed fields)

Per process, held host-side by the runtime (keyed by pid), NOT in guest linear memory
except where noted:
- `pageTableRoot` — offset (in the shared Memory) of this process's page-table root (Track
  A). Software-MMU translation reads it.
- `asyncifyStack` — the process's asyncify buffer + shadow-stack pointer (Track B); it lives
  *in* the process's address space, so the MMU copy carries it for free.
- `modules[]` — the ordered load list: `[mainModule, sideModule₀, sideModule₁, …]`, each an
  `{ url/bytes, memoryBase, tableBase, tableCount }`. **The order is the ABI** — see §4.
- `table` — this process's `__indirect_function_table` (per-instance; see §3).

## 3. Address space + function table — the two decisions

**Address space: one shared `WebAssembly.Memory`, per-process page tables.** Do NOT give
each process its own Memory (the measured ~124-Memory/tab dead-end, `spikes/elastic-mem/`).
Instead the single shared arena is "physical RAM"; each process's page table maps its
*virtual* addresses to physical offsets within that one Memory. This gives per-process
virtual spaces at consistent addresses (pointers stay valid across a COW copy) with **no
124 cap** — the MMU's page table *is* a process-record field. COW-fork = allocate fresh
physical pages in the arena, point the child's page table at them lazily.

**Function table: per-process, with a DETERMINISTIC layout keyed by module-load order.**
Function pointers are table indices stored in linear memory. A forked child re-instantiates
→ gets its own table → the parent's copied indices must resolve to the *same* functions.
Therefore table layout must be a pure function of the module-load sequence: main module
takes `[0, N₀)`, side module k takes `[baseₖ, baseₖ+Nₖ)` assigned in load order. `dlsym`
returns the callee's index in *this* layout. (One shared table across all modules *within* a
process, as in emscripten dynamic linking; separate tables *across* processes.)

## 4. The fork-clone contract (Track A ⨯ B ⨯ C)

`fork()` (asyncify seam, once COW exists):
1. **Capture** the parent's asyncify stack (execution → copyable linear memory). — B
2. **COW/copy** the parent's address space: allocate the child a page table; share pages
   copy-on-write. The copied memory carries the asyncify stack **and every function-pointer
   value (table index)**. — A
3. **Replay** the parent's `modules[]` in order into the child: instantiate main + each side
   module in the *same* sequence → identical table layout → the copied indices resolve to
   the correct functions. This is why §3 mandates deterministic layout, and why the module
   set is core process state, not memory. — C
4. **Rewind** the child's asyncify stack → it resumes at the `fork()` call site returning 0;
   the parent rewinds its own → returns the child pid. — B

Step 3 is the fork×dlopen hazard #33 flagged, resolved: replay, don't copy, the module set.

## 5. The dlopen-mutate contract (Track C)

`dlopen(path)`:
1. Allocate the side module's data at a `memoryBase` in the process's address space (Track
   A's per-process allocator).
2. Instantiate against the process's Memory + shared table; `table.grow` by its function
   count → `tableBase`; resolve `GOT.func` (→ table index) / `GOT.mem` (→ `memoryBase +
   offset`); run `__wasm_apply_data_relocs` + ctors.
3. **Append `{…, memoryBase, tableBase, tableCount}` to `modules[]`** so fork can replay it.
`dlsym(h, name)` → the export's table index in this process's layout.
`dlclose` — table entries don't cleanly reclaim on wasm; leak-until-exit is acceptable
(flag if a consumer needs real unload).

## 6. Interactions to respect
- **fpcast-emu**: fpcast'd binaries call through canonical `(i64×128)→i64` thunks; those
  thunks are the address-taken functions that occupy table slots. The deterministic layout
  (§3) must be computed on the *fpcast-rewritten* module, and `dlsym` must return the thunk's
  index (a bare export index would trap under fpcast). Track C's loader and the fpcast pass
  must agree on which symbol is the callable.
- **The table-reloc bug (#33 point 2)**: fn-pointer relocs currently can land on `table[0]`
  → `call_indirect` sig trap. Fixing this is a prerequisite for `dlsym`-of-functions and is
  part of Track 0's function-table model, not a separate concern.
- **`memory-control` swap (#24)**: when the hardware backend lands, `pageTableRoot` +
  software translate are replaced by engine-managed protection — keep §3's address-space
  behind an interface so only Track A's backend changes, not the process record.

## 7. Open decisions (resolve during A1/C1)
- Where the page table physically lives (dedicated arena region vs per-process) and its
  format (single-level, per the softmmu spike — multi-level only if needed).
- Table-index recycling on `dlclose` (probably: none).
- Whether `modules[]` replay can be made content-addressed (dedupe identical side modules
  across processes at the engine-module level — bytecode is already shared by V8; only
  instances differ).

## 8. What each track consumes from this note
- **A1** builds `pageTableRoot` + the per-access translate against §3's address-space model.
- **B1** builds the asyncify capture/rewind against §4 steps 1/4.
- **C1** builds the loader + `dlsym` against §3's table model + §5, and libffi's generated
  trampolines (design doc §8) install into the same per-process table via §5's mechanism.
