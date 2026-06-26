# Sommelier Visual Check — gtk3-widget-factory via Greenfield/pc

## Status

As of 2026-06-25, Sommelier (`--parent` mode) is the guest Wayland bridge, auto-started
from the inittab. The previous `waylandproxyd` byte-splice proxy is retired.

The `sommelier-smoke.mjs` and `sommelier-leak-smoke.mjs` headless gates (exit 0) prove
the registry handshake and the wl_shm alloc/free lifecycle.

**VERIFIED 2026-06-25 (headless Playwright + Greenfield):** `gtk3-widget-factory`
renders its **full showcase** through Sommelier (Page 1/2/3, Adwaita theme, all
widgets) **and survives** — the process stays alive (`ps` shows it), no
`Error reading events from display: Broken pipe`, and `/var/log/sommelier.log` is
clean (only the benign `virtwl-dmabuf … using virtwl instead` line). Verified by
driving the local `demo/web/` (full `nix:true` artifacts) with system Chrome
(`--enable-unsafe-swiftshader` for Greenfield's WebGL) and screenshotting the
window (wf-final.png on PR #68).

**Required fix:** this only works with `patches/sommelier/0002-keymap-mmap-graceful.patch`.
Without it, a keyboard/seat client (which `wl-eyes` never exercises but GTK does)
makes Greenfield send `wl_keyboard.keymap` with the xkb fd; Sommelier `mmap`s it,
the mmap fails (host→guest fds are not mmappable on NOMMU — `wl-device.js` delivers
them `pfn=0`), and `assert(data != MAP_FAILED)` aborts the per-client worker →
broken pipe. The patch skips Sommelier's own (null-guarded) xkb state on MAP_FAILED;
the keymap fd is still forwarded to the client.

**KNOWN LIMITATION — keyboard INPUT does not work.** The window renders and is
**mouse-usable**, but typing won't register: the guest client's own libxkbcommon
also can't `mmap` the keymap fd (same NOMMU host→guest-fd limit), so it builds no
keymap. In-guest keyboard input needs a separate mechanism for **host→guest
mmappable fds** (the keymap content delivered into guest-allocated backing) — a real
NOMMU feature the team previously hit a wall on (the host-arena dead-end note in
`runtime/virtio/wl-device.js`). Tracked as follow-up, NOT part of this PR.

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

5. Assert: A GTK3 widget-factory window appears via Greenfield, showing the full
   showcase (buttons, sliders, comboboxes, the Adwaita theme). The app does NOT
   crash — no `Broken pipe`, the process stays alive, `/var/log/sommelier.log` has
   no `Assertion failed`/`MAP_FAILED`. **Mouse** interaction works; **keyboard
   input does not** (see the keyboard limitation above). (A headless equivalent of
   this check: drive `demo/web/` with Playwright + Chrome `--enable-unsafe-swiftshader`,
   run `gtk3-widget-factory >/tmp/wf.log 2>&1 &`, then assert `ps` still lists it,
   `/tmp/wf.log` has no `Broken pipe`, and screenshot the window.)

## Engine-file changes and pc sync

If any `runtime/` engine file was changed (e.g. `kernel-worker.js`, `wl-device.js`),
run `runtime/sync-to-pc.sh <pc-checkout>` to sync the engine to the pc project before
testing. Booting with a stale engine may fail to instantiate glib/GTK binaries.

## Inittab change → squashfs republish

The Sommelier autostart (inittab line in `userspace/init.nix`) lives in the squashfs
member of `.#linux-image`, NOT the initramfs. An inittab change republishes via
`.#linux-image`'s squashfs member (`.#wasm-base-squashfs`) — see the CLAUDE.md Boot-test
section: "an `init.nix` change republishes via `.#linux-image`'s squashfs member".
