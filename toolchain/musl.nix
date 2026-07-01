# musl libc 1.2.5 for the wasm32-linux-musl NOMMU guest, built with stock clang-21.
#
# Patch stack (order matters):
#   0000  harness base wasm-arch port (adds arch/wasm; extracted from the
#         joelseverin/linux-wasm harness commit a72025e — "minimal and incorrect")
#   0001..0007  pc's fixes on top (clone tls/ctid, file-backed utmp, exact
#         syscall arity ×3, per-thread LLVM TLS block, seed page_size before
#         ctors). See the patch headers.
#
# Compiled against compiler-rt (--rtlib via LIBCC). No other deps — musl is the
# base of the sysroot.
{ pkgs, compilerRt }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
in
pkgs.stdenv.mkDerivation {
  pname = "musl-wasm32-nommu";
  version = "1.2.5";

  # musl 1.2.5 official release tarball (== git tag v1.2.5 = 7fd8de89, which the
  # harness patch was generated against). Reuse nixpkgs' pinned src — no hash to
  # manage, already cached.
  src = pkgs.musl.src;

  patches = [
    ../patches/musl/0000-harness-wasm-arch.patch
    ../patches/musl/0001-clone-varargs-tls-ctid.patch
    ../patches/musl/0002-utmp-file-backed.patch
    ../patches/musl/0003-setxid-exact-syscall-arity.patch
    ../patches/musl/0004-misc-exact-syscall-arity.patch
    ../patches/musl/0005-wasm-per-thread-llvm-tls-block.patch
    ../patches/musl/0006-wasm-seed-page-size-before-ctors.patch
    ../patches/musl/0007-fork-clone-exact-syscall-arity.patch
    # 0008: detached-thread exit (__unmapself) can't do the native stack-switch
    # dance on wasm (CRTJMP abort()s) → munmap+exit inline instead. Fixes GLib
    # GThreadPool worker exit → SIGILL that blocked GTK apps (gtk3-widget-factory).
    ../patches/musl/0008-wasm-unmapself-no-stack-switch.patch
    # 0009 (#126 Track C / #130): real dlopen/dlsym/dlclose on wasm. The libc
    # reads the side-module file + allocates its data region from the process
    # arena; the ENGINE instantiates/links it (runtime/dylink.js via the
    # __wasm_dl_probe/__wasm_dlopen/__wasm_dlsym host imports — ENGINE_ABI 8,
    # allow-listed in wasm-host-imports.nix). Also resolves the long-dangling
    # __dlsym_time64 import (dlfcn.h's time64 __REDIR of dlsym) to a REAL
    # dlsym. dlclose is leak-until-exit (table slots can't be reclaimed).
    ../patches/musl/0009-wasm-dlopen-dlsym-host-loader.patch
  ];

  nativeBuildInputs = [ bt ];
  dontStrip = true;

  # ROOT FIX for `int main(void)` / `int main()` programs (autoconf's "C compiler
  # cannot create executables" link-test, and most configure feature probes).
  # clang lowers `int main(int,char**)` → `__main_argc_argv`, but `int main(void)`
  # / `int main()` → a 2-arg `main` symbol. The harness crt provided a 3-arg
  # `main(argc,argv,envp)` wrapper, which signature-mismatches clang's 2-arg
  # `main` → autoconf aborts → no autoconf dep builds. Make everything 2-arg
  # consistent: a WEAK 2-arg crt `main` wrapper (so a program's own 2-arg `main`
  # cleanly overrides it; argc/argv programs keep the wrapper bridging to
  # __main_argc_argv), and have musl's startup call `main` with 2 args. This is
  # the high-leverage fix that lets stock autoconf/cmake packages cross-build
  # patch-free (retires the per-dep overlays).
  postPatch = ''
    substituteInPlace arch/wasm/crt_arch.h \
      --replace-fail 'int main(int argc, char *argv[], char *envp[])' \
                     '__attribute__((__weak__)) int main(int argc, char *argv[])' \
      --replace-fail '	(void)envp;
' ""
    substituteInPlace src/env/__libc_start_main.c \
      --replace-fail 'exit(main(argc, argv, envp));' \
                     'exit(((int(*)(int,char**))(void*)main)(argc, argv));'
    # Clean-NOMMU spawn contract: wasm has no fork()/vfork() (return-twice needs a
    # multi-shot continuation, which no shipped engine provides — see
    # docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md). Remove the
    # symbols so a caller fails to LINK in its Nix build (loud, traceable) instead of
    # SIGILL/abort at runtime. posix_spawn (clone-with-fn) is the spawn contract;
    # musl's system()/popen() already route through it.
    # fork(): drop the function (lines `pid_t fork(void)` … first column-0 `}`),
    # keeping fork.c's lock/atfork weak-aliases that other TUs depend on.
    sed -i '/^pid_t fork(void)/,/^}/d' src/process/fork.c
    # vfork(): the whole TU is just the function — empty it so no symbol remains.
    : > src/process/vfork.c
    # posix_fallocate: emulate when the filesystem has no fallocate, like glibc.
    # On the NOMMU wasm guest CONFIG_SHMEM is gated off behind MMU (kernel.nix),
    # so tmpfs falls back to ramfs and NO mounted fs implements ->fallocate — the
    # fallocate(2) syscall returns EOPNOTSUPP everywhere. musl upstream just
    # forwards that error, but glibc (what every real system runs) emulates by
    # ensuring the file size, so posix_fallocate succeeds. Without this,
    # libwayland-cursor's wl_cursor_theme_load fails to size its wl_shm pool and
    # every GTK cursor logs "Unable to load <name> from the cursor theme" (GDK's
    # window buffers escape this only because they use ftruncate, not
    # posix_fallocate). On an in-memory fs ensuring the size IS the allocation
    # (pages fault in on write), matching what the fallocate syscall does on a
    # real system's tmpfs.
    #
    # CRITICAL: call the fallocate() WRAPPER, never a raw __syscall(SYS_fallocate,
    # …). The wrapper splits the 64-bit offset/len into the 6-arg __wasm_syscall_6
    # form the kernel's sys_fallocate (loff_t args) expects; a bare 4-arg
    # __wasm_syscall_4 dispatch traps with a call_indirect signature mismatch
    # ("null function or function signature mismatch") and PANICS the guest — same
    # arity-mismatch hazard the kernel-worker futex shim (nr=422) documents. This
    # bit busybox forkshell's posix_fallocate on its spawn-state temp file.
    cat > src/fcntl/posix_fallocate.c <<'EOF'
#define _GNU_SOURCE
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <sys/stat.h>

int posix_fallocate(int fd, off_t base, off_t len)
{
	/* Native fallocate first (real filesystems keep native behaviour). Use the
	 * fallocate() wrapper — a raw 4-arg __syscall traps on the wasm port. */
	if (fallocate(fd, 0, base, len) == 0)
		return 0;
	int e = errno;
	if (e != EOPNOTSUPP && e != ENOSYS)
		return e;

	/* Filesystem has no fallocate (ramfs on the NOMMU wasm guest). Emulate
	 * like glibc: validate, then ensure the file is at least base+len bytes. */
	if (base < 0 || len < 0)
		return EINVAL;
	if (len && base > (off_t)((~(unsigned long long)0) >> 1) - len)
		return EFBIG;

	struct stat st;
	if (fstat(fd, &st) < 0)
		return errno;
	if (S_ISFIFO(st.st_mode))
		return ESPIPE;
	if (!S_ISREG(st.st_mode))
		return ENODEV;

	if (st.st_size < base + len && ftruncate(fd, base + len) < 0)
		return errno;
	return 0;
}
EOF
  '';

  configurePhase = ''
    runHook preConfigure
    ./configure \
      --target=wasm --prefix=$out --disable-shared \
      CC=${llvm.clang-unwrapped}/bin/clang \
      AR=${bt}/bin/llvm-ar RANLIB=${bt}/bin/llvm-ranlib \
      CFLAGS="--target=wasm32-unknown-unknown -D__linux__ -fPIC -matomics -mbulk-memory" \
      LIBCC="${compilerRt}/lib/wasm32-unknown-unknown/libclang_rt.builtins.a"
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make -j$NIX_BUILD_CORES AR=${bt}/bin/llvm-ar RANLIB=${bt}/bin/llvm-ranlib
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    make install
    # A minimal wasm reactor crt. Packages whose build links a shared library
    # (e.g. bzip2's Makefile, unconditionally) make clang demand crt1-reactor.o
    # for the wasm `-shared` link. The resulting .so is unused (the guest links
    # the static .a into nix.wasm), but the link must succeed. _initialize runs
    # the module's constructors, the reactor-model entry point.
    cat > reactor.c <<'EOF'
    extern void __wasm_call_ctors(void);
    __attribute__((export_name("_initialize"))) void _initialize(void) { __wasm_call_ctors(); }
    EOF
    ${llvm.clang-unwrapped}/bin/clang --target=wasm32-unknown-unknown \
      -matomics -mbulk-memory -fPIC -c reactor.c -o $out/lib/crt1-reactor.o
    runHook postInstall
  '';
}
