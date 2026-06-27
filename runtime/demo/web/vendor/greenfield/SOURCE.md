# vendor/greenfield — Greenfield Wayland HTML5 compositor

In-browser Wayland compositor, vendored for the pc Linux app's Wayland GUI
effort (Phase 2). Boots in a pc window and renders Wayland surfaces as pixels
in cb-windows.

## Provenance

- **Upstream:** Greenfield (https://github.com/udevbe/greenfield), extended fork.
- **Source tree:** `~/Code/greenfield` (outside pc).
- **Commit:** `b5d7a2f` (branch `fix/dom-windows-popups-90`, codebutler/greenfield#2 —
  "accept wl_shm cursor bitmap directly in updateCursor" on top of
  "make xdg_popup grabs, positioning, and rendering work for DOM-windows shells"),
  on top of `fc4966f` ("compositor: add pointerButton / forwardLocalButton") on top
  of `5bf2e35` ("wayland-wasm: in-browser Wayland apps on Greenfield (extended fork)").
  The popups-90 commit fixes xdg_popup grab serial/scene-coords/client-order, the
  xdg_positioner anchor-center miscalc, and adds popup parent/offset + surfaceDestroyed
  so a DOM-windows shell can render popups as positioned overlays (nix-wasm #98/#99/#101).
  The cursor commit aligns the source with the #94 wl_shm-cursor fix previously applied
  to this bundle directly. Also fixes the ensureGeometryConstraints OR-vs-AND bug (#100).
- **Local patch (pc Wayland Phase 4f):** `src/UserShellApi.ts` adds a
  `requestSurfaceClose(compositorSurface)` action — sends `xdg_toplevel.close` to
  the client (via the desktop surface's `requestClose`) and flushes, the standard
  Wayland window-close path. DOM-windows mode (pc's cb-windows) calls it from the
  window × button so the guest client exits cleanly; `closeClient` only tears down
  the server side, which never reaches the guest over the message-passing bridge.
- **Local patch (input):** `src/Pointer.ts` + `src/UserShellApi.ts` add
  `forwardLocalButton` / `pointerButton` — the DOM-windows-mode button-injection
  entry point (the upstream local-input API had motion+leave but no button).
- **Local patch (pc Wayland Phase 4b):** `src/Shm.ts` `createPool` now clamps the
  pool mapping to the wire-declared `size` instead of the backing fd's
  `byteLength`. The guest virtio_wl shm fd is page-rounded LARGER than the
  declared pool size (posix_fallocate / ftruncate round up to a page), so the
  unclamped mapping made `data.byteLength` exceed the real pool size and a later
  legitimate `wl_shm_pool.resize` tripped a spurious "Can't grow pool" protocol
  error that disconnected the client (the weston-flowers render blocker). Rebuilt
  with `tsc --noEmitOnError false` (the upstream fork's dist has pre-existing
  SAB-vs-ArrayBuffer strict-type errors unrelated to this change) then re-bundled
  per the command below. Apply this same patch upstream-side before any rebuild.
- **Local patch (cursor render — pc#94):** the renderer's `updateCursor` read the
  cursor image as `bufferContents.pixelContent.bitmap`, but a wl_shm / canvas
  buffer (every GTK app's cursor) exposes the decoded `ImageBitmap` DIRECTLY as
  `pixelContent` — the same value `updateRenderStatesPixelContent` hands the
  `surfaceContentUpdated` userShell event as `bitmap:`; only decoded video frames
  wrap it in a `.bitmap` field. So `pixelContent.bitmap` was `undefined`,
  `updateCursor` bailed before `setBrowserCursor`, and the pointer was left hidden
  (`cursor: none`) over every Wayland window. Fix: accept both shapes —
  `cursorImage.bitmap !== undefined ? cursorImage.bitmap : cursorImage`. Apply
  upstream-side (`src/render/Renderer.ts` `updateCursor`) before any rebuild.
  pc's vendored copy has the identical bug and needs the same one-liner.
- **License:** `@gfld/compositor` is AGPL-3.0-or-later; `@gfld/compositor-wasm`
  (libpixman / libxkbcommon Emscripten libs) is MIT.

## What is bundled

`@gfld/compositor`'s prebuilt **ESM** dist (`packages/compositor/dist/index.js`)
plus all of its `@gfld/*` workspace deps (`@gfld/common`,
`@gfld/compositor-protocol`, `@gfld/compositor-wasm`,
`@gfld/compositor-ffmpeg-h264`, `@gfld/xtsb`), tree-bundled into a single ES
module. The two Emscripten WASM libs (libpixman ~740KB, libxkbcommon ~4.8MB)
are **embedded as base64 `data:` URIs inside their own JS modules upstream**,
so they bundle inline — there is no separate `.wasm` to load and no classic
`<script>` tag needed. `initWasm()` instantiates them from the inlined data.

The cursor / window-decoration PNGs (`src/assets/*.png`, used only by the
XWayland frame path) are inlined as `data:` URLs via esbuild's `dataurl` loader,
keeping `greenfield.mjs` a single self-contained file with no sidecar assets.

### Files

- `greenfield.mjs` (~6.2 MB) — the bundle. Exports `initWasm`,
  `createCompositorSession`, `createAppLauncher`, plus the event helpers.
- `H264NALDecoder.worker.js` (~1.7 MB) — the h264 NAL decoder worker, bundled
  as a sibling. Loaded lazily via `new Worker(new URL("./H264NALDecoder.worker.js",
  import.meta.url))` and ONLY when a *remote* (proxy) app streams h264 — the
  web:// and (future) guest-shm paths never touch it. Kept next to
  `greenfield.mjs` so the relative worker URL resolves.
- `samples/wl-eyes/` — Greenfield's OWN prebuilt web:// wl-eyes sample
  (`examples/webapps/wl-eyes/dist/{eyes.html,eyes.js,eyes.wasm,eyes.worker.js}`),
  copied so it is served same-origin (the WebAppLauncher `fetch`es the html and
  re-hosts it via iframe `srcdoc` + injected `<base href>`; same-origin avoids
  CORP/COEP breakage under pc's cross-origin isolation). Used by the 2a smoke.

## Build command

Run from the pc worktree root (requires `~/Code/greenfield` checked out at the
commit above, with its workspace `node_modules` symlinks present):

```sh
GF=~/Code/greenfield
bunx esbuild "$GF/packages/compositor/dist/index.js" \
  --bundle --format=esm --loader:.png=dataurl \
  --outfile=vendor/greenfield/greenfield.mjs
bunx esbuild "$GF/packages/compositor/dist/remote/H264NALDecoder.worker.js" \
  --bundle --format=esm --loader:.png=dataurl \
  --outfile=vendor/greenfield/H264NALDecoder.worker.js
mkdir -p vendor/greenfield/samples/wl-eyes
cp "$GF/examples/webapps/wl-eyes/dist/"{eyes.html,eyes.js,eyes.wasm,eyes.worker.js} \
   vendor/greenfield/samples/wl-eyes/
```

esbuild auto-resolves the `@gfld/*` workspace deps from
`packages/compositor/node_modules/@gfld/*` (symlinks into `packages/*` and
`libs/*`).

## No remote dependencies

Verified CDN-free (pc requirement — no unpkg / esm.sh / jsdelivr / cdnjs /
googleapis, no cross-origin subresource under COEP `require-corp`):

```sh
grep -rE 'unpkg|esm\.(sh|run)|jsdelivr|cdnjs|googleapis' vendor/greenfield/  # → no matches
```

The only `import.meta.url` references in the bundle are the wasm modules'
`_scriptDir` (unused — wasm is inlined) and the lazy h264 worker URL (resolved
to the local sibling file).

## Rebuild, do not hand-edit

Per pc's vendoring rule: regenerate from upstream with the command above; never
hand-patch `greenfield.mjs` or the worker.
