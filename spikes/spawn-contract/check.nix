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
# WHAT "muslFork forced first" DOES AND DOES NOT PROVE (raised in review):
# this is a HYBRID link — muslFork's libc.a is placed first, but the
# cc-wrapper still appends the DEFAULT (nommu) sysroot's own `-lc` after it,
# so any symbol muslFork's forced-in objects don't happen to pull still
# resolves from the plain no-fork musl, not from muslFork. This is NOT a
# probe-specific shortcut — it is EXACTLY the same hybrid-link technique both
# real shipped mmu-fork binaries use for the identical reason (verified by
# reading their own recipes, not assumed): userspace/busybox-fork.nix's own
# comment ("Every other archive member is byte-identical to the sysroot's, so
# no ODR risk") and nix-wasm.nix's realFork link ("same rule as userspace/
# busybox-fork.nix") both force muslFork's libc.a first and rely on the same
# byte-identical-elsewhere property. So this probe's result IS representative
# of the real technique — it faithfully answers "does resolving fork()/
# posix_spawn() under the shared cc-wrapper genuinely reach muslFork's
# fork-seam objects, with everything else still resolving normally?" (yes,
# confirmed via --why-extract below). What it does NOT prove: it exercises
# NONE of the actual runtime asyncify/capture_stack double-return machinery
# (a two-line `fork()`/`posix_spawn()` call site, compiled but never run) —
# only fork-smoke.mjs's real boot proves that works; and it does not
# reproduce nix-wasm.nix's realFork build byte-for-byte (that link assembles
# hundreds of specific .o files via meson, not this probe's plain two-file
# compile) — treat this probe's PASS/FAIL as evidence about the LINK GRAPH
# SHAPE (which library provides which symbol) under the shared cc-wrapper,
# never as a stand-in for either real shipped binary's full build or for
# runtime correctness.
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
# file — but NOT to fork=LINKED/spawn=LINKED, and capture_stack does NOT go
# on the shared allow-list (a decision, not a TODO — see the AXIS-1 finding
# in the #202 PR-1 review response). The `__post_Fork`/`_Fork` coupling this
# header traces above is SELF-INFLICTED: `patches/musl/0000` defines wasm's
# `__clone` inside `src/linux/clone.c`, which happens to share a translation
# unit's worth of archive-pull granularity with `_Fork()`'s own
# `_Fork.c` — upstream musl gives `__clone` its own TU, where it never
# touches `__post_Fork` at all. `--gc-sections` cannot rescue a binary that
# doesn't need fork() from this either: `wasm-cross.nix`'s `--export-all`
# roots every DEFINED symbol against GC, and this is already true TODAY on
# the shipped NOMMU busybox, where `_Fork`/`__post_Fork`/`__clone`/`clone`/
# `posix_spawn` all already coexist, rooted, needing no fork() caller at
# all. PR-2's real fix is a musl TU split — move `__post_Fork` (plus its
# `static void dummy` / `weak_alias(dummy, __aio_atfork)`) out of `_Fork.c`
# into its own `src/process/post_Fork.c` — which breaks the accidental
# coupling: `__clone`/posix_spawn/pthread_create then never pull `_Fork.c`
# (so never reference capture_stack) unless a caller ACTUALLY calls fork().
# capture_stack itself is deliberately kept OFF wasm-host-imports.nix even
# after the split, so a non-asyncified binary that genuinely reaches fork()
# still fails to LINK loudly (the whole point of this gate) rather than
# silently TypeError-ing at runtime. So the intended POST-SPLIT contract —
# what PR-2 flips `expected.mmu-fork` to below — is
# fork=NEEDS_CAPTURE_STACK / spawn=LINKED: genuinely discriminating between
# "this program calls fork() and must be asyncified" and "this program only
# spawns/threads and needs nothing extra". `fork=LINKED` would ONLY become
# correct if some FUTURE change also added capture_stack to the shared
# allow-list — which is explicitly not part of PR-2's plan, so this probe
# (and CLAUDE.md's mirroring `.#guest-spawn-contract-fork` sweep note) must
# not describe that outcome as pending. Until the split lands, TODAY's
# fork=NEEDS_CAPTURE_STACK / spawn=NEEDS_CAPTURE_STACK stands, and it is
# ALSO the reason the closure-wide sweep's "exactly 2 modules import
# capture_stack" count (flake.nix's expectCaptureStackCount) is only
# meaningful once the split lands: before it, that count could not
# distinguish "a module calls fork()" from "a module merely spawns" — after
# it, capture_stack-importing becomes synonymous with "genuinely calls
# fork()", and the pinned count is a real, non-false-positive-machine
# regression guard for exactly that. Shipping the default-flip WITHOUT the
# split would make every posix_spawn-only program need capture_stack too,
# defeating the count's discriminating power entirely.
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
    # -w (whole-word match), NOT plain -q: "undefined symbol: fork" is a
    # literal PREFIX of "undefined symbol: forkpty" (and any other fork*
    # symbol), so an unanchored substring match would misclassify a
    # forkpty/forkfoo undefined-symbol error as this probe's own
    # `fork=ABSENT` case (nix-wasm#202, found by review). -w requires the
    # matched text not be immediately followed by another word character, so
    # "undefined symbol: forkpty" no longer matches "undefined symbol: fork".
    if $CC ${extraArgs} ${./uses-fork.c} -o fork.wasm 2>fork.err; then
      echo "fork=LINKED" >> $out/result
    elif grep -qw "undefined symbol: fork" fork.err; then
      echo "fork=ABSENT" >> $out/result
    elif grep -qw "undefined symbol: capture_stack" fork.err; then
      echo "fork=NEEDS_CAPTURE_STACK" >> $out/result
    else
      echo "fork=OTHER_ERROR" >> $out/result; cat fork.err >> $out/result
    fi
    if $CC ${extraArgs} ${./uses-spawn.c} -o spawn.wasm 2>spawn.err; then
      echo "spawn=LINKED" >> $out/result
    elif grep -qw "undefined symbol: capture_stack" spawn.err; then
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
