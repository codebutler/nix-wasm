// wrapperless-cc-e2e.mjs — #3 proof: clang is its own driver for the wasm32
// NOMMU guest. After substituting the toolchain from the binary cache, validate
// that BARE `clang`/`clang++` (no cc/c++ wrapper, configs auto-loaded next to the
// real clang binary) compile + in-process-link (clang spawns wasm-ld via
// posix_spawn) AND that the thin `cc`/`c++` aliases still work.
//
//   1. Boot the nix system, install guest-clang-wasm32 + guest-cc + guest-cxx.
//   2. `clang  hello.c   -o h && ./h`        → exit 42   (bare clang, no wrapper)
//   3. `clang++ hello.cpp -o hx && ./hx`     → exit 7    (bare clang++, libc++/EH)
//   4. `cc  hello.c   -o hc && ./hc`         → exit 42   (thin alias still works)
//   5. `c++ hello.cpp -o hcx && ./hcx`       → exit 7
//
// LINUX_WASM_ARTIFACTS points at vmlinux.wasm/initramfs.cpio.gz/base.squashfs/
// nix-cache (the .#wasm-binary-cache built from the #3 branch). Exit 0/1/2.
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
const checks = [];
const check = (ok, label) => {
  checks.push(ok);
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  return ok;
};
// Send a command, wait for `MARK=<rc>` (a real digit), return whether rc matches.
async function run(cmd, mark, wantRc, ms = 300000) {
  s.send(`${cmd}; echo ${mark}=$?\n`);
  const got = await s.waitForOutput(new RegExp(`${mark}=[0-9]`), ms);
  return got && new RegExp(`${mark}=${wantRc}\\b`).test(s.snapshot());
}

let pass = false;
try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[wrapperless-cc-e2e] INCONCLUSIVE — kernel panic; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!check(reached, "shell prompt reached")) {
    s.kill();
    process.exit(1);
  }

  console.log("  [installing guest-clang-wasm32 + guest-cc + guest-cxx from nix-cache…]");
  check(
    await run("nix-env -iA guest-clang-wasm32 guest-cc guest-cxx 2>&1", "INSTALL_RC", 0),
    "nix-env -iA guest-clang-wasm32 guest-cc guest-cxx",
  );
  s.send(". /etc/set-environment 2>/dev/null\n");
  await s.waitForPrompt(10000);

  // Source programs.
  s.send("printf 'int main(){return 42;}' > /tmp/h.c\n");
  await s.waitForPrompt(10000);
  s.send(
    'printf \'#include <string>\\n#include <vector>\\nint main(){std::vector<std::string> v{"a","b"}; std::string s; for(auto&x:v)s+=x; try{ if(s.size()) throw int(7);}catch(int e){return e;} return 0;}\' > /tmp/hx.cpp\n',
  );
  await s.waitForPrompt(10000);

  // Bare clang / clang++ — the #3 headline (no cc/c++ on the command line).
  check(await run("clang /tmp/h.c -o /tmp/h 2>&1", "CLANG_RC", 0), "bare clang compiles h.c");
  check(await run("/tmp/h", "CLANG_RUN", 42), "bare clang binary runs → exit 42");
  check(
    await run("clang++ /tmp/hx.cpp -o /tmp/hx 2>&1", "CLANGXX_RC", 0),
    "bare clang++ compiles hx.cpp (libc++/EH)",
  );
  check(await run("/tmp/hx", "CLANGXX_RUN", 7), "bare clang++ binary runs → exit 7");

  // Thin aliases still work.
  check(await run("cc /tmp/h.c -o /tmp/hc 2>&1", "CC_RC", 0), "cc alias compiles h.c");
  check(await run("/tmp/hc", "CC_RUN", 42), "cc binary runs → exit 42");
  check(await run("c++ /tmp/hx.cpp -o /tmp/hcx 2>&1", "CXX_RC", 0), "c++ alias compiles hx.cpp");
  check(await run("/tmp/hcx", "CXX_RUN", 7), "c++ binary runs → exit 7");

  pass = checks.every(Boolean);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}
console.log("\n[wrapperless-cc-e2e] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
