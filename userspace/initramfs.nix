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
# `extraBins`: extra guest derivations whose $out/bin/* are copied into /bin
# (Phase 1 1b ships the /dev/wl0 self-test binary, wltest, this way).
{ pkgs, busybox, init, extraBins ? [ ] }:
let
  # busybox udhcpc lease script. udhcpc execs this (via libbb spawn(),
  # clone-with-a-fn on NOMMU — see patches/busybox/0004) on each lease event,
  # passing the action as $1 and the lease params as env vars ($ip/$subnet/
  # $router/$dns/$interface). We apply them with `ip`/`ifconfig` (both busybox
  # applets, present in the guest set). Kept minimal: bring the iface up with no
  # address on `deconfig`; flush + add the address/route + write resolv.conf on
  # `bound`/`renew`.
  udhcpcScript = pkgs.writeText "udhcpc-default.script" ''
    #!/bin/sh
    # Address tcpip.js's DHCP server gives us; configure eth0 from the lease.
    RESOLV=/etc/resolv.conf

    case "$1" in
      deconfig)
        ip link set "$interface" up 2>/dev/null
        ip addr flush dev "$interface" 2>/dev/null
        ;;

      renew|bound)
        ip link set "$interface" up 2>/dev/null
        # Replace any prior address (renew may change it). ifconfig takes the
        # dotted netmask udhcpc hands us directly, avoiding mask->prefix math.
        ip addr flush dev "$interface" 2>/dev/null
        if [ -n "$subnet" ]; then
          ifconfig "$interface" "$ip" netmask "$subnet" up
        else
          ifconfig "$interface" "$ip" up
        fi

        if [ -n "$router" ]; then
          # Clear stale default(s), then install the lease's gateway.
          while ip route del default 2>/dev/null; do :; done
          for r in $router; do
            ip route add default via "$r" dev "$interface" 2>/dev/null
          done
        fi

        # Rewrite resolv.conf from the lease's DNS servers.
        : > "$RESOLV" 2>/dev/null
        [ -n "$domain" ] && echo "search $domain" >> "$RESOLV"
        for d in $dns; do
          echo "nameserver $d" >> "$RESOLV"
        done
        ;;
    esac
    exit 0
  '';
in
pkgs.runCommand "wasm-initramfs"
  {
    nativeBuildInputs = [ pkgs.cpio pkgs.gzip ];
  }
  ''
    root=$(mktemp -d)
    mkdir -p "$root/bin" "$root/sbin" "$root/proc" "$root/sys" "$root/dev" \
             "$root/mnt" "$root/nix" "$root/run" "$root/etc" "$root/root" "$root/tmp"

    # busybox binary + its complete applet symlink set (relative -> busybox).
    cp -a ${busybox}/bin/. "$root/bin/"
    # /bin/sh is among them; ensure it exists even if a future busybox drops it.
    [ -e "$root/bin/sh" ] || ln -sf busybox "$root/bin/sh"

    # extra guest binaries (Phase 1 1b: /bin/wltest). The busybox cp -a above
    # left $root/bin entries read-only; make the dir writable before adding more.
    chmod -R u+w "$root/bin"
    for d in ${pkgs.lib.concatMapStringsSep " " (b: "${b}/bin") extraBins}; do
      [ -d "$d" ] && cp "$d"/* "$root/bin/"
    done
    chmod -R u+w "$root/bin"

    # the generated /init (entrypoint; kernel cmdline init=/init).
    cp ${init} "$root/init"
    chmod +x "$root/init"

    # busybox udhcpc lease script (run at every DHCP event by the udhcpc the
    # /init launches at boot). Default path udhcpc looks for is
    # /usr/share/udhcpc/default.script; must be executable.
    mkdir -p "$root/usr/share/udhcpc" "$root/etc"
    cp ${udhcpcScript} "$root/usr/share/udhcpc/default.script"
    chmod +x "$root/usr/share/udhcpc/default.script"

    # mktemp -d creates the root 0700; an initramfs / must be traversable.
    chmod 0755 "$root"

    # pack newc cpio + gzip. --owner=0:0 records root:root in the archive (the
    # build runs as an unprivileged nixbld user, so without this every entry
    # would carry the builder's uid; the kernel unpacks the initramfs verbatim).
    mkdir -p $out
    ( cd "$root" && find . -print0 \
        | cpio --null -o --format=newc --owner=0:0 --quiet ) \
        | gzip -9 > $out/initramfs.cpio.gz
  ''
