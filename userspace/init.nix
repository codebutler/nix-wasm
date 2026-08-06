# PID 1 inittab for the wasm guest: busybox `init` reads this. One
# getty->autologin->ash chain per hvc console, plus a file-backed syslogd. All
# program paths are PROFILE-ABSOLUTE (/run/current-system/sw/bin) — busybox's
# applets (getty/login/syslogd/init/sh) and our autologin package all live in
# the system profile, so the guest needs NO `busybox --install` and NO FHS-path
# population. This is the busyrc pattern (systemd-free NixOS prior art).
#
# nrConsoles MUST match the count of single-port virtio-console DEVICES the
# transport registers — CONSOLE_DEVICES in runtime/virtio/console-device.js (also
# exported as the JS host's HVC_CONSOLES) and VW_DEV_CONSOLE_BASE..+8 in kernel
# patch 0019: the stock virtio_console driver registers one hvc line per device,
# so a getty count below the device count leaves consoles idle and above it fails
# to open (/dev/hvcN absent). Both are 8; changing this without the device count
# desyncs.
{ lib, pkgs, nrConsoles ? 8 }:
let
  sw = "/run/current-system/sw/bin";
  # getty passes `xterm-256color` as the termtype so TERM is correct from login
  # on (the pc terminal is Ghostty/xterm-compatible; busybox's bare default
  # vt102 is wrong). -L local line, -i skip issue, -n skip login-name prompt,
  # -l <prog> exec autologin instead of /bin/login. baud 0 = keep line speed.
  # One getty->autologin->ash chain per hvc console, as a list of inittab lines.
  consoleLines = lib.map
    (i: "hvc${toString i}::respawn:${sw}/getty -L -i -n -l ${sw}/autologin 0 hvc${toString i} xterm-256color")
    (lib.range 0 (nrConsoles - 1));
  syslogLine = "::respawn:${sw}/sh -c '${sw}/syslogd -n -O /var/log/messages -s 16 -b 1; sleep 5'";
  # Sommelier: the guest-side Wayland compositor shim (userspace/sommelier.nix).
  # GUEST-owned autostart (issue #31) so EVERY host/embedder gets the Wayland proxy
  # without JS-side startup choreography (previously pc's kernel-service.js
  # ensureWaylandProxy / the web demo's main.js wrote the launch to a hidden hvc).
  # Sommelier --parent binds $XDG_RUNTIME_DIR/wayland-0 for guest GUI clients and
  # bridges the Wayland wire protocol to the host compositor over /dev/wl0 (virtwl).
  # INITRAMFS-absolute paths (/bin/sh, /bin/sommelier): sommelier ships in the
  # initramfs `extraBins` (baked /bin), so this comes up BEFORE the served /nix
  # closure is activated and does not depend on the system profile. The env is set
  # INLINE (busybox init does not source /etc/profile for ::respawn entries),
  # matching /etc/profile's values.
  # Guard on /dev/wl0 so a kernel without virtwl doesn't hot-respawn; the trailing
  # `sleep 5` backs off if Sommelier ever exits (same pattern as syslogd above).
  waylandLine = "::respawn:/bin/sh -c 'mkdir -p /tmp; [ -e /dev/wl0 ] && XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /bin/sommelier --parent >>/var/log/sommelier.log 2>&1; sleep 5'";
  # M-X3 (XChat/X11 epic): a SECOND, independent Sommelier instance dedicated
  # to X11 forwarding (-X). This is NOT a peer of the --parent daemon above —
  # sommelier's `--parent` mode returns immediately into its own accept loop
  # (sl_run_parent) and never reaches the "spawn xwayland" code path at all,
  # and the flags it forwards to per-client peer instances (sommelier.cc's
  # posix_spawn-ported peer-spawn block) do NOT include -X/--xwayland-path —
  # verified by reading sommelier.cc before writing this comment. So X
  # support is architecturally a separate, standalone `sommelier -X` process
  # that opens its OWN connection to the host compositor via /dev/wl0 (virtwl
  # supports multiple concurrent contexts — VIRTIO_WL_CMD_VFD_NEW_CTX; every
  # wl-eyes/wl-anim/wl-input-probe run already opens a second one alongside
  # this daemon) and spawns/owns Xwayland itself; X CLIENT apps then connect
  # over Xwayland's own X11 socket, never through this Sommelier's Wayland
  # socket. `--x-display=1` forces a deterministic DISPLAY=:1 (xdisplay=0
  # behaves identically to "unset" in sommelier.cc's `if (xdisplay > 0)`
  # gate, so it must be >=1) — distinct from Xvfb's own :9 in the M-X1/M-X2
  # smokes, so the two servers are trivially distinguishable in a client's
  # `xdpyinfo` output. No --xwayland-path= needed: userspace/sommelier.nix
  # bakes the matching cross-built Xwayland's store path in as the build-time
  # default. Same /dev/wl0 guard + respawn/backoff shape as waylandLine;
  # ${xwayland}/bin/Xwayland only becomes reachable once the served /nix
  # squashfs is mounted, so an early respawn attempt harmlessly retries.
  #
  # The trailing `[program]` positional is REAL — it is the X session leader,
  # NOT inert filler. sommelier.cc's arg parser requires a non-empty
  # `[program]` argv regardless of `-X`, and once Xwayland signals
  # display-ready, `sl_handle_display_ready_event` EXECS that program (it is
  # the session's "run this under X" slot, exactly like ChromeOS's
  # `sommelier -X … /usr/bin/some-app`). An earlier version of this line
  # passed a bogus `x11-unused` placeholder on the theory that the `-X` path
  # branches away from ctx.runprog and never runs it; a real browser boot
  # disproved that — /var/log/sommelier-x.log showed Xwayland spawning fine
  # (0.17s) and then:
  #     x11-unused: No such file or directory
  #     Assertion failed: false (../sommelier.cc: sl_handle_display_ready_event: 3768)
  # i.e. the exec failed, sommelier asserted, and the daemon died taking
  # Xwayland with it — which is why only `sommelier --parent` was ever
  # visible in the guest's `ps`. So pass a real, long-lived program: the X
  # server's lifetime is deliberately tied to it (when the session leader
  # exits, sommelier tears down X — standard sommelier semantics), and
  # `/bin/sleep` is a busybox applet symlink baked into the initramfs /bin
  # alongside /bin/sh, so it needs no served-closure dependency and no
  # nested shell quoting. This is a headless X SESSION (a server for other
  # apps to connect to), so an idle session leader is the correct shape.
  xwaylandLine = "::respawn:/bin/sh -c 'mkdir -p /tmp; [ -e /dev/wl0 ] && XDG_RUNTIME_DIR=/tmp WAYLAND_DISPLAY=wayland-0 /bin/sommelier -X --x-display=1 /bin/sleep 2147483647 >>/var/log/sommelier-x.log 2>&1; sleep 5'";
  # ninepd: the read-only 9P rootfs server behind pc's /Linux mount (pc#472).
  # Dials OUT to the host on vsock 1025 and serves the LIVE guest filesystem —
  # Filer browsing + the tray launcher's .desktop reads. INITRAMFS-absolute
  # path (/bin/ninepd via extraBins), same posture as sommelier above. The
  # daemon retries the dial and reconnects internally (pc may not be listening
  # yet at init, and it replaces the mount on a fresh dial-in), so ::respawn +
  # `sleep 5` is only the crash safety net.
  ninepdLine = "::respawn:/bin/sh -c '/bin/ninepd >>/var/log/ninepd.log 2>&1; sleep 5'";
  # Build the inittab by explicit newline-join — do NOT use a `''` block: it strips
  # only the COMMON leading indent, so a single misaligned line keeps its leading
  # space and busybox then reads the tty id as whitespace ("can't open /dev/  ").
in
pkgs.writeText "inittab"
  (lib.concatStringsSep "\n" ([ syslogLine waylandLine xwaylandLine ninepdLine ] ++ consoleLines) + "\n")
