# userspace/gtk-assets.nix — GTK runtime assets baked into the guest (M3b).
# Compiled GSettings schemas (glib + gtk — GTK aborts without org.gtk.Settings.*)
# + a minimal hicolor icon theme + the Adwaita Xcursor theme. Schemas compiled
# with NATIVE glib-compile-schemas (from pkgs.buildPackages.glib — the guest
# can't run host binaries).
#
# Schema layout note: nixpkgs installs the cross gtk3's .gschema.xml under
#   $out/share/gsettings-schemas/<drv-name>/glib-2.0/schemas/
# (not the canonical $out/share/glib-2.0/schemas/ that glib-compile-schemas
# expects). We flatten them into the output schema dir before compiling.
# Cross glib at 2.88.1 ships only a gschema.dtd (no .gschema.xml of its own).
{ pkgs, cross }:
pkgs.buildPackages.runCommand "gtk-assets" { nativeBuildInputs = [ pkgs.buildPackages.glib ]; } ''
  mkdir -p $out/share/glib-2.0/schemas $out/share/icons

  # Gather the org.gtk.Settings.* schemas from the cross gtk3 output.
  # nixpkgs places them under share/gsettings-schemas/<drv-name>/glib-2.0/schemas/.
  for d in ${cross.gtk3}/share/gsettings-schemas/*/glib-2.0/schemas; do
    [ -d "$d" ] && cp "$d"/*.gschema.xml $out/share/glib-2.0/schemas/ 2>/dev/null || true
  done

  # Cross glib: probe the .dev and main output for any .gschema.xml
  # (at 2.88.1 it ships none, but we probe both outputs defensively).
  for d in ${cross.glib.dev}/share/glib-2.0/schemas \
           ${cross.glib}/share/glib-2.0/schemas; do
    [ -d "$d" ] && cp "$d"/*.gschema.xml $out/share/glib-2.0/schemas/ 2>/dev/null || true
  done

  glib-compile-schemas $out/share/glib-2.0/schemas

  # Minimal icon theme: hicolor index + empty per-size dirs.
  # GTK looks up icons here; hicolor is the ultimate fallback — without at least
  # its index.theme GTK emits "Could not find icon theme" warnings at startup.
  # hicolor-icon-theme is pure data; we take it from buildPackages (native) so
  # we get the plain -0.18 store path regardless of cross settings.
  cp -r ${pkgs.buildPackages.hicolor-icon-theme}/share/icons/hicolor $out/share/icons/

  # Cursor theme: GDK's wayland backend draws pointer shapes from an Xcursor
  # theme on disk (via libwayland-cursor). With NO theme in the search path,
  # EVERY cursor request fails — "Gdk-Message: Unable to load <name> from the
  # cursor theme" for default/text/pointer/*-resize/col-resize — and widgets
  # show no hover/resize/text cursors. Ship the Adwaita Xcursor theme (pure
  # cursor data — gnome-themes-extra carries it under share/icons/Adwaita;
  # adwaita-icon-theme does NOT have cursors). Taken native from buildPackages
  # like hicolor (architecture-independent data; the cp into this fresh
  # derivation leaves no store ref back to gnome-themes-extra). system.nix sets
  # XCURSOR_PATH + XCURSOR_THEME=Adwaita to point GDK here.
  cp -r ${pkgs.buildPackages.gnome-themes-extra}/share/icons/Adwaita $out/share/icons/

  # A "default" theme inheriting Adwaita: libwayland-cursor falls back to the
  # theme literally named "default" when GDK passes a NULL theme name (i.e. if
  # XCURSOR_THEME isn't honoured), and resolves cursors through Inherits=. This
  # makes both the explicit-name and the NULL-name lookup paths succeed.
  mkdir -p $out/share/icons/default
  cat > $out/share/icons/default/index.theme <<'THEME'
[Icon Theme]
Name=Default
Comment=Default cursor theme
Inherits=Adwaita
THEME
''
