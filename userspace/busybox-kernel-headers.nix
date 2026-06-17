# busybox-kernel-headers — the Linux UAPI headers busybox compiles against,
# patched for musl. The Nix port of the harness `build-busybox-kernel-headers`
# step: take the kernel's `make headers_install` output (our `kernelHeaders`,
# the SAME pinned joelseverin/linux wasm tree) and apply the musl-compat header
# fixups.
#
# Why a SEPARATE header set from the toolchain `kernelHeaders`: the raw UAPI
# headers double-define types that musl's own <netinet/*.h>, <sys/stat.h>, etc.
# already provide (struct ethhdr, struct tcphdr, struct stat fields, timespec).
# Compiling busybox — which pulls both musl libc headers (via --sysroot=musl) and
# linux/*.h (via -isystem here) — hits those redefinition clashes. The patch adds
# the libc-compat.h guards (__UAPI_DEF_*) and trims the conflicting blocks.
#
# The patch (patches/busybox/0002-kernel-headers-for-musl.patch) is the harness'
# busybox-kernel-headers-for-musl.patch with the manual-patch litter (.orig/.rej
# files and the two hunks — linux/if.h, linux/kernel.h — that were REJECTED and
# never applied in the harness) stripped: only the 5 files that actually changed
# (if_ether.h, libc-compat.h, stat.h, tcp.h, time.h). Applies -p1 against the
# `linux/` tree at the include root.
{ pkgs, kernelHeaders }:
pkgs.runCommand "busybox-kernel-headers"
  {
    nativeBuildInputs = [ pkgs.gnupatch ];
  }
  ''
    mkdir -p $out
    # kernelHeaders installs to $out/include (INSTALL_HDR_PATH=$out); busybox's
    # -isystem wants `linux/` at the top level, so copy the include CONTENTS.
    cp -r ${kernelHeaders}/include/. $out/
    chmod -R u+w $out
    ( cd $out && patch -p1 < ${../patches/busybox/0002-kernel-headers-for-musl.patch} )
  ''
