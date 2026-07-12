# GNOME games tier — browser visual acceptance

**Status: VERIFIED 2026-07-12 — four games render on the browser rig (PR #144
preview artifacts, commit `7223568`).**

Verified on the headless-Chromium rig (`runtime/demo/web/` + SwiftShader,
per-game fresh boot). The tier's SVG-rendering chain (libcroco → librsvg 2.40 →
pango/cairo → cairo-png) is exercised by every piece drawn; the headless
`rsvg-smoke.mjs` gate covers the same chain CLI-side. No engine crash lines,
no `Unable to load image` for any of these four.

## gnome-mahjongg — full tile board (postmodern SVG theme), tile click-selected
![gnome-mahjongg](./games-shots/gnome-mahjongg.png)

## five-or-more — board + placed balls + the "Next:" SVG preview trio
![five-or-more](./games-shots/five-or-more.png)

## gnome-mines — playable grid, revealed cells (one cosmetic missing SVG icon)
![gnome-mines](./games-shots/gnome-mines.png)

## iagno — green Reversi board with the four starting discs
![iagno](./games-shots/iagno.png)

## Why these four (and not four-in-a-row / tali)

These render their pieces through **librsvg's API** (`rsvg_handle_*` →
cairo), which works. four-in-a-row and tali load their tileset / dice as
`.svg` files **through gdk-pixbuf**, which has no SVG loader on this guest
(no `libpixbufloader-svg`, no `loaders.cache` — verified in-guest). They're
deferred to **nix-wasm#146** (gdk-pixbuf SVG loader), which also clears
gnome-mines' cosmetic icon warning.
