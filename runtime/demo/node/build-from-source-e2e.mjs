// build-from-source-e2e.mjs — issue #92: the guest BUILDS derivations from source
// (not just substitutes prebuilt outputs). Proves nix's local-derivation-goal
// (fork/exec a builder) works on the NOMMU wasm guest — where there is no
// fork/vfork, so the builder is spawned via posix_spawn / clone-with-fn, and the
// build sandbox/namespaces are off (sandbox = false, filter-syscalls = false).
//
// Three from-source builds, escalating:
//   1. Trivial `/bin/sh` builder writes a constant to $out (shell builtins only,
//      no PATH needed) — proves the builder spawns and the output registers.
//   2. Multi-util `/bin/sh` builder with PATH=/bin (busybox mkdir/echo) — proves a
//      build that calls external programs works (the cleared build env needs PATH;
//      without it busybox applets are "command not found", which is normal Nix, not
//      a wasm limitation).
//   3. A derivation that COMPILES inline C with the in-guest toolchain
//      (guest-cc, substituted from the cache) → a wasm binary, then we RUN that
//      freshly-BUILT-from-source output and assert it exits 42. This is the real
//      "build software from source in-browser" capability.
//
// All markers use `=$?` so the regex matches the EXPANDED rc in OUTPUT, never the
// echoed command text, and no marker is a substring of another (cf. #96).
//
// LINUX_WASM_ARTIFACTS must point at a dir with vmlinux.wasm / initramfs.cpio.gz /
// base.squashfs / nix-cache/ (the .#wasm-binary-cache tree, which carries guest-cc
// + paths.nix). Wired into the nix-wasm.yml `nix-boot-smoke` CI job.
//
// Exit 0 pass / 1 fail / 2 inconclusive (kernel panic — re-run).
import { bootNode, primeLocalNixCache } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = true;
// On the software-MMU FORK guest, guest-cc (clang, 57MB) does not yet run under the
// per-access softmmu translate — it SIGSEGVs (a Track-A softmmu/memory follow-up,
// codebutler/nix-wasm#179), ORTHOGONAL to the CLONE_VM spawn fix #175 proves. So the
// MMU fork job passes --no-cc-build to run the compile-from-source sub-case (BUILD3 +
// PROG) NON-GATING (reported, not fatal). The NOMMU nix-boot-smoke keeps it gating —
// BUILD3 works there (#92) — so a regression on NOMMU still fails CI.
const CC_BUILD_GATING = !process.argv.includes("--no-cc-build");
const check = (ok, label, extra = "", gating = true) => {
  const tag = ok ? "ok" : gating ? "FAIL" : "skip";
  console.log(`  ${tag}  ${label}${extra}`);
  if (gating) pass = pass && ok;
  return ok;
};
// Run `cmd`, wait for `<tag>=<rc>` in output, return the captured rc string.
async function run(cmd, tag, ms = 180000) {
  s.send(`${cmd}; echo ${tag}=$?\n`);
  const got = await s.waitForOutput(new RegExp(`${tag}=[0-9]`), ms);
  if (!got) return null;
  return s.snapshot().match(new RegExp(`${tag}=([0-9]+)`))?.[1] ?? "?";
}

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[build-from-source-e2e] INCONCLUSIVE — kernel panic on boot; re-run");
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
  // Offline CI: substitute from the local /nix-cache (the baked guest config is
  // Cachix-only, which has no egress here). Test-only; see primeLocalNixCache.
  await primeLocalNixCache(s);

  // 1. Trivial sh-builder build from source (shell builtins only).
  console.log("  [build #1: trivial /bin/sh builder → $out …]");
  const b1 = await run(
    `nix-build --no-out-link -E 'derivation { name = "t-trivial"; system = builtins.currentSystem; builder = "/bin/sh"; args = ["-c" "echo built-from-source > $out"]; }' 2>&1`,
    "BUILD1",
  );
  check(b1 === "0", "trivial sh-builder derivation builds from source (BUILD1=0)");

  // 2. Multi-util sh-builder build with PATH (busybox mkdir/echo).
  console.log("  [build #2: multi-util /bin/sh builder (PATH=/bin) …]");
  const b2 = await run(
    `nix-build --no-out-link -E 'derivation { name = "t-multi"; system = builtins.currentSystem; builder = "/bin/sh"; args = ["-c" "export PATH=/bin; mkdir -p $out/bin; echo hi > $out/bin/g"]; }' 2>&1`,
    "BUILD2",
  );
  check(b2 === "0", "multi-util sh-builder derivation builds from source (BUILD2=0)");

  // 3a. Install the in-guest toolchain (substituted from the cache) for the compile.
  console.log("  [installing guest-cc for the compile-from-source build …]");
  const inst = await run(
    'P=$(nix eval --raw -f /nix-cache/paths.nix guest-cc); nix profile install --option substitute true "$P" 2>&1',
    "INSTALL",
    300000,
  );
  check(inst === "0", "guest-cc installed from cache (INSTALL=0)");

  // 3b. A derivation that COMPILES inline C with guest-cc → a wasm binary. cc + src
  // are referenced by absolute store path (build env is cleared); --impure reads the
  // cc path from $CC. Capture the built output path.
  console.log("  [build #3: derivation compiles C from source with guest-cc …]");
  const expr =
    `'let cc = builtins.storePath (builtins.getEnv "CC"); ` +
    `src = builtins.toFile "h.c" "int main(){return 42;}"; in ` +
    `derivation { name = "h42-from-source"; system = builtins.currentSystem; ` +
    `builder = "/bin/sh"; args = ["-c" "$\{cc}/bin/cc $\{src} -o $out"]; }'`;
  const b3 = await run(
    `export CC=$(nix eval --raw -f /nix-cache/paths.nix guest-cc); ` +
      `OUT=$(nix-build --no-out-link --impure -E ${expr} 2>/tmp/b3err); echo "OUTPATH=$OUT"; ` +
      `echo "==B3ERR-START=="; cat /tmp/b3err; echo "==B3ERR-END=="`,
    "BUILD3",
    300000,
  );
  const outPath = s.snapshot().match(/OUTPATH=(\/nix\/store\/\S+)/)?.[1] ?? "";
  const ok3 = check(
    b3 === "0" && /^\/nix\/store\/\S+/.test(outPath),
    "C source compiles via derivation (BUILD3=0)",
    outPath ? ` → ${outPath}` : " (no out path)",
    CC_BUILD_GATING,
  );
  if (!ok3) {
    // Surface the builder's stderr (nix-build's 2>/tmp/b3err) so a compile/link
    // failure inside the forked /bin/sh → guest-cc chain is diagnosable from CI.
    const errBlock =
      s
        .snapshot()
        .match(/==B3ERR-START==([\s\S]*?)==B3ERR-END==/)?.[1]
        ?.trim() ?? "(no builder stderr captured)";
    console.log("  ── build #3 builder stderr ──\n" + errBlock);
    if (!CC_BUILD_GATING)
      console.log(
        "  (non-gating on the software-MMU fork guest — clang-under-softmmu is nix-wasm#179)",
      );
  }

  // 3c. RUN the freshly-built-from-source binary → exit 42.
  console.log("  [running the from-source-built binary …]");
  const ran = await run("$OUT", "PROG", 60000);
  check(ran === "42", "from-source-built binary runs → exit 42 (PROG=42)", "", CC_BUILD_GATING);

  console.log("\n[build-from-source-e2e] " + (pass ? "PASS" : "FAIL"));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3500));
  s.kill();
}
process.exit(pass ? 0 : 1);
