# #202 — eliminating the instrument-at-load memory cost (design + plan)

Date: 2026-08-14. Branch: `claude/issue-202-aot-instrumentation` (off
`claude/issue-179-vadh9d`). Status: **design only — nothing implemented.**

Issue #202 is one of the two open risks the MMU ship plan
(`docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md` § Risks, item 1)
records as blocking Phase 3. The other, #203, is fixed (`045c8f0`).

---

## 0. TL;DR / recommendation

**Fix it in the pass, in the engine. Do not ship pre-instrumented artifacts as
the primary fix.**

Two changes to `runtime/softmmu-pass.js`, in this order:

1. **Single-pass streaming emit.** Replace the per-function `number[]`
   accumulator and the three whole-module copies with one growable byte sink
   and backpatched 5-byte padded LEB length fields. Measured basis: a single
   1.4 MB function of `nix.wasm` costs **~298 MiB of RSS** today purely because
   its 12.6 MB emitted body is materialised as a JS `number[]` (~24 bytes of
   heap per emitted byte). Estimated whole-module effect on `nix.wasm`:
   peak delta ~503 MiB → ~160–300 MiB.
2. **Shrink the emitted per-access sequence** (fold the level-1 present test
   and the page-crossing test into ONE combined predicate; move the
   fault-and-retry loop out of line into a cold helper). Measured basis: the
   shipped A2+split encoding costs **147 bytes per memory access**; a hand-byte-
   counted restructure lands at **~101 bytes** (~31% less). That shrinks the
   transient, the emitted module, V8's compile+code cost, AND the per-access
   runtime — all four at once.

**AOT (build-time) instrumentation is rejected as the primary fix** — not
because it doesn't work, but because it cannot be the general fix and it
doesn't remove the dominant cost:

