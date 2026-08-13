# MMU ship plan — Phase 1 parity → Phase 4 cleanup

Date: 2026-08-05
Status: Plan (reviewed). Phase 1's CI/preview wiring is landed (this repo
state); Phases 2-4 are not started — each is gated on the previous one's boot
proof, per the PRIME DIRECTIVE ("don't do the easy slice and call it done").
Parent: `2026-07-01-software-mmu-asyncify-design.md` (#126 epic),
`2026-07-01-cleanup-131-audit.md` (#131 slice audit),
`2026-07-01-track-b-fork-seam-status.md` (#129 Track B mechanism), issue #11.

> One-line thesis: the software-MMU + real-`fork()` guest
> (`.#kernel-mmu-a2` + `.#wasm-initramfs-fork` + `.#wasm-base-squashfs-fork`)
> already BOOTS the full nix system and is CI-gated in parallel with the
> shipped NOMMU guest. This plan is the four-phase path from "parallel-boot,
> not shipped" to "the guest is stock-shaped MMU Linux and #126 is realized" —
> parity proof, then default-flip the userspace, then flip what pc actually
> downloads, then delete the accommodations the flip made dead.

---

## Phase 1 — parity proof (CI + preview only; no default changes)

Goal: prove the MMU/fork variant reaches everywhere the shipped NOMMU guest
reaches, using the existing `-mmu`/`-fork`-suffixed flake attrs exclusively.
Nothing in this phase touches `.#linux-image`, `.#kernel`, `.#nix-wasm`, or any
attr pc/CI treats as the default — it is purely additive coverage, so it
carries **no `ENGINE_ABI` bump** (`.#kernel-mmu-a2` and its ABI-10/11/12
surface already exist; Phase 1 only widens what boots on top of it).

### Landed

- **`boot-smoke`'s `mmu-devices` shard** (`nix-wasm.yml`) — the SAME
  async-signal + virtio-device regression set the NOMMU `signals` shard runs
  (sigalrm/kill-wake/timeout-repro/ping-pace/vsock-ctl/resize/snd/clock/
  exec-reject/blk-rw), re-booted busybox-only on `.#kernel-mmu-a2` +
  `.#wasm-initramfs-fork`. This is explicitly the issue-#11 verification
  substrate: "virtio ring buffers read/write guest memory through the checked
  walk too" is a general obligation, not a per-device one, and every one of
  those smokes was diagnosed and fixed against NOMMU only (#75's entry.S
  FOOT-loop manipulates pt_regs/kernel SP directly; #168's page-crossing
  corruption class shows a per-access translate CAN silently break a
  raw-address mechanism). `exec-reject-smoke` is the one smoke in this shard
  whose *outcome* differs by design — this is the first kernel where the
  softmmu pass can actually REFUSE an image (NOMMU's `signals` shard only
  proves the conforming-twin/no-panic assertions, not the rejection itself).
  **Gating split — PROMOTED (#131 soak-flip):** all ten smokes in this shard
  (sigalrm/kill-wake/timeout-repro/ping-pace/vsock-ctl/resize/snd/clock/
  exec-reject/blk-rw) recorded first-attempt greens in PR #184's first soak
  cycle (whole shard ~2.5 min, no panic-retries) and are `run_smoke` HARD
  GATES since; `ping-pace-probe` stays the permanently-non-gating diagnostic.
  (History: they shipped soak-first because a first-ever boot must record an
  in-tree CI green before it can gate — an earlier draft gated sigalrm/clock
  on a local Node-harness green, corrected in review; the promotion followed
  one cycle later, per the rule.)
- **`nix-boot-smoke-mmu`'s `gtk` shard** (`nix-wasm.yml`, closing out the PR
  #172 "GTK set follows" promise) — the full one-per-boot GTK smoke set
  (`gtk-smoke`, `galculator-smoke`, `widget-factory-smoke`, `gtk-demo-smoke`,
  `gcalctool-smoke`, `l3afpad-smoke`), unmodified, booted on the full nix
  system over `.#kernel-mmu-a2` + `.#wasm-initramfs-fork` +
  `.#wasm-base-squashfs-fork`. Mirrors NOMMU's `nix-boot-smoke` `[core, gtk]`
  split verbatim (same shard boundary, same one-per-fresh-boot isolation
  rationale — batching ~14 MB GTK inits fragments the heap). `core` was
  extended in the same change to run every non-GTK NOMMU smoke this job was
  missing — `profile-install-e2e`, `wrapperless-cc-e2e`, and `rsvg-smoke`.
  `exec-reject-smoke` is deliberately NOT one of them: it boots nix:false
  internally (no squashfs/nix-cache dependency), and `boot-smoke`'s
  `mmu-devices` shard above already boots it on the identical kernel+
  initramfs pair for far less cost — that shard is what the stale "the MMU
  job below runs this" comment on the NOMMU job's own `exec-reject-smoke` line
  now names directly, closing it out without adding a duplicate boot here.
  **Gating split — FULLY PROMOTED (#131 soak-flip):** `core` hard-gates
  all six of its smokes (`smoke.mjs`/`build-from-source-e2e`/`selftests-batch`
  since the core-only predecessor; `profile-install-e2e`/`wrapperless-cc-e2e`/
  `rsvg-smoke` promoted on PR #184's recorded greens), and `gtk` hard-gates
  all six. The last to promote was `widget-factory-smoke` — the first soak
  cycle's one REAL finding: GModule autoconnect resolves `.ui` handlers BY
  NAME via dlsym, and the ABI-8 dl host surface read its user pointers RAW
  (untranslated) under the MMU — garbage name, "Could not find signal
  handler". NOT a missing dynsym seam (widget-factory has one; galculator's
  selftest never calls `connect_signals`, which is why it passed). Fixed
  engine-side (`runtime/mmu-uaccess.js` host soft-uaccess + the dl imports in
  `kernel-worker.js`; side modules/ffi trampolines refused loudly pending
  nix-wasm#185); PR #186's soak recorded the post-fix CI green and it took
  the last promotion — `gtk` hard-gates all six. See this job's SOAK NOTE
  and the (closed) soak-flip checkbox in Remaining below.
- **MMU browser preview variant** (`pr-preview.yml` + `runtime/demo/web/
  main.js`) — every same-repo PR preview now publishes a SECOND artifact set
  (`.#kernel-mmu-a2` + `.#wasm-initramfs-fork` + `.#wasm-base-squashfs-fork`)
  into its own content-addressed `cas/<hash>/` prefix, recorded in
  `preview.json`'s `variants.mmu.artifactsBase`. `main.js` reads a
  `?variant=` query param and resolves it against that map (falling back to
  the per-variant `./artifacts-<name>/` symlink convention for local dev, and
  throwing rather than silently booting the default guest under a URL that
  claims otherwise). Open a PR preview at `…/demo/web/?variant=mmu` to get a
  REAL browser boot of the MMU/fork guest — this is the first time a human can
  eyeball the MMU guest without a local box build. The MMU build step carries
  BOTH `continue-on-error` (bounds an MMU-specific build *failure* — never
  fails the job) AND its own `timeout-minutes: 60` (bounds *wall clock*,
  matched by a +60 min allowance on the job's own `timeout-minutes`) — a
  cold-cache-forced from-source LLVM/kernel rebuild self-terminates as a
  (caught) step failure instead of running the job past its budget.
  `continue-on-error` alone does NOT cover this: a job-level `timeout-minutes`
  cancellation tears down the whole job — including the "Comment preview
  link" step — regardless of any step's `continue-on-error` (an earlier
  draft of this plan + the workflow's own comments claimed otherwise; see the
  step-level comment in `pr-preview.yml` for the corrected reasoning). With
  both in place, a cold-cache or MMU-specific break never blocks the default
  (NOMMU) preview or its PR comment; the comment reports the MMU variant's
  outcome as its own sub-line.

### Remaining

- [ ] **Real-fork autotools proof — SHELL HALF NOW FULLY CLOSED (2026-08-13),
  compiler/#192 half still open: blocked by a kernel exec-fragmentation bug,
  not by the shell.** CLAUDE.md's "In-guest autotools also works" milestone
  (`./configure && make && ./prog`) is proven only on the shipped NOMMU guest,
  through **forkshell ash** — four patches + six postPatch fixes
  (`userspace/ash.nix`, `patches/busybox/ash/*`) that exist ONLY to fake
  autoconf's `$()`/subshell/pipeline/heredoc machinery WITHOUT real `fork()`.
  (Note: that milestone has never been automated on ANY guest — it was a hand-run
  session recorded in the since-deleted `docs/STATUS.md`; `runtime/demo/node/`
  still has no autotools script.) This item asked for a stock-ash-over-`muslFork`
  build to prove real fork makes those tricks unnecessary. **Booting it answered
  the question differently, in two ways — both measured on `.#kernel-mmu-a2` +
  a fork initramfs:**
  1. **Stock ash is BLOCKED, and not by fork — by `longjmp` (nix-wasm#188).**
     Stock ash was built and booted (`CONFIG_ASH`/`SH_IS_ASH` in
     `busybox-fork.nix`, config mirroring `ash.nix`); `/bin/sh` was genuinely
     ash. But the wasm musl's `longjmp` is an `abort()` stub
     (`patches/musl/0000-harness-wasm-arch.patch` → `src/setjmp/wasm/longjmp.S`,
     comment: "we have to abort, let's just hope that never happens"), and ash
     unwinds through `setjmp`/`longjmp` on its NORMAL path. Every forked child
     therefore aborts on completion: `x=$(exit 3); echo $?` → **134**,
     `(exit 5)` → **134**, `if (exit 0)` takes the **else** branch. stdout is
     still correct (the child writes before aborting), so it looks fine and every
     exit status is garbage — fatal for autoconf. `fork()` itself is healthy
     (`fork-smoke` propagates `status=0x7`); job control was ruled out. The ash
     switch was REVERTED; #188 carries the diagnosis and fix directions.
  2. **Stock hush handles every LITERAL-fd autoconf idiom tested — but that
     matrix was too narrow, and the "not POSIX-enough claim does not hold"
     conclusion below does NOT hold, corrected 2026-08-12.**
     `bootstrap.nix:232-242` says hush "dies with 'ambiguous
     redirect' / 'syntax error at fi'", which is why NOMMU promotes forkshell
     ash. That is true of the *NOMMU* hush, which carries
     the NOMMU clone-spawn conversions of its pipeline, `$()` and heredoc paths
     (`0001-wasm-arch-and-clone-spawn.patch`'s `shell/hush.c` hunk —
     `run_pipe_child` — plus `0003-hush-cmdsub-clone` and
     `0006-hush-heredoc-clone`; `0005` is `archival/tar.c`, unrelated to the
     shell); the fork busybox drops all of them and is stock. Measured on the fork
     guest: **0 aborts**, `$(exit 3)`→3, `(exit 5)`→5, `if (exit 0)`→then,
     external true/false→0/1, and every autoconf idiom in the matrix clean — the
     fd-5 logging block (`{ …; echo >&5; } >out 2>&1`, a LITERAL `>&5`, the exact
     "ambiguous redirect" case as originally reproduced), `as_fn_*` functions +
     `test` chains, `$( ( … ) || … )`, heredoc into
     `conftest.c`, case/esac + eval, backticks, `trap … EXIT`, and multi-line
     if/fi (the exact "syntax error at fi" case).
     **CORRECTION (2026-08-12, from the toolchain-half work below): this matrix
     tested only LITERAL fds. A REAL autoconf-generated `configure`'s own
     `as_fn_error` diagnostic helper redirects to a VARIABLE fd instead
     (`>&$4` — the fd number is a shell variable), which hush's parser does
     NOT accept — reproducing the identical "ambiguous redirect"/"syntax
     error at 'fi'" signature this item's matrix believed it had cleared.
     Confirmed two ways: a real generated `configure`
     (`userspace/autotools-fixture.nix`) hits it in its own preamble under
     stock busybox hush, hermetically, on the HOST
     (`userspace/autotools-fixture-hush-check.nix`, at the time an
     on-demand `nix build .#autotools-fixture-hush-check` reproduction —
     since flipped to a hard gate, see the UPDATE immediately below); the
     same `configure`'s in-guest run (`autotools-fork-smoke.mjs`, below)
     fails its CFGRC step with the same signature.
  **UPDATE (same change): the hush-parser patch has landed** —
  `patches/busybox/0009-hush-variable-fd-redirect.patch` +
  `0010-hush-internally-opened-fd0.patch` (the second an independent,
  still-unfixed-upstream `<&0` bug found while verifying the first against a
  real `configure`), wired into `busybox-fork.nix` (and `busybox.nix`/
  `ash.nix`). The host-side, hermetic proof —
  `.#autotools-fixture-hush-check`, now a HARD gate — confirms the full
  `configure`/`config.status`/`make`/`./prog` chain succeeds under exactly
  this hush. **Phase 2 still cannot mark forkshell-ash retirement DONE from
  this checklist item alone**, though: that needs the IN-GUEST
  `autotools-fork-smoke.mjs` soak (below) to record its own green CFGRC on
  the real MMU/fork guest — the host-side proof shows the hush.c fix is
  correct, not that the booted guest's full toolchain path (9P staging,
  in-guest cc/make) exercises it cleanly too. **What was added** is the toolchain half: a
  real `./configure && make && ./prog` needs `cc` + `make` in-guest, which are
  substituted from `.#wasm-binary-cache` (~6.9 GB — it carries `.drv` build
  sources), so the round-trip is a CI-scale run, not a laptop one.
  `demo/node/autotools-fork-smoke.mjs` (nix:true boot on the fork squashfs,
  `nix-env -iA wasm-tools.{guest-cc,make-wasm32}`, then `./configure && make &&
  ./prog` against a small autoconf'd C fixture staged over 9P and copied to
  ramfs — the 9P-write-failure lesson from the original STATUS.md session) is
  now added to the `nix-boot-smoke-mmu` `core` shard, soak-first per the
  promotion rule — its CFGRC step is now expected GREEN (the hush-parser
  patch above landed in this same change): this soak run is a genuine
  first-boot CONFIRMATION, not a reproduction of a known gap. Promote it to
  a `run_smoke` call in the hard-gates step once that green is on record,
  same as every other soak in this job.
  **UPDATE (2026-08-13): the "expected GREEN" call above was wrong, for a
  reason the shell fixes could not have prevented — the SHELL half is
  fully closed, but the soak still cannot promote.** The first in-guest
  soak run (#193) found a THIRD hush bug (EXIT-trap bare-`exit`/`$?` status
  resumption), now fixed by `patches/busybox/0011-hush-exit-trap-status.patch`
  and pinned by a hard NEGATIVE case in `.#autotools-fixture-hush-check`
  (a sabotaged always-failing compiler, asserted to exit exactly 77) — landed
  and merged via PR #197. (This note's own update recording that fact is a
  later, separate commit — it did not land in #197 itself.) With all three hush
  fixes (0009/0010/0011) in place, `.#autotools-fixture-hush-check` proves
  the ENTIRE `configure`/`config.status`/`make`/`./prog` chain, including
  its EXIT-trap error path, hermetically and reproducibly on the host. The
  shell half of this item is therefore CLOSED: there is no more known hush
  defect standing between autoconf and this guest's `/bin/sh`. But the
  IN-GUEST `autotools-fork-smoke.mjs` soak still cannot record a green
  `CFGRC` — its blocker is now issue **#192**, an unrelated kernel bug: `fs/
  binfmt_wasm.c` loads each exec'd module into one contiguous kernel
  allocation, and repeated large execs (clang's driver+cc1 pair, compiling
  `conftest.c` over and over during `configure`) fragment the NOMMU-style
  buddy heap and fail around the 6th large exec with `page allocation
  failure: order:14`. The CONFIG_COMPACTION hypothesis for this was
  EMPIRICALLY REFUTED (it is already `=y` once `CONFIG_MMU=y`, via Kconfig
  default-y propagation — reproduced directly against the real
  kernel-llvm-tools configurePhase); the fixture `configure`'s own run is
  itself a real-world data point for #192, not just a synthetic repro. Fix
  direction on #192 is a per-inode exec image-buffer cache — a kernel
  workstream, queued, not started. Net effect: with 0011, the soak's
  `CFGRC` now fails *honestly* (a genuine nonzero status once a conftest
  compile dies to #192) instead of the pre-0011 failure mode where a masked
  EXIT-trap bug could silently report `CFGRC=0` on a run that had actually
  died fatally — but it still fails, so **this checkbox stays OPEN and the
  soak stays a soak** (do NOT promote to `run_smoke`) until #192 is fixed
  and a green CFGRC is on record. Full record: `docs/process-model.md`'s
  2026-08-13 update, and the "hush can't run a real autoconf `configure`"
  learnings entry + the #192 references in the root `CLAUDE.md`.
- [ ] **#11's Wayland/`wl_shm` half (close-out items 2/3/5) — no MMU compositor
  boot exists yet.** The Landed `mmu-devices` shard above proves #11 item 1
  (vring/pfn addressing is untouched by CONFIG_MMU=y — the kernel stays
  identity-mapped; see the close-out map below), but `nix-boot-smoke-mmu`'s
  `gtk` shard does NOT reach the user-mapping half of #11: virtio_wl's per-vfd
  anon inode, `_resolveShmFd`'s pfn→host-offset `Uint8Array` view
  (`runtime/virtio/wl-device.js`), and waylandproxyd's mmap+copy resync are
  exercised only when a real `wl_shm` pool is allocated — and every smoke in
  that shard runs the display-free `--selftest` path (`gtk_init_check`
  returns FALSE with no compositor in the node harness, so `wl_shm_pool`
  creation never happens; see the M3b entry in CLAUDE.md). The MMU
  browser-preview variant (`?variant=mmu`, Landed above) makes a MANUAL check
  possible for the first time, but nothing GATES it in CI. Close this by
  either promoting a `?variant=mmu` Playwright boot to a CI gate, or adding a
  dedicated wl-text/sommelier smoke on `.#kernel-mmu-a2` + the fork squashfs
  that actually allocates a `wl_shm` buffer. Until this lands, the ticket
  close-out map's #11 entry (below) can only claim item 1, not the ticket as a
  whole — do not close #11 on the `gtk` shard's evidence alone.
- [x] **(DONE, 19/19) Move every soak-step `check` call up to the hard-gates
  step's `run_smoke` once it has a green run on record.** PR #184's first
  soak cycle recorded first-attempt greens for 18 of the 19 soak invocations
  (all ten `mmu-devices` smokes, `core`'s three new e2es, five of six `gtk`
  smokes), each a `run_smoke` hard gate since. (`ping-pace-probe`, the
  20th invocation, is permanently non-gating by design — the `signals`
  shard's own diagnostic breakdown, never part of this move.) The 19th,
  `widget-factory-smoke`, failed its first cycle for a REAL cause — the
  ABI-8 dl host surface reading user pointers untranslated under the MMU
  (see the Landed section's gating-split note; engine fix
  `runtime/mmu-uaccess.js` in PR #186, remainder tracked in nix-wasm#185) —
  exactly the "some may need a real fix first, not just a move" case this
  checkbox anticipated. PR #186's soak recorded its post-fix CI green and it
  took the last promotion; no soak step remains from THIS promotion cycle
  (the autotools acceptance soak added later, below, is a separate item that
  postdates this 19/19 flip and is deliberately not one of the 19 — see its
  own 2026-08-13 update).

Phase 1's CI wiring is now, completely, the regression net Phase 2's risky
world rebuild runs against continuously: a regression on any of the 19
promoted paths turns the JOB red. Of Phase 2's preconditions only the
autotools proof above remains (the wl_shm/#11 gap is orthogonal to Phase 2's
fork-default flip and does not block it — it only blocks closing #11 in
full).

---

## Phase 2 — #131 slice-1 default-flip (a world rebuild, batched)

Goal: make `fork()` the default spawn contract instead of a per-binary
`forkStdenv` opt-in — i.e. **promote today's `-fork`-suffixed parallel build
into the only build**, retiring the `posix_spawn`-only/NOMMU-era accommodation
layer wholesale. This is `docs/superpowers/specs/2026-07-01-cleanup-131-audit.md`
slice 1, executed.

**Load-bearing constraint, stated explicitly because it determines the
ordering below:** real `fork()` needs the child to get an isolated,
COW-diverging address space — that is not an optimization the MMU adds on
top, it is the correctness precondition (`docs/process-model.md`'s "measured
dead-ends" section: fork needs *both* multi-shot control, which the asyncify
seam supplies, *and* a same-address child copy, which only the software-MMU's
per-process page table + COW can give safely on a single shared
`WebAssembly.Memory`). So a default-musl binary that calls real `fork()`
**must run on a CONFIG_MMU=y kernel** — running it on the shipped NOMMU kernel
would not merely be slow, it would corrupt the parent's live memory (no
isolation exists there at all). Phase 2's rebuilt world is therefore validated
EXCLUSIVELY against `.#kernel-mmu-a2` (the existing MMU CI jobs from Phase 1),
and must NOT be promoted to `.#linux-image` in the same change — that
promotion, with its mandatory `ENGINE_ABI` bump, is Phase 3. Phase 2 is "the
world compiles and boots correctly against the MMU kernel under its `.#`
attrs"; Phase 3 is "pc downloads this by default."

### The batched edit set (per the #131 slice-1 audit)

(`docs/superpowers/specs/2026-07-01-cleanup-131-audit.md`)

1. **`toolchain/musl.nix`** — the default `musl` derivation (currently
   `fork = false`, symbols removed) is REPLACED by today's `muslFork`
   settings (`fork = true`, patch 0010 applied) as the flake's default `musl`
   attr consumed by `wasm-cross.nix`. This is a **shared-crossSystem fix**
   (PRIME DIRECTIVE corollary 1) — `musl` is a single override point every
   `cross.*` package and `nix.wasm` build against, exactly like the
   `isStatic`/`hasSharedLibraries` platform flags — so flipping it forces a
   **full world rebuild**, not an incremental one. `.#musl-fork` already
   exists and builds today; this step is a promotion + a `--fuzz=0`
   re-verification that patch 0010 still applies against master's current
   0007/0008 series (they may have drifted since the `-fork` variant was last
   rebuilt), not a from-scratch port.
2. **`toolchain/wasm-host-imports.nix`** — add `capture_stack` to the
   allow-list. It is DELIBERATELY absent today (the file's own header comment:
   "Add capture_stack here in the PR that ships the first REAL fork package
   through forkStdenv — a deliberate, CI-planned world rebuild") precisely
   because adding it changes the file's store path, which is baked into
   `wasm-cross.nix`'s cc-wrapper — i.e. it ALREADY forces the same full
   `cross.*` rebuild step 1 forces, so land both in the same commit rather
   than paying the rebuild twice.
3. **`userspace/ash.nix` + `ash-cb-guest.c` + `patches/busybox/ash/*`** —
   retire the forkshell hacks; build stock upstream ash against the new
   default (fork-capable) musl/busybox, still promoted to `/bin/sh` in
   `bootstrap.nix` (matching NOMMU's promotion, not the fork variant's current
   hush default — ash is the shell autoconf was validated against).
4. **`patches/busybox/0001,0003-0007` + the fork half of `0008`** — revert to
   stock busybox fork; `userspace/busybox-fork.nix`'s CONFIG_NOMMU=n / stock
   `fork()`+exec recipe becomes `userspace/busybox.nix` (no more parallel
   `-fork` derivation once there is only one shape). This also restores
   IFUP/IFDOWN/TELNETD for free, not as a separate edit: `busybox-fork.nix`
   never applies the applet-disabling `sed` carve-out `userspace/busybox.nix`
   (lines 118-141) uses to turn those three off (they `vfork` — rule 1 in
   `docs/process-model.md`) — `wasm_defconfig` ships them `CONFIG_IFUP=y`/
   `CONFIG_IFDOWN=y`/`CONFIG_TELNETD=y` and nothing in `busybox-fork.nix`
   overrides that, so promoting it as the sole recipe re-enables them by
   construction. VERIFY that stays true (grep the built `.config` for those
   three `=y` lines) rather than assuming it.
5. **`patches/glib/0001` + `deps-overlay.nix` glib override** — drop the
   forced `posix_spawn` path and the `child_setup`-rejection `GError`; restore
   stock `g_spawn` (real fork/exec branch).
6. **`patches/pkg-config/0001`** — drop.
7. **`deps-overlay.nix` per-package fork triage** — re-enable the openssl CLI
   (`no-apps` → drop), pcre2's `--disable-pcre2grep-callout-fork` → drop,
   ncurses `test/` demos. (busybox's IFUP/IFDOWN/TELNETD move with the busybox
   derivation itself — see item 4 above, not here; there is no
   `deps-overlay.nix` entry for them.) Each was disabled ONLY because it
   forked (rule 1 in `docs/process-model.md`); with fork restored there is no
   reason left to carve them out.
8. **`.#nofork-linkcheck`** (`spikes/nofork/`) — the probe's PINNED contract
   flips from `fork=ABSENT / spawn=LINKED` to `fork=LINKED / spawn=LINKED`.
   Keep the probe (it is still a useful regression sentinel — "fork did not
   silently vanish again" — not a dead check), just invert its assertion and
   rename if the `nofork-` prefix becomes misleading.
9. **Rewrite `docs/process-model.md`.** The whole document is framed around
   "`posix_spawn`-only by default, fork as a per-binary opt-in" — that framing
   inverts. Keep, rather than delete, the "measured dead-ends" section
   (per-process `WebAssembly.Memory` caps at ~124/tab; the two-wall analysis
   of why real fork needed both multi-shot control AND COW) as the historical
   record of WHY the old contract existed and what changed it — a reader six
   months from now needs to know Track A's COW is what resolved the second
   wall, not that the wall was never real. The busybox/ash/glib patch
   inventory (already retired by this phase) becomes historical too; keep it
   dated rather than deleting the section outright, per this repo's practice
   of recording *why* elsewhere (`kernel-worker.js` `__lsan_*` note, the
   virtio-enum-drift note) rather than only recording current state.
10. **Unblocks #93** — s6 no longer needs a fork→`posix_spawn` port; it can
    build against stock upstream fork/exec.

### Validation

**Precondition — SATISFIED:** the Phase-1 Remaining checklist's soak-flip
checkbox is fully closed (19/19 promoted: 18 on PR #184's recorded greens,
`widget-factory-smoke` on PR #186's post-mmu-uaccess-fix green). Every one of
those 19 promoted paths is hard-gating end to end — a Phase-2 regression on
any of them fails the JOB, no soak step remains from that cycle to hide
behind. (The `core` shard's later-added autotools acceptance soak — the
"Real-fork autotools proof" item in the Phase-1 Remaining checklist above —
is a separate, still-open, deliberately non-gating soak, not one of the 19;
it does not weaken this precondition, since Phase 2's fork-default-flip does
not depend on it.)

Re-point the EXISTING Phase-1 MMU CI jobs (`boot-smoke`'s `mmu`/`mmu-devices`
shards, `nix-boot-smoke-mmu`'s `core`/`gtk` shards, the autotools-fork smoke
added at the end of Phase 1) at the newly-default `cross.*`/`musl`/`nix.wasm`
— they already boot exclusively on `.#kernel-mmu-a2`, so THIS re-point itself
needs no job wiring changes beyond the soak-flip precondition above; only what
the substituted artifacts now contain changes. The NOMMU-facing jobs
(`artifacts`, `nix-boot-smoke`, `boot-smoke`'s `signals` shard, `browser-smoke`)
are UNTOUCHED in this phase — `.#kernel`/`.#linux-image` still point at the
old NOMMU/`posix_spawn`-only build until Phase 3, so they must keep passing
unregressed throughout. (Nothing about restoring fork() at the musl layer
forces the *kernel* choice; Phase 2 and Phase 3 are deliberately decoupled so
a Phase-2 regression is caught on `.#kernel-mmu-a2` CI, never on the thing pc
actually ships.)

---

## Phase 3 — the ship flip

Goal: point `.#linux-image` (what `publish-linux-channel` actually uploads and
pc actually downloads) at the Phase-2 world + `.#kernel-mmu-a2`, and carry that
through to production in the correct order.

1. **`flake.nix`** — `linuxImage = import ./userspace/linux-image.nix { inherit
   pkgs nixpkgs; kernel = kernelMmuA2; initramfs = wasmInitramfs; squashfs =
   wasmBaseSquashfs; };` is NOT the only place the boot kernel is wired, so
   this is NOT "swap the kernel attr and done." G6 independently embeds a
   SECOND kernel+initramfs copy: `wasmToplevel` (which `wasmBaseSquashfs` is
   built FROM — its own `base-squashfs.nix` call passes `toplevel =
   wasmToplevel`) hardcodes `kernel = kernel; initramfs = wasmInitramfs;` so an
   INSTALLED generation's `activate` script can export a coherent kernel+
   initramfs mirror without the ISO — exactly the pattern `wasmToplevelFork`
   already follows for the `-fork` variant (`kernel = kernelMmuA2; initramfs =
   wasmInitramfsFork;`, per its own comment: "embed those so activate can
   export a coherent mirror"). Both copies must move to `kernelMmuA2` in the
   SAME change: `linuxImage.kernel` alone would make the ISO boot the MMU
   kernel while `wasmToplevel`'s embedded copy kept pointing at the NOMMU
   `kernel` attr, so a post-install reboot (which boots off the *installed
   generation's* exported kernel, not the ISO) would run the Phase-2 real-fork
   userspace on a NOMMU kernel — exactly the corruption scenario the
   load-bearing constraint above rules out. Repointing `wasmToplevel`'s
   `kernel`/`initramfs` args forces a `wasmBaseSquashfs` rebuild (it is built
   FROM `wasmToplevel`) — that is expected, not an incidental side effect to
   avoid. Keep `kernelMmuA2` (the CHECKED/demand-paging/COW-correct A2
   variant) — not a hypothetical "promote A1 instead" shortcut; A1's
   no-present-check translate is a fully-populated-address-space stepping
   stone, not something safe to ship (a grown stack page silently
   mistranslates under A1 — see `2026-07-02-mmu-kernel-compile-milestone.md`).
2. **MANDATORY `ENGINE_ABI` bump** — `runtime/abi.js`'s own comment already
   states the obligation this phase discharges: "`wasm_collapse` is added ONLY
   by patches/kernel/0026 (mmu-fork kernels), so the SHIPPED NOMMU `.#kernel`
   / `.#linux-image` does NOT export it and keeps the byte-identical JS-throw
   path... DEFERRED OBLIGATION: if the MMU/fork guest ever becomes the
   published channel image, THAT is an incompatible exec-ABI change and MUST
   bump `ENGINE_ABI`." This phase IS that event. The engine's
   `wasm_user_mode_tail` stops being able to assume the JS-throw collapse path
   is what a published image uses — `wasm_collapse` (the uncatchable wasm trap
   that fixed #175's fork-child `catch(...)` swallowing the collapse) becomes
   the REQUIRED path for the shipped image, not a feature-detected optional
   one. **Fold in the same commit** (do not spend a second bump on it):
   remove the vestigial `__dlsym_time64: () => 0` env stub from
   `runtime/kernel-worker.js` and its entry from
   `toolchain/wasm-host-imports.nix`'s allow-list — per the #131 slice-2 audit
   ("KEPT until the coordinated musl rebuild ships — removing it now would
   break instantiation of any not-yet-rebuilt binary that still carries the
   weak-undef import. Remove the stub + its allow-list entry in the SAME
   commit that lands the musl 0009 world rebuild"). Musl patch 0009 (real
   dlsym) is already unconditional in `toolchain/musl.nix`, so no live binary
   should still import the stub — but Phase 3's is the first
   world-rebuild-and-republish event since 0009 landed, and it is a stray
   accommodation, not a mechanism, so batching its removal into the mandatory
   bump avoids opening a second low-stakes ABI-bump PR purely for a stub that
   nothing calls. **Do not batch anything else** into this bump opportunistically
   — only genuinely-dead wire surface belongs here, never a "while we're at
   it" feature.
3. **Ordered rollout** (per CLAUDE.md's own "pc-facing delivery" rule — a
   `master`-based `linux` channel can only ship AFTER the matching engine is
   synced into pc and pc is deployed; the guard is exactly what stops a
   premature publish from bricking the deployed engine with "reload pc"):
   1. `runtime/sync-to-pc.sh <pc-checkout>` — vendor the new `ENGINE_ABI`
      engine (kernel-worker.js's `wasm_collapse` detection flip, the removed
      `__dlsym_time64` stub, and every ABI-11/12-generation engine change that
      accumulated in `runtime/` since pc's last sync) into pc.
   2. **pc deploy** — ship that engine build to production.
   3. **`publish-linux-channel` workflow** (`workflow_dispatch`, `dry_run:
      true` first) — builds `.#linux-image` (now MMU-shaped, `minEngine`
      stamped from the bumped `ENGINE_ABI`) + `.#wasm-binary-cache`, uploads
      under the image's content hash, flips `packages/linux/latest.json`.
      Only after step 2 does the deployed engine's `ENGINE_ABI` already meet
      the new `minEngine` — running this step first would show every
      already-deployed pc "reload pc" for an engine that isn't live yet.
4. **CI swaps primary to MMU, with a NOMMU deprecation window.** `artifacts`
   (the job `nix-wasm.yml` uses to build `nix-wasm`/`wasm-binary-cache`/
   `wasm-base-squashfs`/`wasm-initramfs`/`linux-image`), `nix-boot-smoke`, and
   `browser-smoke` all switch their DEFAULT substituted kernel/initramfs/
   squashfs from the old NOMMU attrs to the (post-Phase-2) attrs `.#kernel`
   now resolves to. The OLD NOMMU pipeline — `.#kernel-nommu` /
   `.#wasm-initramfs-nommu` / `.#wasm-base-squashfs-nommu` (renamed from
   today's unsuffixed attrs at the same time `kernelMmuA2` takes over the
   `kernel` name) — keeps ONE clearly-labeled CI job (mirroring today's
   `nix-boot-smoke-mmu`'s role, inverted) for a deprecation window, so a
   regression in the about-to-be-deleted path is still caught rather than
   silently rotting before Phase 4 deletes it outright. Length of the window
   is a judgment call for whoever executes this phase — long enough to catch
   a real-world regression report against a still-live NOMMU published image,
   short enough that it does not become permanent parallel-maintenance debt
   (which is exactly what Phase 4 exists to end).

---

## Phase 4 — cleanup (#131 slices 2 + 3)

Goal: delete every accommodation Phases 2-3 made structurally unnecessary.
Per #131's own DoD, each box below is either **[deleted, boot-verified]** or
**[keep, because <reason not one of the three walls>]** — never left
unresolved. The dispositions below are the PLAN's best-evidence call, made
from the existing audit + design docs; PRIME DIRECTIVE still requires each one
be executed with an actual box + boot, not applied blind (the audit doc's own
words: "blindly editing the (documented-as-fiddly) glib/gtk3 overrides without
a boot to verify would be precisely the unverified workaround the PRIME
DIRECTIVE forbids"). Treat every disposition here as a hypothesis to VERIFY,
not a pre-approved patch.

### Slice 2 — remaining dlopen accommodations

(Track C / #130 already landed the mechanism; `dlopen-smoke` passes today,
independent of this plan. One item already closed before this plan — listed
for completeness:)
- [x] **DONE** — `patches/widget-factory/0001`'s `add_callback_symbol`
  workaround dropped; plain `gtk_builder_connect_signals(builder, NULL)` via
  real `dlopen(NULL)`/`dlsym`. Boot-verified (`widget-factory-smoke`).

A second item is scheduled, not closed — do not double-count it as done:
- [ ] **PENDING (scheduled: Phase 3 step 2, not yet executed).** The vestigial
  `__dlsym_time64: () => 0` env stub is still live today
  (`runtime/kernel-worker.js:1325`), with its allow-list entry still present
  (`toolchain/wasm-host-imports.nix`) — it batches into the mandatory
  `ENGINE_ABI` bump commit per Phase 3 step 2 above, not before (removing it
  early would break instantiation of any not-yet-rebuilt binary that still
  carries the weak-undef import).

Still open:
- [ ] `deps-overlay.nix` glib — gio modules loadable as PIC side-modules.
  **Provisional: keep, because** the guest is platform-wide `isStatic = true`
  (every meson/autotools cross build flips `-Ddefault_library=static`), so
  making gio modules loadable is a real per-module PIC-packaging +
  `GIO_MODULE_DIR` scan effort — not a flag flip — for zero functional gain
  (the built-in modules already work; nothing is missing). The dlopen WALL
  that made this a mechanism gap is gone, so this is now pure
  stock-shapedness, correctly low priority. VERIFY: if pursued anyway,
  `glib-smoke.mjs` + a booted gio-module load is the gate.
- [ ] `deps-overlay.nix` gtk3 — gdk-pixbuf loadable loaders (`loaders.cache` +
  PIC loader modules). **Provisional: keep, because** identical reasoning to
  the glib item above — built-in loaders work, loadable ones are a packaging
  project with no capability gain now that the wall is gone.
- [ ] **galculator — the real click-to-42 window with zero workaround.**
  galculator already carries `cb.dynsym` and its 115 `.ui` handlers resolve
  through real `gtk_builder_connect_signals(NULL)` → GModule → `dlopen(NULL)`/
  `dlsym` today (the mechanism gap closed with widget-factory's proof). This
  is not a delete-a-patch item — there is no galculator-specific patch left to
  remove — it is a VERIFY-and-close-out item: a real compositor render is a
  browser-visual check (`docs/superpowers/notes/m4-galculator-visual.md`,
  currently PENDING). Do it once Phase 1's still-open wl_shm/#11 Remaining item
  (above — no MMU compositor boot exists yet) gives a compositor path to test
  against; no code change expected.

### Slice 3 — NOMMU-memory accommodations (gated on CONFIG_MMU=y default)

(Unblocked by Phase 3 — every item below needs a CONFIG_MMU=y boot to verify.)

- [ ] `toolchain/musl.nix` `posix_fallocate` emulation.
  **Provisional: keep, because** the underlying gap is a real Linux
  filesystem property, not a NOMMU accommodation — ramfs has NO `->fallocate`
  on ANY kernel, MMU or not (`fs/ramfs/file-nommu.c` / `file-mmu.c` both lack
  it; glibc emulates on every real system for the same reason). MMU-vs-NOMMU
  is orthogonal to this gap. VERIFY empirically anyway (boot the MMU-default
  guest, `fallocate` on `/tmp`/`/dev/shm`) before writing off the audit's own
  "may become unnecessary" hedge as wrong.
- [ ] `patches/musl/0008` `__unmapself` no-stack-switch.
  **Provisional: keep, because** the underlying limitation is wasm's own
  operand-stack model (`CRTJMP` needs a native SP swap that no wasm engine
  offers), not a property of NOMMU vs a software-MMU page table — asyncify
  controls the *C call stack's contents*, not a foreign jump target. VERIFY:
  boot `.#pthread-exit-test`-equivalent (detached-thread exit) on the
  MMU-default guest; if it still SIGILLs without the emulation, keep with this
  same reasoning recorded, don't re-litigate it per-PR.
- [ ] `patches/kernel/0016` (RO-shared-mmap copy) + `0022` (ramfs-regrow-
  shared-mmap). **Provisional: delete + boot-verify.** These exist
  specifically because NOMMU mmap has no demand-paging/COW to fall back on;
  Track A2 (checked translate + present/write-bit COW, already boot-verified
  in `mmu-smoke-a2`) is the general mechanism these patches special-cased
  around. VERIFY via the GTK/wl_shm smokes that originally motivated them
  (`gtk-smoke`, `widget-factory-smoke` — real window renders, not just
  `--selftest`) plus a squashfs mmap-exec round-trip. (The #131 slice-3 audit
  this table follows also names a third patch here, `0025` — "file-mmap eager
  bounce" — but that reference is now STALE: `patches/kernel/0025` was
  repurposed on 2026-07-21 (#168) as `0025-mmu-debug-trace.patch`, the MMUSEGV
  fault-trace kernel `kernelMmuA2Dbg` (`debugTrace = true` in `kernel.nix`)
  depends on. There is no NOMMU eager-bounce patch at that number, or under
  any name, in `patches/kernel/` today — do NOT delete `0025`, it is an
  MMU-debugging facility this very phase's boot-verification work will want.)
- [ ] `kernel.nix` `CONFIG_BOOT_MEM_PAGES`/`CONFIG_ARCH_FORCE_MAX_ORDER`
  contiguous-alloc bumps + `patches/kernel/0007` (4 MiB user stack).
  **Provisional: measure, don't assume either way.** Real demand paging
  removes the CONTIGUITY pressure the bumps exist for (clang.wasm's order-11
  mmap, nix-env's large on-demand unpack) — but MMU still needs *some*
  explicit stack ceiling (A2 demand-pages growth, it does not remove the need
  for a VMA size), so 0007 likely stays even if the `BOOT_MEM_PAGES`/
  `ARCH_FORCE_MAX_ORDER` bumps shrink. VERIFY with `wrapperless-cc-e2e`
  (clang) and a large `nix-env -iA` install before touching either value —
  this is exactly the kind of contiguity-vs-paging tradeoff that must be
  measured on the box, not reasoned from the design doc alone.
- [ ] `nix-wasm.nix`/`deps-overlay.nix` sqlite `-DSQLITE_OMIT_WAL`
  (`+ THREADSAFE=0`). **Provisional: attempt re-enable, VERIFY under real
  concurrent load.** WAL's `-shm` needs a real growable `MAP_SHARED` file;
  ramfs already supports `MAP_SHARED` (proven by the `/dev/shm` wl_shm path)
  independent of MMU, so this may have never been strictly an MMU gap either
  — re-test with WAL + THREADSAFE=1 under a real `nix-env` store-DB write
  workload (the original failure mode) before concluding it's safe, and
  revert with the specific new failure recorded if it still breaks.
- [ ] ramfs-mandatory-for-shared-mmap assumptions (`bootstrap.nix` `/dev/shm`,
  9P `cache=loose,ignoreqv`). **Provisional: VERIFY both, may flip.**
  `cache=loose` exists because NOMMU can't `get_user_pages` on a user buffer
  (netfs's `cache=none` unbuffered-read path needs it); a real MMU restores
  `get_user_pages` in the normal way, so `cache=none` may become viable again
  — re-test rather than assume `loose` must stay "because it always has."
  Similarly, mainline Linux's `tmpfs`/`shmem` `MAP_SHARED` restriction is
  specifically a NOMMU limitation (`CONFIG_MMU` gates real shmem `mmap`); the
  ramfs-not-tmpfs choice for `/dev/shm`/`/tmp` may be revisable to stock tmpfs
  under CONFIG_MMU=y. Do not change either without a GTK-shm boot proof — a
  regression here reproduces exactly the "empty 0×0 window" failure mode the
  original fix diagnosed.

### Explicitly kept, unconditionally

(Orthogonal to fork/dlopen/MMU — the audit's own list, unaffected by any
phase here.)

`--fpcast-emu` (strict `call_indirect` casts — MORE load-bearing post-#126, per
the audit, since dynsym-inject + the FFI canonical path both depend on the
canonical-thunk ABI), the `__lsan_*` weak-undef loader stubs, the crt weak
2-arg `main` wrapper, the wasm-ld ELF-flag filter, `-fvisibility=hidden`, the
libffi raw backend's static fast path. None of these trace to NOMMU, no-fork,
or no-dlopen — do not touch them in this cleanup.

---

## Ticket close-out map

- **#11** ("revisit NOMMU Wayland accommodations if MMU lands") enumerates SIX
  accommodations (the ticket's own table). It is answered IN PART by Phase 1,
  not closed by it, and the evidence splits into four groups, not two:
  - **Item 1 (virtio vring/pfn addressing) is answered by ARGUMENT, and its CI
    confirmation is now hard-gated** (stale as of an earlier draft of this
    map: it used to be soak-gated, before the PR #184 promotion cycle below
    moved all ten `mmu-devices` smokes to `run_smoke`). The structural reason: **the MMU
    kernel keeps the kernel itself identity-mapped** — only USER virtual
    addresses are translated (`patches/kernel/0023`'s own comments: "the
    kernel runs in physical/identity space... A user va resolves through the
    [page table]"). The virtio transport's vring/pfn addressing
    (`patches/kernel/0013`, e.g. `virt_to_phys(buf)` as the host-readable byte
    offset) runs entirely in KERNEL/driver context, so it is untouched by
    CONFIG_MMU=y — patches 0013/0017-0020 apply to the MMU kernel completely
    unmodified (`kernel.nix`'s `mmu=true` path layers 0023/0024/0026 ON TOP of
    them, never replacing them). This argument does not depend on any CI
    result and holds regardless. Phase 1's `mmu-devices` shard
    (vsock/resize/snd/blk-rw, all virtio-device tests) was meant to be the
    empirical confirmation, item by item: each of those NOMMU-era device
    accommodations either (a) turns out to be MMU-orthogonal entirely — the
    kernel-identity-mapping argument above — or (b) is a real, independent gap
    (ramfs's missing `->fallocate`, wasm's missing `CRTJMP`) that Phase 4's
    slice-3 table above resolves on its own merits, not as a "NOMMU vs MMU"
    question. Every one of those confirming smokes is a `run_smoke` HARD GATE
    since the PR #184 promotion cycle — a real regression in
    vsock/resize/snd/blk-rw now fails the JOB. Item 1 is answered by the
    argument AND CI-protected.
  - **Items 2/3/5 (the Wayland/`wl_shm` user-mapping accommodations) are NOT
    answered yet, despite `nix-boot-smoke-mmu`'s `gtk` shard running real GTK
    binaries.** Every smoke in that shard is the display-free `--selftest`
    path — no compositor in the node harness means `gtk_init_check` returns
    FALSE, no `GdkDisplay`, so no `wl_shm` pool is ever allocated — so
    virtio_wl's per-vfd anon inode, `_resolveShmFd`'s pfn→host-offset
    `Uint8Array` view (`runtime/virtio/wl-device.js`), and waylandproxyd's
    mmap+copy resync never run under CONFIG_MMU=y anywhere in CI today. This
    is Phase 1's still-open Remaining item (above): closing it needs an actual
    wl_shm-allocating MMU boot (a gated `?variant=mmu` Playwright check, or a
    dedicated wl-text/sommelier smoke on `.#kernel-mmu-a2`), which does not
    exist yet.
  - **Item 4 (the dropped upstream `vmalloc`+`find_vm_area` large-buffer send
    branch) is UNASSESSED by this plan.** #131's own slice-3 table
    (`cleanup-131-audit.md`, titled "non-Wayland NOMMU-memory accommodations")
    deliberately excludes every Wayland-stack item on the assumption #11
    covers them, but nothing in that audit or this plan actually picks item 4
    up. It is a restore-or-keep call (the ticket's own words: "with MMU + a
    real DMA path, the upstream scatter/vmalloc branch could be restored"),
    not something a display-free `--selftest` answers — deciding it needs a
    `wl_shm` send that exceeds a single scatter entry, which depends on the
    same still-missing wl_shm-allocating MMU boot as items 2/3/5.
    Disposition: **keep the current kvmalloc/single-`sg_init_one` NOMMU port
    until that boot exists**, then re-evaluate — restoring the upstream branch
    may not even buy anything, since item 1's identity-vring argument shows
    this transport was never going through the DMA/IOMMU path the upstream
    branch assumes.
  - **Item 6 (waylandproxyd's single-process/no-fork design) is answered by
    Phase 2, not Phase 1.** Track B's real MMU-native `fork()` (boot-verified
    — see the `fork-smoke` entry in CLAUDE.md) is exactly the capability the
    ticket says would "make a more conventional multi-process proxy design
    possible" — but the ticket's own text also says "the single-process poll
    loop is fine," i.e. this was never a correctness gap, only an option.
    Disposition: **keep the single-process design** — neither Phase 2's #131
    slice-1 edit set (musl/ash/busybox/glib/pkg-config, listed above) nor
    anything else in this plan touches `waylandproxyd`, so there is no
    motivation here to rewrite it. Whoever eventually picks up items 2/3/4/5
    on a real wl_shm-allocating boot should record this decision explicitly
    rather than leaving item 6 silently unaddressed.
  **#11 as a whole still cannot close on Phase 1's current CI evidence, even
  though item 1 is now fully answered** (structural argument AND hard-gated
  CI, both above) **— items 2/3/4/5 all need
  a wl_shm-allocating MMU boot that does not exist yet, and item 6's
  keep-as-is disposition above still needs recording on the ticket itself.**
  Do not close the ticket, and do not cite the `gtk` shard as "real wl_shm"
  evidence, until the Remaining items above land.
- **#131** closes when slice 1 (Phase 2), slice 2 (Phase 4, three items), and
  slice 3 (Phase 4, six items) are ALL resolved (deleted-and-verified or
  kept-with-reason) — i.e. at the end of Phase 4.
- **#126** closes with #131 — the epic's own stated DoD (`cleanup-131-audit.md`:
  "the guest is stock-shaped from userspace and #126 is realized") makes
  #131's closure the epic's closure; there is no separate #126 checklist.

---

## Risks

(Open, unresolved by this plan — surfaced for Phase 3 to address before it
ships to real users, not CI runners.)

1. **Browser memory for instrument-at-load of `nix.wasm`.** The engine
   software-MMU-instruments EVERY exec'd binary at load
   (`kernel-worker.js`'s `wasm_load_executable`, gated on the MMU kernel's
   nonzero `pt_base`). For the real-fork `nix.wasm` — already
   whole-module-asyncified over its fork call graph (bounded via
   `asyncify-ignore-indirect` + a curated addlist + `propagate-addlist` +
   size/decision-count build gates, per #175) — the SECOND pass (softmmu
   instrumentation, layered on top of the already-asyncified module) produces
   multi-MB helper-call-translated functions that **OOM-killed the default CI
   runner** (`#175`, exit 137); `nix-boot-smoke-mmu` only passes today because
   it was moved onto the `-lg` (LLVM-build-sized) Namespace profile — CI
   runners can be given more RAM on request, real end-user BROWSER TABS
   cannot. This is a genuine, currently-UNRESOLVED ship risk for Phase 3: if a
   real browser tab hits the same instrument-at-load memory spike loading
   `nix.wasm`, users get an OOM crash where the NOMMU guest today does not.
   Nothing in this plan bounds the softmmu pass's own memory blowup the way
   `asyncify-ignore-indirect`/the addlist bound the fork instrumentation —
   that is a real gap, not a solved problem being restated. Before Phase 3
   ships to production, either (a) bound the softmmu pass's per-function
   output the same deliberate way the asyncify pass is bounded, or (b) get a
   REAL browser (not Node/CI) memory measurement loading the fork `nix.wasm`
   on `.#kernel-mmu-a2` — `nix-wasm.yml`'s `browser-smoke` job's Playwright
   harness does not currently boot the MMU variant at all, so this number does
   not exist yet.
2. **The 2-3x per-access-walk slowdown is permanent, not a CI convenience
   line.** `nix-wasm.yml`'s own comments document it directly:
   `NIX_MAKE_TIMEOUT_MS` is raised 3.3× (180s → 600s) and `nix-boot-smoke-mmu`'s
   budget is exactly doubled (120min → 240min — NOT the 90min figure, which is
   the UNRELATED NOMMU `nix-boot-smoke` job's own budget, shared across ITS
   `core`/`gtk` shards) specifically because
   "the software-MMU guest runs the substitute+unpack ~2-3x slower than NOMMU
   (every access is a 2-level walk; page-crossing accesses split byte-wise)."
   Once Phase 3 ships, this is not a CI-only cost — it is what every end
   user's `nix-env -iA` install, in-guest compile, and GTK app launch pays,
   forever (or until something like the wasm `memory-control` proposal ships a
   hardware-backed MMU primitive — the design doc's own noted escape hatch).
   It is worth explicitly noting this is HIGHER than the literature floor the
   original MMU-viability research cited (WAVEN's ~10.4% geomean, "~1.1× the
   honest ballpark for the folded-into-codegen case" of a JIT-fused per-access
   translate over natively-compiled wasm,
   `2026-07-01-software-mmu-asyncify-design.md` §1) — our pass is an
   UNoptimized inline-everything translate (deliberately, per the "inline the
   translate, never a helper call" lesson — a helper-call-per-access measured
   ~12× under V8), PLUS the present/writable-bit check A2 adds on every
   access, PLUS helper-call bailouts for functions that exceed V8's 6 MB
   function-size cap after instrumentation. This is an ACCEPTED tradeoff for
   Phase 3 (COW/dlopen/real-fork/normal-mmap are worth it), not a bug to fix
   before shipping — but it is user-visible latency that belongs in release
   notes, not just a CI timeout comment, and it is a legitimate FUTURE
   optimization target (closing the gap toward the ~1.1× floor) independent
   of this plan's four phases.

---

## References

In-repo: `docs/superpowers/specs/2026-07-01-software-mmu-asyncify-design.md`
(the #126 epic design + the WAVEN/LFI measurement record + the §"References"
line naming #11 explicitly), `docs/superpowers/specs/
2026-07-01-cleanup-131-audit.md` (the slice-by-slice #131 audit this plan
executes), `docs/superpowers/specs/2026-07-01-track-b-fork-seam-status.md`
(the real-fork mechanism's full validation history, including the task-#5
SIGCHLD/asyncify-instrumentation red herring worth re-reading before touching
anything fork-related), `docs/superpowers/notes/
2026-07-02-mmu-kernel-compile-milestone.md` (A1/A2 kernel boot history — why
A2, not A1, is the shipped variant), `docs/process-model.md` (the document
Phase 2 rewrites), `runtime/abi.js` (the `ENGINE_ABI` history + the deferred
wasm_collapse-bump obligation Phase 3 discharges), `.github/workflows/
nix-wasm.yml` (`mmu-devices`/`mmu`/`signals` shards in `boot-smoke`; `core`/
`gtk` shards in `nix-boot-smoke-mmu`), `.github/workflows/pr-preview.yml` +
`runtime/demo/web/main.js` (the `?variant=mmu` preview wiring).
