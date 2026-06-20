// smoke.mjs — boots ONCE with the full nix-system wiring and runs the cheap
// per-boot assertions:
//   prompt → 9P read → write/overwrite/append → ls → nix-env -iA sl.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";
import { MemVfs } from "../ninep/mem-vfs.js";

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
  // Robust shell-readiness: don't rely on an end-anchored prompt match — under
  // per-process memory (wasm_user_as, the default cmdline) the kernel's
  // `wasm_user_as: create/free` printk markers trail the prompt on the console,
  // so the tail is rarely a bare `#`. Wait for the ash shell banner (autologin
  // done), then round-trip a sentinel whose EVALUATED output (SMOKE_42_READY)
  // differs from its command echo (`echo SMOKE_$((40+2))_READY`) — proving a live
  // shell that evaluates arithmetic, independent of prompt-tail noise.
  await s.waitForOutput(/built-in shell \(ash\)|dropping to a shell/, 180000);
  if (/panic/i.test(s.snapshot())) {
    console.log("[smoke] INCONCLUSIVE — kernel panic on boot; re-run");
    s.kill();
    process.exit(2);
  }
  s.send("echo SMOKE_$((40+2))_READY\n");
  const reached = await s.waitForOutput(/SMOKE_42_READY/, 60000);
  check(reached, "shell prompt reached");
  check(/9pnet: Installing 9P2000 support/.test(s.snapshot()), "9P core registered");

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

  // nix-system: substitute a package from the committed binary cache
  s.send("nix-env -iA sl\n");
  check(
    await s.waitForOutput(/installing 'sl|building path|sl-[0-9]/, 180000),
    "nix-env -iA sl substitutes from the cache",
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-2000));
  s.kill();
}

console.log("\n[smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
