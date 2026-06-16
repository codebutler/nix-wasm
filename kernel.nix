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
# order). The config toggle list mirrors build.sh `configure_kernel()` EXACTLY,
# minus overlay/shmem/tmpfs (a later phase): the base set is NET + 9P + the
# host-callback transport, devtmpfs (for /dev/hvcN), POSIX file locking, the
# stack-end canary (#118), and a 128MB buddy max order (#139 — NOMMU exec needs
# the whole binary in one contiguous allocation).
#
# It is the NEW exec ABI (039e5f3e: wasm_create_and_run_task / wasm_load_
# executable / wasm_release_task / wasm_serialize_tasks; NO wasm_exec_*). It
# will NOT boot yet — the JS runtime forward-port is a separate plan; acceptance
# here is a structurally-correct, reproducible kernel.
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

    # build.sh configure_kernel() toggle set (base config only — overlay/shmem/
    # tmpfs are a later phase and intentionally omitted here).
    bash ./scripts/config --file build/.config \
      --enable CONFIG_NET --enable CONFIG_NET_9P --enable CONFIG_NET_9P_CB --enable CONFIG_9P_FS \
      --enable CONFIG_DEVTMPFS --enable CONFIG_DEVTMPFS_MOUNT \
      --enable CONFIG_FILE_LOCKING \
      --enable CONFIG_SCHED_STACK_END_CHECK \
      --set-val CONFIG_ARCH_FORCE_MAX_ORDER 15

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
