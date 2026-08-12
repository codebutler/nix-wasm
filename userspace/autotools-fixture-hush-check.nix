# autotools-fixture-hush-check.nix — P2-1 (2026-08-12 review): an on-demand,
# HOST-side, hermetic reproduction of the KNOWN hush parser gap that blocks
# autotools-fork-smoke.mjs's CFGRC today.
#
# THE GAP: autotools' generated `configure` uses a VARIABLE-fd redirect
# (`as_fn_error`'s `>&$4` — the fd number is a shell VARIABLE, not a literal
# `>&5`) for its diagnostic-logging helper. Busybox hush's parser does not
# accept that form; this — not anything wasm/NOMMU/fork-specific — is the
# actual source of the classic "hush: ambiguous redirect" / "hush: syntax
# error at 'fi'" failures CLAUDE.md's "In-guest autotools also works" caveat
# documents. The #189 hush measurement matrix only exercised LITERAL fds
# (e.g. `>&5`), which is why it reported "every autoconf idiom clean" without
# catching this — a REAL generated `configure` (this fixture's, or any
# other's) hits the variable-fd form immediately, in its own preamble.
#
# A SEPARATE change (a patch under patches/busybox/ hush, not this file)
# fixes hush's parser; this derivation is the regression PROOF for that fix,
# not a fix itself — so it is expected to FAIL until that patch lands.
#
# WHY STOCK nixpkgs busybox (native), not nix-wasm's own patched-for-wasm
# busybox: the bug is in hush's PARSER — a plain upstream limitation with no
# dependency on any of this repo's NOMMU/clone-spawn source patches — and
# nix-wasm's own busybox only builds for the wasm32 cross target, which
# cannot execute on the Nix build host at all (there is no way to run it
# here). Once the sibling hush patch lands in patches/busybox/, point
# `hushBusybox` below at a NATIVE build carrying that same patch (native
# stdenv, not `cross.stdenv`) to make this an exact proof instead of a
# representative one.
#
# NOT wired into any default build (`.#autotools-fixture` does not depend on
# this) or any CI job — `nix build .#autotools-fixture-hush-check -L` is a
# manual, on-demand check. Deliberately not gating: gating it today would
# either hard-fail `nix build .#autotools-fixture` (this repo's actual
# default build path) on a KNOWN, already-tracked, already-being-fixed gap,
# or need an assert-inversion ("expected to currently fail") that silently
# goes stale the moment the sibling patch lands and nobody remembers to flip
# it — worse than no automation at all. Once the sibling patch is in this
# tree, wiring this check into CI (asserting PASS, non-soak) is the natural
# follow-up.
{ pkgs, fixture }:
let
  hushBusybox = pkgs.busybox.override {
    extraConfig = ''
      CONFIG_HUSH y
    '';
  };
in
pkgs.runCommand "autotools-fixture-hush-check" { nativeBuildInputs = [ hushBusybox ]; } ''
  cp ${fixture}/configure.ac ${fixture}/configure ${fixture}/Makefile.in ${fixture}/prog.c .
  chmod -R u+w .
  chmod +x configure

  # The sandbox environment MUST be neutralized for this to test anything
  # real, in TWO independent ways autoconf's generated preamble uses to
  # dodge a bad current shell — both need defeating, not just one:
  #  1. nixpkgs' stdenv setup.sh EXPORTS `CONFIG_SHELL` (and `SHELL`)
  #     pointing at bash. The preamble's very first check
  #     (`test "x$CONFIG_SHELL" != x`) immediately `exec`s that shell,
  #     bypassing hush before a single real line of `configure` runs — a
  #     first cut of this check did exactly that (reached "checking for
  #     gcc" instead of hush's parser at all, because it was silently
  #     running under bash the whole time).
  #  2. Failing that, the preamble's shell-hunting loop tries a hardcoded
  #     candidate list of absolute paths (`/bin/sh`, `/usr/bin/sh`, …) —
  #     harmless in the sandbox (none exist) — and, as a last resort,
  #     `$SHELL` again by absolute path. Both must be gone too.
  # `unset` both, then set PATH to busybox-only — matching the booted guest,
  # whose PATH is busybox applets only with no separate bash — so the
  # preamble finds nothing better and falls through to actually running
  # under hush. Confirmed by hand: `env -i PATH=<busybox-bin>
  # busybox hush ./configure` gives the exact "hush: ambiguous redirect" /
  # "hush: syntax error at 'fi'" failure this derivation's header cites;
  # without BOTH neutralizations, this check validates nothing.
  unset CONFIG_SHELL SHELL
  export PATH="${hushBusybox}/bin"

  set +e
  busybox hush ./configure > configure.log 2>&1
  rc=$?
  set -e
  cat configure.log

  if [ "$rc" -ne 0 ]; then
    cat >&2 <<EOF

  FAIL: busybox hush could not parse/run the generated configure (rc=$rc).
  This is the KNOWN variable-fd-redirect gap documented at the top of this
  derivation (as_fn_error's '>&\$4') — expected until the sibling hush patch
  (patches/busybox/) lands. Re-run this check after that patch to confirm
  the fix (it should then exit 0).
  EOF
    exit 1
  fi

  echo "PASS: busybox hush parsed and ran the generated configure cleanly." | tee "$out"
''
