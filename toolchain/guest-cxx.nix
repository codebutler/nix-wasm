# The in-guest `c++` driver — the C++ companion to toolchain/guest-cc.nix. Same
# clang + wasm-ld (toolchain/guest-clang.nix) and cc-sysroot (toolchain/
# cc-sysroot.nix, now carrying sys/cxx = the nix-built libc++ headers + libs),
# all Nix store paths in the /nix closure, referenced by absolute store path.
#
# Adds, over `cc`: the libc++ header path (-nostdinc++ -isystem …/c++/v1), wasm
# exception handling (-fwasm-exceptions, the model libc++ was built with), the
# libc++ visibility-annotation disables (match the hermetic/hidden libcxx build),
# and the libc++/libc++abi/libunwind link. The dylink-module link flags are
# identical to guest-cc (incl. --gc-sections, which drops crt1.o's dead weak-main
# forwarder so `int main()`/`int main(void)` link without a dangling
# __main_argc_argv import). Compile + link are SEPARATE clang/wasm-ld execs (the
# wasm/NOMMU kernel runs each as its own process).
#
# A `c++` driver compiles every source as C++ (like g++) — `-x c++` is forced.
{ pkgs, guestClang, ccSysroot }:
let
  clang = "${guestClang}/bin/clang";
  ld = "${guestClang}/bin/wasm-ld";
  sr = "${ccSysroot}/sys";
in
pkgs.writeTextFile {
  name = "guest-cxx";
  destination = "/bin/c++";
  executable = true;
  text = ''
    #!/bin/sh
    # c++ — a minimal C++ driver for the wasm32-linux guest (#139 Layer 3 stdenv).
    #
    # Wraps clang (compile, forced C++) + wasm-ld (link) against the cc-sysroot's
    # musl + libc++, all Nix store paths in the /nix closure. Recognizes the common
    # driver flags — enough for simple C++ packages. Compile + link are SEPARATE
    # clang/wasm-ld execs (the wasm/NOMMU kernel runs each as its own process).
    #
    # NB: no `set -e` (see guest-cc) — busybox hush exits the script when the
    # arg-parse while-loop's final condition sets $?=1. We `|| exit` instead.

    SR=${sr}
    CLANG=${clang}
    LD=${ld}
    TARGET="--target=wasm32-unknown-unknown -fPIC --sysroot=$SR/musl -resource-dir=$SR/clang \
      -nostdinc++ -isystem $SR/cxx/include/c++/v1"
    # -D__linux__ is REQUIRED: the target is wasm32-unknown-*unknown* (clang rejects
    # the -linux- triple), so libc++'s __config can't auto-select the pthread thread
    # API and errors "No thread API". -D__linux__ (matching nix.wasm's own C++ link)
    # makes it pick pthread; -D_GNU_SOURCE matches the musl feature set.
    FEAT="-D__linux__ -D_GNU_SOURCE \
      -Xclang -target-feature -Xclang +atomics -Xclang -target-feature -Xclang +bulk-memory \
      -fwasm-exceptions -D__USING_WASM_EXCEPTIONS__ \
      -D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS -D_LIBCXXABI_DISABLE_VISIBILITY_ANNOTATIONS"
    # --allow-undefined (vs cc's --import-undefined alone): C++ wasm-EH references
    # the host-provided __cpp_exception tag, which --import-undefined doesn't import
    # (it's an exception tag, not a function); --allow-undefined imports it, exactly
    # as nix.wasm's own C++ link does. The remaining env imports are the standard
    # runtime ABI (memory/table/bases, __wasm_abort, __wasm_syscall_*, logAPIs).
    LDADD="-shared --gc-sections --no-merge-data-segments --no-entry --export-all \
      --import-memory --shared-memory --max-memory=4294967296 --import-undefined --allow-undefined --import-table"

    compile_only=0
    out=
    srcs=
    objs=
    cflags=
    ldflags=
    libs=
    while [ $# -gt 0 ]; do
    	case "$1" in
    		-c) compile_only=1 ;;
    		-o) out=$2; shift ;;
    		# Two-arg flags whose VALUE is the next argument (see guest-cc.nix — these
    		# MUST consume both, else the value was silently dropped).
    		-isystem | -iquote | -idirafter | -imacros | -isysroot | -include | -I | -D | -U \
    			| -MF | -MT | -MQ | -x | -Xclang | -Xpreprocessor)
    			cflags="$cflags $1 $2"; shift ;;
    		-Xlinker) ldflags="$ldflags $2"; shift ;;
    		-Wl,*) for a in $(printf '%s' "''${1#-Wl,}" | tr , ' '); do ldflags="$ldflags $a"; done ;;
    		-l*) libs="$libs $1" ;;
    		-L*) ldflags="$ldflags $1" ;;
    		-I* | -D* | -U* | -O* | -std=* | -M* | -W* | -g | -g* | -f* | -m* | -pipe | -pedantic | -ansi) cflags="$cflags $1" ;;
    		@*) cflags="$cflags $1" ;;
    		*.cc | *.cpp | *.cxx | *.c++ | *.C | *.c) srcs="$srcs $1" ;;
    		*.o | *.a) objs="$objs $1" ;;
    		-*) cflags="$cflags $1" ;; # unknown flag → treat as a compile flag
    		*) ;;
    	esac
    	shift
    done

    # Compile each source to a .o (forced C++, like g++).
    for s in $srcs; do
    	o="''${s%.*}.o"
    	if [ "$compile_only" = 1 ] && [ -n "$out" ]; then o="$out"; fi
    	# shellcheck disable=SC2086
    	"$CLANG" $TARGET $FEAT $cflags -x c++ -c "$s" -o "$o" || exit 1
    	objs="$objs $o"
    done

    if [ "$compile_only" = 1 ]; then exit 0; fi

    [ -n "$out" ] || out=a.out
    # libc++ → libc++abi (unwind shim folded in) → libunwind → libc, then builtins.
    # shellcheck disable=SC2086
    "$LD" -m wasm32 -L"$SR/clang/lib/wasm32-unknown-unknown" -L"$SR/musl/lib" -L"$SR/cxx/lib" \
    	"$SR/musl/lib/crt1.o" $objs $ldflags $libs $LDADD \
    	-lc++ -lc++abi -lunwind -lc "$SR/clang/lib/wasm32-unknown-unknown/libclang_rt.builtins.a" \
    	-o "$out" || exit 1
  '';
}
