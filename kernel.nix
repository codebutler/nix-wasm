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
    # Toolchain flags moved INTO the kernel source (replacing the fake-llvm argv
    # shim): arch/wasm/Makefile carries the wasm cc + LDFLAGS_vmlinux flags, and
    # three small generic-kbuild guards drop what wasm-ld/llvm-objcopy reject
    # (--build-id/-z noexecstack, --start-group, --set-section-flags/symbol-strip).
    ./patches/kernel/0008-wasm-arch-toolchain-flags.patch
    ./patches/kernel/0009-wasm-skip-buildid-noexecstack.patch
    ./patches/kernel/0010-wasm-link-vmlinux-no-group.patch
    ./patches/kernel/0011-wasm-strip-relocs-section-only.patch
    ./patches/kernel/0012-wasm-vmlinux-o-no-group.patch
    # Wayland Phase 1 (1a): a minimal virtio transport over Wasm host callbacks
    # (drivers/virtio/virtio_wasm.c) + an in-kernel echo self-test that proves
    # the guest<->host vring round-trip AND host->guest used-buffer interrupt
    # delivery via raise_interrupt(). Enabled by CONFIG_VIRTIO_WASM below.
    ./patches/kernel/0013-wasm-virtio-wasm-transport.patch
    # Phase 1 (Task 1): route copy_to/from_user + strncpy_from_user through the
    # host-bridge import (drops UACCESS_MEMCPY, adds ARCH_HAS_STRNCPY_FROM_USER)
    # so the kernel reaches a process's memory via the runtime. The runtime still
    # services it against the SHARED buffer — zero behavior change; this de-risks
    # the ABI before the per-process memory split (Task 2).
    ./patches/kernel/0014-wasm-uaccess-hostbridge.patch
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

  # kbuild resolves CC=clang, AR=llvm-ar, OBJCOPY=llvm-objcopy, … from LLVM=<dir>/
  # (the symlink farm). CROSS_COMPILE=wasm32-unknown-unknown- makes kbuild pass
  # --target=wasm32-unknown-unknown (a triple clang accepts). HOSTCC=gcc keeps the
  # native host tools (fixdep, kallsyms) on the build platform; HOSTLD defaults to
  # the farm's ld.lld (ELF — fine for host ELF). LD is overridden to wasm-ld: lld
  # dispatches on argv[0], and the default LLVM= LD=ld.lld is the ELF driver, which
  # can't link the wasm target objects — wasm-ld is the wasm driver.
  makeFlags = [
    "ARCH=wasm"
    "O=build"
    "LLVM=${kernelCC}/bin/"
    "LD=${kernelCC}/bin/wasm-ld"
    "HOSTCC=gcc"
    "CROSS_COMPILE=wasm32-unknown-unknown-"
    # scripts/Makefile.clang hardcodes CLANG_TARGET_FLAGS_wasm := wasm-linux-musl,
    # which clang REJECTS (wasm needs wasm32). Override it (command-line wins over
    # the Makefile :=) to the triple clang accepts; arch/wasm/Makefile re-adds the
    # -D__linux__/__unix__ the bare triple drops. (No patch to the generic file.)
    "CLANG_TARGET_FLAGS_wasm=wasm32-unknown-unknown"
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
      `# Wayland Phase 1 (1a/1b): virtio core + the Wasm host-callback transport` \
      `# (patch 0013), its 2-vq echo self-test, and the virtio_wl driver` \
      `# (/dev/wl0). VIRTIO/VIRTIO_MENU are off in wasm32_nommu_defconfig; turn` \
      `# them on so virtio.c/virtio_ring.c build, then enable our transport +` \
      `# drivers. No DMA layer is needed — the transport withholds` \
      `# VIRTIO_F_ACCESS_PLATFORM so vring uses identity nommu offsets.` \
      --enable CONFIG_VIRTIO --enable CONFIG_VIRTIO_MENU --enable CONFIG_VIRTIO_WASM \
      --enable CONFIG_VIRTIO_WASM_ECHO --enable CONFIG_VIRTIO_WL \
      --enable CONFIG_SCHED_STACK_END_CHECK \
      --set-val CONFIG_ARCH_FORCE_MAX_ORDER 15 \
      `# Boot RAM: arch/wasm head.S grows the wasm Memory to CONFIG_BOOT_MEM_PAGES` \
      `# (64KiB pages) and that becomes the kernel's physical RAM. The default` \
      `# 0x2000 = 512MiB is too tight for in-guest compilation: exec'ing the 57MB` \
      `# clang.wasm needs a single contiguous mmap, and the cc wrapper's sysroot` \
      `# unpack fragments the NOMMU buddy allocator below 57MB first (only 4 order-15` \
      `# blocks at 512MiB, all spoiled). 0x4000 = 1GiB doubles the order-15 block` \
      `# count so a contiguous 57MB survives; stays under setup.c's 0x80000000` \
      `# (2GiB) positive-address limit. Shared fix — helps any large-binary exec.` \
      --set-val CONFIG_BOOT_MEM_PAGES 0x4000 \
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
