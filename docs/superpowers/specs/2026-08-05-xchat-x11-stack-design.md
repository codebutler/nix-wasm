# XChat on the wasm guest — the X11 stack (Xwayland + GTK2) design

**Goal:** run the genuine XChat 2.8.8 — the old-school GTK2 IRC client — in a
real window on the wasm Linux guest, connected to a real IRC network over the
guest's own TCP/IP uplink. Not a lookalike, not a text frontend: the actual
XChat GUI.

**Why this is an epic, not a package:** XChat is GTK2, and GTK2 has no Wayland
backend — it is X11-only, forever (upstream GTK2 is EOL). Our entire display
stack is deliberately Wayland-only: `deps-overlay.nix` strips `x11Support`
from every package, gtk3 is wayland-only, libepoxy is no-GL, and Sommelier's
X11/XWM path is compiled against link-only xcb stubs that are never executed.
So getting XChat's window on screen means standing up an X server on the
NOMMU wasm guest. The good news: the architecture for exactly this already
half-exists in the tree — Sommelier IS ChromeOS's Xwayland window manager,
and its `-X` path is fully present in `vendor/sommelier/sommelier.cc`
(Xwayland spawn, WM socketpairs, xcb window management), just never enabled.

## Architecture

```
XChat (GTK2/Xlib client)
  │  X11 protocol over AF_UNIX (/tmp/.X11-unix/X0)
  ▼
Xwayland  (xorg-server 24.1.x, rootless, software rendering — no glamor/GL)
  │  Wayland protocol (wl_shm surfaces) + XWM xcb channel
  ▼
sommelier -X  (spawns Xwayland, acts as its window manager, maps X windows
  │            to Wayland surfaces — the stock ChromeOS design)
  ▼
/dev/wl0 virtwl → host → pc's Greenfield compositor (unchanged)
```

Everything below Sommelier is untouched: pc sees ordinary Wayland surfaces,
exactly like gtk3 apps today. No pc-side engine change, no `ENGINE_ABI` bump
anticipated (the one caveat: if Xwayland trips a missing syscall that needs a
host shim, that's a `kernel-worker.js` edit → `sync-to-pc.sh`, and only an ABI
bump if the import surface changes).

**Headless CI strategy — Xvfb is the second server.** The node harness has no
compositor, so Xwayland can't even start there. But xorg-server also builds
**Xvfb** (X into a virtual framebuffer — no Wayland, no hardware, no display
of any kind). We build both from the same xserver source: Xvfb is the
headless CI gate for the entire client stack (X clients, GTK2, XChat's
selftest all run against Xvfb inside the booted guest in CI), while Xwayland
+ sommelier `-X` is the real browser path. This gives every milestone a
gating smoke instead of "manual browser check only" — and Xvfb + `xwd` can
even capture a real pixel dump of XChat's window headless.

**Alternatives rejected:**
- *Port a Wayland backend to GTK2* — does not exist, upstream EOL; writing one
  is a bigger project than the X server and benefits nothing else.
