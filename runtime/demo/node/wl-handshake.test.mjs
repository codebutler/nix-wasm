// wl-handshake.test.mjs — node:test gate for the Wayland registry round-trip
// (issue #30). Boots the busybox guest, runs /bin/waylandproxyd + the stock
// libwayland /bin/wlhandshake client, and asserts the handshake completes:
//
//   wlhandshake --AF_UNIX--> waylandproxyd --VIRTWL SEND--> JS virtio-wl device
//   --OUT--> host WlServer fallback (no compositor bridge: WlDevice.serveLocal)
//   --IN VFD_RECV--> guest --RECV--> waylandproxyd --> wlhandshake sees globals.
//
// The host→guest reply leg is the path #30 found broken: with no Greenfield
// bridge wired the node harness used to DROP the SEND ("no host bridge wired").
// The fix serves it on the host-side WlDevice, so this is now a real regression
// gate — it exercises the same IN vring + raised_irqs self-wake the compositor
// path uses, just with the registry-handshake WlServer instead of Greenfield.
//
// Artifact source / SKIP behavior mirror boot.test.mjs (prerequisite-gate only;
// nix:false busybox boot — wlhandshake + waylandproxyd are initramfs extraBins).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installWebShims, terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const haveArtifacts =
  !ARTIFACTS.startsWith("file:") || existsSync(fileURLToPath(new URL("vmlinux.wasm", ARTIFACTS)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test(
  "stock libwayland client completes the registry handshake through virtio-wl",
  {
    timeout: 180000,
    skip: haveArtifacts
      ? false
      : "set LINUX_WASM_ARTIFACTS or symlink runtime/web/artifacts to a `nix build` output",
  },
  async () => {
    installWebShims();
    const vfs = MemVfs.from({ Home: {} });
    const handle = await bootNixSystem({ vfs, baseUrl: ARTIFACTS, nix: false });
    let out = "";
    handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
    const send = (s) => handle.console(0).write(s);
    const waitFor = async (re, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (re.test(out)) return true;
        if (/panic/i.test(out)) throw new Error("KERNEL_PANIC:\n" + out);
        await sleep(200);
      }
      return false;
    };

    try {
      assert.ok(await waitFor(/[#$]\s*$/m, 90000), "expected a shell prompt (boot panic?)");

      // wl_display_connect(NULL) composes "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY".
      send("export XDG_RUNTIME_DIR=/tmp\n");
      send("export WAYLAND_DISPLAY=wayland-0\n");
      send("/bin/waylandproxyd & sleep 1\n");
      assert.ok(
        await waitFor(/RESULT waylandproxyd PASS .*listening/, 15000),
        "waylandproxyd did not come up",
      );

      send("/bin/wlhandshake; echo HSDONE=$?\n");
      assert.ok(await waitFor(/HSDONE=\d/, 30000), "wlhandshake did not finish");

      assert.doesNotMatch(out, /RESULT wl-handshake FAIL/, "wlhandshake reported FAIL");
      const m = out.match(/RESULT wl-handshake PASS (\d+)/);
      assert.ok(m, "wlhandshake produced no RESULT PASS marker (host->guest reply stall?)");
      assert.ok(Number(m[1]) > 0, "expected the client to enumerate at least one global");
    } finally {
      handle.kill();
      await terminateAllWorkers();
    }
  },
);
