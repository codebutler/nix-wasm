# Vendored ghostty-web — provenance

Vendored by `vendor/build.sh` on 2026-06-10T17:26:58.375Z.

**Do not hand-edit `ghostty.mjs` — re-run `vendor/build.sh`.**

| Package | Version (from vendor/package.json) |
|---|---|
| `ghostty-web` | 0.4.0-next.14.g6a1a50d |

Layout:
- `ghostty.mjs` — bundled output, self-contained (no bare imports); the API app code imports directly.
- `LICENSE`     — concatenated licenses from each upstream package.
- `build.json`  — package list + required export symbols (for
                  the build-time verifier).

Reproduce:
```
vendor/build.sh
```
