// xchat-smoke.mjs — M-X5 of the XChat/X11 epic, the FINALE: XChat 2.8.8 itself
// (userspace/xchat.nix), over GTK2's X11 backend (M-X4) against a cross-built
// Xvfb (M-X1). One boot, two checks:
//
//   1. `xchat --selftest` — display-free (see patches/xchat/0003):
//      servlist_init()'s built-in default server list (asserts "freenode" is
//      present, the exact fallback path a first-run guest with no
//      ~/.xchat2/servlist.conf takes) + GTK2 widget class_init (GtkWindow,
//      GtkNotebook — the tab strip XChat's main window is built from) through
//      the fpcast-emu seam, both run BEFORE gtk_init() so no display is
//      needed. Mirrors gtk2-smoke.mjs's posture.
//   2. A LIVE main window against Xvfb — the gtk2-x11-smoke.mjs pixel-proof
//      pattern, now for the actual headline app. XChat's default first-run
//      behaviour opens a modal "Network List" dialog before any main window
//      (servlist_init() finds no ~/.xchat2/servlist.conf and falls back to
//      the compiled-in defaults, then xchat_init() opens the network-picker
//      GUI unless `gui_slist_skip` is set) — so this seeds a minimal
//      ~/.xchat2/xchat.conf with `gui_slist_skip = 1` (cfgfiles.c's plain
//      `key = value` text format) and launches with `-a` (--no-auto, so it
//      never attempts a real IRC connect — this harness has no relay to
//      connect to). With both, xchat.c's startup takes the
//      `prefs.slist_skip -> new_ircwindow(...)` path directly to a normal
//      main chat window, skipping the server-list dialog entirely — the
//      real target for the xwd pixel proof, not a placeholder dialog.
//
// xwd -root dumps the real server framebuffer (no compositor on Xvfb, so xwd
// sees exactly what's on screen) to /mnt/pc, parsed host-side against the
// real XWD header layout (X11/XWDFile.h) — same verification gtk2-x11-smoke.mjs
// and x11-apps-smoke.mjs already established.
//
// Markers are picked per the #96 lesson: every waitForOutput regex requires a
// DIGIT that only exists after real shell expansion ($?), never a literal
// string also present in the ECHOED (not-yet-evaluated) command.
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../../ninep/mem-vfs.js";

const vfs = MemVfs.from({ Home: {} });
const s = await bootNode({ nix: true, vfs });

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};

