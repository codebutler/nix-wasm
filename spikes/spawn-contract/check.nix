# nix-wasm#202 PR-1: the spawn-contract link probe, parameterized over which
# profile's libc it checks against. Was spikes/nofork/ (flake attr
# `.#nofork-linkcheck`, kept as a compat alias in flake.nix — see its own
# comment) — renamed because a single hardcoded "fork must be absent"
# assertion stops being an accurate name the moment a SECOND profile (real
# fork, #129/#131) exists to probe too. See docs/process-model.md for the two
# process-model shapes this now checks.
#
# nommu-spawn (today's DEFAULT, unparameterized musl — toolchain/musl.nix's
# `fork ? false`): compiles a fork() user and a posix_spawn() user through the
# plain cross cc-wrapper. Contract: fork=ABSENT (wasm-ld reports `undefined
# symbol: fork` — musl.nix's postPatch deletes the symbol body), spawn=LINKED.
# This is what SHIPS today; PR-2's world-rebuild flip is what changes it.
#
# mmu-fork (the #129/#131 real-fork musl, `muslFork`): relinks the SAME two
# probes with muslFork's libc.a forced FIRST on the link line (mirrors
# userspace/busybox-fork.nix's own CONFIG_EXTRA_LDFLAGS technique, for the
# identical reason — an archive placed earlier on the link line satisfies a
# not-yet-pulled symbol before the wrapper's own default sysroot `-lc` gets a
# chance to). No extra flags beyond that: the cross cc-wrapper's OWN baked-in
# `--allow-undefined-file` (wasm-cross.nix, via toolchain/wasm-host-imports.nix)
# is used completely UNMODIFIED — this probe does not (and must not) invent a
# THIRD local extension idiom for capture_stack; wasm-host-imports.nix's own
# header names the two sanctioned ones (nix-wasm.nix's extended allow-list;
# busybox-fork.nix's blanket --import-undefined), and this probe deliberately
# uses NEITHER, because it exists to observe today's un-extended contract, not
# to make a fork program buildable.
#
# MEASURED (not assumed) result of that unmodified link, both probes, TODAY —
# before PR-2 adds capture_stack to wasm-host-imports.nix: BOTH fork() and
# posix_spawn() fail to link, and — this is the finding worth recording — BOTH
# fail on the exact same undefined symbol, `capture_stack`, not on `fork`.
# Traced with `wasm-ld --why-extract`: posix_spawn() itself never references
# fork/_Fork (it calls __clone directly), but musl's __clone implementation
# (clone.lo) unconditionally references `__post_Fork` — a vfork-adjacent
# bookkeeping hook — and `__post_Fork` is defined in the SAME object file as
# `_Fork()` itself (_Fork.c), so pulling clone.lo in for `__post_Fork` drags
# `_Fork()`'s own `capture_stack` reference along too, purely from object-file
# granularity (archives are searched per translation unit, not per symbol
# within one). So in the mmu-fork profile, EVERY nontrivial program — not just
# one that calls fork() itself — needs capture_stack resolvable, which is
# exactly why every real shipped mmu-fork binary today
# (userspace/busybox-fork.nix, nix-wasm.nix's realFork) uses one of the two
# sanctioned extension idioms rather than linking through the plain
# cc-wrapper unmodified. The contract this probe pins for TODAY is therefore
# fork=NEEDS_CAPTURE_STACK / spawn=NEEDS_CAPTURE_STACK (both link failures,
# both citing exactly `capture_stack`) — asserting fork=LINKED here would be
# dishonest about what the UNMODIFIED toolchain can do before PR-2 lands.
#
# PR-2 flips the expectation BY CHANGING A PARAMETER, not by rewriting this
# file: once capture_stack is added to wasm-host-imports.nix (and, per that
# file's own header, that addition is PLANNED as a full cross.* world
# rebuild, landing together with the musl.nix default flip), this SAME
# unmodified link will simply succeed — flip the `mmu-fork` entry in
# `expected` below from NEEDS_CAPTURE_STACK to LINKED and the probe's own
# logic needs no other change.
{ cross, muslFork ? null, profile ? "nommu-spawn" }:
let
  lib = cross.lib;
  profiles = [ "nommu-spawn" "mmu-fork" ];
  expected = {
    "nommu-spawn" = { fork = "ABSENT"; spawn = "LINKED"; };
    # [MEASURED 2026-08-13 against the real muslFork + cross cc-wrapper store
    # paths, via wasm-ld --why-extract; see the header above] — update this
    # alongside wasm-host-imports.nix gaining capture_stack (PR-2).
    "mmu-fork" = { fork = "NEEDS_CAPTURE_STACK"; spawn = "NEEDS_CAPTURE_STACK"; };
  };
  want =
    if builtins.elem profile profiles
    then expected.${profile}
    else throw "spikes/spawn-contract/check.nix: profile must be one of ${lib.concatStringsSep ", " profiles}, got ${profile}";
  extraArgs =
    lib.optionalString (profile == "mmu-fork")
      (if muslFork == null
       then throw "spikes/spawn-contract/check.nix: profile mmu-fork needs `muslFork` (toolchain/musl.nix's fork=true variant, e.g. .#musl-fork)"
       else "${muslFork}/lib/libc.a");
in
cross.stdenv.mkDerivation {
  name = "spawn-linkcheck-${profile}";
  dontUnpack = true;
  buildPhase = ''
    mkdir -p $out
    : > $out/result
    if $CC ${extraArgs} ${./uses-fork.c} -o fork.wasm 2>fork.err; then
      echo "fork=LINKED" >> $out/result
    elif grep -q "undefined symbol: fork" fork.err; then
      echo "fork=ABSENT" >> $out/result
    elif grep -q "undefined symbol: capture_stack" fork.err; then
      echo "fork=NEEDS_CAPTURE_STACK" >> $out/result
    else
      echo "fork=OTHER_ERROR" >> $out/result; cat fork.err >> $out/result
    fi
    if $CC ${extraArgs} ${./uses-spawn.c} -o spawn.wasm 2>spawn.err; then
      echo "spawn=LINKED" >> $out/result
    elif grep -q "undefined symbol: capture_stack" spawn.err; then
      echo "spawn=NEEDS_CAPTURE_STACK" >> $out/result
    else
      echo "spawn=FAILED" >> $out/result; cat spawn.err >> $out/result
    fi

    echo "== spawn-linkcheck-${profile} result =="; cat $out/result
    # Enforce the contract — fail the build on any deviation from `expected`
    # above (the whole point: this must be a real regression gate, not a
    # passive report).
    grep -qx "fork=${want.fork}" $out/result \
      || { echo "CONTRACT VIOLATION (${profile}): fork expected ${want.fork}, got $(grep '^fork=' $out/result)" >&2; exit 1; }
    grep -qx "spawn=${want.spawn}" $out/result \
      || { echo "CONTRACT VIOLATION (${profile}): posix_spawn expected ${want.spawn}, got $(grep '^spawn=' $out/result)" >&2; exit 1; }
  '';
  installPhase = "true";
}
