// Tests for resolveArtifactsBase (preview-variant.js) — the reader half of the
// pr-preview.yml ↔ main.js "variants.<name>.artifactsBase" contract. Pins the
// exact key path the jq step in pr-preview.yml writes
// (`.variants.nommu.artifactsBase = $base`) so a rename on either side fails
// here instead of only surfacing as a live "unknown preview variant" click.
//
// The fixture-based tests below pin the READER side only (resolveArtifactsBase
// against hand-written preview.json shapes) — they say nothing about what
// pr-preview.yml's jq step actually WRITES. The "pr-preview.yml ↔
// resolveArtifactsBase contract" describe block at the end of this file closes
// that gap for real: it reads the workflow source itself and asserts (a) its
// jq mutation target is the literal `variants.<name>.artifactsBase` key path
// resolveArtifactsBase reads (a rename to e.g. `.variants.nommu.base` fails the
// regex match outright) and (b) the variant name embedded there is the SAME
// name the "Comment preview link" step's `?variant=` URL links (a rename on
// only one side desyncs the two captured names). Without that block, editing
// pr-preview.yml alone (as the review note dated 2026-08-05 pointed out) left
// `bun run test`, `tsc`, `oxlint`, and `oxfmt --check` all green.
import { readFileSync } from "node:fs";
import { test, expect, describe } from "bun:test";
import { resolveArtifactsBase } from "./preview-variant.js";

const BASE_HREF = "https://preview.example/pr-42/demo/web/";

describe("no variant requested", () => {
  test("no preview.json (local dev) → ./artifacts/", () => {
    expect(resolveArtifactsBase(null, null, BASE_HREF)).toBe(
      "https://preview.example/pr-42/demo/web/artifacts/",
    );
  });

  test("preview.json present, default artifactsBase → resolved against it", () => {
    const preview = { artifactsBase: "/cas/abc123/" };
    expect(resolveArtifactsBase(preview, null, BASE_HREF)).toBe(
      "https://preview.example/cas/abc123/",
    );
  });

  test("preview.json present but no artifactsBase key → falls back to ./artifacts/", () => {
    expect(resolveArtifactsBase({}, null, BASE_HREF)).toBe(
      "https://preview.example/pr-42/demo/web/artifacts/",
    );
  });
});

describe("variant requested, preview.json present (PR preview)", () => {
  test("variant present in variants map → resolved against its artifactsBase", () => {
    const preview = {
      artifactsBase: "/cas/abc123/",
      variants: { nommu: { artifactsBase: "/cas/def456/" } },
    };
    expect(resolveArtifactsBase(preview, "nommu", BASE_HREF)).toBe(
      "https://preview.example/cas/def456/",
    );
  });

  test("variant absent from variants map → throws, never falls back to the default guest", () => {
    const preview = {
      artifactsBase: "/cas/abc123/",
      variants: { nommu: { artifactsBase: "/cas/def456/" } },
    };
    expect(() => resolveArtifactsBase(preview, "nope", BASE_HREF)).toThrow(
      /unknown preview variant "nope"/,
    );
  });

  test("preview.json present with no variants map at all → throws (same as absent)", () => {
    const preview = { artifactsBase: "/cas/abc123/" };
    expect(() => resolveArtifactsBase(preview, "nommu", BASE_HREF)).toThrow(
      /unknown preview variant "nommu"/,
    );
  });
});

describe("variant requested, no preview.json (local dev)", () => {
  test("mirrors the ./artifacts-<variant>/ symlink convention", () => {
    expect(resolveArtifactsBase(null, "nommu", BASE_HREF)).toBe(
      "https://preview.example/pr-42/demo/web/artifacts-nommu/",
    );
  });
});

describe("pr-preview.yml ↔ resolveArtifactsBase contract", () => {
  // Read the workflow source itself (not a copy/fixture of it) so this test
  // fails the moment either side actually drifts, rather than trusting a
  // second hand-kept description of what the workflow does.
  const workflowPath = new URL("../.github/workflows/pr-preview.yml", import.meta.url);
  const workflow = readFileSync(workflowPath, "utf8");

  test("the jq step's mutation target is the literal variants.<name>.artifactsBase key path", () => {
    // resolveArtifactsBase reads `preview?.variants?.[variant]?.artifactsBase`
    // (preview-variant.js) — this must match the jq filter's literal key path
    // byte-for-byte. A rename on the yml side (e.g. to `.variants.nommu.base`,
    // or hoisting the field a level) makes this regex fail to match, not
    // silently pass with a stale capture.
    const jqTarget = workflow.match(/'\.variants\.([\w-]+)\.artifactsBase = \$base'/);
    expect(jqTarget).not.toBeNull();
    expect(jqTarget[1]).toBe("nommu");
  });

  test("the jq write and the PR-comment's ?variant= link agree on the same variant name", () => {
    const jqTarget = workflow.match(/'\.variants\.([\w-]+)\.artifactsBase = \$base'/);
    const commentLink = workflow.match(/\$\{url\}\?variant=([\w-]+)<\/sub>/);
    expect(jqTarget).not.toBeNull();
    expect(commentLink).not.toBeNull();
    // Same string the "Comment preview link" step actually publishes — a
    // rename of only one side (jq's write key vs. the comment's read-back
    // link) is exactly the drift this test exists to catch.
    expect(commentLink[1]).toBe(jqTarget[1]);
  });
});
