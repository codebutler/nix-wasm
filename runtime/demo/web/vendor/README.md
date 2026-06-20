# web/vendor

Vendored third-party bundles for the browser demo. Never hand-edit these files — regenerate via the upstream build process and copy the output here.

## ghostty/

ghostty-web — the Ghostty terminal VT engine compiled to WASM with a Canvas renderer.

- **Package:** `ghostty-web` (version pinned in `ghostty/SOURCE.md`)
- **Artifact:** `ghostty/ghostty.mjs` — self-contained bun-bundled output (no bare imports); this is what app code imports directly
- **License:** `ghostty/LICENSE` (concatenated upstream licenses)

To refresh: re-run `vendor/build.sh` in the `pc` repo (which installs the npm package and bundles it), then copy `ghostty.mjs`, `LICENSE`, `build.json`, and `SOURCE.md` here. The checked-in bundle is the artifact — do not hand-edit it.
