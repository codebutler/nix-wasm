# PID 1 inittab for the wasm guest: busybox `init` reads this. One
# getty->autologin->ash chain per hvc console, plus a file-backed syslogd. All
# program paths are PROFILE-ABSOLUTE (/run/current-system/sw/bin) — busybox's
# applets (getty/login/syslogd/init/sh) and our autologin package all live in
# the system profile, so the guest needs NO `busybox --install` and NO FHS-path
# population. This is the busyrc pattern (systemd-free NixOS prior art).
#
# nrConsoles MUST match the kernel's HVC_WASM_NR_CONSOLES and the JS host's
# HVC_CONSOLES (both 8). Changing it here without the others desyncs consoles.
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
  # Build the inittab by explicit newline-join — do NOT use a `''` block: it strips
  # only the COMMON leading indent, so a single misaligned line keeps its leading
  # space and busybox then reads the tty id as whitespace ("can't open /dev/  ").
in
pkgs.writeText "inittab"
  (lib.concatStringsSep "\n" ([ syslogLine waylandLine ] ++ consoleLines) + "\n")
