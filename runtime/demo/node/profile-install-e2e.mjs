// profile-install-e2e.mjs — issue #1 validator: `nix profile install` (the new
// CLI, not just `nix-env -iA`) of the compiler toolchain from the binary cache.
//
// STATUS: FIXED — expected to PASS. The new CLI installs the package's OUTPUT
// PATH (Opaque), source-free and substitute-only — no .drv, no sources. Two real
// pieces, no hacks / no nix source patch:
//   • `substitute = true` in the guest nix.conf (userspace/system.nix). The new
//     CLI probes for Internet (src/nix/main.cc) and, finding none on the
//     network-less guest, sets `useSubstitutes = false` unless overridden —
//     silently disabling substitution even for `file:///nix-cache` (which needs
//     no network). Marking it overridden leaves substitution ON.
//   • the install uses the paths.nix catalog: `nix profile install -f
//     /nix-cache/paths.nix guest-cc`, where guest-cc = `builtins.storePath
//     "<outPath>"`. That resolves to a DerivedPath::Opaque (a store path), so Nix
//     substitutes the prebuilt OUTPUT (+ its closure, incl. guest-clang) — exactly
//     like `nix profile install /nix/store/<hash>-guest-cc`. It does NOT go through
//     the deriver, sidestepping the .drv wall: the NEW CLI forms a Built{drvPath}
//     and can NOT obtain a non-local .drv (src/libstore/misc.cc queryMissing marks
//     it "unknown" — the original "failed to obtain derivation of …guest-cc.drv"
//     error). (nix-env -iA is different — its realisation DOES substitute the .drv
//     from the cache; that is why the cache still publishes the .drv closures and
//     why `smoke.mjs`'s `nix-env -iA make-wasm32` works. The new CLI just can't.)
//
// Like smoke.mjs, a full nix:true boot is heavy; run manually after building the
// artifacts, and it is wired into the nix-wasm.yml `nix-boot-smoke` CI job:
//   LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/profile-install-e2e.mjs
//
// Steps:
//   1. Boot the nix system (full /nix overlay from squashfs + nix-cache).
//   2. Assert `cc` is NOT in $PATH (toolchain removed from base).
//   3. `nix profile install -f /nix-cache/paths.nix guest-cc`.
//   4. Assert `cc` is now in $PATH (guest-cc ships /bin/cc, which execs guest-clang).
//   5. Compile `int main(){return 42;}` with `cc`, run it, assert exit 42.
//
// LINUX_WASM_ARTIFACTS must point at a dir with:
//   vmlinux.wasm  initramfs.cpio.gz  base.squashfs  nix-cache/
// where nix-cache/ is the .#wasm-binary-cache tree (OUTPUTS + .drv closures +
// pkgs.nix + paths.nix) and base.squashfs carries nix.conf with `substitute=true`.
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

  // Step 2: assert cc is NOT present (toolchain removed from base)
  s.send("which cc 2>/dev/null || echo CC_ABSENT_OK\n");
  const ccAbsent = await s.waitForOutput(/CC_ABSENT_OK/, 15000);
  check(ccAbsent, "cc absent from base system (CC_ABSENT_OK)");

  // Step 3: `nix profile install` the guest-cc OUTPUT path (Opaque) from paths.nix.
  console.log("  [nix profile install guest-cc from nix-cache — may take a while…]");
  s.send("nix profile install -f /nix-cache/paths.nix guest-cc 2>&1; echo NIX_PROFILE_RC=$?\n");
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

  // Step 4: assert cc is now present (nix profile install puts guest-cc/bin on
  // ~/.nix-profile/bin, which /etc/profile already has on PATH).
  s.send("which cc 2>&1; echo WHICH_CC_RC=$?\n");
  const ccPresent = await s.waitForOutput(/WHICH_CC_RC=0\b/, 15000);
  check(ccPresent, "cc now in PATH after nix profile install");

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
