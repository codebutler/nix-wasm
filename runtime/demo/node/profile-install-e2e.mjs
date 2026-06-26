// profile-install-e2e.mjs — issue #1 validator: `nix profile install` (the new
// CLI, not just `nix-env -iA`) of the compiler toolchain from the binary cache.
//
// STATUS: FIXED — expected to PASS. The ticket was misdiagnosed for a long time
// (the "nix profile realises the deriver / builds xgcc" theory). The actual root
// cause is in src/nix/main.cc: the NEW nix CLI probes for Internet and, finding
// none on the network-less guest, sets `useSubstitutes = false` unless the setting
// was explicitly overridden — silently disabling ALL substitution. Our only
// substituter is `file:///nix-cache`, which needs no network, so that default is
// wrong here. With substitution off, `nix profile install` could not substitute
// the already-cached output and FELL BACK to building the deriver (hence the
// xgcc-build symptom). `nix-env -iA` is a separate entry point that skips the
// probe, which is why only the new CLI was ever affected.
//
// The real-NixOS fix, no hacks / no nix source patch:
//   • `substitute = true` in the guest nix.conf (userspace/system.nix) marks the
//     setting overridden, so the offline path leaves substitution ON.
//   • the catalog (pkgs.nix) entries are REAL derivations (carry the real drvPath),
//     and the cache serves the .drv closures as well as the outputs — so
//     `nix profile install` reads the deriver and the stock DerivationGoal
//     substitutes the cache-valid output WITHOUT building. Exactly like installing
//     from cache.nixos.org. (userspace/binary-cache.nix)
//
// Like smoke.mjs, a full nix:true boot is heavy; run manually after building the
// artifacts, and it is wired into the nix-wasm.yml `nix-boot-smoke` CI job:
//   LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/profile-install-e2e.mjs
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
// where nix-cache/ is the .#wasm-binary-cache tree (real derivations + .drv
// closures) and base.squashfs carries the guest nix.conf with `substitute = true`.
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
