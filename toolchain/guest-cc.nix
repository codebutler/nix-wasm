# The in-guest `cc` driver — a minimal POSIX-sh wrapper over clang + wasm-ld
# (toolchain/guest-clang.nix) and the cc-sysroot (toolchain/cc-sysroot.nix), all
# now Nix store paths in the /nix closure (served read-only over 9P). The wrapper
# references them by absolute store path — no `/opt/bin`, no cpio, no /tmp
# extraction (the sysroot is read directly from the store mount). Lands at
# $out/bin/cc → on PATH via the system profile, exactly like any other package.
#
# Compile + link are SEPARATE clang/wasm-ld execs: the wasm/NOMMU kernel runs
# each as its own process (no in-process clang→linker spawn). Flags mirror the
# guest dylink-module link the rest of the guest userspace uses.
{ pkgs, guestClang, ccSysroot }:
let
  clang = "${guestClang}/bin/clang";
  ld = "${guestClang}/bin/wasm-ld";
  sr = "${ccSysroot}/sys";
  # Shared no-undef allow-list (#52): the only symbols a `cc`-driven link may
  # leave undefined are the host-provided imports. A stray fork/exec then fails
  # the link instead of becoming a dangling env.* import.
  allowUndefined = import ./wasm-host-imports.nix { inherit pkgs; };
in
pkgs.writeTextFile {
  name = "guest-cc";
  destination = "/bin/cc";
  executable = true;
  text = ''
    #!/bin/sh
    # cc — a minimal C driver for the wasm32-linux guest (#139 Layer 3 stdenv).
    #
    # Wraps clang (compile) + wasm-ld (link) against the cc-sysroot, all Nix store
    # paths in the /nix closure. Recognizes the common driver flags — enough for
    # simple C packages; complex builds (autotools probes, odd linker flags) may
    # need more. Compile + link are SEPARATE clang/wasm-ld execs (the wasm/NOMMU
    # kernel runs each as its own process; we don't make clang spawn the linker).
    #
    # NB: no `set -e` — busybox hush exits the script when a while-loop's final
    # (false) condition sets $?=1, which would kill us right after arg parsing. We
    # fail explicitly via `|| exit` on the compile/link steps instead.

    SR=${sr}
    CLANG=${clang}
    LD=${ld}
    TARGET="--target=wasm32-unknown-unknown -fPIC --sysroot=$SR/musl -resource-dir=$SR/clang"
    FEAT="-Xclang -target-feature -Xclang +atomics -Xclang -target-feature -Xclang +bulk-memory"
    # --gc-sections (paired with --export-all, which roots every named symbol) drops
    # only truly-dead leftovers — notably crt1.o's overridden-weak `main` forwarder,
    # which references `__main_argc_argv`. clang emits `__main_argc_argv` only for
    # `int main(int,char**)`; for `int main(void)` it emits `__main_void`/`main`, so
    # that forwarder's reference dangles into an unsatisfied `env.__main_argc_argv`
    # import and the module fails to instantiate (SIGILL at startup). GC'ing the dead
    # forwarder removes the dangling import while keeping all exported entry points.
    # No-undef contract (#52): allow ONLY the host-provided imports in the shared
    # allow-list (NOT a blanket --import-undefined, which made EVERY undefined
    # symbol an import — so a missing function or a stray fork silently became a
    # dangling env.* import that trapped at instantiation). Any other undefined
    # symbol now fails the link loudly. Memory/table/bases come from
    # --import-memory/--import-table; the rest from the kernel/runtime bridge.
    LDADD="-shared --gc-sections --no-merge-data-segments --no-entry --export-all \
      --import-memory --shared-memory --max-memory=4294967296 --allow-undefined-file=${allowUndefined} --import-table"

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
    		# Two-arg compile flags: the VALUE is the next argument. These MUST consume
    		# both — otherwise the value (a path/name, not matching -*/*.c) fell through
    		# to the *) catch-all and was silently dropped, corrupting the compile
    		# (e.g. `-isystem /inc` lost `/inc`; `-MF dep.d` lost the depfile name).
    		-isystem | -iquote | -idirafter | -imacros | -isysroot | -include | -I | -D | -U \
    			| -MF | -MT | -MQ | -x | -Xclang | -Xpreprocessor)
    			cflags="$cflags $1 $2"; shift ;;
    		-Xlinker) ldflags="$ldflags $2"; shift ;;          # raw linker arg → link
    		-Wl,*) # clang-style -Wl,a,b,c → pass a b c to the linker (we drive wasm-ld)
    			for a in $(printf '%s' "''${1#-Wl,}" | tr , ' '); do ldflags="$ldflags $a"; done ;;
    		-l*) libs="$libs $1" ;;
    		-L*) ldflags="$ldflags $1" ;;
    		# Depfile single-arg flags (-MMD/-MD/-MP/-MM/-M/-MG) and the rest are compile
    		# flags. -M* must come AFTER the two-arg -MF/-MT/-MQ cases above.
    		-I* | -D* | -U* | -O* | -std=* | -M* | -W* | -g | -g* | -f* | -m* | -pipe | -pedantic | -ansi) cflags="$cflags $1" ;;
    		@*) cflags="$cflags $1" ;; # response file — clang expands it at compile
    		*.c) srcs="$srcs $1" ;;
    		*.o | *.a) objs="$objs $1" ;;
    		-*) cflags="$cflags $1" ;; # unknown flag → treat as a compile flag
    		*) ;;
    	esac
    	shift
    done

    # Compile each .c to a .o
    for s in $srcs; do
    	o="''${s%.c}.o"
    	if [ "$compile_only" = 1 ] && [ -n "$out" ]; then o="$out"; fi
    	# shellcheck disable=SC2086
    	"$CLANG" $TARGET $FEAT $cflags -c "$s" -o "$o" || exit 1
    	objs="$objs $o"
    done

    if [ "$compile_only" = 1 ]; then exit 0; fi

    [ -n "$out" ] || out=a.out
    # shellcheck disable=SC2086
    "$LD" -m wasm32 -L"$SR/clang/lib/wasm32-unknown-unknown" -L"$SR/musl/lib" \
    	"$SR/musl/lib/crt1.o" $objs $ldflags $libs $LDADD \
    	-lc "$SR/clang/lib/wasm32-unknown-unknown/libclang_rt.builtins.a" -o "$out" || exit 1
  '';
}
