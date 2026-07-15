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
# `fork ? false` (#129 Track B, muslFork variant): when true, KEEP fork() and
# route _Fork() through the asyncify double-return seam (patch 0010) instead of
# the clone syscall. This is the userspace half of real fork() over the software
# MMU + COW (#128). The seam is foundation-independent — _Fork() just calls
# capture_stack() (a host import the ENGINE handles); the address-space dup +
# kernel clone + rewind live in the engine/kernel, not here. capture_stack is an
# undefined symbol resolved only at PROGRAM link (via forkStdenv's allow-list +
# --asyncify pass), so the libc.a itself builds unchanged. The DEFAULT (fork =
# false) is the standard no-fork guest libc (fork()/vfork() removed → link error).
{ pkgs, compilerRt, fork ? false }:
let
  llvm = pkgs.llvmPackages_21;
  bt = llvm.bintools-unwrapped;
in
pkgs.stdenv.mkDerivation {
  pname = if fork then "musl-wasm32-nommu-fork" else "musl-wasm32-nommu";
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
  ] ++ pkgs.lib.optionals fork [
    # 0010 (#129 Track B, muslFork only): _Fork() over the asyncify double-return
    # seam — fork() no longer issues the clone syscall; it calls capture_stack()
    # (a host import) which the engine unwinds + dual-rewinds so fork() returns
    # twice. Applies on top of 0007's clone-arity baseline. Only in the fork
    # variant; the default guest libc has fork() removed (postPatch below).
    ../patches/musl/0010-fork-asyncify-seam.patch
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
    # softmmu keep-alive (#152): under CONFIG_MMU the engine software-instruments
    # EVERY exec'd binary at load, and checked-mode fault routing
    # (runtime/softmmu-pass.js) emits `__wasm_syscall_2(NR_MMU_FAULT=244, ea, kind)`
    # for every load/store — so the pass REQUIRES the module to import
    # env.__wasm_syscall_2 and THROWS (→ kernel panic on execve) if it doesn't.
    # The old assumption "every libc binary imports it" is false: a binary that
    # happens to make no 2-arg syscall never references the symbol, so wasm-ld
    # drops the import. Force-retain it in EVERY executable by referencing it from
    # __libc_start_main (always linked, reachable from every _start) behind a
    # `volatile` guard that never fires. Reachable-from-a-link-root is what
    # actually survives --gc-sections here — a bare `used`/`retain` attribute or
    # `--undefined=` does NOT (verified against wasm-ld 18). Harmless on the NOMMU
    # guest: one unused, already allow-listed (toolchain/wasm-host-imports.nix)
    # import per binary. The extern + guard are block-scoped so nothing else in
    # the TU sees them; `long` == i32 on wasm32 → the exact (i32×5)->i32 signature
    # the pass checks (musl's real __wasm_syscall_2 ABI: sp,tp,nr,a,b -> result).
    substituteInPlace src/env/__libc_start_main.c \
      --replace-fail 'exit(main(argc, argv, envp));' \
                     'do { extern long __wasm_syscall_2(long,long,long,long,long); volatile int __softmmu_keep = 0; if (__softmmu_keep) __wasm_syscall_2(0,0,244,0,0); } while (0); exit(((int(*)(int,char**))(void*)main)(argc, argv));'
    # MMU flip (#166): also seed libc.auxv before ctors (same root as page_size
    # / patch 0006). mallocng's first alloc_meta -> get_random_secret() loops
    # `for (i=0; libc.auxv[i]; i+=2)` reading libc.auxv[0]. __init_libc sets
    # libc.auxv from the process auxv, but that runs in _start AFTER the host's
    # __wasm_call_ctors — so a malloc() from a global constructor (sommelier's
    # pixman_constructor, busybox ctors) reads libc.auxv[0] == *(size_t*)NULL at
    # ea=0. Readable garbage on NOMMU; SIGSEGV under CONFIG_MMU (localized by the
    # #166 fault probe: __malloc_alloc_meta <- get_random_secret <- alloc_meta).
    # Point auxv at a static empty vector (single 0 terminator, BSS) so the loop
    # terminates immediately (secret falls back to the &secret-based value);
    # __init_libc installs the real auxv moments later. Static initializer =
    # applied by __wasm_apply_data_relocs before any ctor runs (no runtime call,
    # unlike the TP seed below). Extends patch 0006's seeded __libc.
    substituteInPlace src/internal/libc.c \
      --replace-fail 'struct __libc __libc = { .page_size = 4096 };' \
                     'static size_t __wasm_empty_auxv[1]; struct __libc __libc = { .page_size = 4096, .auxv = __wasm_empty_auxv };'
    # MMU flip (#166, class 4 — the wasm ZERO-VARARG ABI vs POSIX optional
    # args): LLVM's wasm backend passes a NULL vararg-buffer pointer when a
    # variadic call supplies NO variadic arguments, and clang's wasm va_list is
    # a bare char* (CharPtrBuiltinVaList) — so a callee's va_arg reads *(NULL).
    # musl reads POSIX-OPTIONAL trailing args UNCONDITIONALLY in ioctl/fcntl/
    # prctl/syscall, so any legal 2-arg call faults at ea=0: named frame
    # `busybox_unstripped.ioctl <- getty_main` = getty's setsid-fail fallback
    # `ioctl(fd, TIOCNOTTY)` (the getty respawn storm); busybox ndelay_on/off's
    # 2-arg `fcntl(fd, F_GETFL)` is the same shape (udhcpc, shells). On NOMMU
    # the *(NULL) read returned harmless garbage (the value is unused for these
    # requests); under CONFIG_MMU page 0 is unmapped -> SIGSEGV. POSIX requires
    # libc to tolerate the omitted optional arg, and glibc/x86 does so by
    # accident (reads a garbage register) — so the correct general fix is the
    # libc guard, NOT patching LLVM's calling convention (userspace stays on
    # stock LLVM per the architecture) and NOT per-caller busybox patches.
    # va_list == char* here, so `ap ? ... : 0` is exactly "was a vararg buffer
    # passed". No-op for every well-formed >=3-arg call.
    substituteInPlace src/misc/ioctl.c \
      --replace-fail 'arg = va_arg(ap, void *);' \
                     'arg = ap ? va_arg(ap, void *) : 0;'
    substituteInPlace src/fcntl/fcntl.c \
      --replace-fail 'arg = va_arg(ap, unsigned long);' \
                     'arg = ap ? va_arg(ap, unsigned long) : 0;'
    substituteInPlace src/linux/prctl.c \
      --replace-fail 'for (i=0; i<4; i++) x[i] = va_arg(ap, unsigned long);' \
                     'for (i=0; i<4; i++) x[i] = ap ? va_arg(ap, unsigned long) : 0;'
    # (syscall() needs NO guard: the wasm arch patch 0000 already rewrote it to
    # a count-dispatched form — `syscall(count, n, ...)` reads exactly `count`
    # va_args and case 0 reads none, so a zero-vararg call never touches the
    # NULL buffer.)
    # MMU flip (#166): seed a VALID main-thread pointer BEFORE global ctors run.
    # The host runtime (runtime/kernel-worker.js, user_executable_run) calls
    # __wasm_call_ctors — the C++/init_array static initializers — BEFORE
    # _start -> __libc_start_main -> __init_libc -> __init_tp installs the real
    # thread pointer (same ordering patch 0006 documents for page_size). So any
    # ctor that touches TLS executes with __musl_tp == 0: libc++'s iostream init
    # (std::ios_base::Init) calls __uselocale, which reads __pthread_self()->locale
    # and dereferences a null struct pthread — faulting at offsetof(struct pthread,
    # locale) == 0x60 (C ctors reading ->self fault at 0x0). On NOMMU page 0 is
    # readable linear memory so the garbage read was silently tolerated; under
    # CONFIG_MMU page 0 is unmapped and EVERY exec'd binary (busybox getty/init,
    # sommelier, udhcpc, nix.wasm, ...) SIGSEGVs in startup — the single root
    # cause behind the whole MMU-flip crash storm (localized by the engine-side
    # wasm-frame fault probe). Fix: the host calls __wasm_early_tp_init (when the
    # export is present) right before __wasm_call_ctors; __init_tp later installs
    # the real main pthread, abandoning this static stand-in (harmless, static
    # BSS). Lives in __set_thread_area.c (always linked — every binary uses
    # __musl_tp/__set_thread_area — so --export-all/--export-if-defined exports
    # it) and touches ONLY data (&libc.global_locale, a static pthread; both
    # patched by __wasm_apply_data_relocs before the host calls it) — never a
    # function address, so it dodges the GOT.func-resolves-to-0 hazard that is
    # exactly why __wasm_call_ctors itself stays host-called, not musl-called.
    cat >> src/thread/wasm/__set_thread_area.c <<'EOF'

#ifdef __wasm__
static struct pthread __wasm_early_main_td;
void __wasm_early_tp_init(void)
{
	/* Mirror __init_tp()'s field setup (src/env/__init_tls.c) as closely as
	 * possible WITHOUT a syscall, so any ctor that touches the thread struct
	 * (not just locale) sees a coherent main-thread pointer. tid is the one
	 * field that needs a syscall (SYS_set_tid_address); leave it 0 — ctors
	 * run single-threaded before threading is up and never need a real tid,
	 * and __init_tp sets it properly on the real pthread moments later. */
	struct pthread *td = &__wasm_early_main_td;
	td->self = td;
	td->detach_state = DT_JOINABLE;
	td->locale = &libc.global_locale;
	td->robust_list.head = &td->robust_list.head;
	td->next = td->prev = td;
	__musl_tp = (uintptr_t)td;
}
#endif
EOF
    # Clean-NOMMU spawn contract: wasm has no fork()/vfork() (return-twice needs a
    # multi-shot continuation, which no shipped engine provides — see
    # docs/superpowers/specs/2026-06-21-clean-nommu-memory-design.md). Remove the
    # symbols so a caller fails to LINK in its Nix build (loud, traceable) instead of
    # SIGILL/abort at runtime. posix_spawn (clone-with-fn) is the spawn contract;
    # musl's system()/popen() already route through it.
    # fork(): drop the function (lines `pid_t fork(void)` … first column-0 `}`),
    # keeping fork.c's lock/atfork weak-aliases that other TUs depend on. SKIPPED
    # in the fork variant (#129) — there fork() is kept and _Fork() routes through
    # the asyncify seam (patch 0010) instead of removed.
    ${pkgs.lib.optionalString (!fork) "sed -i '/^pid_t fork(void)/,/^}/d' src/process/fork.c"}
    # vfork(): the whole TU is just an asm return-twice stub that can't work on
    # wasm. In the DEFAULT (no-fork) guest libc, empty it so no symbol remains
    # (posix_spawn/clone-with-fn is the spawn contract; a live vfork fails to LINK).
    # In the FORK variant (#131), define vfork() as a REAL fork(): on the software
    # MMU every process has its own COW page table, so vfork-as-fork is
    # semantically safe (vfork is only an optimization of fork; correct vforking
    # code execs or _exits in the child before touching shared state, and the
    # shared-memory error-reporting trick that would break is a BB_MMU=0-only
    # path busybox does NOT use when built CONFIG_NOMMU=n). This lets stock
    # busybox — which still calls vfork() directly in init's run() and a few other
    # sites even with BB_MMU=1 — spawn every child through the asyncify fork seam
    # instead of the NOMMU clone-with-fn hack. fork() itself returns twice via the
    # seam (patch 0010); vfork() inherits that by delegating.
    ${if fork then ''
      cat > src/process/vfork.c <<'EOF'
#include <unistd.h>
pid_t fork(void);
/* vfork-as-fork: safe on the COW software MMU (see musl.nix rationale). */
pid_t vfork(void) { return fork(); }
EOF
'' else ": > src/process/vfork.c"}
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