- *hexchat / srain / irssi* — not XChat. (hexchat-text and irssi remain cheap
  fallbacks, but they're not this plan.)
- *Host-side X server (X in pc/JS)* — duplicates what Xwayland already is,
  and violates the "guest is a real Linux system" posture. The guest running
  its own X server is exactly what a real machine does.
- *VNC/Xvnc into a pc window* — a second remoting layer over the one we
  already have; input latency and clipboard would be worse than XWM.

**Payoff beyond XChat:** an X11 stack unlocks the entire pre-Wayland
application universe for the guest (GTK2 era, Motif, Tk, xterm, classic X
games) — very on-brand for a retro desktop. Every piece (libX11 closure,
xorg-server, cairo-xlib, GTK2) is a shared crossSystem/overlay fix per PRIME
DIRECTIVE corollary 1 — no XChat-private recipes.

## What already exists (inventory)

| Piece | State |
|---|---|
| Sommelier `-X` / XWM code | Fully present in `vendor/sommelier/sommelier.cc` (Xwayland spawn at ~L4056, WM + display socketpairs, xcb WM). The posix-spawn patch (`patches/sommelier/0001`) already converts that exact fork site. Compiled today against link-only xcb; never enabled. |
| libxcb + libxau + libxdmcp | Cross-build TODAY (`deps-overlay.nix` "libxcb closure" section) — currently link-only for Sommelier, but they're real, working builds. Promoting them to runtime = removing the "never executed" caveat, not new porting. |
| AF_UNIX sockets | Proven (every Wayland client connects to sommelier over them). |
| Guest TCP/IP | Proven (Cachix substitution over virtio-net → wan0 Wisp uplink). IRC is just another TCP stream. |
| pixman, libxkbcommon, xkeyboard-config | Already cross-built (sommelier / gtk3 closure). |
| fontconfig/freetype/Xft fonts | DejaVu + fontconfig already in the system profile (M2 text stack). |
| fpcast-emu seam | `userspace/fpcast-emu.nix` — GTK2 is gobject; XChat gets the same post-link pass as every GTK3 app. |
| gdk-pixbuf, atk, pango, cairo | Cross-build today (gtk3 closure). cairo needs the **xlib backend** enabled (additive, same pattern as the M2 ft/fontconfig enable). |
| Xwayland package | `pkgs/by-name/xw/xwayland` (24.1.12) at our pin — meson, trimmable. |
| gtk2 package | `pkgs/by-name/gt/gtk2` at our pin. |
| XChat 2.8.8 source | `http://archive.debian.org/debian/pool/main/x/xchat/xchat_2.8.8.orig.tar.bz2` (pristine upstream tarball, permanent archive; Debian also carries a mature patch stack for modern toolchains). |

## Milestones

Ordered by risk retirement: the X server is the unknown; GTK2 and XChat are
"more of what we already do" (autotools + gobject + fpcast).

### M-X0 — X11 client runtime closure (small)

Cross-build the client-side X libraries as *runtime* libs:
`libX11` (the big one — xtrans, XKB, locale/XLC tables), `libXext`,
`libXrender`, `libXrandr`, `libXcursor`, `libXfixes`, `libXdamage`,
`libXcomposite`, `libXi`, `libXft`. All are autotools C over the
already-crossing libxcb; expected fixes are the usual output-trimming +
native-codegen moves, `isWasm`-guarded in `deps-overlay.nix`.

- libX11's `Xlib.h` i18n tables load from `$out/share/X11/locale` at runtime
  → the package must ride the served closure (the galculator ICONDIR lesson).
- Gate: a `.#x11-libs-linkcheck`-style build target; no boot needed yet.

### M-X1 — xorg-server crosses; **Xvfb boots headless** (the risk keystone)

Build xorg-server (the `xwayland` 24.1.x source tree builds both DDXes; if
the xwayland-only tarball won't emit Xvfb, use the full `xorg-server` tarball
at the same version) with everything optional stripped:

- **Off:** glamor/GL (`-Dglamor=false` — drops libGL/gbm/epoxy/egl-wayland/
  libdrm/mesa entirely), libei, libdecor, systemd notify, secure-rpc
  (libtirpc), libunwind (already off under useLLVM), XDMCP, DRI1/2/3.
- **On:** wl_shm-only Xwayland, Xvfb, XKB (xkbcomp + the xkeyboard-config we
  already ship), xcsecurity optional.
- **Known NOMMU/process-model work items:**
  1. **`Popen`/`System` in `os/utils.c` fork()** — the server compiles
     keymaps by spawning `xkbcomp` via its own Popen (fork/exec). Under the
     no-fork musl this fails to *link* (loudly, by design). Port Popen to
     `posix_spawn` (pipe + spawn — same shape as the sommelier patch). This
     is a generic patch worth carrying in `patches/xserver/`.
  2. **MIT-SHM**: needs SysV IPC (`shmget`) — almost certainly off in the
     guest kernel config, and NOMMU shared mappings are the ramfs story.
     Build with MIT-SHM disabled (or let the extension fail at runtime —
     clients fall back to core-protocol PutImage). Slower blits, correct
     behavior. Revisit later via memfd/ramfs if paint speed matters.
  3. **Core fonts**: the server needs the built-in `fixed` font; 24.x keeps
     builtin-fonts support. If any core-font path is unavoidable, ship
     `font-util` + misc-fixed under the X11 fontpath. XChat itself renders
     via Xft/fontconfig (client-side), so this is server-boot plumbing only.
  4. **Memory**: the X server is a long-lived ~10–30MB process; fine under
     the 1.99GiB config, but watch NOMMU fragmentation alongside GTK apps.
- Smoke (gating, `nix-boot-smoke` style): boot the guest, `Xvfb :9 &`,
  then `xdpyinfo -display :9` (or a minimal xcb C probe like our other
  fixtures) asserts the server answers. `demo/node/xvfb-smoke.mjs`.

### M-X2 — first X client + `xwd` pixel proof

`xeyes` (pure Xlib — the spiritual sibling of our vendored wl-eyes) +
`xdpyinfo` + `xwd`. Run against Xvfb in the smoke; `xwd -root` and assert a
plausible dump (non-zero size, expected visual). This proves the client
libs ↔ server protocol path end-to-end with zero toolkit involvement.

### M-X3 — sommelier `-X` + Xwayland in the browser (visual milestone)

- Build the Xwayland DDX (same derivation as M-X1).
- Sommelier: enable the X11/XWM path — the xcb libs graduate from link-only
  to runtime (delete the "never executed" caveat comments in
  `deps-overlay.nix` + `sommelier.nix`); wire `--xwayland-path`; confirm the
  posix-spawn patch covers the Xwayland spawn site's socketpair fd
  inheritance (child-facing ends already have CLOEXEC cleared in patch 0001).
- Launch shape: `sommelier -X --xwayland-path=… <client>` per app, or a
  persistent `sommelier -X` parented X session — decide by what the current
  per-app sommelier invocation in the guest session scripts looks like.
- Verify: `xeyes` in a real pc window in the browser (manual check, noted in
  `docs/superpowers/notes/` like the GTK visual checks; the CI gate for
  server correctness stays Xvfb).

### M-X4 — GTK2 stack

- **cairo**: enable the xlib surface backend (strictly additive flag flip,
  same posture as the M2 freetype/fontconfig enable; weston-flowers stays
  the no-regression gate).
- **gtk2** cross: `gdktarget=x11`; introspection off; cups off; static-link
  the IM modules story away (`gtk-query-immodules` is a cross binary that
  can't run at build time, and NOMMU can't dlopen modules — build with
  `--disable-modules`/included immodules, or accept no input methods:
  plain XIM-less keyboard input is fine for IRC). gdk-pixbuf is already
  builtin-loaders. Expect the usual dead-doc-output and native-codegen
  (`gtk-update-icon-cache`, `gdk-pixbuf-csource`) moves.
- **fpcast**: GTK2 apps get the same `--fpcast-emu` post-link pass; gtk2's
  gobject fn-pointer casts are the same class the seam already handles.
- Proof app: a 20-line `gtk2-hello` (`userspace/`, like gtk-hello) with a
  display-free `--selftest` (class_init via the fpcast seam) AND an Xvfb run
  in the smoke — GTK2 can be *screenshotted headless* via `xwd`, something
  the GTK3/Wayland tier never had.

### M-X5 — XChat itself

- `userspace/xchat.nix` from the Debian-archived pristine tarball + the
  Debian patch stack where needed (2010 code vs clang 21: expect `-fcommon`,
  implicit-function-declaration, and glib deprecation fixes).
- Configure: `--disable-perl --disable-python --disable-tcl` (plugin
  interpreters are their own epics and all dlopen), `--enable-openssl`
  (cross openssl exists — TLS for port 6697), `--disable-nls` if gettext
  fights, spell/enchant off.
- **fork holdouts** (process-model rule — port, never stub): XChat forks for
  (a) `/exec` (spawn a shell command into a tab) and (b) its non-blocking
  DNS resolver child. Port both to `posix_spawn` (the DNS child re-execs a
  helper mode, a documented XChat pattern) or compile out `/exec` with an
  honest "not supported" message. If Track B's real-fork guest ships first
  (#129/#131), this item may evaporate — check before doing the work.
- Plugins are dlopen — build with plugins disabled initially. (Track C
  dlopen actually WORKS now, so a follow-up could light them up — not in
  scope.)
- `--selftest` patch (display-free: widget class_inits through fpcast +
  a servlist parse) → `demo/node/xchat-smoke.mjs`, one-per-boot in
  `nix-boot-smoke`, PLUS an Xvfb launch asserting the main window maps
  (`xwd` dump of the server list dialog).
- Ships via `environment.systemPackages` (needs its runtime `share/` data on
  the served closure). Squashfs rebuild → publish via `.#linux-image` /
  `publish-linux-channel` — no pc deploy expected.
- End-to-end: connect to Libera (`irc.libera.chat:6697` TLS) over the wan0
  uplink from the browser, join a channel, say hello. The uplink is raw TCP
  via Wisp, same as the Cachix HTTPS path, so no new network plumbing —
  CA trust anchors are already baked for TLS.

## Risks / unknowns (resolve in milestone order)

| Risk | Milestone | Mitigation |
|---|---|---|
| xorg-server won't cross (biggest unknown: os/ layer — smart scheduler `SIGALRM` (proven by #55/#75 fixes), select/poll loop, `getpeereid`/ancillary creds on AF_UNIX) | M-X1 | It's autotools/meson C over libs we already cross; musl-based distros (Alpine) build it routinely. Budget the surprises here — everything after rides on it. |
| Popen/xkbcomp spawn | M-X1 | posix_spawn port of os/utils.c (loud link failure guarantees we can't miss it). |
| No SysV shm → MIT-SHM off | M-X1 | Core-protocol image path; acceptable for IRC-sized repaint. |
| Xwayland needs a wl feature Greenfield/sommelier lacks | M-X3 | Xwayland's requirements are minimal (wl_shm, xdg-shell via sommelier); sommelier was built for exactly this pairing on ChromeOS. Xvfb keeps the client stack unblocked regardless. |
| GTK2 IM/module dlopen | M-X4 | Build module-less; Track C dlopen as fallback. |
| XChat fork holdouts | M-X5 | posix_spawn port or compile-out; possibly mooted by Track B. |
| 2010-era C vs clang 21 | M-X5 | `-fcommon` + Debian patch stack; worst case small local patches in `patches/xchat/`. |
| Closure bloat (X server + gtk2 + xchat on the served squashfs) | M-X5 | The galculator `nix-support` lesson + `#43` squashfs already absorb this class; measure at each milestone. |

## Out of scope (this epic)

- XChat plugins/scripting (perl/python/tcl), DCC file transfer (needs
  listening sockets — uplink is outbound-only), spell check.
- A pc-side Start-menu entry for XChat (pc's Linux app owns guest app
  launch UX; follow-up on the pc side).
- Xwayland GL/glamor, MIT-SHM performance work, any second X11 app —
  they come free-ish afterwards but are not gates.

## Sizing (rough)

M-X0 ~1 session · M-X1 2–3 sessions (the keystone) · M-X2 ~0.5 ·
M-X3 1–2 (browser/visual iteration) · M-X4 1–2 · M-X5 1–2.
Each milestone is a PR with its own gate, per repo convention; CI stays
green throughout because every stage is `isWasm`-guarded and additive.
