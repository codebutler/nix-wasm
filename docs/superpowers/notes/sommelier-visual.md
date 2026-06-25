# Sommelier Visual Check — gtk3-widget-factory via Greenfield/pc

## Status

As of 2026-06-25, Sommelier (`--parent` mode) is the guest Wayland bridge, auto-started
from the inittab. The previous `waylandproxyd` byte-splice proxy is retired.

The `sommelier-smoke.mjs` and `sommelier-leak-smoke.mjs` headless gates (exit 0) prove
the registry handshake and the wl_shm alloc/free lifecycle. The visual check below
confirms the full render path: GTK window → wl_shm buffer → Greenfield compositor →
browser canvas.

## Manual Browser Check: gtk3-widget-factory renders and survives

The visual headline is `gtk3-widget-factory` — GTK's own showcase app — opening a full
Adwaita-themed window with interactive widgets in the browser (Greenfield). This was the
M3b/M4 regression that was unblocked by three shared fixes (see CLAUDE.md hard-won
learnings: `/dev/shm` ramfs mount, `__unmapself` patch 0008, 1.75 GiB RAM).

### Steps

1. Build artifacts:
   ```sh
   export NIX_CONFIG="experimental-features = nix-command flakes"
   echo password | sudo -S nix build .#kernel --no-link --print-out-paths
   echo password | sudo -S nix build .#wasm-initramfs --no-link --print-out-paths
   echo password | sudo -S nix build .#wasm-base-squashfs --no-link --print-out-paths
   echo password | sudo -S nix build .#wasm-binary-cache --no-link --print-out-paths
   ```

2. Point the browser demo at the new artifacts:
   ```sh
   ln -sfn /path/to/artifacts runtime/demo/web/artifacts
   cd runtime && node demo/web/serve.mjs
   ```
   Browse to http://localhost:8080.

3. Wait for the boot to complete (autologin shell prompt in the terminal).

4. In the guest shell:
   ```sh
   nix-env -iA widget-factory
   gtk3-widget-factory &
   ```

5. Assert: A GTK3 widget-factory window appears as a floating draggable panel
   in the browser page via Greenfield, showing buttons, sliders, comboboxes etc.
   Click around — widgets respond. The app does NOT crash (no SIGILL/abort),
   which was the pre-fix regression (detached GThreadPool worker SIGILL on exit).

## Engine-file changes and pc sync

If any `runtime/` engine file was changed (e.g. `kernel-worker.js`, `wl-device.js`),
run `runtime/sync-to-pc.sh <pc-checkout>` to sync the engine to the pc project before
testing. Booting with a stale engine may fail to instantiate glib/GTK binaries.

## Inittab change → squashfs republish

The Sommelier autostart (inittab line in `userspace/init.nix`) lives in the squashfs
member of `.#linux-image`, NOT the initramfs. An inittab change republishes via
`.#linux-image`'s squashfs member (`.#wasm-base-squashfs`) — see the CLAUDE.md Boot-test
section: "an `init.nix` change republishes via `.#linux-image`'s squashfs member".
