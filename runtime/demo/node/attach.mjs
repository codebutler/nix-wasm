// attach.mjs — interactive REPL: drop into the guest shell from Node.
// Usage: node node/attach.mjs [--no-nix]
// Detach + shut down with Ctrl-] .
import { bootNode } from "./boot-node.mjs";

const nix = !process.argv.includes("--no-nix");
process.stderr.write(`[attach] booting kernel (nix=${nix})…\n`);
const s = await bootNode({ nix });

const con = s.console(0);
con.onData((b) => process.stdout.write(b));

const stdin = process.stdin;
stdin.setRawMode?.(true);
stdin.resume();
stdin.on("data", (buf) => {
  if (buf.length === 1 && buf[0] === 0x1d) {
    // Ctrl-]
    process.stderr.write("\n[attach] detaching\n");
    stdin.setRawMode?.(false);
    s.kill();
    process.exit(0);
  }
  con.write(buf);
});

const syncSize = () => {
  if (process.stdout.columns) con.resize(process.stdout.columns, process.stdout.rows);
};
syncSize();
process.stdout.on("resize", syncSize);
process.stderr.write("[attach] attached to hvc0 — Ctrl-] to quit\n");
