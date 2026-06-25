# wl-eyes — a Wayland eyes app in C

A small native Wayland client (`src/eyes.c`). Pure `wl_shm` + `xdg-shell` +
`wl_pointer` — no toolkit, no GPU.

Two anti-aliased eyes (2×2 supersampled into a shared-memory buffer) whose pupils
follow the pointer. Left-press anywhere on the body drags the window.

> Ported from a WebAssembly/Greenfield build to a standard native Wayland app —
> the rendering and protocol code is unchanged; only the emscripten teardown and
> build glue were replaced.

## Wayland note

A Wayland client only receives pointer events **while the cursor is over its own
surface** (the security model — there is no global pointer like X11's). So the eyes
track the cursor when it is over the window, and freeze at the last position when it
leaves. There is no standard Wayland protocol to read the global pointer position.

## Build

Prereqs (development packages):

- `wayland-client` (libwayland)
- `wayland-protocols`
- `wayland-scanner` (usually shipped with libwayland)
- a C compiler and `make`

On Debian/Ubuntu:

```bash
sudo apt install build-essential libwayland-dev wayland-protocols
```

Then:

```bash
make          # wayland-scanner generates xdg-shell glue, then builds ./wl-eyes
make clean    # remove generated/ and the binary
```

`make` uses `wayland-scanner` to generate `xdg-shell-client-protocol.h` and
`xdg-shell-protocol.c` from the system `wayland-protocols` xml, then compiles them
together with `src/eyes.c`.

## Run

From any Wayland session (`WAYLAND_DISPLAY` set):

```bash
./wl-eyes
```

A 360×220 window appears. Move the pointer over it to make the eyes follow; click and
drag to move the window; close it from the compositor to quit.
