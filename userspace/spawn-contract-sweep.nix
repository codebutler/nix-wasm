# .#guest-spawn-contract-nommu / .#guest-spawn-contract-fork (nix-wasm#202 PR-1).
#
# The closure-wide gate that must be green BEFORE Phase 2 can flip
# toolchain/musl.nix's default from `fork ? false` to `fork = true`: it runs
# scripts/wasm-closure-sweep.py (--fork-contract=PROFILE, wasm-check-imports.py's
# per-module check) over EVERY real wasm module reachable from a profile's guest
# roots — not just busybox (the one binary the pre-existing hardening in
# userspace/busybox-fork.nix's installPhase already checked).
#
# DELIBERATELY A SEPARATE CHECK DERIVATION, not wired into
# userspace/initramfs.nix / userspace/base-squashfs.nix themselves:
#   1. PR-1's own constraint (see its commit message) is that it changes NO
#      derivation that produces a SHIPPED artifact's content — the initramfs/
#      squashfs derivations must stay byte-for-byte structurally identical.
#      Adding a build-time assertion INSIDE those derivations would violate
#      that (their buildCommand/env would change) even though the images
#      themselves would still come out byte-identical once built.
#   2. CI granularity: a checker-only edit (e.g. tightening the asyncify-ABI
#      assertion) should re-run the sweep WITHOUT forcing a rebuild of the
#      ~180MB base-squashfs / ~40-220MB initramfs images it inspects — those
#      are expensive (a busybox-fork rebuild alone re-runs a whole-module
#      wasm-opt --asyncify pass over a multi-MB binary). A separate check
#      derivation only rebuilds (and only re-fails fast) when its own script
#      or the swept packages themselves change; Nix's content-addressed
#      caching gives this for free once the two concerns are separate attrs.
#
# `roots` = the derivations to sweep — mirrors initramfs.nix's OWN
# `busybox`/`extraBins` parameterization (the caller passes the SAME lists
# flake.nix already assembles for the real initramfs, so this attr's closure
# is defined identically to what actually ships) PLUS the toplevel system
# closure (nix.wasm + every environment.systemPackages app — galculator,
# gcalctool, l3afpad, the games, …), covering the OTHER half of the shipped
# guest (installed packages, not just initramfs extraBins). Every root's
# FULL transitive closure is swept (pkgs.closureInfo, the same idiom
# userspace/base-squashfs.nix already uses for its own store-paths list) —
# not just each root's own $out — so a wasm module reached only indirectly
# (a runtime dependency of an extraBin, say) is not silently skipped.
#
# We do NOT unpack the packaged initramfs.cpio.gz / base.squashfs artifacts
# themselves to find their contents — both are compressed, so nothing in
# them is byte-scannable as "wasm modules" without decompressing first, and
# decompressing here would just re-derive (expensively) exactly the input
# set the caller already has as plain Nix derivations. Sweeping the inputs
# directly is equivalent (initramfs.nix / base-squashfs.nix copy these EXACT
# paths in, verbatim, uncompressed-then-compressed) and far cheaper.
{ pkgs, profile, roots, expectCaptureStackCount ? null }:
let
  closure = pkgs.closureInfo { rootPaths = roots; };
in
pkgs.runCommand "guest-spawn-contract-${profile}"
  { nativeBuildInputs = [ pkgs.python3 ]; }
  ''
    # `set -o pipefail`: WITHOUT it, `python3 ... | tee $out`'s overall exit
    # status is tee's (always 0), so a real spawn-contract VIOLATION would be
    # printed to $out and the build would still report success — silently
    # defeating the gate (the exact "step exit code always 0 regardless of
    # what ran" hazard CLAUDE.md's soak-idiom note warns about, here at the
    # pipeline level instead of the CI-step level). With it, the derivation
    # fails whenever the checker does, while $out still carries the full
    # per-module report for a human (or the log) to read.
    set -o pipefail
    python3 ${../scripts/wasm-closure-sweep.py} ${profile} \
      ${pkgs.lib.optionalString (expectCaptureStackCount != null)
        "--expect-capture-stack-count=${toString expectCaptureStackCount}"} \
      --roots-file=${closure}/store-paths \
      | tee $out
  ''
