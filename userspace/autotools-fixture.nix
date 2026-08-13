# autotools-fixture.nix — the 2026-08-05 MMU ship-plan Phase-1 precondition's
# TOOLCHAIN half: a minimal but REAL autoconf'd C project, staged into the
# software-MMU/real-fork guest by runtime/demo/node/autotools-fork-smoke.mjs to
# run a genuine `./configure && make && ./prog` against the in-guest cc/make.
# (The SHELL half is already boot-verified — nix-wasm#188/#189, CLAUDE.md's
# "In-guest autotools also works" caveat — stock hush on the fork guest handles
# every autoconf idiom the NOMMU forkshell-ash hacks exist to fake.)
#
# Built ENTIRELY with NATIVE tooling (pkgs.buildPackages.autoconf) at Nix-build
# time: `autoconf` runs HERE, on the build host, to turn configure.ac into a
# real, runnable `configure` shell script. This derivation performs NO
# compilation and installs NO binary — its $out is nothing but a plain,
# unbuilt source tree (configure.ac, the generated configure, a hand-written
# CLASSIC (non-automake — no Makefile.am, no aclocal/automake dependency)
# Makefile.in, and prog.c). The in-guest smoke copies this tree into the
# booted guest's writable ramfs and runs the real toolchain there — this
# derivation's own (native) autoconf never touches $CC.
#
# configure.ac stays HONEST: AC_PROG_CC + two real AC_CHECK_HEADERS probes, no
# faked/skipped checks. `./configure` therefore genuinely runs "checking
# whether the C compiler works" / "checking for stdio.h" etc. against whatever
# $CC resolves to at guest run time — proving the IN-GUEST cc, not this
# derivation's native one. No AC_CONFIG_HEADERS/config.h: the classic `@DEFS@`
# substitution (plain -DHAVE_STDIO_H=1-style command-line defines) keeps the
# fixture's file list exactly {configure.ac, configure, Makefile.in, prog.c} —
# one less generated artifact for the in-guest `make` to depend on correctly.
{ pkgs }:
let
  configureAc = pkgs.writeText "configure.ac" ''
    dnl autotools-fixture: a minimal but real (non-automake) autoconf project.
    dnl AC_PROG_CC and the AC_CHECK_HEADERS probes are genuine compiler/header
    dnl checks — this is what runs in-guest against the wasm cc.
    AC_INIT([autotools-fixture], [1.0], [nobody@example.invalid])
    AC_CONFIG_SRCDIR([prog.c])
    AC_PROG_CC
    AC_CHECK_HEADERS([stdio.h unistd.h])
    AC_CHECK_FUNCS([printf])
    AC_CONFIG_FILES([Makefile])
    AC_OUTPUT
  '';

  # Classic (pre-automake) Makefile.in: @CC@/@CFLAGS@/@CPPFLAGS@/@DEFS@ are the
  # standard configure output substitutions; @DEFS@ carries the
  # -DHAVE_STDIO_H=1-style defines AC_CHECK_HEADERS/AC_CHECK_FUNCS produce.
  makefileIn = pkgs.writeText "Makefile.in" ''
    # Makefile.in — generated to Makefile by ./configure (AC_CONFIG_FILES).
    srcdir = @srcdir@
    CC = @CC@
    CFLAGS = @CFLAGS@
    CPPFLAGS = @CPPFLAGS@
    DEFS = @DEFS@

    all: prog

    prog: $(srcdir)/prog.c
    	$(CC) $(DEFS) $(CPPFLAGS) $(CFLAGS) -o prog $(srcdir)/prog.c

    clean:
    	rm -f prog

    .PHONY: all clean
  '';

  # The distinctive marker + exit status the smoke asserts: stdout must
  # contain AUTOTOOLS_FIXTURE_OK AND the process must exit 0. HAVE_STDIO_H is
  # real configure output (from the AC_CHECK_HEADERS probe above), not a
  # hardcoded assumption — on any toolchain where stdio.h is genuinely
  # missing, this program would compile (empty main) but print nothing, which
  # would correctly fail the smoke's marker assertion rather than silently
  # passing.
  progC = pkgs.writeText "prog.c" ''
    /* prog.c — the autotools-fixture payload. Built by the in-guest cc via
       the Makefile ./configure generates from Makefile.in. */
    #if HAVE_STDIO_H
    #include <stdio.h>
    #endif

    int
    main (void)
    {
    #if HAVE_STDIO_H
      printf ("AUTOTOOLS_FIXTURE_OK\n");
    #endif
      return 0;
    }
  '';
in
pkgs.stdenv.mkDerivation {
  pname = "autotools-fixture";
  version = "1.0";
  dontUnpack = true;
  # The generated `configure`'s shebang MUST stay the generic `#!/bin/sh` —
  # nixpkgs' default fixupPhase patches shebangs to an absolute BUILD-HOST
  # store path (bash), which does not exist in the guest this fixture is
  # staged into. The smoke also invokes it as `sh ./configure` defensively
  # (never relies on the shebang/exec bit at all), but this keeps the tree
  # itself portable — a plain `./configure` on ANY POSIX host (this
  # derivation's own host sanity check included) resolves `/bin/sh` locally.
  dontPatchShebangs = true;
  # NATIVE autoconf (buildPackages) — this runs on the BUILD host, not the
  # wasm cross target; there is no cross toolchain involved anywhere in this
  # derivation at all.
  nativeBuildInputs = [ pkgs.buildPackages.autoconf ];

  buildPhase = ''
    runHook preBuild
    mkdir -p src
    cp ${configureAc} src/configure.ac
    cp ${makefileIn} src/Makefile.in
    cp ${progC} src/prog.c
    ( cd src && autoconf )
    # Sanity: the generated configure must be a REAL, runnable script that
    # actually probes a C compiler — not a stub. Catches a future autoconf
    # version bump that silently changed the macro's expansion here, at
    # fixture-BUILD time, rather than 300 miles away in a guest CI boot.
    grep -q 'checking whether the C compiler works' src/configure
    chmod +x src/configure
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp src/configure.ac src/configure src/Makefile.in src/prog.c "$out"/
    runHook postInstall
  '';

  meta.description = "Minimal real autoconf'd C project (configure/Makefile.in/prog.c), staged into the guest for the real-fork autotools acceptance smoke";
}
