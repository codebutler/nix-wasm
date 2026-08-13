# Cleanup #131 — execution-ready audit (the epic's payoff)

Date: 2026-07-01
Status: Audit + gating. The self-contained/verifiable items are done; the
world-build-gated items are specified exactly here so the box/CI executes them
without re-deriving intent.
Parent: `2026-07-01-software-mmu-asyncify-design.md` (#126), issue #131.

> #131 is the point of the epic — DELETE the NOMMU/no-fork/no-dlopen
> accommodations the three tracks make unnecessary. Its own DoD: "each box
> checked OR explicitly decided 'keep, because <reason not one of the three
> walls>'." Every accommodation is a nix-override / patch / musl / kernel change
> whose correctness is only observable by BUILDING + BOOTING the guest. This
> environment has no nix and cannot fetch the kernel source, so the deletions are
> **specified here to the exact edit** and executed on the box — blindly editing
> the (documented-as-fiddly) glib/gtk3 overrides without a boot to verify would
> be precisely the unverified workaround the PRIME DIRECTIVE forbids.

## Gate status of each slice

| Slice | Gate | Track status | Can execute here? |
|---|---|---|---|
| 1 — fork/spawn | Track B real `fork()` (#129) | **mechanism DONE + BOOT-VERIFIED** (musl/kernel/engine fork+COW; `fork-smoke` passes; the fork guest's `/bin/sh` (hush) is autoconf-capable, host-proven + hard-gated, and the in-guest autotools acceptance gate is now green too — see the 2026-08-13 updates below). Slice-1 *retirement*: the `wasmAsh`-from-fork-profile REVERT is DONE (2026-08-13); the rest (musl fork/vfork restoration, the forkshell-ash accommodation, the busybox fork-patch reverts, the per-package triage, the link-contract relax) has **not started**. | Yes for the first REVERT (executed); the remaining slice-1 REVERTs are each their own world-rebuild-scale edit, now unblocked (the in-guest autotools gate that used to precondition them is green) but not yet executed |
| 2 — dlopen | Track C GModule (#130) | **LANDED + BOOT-VERIFIED** (loader + musl 0009 + dynsym seam + libffi codegen; `dlopen-smoke` passes in a booted guest, galculator carries `cb.dynsym`) | Yes — being executed |
| 3 — NOMMU memory | Track A real MMU (#128) | **mechanism DONE + BOOT-VERIFIED** (both A1 — `.#kernel-mmu`, `mmu-smoke.mjs` — and A2 demand-paging/COW — `.#kernel-mmu-a2`, `mmu-smoke-a2.mjs` — boot and are hard-gated in CI). Slice-3 *retirement* itself (the accommodations below) has **not started**, and each item there still needs its own CONFIG_MMU=y boot to verify per-item, not just the mechanism. | Partially — the CONFIG_MMU=y boot the row used to require now exists and is gated; executing the slice-3 retirement items still needs the box |

## Slice 2 — dlopen accommodations (gated on #130, LANDED)

Track C shipped the general loader (`runtime/dylink.js`), the musl dlopen/dlsym
port (`patches/musl/0009`), the dynsym-inject seam (`userspace/dynsym.nix` +
`scripts/wasm-dynsym-inject.py`), and the runtime libffi codegen
(`runtime/ffi-codegen.js`). So these accommodations can be removed — each is a
nix/patch edit whose PROOF is the `dlopen-smoke.mjs` + GTK smokes on the box:

- [ ] **`deps-overlay.nix` glib — gio modules loadable again.** DEFERRED, low
  value. NOT a meson-flag flip: the guest is `isStatic = true` platform-wide
  (`-Ddefault_library=static` everywhere), so gio's modules build INTO libgio.
  Making them loadable means building each as a PIC `SIDE_MODULE`, installing to
  `GIO_MODULE_DIR`, and shipping the scan — a real per-module packaging effort,
  while the **built-in** modules work fine (the guest is not missing
  functionality). The MECHANISM that made this a wall (no dlopen) is gone —
  proven by `dlopen-smoke` + widget-factory — so this is now purely a
  stock-shapedness cleanup, correctly deprioritized behind Track A (the actual
  remaining value). If pursued: `glib-smoke.mjs` + a booted gio-module load is
  the gate.
- [ ] **`deps-overlay.nix` gtk3 — gdk-pixbuf loadable loaders.** DEFERRED, same
  reasoning: built-in loaders work; loadable loaders are a side-module packaging
  effort (`loaders.cache` + PIC loader modules), not a flag flip, with marginal
  value now that the dlopen wall is gone.
- [x] **`patches/widget-factory/0001` — drop `add_callback_symbol`. DONE +
  BOOT-VERIFIED.** The `--selftest` now resolves its `.ui` handler purely via
  `gtk_builder_connect_signals(NULL)` → `g_module_open(NULL)`/`g_module_symbol` →
  `dlopen(NULL)`/`dlsym`; the build adds dynsym-inject before fpcast + relies on
  `--export-all`. `widget-factory-smoke` PASSES in a booted guest
  (`connected_via_gmodule=1 handler_ran=1`), the binary carries `cb.dynsym`. This
  is the definitive proof the GModule wall is gone. (Mechanism note: `g_module_open(NULL)`/`g_module_symbol` reduce to
  `dlopen(NULL)`/`dlsym`, exactly the path `dlopen-smoke` proves — the old #33
  error was `g_module_open(NULL)` failing because dlopen was stubbed, now real.
  This box is the widget-factory INTEGRATION: it needs the handlers exported
  (`--export-dynamic`) + non-static so dlsym finds them by name — source surgery
  the box does with a boot check.) The patch
  registers each `.ui` handler via `gtk_builder_add_callback_symbol` to dodge
  GModule. With real `dlopen(NULL)`/`dlsym` (musl 0009 + `--export-dynamic`),
  restore plain `gtk_builder_connect_signals(builder, NULL)`. **Requires** the
  widget-factory binary link with `-Wl,--export-dynamic` (so its handlers are in
  the dynamic symbol table the loader searches) + the dynsym-inject pass (so the
  fpcast'd handlers have canonical-thunk elem slots — already the seam from Track
  C). **Verify:** `widget-factory-smoke.mjs` with the workaround removed.
- [ ] **galculator — real window with no workaround.** galculator's 115 `.ui`
  handlers go through `gtk_builder_connect_signals(NULL)` → GModule → the real
  loader now. galculator already dynsym-injects (this PR wired it,
  `deps-overlay.nix`, and its binary now carries `cb.dynsym` — verified on the
  build box). The GModule wall is gone (dlopen boot-verified); the click-to-42 is
  now a browser-VISUAL check (needs a compositor), no longer a mechanism gap.
- [x] **`runtime/kernel-worker.js` — real dlsym.** DONE in this PR: the
  `__wasm_dl_probe`/`__wasm_dlopen`/`__wasm_dlsym` host imports + the
  `DynamicLoader` back them; musl 0009 DEFINES `__dlsym_time64` as a real
  function. The old `__dlsym_time64: () => 0` env stub is now **vestigial** (no
  new-musl binary imports it) but is KEPT until the coordinated musl rebuild
  ships — removing it now would break instantiation of any not-yet-rebuilt binary
  that still carries the weak-undef import. Remove the stub + its allow-list entry
  in the SAME commit that lands the musl 0009 world rebuild. ENGINE_ABI bumped to
  8; `sync-to-pc.sh` on the pc side per the runbook.

## Slice 1 — fork/spawn accommodations (gated on #129 real fork + COW)

Each is a REVERT of a fork-removal accommodation, safe only once a real package
forks through the seam (`toolchain/wasm-fork-stdenv.nix`) AND COW (Track A2)
makes it cheap. Specified for the box:

**Status update (2026-08-13):** the fork *mechanism* (musl's `fork = true`
variant, the kernel's software-MMU COW, the engine's `capture_stack`/
`run_user_entry` fork loop) is DONE and boot-verified (`fork-smoke.mjs`,
gated — see `docs/process-model.md`'s 2026-08-13 update and the "Track B"
entry in `CLAUDE.md`). Two more pieces of groundwork have also landed since
this audit was written, both narrowly scoped and **not** a start on the
checklist below: (1) the fork guest's `/bin/sh` — **stock busybox hush**, not
stock ash (ash was tried and found blocked by an orthogonal `longjmp` bug,
nix-wasm#188, so the plan below's "stock ash with real fork" item is
superseded — hush is the shell autoconf is validated against on this guest)
— is now autoconf-capable: three independent, previously-unfixed-upstream
hush bugs are fixed (`patches/busybox/0009`–`0011`) and HARD-GATED on the
host, hermetically, by `.#autotools-fixture-hush-check` (including a
sabotaged-compiler negative case). (2) `userspace/busybox-fork.nix`'s
post-link build now runs `scripts/wasm-check-imports.py` against the shared
generated allow-list, the same import-contract discipline the NOMMU build
already had, so a stray `env.*` import in the fork initramfs fails the build
loudly instead of shipping silently. **Neither of these is a slice-1
checklist item** — they make the fork guest's shell layer trustworthy, they
do not revert any `posix_spawn`-only accommodation.

**UPDATE (2026-08-13, same day, later commit): the IN-GUEST autotools proof
gate that used to hold every REVERT box below UNCHECKED is now GREEN.**
Issue #192 (the kernel exec-image-buffer fragmentation bug that killed
`configure`'s conftest compiles around the 6th large exec) is fixed
(PR #199, `patches/kernel/0030`); `autotools-fork-smoke.mjs` recorded its
first green CFGRC (workflow run 31697211801) and is now a `run_smoke` hard
gate in `nix-wasm.yml`'s `nix-boot-smoke-mmu` `core` shard — see CLAUDE.md
and `docs/superpowers/notes/2026-08-05-mmu-phase1-parity-plan.md`'s
"Real-fork autotools proof" item. This unblocks slice-1 REVERTs whose
correctness that gate was standing in for. The FIRST one has been executed
in this same change — see the `wasmAsh`-from-fork-profile box above, now
checked. The remaining REVERT boxes below (musl fork/vfork restoration,
the forkshell-ash accommodation itself, the busybox fork-patch reverts, the
per-package fork triage, the link-contract relax) are each their own
world-rebuild-scale edit and are each still UNSTARTED — this gate going
green does not itself execute them, it only removes the precondition that
was blocking their execution. Per this audit's own DoD ("each box checked
OR explicitly decided 'keep, because <reason>'"), a **KEEP-with-reason**
disposition is a valid closure on its own terms independent of this gate:
two items originally on this list were adjudicated KEEP on 2026-08-13
(codebutler/nix-wasm#131 comment
[5278756088](https://github.com/codebutler/nix-wasm/issues/131#issuecomment-5278756088))
and moved to "Explicitly KEPT" below instead of staying REVERT checkboxes
here.

- [ ] `toolchain/musl.nix` — restore `fork`/`vfork` (drop the symbol-removal
  postPatch). **Couples to** re-integrating PR #20's `muslFork` seam patch
  against master's current musl patch series (0007/0008 differ) — a `--fuzz=0`
  merge on the box. (NOTE: `.#musl-fork` already exists and builds today as
  the CI-gated MMU variant's musl — this item is about promoting it to the
  flake's *default* `musl` attr, not building it for the first time.)
- [x] **`flake.nix` `wasmSystemFork` — drop `wasmAsh` from the fork profile's
  `toolchain` list. DONE + BOOT-VERIFIED (2026-08-13).** The narrow,
  closure-weight-only sub-piece of the box below: `wasmSystemFork`'s
  `toolchain` was `[ nixWasmForkClean wasmAsh ]` even though hush, not ash,
  is `/bin/sh` on the fork guest — `bootstrap.nix`'s forkshell-ash `/bin/sh`
  promotion is unconditionally skipped in forkMode
  (`pkgs.lib.optionalString (!forkMode) ...`), and nothing in the fork boot
  path (`userspace/busybox-fork.nix`'s stock hush applet, `initramfsExtraBins`,
  the fork bootstrap script) references `ash`/`wasmAsh` — it rode along in
  `environment.systemPackages` as pure unused closure weight. Changed to
  `toolchain = [ nixWasmForkClean ]`. Gate green as of workflow run
  31697211801 (`nix-boot-smoke-mmu` `core`, the same run that first recorded
  a green autotools CFGRC — the run that most directly exercises this
  profile's `/bin/sh`). Verified fork-profile-only: `wasmSystem` (NOMMU,
  `flake.nix` line ~609) and the `guest-ash` flake output (line ~923, a
  standalone `nix build .#guest-ash` package attr, not wired into any system)
  are BOTH untouched — forkshell ash remains the NOMMU guest's `/bin/sh`.
  `nix path-info --derivation` confirms `.#wasm-initramfs`/
  `.#wasm-base-squashfs` (NOMMU) are unaffected by this edit while
  `.#wasm-initramfs-fork`/`.#wasm-base-squashfs-fork` change (the closure
  shrinks by the ash package + its unique deps). This is a REVERT of the
  narrowest possible slice of the item below — it does not touch
  `userspace/ash.nix`/`ash-cb-guest.c`/`patches/busybox/ash/*` themselves,
  which remain load-bearing for NOMMU and are unstarted work, tracked
  separately in the next box.
- [ ] `userspace/ash.nix` + `ash-cb-guest.c` + `patches/busybox/ash/*` — drop
  the forkshell-ash accommodation ENTIRELY (i.e. retire it as a NOMMU
  accommodation too, once #131 slice 1 flips the default guest off NOMMU).
  **Superseded direction (see status update above):** stock ash is blocked by
  nix-wasm#188 (musl `longjmp` is an `abort()` stub, unrelated to fork), so
  the guest's post-retirement `/bin/sh` is stock hush (already promoted on
  the `-fork` variant today), not stock ash as this item originally
  specified. The narrow `wasmAsh`-from-fork-profile sub-piece this item used
  to also describe is DONE — see the box immediately above; this box is now
  scoped to the NOMMU-only forkshell-ash accommodation itself, unstarted.
- [ ] `patches/busybox/0001,0003–0007`, fork part of `0008` — revert to stock
  busybox fork.
- [x] `patches/glib/0001` + `deps-overlay.nix` glib — **KEEP** (moved to
  "Explicitly KEPT" below; see the 2026-08-13 disposition).
- [x] `patches/pkg-config/0001` — **KEEP** (moved to "Explicitly KEPT" below;
  see the 2026-08-13 disposition).
- [ ] `deps-overlay.nix` per-package fork triage — re-enable openssl CLI, pcre2
  callout-fork, ncurses test-demos, busybox IFUP/IFDOWN/TELNETD.
- [ ] `toolchain/wasm-host-imports.nix` + `.#nofork-linkcheck` — relax the
  fork-absent link contract (fork is no longer forbidden).
- [ ] Rewrite `docs/process-model.md`.
- [ ] Unblocks **#93** (s6 no longer needs fork→posix_spawn).

## Slice 3 — non-Wayland NOMMU-memory accommodations (gated on #128 real MMU)

Gated on the CONFIG_MMU=y kernel arch layer
(`2026-07-01-softmmu-kernel-design.md`). Specified for the box:

- [ ] `toolchain/musl.nix` — `posix_fallocate` emulation + `patches/musl/0008`
  `__unmapself` no-stack-switch — revisit under real VM (both may become
  unnecessary or change shape).
- [ ] `patches/kernel/0016` (RO-shared-mmap copy), `0022` (ramfs-regrow-shared-
  mmap), `0025` (file-mmap eager bounce) — demand-paged/COW mmap replaces these.
- [ ] `kernel.nix` — `CONFIG_BOOT_MEM_PAGES` / `CONFIG_ARCH_FORCE_MAX_ORDER`
  contiguous-alloc bumps + `patches/kernel/0007` (4 MiB user stack) — real VM
  removes the contiguous-alloc pressure (paging replaces contiguity).
- [ ] `nix-wasm.nix`/`deps-overlay.nix` sqlite `-DSQLITE_OMIT_WAL` (+
  `THREADSAFE=0`) — WAL's `-shm` mmap works under real VM.
- [ ] ramfs-mandatory-for-shared-mmap assumptions (`bootstrap.nix` `/dev/shm`, 9P
  `cache=loose`) — revisit.

## Explicitly KEPT (orthogonal to the three walls — do NOT remove)

Per #131's own list, unchanged by this epic:
- `--fpcast-emu` (strict `call_indirect` signature casts — not fork/dlopen/MMU).
  NOTE: this epic makes fpcast MORE load-bearing (the dynsym-inject seam + the
  runtime FFI canonical path both depend on the canonical-thunk ABI), so it is
  firmly a keeper.
- The `__lsan_*` weak-undef loader stubs.
- The crt weak 2-arg `main` wrapper, the wasm-ld ELF-flag filter,
  `-fvisibility=hidden`, the libffi raw backend's STATIC fast path (the runtime
  codegen is a FALLBACK, not a replacement), etc. — general wasm-target link
  plumbing.

**Slice-1 items adjudicated KEEP, not REVERT (2026-08-13, codebutler/nix-wasm#131
comment [5278756088](https://github.com/codebutler/nix-wasm/issues/131#issuecomment-5278756088)),
per this audit's DoD — "each box checked OR explicitly decided 'keep, because
<reason not one of the three walls>'":**
- **`patches/glib/0001-posix-spawn-only-wasm-nommu.patch` + the glib override —
  KEEP.** Dropping it on the fork guest would recompile glib's raw fork/exec
  branch into `libglib` for EVERY GTK app, and none of those binaries is
  asyncified — so the failure mode moves from today's clean `GError`
  ("child_setup … not supported") to a `TypeError` out of `capture_stack`.
  Stock glib's spawn takes the same `posix_spawn` fast path the patch forces
  anyway, so keeping it costs no capability. Revisit only if a guest consumer
  actually needs `child_setup`/`envp`-PATH semantics. Caveat: no CI gate
  currently exercises `g_spawn` on either guest, so a future retirement
  attempt would need to add that coverage first.
- **`patches/pkg-config/0001-bundled-glib-no-fork-wasm-nommu.patch` — KEEP.**
  pkg-config is a build-time tool whose bundled-glib fork path is dead code on
  our builds (`deps-overlay.nix`'s `pkg-config-unwrapped` override). Zero
  guest-visible benefit to retiring, and dropping it would force a shared
  rebuild of every meson/autoconf consumer in the `cross.*` world for nothing.

## DoD

When the box executes slices 1–3 above (each verified by its named smoke) and
checks/keeps every box, the guest is stock-shaped from userspace and #126 is
realized. This audit is the executable checklist; the per-item VERIFY gate is
the proof, not a code read.
