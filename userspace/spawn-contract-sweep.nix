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
# `roots` = the derivations to sweep — the flake.nix callers pass, per profile:
# busybox + the generated /init (bootstrap.nix) + every initramfs extraBin
# (mirrors initramfs.nix's OWN `busybox`/`extraBins` parameterization — the
# SAME lists flake.nix already assembles for the real initramfs) + the
# toplevel system closure (nix.wasm + every environment.systemPackages app —
# galculator, gcalctool, l3afpad, the games, …) + the on-demand compiler
# toolchain and nixpkgs catalog (wasmDevPaths/wasmPublishedPkgs — substituted
# lazily via `nix-env -iA wasm-tools.*`/`nixpkgs.*`, so NOT reachable from
# either the initramfs or toplevel closures, but real modules the guest runs
# all the same — see the flake.nix callers' own comments). Every root's FULL
# transitive closure is swept (pkgs.closureInfo, the same idiom userspace/
# base-squashfs.nix already uses for its own store-paths list) — not just
# each root's own $out — so a wasm module reached only indirectly (a runtime
# dependency of an extraBin, say) is not silently skipped. This is now, to
# the best of this repo's knowledge, EVERY real wasm module a profile's guest
# can end up running — not merely its boot-time closure — but "the roots
# flake.nix happens to pass" is the actual, checkable claim; if a future
# guest-facing artifact category is added without a matching root here, this
# sweep will not see it, silently.
#
# A "real wasm module" here means a FINAL, linked dylink module (one that
# carries a `dylink.0` custom section) — scripts/wasm-closure-sweep.py's
# `has_dylink_section` filters out relocatable objects (crt1.o and similar)
# that also start with the wasm magic but are not yet linked, so their
# unresolved references are not host imports and must not be graded as such.
#
# We do NOT unpack the packaged initramfs.cpio.gz / base.squashfs artifacts
# themselves to find their contents — both are compressed, so nothing in
# them is byte-scannable as "wasm modules" without decompressing first, and
# decompressing here would just re-derive (expensively) exactly the input
# set the caller already has as plain Nix derivations. Sweeping the inputs
# directly is equivalent (initramfs.nix / base-squashfs.nix copy these EXACT
# paths in, verbatim, uncompressed-then-compressed) and far cheaper.
{ pkgs, profile, roots, expectCaptureStackCount ? null
, expectCaptureStackNames ? null
, expectMinModules ? null
# The DERIVATION name, deliberately NOT derived from `profile` by default
# fallback logic here: `profile` is "nommu-spawn"/"mmu-fork" (the
# wasm-check-imports.py contract-profile vocabulary), but the flake attrs
# these derivations are actually exposed as are `guest-spawn-contract-nommu`
# / `guest-spawn-contract-fork` (flake.nix's `packages`) — a plain
# `"guest-spawn-contract-${profile}"` default would produce
# `guest-spawn-contract-nommu-spawn` / `guest-spawn-contract-mmu-fork`,
# neither of which matches its own flake attr name (nix-wasm#202, found by
# review — `nix build .#guest-spawn-contract-fork --print-out-paths` prints
# a store path whose own basename disagreed with the attr that built it,
# confusing for anyone reading `nix build -L` output or a store-path log).
# Callers (flake.nix) pass the real attr name explicitly; the profile-based
# fallback only covers ad hoc/spike callers that don't care.
, name ? "guest-spawn-contract-${profile}"
}:
let
  closure = pkgs.closureInfo { rootPaths = roots; };
in
pkgs.runCommand name
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
    # The DIRECTORY below is interpolated on purpose (see the line after this
    # comment block) — NOT a path to the single file wasm-closure-sweep.py
    # itself. Interpolating a path to a single FILE copies only that file
    # into the store — siblings are NOT copied alongside it — and this
    # script's own `_HERE`-relative loads of wasm-check-imports.py and
    # wasm-check-exports.py would then FileNotFoundError inside the sandbox
    # (nix-wasm#202, found by review — reproduced with a minimal flake of
    # identical shape before this fix). Interpolating the directory copies
    # the whole `scripts/` tree as one store path, so the siblings survive.
    # NOTE ON WRITING THIS COMMENT ITSELF: this whole buildCommand is a Nix
    # indented ("doubled-apostrophe-delimited") string, so Nix's own lexer
    # scans EVERY line of it — including this shell `#` comment — for
    # dollar-brace interpolation and for the doubled-apostrophe escape
    # sequence, regardless of the shell never treating a comment as code. An
    # earlier revision illustrated the WRONG shape by writing a live,
    # unescaped dollar-brace path to the single-file script right here in
    # prose — which Nix duly evaluated, silently adding that unused
    # single-file store path to this derivation's inputs (nix-wasm#202,
    # found by review). This paragraph deliberately describes the escape
    # mechanism in words rather than typing the literal characters, to avoid
    # reintroducing exactly that hazard in its own explanation.
    python3 ${../scripts}/wasm-closure-sweep.py ${profile} \
      ${pkgs.lib.optionalString (expectCaptureStackCount != null)
        "--expect-capture-stack-count=${toString expectCaptureStackCount}"} \
      ${pkgs.lib.optionalString (expectCaptureStackNames != null)
        "--expect-capture-stack=${pkgs.lib.concatStringsSep "," expectCaptureStackNames}"} \
      ${pkgs.lib.optionalString (expectMinModules != null)
        "--expect-min-modules=${toString expectMinModules}"} \
      --roots-file=${closure}/store-paths \
      | tee $out
  ''
