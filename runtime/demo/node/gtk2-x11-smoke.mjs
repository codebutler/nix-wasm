// gtk2-x11-smoke.mjs — M-X4 of the XChat/X11 epic. Boots (nix:true), launches
// Xvfb (M-X1), then runs gtk2-hello's VISUAL mode (a real GtkWindow + GtkLabel,
// no --selftest) against it — the live-window pixel proof that x11-apps-smoke.mjs
// (M-X2) already established for xeyes, now for a real GTK2 toolkit app. GTK2's
// X11 backend can be screenshotted headless this way; GTK3's wayland backend
// (gtk-smoke.mjs) never could, since the node harness has no real compositor —
// Xvfb needs none.
//
//   - xdpyinfo: a server-info query, asserting the real screen dimensions come
//     back over the wire (same check x11-apps-smoke.mjs uses, confirming Xvfb
//     is actually up before launching the GTK app against it).
//   - gtk2-hello (no args → visual mode): backgrounded, checked with `ps` a few
//     seconds later — proves it didn't crash/exit (gtk_main's event loop is
//     still running).
//   - xwd -root: dumps the actual server framebuffer (gtk2-hello's window
//     included, since Xvfb has no compositor) to /mnt/pc (the 9P-mounted host
//     VFS), then this script reads the file back HOST-SIDE and parses the real
//     XWD header (X11/XWDFile.h) to assert pixmap_width/height/depth match the
//     requested screen AND that the pixel data is not a single flat color
//     (i.e. gtk2-hello actually drew a window + label, not just a blank Xvfb
//     backdrop).
//
// See deps-overlay.nix's "GTK2 cross-build" section (M-X4) + userspace/
// gtk2-hello.* for the cross-build/proof-app details.
//
// Markers are picked per the #96 lesson: every waitForOutput regex requires a
// DIGIT that only exists after real shell expansion ($?), never a literal
// string also present in the ECHOED (not-yet-evaluated) command — so a marker
// can never match its own typed-but-unexecuted command line.
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
      console.log("[gtk2-x11-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

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

  // gtk2-hello, backgrounded, visual (no --selftest) mode: maps a real
  // GtkWindow + GtkLabel via GTK2's X11 backend. NOTE: do NOT use `$!` here —
  // this runs in the nix-system login shell's stock busybox ash (from the
  // squashfs), which leaves `$!` empty for a backgrounded job (same gap
  // x11-apps-smoke.mjs's xeyes launch documents) — probe liveness with `ps` +
  // a bracketed pattern instead.
  s.send("DISPLAY=:9 /bin/gtk2-hello > /tmp/gtk2-hello.log 2>&1 &\n");
  s.send("echo GTK2HELLO_LAUNCHED\n");
  const gotLaunch = await s.waitForOutput(/GTK2HELLO_LAUNCHED/, 15000);
  check(gotLaunch, "gtk2-hello launched");

  // Give it a few seconds to run its event loop, then prove it's still alive
  // by finding it in the process table.
  s.send("sleep 3; ps | grep '[g]tk2-hello' > /dev/null; echo GTK2HELLO_PS_RC:$?\n");
  const aliveOut = await s.waitForOutput(/GTK2HELLO_PS_RC:\d+/, 15000);
  const aliveMatch = /GTK2HELLO_PS_RC:(\d+)/.exec(s.snapshot());
  const helloAlive = aliveOut && aliveMatch && aliveMatch[1] === "0";
  check(helloAlive, "gtk2-hello is still running 3s later (found in ps)");
  if (!helloAlive) {
    s.send("cat /tmp/gtk2-hello.log\n");
    await new Promise((r) => setTimeout(r, 1500));
    console.log("\n── gtk2-hello.log ──\n" + s.snapshot().slice(-2000));
  }

  // xwd -root: dump the real server framebuffer (gtk2-hello's window
  // included — Xvfb has no compositor, so xwd sees exactly what's on screen)
  // to the 9P-mounted host VFS.
  s.send("DISPLAY=:9 xwd -root -silent -out /mnt/pc/Home/gtk2.xwd; echo XWDDONE_RC:$?\n");
  const xwdRan = await s.waitForOutput(/XWDDONE_RC:\d+/, 30000);
  const xwdMatch = /XWDDONE_RC:(\d+)/.exec(s.snapshot());
  const xwdOk = xwdRan && xwdMatch && xwdMatch[1] === "0";
  check(xwdOk, "xwd -root exits 0");

  if (xwdOk) {
    // Let the 9P write settle (same margin x11-apps-smoke.mjs's writeCheck uses).
    await new Promise((r) => setTimeout(r, 1500));
    let bytes;
    try {
      bytes = new Uint8Array(await (await vfs.readBlob("/Home/gtk2.xwd")).arrayBuffer());
    } catch (e) {
      check(false, "host VFS sees the written gtk2.xwd file", `: ${e.message}`);
    }
    if (bytes) {
      check(bytes.length > 100, "gtk2.xwd is non-trivially sized", ` (${bytes.length} bytes)`);

      // X11/XWDFile.h's XWDFileHeader: 25 big-endian CARD32 fields (xwd.c
      // always _swaplong()s to network byte order on write). Field indices
      // per the struct order (same layout x11-apps-smoke.mjs already verified
      // against the vendored xwd.c).
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
      // region and confirm they're not all identical — i.e. gtk2-hello
      // actually drew a window + label (a plain unpainted Xvfb backdrop
      // would be uniform).
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
      check(varied, "pixel data is not a single flat color (gtk2-hello drew something)");
    }
  } else {
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  }
} finally {
  if (!pass) console.log("\n── final transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[gtk2-x11-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
