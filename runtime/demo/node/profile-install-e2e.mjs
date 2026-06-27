// profile-install-e2e.mjs — issue #1 validator: `nix profile install` (the new
// CLI, not just `nix-env -iA`) of the compiler toolchain from the binary cache.
//
// STATUS: FIXED — expected to PASS. The new CLI installs the package's OUTPUT
// PATH (Opaque), source-free and substitute-only — no .drv, no sources. Two real
// pieces, no hacks / no nix source patch:
//   • substitution must stay ON. The new CLI probes for Internet (src/nix/main.cc)
//     and, finding none on the network-less guest, sets `useSubstitutes = false`
//     UNLESS overridden — disabling substitution even for `file:///nix-cache`
//     (which needs no network). We pass `--option substitute true` on the install
//     (a command-line override the offline block honors); `substitute = true` is
//     also in the guest nix.conf.
//   • install the OUTPUT path positionally. paths.nix is a plain name → output-path
//     map; the test reads the path (`nix eval --raw -f /nix-cache/paths.nix
//     guest-cc`, inert at eval) and runs `nix profile install <outPath>`. That is a
//     DerivedPath::Opaque (a store path), so Nix substitutes the prebuilt OUTPUT
//     (+ closure, incl. guest-clang) — exactly `nix profile install /nix/store/
//     <hash>-guest-cc`. It does NOT go through the deriver, sidestepping the .drv
//     wall: the new CLI forms a Built{drvPath} and can NOT obtain a non-local .drv
//     (src/libstore/misc.cc queryMissing marks it "unknown" — the original "failed
//     to obtain derivation of …guest-cc.drv" error). (nix-env -iA is different —
//     its realisation DOES substitute the .drv from the cache; that is why the
//     cache still publishes the .drv closures and why smoke.mjs's
//     `nix-env -iA make-wasm32` works. The new CLI just can't.) An earlier attempt
//     used `builtins.storePath` in paths.nix, but that realises at EVAL time, which
//     the offline-disable turns into "no substituter that can build it".
//
// Like smoke.mjs, a full nix:true boot is heavy; run manually after building the
// artifacts, and it is wired into the nix-wasm.yml `nix-boot-smoke` CI job:
//   LINUX_WASM_ARTIFACTS=file:///path/to/artifacts/ node demo/node/profile-install-e2e.mjs
//
// Steps (ALL GATING — they are the #1 deliverable):
//   1. Boot the nix system (full /nix overlay from squashfs + nix-cache).
//   2. Assert `cc` is NOT in $PATH (toolchain removed from base).
//   3. Read guest-cc's output path from paths.nix; `nix profile install <outPath>`.
//   4. Assert `cc` is now in $PATH (guest-cc ships /bin/cc, which execs guest-clang).
//   5. Compile `int main(){return 42;}` with `cc` (CC_COMPILE_RC=0) — proves the
//      new-CLI-installed toolchain works.
//   6. Run the binary → exit 42 (GATING). Once non-gating on a SUSPECTED exec hang
//      (#96) that turned out to be a harness bug: the old `CC_RC` marker is a
//      substring of step 4's `WHICH_CC_RC`, so the run check matched stale output.
//      Fixed with a collision-free sentinel; the exec itself is healthy (~1-4s).
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

  // Diagnostic: the new CLI's effective substitute config (the offline-disable
  // sets useSubstitutes=false unless overridden — main.cc — so confirm what sticks).
  s.send("nix config show 2>&1 | grep -iE 'substitut' ; echo CFG_DONE\n");
  await s.waitForOutput(/CFG_DONE/, 15000);

  // Step 3: install the guest-cc OUTPUT path (Opaque), substituted from the cache.
  // Read the path out of paths.nix (plain string → no eval-time realisation) and
  // install it positionally. `--option substitute true` is a command-line override
  // that the new CLI's offline-substitute-disable honors (its nix.conf form isn't
  // taking effect for the new CLI here); substituters come from the guest nix.conf.
  console.log("  [nix profile install guest-cc from nix-cache — may take a while…]");
  s.send(
    'P=$(nix eval --raw -f /nix-cache/paths.nix guest-cc); echo "GUESTCC_PATH=$P"; ' +
      'nix profile install --option substitute true "$P" 2>&1; echo NIX_PROFILE_RC=$?\n',
  );
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

  // Step 5 (GATING): the new-CLI-installed toolchain COMPILES a C program. This is
  // the issue-#1 deliverable — `nix profile install` (new CLI) installed a WORKING
  // `cc`. The compile drives cc → guest-clang → wasm-ld and links a wasm binary;
  // RC=0 proves the substituted toolchain is functional.
  s.send("printf 'int main(){return 42;}' > /tmp/h.c\n");
  await s.waitForPrompt(10000);
  s.send("cc /tmp/h.c -o /tmp/h 2>&1; echo CC_COMPILE_RC=$?\n");
  const compiled = await s.waitForOutput(/CC_COMPILE_RC=[0-9]/, 300000);
  const compileOk = compiled && /CC_COMPILE_RC=0\b/.test(s.snapshot());
  check(compileOk, "cc /tmp/h.c -o /tmp/h compiles (CC_COMPILE_RC=0)");

  // Step 6 (GATING): EXECUTE the freshly-built binary → exit 42. This was once
  // non-gating on a SUSPECTED exec hang (issue #96) — but the binary always ran
  // fine (cold first-exec ~1-4s; each exec recompiles the module from shared memory,
  // there is no host module cache; warm execs are instant). The real #96 bug was
  // HERE in the harness: the run marker `CC_RC` is a SUBSTRING of step 4's
  // `WHICH_CC_RC`, so `waitForOutput(/CC_RC=[0-9]/)` matched the STALE
  // `WHICH_CC_RC=0` from step 4 instantly, captured rc=0 (≠42), and reported the
  // (healthy) run as failed/hung — "transcript ends at the compile". Fixed by using
  // a sentinel that can't collide with any earlier output. wrapperless-cc-e2e.mjs
  // gates the same exec capability more broadly (clang/clang++/cc/c++).
  s.send("/tmp/h; echo PROG_EXIT=$?\n");
  const ran = await s.waitForOutput(/PROG_EXIT=[0-9]/, 30000);
  const rc42 = ran && /PROG_EXIT=42\b/.test(s.snapshot());
  if (!rc42) {
    // Capture state to distinguish a hang (no PROG_EXIT) from a wrong/missing binary.
    s.send("ls -la /tmp/h 2>&1; echo LS_DONE\n");
    await s.waitForOutput(/LS_DONE/, 8000);
  }
  check(rc42, "cc-compiled program runs → exit 42 (PROG_EXIT=42)");

  pass = checks.every((c) => c.ok);
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}

console.log("\n[profile-install-e2e] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
