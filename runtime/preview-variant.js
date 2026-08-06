// preview-variant.js — pure resolution of which artifact set demo/web/main.js
// boots from, given an optional `?variant=` query param and an optional
// preview.json manifest (PR previews only; local dev has none).
//
// Extracted out of main.js (where it was inlined and had zero test coverage —
// see the review note dated 2026-08-05) because it is one half of a
// two-copies-must-agree seam: pr-preview.yml's jq step writes
// `.variants.<name>.artifactsBase` (around the "writing preview.json"
// echo there) and this function is the only reader. Nothing enforced the two
// key paths staying in sync — a rename on either side would leave `bun test`,
// typecheck, lint, and the query-string-free browser smoke all green, and
// only surface as a live "boot failed: unknown preview variant" click.
// Pulling the resolution logic out to a plain function lets
// preview-variant.test.js (1) pin this reader's exact shape
// (`variants.<name>.artifactsBase`) against fixture preview.json objects, AND
// (2) read pr-preview.yml itself and assert its jq write step targets that
// same literal key path under the same variant name the "Comment preview
// link" step's `?variant=` URL links — so a drift on EITHER side (a rename in
// the yml, or the yml's jq/comment steps desyncing from each other) breaks
// `bun run test` instead of only surfacing as a live click.
//
// demo/ is excluded from tsc (jsconfig.json) and from `bun run test`'s glob
// (package.json's `test` script only covers `./*.test.js` at the runtime/
// root, `ninep/`, and `virtio/`) — so this logic has to live at the runtime/
// root to be gated at all; main.js imports it back via a relative path.

/**
 * @param {{ artifactsBase?: string, variants?: Record<string, { artifactsBase: string }> } | null} preview
 *   Parsed preview.json, or null when the page has none (local dev).
 * @param {string | null} variant  The `?variant=` query param value, or null
 *   for the default (unqualified) artifact set.
 * @param {string} baseHref  Resolution base for the relative URLs below
 *   (document.baseURI in the browser).
 * @returns {string}  The resolved artifacts/ base URL (trailing slash).
 * @throws {Error}  If an explicit variant doesn't resolve to a real artifact
 *   set under a preview.json that IS present — deliberately never falls back
 *   to booting the default guest under a URL that claims a variant it isn't.
 */
export function resolveArtifactsBase(preview, variant, baseHref) {
  if (variant) {
    const variantBase = preview?.variants?.[variant]?.artifactsBase;
    if (variantBase) return new URL(variantBase, baseHref).href;
    if (!preview) {
      // Local dev has no preview.json to carry a variants map; mirror the
      // ./artifacts/ symlink convention per-variant (runtime/.gitignore's
      // `demo/web/artifacts-*` entry, main.js's file-header comment).
      return new URL(`./artifacts-${variant}/`, baseHref).href;
    }
    throw new Error(`unknown preview variant "${variant}" (not in preview.json's variants map)`);
  }
  if (preview?.artifactsBase) return new URL(preview.artifactsBase, baseHref).href;
  return new URL("./artifacts/", baseHref).href;
}
