// dlopen-smoke.mjs — boots (nix:true) and runs the #130 dlopen/dlsym
// acceptance in-guest, BOTH ABI variants:
//   dltest         — plain build: raw-signature dl path (dynamic table install)
//   dltest-fpcast  — dynsym-injected + fpcast'd build opening the fpcast'd side
//                    module: the canonical-thunk path GTK/GModule apps use.
// Each exercises dlopen(NULL)+dlsym-self, dlopen of a real side-module file
// off the guest FS (store path → needs nix:true), dlsym of function + data
// symbols, ctor execution, and dlerror. PASS line per variant:
// `DLTEST: self=1 side=1 ctor=1 err=1 OK`.
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(180000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[dlopen-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!reached) throw new Error("no prompt");
  s.send("dltest; echo PLAIN_RC=$?\n");
  const plain = await s.waitForOutput(/DLTEST: self=1 side=1 ctor=1 err=1 OK/, 120000);
  await s.waitForOutput(/PLAIN_RC=0/, 30000);
  s.send("dltest-fpcast; echo FPC_RC=$?\n");
  const fpcast = await s.waitForOutput(
    /DLTEST: self=1 side=1 ctor=1 err=1 OK[\s\S]*DLTEST: self=1 side=1 ctor=1 err=1 OK/,
    120000,
  );
  await s.waitForOutput(/FPC_RC=0/, 30000);
  pass = plain && fpcast;
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-2000));
  s.kill();
}
console.log("\n[dlopen-smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
