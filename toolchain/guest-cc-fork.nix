# The in-guest fork() compiler driver — `cc-fork` (Phase 2 T1b capstone). Compiles
# a C program INSIDE the guest into a real fork()-capable wasm executable, the same
# way the host asyncify-cc.nix path does, but entirely from guest-resident tools:
#   1. clang compiles the .c (toolchain/guest-clang.nix);
#   2. wasm-ld links it, with the musl-fork libc.a (the capture_stack seam _Fork)
#      pulled FIRST so fork() takes the asyncify path;
#   3. the in-guest wasm-opt (toolchain/guest-binaryen.nix) runs --asyncify,
#      addlist-bounded to the fork call graph (the GOT-indirect capture_stack call
#      means reachability finds nothing → addlist force-instruments the frames).
# All three are Nix store paths served read-only over 9P in the /nix closure.
#
# Separate from the canonical `cc` (guest-cc.nix) so that stays byte-identical;
# `cc-fork prog.c -o prog && ./prog` is the interactive in-guest fork build.
{ pkgs, guestClang, ccSysroot, guestBinaryen, muslFork }:
let
  clang = "${guestClang}/bin/clang";
  ld = "${guestClang}/bin/wasm-ld";
  sr = "${ccSysroot}/sys";
  wasmOpt = "${guestBinaryen}/bin/wasm-opt";
  forkLib = "${muslFork}/lib/libc.a";
in
pkgs.writeTextFile {
  name = "guest-cc-fork";
  destination = "/bin/cc-fork";
  executable = true;
  text = ''
    #!/bin/sh
    # cc-fork — compile a C program into a real fork()-capable wasm executable,
    # entirely in-guest. Usage: cc-fork prog.c [-o prog] [cflags...]
    #
    # No `set -e` (busybox ash, like guest-cc): fail explicitly via `|| exit`.

    SR=${sr}
    CLANG=${clang}
    LD=${ld}
    WASM_OPT=${wasmOpt}
    FORK_LIB=${forkLib}
    TARGET="--target=wasm32-unknown-unknown -fPIC --sysroot=$SR/musl -resource-dir=$SR/clang"
    FEAT="-Xclang -target-feature -Xclang +atomics -Xclang -target-feature -Xclang +bulk-memory"
    # Link flags mirror the host asyncify-cc path: import-undefined keeps
    # capture_stack an import; --gc-sections + the usual dylink module flags.
    LDADD="-shared --gc-sections --no-merge-data-segments --no-entry --export-all \
      --import-memory --shared-memory --max-memory=4294967296 --import-undefined --import-table"

    out=
    srcs=
    cflags=
    while [ $# -gt 0 ]; do
    	case "$1" in
    		-o) out=$2; shift ;;
    		-isystem | -iquote | -idirafter | -imacros | -isysroot | -include | -I | -D | -U \
    			| -MF | -MT | -MQ | -x | -Xclang | -Xpreprocessor)
    			cflags="$cflags $1 $2"; shift ;;
    		*.c) srcs="$srcs $1" ;;
    		-*) cflags="$cflags $1" ;;
    		*) ;;
    	esac
    	shift
    done

    [ -n "$out" ] || out=a.out
    objs=
    for s in $srcs; do
    	o="''${s%.c}.o"
    	# shellcheck disable=SC2086
    	"$CLANG" $TARGET $FEAT $cflags -c "$s" -o "$o" || exit 1
    	objs="$objs $o"
    done

    # Link to a pre-asyncify module: musl-fork's libc.a FIRST so its seam _Fork
    # (capture_stack) overrides the sysroot's clone-syscall _Fork; everything else
    # is byte-identical so no ODR risk.
    pre="$out.pre"
    # shellcheck disable=SC2086
    "$LD" -m wasm32 -L"$SR/clang/lib/wasm32-unknown-unknown" -L"$SR/musl/lib" \
    	"$SR/musl/lib/crt1.o" $objs "$FORK_LIB" $LDADD \
    	-lc "$SR/clang/lib/wasm32-unknown-unknown/libclang_rt.builtins.a" -o "$pre" || exit 1

    # In-guest asyncify: env.capture_stack is the unwind point. NO addlist —
    # asyncify's reachability from the (directly-called) import instruments the
    # whole transitive fork call graph automatically, at any call depth.
    "$WASM_OPT" "$pre" --asyncify \
    	--pass-arg=asyncify-imports@env.capture_stack \
    	-o "$out" || exit 1
    # wasm-opt writes 0644; the guest binfmt loader needs the +x bit to exec it.
    chmod +x "$out"
    rm -f "$pre"
  '';
}