- It structurally **cannot cover guest-produced binaries**. The MMU/fork guest's
  headline capability set includes in-guest `cc`/`c++` (#3, #92) and in-guest
  `nix build` from source (#175). Those binaries are produced *inside the
  booted guest*; no Nix derivation can have pre-instrumented them. So the
  load-time pass stays, and every user who compiles anything still pays the
  full 11-GB-class path. That is PRIME DIRECTIVE corollary 1 exactly: a fix
  that solves the immediate task (`nix.wasm` boots in a tab) but not the actual
  goal (the MMU guest is usable in a tab).
- It does **not** remove V8's cost of compiling a 150 MB module. Measured:
  instrumenting `nix.wasm-fork` costs ~503 MiB of transient; **compiling** the
  result costs another ~140 MiB (lazy) to ~880 MiB (tiered-up). AOT deletes the
  first number and none of the second.
- The only AOT shape that is even *viable* is a host-side content-addressed
  sidecar (§5.2) — a guest-side one is impossible, see §5.3 (the instrumented
  `guest-clang` is ~320 MB, above the guest's 256 MB `MAX_ORDER` exec-image
  allocation ceiling; it could not be `execve`d at all).
- It costs a **5.4×** blow-up of the instrumented artifacts (measured) plus a
  new versioned publish pipeline whose failure mode is silently serving
  *stale instrumentation* — the same class of hazard the ABI-BUMP RULE exists
  to prevent.

AOT-as-host-side-CAS remains a legitimate **follow-on** once (1)+(2) land and a
real browser measurement exists; §5.2 specifies it fully so it can be executed
without redesign. It needs **no `ENGINE_ABI` bump** (§5.4).

---

## 1. Blast radius: is this a Phase-3 SHIP blocker or a browser-UX blocker?

**Neither, exactly — it is a Phase-3 ship blocker that today's shipped users
cannot reach.** Precisely:

- **The published guest does not instrument anything, ever.**
  `userspace/linux-image.nix` is instantiated in `flake.nix` with `kernel` —
  the NOMMU `.#kernel`, not `kernelMmuA2`. A NOMMU kernel passes `pt_base = 0`
  through the exec ABI, and `kernel-worker.js`'s `wasm_load_executable` gates
  the entire pass on `Number(pt_base || 0) !== 0`. On the shipped channel the
  softmmu pass is dead code. **Zero pc users are affected today.** This is not
  a "reload pc" or republish situation.
- **Who hits the path today:**
  1. `nix-wasm.yml`'s `nix-boot-smoke-mmu` job — which is *already* on
     `namespace-profile-lg` specifically because the default runner was
     OOM-killed (exit 137) loading the fork `nix.wasm` (#175). That's the only
     recorded hard failure.
  2. `boot-smoke`'s `mmu`/`mmu-devices` shards (`namespace-profile-md`) — these
     boot busybox-fork only (4.5 MB → 29 MB instrumented), which is comfortably
     within budget.
  3. A human clicking a PR preview's `?variant=mmu` link
     (`runtime/preview-variant.js`). This is a manual check, not a gate.
- **Who would hit it after Phase 3:** every end user of the Linux app, on every
  `exec` of every binary, in a real browser tab that also holds a 1.75 GiB
  guest-RAM `SharedArrayBuffer` (`CONFIG_BOOT_MEM_PAGES 0x7000`).

So: sequencing-wise this does **not** block Phase 2 (#131 slice-1 default flip
+ the batched world rebuild), and it does not block any republish of the
current NOMMU channel. It blocks **Phase 3 and only Phase 3**.

### 1.1 Correction to the framing in the issue text

The task brief says "the parity plan records roughly 11 GB tab RSS". **It does
not.** The plan's Risks item 1 says the opposite, verbatim:

> get a REAL browser (not Node/CI) memory measurement loading the fork
> `nix.wasm` on `.#kernel-mmu-a2` — `nix-wasm.yml`'s `browser-smoke` job's
> Playwright harness does not currently boot the MMU variant at all, so this
> number does not exist yet.

The only hard datum in the repo is the CI OOM-kill (exit 137 on the default
Namespace runner) and the mitigation of moving the job to `-lg`. **There is no
browser measurement.** Everything below is Node-measured (which is *worse* for
the JS-heap component than Chrome — see §3.4) plus explicit estimates. Getting
the browser number is step 0 of the plan (§7.1), because without it we cannot
tell whether (1)+(2) are sufficient or whether the AOT follow-on is required.

---

## 2. What I measured, and on what

All measurements are on **existing store paths / existing files** — no `nix
build` was run (this host has ~300 MB free disk). Peak RSS is `VmHWM` from
`/proc/self/status`, which is the kernel's own high-water mark, so it needs no
sampling loop. Node v22.22.2, pointer compression **off**, heap limit 8.2 GB.

Binaries used:

| artifact | store path | size | code sec | funcs | mem ops |
|---|---|---|---|---|---|
| `busybox` (fork) | `/nix/store/09qclng…-busybox-wasm32-fork-…-1.36.1/bin/busybox` | 4,478,021 | 4,231,827 | 3,503 | 170,521 |
| `nix` (fork) | `/nix/store/ia27w81…-nix-wasm-fork-2.34.7/bin/nix` | 27,812,850 | 16,374,850 | 39,843 | 955,521 |
| `clang` | `/nix/store/9isgsjb…-guest-clang-wasm32-21.1.8/bin/clang` | 59,691,009 | 52,738,646 | 138,983 | 3,110,445 |

Notes from the scan that matter downstream:

- Memory ops are **one per ~17 code bytes** in `nix`/`clang` (5.9% of code
  bytes are memory opcodes; ~24.8 B/op in busybox). This is the multiplier that
  drives everything: ~1M accesses in `nix`, ~3.1M in `clang`.
- `nix.wasm-fork` carries an **8,205,641-byte custom section** (the name
  section — #175 deliberately ships it unstripped for symbolised traces). The
  pass copies custom sections through verbatim, so those 8.2 MB ride into the
  instrumented image and into V8.
- `nix.wasm-fork` has **one 1,406,522-byte function** (the asyncified
  fork-graph frame). It is the single worst memory line item (§3.2).
- No SIMD in any of the three (the pass aborts on SIMD), so nothing is
  hiding behind the loud-abort path.

---

## 3. Where the memory actually goes

### 3.1 The headline numbers (measured)

`nix.wasm-fork`, `instrument(bytes, {checked:true, exportControls:true})`:

| stage | peak RSS | delta |
|---|---|---|
| node + file read (baseline) | 99 MiB | — |
| rewrite every function body, **discarding** the result | 464 MiB | +365 |
| rewrite + keep each body's `Uint8Array` | 449 MiB | +350 (GC noise) |
| full `instrument()` | **603 MiB** | +504 |
| + `WebAssembly.compile` (default, lazy) | 745 MiB | +142 |
| + `WebAssembly.compile` (`--no-wasm-lazy-compilation`) | **1,487 MiB** | +884 |

Output: **149,881,165 bytes = 5.39× the input.** Wall time for the pass: 8.2–8.9 s.

`busybox-fork`: 4,478,021 → 28,857,430 (**6.44×**), pass peak 222 MiB
(baseline 55), 1.9 s. With eager compile the peak reached 1,925 MiB — noisy
(V8 background tier-up racing process exit), reported for completeness but not
relied on.

For scale, `clang` was **not** instrumented here (it would need ~2.5–3 GB and
~40 s); its instrumented size is estimated at ~320 MB in §3.5.

### 3.2 Attribution — the single biggest line item is a JS `number[]`

`rewriteFuncBody` accumulates the rewritten body into a plain JS `number[]`
(`const out = []; out.push(…)`) and only converts to bytes at the end
(`concatBytes([u(len), rewritten])` in `instrument`).

Measured in isolation, on `nix.wasm-fork`'s single biggest function:

```
biggest fn = 1,406,522 B source; baseline peak 100 MiB
rewriteFuncBody(...) inline  -> 12,610,478 B body ; peak 398 MiB
```

**One function moves the peak by ~298 MiB.** That is ~24 bytes of process RSS
per emitted wasm byte: 8 bytes per element for a `PACKED_SMI_ELEMENTS`
`FixedArray` on a Node build without pointer compression, times ~2–3× for
V8's geometric array growth + the old copy still live during a grow + GC lag.

This is also where the **double rewrite** bites. `instrument()` rewrites a
function inline, checks `rewritten.length > inlineLimit` (6 MB), and if so
rewrites it **again** with the helper-call translate — while the first
`number[]` is still referenced by `rewritten`. On `nix.wasm-fork` this happens
for function #2 exactly (the pass logs it): 12,689,379 B inline, then
2,353,348 B via helper. Both arrays live simultaneously.

### 3.3 The rest of the peak

After the per-function transient, `instrument()` holds the whole instrumented
module **three times over** at the end:

1. `newCodeEntries` — one `Uint8Array` per function, ~148 MB total, still
   referenced when
2. `newCodeBody = concatBytes([...newCodeEntries])` — a second full copy
   (~148 MB), still referenced when
3. `bytesOut` — the assembled module (~150 MB).

That is ~446 MB live at the final assembly, matching the measured +504 MiB
whole-pass delta once the per-function scratch has been collected.

`splitSections` uses `subarray` (views, not copies) and `scanUnhandled` is a
read-only walk — neither is a contributor. The parsed-module representation is
**not** a factor at all: this pass never materialises an AST or an instruction
list; it is a byte-to-byte rewriter. So of the candidates named in the brief,
the answer is: **the emitted output buffer, several times over, plus a ~24×-
amplified `number[]` for the largest function** — not parsing, and not
(primarily) `WebAssembly.compile`.

### 3.4 `WebAssembly.compile` and the retained-module tail

Compile of the instrumented module adds **+142 MiB** at load (V8 keeps the wire
bytes and the module metadata; function code is compiled lazily on first call)
and up to **+884 MiB** once functions are actually compiled/tiered. The
uninstrumented `nix.wasm` compiles for +111 MiB by comparison. This cost is a
direct function of the emitted module size, so it is reduced ONLY by §6
(shrinking the encoding) — streaming does not touch it, and AOT does not touch
it either.

There is also a **retention** tail that grows over a session, not per-exec:
`kernel-host.js` keeps `exec_module_cache`, a content-keyed FIFO of compiled
`WebAssembly.Module`s capped at **`EXEC_MODULE_CACHE_MAX = 48`**, and every
worker gets a *snapshot* of it at creation and adds its own misses to a local
`exec_modules` `Map` with **no cap**. 48 distinct instrumented binaries — a GTK
session easily reaches that — at 5.4× expansion is on the order of a gigabyte
of retained wire bytes plus whatever code V8 has compiled. Structured-cloned
Modules share compiled code across workers, so this is once, not once-per-
worker; the *transient* pass cost, however, IS once per worker that misses the
cache, and several workers can miss concurrently during a shell-heavy boot.

### 3.5 Estimate: what a browser tab would actually hold

Not measured (see §1.1 — the number does not exist). Reasoned estimate for a
Chrome tab booting `.#kernel-mmu-a2` + the fork squashfs and running
`nix-env -iA`:

| component | estimate | basis |
|---|---|---|
| guest RAM `SharedArrayBuffer` | 1.75 GiB | `CONFIG_BOOT_MEM_PAGES 0x7000`, `kernel.nix` |
| pass transient for `nix.wasm` | ~250–500 MiB | measured 504 MiB in Node; Chrome's pointer compression halves the `number[]` half of it |
| retained instrumented `nix.wasm` module | ~150 MB wire + ~300–900 MB code | measured compile deltas |
| retained instrumented `busybox` module | ~29 MB + code | measured |
| retained instrumented `clang` (if the session compiles) | ~320 MB wire + code | 59.7 MB × 5.4 |
| ×N workers with concurrent misses | multiplies the transient only | `exec_modules` is a snapshot |

That lands in the 3–5 GB range for a `nix-env` session and can plausibly reach
double digits for a session that also execs `clang` and several GTK apps while
multiple workers miss the cache concurrently — which is consistent with an
11 GB anecdote, but **I did not measure it and neither did the parity plan.**

Chrome caveat cutting the other way: Chrome builds V8 **with** pointer
compression (4 B per SMI element, so the `number[]` transient is roughly half
of Node's) but caps the compressed heap cage at ~4 GB per isolate — and the
`number[]` transient lives *inside* that cage while the wasm module bytes and
compiled code live outside it. A 300 MiB `number[]` for one function is fine;
it is the sum with everything else that isn't.

---

## 4. What the pass is contractually required to keep doing

Any redesign must preserve all of this — it is all load-bearing and all was
found by booting:

- **Inline the translate, never a helper call per access** (a helper call per
  access measured ~12× under V8; the file header records this). Any size
  optimisation that turns the *hot* path into a call is a regression, not a
  fix. Moving the *cold* path (fault + retry) out of line is not.
- **Level-1 present test is `entry != 0`; leaf test is `pte & 1` for loads and
  `pte & 3` for stores/RMW.** The write-bit test on stores is what makes COW
  and `mprotect` work.
- **Page-crossing accesses (width ≥ 2) must split byte-wise**, translating each
  byte's page separately.
- **Atomics keep their original `align`** and are translated identically to
  scalars; SIMD aborts loudly.
- **The start section is stripped and re-exported as `__mmu_start`** — the
  embedder sets `__mmu_pt_base` and *then* calls it.
- **`checked` mode requires** imported `__wasm_syscall_2`, imported
  `__stack_pointer`, exported `__get_tls_base`, and throws (never silently
  degrades) if any is missing.
- **`isInstrumented()` already exists** and makes the engine skip the pass for
  an image that already exports `__mmu_start`. Every AOT design below is
  standing on this existing mechanism, not inventing one.

---

## 5. Option A — ahead-of-time (build-time) instrumentation

Worked through fully, because the brief asks for it and because the follow-on
version (§5.2) is worth keeping on the table.

### 5.1 The obvious shape, and why it does not work

"Run the pass in Nix, ship the instrumented binary in place of the original."

- **Which derivations.** To be correct in general (corollary 1) this cannot be a
  curated list — a user can `nix-env -iA nixpkgs.<anything>`, so it would have
  to be a shared post-link seam in the MMU/fork world's cc-wrapper
  (`wasm-cross.nix`), the way `-fvisibility=hidden` and the allow-list file are.
  That is a full `cross.*` world rebuild and a second Cachix world, on top of
  the already-separate `-fork` world (`musl-fork`, asyncify, its own squashfs).
  Affected today: `.#userspace-busybox-fork`, `.#nix-wasm-fork`,
  `.#guest-clang`, every `cross.*` package in the fork squashfs's
  `environment.systemPackages`, and every published wasm output in the guest
  binary cache.
- **Selection at boot.** The exec path never sees a filename — `binfmt_wasm`
  hands the engine a *byte range in guest memory*
  (`wasm_load_executable(bin_start, bin_end, …)`). So "pick the instrumented
  file" is not expressible without an ABI change; the selection has to happen
  either inside the bytes (a custom section) or host-side by content hash.
- **The killer: guest RAM and `MAX_ORDER`.** With the instrumented image *in
  the store*, the guest kernel must read it into an exec-image buffer.
  Instrumented sizes are 5.4–6.4× (measured): `busybox` 29 MB, `nix` 150 MB,
  `clang` **~320 MB**. The guest has 1.75 GiB total and
  `CONFIG_ARCH_FORCE_MAX_ORDER=16` → a **256 MB** maximum contiguous
  allocation. A 320 MB `clang` **cannot be `execve`d at all**, and a 150 MB
  `nix` would need an order-16 block on a heap that #192 already showed
  fragments under repeated large execs. Today the guest reads the *original*
  60 MB and the 320 MB expansion happens in host JS, outside the guest's
  address space entirely. Moving it into the guest is strictly worse.
- **Guest-produced binaries.** `cc hello.c -o hello` in the guest, and #175's
  in-guest `nix build` from source, produce binaries no derivation touched. The
  load-time pass must remain for them. So AOT never removes the code path, only
  (some of) its traffic.

Conclusion: **store-resident AOT is not viable.** Not "expensive" — *not
viable*, on the `MAX_ORDER` point alone.

### 5.2 The viable AOT shape: a host-side content-addressed sidecar

If AOT is done later, this is the design:

- Nix builds, for each instrumentable artifact, `sha(original bytes) →
  instrumented bytes`, and publishes them as a **CAS tree alongside the boot
  artifacts** (a `linux-image` member / R2 prefix, e.g.
  `mmu-cache/<passver>/<hash>.wasm.zst`), keyed on the **pre-instrument**
  content hash.
- The engine already computes exactly that key: `exec_hash(bytes)` in
  `kernel-worker.js` (2×FNV-1a + length over the pre-instrument bytes), used
  for `exec_modules`. The sidecar lookup slots in as a third tier ahead of the
  pass:
  `exec_modules` hit → sidecar fetch → local `instrument()`.
- **It fits the existing control flow with no restructuring**: `user_executable`
  is *already* a `Promise` (`WebAssembly.compile(...)`), awaited later by
  `start_thread`. So the sidecar fetch can be async without changing the
  synchronous host-import contract:
  `user_executable = fetchSidecar(key).then(b => WebAssembly.compile(b ?? softmmuInstrument(bytes, …)))`.
  Only the `table_import_initial(bytes)` probe, which runs synchronously today,
  has to move inside the promise or be computed from the *original* bytes (it
  can: the pass appends, it never touches the table import).
- **The guest is untouched.** It still reads the 60 MB original into its exec
  buffer; the 320 MB expansion stays in host JS. `MAX_ORDER`, guest RAM, the
  kernel, `binfmt_wasm`, `pt_base` — all unchanged.
- **Versioning is mandatory and is the main hazard.** The pass has changed
  repeatedly and semantically (A2 checked walk, #128 page-crossing split, #164
  helper fallback, the level-1 present-test fix). A stale sidecar would run the
  *wrong walk* silently — the exact class of failure the ABI-BUMP RULE exists
  to prevent. So: the pass gets an explicit `SOFTMMU_PASS_VERSION` constant,
  every emitted image carries it in a `softmmu.version` custom section, the CAS
  path includes it, and the engine **refuses** (falls back to instrumenting) any
  sidecar whose stamp ≠ its own. A CI gate must assert the constant changes
  whenever `softmmu-pass.js`'s emit changes — modelled on the `ENGINE_ABI`
  discipline, e.g. a golden-output test over a checked-in fixture whose hash is
  pinned next to the version constant.
- **Cost:** the browser downloads ~150 MB (≈25–35 MB zstd) for `nix`, ~320 MB
  (≈50–70 MB zstd) for `clang`, instead of spending ~8 s CPU and ~500 MiB
  transient. Whether that is a win depends entirely on the browser number that
  does not exist yet (§1.1).

### 5.3 Rejected sub-variant: embed the instrumented image as a custom section

Self-describing (no ABI change, no CAS, no fetch), and `isInstrumented()`-style
detection is trivial — but it makes the *file* 6.4× bigger, which lands
squarely on the `MAX_ORDER`/guest-RAM wall of §5.1. Rejected for the same
reason.

### 5.4 Does AOT force an `ENGINE_ABI` bump?

**No** — for the §5.2 shape. Per `runtime/abi.js`, `ENGINE_ABI` is the
kernel↔engine wire contract: the 9P/virtio transport, the exec ABI, the device
models, the syscall/loader stubs. §5.2 changes none of them:

- `pt_base` already rides the exec ABI and keeps its exact meaning.
- The start-section strip → `__mmu_start` is *internal to the module*; the
  engine's existing call site is unchanged, and an AOT image produces the same
  export the load-time pass does.
- No host import is added, removed, or retyped. The sidecar fetch is
  engine-internal (the same class as #196's `wasm_error` fix or #179's exec-
  reject return value, both explicitly no-bump).

It **is** a `kernel-worker.js` edit, so it carries the standing
`runtime/sync-to-pc.sh <pc-checkout>` obligation before any pc deploy. And note
the deferred bump `abi.js` already documents: whenever the MMU/fork guest
*becomes* the published image, that flip is itself the bump.

### 5.5 dlopen side modules and runtime ffi trampolines

AOT changes this story **not at all**, and should not try to.

Per CLAUDE.md and `kernel-worker.js` (~lines 1467–1535), runtime-instantiated
side modules and `ffi-codegen.js` trampolines are **un-instrumented guest code**
and are **refused loudly** under a nonzero `pt_base` (`-ENOEXEC`/`dlerror`, and
the C `wasm_ffi_unsupported` abort) rather than being allowed to corrupt
memory. That refusal is a deliberate #185 decision with its own open design
constraints (a checked-pass side module needs imports a side module does not
have).

- **ffi trampolines are generated at runtime, in the host, per call signature.**
  No build step can precompute them. AOT is irrelevant.
- **dlopen side modules loaded off the guest FS** *could* be covered by the same
  §5.2 CAS (they come out of the store like any other artifact), which is a
  genuine bonus — but it does not resolve #185's actual blocker, which is that
  the pass's checked mode requires `__wasm_syscall_2`/`__stack_pointer`/
  `__get_tls_base`, and a PIC side module does not have them. Solving that is
  its own piece of work with or without AOT.

So: leave it alone. Neither option in this document changes the refusal.

### 5.6 Store/closure size impact (measured expansion, estimated closure)

Measured expansion ratios: **busybox 6.44×, nix 5.39×**; `clang` estimated
~5.4× → ~320 MB. Per-access emitted cost is 147 B (§6.1), so the ratio is
essentially `1 + 147 × (mem-ops / total-size)` and is stable across binaries.

Are both copies needed? For the §5.2 host-side CAS: **yes, both** — the guest
store keeps the original (that is what `execve`s, and the CAS key is its hash)
and the CAS holds the instrumented copy. But the instrumented copy lives in a
*host-side artifact tree*, not the guest closure, so it does not touch the
served squashfs, guest RAM, or the guest's `/nix` at all. It does add ~5.4× of
the instrumentable footprint to the published channel and to whatever fraction
of the binary cache is pre-instrumented.

For the §5.1 store-resident shape only one copy would be needed — and that
shape is not viable anyway.

---

## 6. Option B/C — streaming emit, and shrinking the encoding

These are the two halves of the recommendation. They are independent and both
are confined to `runtime/softmmu-pass.js` (+ its unit tests).

### 6.1 Where the 5.4× comes from (measured)

Emitted code-section size on `busybox-fork` (orig code section 4,225,743 B,
170,521 memory ops), one run per configuration:

| configuration | emitted code | ×orig | B / access |
|---|---|---|---|
| A1 unchecked, no page-split | 13,769,277 | 3.26× | 56 |
| A1 unchecked, + page-split | 17,895,851 | 4.23× | 80 |
| A2 checked, no page-split | 25,087,689 | 5.94× | 122 |
| **A2 checked + page-split (SHIPPED)** | **29,214,263** | **6.91×** | **147** |

So the A2 present-check costs ~66 B/access on top of A1, and the page-crossing
split ~24 B/access. (Hand byte-counting the A1 unchecked emit gives 57 B, which
matches the measured 56 — the accounting below can be trusted.)

### 6.2 C — shrink the emitted per-access sequence

Three changes, all preserving §4's contracts:

1. **One combined predicate instead of two `if`/fault/`br` blocks.** Compute the
   whole walk unconditionally into `$PGD_E`/`$PTE`, then branch **once** on
   `(pgd_e != 0) & ((pte & need) == need)`. Safe because a not-present level-1
   entry is exactly `0`, so the level-2 raw load reads from `idx*4 < 4096` —
   in-bounds, cannot trap — and its value is neutralised by the `pgd_e != 0`
   conjunct. (This conjunct is **load-bearing**: without it, garbage in low
   memory with bits 0+1 set would pass the leaf test.)
2. **Move fault-and-retry out of line.** The `else` arm becomes
   `local.get $EA; i32.const kind; call __mmu_slow` where `__mmu_slow(ea,kind)
   -> phys` is the appended, *authoritative*, present-checked walk-with-retry
   (essentially today's `checkedTranslateBody`). This does **not** violate the
   "inline the translate" rule: the hot path stays fully inline; only the cold
   fault path becomes a call. Today's inline `emitFaultCall` is ~15 B and is
   emitted **twice** per access.
3. **Fold the page-crossing test into the same predicate** —
   `& ((ea & 0xfff) <= 0x1000 - W)` — so the fast/slow branch is one `if`, and
   the slow arm calls the existing byte-wise helper.

Hand byte-count of the resulting per-access emit (loads, W ≥ 2, real
multi-byte LEB indices): ea setup 6, level-1 17, level-2 25, combined predicate
23, `if`/fast-arm/`else`/slow-arm/`end` 30 → **~101 B/access vs 147 today
(−31%)**. Projected: `nix.wasm-fork` 150 MB → ~112 MB; `clang` ~320 → ~240 MB.

It should also be **faster**: one branch instead of three, no `loop` framing on
the hot path, and the retry loop (which today re-executes the whole inline walk)
lives in the helper.

Honest limit: this is a 30% improvement, not an order of magnitude. The walk
itself (42 B for two levels) is the irreducible core of an inline 2-level walk.
The only way past it is a **flat single-level shadow table** (`phys = u32[pt_base
+ (ea>>>12)<<2]`, ~14 B) — which is what `spikes/softmmu` originally modelled,
and which the design deliberately rejected because the generic MM wants
page-sized PTE tables. Maintaining a flat shadow *alongside* the real tables is
a real option (4 MB/process for a full 32-bit VA space, order-10 contiguous —
affordable under the CONFIG_WASM contiguous-vmalloc design) and would cut the
emit to ~55 B/access and the runtime cost roughly in half. It is a **kernel**
change of real size and is out of scope here; recorded so it is not forgotten.

### 6.3 B — streaming / single-pass emit

**Feasible, and the code structure is already 90% of the way there.** The pass
is a pure byte-to-byte rewriter — it never builds an AST — and every index it
needs (`translateFunc`, `bulkFns`, `splitFns`, `ptBaseGlobal`, the appended type
indices) is computed from section *counts* before any body is rewritten. So
bodies can be emitted in one forward pass. Concretely:

1. **`rewriteFuncBody` writes into a `ByteSink`** (a growable `Uint8Array` +
   `push`/`pushBytes`) instead of a `number[]`. Purely mechanical — the function
   only ever appends. This alone removes the ~24×-per-byte amplification
   (measured: ~298 MiB for one function → ~13 MiB).
2. **Choose inline-vs-helper mode BEFORE emitting**, from a cheap size estimate
   (`memOpCount × ~101 B + originalSize`), instead of emitting inline and
   re-emitting on overflow. Removes the double rewrite entirely. Keep a
   post-hoc assertion (emit, then verify `< kV8MaxWasmFunctionSize`) so a
   mis-estimate fails loudly rather than producing an uncompilable module.
3. **Emit the code section directly into the output sink** with a **5-byte
   padded LEB** reserved for the section size and for the function-count vector,
   backpatched at the end. I **verified experimentally** that V8 accepts
   non-minimal (padded) LEB128 for section sizes, function-body sizes, and
   vector counts — all five combinations of padded/minimal load fine
   (`new WebAssembly.Module`). This removes `newCodeEntries` **and**
   `newCodeBody`, i.e. two of the three whole-module copies.
4. Optionally pre-size the output sink from the same estimate, so the sink never
   doubles (the remaining transient is then exactly one copy).

Estimated effect on `nix.wasm-fork`: peak delta ~504 MiB → **~160–300 MiB**
(one output buffer of ~112 MB after §6.2, plus one function's scratch, plus the
28 MB input). Combined with §6.2, the module V8 has to hold drops from 150 MB
to ~112 MB.

What streaming does **not** fix: `WebAssembly.compile`'s cost, and the retained
`exec_modules` tail. Those need §6.2 and §6.4 respectively.

### 6.4 Two cheap adjacent wins

- **Cap the worker-side `exec_modules`.** `kernel-host.js` caps its cache at 48
  (FIFO); the per-worker `Map` that receives the snapshot and adds local misses
  has no cap. Give it the same bound.
- **Consider dropping the 8.2 MB name section from the shipped fork
  `nix.wasm`** — or at least be aware the pass copies it through into the
  instrumented image and into V8. #175 ships it unstripped deliberately (for
  symbolised traces), so this is a judgement call, not an obvious win; it is
  ~5% of the instrumented module.

---

## 7. Recommendation, sequencing, gates, risks

### 7.1 Sequence

0. **Get the browser number that does not exist.** Extend
   `runtime/demo/web/smoke.mjs` (or a sibling) to boot the `?variant=mmu`
   artifact set under Playwright/Chromium and report peak memory —
   `performance.measureUserAgentSpecificMemory()` is available because the demo
   already ships COOP/COEP for `SharedArrayBuffer`, and CDP
   `Performance.getMetrics` / `--enable-precise-memory-info` are fallbacks.
   Record the baseline for `busybox` (cheap) and, if it survives, `nix`.
   *Without this, we cannot tell whether §6 alone is sufficient.*
1. **§6.3 streaming emit** — biggest measured win, smallest blast radius, no
   contract change. Gate on byte-identical output (see §7.2).
2. **§6.2 encoding shrink** — helps transient, module size, compile cost, and
   runtime speed. This one changes generated code semantics-adjacent structure,
   so it needs the full boot matrix.
3. **§6.4** cap the worker cache.
4. **Re-run step 0.** If a browser tab is now comfortable, #202 closes and
   Phase 3 is unblocked. If not, execute **§5.2** (host-side CAS sidecar) with
   its version stamp and its CI drift gate.

### 7.2 Verification gates

- **Differential byte-identity (step 1 only).** The streaming rewrite must
  produce output **byte-for-byte identical** to today's for a real binary. A
  temporary test that runs both implementations over
  `runtime/test-fixtures/softmmu/*` and over one real store binary and compares
  hashes is the cheapest possible proof, and it is available *because* step 1 is
  a pure refactor. Do step 1 before step 2 precisely so this gate exists.
- **Existing unit gates:** `runtime/softmmu-pass.test.js`,
  `softmmu-fork.test.js` (asyncify × softmmu × COW, two instances on one
  Memory), plus the four static gates (`bun run test|lint|format:check|typecheck`).
  Step 2 needs new unit cases for the combined predicate: a not-present level-1
  entry whose level-2 slot in low memory has bits 0+1 set **must** still fault
  (this is the specific hazard §6.2 introduces).
- **Existing boot gates, all already hard gates on `.#kernel-mmu-a2`:**
  `mmu-smoke.mjs`, `mmu-smoke-a2.mjs` (demand paging, COW, `mprotect`),
  `fork-smoke.mjs`, `build-from-source-e2e` (BUILD1/2/3), the
  `nix-boot-smoke-mmu` `core` + `gtk` shards, and `autotools-fork-smoke.mjs`.
  Step 2 must go through all of them — the COW/`mprotect` behaviour it touches
  is exactly what `mmu-smoke-a2` exists to pin.
- **The new gate this work should leave behind:** the step-0 browser MMU smoke,
  wired into CI with a **peak-memory assertion**, so a future pass change that
  re-inflates the emit turns a job red instead of being discovered by a user's
  tab. That is the gate #202 is really asking for; today `browser-smoke` (folded
  into `nix-boot-smoke`'s `core` steps) never boots the MMU variant at all.
- **Runtime-cost check:** step 2 claims to be *faster*; confirm with the
  existing timing signals rather than a new benchmark — `nix-boot-smoke-mmu`'s
  wall time and `NIX_MAKE_TIMEOUT_MS` headroom are the honest indicators.

### 7.3 What could go wrong

- **The combined predicate is subtly wrong.** The `pgd_e != 0` conjunct is
  load-bearing; drop it and a zero-PGD access reads a garbage "PTE" out of low
  memory and, if bits 0+1 happen to be set, walks through to a wrong physical
  address — silent corruption, not a trap. Mitigation: the dedicated unit case
  above, plus `mmu-smoke-a2`.
- **Fault ordering changes.** Today a level-1 miss faults with `kind` before the
  level-2 read happens; combined, both levels are read first and the helper
  re-walks. Outcome is identical (the helper is authoritative and
  `handle_mm_fault` is idempotent for this purpose) but any kernel-side logic
  keyed on fault *sequence* would notice. Nothing in `mm/fault.c` appears to be,
  but this deserves a look before implementing.
- **Padded-LEB reliance.** Verified in V8 (Node 22) for section size, body size,
  and vector counts; the spec permits non-minimal `uN` up to `ceil(N/7)` bytes.
  Still, if anything downstream re-parses the module with a stricter reader
  (`table_import_initial`, `isInstrumented`, `dylink.js`, the pc-side engine),
  it must tolerate them. Cheap alternative if this bites: keep the two-pass
  code-section assembly but with a byte sink, which still removes the 24×
  amplification and one of the three copies.
- **Streaming must not regress the `#164` over-limit path.** The size *estimate*
  driving the inline/helper choice must be conservative; keep the post-emit
  assertion so a mis-estimate is a loud build/boot error, not an uncompilable
  module.
- **§6.2's 30% may not be enough.** It is a 30% improvement, honestly labelled.
  If the step-0 browser number says a tab needs an order of magnitude, the
  answer is §5.2 (AOT CAS) and/or the flat-shadow-table kernel change in §6.2's
  closing paragraph — not more micro-optimisation of the current encoding.

### 7.4 Why this ordering satisfies the PRIME DIRECTIVE

The shared thing is `runtime/softmmu-pass.js`: every instrumented binary, on
every host (Node smokes, CI runners, browsers), from every source (the Nix
build, the guest's own compiler, `nix build` from source in the guest) goes
through it. Fixing it fixes all of them. AOT fixes only the subset that a
derivation produced, on the subset of hosts that can reach the published CAS,
and leaves the in-guest-compile path — a Phase-3 *feature* — on exactly the code
path #202 is about. Doing AOT first would be shipping the tractable slice and
calling it done (corollary 2), and it would add a versioned-artifact pipeline
whose stale-serving failure mode is silent (the ABI-BUMP-RULE hazard class)
before we have even measured whether it is needed.

---

## 8. Measured vs. estimated

**Measured** (on this host, on existing store paths; commands and scripts are
throwaway and not committed):

- Section/function/memory-op census of `busybox-fork`, `nix-wasm-fork`,
  `guest-clang` (§2 table), including the 8.2 MB name section and the single
  1.4 MB function in `nix`.
- Instrumented output sizes and pass wall time: `busybox` 4,478,021 →
  28,857,430 (6.44×, 1.9 s); `nix` 27,812,850 → 149,881,165 (5.39×, 8.2–8.9 s).
- Peak RSS (`VmHWM`) of: baseline read, rewrite-all-discard, rewrite-all-keep,
  full `instrument()`, `+compile` lazy, `+compile` eager — for `nix` (§3.1) and
  `busybox`.
- The single-function isolation: 1,406,522 B source → 12,610,478 B emitted,
  peak 100 → 398 MiB (§3.2).
- The four-configuration per-access byte cost table on `busybox` (§6.1),
  including the 147 B/access shipped figure.
- V8 accepts non-minimal (padded) 5-byte LEB128 for section size, function-body
  size, and vector count (§6.3, direct `new WebAssembly.Module` test).
- Code facts read directly: `linuxImage` is built with the NOMMU `kernel`;
  `wasm_load_executable` gates instrumentation on `pt_base != 0`;
  `EXEC_MODULE_CACHE_MAX = 48` on the host with no cap on the worker-side
  `exec_modules`; `user_executable` is already a Promise; the parity plan
  contains **no** browser memory number.

**Estimated** (reasoning shown inline, not verified):

- `clang` instrumented ≈ 320 MB (59.7 MB × the measured ~5.4× ratio) — the pass
  was **not** run on it.
- The ~101 B/access figure for the §6.2 restructure — hand byte-counted, not
  implemented. (The counting method was validated against the measured A1
  number: hand-count 57 vs measured 56.)
- Post-streaming peak of ~160–300 MiB for `nix` — arithmetic from the measured
  component sizes, not measured.
- The §3.5 browser-tab table — reasoned from the Node measurements plus the
  1.75 GiB SAB; **no browser measurement was taken, and none exists in the
  repo.**
- Compressed sidecar sizes (~25–35 MB zstd for `nix`) — typical wasm zstd
  ratios, not measured.
- The flat-shadow-table sketch (~55 B/access, 4 MB/process) — arithmetic only.

---

## Addendum (2026-08-14, post-#212): the §7.1 step-0 real browser measurement

Attempted after PR #212 (the streaming-emit + combined-predicate fix) merged
to master as `1f507bf`. **Partial result: boot + exec success in a real
browser tab is now confirmed for both variants (a first) and a clean,
trustworthy EXEC-LATENCY delta was obtained — but a trustworthy
instrument-at-load PEAK-MEMORY delta was NOT obtained**, for a specific,
measured reason recorded below. This is not the clean "does it fit in a tab"
verdict §7.1 was hoping for; it is real progress plus a new, real, separate
finding that blocked the rest.

### Method

Per this doc's own instruction ("Extend `runtime/demo/web/smoke.mjs`"), the
harness reuses that file's proven boot-detection idiom rather than a fresh
driver — see the file-header note in the throwaway probe script (`mem-probe.mjs`,
not committed; lives only in the session's scratchpad) for why.

- **Target**: PR #212's own artifacts, fetched from the `nix-wasm-previews` R2
  bucket's content-addressed `cas/<buildhash>/` prefixes (immutable, and NOT
  removed by the PR-close teardown workflow, unlike the `pr-212/` pointer
  itself, which the close-triggered `teardown` job purges — confirmed by a
  direct 404 on the old PR-212 preview URL). Buildhashes recovered from the
  `deploy` job's own log (`nix-wasm.yml` run `31786008858`):
  default `23bf491f642ffaebb3e24a135eeb9054`, mmu `c211adb72d39f9d59fe0250d7a3a03c5`.
- A local Node static server plus a `/cas/*` **same-origin proxy** to that R2
  prefix (`proxy-serve.mjs`) stands in for the torn-down `pr-212/` frontend —
  necessary because the R2 worker sends no `Access-Control-Allow-Origin`, so a
  cross-origin `fetch()` of `base.squashfs` (boot-nix-system.js's plain
  `fetch(u("base.squashfs"))`) is CORS-rejected and boot silently never
  progresses; this was the first dead end (see below).
- Chromium: the pre-installed `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  (matches the vendored Playwright's expected revision; the host's default
  `chromium.launch()` targets rev 1194 too — no mismatch this session),
  `--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader`, headless.
- `window.crossOriginIsolated === true` confirmed on every run (COOP/COEP both
  present via the local server); `performance.measureUserAgentSpecificMemory`
  confirmed present and callable.
- OS-level cross-check: every Chromium process matching the binary path,
  summed and broken out by `--type=` from `ps -eo pid,rss,args`, sampled every
  2s for the whole run — this is what actually localized the finding below to
  the **renderer** process specifically.

### Two real harness bugs found and fixed en route (recorded so they aren't repeated)

1. **Cross-origin `fetch()` with no CORS headers.** The first attempt pointed
   `preview.json`'s `artifactsBase` straight at the R2 worker's `cas/` URLs
   from a `localhost` page. Boot hung forever with zero console signal (the
   `fetch()` promise rejects, `boot()`'s `.catch` only sets page text, and
   nothing in the page emits a matching console line) — indistinguishable from
   a slow boot until diagnosed by adding live `window._termLog` tailing to the
   probe and noticing it never grew. Fixed by the same-origin proxy above.
2. **The exact #96 class of bug, reproduced by this session firsthand.** The
   guest tty echoes every keystroke into `window._termLog` **immediately**,
   before any shell reads it. A bare `/[#$%]/` prompt-detection regex (copied
   from `smoke.mjs`) false-positived on kernel boot text containing those
   characters, ~13 real seconds before a shell actually existed; an
   `.includes("MARKER")` completion check false-positived on the **raw typed,
   not-yet-executed** keystrokes themselves (typing `echo FOO=$?` makes
   `_termLog` contain `FOO=` on the very keypress, with no digit, well before
   Enter). Together these made an early "run" falsely report `nix --version`
   as completing in under a second when it had not even reached a real shell
   yet. Fixed exactly per CLAUDE.md's own #96 lesson: match the REAL prompt
   banner specifically (`/root@[^\n]*#/`, the identical regex `main.js` itself
   uses for its own proxy-start gating) and require a **digit** immediately
   after `=` for command completion (`/NIXVERDONE=\d/`) — the raw echoed
   keystrokes never satisfy that, only real shell expansion does. Re-running
   with the fix produced markedly different, self-consistent, correct-output
   timings (below); the pre-fix numbers were discarded, not reported.

### What is trustworthy

Both variants **boot to a real interactive shell and correctly execute
`nix.wasm`** in a real, headless-but-otherwise-real Chromium tab, confirmed by
shell-expanded exit-code markers (not keystroke echo) and correct command
output (`nix (Nix) 2.34.7`) on both:

| | NOMMU baseline | software-MMU (`kernel-mmu-a2` + real fork) |
|---|---|---|
| `crossOriginIsolated` | true | true |
| wall-clock to real shell prompt | ~22–34s (3 runs, network-jitter variance) | 44.8s (1 run) |
| first `nix --version`: wall-clock from Enter to output | **~1–3s** | **~30.1s** |
| second `nix --version` (same content hash): wall-clock | ~2.6s | **~2.1s** |
| second-exec output | `nix (Nix) 2.34.7`, exit 0 | `nix (Nix) 2.34.7`, exit 0 |

The **first-vs-second exec latency delta on MMU (~30.1s → ~2.1s) is the
single cleanest, most trustworthy number this session obtained.** It is
exactly the shape §3.4/§6.4's `exec_module_cache` design predicts: the first
exec pays `instrument()` + `WebAssembly.compile()` of the ~111 MB output once;
the second exec, same content hash, hits the cache and completes in about the
same wall-clock as the NOMMU baseline's un-instrumented exec. The NOMMU
baseline's near-identical first/second timings (nothing to instrument, since
`pt_base == 0` gates the whole pass off) are the correctly-behaving control
that makes this comparison meaningful — this is real evidence the fix's
target case (repeated execs of the same binary) behaves as designed in an
actual browser, not just in Node.

### What is NOT trustworthy, and why: a new, real, separate finding

Peak-RSS attribution to `instrument()` specifically could **not** be obtained.
Across 5 independent boots (3 baseline, 2 mmu, all post-#96-fix), the
Chromium **renderer** process (isolated from the browser/gpu-process/utility/
zygote processes via the `ps --type=` breakdown — only the renderer moves)
exhibits large, continuous, roughly linear growth — tens to ~250 MiB per 2s
sample — that:

- **begins within seconds of the guest reaching an interactive shell**,
- **continues identically whether or not any guest command is ever run**
  (reproduced on a NOMMU run that only idled after boot, no exec at all), and
- **is present on the un-instrumented NOMMU baseline just as much as on MMU**
  (baseline peak renderer RSS before crash: 8,474 MiB / total 9,124.7 MiB at
  t+59.5s; MMU: 9,506.6 MiB / total 10,153.4 MiB at t+87.8s) —

and both variants' tabs eventually crash (Chromium kills the renderer; no
crashpad minidump is produced, consistent with an internal OOM policy kill
rather than a real segfault) at a broadly similar renderer-RSS ceiling,
**with 13–15 GiB of host RAM free throughout in every run** (`free -h`,
sampled continuously) — ruling out host memory pressure as the trigger. This
is the exact "baseline crashed too, with plenty of host RAM free" symptom the
task brief's failed prior attempt reported; this session reproduces it
reliably with a validated harness and localizes it to the renderer process
specifically, but did **not** root-cause it.

Because this growth is large (dwarfing the ~227.6 MiB `instrument()` peak
PR #212 measured in Node), continuous, and present on the **NOMMU** baseline —
which runs no `instrument()` pass at all — it cannot be the softmmu pass, and
it swamps any exec-specific signal a peak-RSS-before-crash number would
otherwise carry. Reporting the raw peak or crash numbers as "the MMU tab needs
~9.5 GB" would misattribute this separate phenomenon to #202; that number is
not reported as such here.

**Unverified hypothesis** (recorded for the next attempt, not claimed as
fact): Playwright's `page.on("console")` listener enables Chromium's
DevTools-protocol `Runtime` domain, which is documented to make V8 retain
extra per-script state for a page's dynamically-compiled objects. This boot
process calls `WebAssembly.compile()` many times over the guest's lifetime
(once per distinct exec'd binary, more under MMU since each is a freshly
instrumented ~2–6× larger module); Runtime-domain retention accumulating
across all of them, unbounded, for as long as DevTools stays attached, would
produce exactly this signature — and would **not** affect a real end-user tab
with no DevTools/CDP attached. This could not be confirmed this session
(Playwright's automation is itself CDP, so a CDP-free control wasn't
available without a different automation approach entirely) and is offered
as the most promising lead for whoever picks this up next, not as a finding.

### Net effect on §7.1's step 0 and §7.4's sequencing

Step 0 is **partially, not fully, closed**. What it resolves: both variants
demonstrably boot and correctly exec `nix.wasm` in a real browser tab, and the
`exec_module_cache` fast-path is confirmed working end-to-end outside Node for
the first time. What it leaves open: the actual question §7.1 was written to
answer — "is a real Chrome tab now comfortable after #212, or is §5.2 (AOT
CAS) still needed" — is **still unanswered**, because the renderer-growth
confound above makes every peak-RSS number from this session's harness
unusable as evidence either way. The next attempt should either (a) root-cause
and eliminate the renderer growth (starting from the DevTools-Runtime-domain
hypothesis above) so a clean peak-RSS reading becomes possible, or (b) measure
peak RSS via a channel that doesn't require CDP at all (e.g. a manual PR
preview click-through with the OS-level `ps` sampling script run alongside,
no Playwright), since CDP attachment is itself now a suspect.

**Session record**: worktree branch `claude/issue-202-browser-mem-measurement`
(off `origin/master` post-#212, commit `1f507bf`); the throwaway probe scripts
(`mem-probe.mjs`, `proxy-serve.mjs`) and raw per-run JSON timelines are not
committed (scratchpad-only, per the task's own instructions) but the exact
buildhashes and methodology above are sufficient to reproduce.
