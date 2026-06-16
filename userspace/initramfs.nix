# .#wasm-initramfs — the guest initramfs.cpio.gz, built by Nix (replaces pc's
# build.sh initramfs path). Contents: the generated /init (bootstrap.nix) + the
# cross-built busybox and its full applet symlink set (the initrd's own toolset,
# baked at build — NOT the runtime busybox --install we deleted). newc cpio +
# gzip, the format the kernel's initramfs loader expects.
#
# `cross` is the wasm guest pkg set (busybox is a guest binary); native cpio/gzip
# come from `pkgs` (host tools that just archive the guest files).
#
# We DON'T run `busybox --install`: a wasm32 busybox can't exec on the x86 host.
# nixpkgs busybox already ships every applet as a RELATIVE symlink (-> busybox)
# in $out/bin, so `cp -a` of that dir gives the real binary + all applets +
# /bin/sh, deterministically and without executing any guest code.
{ pkgs, cross, init }:
pkgs.runCommand "wasm-initramfs"
  {
    nativeBuildInputs = [ pkgs.cpio pkgs.gzip ];
  }
  ''
    root=$(mktemp -d)
    mkdir -p "$root/bin" "$root/sbin" "$root/proc" "$root/sys" "$root/dev" \
             "$root/mnt" "$root/nix" "$root/run" "$root/etc" "$root/root" "$root/tmp"

    # busybox binary + its complete applet symlink set (relative -> busybox).
    cp -a ${cross.busybox}/bin/. "$root/bin/"
    # /bin/sh is among them; ensure it exists even if a future busybox drops it.
    [ -e "$root/bin/sh" ] || ln -sf busybox "$root/bin/sh"

    # the generated /init (entrypoint; kernel cmdline init=/init).
    cp ${init} "$root/init"
    chmod +x "$root/init"

    # pack newc cpio + gzip.
    mkdir -p $out
    ( cd "$root" && find . -print0 \
        | cpio --null -o --format=newc --quiet ) \
        | gzip -9 > $out/initramfs.cpio.gz
  ''
