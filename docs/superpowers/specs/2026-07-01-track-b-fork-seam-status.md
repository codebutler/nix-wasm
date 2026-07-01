# Track B — asyncify fork seam revival: status (#129)

Date: 2026-07-01
Status: Mechanism recovered + engine tested; the reusable build path authored;
LANDING gated on Track A2 (COW) + the world build.
Parent: `2026-07-01-software-mmu-asyncify-design.md` §4 Track B. Revives #32/#25/#29.

## What Track B is

Real `fork()` without `exec()` on the wasm guest, via the **asyncify double-
return** seam PR #20 built and proved (8 `fork-*` acceptance programs passed:
returns-twice, nested, loop, pipe, exec, in-thread, +helper). It was closed
*not_planned* because `posix_spawn` covered fork-then-exec and #29's eager whole-
RSS copy had no COW. **Track A now provides COW** (#128), so the seam is worth
reviving — as a *reusable* path (#32's unfinished acceptance), with the tax
confined to fork-users (#129 B2).

## Done here (verifiable in this environment)

- **The runtime engine** — `runtime/asyncify.js` (recovered from PR #20). The
  host-side double-return orchestration: `capture_stack` import → unwind into the
  instance's own linear memory → copy to child → rewind both so `fork()` returns
  twice. **6 node tests pass** (`runtime/demo/node/asyncify.test.mjs`), plus the
  link test. This is the mechanism, unchanged and green.
- **The de-risk spike** — `spikes/asyncify-fork/` (probe + FINDINGS) proving the
  mechanism through real clang -O2 codegen.
- **The fork × dlopen replay** — THE sharp edge the design flagged (Track 0 §4
  step 3 / #33 point 3): a forked child must re-instantiate + re-link the
  parent's `dlopen`'d side modules (module instances + the table are engine state
  the memory snapshot does NOT carry). **This is implemented + tested** in
  `runtime/dylink.js` (`snapshot`/`replay`, deterministic table layout) — so when
  the seam lands, fork-after-dlopen already reproduces the parent's table.
- **The reusable build path (B1)** — `toolchain/wasm-fork-stdenv.nix`: the
  stdenv-adapter generalization of the single-source `userspace/asyncify-cc.nix`
  seam, so a package opts into real fork by building through it
  (`enableForkFor drv`), not a bespoke derivation. Links `muslFork` first + runs
  `wasm-opt --asyncify` over the final module. Authored + grounded in the proven
  per-source seam; **not build-verified here** (needs the world build).
- **The proven seam reference** — `userspace/asyncify-cc.nix`,
  `toolchain/guest-cc-fork.nix`, the `fork-*.c` acceptance programs (recovered
  from PR #20) as the reference the adapter generalizes.

## Gated on the world build / Track A2 (NOT done here)

- **`muslFork`** — the musl-fork variant (canonical musl + the fork-asyncify
  seam patch). PR #20's `patches/musl/0008-fork-asyncify-seam.patch` predates
  master's current musl patch series (master's 0007/0008 are different fixes), so
  re-integrating it is a build-verified merge on the linux box, NOT a blind
  checkout (which would silently conflict with the `__unmapself` / syscall-arity
  patches that must all apply `--fuzz=0`). Left for the box.
- **Booting a real (non-test) fork-without-exec package** through `forkStdenv`
  — the B1 DoD. Needs `muslFork` + a world rebuild.
- **COW dependency** — the seam only BEATS the status quo once Track A2's COW
  removes #29's eager-copy cliff, and A2 needs the kernel MMU arch layer (#128
  kernel half), which needs the kernel source + nix/LLVM builds this environment
  lacks.

## Then (the #131 slice-1 payoff, gated on the above)

Once a real package forks through the seam + COW makes it cheap: retire the
forkshell `ash` (#25), the busybox spawn patches, glib's `posix_spawn`-only
patch, the per-package fork triage — enumerated in #131 slice 1. Unblocks #93
(s6 no longer needs a fork→posix_spawn port).

## Summary

The **mechanism** is recovered and green; the **fork×dlopen replay** (the design's
named hazard) is fully implemented + tested; the **reusable build path** is
authored. What remains is the `muslFork` re-integration + a real-package boot +
the COW dependency — all bottlenecked on the world/kernel build, per the epic's
"ship what works, report honestly" for the build-gated half.
