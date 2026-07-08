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
| 1 — fork/spawn | Track B real `fork()` (#129) | mechanism recovered + engine tested; muslFork re-integration + COW pending (world build) | No — needs muslFork + boot |
| 2 — dlopen | Track C GModule (#130) | **LANDED + BOOT-VERIFIED** (loader + musl 0009 + dynsym seam + libffi codegen; `dlopen-smoke` passes in a booted guest, galculator carries `cb.dynsym`) | Yes — being executed |
| 3 — NOMMU memory | Track A real MMU (#128) | pass done+measured; kernel arch layer pending (world/kernel build) | No — needs CONFIG_MMU=y boot |

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

- [ ] `toolchain/musl.nix` — restore `fork`/`vfork` (drop the symbol-removal
  postPatch). **Couples to** re-integrating PR #20's `muslFork` seam patch
  against master's current musl patch series (0007/0008 differ) — a `--fuzz=0`
  merge on the box.
- [ ] `userspace/ash.nix` + `ash-cb-guest.c` + `patches/busybox/ash/*` — retire
  forkshell ash; stock ash with real fork.
- [ ] `patches/busybox/0001,0003–0007`, fork part of `0008` — revert to stock
  busybox fork.
- [ ] `patches/glib/0001` + `deps-overlay.nix` glib — drop the forced
  `posix_spawn` path + `child_setup` rejection; stock `g_spawn`.
- [ ] `patches/pkg-config/0001` — drop.
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

## DoD

When the box executes slices 1–3 above (each verified by its named smoke) and
checks/keeps every box, the guest is stock-shaped from userspace and #126 is
realized. This audit is the executable checklist; the per-item VERIFY gate is
the proof, not a code read.
