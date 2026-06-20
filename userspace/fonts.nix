# userspace/fonts.nix — the guest font + fontconfig bundle (M2 text stack).
# A self-contained /etc/fonts/fonts.conf + DejaVu font dir + a fontconfig cache
# built at build time (native fontconfig; the guest can't run fc-cache). Because
# the cache is keyed to the build path (not the guest's
# /run/current-system/sw/share/fonts), fontconfig rescans once on first in-guest
# FcInit — fine for a single font dir.
{ pkgs }:
let
  fontDir = "${pkgs.dejavu_fonts}/share/fonts/truetype";
in
pkgs.runCommand "guest-fonts" { nativeBuildInputs = [ pkgs.fontconfig ]; } ''
  mkdir -p $out/etc/fonts $out/share/fonts $out/var/cache/fontconfig
  # the served font dir (guest path /run/current-system/sw/share/fonts via the profile)
  cp ${fontDir}/DejaVuSans.ttf $out/share/fonts/

  cat > $out/etc/fonts/fonts.conf <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/run/current-system/sw/share/fonts</dir>
  <cachedir>/var/cache/fontconfig</cachedir>
  <config></config>
</fontconfig>
EOF

  # Prebuild the cache against the SAME guest paths fontconfig will see at runtime.
  # FONTCONFIG_FILE points at our conf; build the cache into $out/var/cache.
  FONTCONFIG_FILE=$out/etc/fonts/fonts.conf \
  FONTCONFIG_PATH=$out/etc/fonts \
    ${pkgs.fontconfig}/bin/fc-cache -f -v $out/share/fonts || true
''
