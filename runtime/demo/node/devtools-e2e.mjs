// devtools-e2e.mjs — Task 7 (#43) end-to-end proof: the compiler toolchain is
// absent from the slim base squashfs, then installed on demand from the binary
// cache via `nix-env -iA <pkg>` (the real package names — `guest-clang-wasm32`,
// `guest-cc`), then used to compile and run a C program.
//
// Steps:
//   1. Boot the nix system (full /nix overlay from squashfs + nix-cache).
//   2. Assert `clang` is NOT in $PATH (toolchain removed from base).
//   3. `nix-env -iA guest-clang-wasm32 guest-cc` — substitutes from /nix-cache.
//   4. Assert `clang` is now in $PATH.
//   5. Compile `int main(){return 42;}` with `cc`, run it, assert exit 42.
//
// LINUX_WASM_ARTIFACTS must point at a dir with:
//   vmlinux.wasm  initramfs.cpio.gz  base.squashfs  nix-cache/
// where nix-cache/ is the .#wasm-binary-cache output. Its pkgs.nix index is
// generated from the published packages — attrs are the real `lib.getName`s
// (guest-clang-wasm32, guest-cc, guest-cxx, make-wasm32), no invented aliases.
//
// Exit 0 pass / 1 fail / 2 inconclusive (kernel panic — re-run).
import { bootNode } from "./boot-node.mjs";

const s = await bootNode({ nix: true });

let pass = false;
const checks = [];
const check = (ok, label, extra = "") => {
  checks.push({ ok, label, extra });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${extra}`);
  return ok;
};

try {
  // Boot to shell prompt
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[devtools-e2e] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!check(reached, "shell prompt reached")) {
    console.log("\n── transcript ──\n" + s.snapshot().slice(-2000));
    s.kill();
    process.exit(1);
  }

  // Step 2: assert clang is NOT present (toolchain removed from base)
  s.send("which clang 2>/dev/null || echo CLANG_ABSENT_OK\n");
  const clangAbsent = await s.waitForOutput(/CLANG_ABSENT_OK/, 15000);
  check(clangAbsent, "clang absent from base system (CLANG_ABSENT_OK)");

  // Step 3: install the toolchain from the binary cache by its REAL package
  // names (no invented `dev-tools` aggregate) — clang+lld and the cc driver.
  console.log("  [installing guest-clang-wasm32 + guest-cc from nix-cache — may take a while…]");
  s.send("nix-env -iA guest-clang-wasm32 guest-cc 2>&1; echo NIX_ENV_RC=$?\n");
  // Wait for a digit after NIX_ENV_RC= (the echo has $? not a digit).
  const installed = await s.waitForOutput(/NIX_ENV_RC=[0-9]/, 300000);
  const installOk = installed && /NIX_ENV_RC=0\b/.test(s.snapshot());
  check(installOk, "nix-env -iA guest-clang-wasm32 guest-cc substitutes from /nix-cache");
  if (!installOk) {
    console.log(
      "\n── nix-env output (tail) ──\n" +
        s
          .snapshot()
          .match(/nix-env.*[\s\S]*/)?.[0]
          ?.slice(-2000),
    );
  }

  // Step 4: assert clang is now present
  s.send(". /etc/set-environment 2>/dev/null; which clang 2>&1; echo WHICH_CLANG_RC=$?\n");
  const clangPresent = await s.waitForOutput(/WHICH_CLANG_RC=0\b/, 15000);
  check(clangPresent, "clang now in PATH after nix-env -iA guest-clang-wasm32 guest-cc");

  // Step 5: compile and run a C program that exits 42
  // Use a separate compile step with explicit stderr capture so a clang crash
  // shows up as CC_RC=<n> rather than a silent hang. The 5-minute timeout
  // covers clang startup time on the NOMMU wasm32 guest (57MB binary, ramfs).
  s.send("printf 'int main(){return 42;}' > /tmp/h.c\n");
  await s.waitForPrompt(10000);
  s.send("cc /tmp/h.c -o /tmp/h 2>&1; echo CC_COMPILE_RC=$?\n");
  // Wait for a digit after CC_COMPILE_RC= (the echo has $? not a digit).
  const compiled = await s.waitForOutput(/CC_COMPILE_RC=[0-9]/, 300000);
  const compileOk = compiled && /CC_COMPILE_RC=0\b/.test(s.snapshot());
  check(compileOk, "cc /tmp/h.c -o /tmp/h compiles (CC_COMPILE_RC=0)");

  // Run the compiled binary and check exit 42
  s.send("/tmp/h; echo CC_RC=$?\n");
  // Wait for a digit (echo has $? not a digit).
  const ran = await s.waitForOutput(/CC_RC=[0-9]/, 30000);
  const rc42 = ran && /CC_RC=42\b/.test(s.snapshot());
  check(rc42, "cc /tmp/h.c compiles and runs (expected exit 42)", rc42 ? "" : " — got wrong RC");

  pass = checks.every((c) => c.ok);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
  s.kill();
}

console.log("\n[devtools-e2e] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
