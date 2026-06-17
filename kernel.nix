# The wasm guest kernel: vmlinux.wasm, built reproducibly from the pinned
# joelseverin/linux source (the out-of-tree wasm Linux arch port) with stock
# clang-21 + the kernel-only patched wasm-ld (GNU linker-script support), via
# the fake-llvm-equivalent wrappers in kernelCC.
#
# This is the Nix port of pc's build.sh `build_kernel`: configure
# (wasm32_nommu_defconfig + the host-integration toggles), `make … vmlinux`,
# then `cp build/vmlinux $out/vmlinux.wasm` (wasm-ld emits the .wasm directly —
# no ELF->wasm step). The 6 kernel patches are pc's host-integration set (9p
# trans_cb, hvc multi-console + winsize, single-CPU pin, 16K stack, force-max-
# order). The config toggle list mirrors build.sh `configure_kernel()`: NET + 9P
# + the host-callback transport, devtmpfs (for /dev/hvcN), POSIX file locking,
# the stack-end canary (#118), a 128MB buddy max order (#139 — NOMMU exec needs
# the whole binary in one contiguous allocation), PLUS CONFIG_OVERLAY_FS (Plan 2:
# read-only served /nix store + ramfs upper; see the toggle comment below).
#
# It is the NEW exec ABI (039e5f3e: wasm_create_and_run_task / wasm_load_
# executable / wasm_release_task / wasm_serialize_tasks; NO wasm_exec_*), and it
# BOOTS + execs userspace with the forward-ported JS runtime (pc commit
# c6a33dbd: kernel-worker.js/kernel-host.js compile the user binary directly
# from the kernel memory range the new ABI passes).
{ pkgs, kernelSrc, kernelCC }:
pkgs.stdenv.mkDerivation {
  pname = "vmlinux-wasm";
  version = "7.0-039e5f3e";

  src = kernelSrc;

  patches = [
    ./patches/kernel/0001-9p-trans_cb.patch
    ./patches/kernel/0002-hvc-wasm-multi-console.patch
    ./patches/kernel/0003-hvc-wasm-winsize.patch
    ./patches/kernel/0004-wasm-pin-user-tasks-single-cpu.patch
    ./patches/kernel/0005-wasm-enlarge-kernel-stack.patch
    ./patches/kernel/0006-wasm-force-max-order.patch
    # User stack 8KiB->8MiB: the 8KiB stack overflowed on a single musl realpath()
    # (8KiB of buffers) and crashed nix at startup; NOMMU stacks can't grow.
    ./patches/kernel/0007-wasm-enlarge-user-stack.patch
  ];

  nativeBuildInputs = [
    pkgs.gnumake
    pkgs.bison
    pkgs.flex
    pkgs.bc
    pkgs.python3
    pkgs.perl
    pkgs.rsync
    pkgs.gcc
    kernelCC
  ];

  # kbuild resolves CC=clang, LD=ld.lld, AR=llvm-ar, … from LLVM=<dir>/; HOSTCC
  # stays the native gcc (host tools: fixdep, kallsyms, …). The CROSS_COMPILE
  # prefix only names the (rewritten-away) target triple.
  makeFlags = [
    "ARCH=wasm"
    "O=build"
    "LLVM=${kernelCC}/bin/"
    "HOSTCC=gcc"
    "CROSS_COMPILE=wasm32-unknown-unknown-"
  ];

  # Fixed identity so the build is deterministic (kbuild otherwise embeds the
  # builder's user/host/timestamp into the kernel).
  KBUILD_BUILD_USER = "nix";
  KBUILD_BUILD_HOST = "nix-wasm";
  KBUILD_BUILD_TIMESTAMP = "Thu Jan  1 00:00:00 UTC 1970";

  enableParallelBuilding = true;

  configurePhase = ''
    runHook preConfigure

    # The kernel ships scripts with `#!/usr/bin/env …` shebangs the sandbox
    # has no /usr/bin/env for; rewrite them to absolute store paths.
    patchShebangs scripts

    make $makeFlags wasm32_nommu_defconfig

    # build.sh configure_kernel() toggle set + overlayfs (Plan 2): the Nix-built
    # /nix store is served READ-ONLY over 9P (overlay lowerdir); unioning it with
    # a writable upper lets nix-env install without a writable backing store.
    # NOMMU caveat: CONFIG_TMPFS depends on CONFIG_SHMEM and mainline gates SHMEM
    # behind MMU, so olddefconfig SILENTLY DROPS both here — we request them
    # anyway (harmless; auto-enables if a future MMU/EXPERT change allows tmpfs),
    # but the working overlay upper is RAMFS (always built in, backs the
    # initramfs). CONFIG_OVERLAY_FS itself compiles cleanly on this NOMMU kernel.
    bash ./scripts/config --file build/.config \
      --enable CONFIG_NET --enable CONFIG_NET_9P --enable CONFIG_NET_9P_CB --enable CONFIG_9P_FS \
      --enable CONFIG_DEVTMPFS --enable CONFIG_DEVTMPFS_MOUNT \
      --enable CONFIG_FILE_LOCKING \
      --enable CONFIG_SCHED_STACK_END_CHECK \
      --set-val CONFIG_ARCH_FORCE_MAX_ORDER 15 \
      --enable CONFIG_SHMEM --enable CONFIG_TMPFS --enable CONFIG_OVERLAY_FS

    make $makeFlags olddefconfig

    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    make $makeFlags -j$NIX_BUILD_CORES vmlinux
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp build/vmlinux $out/vmlinux.wasm
    runHook postInstall
  '';

  dontFixup = true;
  dontStrip = true;
}
