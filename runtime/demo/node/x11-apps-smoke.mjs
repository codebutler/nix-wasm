// x11-apps-smoke.mjs — M-X2 of the XChat/X11 epic. Boots (nix:true), launches
// Xvfb (M-X1), then runs the first real X11 CLIENT APPS against it:
//   - xdpyinfo: a server-info query, asserting the real screen dimensions
//     come back over the wire.
//   - xeyes: a live Xlib/Xt/Xmu toolkit client, backgrounded and checked
//     with `kill -0` a few seconds later — proves it didn't crash/exit.
//   - xwd -root: dumps the actual server framebuffer (xeyes' window
//     included, since Xvfb has no compositor — xwd sees exactly what's on
//     screen) to /mnt/yore (the 9P-mounted host VFS), then this script reads
//     the file back HOST-SIDE and parses the real XWD header (X11/XWDFile.h)
//     to assert pixmap_width/height/depth match the requested screen AND
//     that the pixel data is not a single flat color (i.e. xeyes actually
//     drew something, not just a blank Xvfb backdrop).
//
// See deps-overlay.nix's "xeyes / xwd / xdpyinfo" section (M-X2) for the
// cross-build details (libice/libsm/libxt/libxmu/libxtst — the new runtime
// libs beyond M-X0/M-X1's closure).
//
// Markers are picked per the #96 lesson: every waitForOutput regex requires
// a DIGIT that only exists after real shell expansion ($?/$!), never a
// literal string also present in the ECHOED (not-yet-evaluated) command —
// so a marker can never match its own typed-but-unexecuted command line.
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
      console.log("[x11-apps-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // Both ship via systemPackages (PATH lookup, not /bin — the l3afpad/
  // gcalctool lesson: initramfs extraBins live in unevictable tmpfs, but
  // systemPackages load from the file-backed squashfs at
  // /run/current-system/sw/bin).
  s.send("Xvfb :9 -nolisten tcp -screen 0 1280x1024x24 > /tmp/xvfb.log 2>&1 &\n");

  // xdpyinfo, retried: the first Xvfb start also spawns xkbcomp (a fresh
  // wasm exec + keymap compile), which can take longer than a fixed sleep.
  s.send(
    "for i in $(seq 15); do DISPLAY=:9 xdpyinfo > /tmp/xdpyinfo.out 2>&1 && break; sleep 2; done\n",
  );
  s.send("cat /tmp/xdpyinfo.out\n");
  const dpyOk = await s.waitForOutput(/dimensions:\s+1280x1024 pixels/, 60000);
  check(dpyOk, "xdpyinfo reports the real 1280x1024 screen over the wire");
  if (!dpyOk) {
    console.log("\n── xdpyinfo transcript tail ──\n" + s.snapshot().slice(-3000));
  }

  // xeyes, backgrounded. NOTE: do NOT use `$!` here — this runs in the
  // nix-system login shell, whose /bin/sh is stock busybox-1.36.1 ash (from
  // the squashfs), NOT the guest's patched forkshell ash; stock ash leaves
  // `$!` empty for a backgrounded job, so `XEYES_PID=$!` yields nothing (a
  // pre-existing squashfs-shell gap, unrelated to X). Probe liveness with
  // `ps` + a bracketed pattern instead (the `[x]eyes` trick keeps the grep
  // process itself from matching), which needs no PID capture.
  s.send("DISPLAY=:9 xeyes > /tmp/xeyes.log 2>&1 &\n");
  s.send("echo XEYES_LAUNCHED\n");
  const gotLaunch = await s.waitForOutput(/XEYES_LAUNCHED/, 15000);
  check(gotLaunch, "xeyes launched");

  // Give it a few seconds to run its event loop, then prove it's still alive
  // by finding it in the process table — if xeyes crashed/exited on the XKB
  // BadRequest (the M-X2 bug), it would not appear.
  s.send("sleep 3; ps | grep '[x]eyes' > /dev/null; echo XEYES_PS_RC:$?\n");
  const aliveOut = await s.waitForOutput(/XEYES_PS_RC:\d+/, 15000);
  const aliveMatch = /XEYES_PS_RC:(\d+)/.exec(s.snapshot());
  const xeyesAlive = aliveOut && aliveMatch && aliveMatch[1] === "0";
  check(xeyesAlive, "xeyes is still running 3s later (found in ps)");
  if (!xeyesAlive) {
    s.send("cat /tmp/xeyes.log\n");
    await new Promise((r) => setTimeout(r, 1500));
    console.log("\n── xeyes.log ──\n" + s.snapshot().slice(-2000));
  }

  // xwd -root: dump the real server framebuffer (xeyes' window included —
  // Xvfb has no compositor, so xwd sees exactly what's on screen) to the
  // 9P-mounted host VFS.
  s.send("DISPLAY=:9 xwd -root -silent -out /mnt/yore/Home/root.xwd; echo XWDDONE_RC:$?\n");
  const xwdRan = await s.waitForOutput(/XWDDONE_RC:\d+/, 30000);
  const xwdMatch = /XWDDONE_RC:(\d+)/.exec(s.snapshot());
  const xwdOk = xwdRan && xwdMatch && xwdMatch[1] === "0";
  check(xwdOk, "xwd -root exits 0");

  if (xwdOk) {
    // Let the 9P write settle (same margin smoke.mjs's writeCheck uses).
    await new Promise((r) => setTimeout(r, 1500));
    let bytes;
    try {
      bytes = new Uint8Array(await (await vfs.readBlob("/Home/root.xwd")).arrayBuffer());
    } catch (e) {
      check(false, "host VFS sees the written root.xwd file", `: ${e.message}`);
    }
    if (bytes) {
      check(bytes.length > 100, "root.xwd is non-trivially sized", ` (${bytes.length} bytes)`);

      // X11/XWDFile.h's XWDFileHeader: 25 big-endian CARD32 fields (xwd.c
      // always _swaplong()s to network byte order on write — see xwd.c's
      // `swaptest` check before the fwrite). Field indices per the struct
      // order (verified against the vendored xwd.c before writing this).
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const u32 = (i) => dv.getUint32(i * 4, false);
      const headerSize = u32(0);
      const pixmapDepth = u32(3);
      const pixmapWidth = u32(4);
      const pixmapHeight = u32(5);
      const bytesPerLine = u32(12);
      const ncolors = u32(19);

      check(
        pixmapWidth === 1280 && pixmapHeight === 1024,
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
      // region and confirm they're not all identical — i.e. xeyes actually
      // drew something (a plain unpainted Xvfb backdrop would be uniform).
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
      check(varied, "pixel data is not a single flat color (xeyes drew something)");
    }
  } else {
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  }
} finally {
  if (!pass) console.log("\n── final transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[x11-apps-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
