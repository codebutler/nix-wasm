# Software MMU + asyncify — the path off NOMMU (and the dlopen gap that survives it)

Date: 2026-07-01
Status: Design / exploratory — revisits a prior decision, no implementation yet
Baseline: **master** — the single-shared-arena NOMMU model + `posix_spawn`-only
spawn contract (`docs/process-model.md`, `docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md`).
Revisits: the **software-MMU rejection** in the clean-NOMMU memory design, which was
made on an *unmeasured* estimate (see §1).

> One-line thesis: a **software MMU** (per-access translation, WAVEN-style) and the
> **asyncify fork seam** (already built in PR #20) are the two halves that let the
> guest run as **normal MMU Linux** and retire the entire NOMMU accommodation layer.
> They do **not**, on their own, solve **dlopen / dynamic linking** — but dlopen is
> **not orthogonal to this plan**. It is the **third leg of the same process
> abstraction**, sitting on the *same* per-process address-space + function-table +
> relocation substrate the MMU/fork work builds (#33's own analysis calls that work
> "enabling groundwork" for a dynamic loader, and fork-after-dlopen couples them). So
> the process model must be **co-designed** with dynamic linking from day one — while
> keeping dlopen's *delivery* independent, so the GModule win is never held hostage to
> the MMU effort.

---

## 0. Why this exists

Everything painful about the guest — `fork`/`vfork` removed from musl, the forkshell
`ash`/`hush`, glib's `posix_spawn`-only patch, the per-package fork/vfork triage, the
GModule wall — traces to **one** substrate choice: we run all of Linux inside a single
`WebAssembly.Memory` as a NOMMU blob, so *processes are not real*. This doc asks
whether that choice is still correct now that (a) we have measured data on software-MMU
overhead, and (b) the asyncify fork seam already exists.

The framing that makes the whole problem legible:

> **In wasm, code and the call stack are not in linear memory.** The wasm function
> table, module instances, and the value/control stack are engine objects *outside*
> the addressable byte array. A "software MMU" governs the byte array (data). So:
> - a soft MMU can give per-process address spaces, COW, demand paging — **data**;
> - it cannot clone the execution stack (that's **asyncify**) and it cannot load or
>   resolve code (that's **dlopen / dynamic linking**).
>
> Every guest limitation is one of those three axes. Fixing memory alone fixes one.

---

## 1. The prior we are revisiting was never measured

The clean-NOMMU memory design rejected a software MMU with:

> "A software MMU (per-access translation) — 10–100× slowdown, not viable."
> — `2026-06-21-clean-nommu-memory-design.md`

and issue #24 estimated it differently:

> "a 2–5× slowdown (cf. Emscripten SAFE_HEAP)."

**These are estimates, and they disagree with each other** (2–5× vs 10–100×) — the tell
that neither is a measurement. The soft MMU was ruled out by analogy to SAFE_HEAP, never
benchmarked. **`spikes/softmmu/` now measures it** (see §1b) — the verdict was wrong.

### What the research actually found (2026-07-01 deep-research pass)

Primary sources, adversarially verified (23/25 claims confirmed). Full record in the
session transcript; key results:

- **Emulator MMUs are NOT reusable.** v86 / QEMU-softmmu / Blink each fuse per-access
  translation to the JIT/dispatch loop that already intercepts every guest access
  (v86's inline `gen_safe_read` TLB guard; Blink: MMU "tightly integrated with JIT
  code generation and the instruction dispatch loop… invalidates JIT-generated code
  when memory protections change"). Native wasm has **no free per-access hook**, so
  their MMU does not transfer. The reusable "MMU core" (page tables + software TLB) is
  the *cheap, everyone-does-it-identically* part. Sources: v86 `how-it-works.md`,
  `jart/blink` README. **Confirmed 3-0.**

- **The measured datapoint for exactly our architecture: WAVEN (NDSS 2025).** A
  page-level software MMU added to **natively-compiled** wasm (WAMR AOT) via per-access
  translation injected into codegen (single-level page table, software MMU walk),
  **not** CPU emulation. Overhead: **6.14–12.52%, geomean ~10.4% (PolyBench)** over
  vanilla WAMR AOT. Source: NDSS 2025 paper `2025-746-paper.pdf`. **Confirmed 3-0.**
  → The "10–100×" verdict is off by roughly an order of magnitude; ~1.1× is the honest
  ballpark for the folded-into-codegen case.

- **Skip the software TLB.** WAVEN measured **18.9–30.8% with a TLB** (sizes 2–512) vs
  **10.4% without** — the TLB made it *worse*. Its own conclusion: "TLB cannot
  effectively amortize the overhead of memory virtualization." So copying an emulator's
  TLB (the thing you'd be most tempted to lift) is a net loss. **Confirmed 3-0.**

- **The pessimistic bound.** Generic per-access software isolation/masking of every
  load/store (the mechanism if translation can't be folded into existing checks):
  **15–22%** for fast AOT engines, up to **37–67%** for Wasmtime (LFI, ASPLOS 2024,
  SPEC 2017); the **load path** is the expensive part. **Confirmed 3-0.**

- **`memory-control` is the eventual replacement, not available yet.** The WebAssembly
  `memory-control` proposal (`memory.map`/`unmap`/`protect`/`discard`, "virtual" mode)
  would delegate page protection to the **host hardware MMU** (`mmap`/`mprotect`/
  `madvise`) at ~0 overhead — obviating a software MMU. But it is **Phase 1**, "early
  stages," not shipping in V8/Node/browsers. Sources: `WebAssembly/memory-control`
  `Overview.md` / `virtual.md` / `discard.md`. **Confirmed 3-0.**
  → Subtlety #24 didn't note: those ops are invoked by the *engine*, not by a guest
  kernel compiled to wasm, so even when it ships the runtime must plumb it through to
  the guest's `mmap`/`fork`.

- **Prior art for the non-emulator route exists:** WasmLinux (LKL + musl + BusyBox to
  bare wasm) and our own upstream `joelseverin/linux-wasm`.

### Honesty caveats on the number (from the research)

- WAVEN's low ~10% is partly because it **replaces** wasm's existing bounds checks with
  translation (netting cost down) and **does not implement COW or fork** — the exact
  features we want. Adding COW/demand-paging *on top* budgets higher.
- WAVEN controls WAMR's LLVM-IR codegen. **We run the guest in V8 directly** and do not
  control V8's codegen, so we'd instrument at the **wasm level** (a Binaryen/`wasm-opt`
  pass rewriting loads/stores — the SAFE_HEAP mechanism), which is less optimizable →
  expect the higher end.
- **Realistic budget: ~1.1× (optimistic) to ~1.3–1.7× (pessimistic).** Either way,
  squarely "worth prototyping," not "non-starter." **This is the number the project
  never had, and the whole "too slow" verdict rested on it.** → now measured, §1b.

### 1b. The A0 measurement (`spikes/softmmu/`) — the guess is now a number

A wasm module run under **V8** (node) routes every load/store through a single-level
page-table translate (WAVEN's model), vs plain access. Full data + method:
`spikes/softmmu/FINDINGS.md`. Headline:

| workload class | measured overhead |
|---|---|
| realistic — compute-dense (`mixed`) or memory-latency-bound (`chase`/`stride` DRAM) | **+1% to +8%** (reproduces WAVEN's ~10%) |
| pathological — pure memory ops on a **cache-resident** working set (`seq`/`chase` L1, `store`) | **1.8×–2.7×** |
| geomean across the (deliberately half-pathological) kernel set | 1.44× |

Findings that matter:
- **"10–100×" is decisively refuted** — the *worst* case is 2.67× (a loop that does
  nothing but chase cache-resident pointers); real code is single-digit percent.
- **The cost is fundamental**: a non-volatile PTE load (compiler free to hoist) measured
  identical to a forced one — the optimizer cannot remove the per-access translate. (A
  software TLB wouldn't help; WAVEN measured it *worse*.)
- **These are the honest ratios for pc**: the baseline is V8 guard-page bounds checks
  (≈ free, the fastest baseline), so no "replaced an existing check" discount hides cost.
- **The risk to watch — now measured**: a **nix-eval-shaped kernel** (value-graph
  interpreter: alloc + data-dependent pointer-chase + primop + memoizing store) was added to
  the spike. Result: **+24% on a large (48 MB, mostly-cold) graph** and **1.93× fully
  cache-resident** — so real nixpkgs eval, the workload *most* exposed to per-access
  translation, lands **~1.25–1.9× depending on cache-residency**. Viable, not "10×", and the
  case that most rewards the mitigations (exempt provably-in-bounds stack/shadow-stack
  accesses; selective instrumentation) and the eventual `memory-control` hardware backend.
  Full data: `spikes/softmmu/FINDINGS.md` § nix-eval.

**Verdict: viable.** ~1.05–1.3× for realistic guest workloads, with a bounded, known,
mitigable worst case. The "too slow" prior is retired on evidence.

---

## 2. One process abstraction, three legs — sharing one substrate

A real process is **three** things, all of which `fork()` must clone: an **address
space**, an **execution context**, and a **code/module + function-table set**. NOMMU
has a degenerate form of each. The three legs map to the three tracks — and their
*designs* are **not** independent, because they share one substrate: a per-process
address-space allocator, a per-process **function table**, and the GOT/relocation
machinery. Decide that substrate once (Track 0, §4) or pay to redo it. Critically, the
third leg (module/table set) is **engine state outside linear memory**, so the MMU's
memory snapshot does **not** capture it — the process record must track it explicitly.

Fork's two hard halves (memory + execution):

Real `fork()` needs **both** an address-space clone **and** an execution-context clone.
NOMMU has neither; MMU + asyncify supply them:

| Half | Mechanism | Gives |
|---|---|---|
| Address space | **Software MMU** (per-access translate + perm bit → fault-on-access) | per-process VAs at *consistent* addresses **inside one shared Memory** (no ~124-Memory cap — see #24/elastic-mem), COW, demand paging, MAP_SHARED, mprotect, guard pages, **real isolation** |
| Execution | **Asyncify** (serialize stack to copyable linear memory) | the "return-twice" — child resumes at the `fork()` call site |

Together → **real `fork()`**, cheap (COW), for arbitrary programs. Both walls that
killed real fork in `process-model.md` (the same-address child copy *and* the 124 cap
*and* the missing multi-shot) fall.

### What this lets us delete (the payoff)

Flip the guest from uClinux/NOMMU to **normal MMU Linux** (`CONFIG_MMU=y` with a wasm MMU
arch layer). The entire accommodation stack becomes unnecessary:

- musl `fork`/`vfork` removal → **gone** (standard MMU musl).
- forkshell `ash`/`hush` (`patches/busybox/ash/*`, hush clone patches) → **gone**.
- glib `posix_spawn`-only patch + `child_setup` rejection → **gone**.
- busybox spawn ports (`0001/0003/0004/0005/0006/0007`), the per-package fork/vfork
  triage (openssl `no-apps`, pcre2, ncurses, …) → **gone**.
- nixpkgs packages cross-compile **without NOMMU patches**. (Still wasm32 cross-compiled
  — we do **not** run x86 binaries; that would be emulation, out of scope. The win is
  "not NOMMU-crippled," not "run foreign binaries.")

Bonus: NOMMU "soft isolation" (processes can scribble each other; acceptable only for
single-user) becomes **real per-process protection**.

---

## 3. The third leg: dlopen / dynamic linking (co-designed, not bolted on)

**MMU + asyncify do NOT, by themselves, fix dlopen** — dlopen is a *code-loading*
problem, and in wasm **code lives outside linear memory**, so neither address
translation (data) nor stack capture (execution) can load code or resolve a symbol to a
callable. But that same fact is *why dlopen is a first-class part of this plan, not a
side quest*: because code/table state lives **outside** the MMU-governed memory image,
the process abstraction must track a process's **module + function-table set as core
process state** — the thing `fork()` clones and `dlopen` mutates. Design the process
model without it and you build an abstraction that can't hold dynamic modules, then redo
it. So dlopen is **design-coupled** to A/B via the shared substrate (§2, Track 0), even
though it carries **independent delivery value** (below). After A/B alone, these still
fail exactly as today:

- GModule / gio modules / gdk-pixbuf loaders / `gtk_builder_connect_signals(NULL)`
  (galculator's real window, and any GtkBuilder-autoconnect app).
- Any guest program that `dlopen`s a plugin at runtime.

This is **issue #33**, still unbuilt for the general case (the narrow galculator
unblock used the static `add_callback_symbol` path; the general **side-module dynamic
loader** was scoped "later"). It is a **third, independent track**:

- Build guest shared libraries as PIC wasm **`SIDE_MODULE`s** (the substrate is already
  there — every guest program is emitted `-shared -Bsymbolic --import-memory
  --import-table` + GOT + `__wasm_apply_data_relocs`; `wasm-cross.nix`).
- `dlopen` = instantiate the side module against the process's Memory + shared Table,
  `table.grow` its functions, resolve `GOT.func`/`GOT.mem` relocs, run ctors.
- `dlsym(name)` = table index (a function pointer). Gated on the **function-pointer
  table-reloc fix** the gobject/fpcast work needs (#33 point 2): fn-pointer relocs must
  land at the correct table slot, not `table[0]` (→ `call_indirect` sig trap).

### The fork × dlopen interaction (must design for, per #33)

Once **both** real fork and dlopen exist, **fork-after-dlopen is a sharp edge**: the MMU
copies/COWs *linear memory*, but **module instances and the wasm table are engine objects
outside linear memory** and are **not** captured by the snapshot. So a forked child must
**re-instantiate + re-link** the parent's `dlopen`'d side modules and reproduce their
table entries (and any `dlsym` pointers) before it resumes. Design the dynamic loader so
the runtime can replay a process's side-module set into the child. (No consumer needs
this until both tracks land — but bake the hook in from the start.)

---

## 4. The tracks

### Track 0 — the shared process + function-table model (design once, up front)

Before A1/B1/C1 diverge, decide the **process abstraction** and the **per-process
function-table + PIC/dynamic-linking model** *once*, because all three legs read/write
it:
- **What a process IS**: its address-space region (A), its execution/asyncify state (B),
  and its **loaded-module set + function table** (C). `fork()` clones all three; the
  third is engine state *outside* linear memory, so the MMU snapshot does **not** capture
  it — the process record must own it explicitly and the fork path must replay it.
- **The function-table / function-pointer model** is the connective tissue shared by
  `dlsym` (pointer = table index), fork's table-reproduction, and the existing
  **fpcast-emu** hack (gobject signature casts) + the table-reloc bug (#33 point 2:
  fn-pointer relocs must land at the right slot, not `table[0]`). One coherent model puts
  dlopen, fork-clone, and fpcast on the same footing. (Whether a clean typed table lets
  fpcast-emu be *retired* is an open question — §7 — not a promise.)
- **Deliverable:** a short design note pinning the process record, per-process table
  ownership, GOT/reloc handling, and the **fork-clone + dlopen-mutate contract** — the
  shared spec A1, B1, and C1 all build against. Cheap; do it alongside the A0 spike.

### Track A — Software MMU (get the real number FIRST)

- **A0 (spike, do this before anything):** a Binaryen/`wasm-opt` pass that rewrites the
  guest `.wasm`'s loads/stores through a **single-level page-table translate** (no TLB —
  measured to hurt). Benchmark against a real hot path: **nix eval + a `guest-cc` compile
  + a memory-bound microbench**. Output = **our** overhead multiplier, replacing the
  guessed one. This is the branch's whole reason for existing (`claude/software-mmu-…`).
  Acceptance: a committed number with a reproducible harness (a fourth spike alongside
  `elastic-mem`/`nofork`/`stackswitch`).
- **A1:** if A0's number is acceptable (< ~1.7×, expected ~1.1–1.4×), design the **wasm
  arch MMU layer**: page-fault handling, populate/walk page tables, wire Linux MM
  (`CONFIG_MMU=y`) onto the per-access translate. This is the **large** piece — a kernel
  arch MMU + a toolchain instrumentation pass, not a bolt-on. Scope honestly.
- **A2:** COW + demand-paged file mmap + real `mprotect`/guard pages on top (the #24/#23
  wishlist, now in software).
- **Exit ramp:** when `memory-control` ships in V8/Node, swap the software translate for
  hardware-backed (`memory.map`/`protect`/`discard`) at ~0 overhead. Keep A1's MM wiring
  behind an interface so the backend is replaceable.

### Track B — Asyncify fork seam (revive PR #20, aim it at the NOMMU-drop)

- The seam already exists and passed 8 `fork-*` acceptance programs: `musl-fork`
  (`toolchain/musl.nix` `forkSeam`), `userspace/asyncify-cc.nix`, the `cc-fork` driver
  (`toolchain/guest-cc-fork.nix`). It was closed *not_planned* (#32/#25/#23) because
  NOMMU+`posix_spawn` covered the common case and the copy cliff (#29) had no COW.
- With **Track A providing COW**, #29's cliff is gone — revive the seam.
- **B1:** generalize the build path into a reusable cross-stdenv variant (`musl-fork` +
  `wasm-opt --asyncify` at link) so opting a package into real `fork()` is a flag
  (#32's unfinished acceptance).
- **B2:** the asyncify tax is **per-binary** — apply only to fork-users (shell, make,
  daemons); the GUI desktop keeps `posix_spawn` and pays nothing. (JSPI, when convenient,
  carries ordinary blocking/scheduler suspends at ~0 cost; #23 already ruled JSPI
  *wontfix for fork* — its Suspender is opaque/non-copyable — so JSPI is a non-fork
  cleanup, not part of the fork seam.)

### Track C — dlopen / dynamic linking (#33) — the surviving gap

- **C0:** land the function-pointer table-reloc fix (shared with gobject/fpcast).
- **C1:** the general runtime **side-module loader** (`dlopen`/`dlsym` of real wasm
  `SIDE_MODULE`s), sitting on the PIC/dylink + GOT substrate that already exists.
- **C2:** design the **fork × dlopen** replay hook (§3) so a forked child re-instantiates
  side modules.
- Payoff: GModule works → galculator's real window, GtkBuilder autoconnect, gio/gdk-pixbuf
  modules — the GTK per-app treadmill ends. **Delivery is independent** (a narrow slice
  ships on today's substrate — the galculator static path already did), so C must **not be
  blocked** on the MMU megaproject. But its **design is not** independent: C1 builds on
  Track 0's process/table model and A's per-process address-space substrate. *Integrate the
  design; keep the schedule decoupled.*

---

## 5. Sequencing

0. **Track 0 design note** — the shared process + function-table model. Cheap, and it
   gates coherent divergence of A1/B1/C1. Runs alongside the A0 spike.
1. **Track A0 spike** — the measurement. Nothing else *big* is justified until this
   number exists. (Cheap; days.)
2. Branch on A0:
   - number acceptable → commit to **A1/A2** (the big kernel MMU effort) and, in
     parallel (independent), **Track C** (dlopen — the gap that A/B can't touch).
   - number bad → stay NOMMU; the asyncify seam (B) remains the surgical option for
     specific fork-without-exec packages, and **C is still worth doing on its own** (it's
     orthogonal and is what actually ends the GTK patching).
3. **Track B** (fork seam revival) follows A2 (needs COW to beat #29).
4. **memory-control** watched throughout as A's eventual zero-cost backend.

Note: **Track C (dlopen) is design-coupled but delivery-independent.** Its *design*
shares Track 0's process/table model and A's address-space substrate — so it is decided
*with* A/B, not after (build the process abstraction wrong and you redo it). Its
*delivery* does not wait on the MMU: C is the highest-leverage item for "stop patching
apps" on the GTK side and can ship a slice on today's substrate. **Integrate the design;
decouple the schedule.**

---

## 6. What this does NOT solve (scope honesty)

- **dlopen/GModule** — §3; needs Track C.
- **Executable mmap / in-guest JIT / self-modifying code** — same code-loading wall as
  dlopen; a guest that generates and runs code needs the wasm dynamic-loader path
  (exec of a *freshly produced wasm binary* already works via the runtime exec ABI —
  that's how `guest-cc` runs its output; it's `dlopen`-into-a-running-process that's
  missing).
- **Foreign (x86) binaries** — out of scope forever; that's emulation.
- **A's engineering size** — the ~1.1–1.7× is *runtime* cost only. Giving the wasm arch a
  real MMU (kernel MM layer + fault handling + the instrumentation pass) is a major build.

---

## 7. Open questions (from the research)

- True multiplier when COW/demand-paging is **added on top of** existing wasm bounds
  checks (WAVEN nets its 10% partly by *replacing* them and implements no COW). A0 answers
  this for our workloads.
- Does WAVEN-style folding even apply when the guest is a **fixed AOT wasm module V8 runs**
  (we don't re-instrument per access in a runtime we control)? → the wasm-level Binaryen
  pass is the applicable form; A0 measures it.
- Can `memory-control` host-MMU delegation be plumbed to a guest Linux compiled to wasm
  (guest `mmap`/`mprotect`/`fork` → engine `memory.map`/`protect`/`discard`), or does the
  single-shared-Memory model preclude it until the proposal ships and the runtime bridges
  it?
- `memory-control` timeline to Phase 4 / V8 shipping — determines whether A is "the
  implementation" or "the bridge until hardware-backed."

---

## 8. Residual gaps beyond the three walls (what this stack does NOT fix — and ideas)

Tracks 0/A/B/C + the cleanup (#131) remove the **fork / dlopen / NOMMU-memory** walls. They
do **not** make "most of nixpkgs build unmodified" — several independent axes survive.
Captured so the epic isn't oversold and the ideas aren't lost.

**The shared enabler.** Most of these collapse onto ONE primitive: **runtime wasm
instantiation** — generate/instantiate a wasm module at runtime against the shared
table/memory. Track C (#130) builds it for dlopen, but it is *more general than dlopen*:
libffi and the only general JIT escape-hatch both ride on it. **Scope #130 as "runtime wasm
codegen," not "a dlopen loader."**

- **libffi (arbitrary runtime FFI).** The trampoline-table backend is bounded (K/M, no
  structs/varargs/closures). Real fix: **generate a trampoline wasm module per needed
  signature** (a fn with those param types that marshals from the arg buffer + `call_indirect`s
  the right type), instantiate against the shared table, cache by signature; closures = a
  generated context-capturing thunk; structs = the wasm C ABI's predictable lowering. This is
  Track C's primitive. Engine path (parallel to `memory-control`): **`WebAssembly.Function`**
  (type-reflection) would synthesize the funcref host-side with no module — cleaner, unshipped
  in V8. Ship the generate-a-module form now.
- **fpcast (strict `call_indirect` signature casts).** `--fpcast-emu` already *is* the fix
  (opaque pointers killed LLVM's bitcast pass). Gap = it's a manual per-package opt-in.
  Improvement is infra: **auto-apply the post-link pass to any binary whose closure pulls in
  glib/gobject** (detect the dep), so it stops being an override. NOT global (that rewrites
  every binary's calling convention — see the fpcast learning in CLAUDE.md).
- **Unimplemented syscalls / compiled-out kernel features (pc#137).** Not a wall — coverage.
  Each is a "port it" task like SA_RESTART / futex / the virtio devices were (`memfd_create`,
  seccomp-as-allow, …). pc#137 is the audit; work it down. The VM-requiring ones arrive with
  Track A.
- **The cross-compile long tail.** Mostly generic nixpkgs cross quality. Two wasm-specific
  levers: (1) **run target wasm build-tools at build time** through a runtime (node/wasmtime)
  — unlike most cross targets, wasm binaries *are* host-runnable, fixing "package builds a
  codegen tool then runs it"; (2) **build in-guest** (native to the target) via #92 instead of
  cross — slow but sidesteps cross bugs for the tail.
- **JIT — the one true residual wall (accepted non-goal).** wasm can't execute runtime-
  generated *native* code. Softeners: most JIT packages run on their **interpreter fallback**
  (`--disable-jit`: Lua/CPython/PCRE) so it's usually a build flag, not a break; the *general*
  escape hatch is again runtime **wasm** codegen, but porting an engine's JIT to emit wasm is a
  **per-engine** rewrite, not systemic. Treat hard-JIT-required packages as out of scope.

**Net after the whole stack + these:** a large fraction of normal C/C++ nixpkgs runs
unmodified. The libffi path is now **proven** (`spikes/ffi-codegen/`): runtime-generated
trampoline modules call arbitrary scalar signatures — *including past the fixed backend's
K=24/M=2 bounds* — so FFI is **finish-work** (structs/varargs/closures = more marshalling on
the same mechanism), not a wall. The true residuals are **hard-JIT-required packages** and the
**cross-build tail** — see §9 for the precise floor.

## 9. The true floor (after the whole plan)

What the guest is, and what's left, *after* Tracks 0/A/B/C + the cleanup (#131) — stated
precisely so nobody mistakes "runtime walls gone" for "all of nixpkgs works."

**The post-plan target is MMU, NOT NOMMU.** Tracks A/B + #131 rebuild musl with `fork`/`vfork`
restored and the kernel with real `mmap`/COW/mprotect/isolation, so from the toolchain's view
the target is a **normal MMU Linux wasm target** (`wasm32 … linux-musl`, MMU; *static-or-dynamic*
once Track C adds a runtime linker). NOMMU is precisely what the plan **deletes** — do not
describe the post-plan target as NOMMU.

**But the LLVM triple stays `wasm32-unknown-unknown`, and that's fine.** The `-unknown` OS is a
*toolchain* constraint, unrelated to the MMU: clang **rejects** `wasm32-…-linux-…` (LLVM's wasm
backend only accepts OS `unknown`/`wasi`/`emscripten`), so the guest compiles as freestanding and
the Linux-ness is re-supplied by flags (`-D__linux__ -matomics -mbulk-memory -fwasm-exceptions`).
This persists after the plan — it's part of the *arch-exoticness*, not the memory model.
*(Inventing a custom vendor/OS doesn't help: an unrecognized OS string parses to `unknown` —
pure relabeling, same flags — and a first-class recognized OS would require **forking LLVM**
(driver ToolChain + ABI), which the stock-LLVM principle forbids and which wouldn't reduce
the actual musl/headers/features work. The upstream effort to give "Linux under wasm" a real
recognized triple is **WALI** (`wasm32-wali-linux-musl`) — a watch-item, not an action here.)*

The residual gaps, by kind:
- **A. JIT — the one inherent wall (accepted non-goal).** wasm can't execute runtime-generated
  *native* code. Interpreter fallback (`--disable-jit`) covers most; hard-JIT-required packages are
  out of scope. (The runtime-*wasm*-codegen primitive from Track C is the only general escape, but
  a per-engine port.)
- **B. The cross-build tail — the *actual* ceiling on "most of nixpkgs," and it's
  arch-exoticness, NOT NOMMU.** `wasm32` is a niche cross target with a bespoke static/dylink link
  model (the `-unknown` re-supply above, `-fvisibility=hidden`, the wasm-ld ELF-flag filter, the
  custom TLS `.o` link). This plan fixes the *runtime*, not the *build*; making the long tail
  *cross-compile* is a **separate, mostly-generic cross-compilation epic** (levers: run target
  wasm build-tools at build time; in-guest native builds via #92; upstream nixpkgs cross fixes).
- **C. Coverage frontiers (shrink over time).** Missing/ENOSYS syscalls + compiled-out kernel
  features (pc#137); single-CPU (`maxcpus=1`, no true SMP scaling); FFI structs/varargs/closures
  (core **proven** in `spikes/ffi-codegen/`, the rest is marshalling).
- **D. Inherently out of scope.** GPU/CUDA, kernel modules, direct hardware, hard real-time — a
  browser wasm guest can't offer these by nature.
- **Perf caveat (not correctness).** ~1.05–1.9× (eval-heavy worst, measured) until `memory-control`
  ships and swaps in the hardware backend.

**The reframe:** after the plan, the binding constraint flips from *"the process model is weird"*
(solved) to *"does it cross-compile to an exotic wasm32 target"* (a generic cross-porting problem).
That's a much better place to be — normal porting, not a fundamental wall.

## References

- Issues: **#24** (MMU on wasm — the blocker & payoff; `memory-control` watch), **#23**
  (Phase-2 fork deferred follow-ons; JSPI wontfix-for-fork), **#32** (asyncify seam —
  real fork-without-exec, closed not_planned), **#25** (retire forkshell onto the seam),
  **#29** (fork-at-scale eager-copy cliff; COW gated on MMU), **#33** (dlopen/dlsym +
  fork×dlopen interaction), **#11** (revisit NOMMU Wayland accommodations if MMU lands).
- In-repo: `docs/process-model.md`, `docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md`,
  the Track 0 note (`2026-07-01-process-model-track0-design.md`),
  `spikes/{elastic-mem,nofork,stackswitch,softmmu,ffi-codegen}/`, the asyncify seam (`toolchain/musl.nix`
  `forkSeam`, `userspace/asyncify-cc.nix`, `toolchain/guest-cc-fork.nix`), PIC/dylink +
  GOT substrate (`wasm-cross.nix`).
- External (measured, primary): WAVEN (NDSS 2025, `2025-746-paper.pdf`) — software MMU on
  native wasm, ~10.4% geomean, TLB hurts; LFI (ASPLOS 2024) — 15–67% generic per-access
  isolation; Faasm (ATC 2020) & Swivel/Lucet (USENIX Sec 2021) — host-MMU delegation;
  `WebAssembly/memory-control` (`Overview.md`/`virtual.md`/`discard.md`) — Phase 1;
  v86 `how-it-works.md` & `jart/blink` — emulator MMUs not reusable; WasmLinux &
  `joelseverin/linux-wasm` — non-emulator prior art.