try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[xchat-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // --- 1. display-free --selftest ------------------------------------------
  s.send("xchat --selftest\n");
  const selftestOk = await s.waitForOutput(/XCHAT-SELFTEST: .* OK/, 60000);
  check(selftestOk, "xchat --selftest (servlist defaults + GTK2 class_init through fpcast)");
  if (!selftestOk) {
    console.log("\n── selftest transcript tail ──\n" + s.snapshot().slice(-3000));
  }

  // --- 2. a real main window against Xvfb ----------------------------------
  // Xvfb ships via systemPackages (PATH lookup, not /bin).
  s.send("Xvfb :9 -nolisten tcp -screen 0 1024x768x24 > /tmp/xvfb.log 2>&1 &\n");

  // xdpyinfo, retried: the first Xvfb start also spawns xkbcomp (a fresh wasm
  // exec + keymap compile), which can take longer than a fixed sleep.
  s.send(
    "for i in $(seq 15); do DISPLAY=:9 xdpyinfo > /tmp/xdpyinfo.out 2>&1 && break; sleep 2; done\n",
  );
  s.send("cat /tmp/xdpyinfo.out\n");
  const dpyOk = await s.waitForOutput(/dimensions:\s+1024x768 pixels/, 60000);
  check(dpyOk, "xdpyinfo reports the real 1024x768 screen over the wire");
  if (!dpyOk) {
    console.log("\n── xdpyinfo transcript tail ──\n" + s.snapshot().slice(-3000));
  }

  // Seed a minimal xchat.conf that skips the server-list dialog (see the
  // file-header comment) — plain `key = value` text, cfgfiles.c's format.
  s.send("mkdir -p ~/.xchat2 && printf 'gui_slist_skip = 1\\n' > ~/.xchat2/xchat.conf\n");
  s.send("echo XCHATCONF_SEEDED\n");
  const confSeeded = await s.waitForOutput(/XCHATCONF_SEEDED/, 15000);
  check(confSeeded, "seeded ~/.xchat2/xchat.conf (gui_slist_skip=1)");

  // Backgrounded, `-a` (--no-auto, never attempts a real IRC connect — no
  // relay reachable from this harness). NOTE: do NOT use `$!` here — this
  // runs in the nix-system login shell's stock busybox ash (from the
  // squashfs), which leaves `$!` empty for a backgrounded job (the same gap
  // gtk2-x11-smoke.mjs/x11-apps-smoke.mjs document) — probe liveness with
  // `ps` + a bracketed pattern instead.
  s.send("DISPLAY=:9 xchat -a > /tmp/xchat.log 2>&1 &\n");
  s.send("echo XCHAT_LAUNCHED\n");
  const gotLaunch = await s.waitForOutput(/XCHAT_LAUNCHED/, 15000);
  check(gotLaunch, "xchat launched");

  // Give it a few seconds to realize its window + run the event loop, then
  // prove it's still alive by finding it in the process table.
  s.send("sleep 4; ps | grep '[x]chat' > /dev/null; echo XCHAT_PS_RC:$?\n");
  const aliveOut = await s.waitForOutput(/XCHAT_PS_RC:\d+/, 15000);
  const aliveMatch = /XCHAT_PS_RC:(\d+)/.exec(s.snapshot());
  const xchatAlive = aliveOut && aliveMatch && aliveMatch[1] === "0";
  check(xchatAlive, "xchat is still running 4s later (found in ps)");
  if (!xchatAlive) {
    s.send("cat /tmp/xchat.log\n");
    await new Promise((r) => setTimeout(r, 1500));
    console.log("\n── xchat.log ──\n" + s.snapshot().slice(-2000));
  }

  // xwd -root: dump the real server framebuffer (xchat's window included —
  // Xvfb has no compositor, so xwd sees exactly what's on screen) to the
  // 9P-mounted host VFS.
  s.send("DISPLAY=:9 xwd -root -silent -out /mnt/pc/Home/xchat.xwd; echo XWDDONE_RC:$?\n");
  const xwdRan = await s.waitForOutput(/XWDDONE_RC:\d+/, 30000);
  const xwdMatch = /XWDDONE_RC:(\d+)/.exec(s.snapshot());
  const xwdOk = xwdRan && xwdMatch && xwdMatch[1] === "0";
  check(xwdOk, "xwd -root exits 0");

  if (xwdOk) {
    // Let the 9P write settle (same margin gtk2-x11-smoke.mjs's check uses).
    await new Promise((r) => setTimeout(r, 1500));
    let bytes;
    try {
      bytes = new Uint8Array(await (await vfs.readBlob("/Home/xchat.xwd")).arrayBuffer());
    } catch (e) {
      check(false, "host VFS sees the written xchat.xwd file", `: ${e.message}`);
    }
    if (bytes) {
      check(bytes.length > 100, "xchat.xwd is non-trivially sized", ` (${bytes.length} bytes)`);

      // X11/XWDFile.h's XWDFileHeader: 25 big-endian CARD32 fields (xwd.c
      // always _swaplong()s to network byte order on write). Field indices
      // per the struct order (the layout gtk2-x11-smoke.mjs/x11-apps-smoke.mjs
      // already verified against the vendored xwd.c).
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const u32 = (i) => dv.getUint32(i * 4, false);
      const headerSize = u32(0);
      const pixmapDepth = u32(3);
      const pixmapWidth = u32(4);
      const pixmapHeight = u32(5);
      const bytesPerLine = u32(12);
      const ncolors = u32(19);

      check(
        pixmapWidth === 1024 && pixmapHeight === 768,
        "XWD header dimensions match the requested screen",
        ` (got ${pixmapWidth}x${pixmapHeight})`,
      );
      check(pixmapDepth === 24, "XWD header depth is 24", ` (got ${pixmapDepth})`);

      // Pixel data starts after header_size (header + window-name string)
      // + the color table (ncolors * sizeof(XWDColor), 12 bytes each).
      const dataOffset = headerSize + ncolors * 12;
      const expectedPixelBytes = bytesPerLine * pixmapHeight;
      check(
        dataOffset > 0 && dataOffset < bytes.length,
        "pixel data offset is within the file",
        ` (offset=${dataOffset}, file=${bytes.length}B, expected pixel bytes=${expectedPixelBytes})`,
      );

      // "Not a single flat color": sample bytes spread across the pixel
      // region and confirm they're not all identical — i.e. xchat actually
      // drew a real main window (menubar/tree/text/input), not just a blank
      // Xvfb backdrop.
      let varied = false;
      if (dataOffset > 0 && dataOffset < bytes.length) {
        const first = bytes[dataOffset];
        const step = Math.max(1, Math.floor((bytes.length - dataOffset) / 8000));
        for (let i = dataOffset; i < bytes.length; i += step) {
          if (bytes[i] !== first) {
            varied = true;
            break;
          }
        }
      }
      check(varied, "pixel data is not a single flat color (xchat drew its main window)");
    }
  } else {
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  }
} finally {
  if (!pass) console.log("\n── final transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[xchat-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
