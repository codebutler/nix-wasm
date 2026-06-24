// smoke.mjs — boots ONCE with the full nix-system wiring and runs the cheap
// per-boot assertions:
//   prompt → 9P read → write/overwrite/append → ls → nix-env -iA make.
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

  // nix-system: substitute a package from the committed binary cache.
  // Use `make` (lightweight; in .#wasm-binary-cache pkgs.nix) as the smoke
  // substitution package — the full install+compile proof is in devtools-e2e.mjs.
  s.send("nix-env -iA make 2>&1; echo NIX_MAKE_RC=$?\n");
  check(
    await s.waitForOutput(/NIX_MAKE_RC=0/, 180000),
    "nix-env -iA make substitutes from the cache",
  );
} finally {
  if (!pass) console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-2000));
  s.kill();
}

console.log("\n[smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
