// Phase 2 T1b capstone — interactive in-guest fork() compilation.
//
// Boots the full nix system (the /nix closure carries cc-fork, the in-guest
// clang/wasm-ld, the cross-built wasm-opt, and musl-fork), writes a fork() C
// program in the guest, compiles it with `cc-fork` (clang -> wasm-ld+musl-fork ->
// in-guest wasm-opt --asyncify), runs it, and asserts the double return + private
// memory — all from guest-resident tools, no host build.
//
// Exit 0 = PASS, 1 = FAIL, 2 = inconclusive (boot panic — re-run). Needs
// LINUX_WASM_ARTIFACTS=file:///path/ (vmlinux.wasm, initramfs.cpio.gz, store.json
// + store-content/). Slow: in-guest clang loads a ~57 MB module, wasm-opt ~10 MB.
import { installWebShims } from "./web-shims.mjs";
import { bootNixSystem } from "../../index.js";
import { MemVfs } from "../../ninep/mem-vfs.js";

installWebShims();

const ARTIFACTS =
  process.env.LINUX_WASM_ARTIFACTS || new URL("../web/artifacts/", import.meta.url).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The in-guest fork program (heredoc'd into the guest fs). cc-fork asyncifies via
// pure reachability from the capture_stack import — no addlist, any call depth.
const PROG = [
  "#include <unistd.h>",
  "#include <sys/wait.h>",
  "#include <stdio.h>",
  "#include <stdlib.h>",
  "int main(void){",
  "  volatile int w=0x200;",
  "  pid_t p=fork();",
  '  if(p==0){ w+=0x0C; printf("INGUEST CHILD ret=0 w=0x%x\\n",w); fflush(stdout); _exit(9); }',
  "  int st=0; waitpid(p,&st,0);",
  '  w+=0xA0; printf("INGUEST PARENT pid=%d w=0x%x cexit=%d\\n",p,w,WEXITSTATUS(st)); fflush(stdout);',
  "  return 0;",
  "}",
].join("\n");

async function main() {
  const vfs = MemVfs.from({ Home: {} });
  const handle = await bootNixSystem({ vfs, baseUrl: ARTIFACTS, nix: true });

  let out = "";
  handle.console(0).onData((b) => (out += new TextDecoder().decode(b)));
  const send = (s) => handle.console(0).write(s);
  const waitFor = async (re, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (/panic/i.test(out)) return "panic";
      if (re.test(out)) return true;
      await sleep(500);
    }
    return false;
  };

  // Wait for the autologin shell (nix boot prints user_as markers after the
  // prompt, so use a sentinel round-trip rather than an anchored prompt).
  let ready = false;
  const dl = Date.now() + 180000;
  while (Date.now() < dl) {
    if (/panic/i.test(out)) {
      console.error("BOOT PANIC:\n" + out.slice(-2000));
      handle.kill();
      process.exit(2);
    }
    send("echo CAP_$((20+2))_READY\n");
    if (await waitFor(/CAP_22_READY/, 4000)) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    console.error("no shell:\n" + out.slice(-2000));
    handle.kill();
    process.exit(2);
  }
  console.log("ok  shell reached");

  // Write the program into the guest fs via a heredoc, then compile + run.
  out = "";
  send("cat > /tmp/fork.c <<'EOF'\n" + PROG + "\nEOF\necho WROTE_$?\n");
  if ((await waitFor(/WROTE_0/, 15000)) !== true) {
    console.error("write failed:\n" + out.slice(-1500));
    handle.kill();
    process.exit(1);
  }
  console.log("ok  wrote /tmp/fork.c");

  // Compile with cc-fork (this loads clang.wasm + wasm-opt.wasm — slow).
  out = "";
  send("cc-fork /tmp/fork.c -o /tmp/fork; echo CC_$?\n");
  const cc = await waitFor(/CC_(\d+)/, 240000);
  if (cc === "panic") {
    console.error("PANIC during compile:\n" + out.slice(-2000));
    handle.kill();
    process.exit(2);
  }
  const ccm = /CC_(\d+)/.exec(out);
  console.log("cc-fork output:\n" + out.slice(-800));
  if (!ccm || ccm[1] !== "0") {
    console.error("cc-fork failed (exit " + (ccm ? ccm[1] : "?") + ")");
    handle.kill();
    process.exit(1);
  }
  console.log("ok  cc-fork compiled /tmp/fork");

  // Run the in-guest-built fork program.
  out = "";
  send("/tmp/fork; echo RUN_$?\n");
  const run = await waitFor(/RUN_(\d+)/, 60000);
  if (run === "panic") {
    console.error("PANIC during run:\n" + out.slice(-2000));
    handle.kill();
    process.exit(2);
  }
  console.log("run output:\n" + out.slice(-800));
  handle.kill();

  const child = /INGUEST CHILD ret=0 w=0x([0-9a-f]+)/.exec(out);
  const parent = /INGUEST PARENT pid=(\d+) w=0x([0-9a-f]+) cexit=(\d+)/.exec(out);
  const checks = [
    ["in-guest build: returns twice — CHILD (fork()==0)", !!child],
    ["in-guest build: returns twice — PARENT (fork()>0)", !!parent && Number(parent[1]) > 0],
    ["in-guest build: private memory (child 0x20c)", child && child[1] === "20c"],
    ["in-guest build: private memory (parent 0x2a0, diverged)", parent && parent[2] === "2a0"],
    ["in-guest build: waitpid child exit 9", parent && Number(parent[3]) === 9],
    ["in-guest build: exited 0", /RUN_0/.test(out)],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    ok = ok && !!pass;
  }
  if (!ok) {
    console.error("IN-GUEST FORK FAIL");
    process.exit(1);
  }
  console.log(
    "IN-GUEST FORK PASS — cc-fork compiled a fork() program in-guest and it returns twice",
  );
}

main().catch((e) => {
  console.error("harness error:", e && e.stack ? e.stack : e);
  process.exit(2);
});
