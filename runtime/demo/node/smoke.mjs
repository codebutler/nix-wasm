// smoke.mjs — boots ONCE with the full nix-system wiring and runs the cheap
// per-boot assertions:
//   prompt → 9P read → write/overwrite/append → ls → nix-env -iA make-wasm32.
// The LINUX_WASM_ARTIFACTS nix-cache/ must be the .#wasm-binary-cache output
// (has the `make-wasm32` attr in pkgs.nix). See devtools-e2e.mjs for the full toolchain-install
// install-then-compile proof.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../../ninep/mem-vfs.js";

const vfs = MemVfs.from({
  Home: { "pc-9p-proof.txt": "written by pc's vfs.write\n" },
});

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};

const s = await bootNode({ vfs });

try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached");
  // The 9P-over-virtio transport negotiated a mount (printed per mount when the
  // guest clamps msize to the device max). This gates the #87 regression — if the
  // 9P virtio devices fail to register there is no mount and this line never prints
  // — and it is robust to the #83 console change: stock virtio-console attaches
  // hvc0 LATER than the retired hvc_wasm (no earlycon / hvc_instantiate, so the
  // pre-attach boot-log buffer is not replayed), which drops the earlier
  // "9pnet: Installing 9P2000 support" core-init line from the console. The
  // msize-clamp line is printed at boot mount time, after hvc0 is up, so it is
  // console-visible — and proves the *virtio* transport specifically, not just the
  // 9P protocol core. (9P function is independently proven by the read/write checks
  // below.)
  check(
    /9pnet:.*Limiting 'msize'.*supported by transport virtio/.test(s.snapshot()),
    "9P-over-virtio transport mounted",
  );

  // read path
  s.send("cat /mnt/pc/Home/pc-9p-proof.txt\n");
  check(await s.waitForOutput(/written by pc's vfs\.write/), "cat reads a real-VFS file over 9P");

  // write / overwrite / append round-trip back to the host VFS
  const FILE = "/Home/smoke-wtest.txt";
  const readVfs = async () => (await vfs.readBlob(FILE)).text();
  const writeCheck = async (cmd, expect, label) => {
    s.send(cmd);
    await new Promise((r) => setTimeout(r, 2500));
    const got = await readVfs().catch((e) => "ERR:" + e.message);
    check(
      got === expect,
      label,
      got === expect
        ? ""
        : `: vfs sees ${JSON.stringify(got)} (expected ${JSON.stringify(expect)})`,
    );
  };
  await writeCheck(`echo hello-from-linux > /mnt/pc${FILE}\n`, "hello-from-linux\n", "write");
  await writeCheck(`echo hi > /mnt/pc${FILE}\n`, "hi\n", "overwrite (O_TRUNC)");
  await writeCheck(`echo more >> /mnt/pc${FILE}\n`, "hi\nmore\n", "append");

  // directory read-back
  s.send("ls /mnt/pc/Home\n");
  check(await s.waitForOutput(/smoke-wtest\.txt/), "ls lists the written file");

  // nix-system: substitute a package from the committed binary cache.
  // Use `make-wasm32` (lightweight pdpmake; in .#wasm-binary-cache pkgs.nix) as the
  // smoke substitution package — the full install+compile proof is in devtools-e2e.mjs.
  // The catalog attrs are `lib.getName`-derived (#79), so this is `make-wasm32`, not
  // `make` (the stale `make` attr is what nix-boot-smoke caught when it was first run
  // in CI — see #88).
  // The software-MMU guest translates every memory access (2-level walk) + splits
  // page-crossing scalar accesses byte-wise, so the same substitute+unpack runs
  // ~2-3x slower than the NOMMU path. Allow the MMU boot job to raise the ceiling
  // via NIX_MAKE_TIMEOUT_MS (default 180s keeps the NOMMU nix-boot-smoke unchanged).
  const makeTimeoutMs = Number(process.env.NIX_MAKE_TIMEOUT_MS) || 180000;
  // DIAGNOSTIC (#166/#131 cache-fallthrough localizer, revert once fixed): the MMU
  // prove-job's guest queried nix-wasm.cachix.org for make-wasm32.drv (external
  // fetch → DNS fail) even though system.nix forces substituters=[file:///nix-cache].
  // Dump the EFFECTIVE substituters, the nix.conf sources, NIX_CONFIG, and whether
  // make-wasm32's .drv narinfo is actually present in the served /nix-cache — the
  // one boot-only fact that pins whether the cache is incomplete or a stray
  // substituter is configured. Printed unconditionally (before the install) so it
  // lands in the log whether or not the install then succeeds.
  s.send(
    "echo MMUDIAG_START; nix show-config 2>/dev/null | grep -iE '^(substituters|substitute|require-sigs)'; " +
      "echo ETC_CONF=$(tr '\\n' '|' </etc/nix/nix.conf 2>/dev/null); " +
      "echo USER_CONF=$(tr '\\n' '|' <~/.config/nix/nix.conf 2>/dev/null); " +
      'echo NIX_CONFIG_ENV="[$NIX_CONFIG]"; ' +
      "echo MAKEWASM_DRV_IN_CACHE=$(ls /nix-cache 2>/dev/null | grep -c 'make-wasm32.*\\.drv'); " +
      "echo MMUDIAG_END\n",
  );
  await s.waitForOutput(/MMUDIAG_END/, 30000);
  console.log(
    "\n── MMUDIAG ──\n" +
      (s.snapshot().match(/MMUDIAG_START[\s\S]*?MMUDIAG_END/)?.[0] ?? "(not captured)"),
  );
  s.send("nix-env -iA wasm-tools.make-wasm32 2>&1; echo NIX_MAKE_RC=$?\n");
  check(
    await s.waitForOutput(/NIX_MAKE_RC=0/, makeTimeoutMs),
    "nix-env -iA make-wasm32 substitutes from the cache",
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-2000));
  s.kill();
}

console.log("\n[smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
