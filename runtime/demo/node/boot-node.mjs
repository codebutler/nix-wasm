// boot-node.mjs — boot the linux-wasm guest to a shell from Node, returning a
// session with raw consoles + an expect API (send/waitForOutput/waitForPrompt).
import { terminateAllWorkers } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

// Artifacts: default to the env var, else the repo-relative web/artifacts dir.
// CI sets LINUX_WASM_ARTIFACTS to the `nix build` output dir.
const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function bootNode(opts = {}) {
  const vfs = opts.vfs || MemVfs.from(opts.seed || { Home: {} });
  const handle = await bootNixSystem({
    vfs,
    baseUrl: opts.baseUrl || ARTIFACTS,
    nix: opts.nix !== false,
    cmdline: opts.cmdline,
    onLog: opts.onLog,
    // #177: RW state disk (/dev/vdb). Passed through for G1/G3 smokes.
    stateDisk: opts.stateDisk,
    // Issue #10 option 3: the virtio-vsock /Ctl bridge hook. Passed straight
    // through so a smoke can register a host listener (device.listen(port, …))
    // via vsock.onReady(device). Absent for boots that don't exercise vsock.
    vsock: opts.vsock,
    // Issue #145: the virtio-snd PCM sink hook. Passed straight through so a
    // smoke can attach a recorder (device.setSink({ onPcm, … })) via
    // snd.onReady(device). Absent for boots that don't exercise audio.
    snd: opts.snd,
    // #11 items 2/3/5: the Wayland compositor bridge hook (worker→main
    // Greenfield shape: sendOut(clientId, buffer, fds), fds are live
    // Uint8Array VIEWS over guest memory resolved by the host WlDevice's
    // _resolveShmFd — see runtime/virtio/wl-device.js). Passed straight
    // through so a smoke can assert on the exact bytes a VFD_SEND's attached
    // shm vfds resolve to, without a real compositor. Absent for boots that
    // don't exercise this (falls back to the in-process WlServer stub).
    wayland: opts.wayland,
  });

  const transcripts = new Map();
  const tapped = new Set();
  const tap = (n) => {
    if (tapped.has(n)) return;
    transcripts.set(n, "");
    handle.console(n).onData((bytes) => transcripts.set(n, transcripts.get(n) + dec.decode(bytes)));
    tapped.add(n);
  };

  return {
    handle,
    consoleCount: handle.consoleCount,
    console: (n) => handle.console(n),
    snapshot(n = 0) {
      tap(n);
      return transcripts.get(n) || "";
    },
    send(s, n = 0) {
      handle.console(n).write(s);
    },
    async waitForOutput(re, ms = 15000, n = 0) {
      tap(n);
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (re.test(transcripts.get(n) || "")) return true;
        await sleep(200);
      }
      return false;
    },
    async waitForPrompt(ms = 45000, n = 0) {
      tap(n);
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const b = transcripts.get(n) || "";
        if (/panic/i.test(b)) throw new Error("KERNEL_PANIC");
        if (/[#$]\s*$/.test(b.trimEnd())) return true;
        await sleep(500);
      }
      return false;
    },
    kill() {
      handle.kill(); // stops the 9P Atomics.waitAsync loop
      terminateAllWorkers(); // terminates the kernel worker_threads workers
    },
  };
}

// Test-only: point the booted guest at the LOCAL /nix-cache (9P) for
// substitution. The SHIPPED guest substitutes from nix-wasm.cachix.org over its
// own TCP/IP (real-NixOS; js/vnet/wan over the Wisp uplink), which the offline CI
// harness can't reach. So each nix smoke primes a USER-level nix.conf that
// overrides the substituter back to the local 9P cache (still mounted at
// /nix-cache for the catalogs) — the standard "give the offline test a local
// cache" shape, with NO change to the baked (Cachix-only) system config. Keep
// `always-allow-substitutes = true` in this override: `guest-cc`/`guest-cxx` are
// trivial builders with `allowSubstitutes = false`, and without this setting the
// guest tries to build them locally (platform mismatch / std::bad_alloc) instead
// of substituting the cached outputs.
// Call AFTER waitForPrompt(), before any nix command.
export async function primeLocalNixCache(session, { timeoutMs = 15000 } = {}) {
  // Write via $HOME, NOT ~. The MMU/fork boot's /bin/sh is busybox hush, built
  // WITHOUT CONFIG_HUSH_TILDE, so it does NOT expand `~` — `~/.config/nix` would
  // become a literal `~` directory and nix (which reads $HOME/.config/nix/nix.conf)
  // never sees the primed override, falling back to the baked Cachix substituter
  // (DNS-fails offline). The NOMMU boot's forkshell ash expands `~`, so this only
  // bit the MMU nix-boot-smoke. $HOME is expanded by both shells and is exactly
  // the path nix resolves, so it works everywhere.
  session.send(
    "mkdir -p $HOME/.config/nix && " +
      "printf 'substituters = file:///nix-cache\\n" +
      "trusted-substituters = file:///nix-cache\\n" +
      "require-sigs = false\\n" +
      "substitute = true\\n" +
      "always-allow-substitutes = true\\n' " +
      "> $HOME/.config/nix/nix.conf && echo LOCAL_NIX_CACHE_READY=$?\n",
  );
  const ok = await session.waitForOutput(/LOCAL_NIX_CACHE_READY=0/, timeoutMs);
  if (!ok) throw new Error("primeLocalNixCache: guest did not confirm the nix.conf write");
}
