// profile-install-e2e.mjs — issue #1 reproducer: attempt `nix profile install`
// (not just `nix-env -iA`) of the compiler toolchain from the binary cache.
//
// STATUS: BLOCKED (documented, not in any CI gate). `nix profile install`
// resolves an installable to a `Built{drv, outputs}` derived path and records
// the DERIVER in the profile manifest, so it must obtain + REALISE the `.drv`.
// Realising an input-addressed derivation whose output is not already valid
// forces nix to BUILD it from its input-derivation OUTPUTS (xgcc, perl, bash,
// stdenv, python, zstd, zlib-ng — the NATIVE x86_64 build toolchain). On the
// network-less NOMMU wasm guest those native outputs are neither substitutable
// (the cache ships only the wasm output closures + the .drv NARs, not the native
// build-input outputs) nor runnable (x86_64 binaries can't execute on wasm), so
// the build fails with "Cannot build '…xgcc-15.2.0.drv'. … 1 dependency failed".
// Even pre-substituting BOTH the .drv AND the output into the local store does
// not help: `nix profile install -f` still re-obtains the deriver and walks the
// build graph. There is no flag to make `nix profile` substitute-the-output and
// skip the deriver build for an input-addressed drv. Conversely, MAKING the
// deriver resolvable (shipping the .drv NARs + a drvPath in pkgs.nix) REGRESSES
// the working `nix-env -iA` path — it then also follows the deriver and tries to
// build xgcc. So the output-only cache (no .drv, no Deriver) is kept; #1 stays
// open. See .superpowers/sdd/task-10-report.md for the full transcript.
//
// This script is the reproducer for that diagnosis; it is EXPECTED TO FAIL on
// the current guest. It is intentionally NOT named *.test.mjs and is not run by
// `node --test demo/node/` — run it manually to reproduce the #1 blocker.
//
// Steps:
//   1. Boot the nix system (full /nix overlay from squashfs + nix-cache).
//   2. Assert `clang` is NOT in $PATH (toolchain removed from base).
//   3. `nix profile install -f /nix-cache/pkgs.nix guest-cc`.
//   4. Assert `clang` is now in $PATH.
//   5. Compile `int main(){return 42;}` with `cc`, run it, assert exit 42.
//
// LINUX_WASM_ARTIFACTS must point at a dir with:
//   vmlinux.wasm  initramfs.cpio.gz  base.squashfs  nix-cache/
// where nix-cache/ is the DERIVATION-AWARE cache from build-artifacts.sh.
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
      console.log("[profile-install-e2e] INCONCLUSIVE — kernel panic on boot; re-run");
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

  // Step 3: `nix profile install` guest-cc from the derivation-aware cache.
  console.log("  [nix profile install guest-cc from nix-cache — may take a while…]");
  s.send("nix profile install -f /nix-cache/pkgs.nix guest-cc 2>&1; echo NIX_PROFILE_RC=$?\n");
  const installed = await s.waitForOutput(/NIX_PROFILE_RC=[0-9]/, 300000);
  const installOk = installed && /NIX_PROFILE_RC=0\b/.test(s.snapshot());
  check(installOk, "nix profile install guest-cc from /nix-cache");
  if (!installOk) {
    console.log(
      "\n── nix profile install output (tail) ──\n" +
        s
          .snapshot()
          .match(/nix profile install[\s\S]*/)?.[0]
          ?.slice(-3000),
    );
  }

  // Step 4: assert clang is now present (nix profile install puts it on
  // ~/.nix-profile/bin, which /etc/profile already has on PATH).
  s.send("which clang 2>&1; echo WHICH_CLANG_RC=$?\n");
  const clangPresent = await s.waitForOutput(/WHICH_CLANG_RC=0\b/, 15000);
  check(clangPresent, "clang now in PATH after nix profile install");

  // Step 5: compile and run a C program that exits 42
  s.send("printf 'int main(){return 42;}' > /tmp/h.c\n");
  await s.waitForPrompt(10000);
  s.send("cc /tmp/h.c -o /tmp/h 2>&1; echo CC_COMPILE_RC=$?\n");
  const compiled = await s.waitForOutput(/CC_COMPILE_RC=[0-9]/, 300000);
  const compileOk = compiled && /CC_COMPILE_RC=0\b/.test(s.snapshot());
  check(compileOk, "cc /tmp/h.c -o /tmp/h compiles (CC_COMPILE_RC=0)");

  s.send("/tmp/h; echo CC_RC=$?\n");
  const ran = await s.waitForOutput(/CC_RC=[0-9]/, 30000);
  const rc42 = ran && /CC_RC=42\b/.test(s.snapshot());
  check(rc42, "cc-compiled program runs (expected exit 42)", rc42 ? "" : " — got wrong RC");

  pass = checks.every((c) => c.ok);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}

console.log("\n[profile-install-e2e] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
