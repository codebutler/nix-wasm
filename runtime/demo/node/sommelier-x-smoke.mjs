// sommelier-x-smoke.mjs — M-X3 of the XChat/X11 epic. Boots (nix:true) with
// NO manual setup: userspace/init.nix's guest-owned `xwaylandLine` respawn
// entry should already be spawning a SECOND, independent Sommelier instance
// (`sommelier -X --x-display=1`) that owns/spawns the cross-built Xwayland
// (deps-overlay.nix's "Xwayland" section) — distinct from the `--parent`
// Wayland-only daemon (`waylandLine`) that was already running before this
// milestone.
//
// SESSION RECORD (2026-08-05) — read before changing the CI-gating decision:
//   PASSES headlessly, boot-verified against a locally-built kernel +
//   initramfs + squashfs (this milestone's own build, not a stale artifact):
//     - Both `sommelier` processes (the pre-existing `--parent` daemon AND
//       this milestone's `-X` daemon) show up in `ps`.
//     - The `{Xwayland}` child process shows up in `ps` under the `-X`
//       daemon, running from the exact cross-built store path
//       (deps-overlay.nix's "Xwayland" section) — i.e. Sommelier's
//       posix_spawn of Xwayland (patches/sommelier/0001, sl_spawn_xwayland)
//       genuinely succeeds on this guest.
//   DOES NOT pass headlessly (confirmed, not just "untried"):
//     - `DISPLAY=:1 xdpyinfo` HANGS indefinitely — it never returns, not
//       even with a real error. Re-run twice (once inside this smoke's own
//       bounded retry loop, once in a standalone diagnostic boot with a
//       long single attempt) with the same result: no X11 ServerRefused/
//       ProtocolError, no bytes back at all.
//     - Working theory (NOT yet root-caused): Xwayland's `-displayfd`/`-wm`
//       handshake with Sommelier requires Sommelier's OWN Wayland registry
//       roundtrip to complete first (`sl_connect` in
//       `sl_handle_display_ready_event`), and Xwayland itself is a Wayland
//       CLIENT that needs at least `wl_compositor`/`wl_shm`/`xdg_wm_base`
//       (or the aura_shell globals ChromeOS's real compositor offers) bound
//       before it will finish `screen 0` init and open its X11 listen
//       socket. This Node harness's WlDevice is a MINIMAL registry with NO
//       compositor behind it (same documented limitation as the M3b/M4 GTK
//       gates — see CLAUDE.md) — Xvfb never hits this because it has NO
//       Wayland dependency at all, so M-X1/M-X2's harness never exercised
//       this class of wait. This is a real, unresolved gap, not a hack to
//       paper over: do NOT add a sleep/retry-count workaround that merely
//       hides a hang.
//   DECISION: this script is NOT wired into any CI workflow (nix-wasm.yml's
//   boot-smoke or otherwise). A gate that cannot pass headlessly must not be
//   gating, per repo policy — CI stays green, and `ps`-level proof (Xwayland
//   spawns and stays alive) is left as informal, run-by-hand evidence rather
//   than an asserted, always-red CI job. The visual milestone's actual
//   definition of done is the BROWSER check below.
//
// BROWSER CHECK (manual, defines the actual M-X3 visual milestone):
//   Boot pc's Linux app in a real browser (Greenfield compositor, real GL —
//   see CLAUDE.md's Playwright/Greenfield notes for the SwiftShader flags a
//   headless run needs). In the guest, confirm both sommelier daemons +
//   Xwayland are up (same `ps` check as above), then run a real X11 client
//   (`DISPLAY=:1 xeyes`, or `xdpyinfo`/`xwd` per the M-X2 pattern) and
//   confirm: (1) the client actually connects (no hang) now that a REAL
//   compositor is answering Sommelier's Wayland roundtrip; (2) a window for
//   it appears as a REAL pc window (via Greenfield), not a headless dump.
//   If step (1) still hangs against a real compositor, the working theory
//   above is wrong and needs fresh diagnosis (trace Xwayland's own stderr —
//   `-displayfd`'s write-side and Sommelier's `sl_handle_display_ready_event`
//   read-side — rather than iterating on this harness further).
//
// What THIS script proves, all over the real X11 wire, as far as it goes:
//   - `ps` shows both `sommelier` (the -X instance) and `Xwayland` running.
//   - `DISPLAY=:1 xdpyinfo` is ATTEMPTED against Xwayland specifically (NOT
//     Xvfb, which M-X1/M-X2's x11-apps-smoke.mjs runs on a manually-started
//     :9) — currently expected to FAIL per the session record above.
//   - IF it ever starts succeeding (e.g. after a future engine/harness
//     change adds compositor globals), the script also compares Xwayland's
//     reported "X.Org version:" against a same-boot Xvfb :9 instance to
//     confirm they're genuinely different xserver releases (21.1.23 vs
//     24.1.12), not just different DISPLAY numbers.
//
// Markers per the #96 lesson (a digit that only exists after real shell
// expansion, never a substring of an earlier marker).
//
// Exit 0 pass / 1 fail (expected today — see session record) / 2
// inconclusive (boot panic — re-run).
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
      console.log("[sommelier-x-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");

  // Give the guest-owned respawn entries (waylandLine, xwaylandLine,
  // ninepdLine) time to come up — xwaylandLine additionally waits on the
  // served /nix squashfs (Xwayland ships via environment.systemPackages, not
  // initramfs extraBins) which activates a little after the login prompt.
  s.send(
    "for i in $(seq 30); do ps | grep -q '[X]wayland' && break; sleep 1; done; " +
      "ps | grep -E '[Ss]ommelier|[X]wayland' > /tmp/ps.out; echo PSCHECK_RC:$?\n",
  );
  const psRan = await s.waitForOutput(/PSCHECK_RC:\d+/, 45000);
  check(psRan, "ps check ran");
  s.send("cat /tmp/ps.out\n");
  await new Promise((r) => setTimeout(r, 500));
  const psOut = s.snapshot();
  const sommelierCount = (psOut.match(/\bsommelier\b/g) || []).length;
  const xwaylandUp = /\bXwayland\b/.test(psOut);
  // Two sommelier processes: the --parent daemon (waylandLine) + the -X
  // daemon (xwaylandLine). grep's own invocation also matches the pattern
  // text once per line in the transcript echo, so assert >=2 real hits
  // rather than an exact count (transcript-echo noise, not a process count).
  check(
    sommelierCount >= 2,
    "both sommelier daemons show up in ps",
    ` (matches=${sommelierCount})`,
  );
  check(xwaylandUp, "Xwayland process is running under the -X sommelier");

  if (!xwaylandUp) {
    s.send("cat /var/log/sommelier-x.log\n");
    await new Promise((r) => setTimeout(r, 1000));
    console.log("\n── sommelier-x.log ──\n" + s.snapshot().slice(-3000));
  }

  // A real X11 client against Xwayland specifically — DISPLAY=:1, never :9.
  s.send(
    "for i in $(seq 20); do DISPLAY=:1 xdpyinfo > /tmp/xdpyinfo-xwl.out 2>&1 && break; sleep 2; done\n",
  );
  s.send("cat /tmp/xdpyinfo-xwl.out\n");
  const xwlDpyOk = await s.waitForOutput(/X\.Org version:/, 60000);
  check(xwlDpyOk, "xdpyinfo (DISPLAY=:1) reaches the Xwayland server");
  const xwlVersionMatch = /X\.Org version:\s*(\S+)/.exec(s.snapshot());
  const xwlVersion = xwlVersionMatch ? xwlVersionMatch[1] : null;
  console.log(`  info  Xwayland (:1) X.Org version: ${xwlVersion}`);

  if (!xwlDpyOk) {
    console.log("\n── xdpyinfo-xwl transcript tail ──\n" + s.snapshot().slice(-3000));
  } else {
    // Now start Xvfb (:9, M-X1's server) IN THE SAME BOOT and confirm its
    // reported version genuinely differs — the two servers come from
    // different upstream xserver source releases (21.1.23 vs 24.1.12), so
    // this is a real distinguishing signal, not just "a different number".
    s.send("Xvfb :9 -nolisten tcp -screen 0 1280x1024x24 > /tmp/xvfb.log 2>&1 &\n");
    s.send(
      "for i in $(seq 15); do DISPLAY=:9 xdpyinfo > /tmp/xdpyinfo-xvfb.out 2>&1 && break; sleep 2; done\n",
    );
    s.send("cat /tmp/xdpyinfo-xvfb.out\n");
    const xvfbDpyOk = await s.waitForOutput(/dimensions:\s+1280x1024 pixels/, 60000);
    check(xvfbDpyOk, "xdpyinfo (DISPLAY=:9) reaches the separate Xvfb server");
    const fullTranscript = s.snapshot();
    const versionMatches = [...fullTranscript.matchAll(/X\.Org version:\s*(\S+)/g)];
    const xvfbVersion =
      versionMatches.length > 1 ? versionMatches[versionMatches.length - 1][1] : null;
    console.log(`  info  Xvfb (:9) X.Org version: ${xvfbVersion}`);
    check(
      xvfbVersion != null && xwlVersion != null && xvfbVersion !== xwlVersion,
      "Xwayland (:1) and Xvfb (:9) report DIFFERENT X.Org versions",
      ` (Xwayland=${xwlVersion}, Xvfb=${xvfbVersion})`,
    );
  }
} finally {
  if (!pass) console.log("\n── final transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
console.log("\n[sommelier-x-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
