// #173 M1-M3 acceptance: the MMU guest evaluates the second, native nixpkgs
// set and realises cache misses with system=wasm32-linux builders.
//
// The local CI cache contains only the host-crossed stdenv seeds and source-only
// inputs. It deliberately does not contain the three outputs built below, so
// a successful run proves local derivation goals rather than substitution.
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — retry).
import { bootNode, primeLocalNixCache, describeGuestOom } from "./boot-node.mjs";

const s = await bootNode({ nix: true });
let pass = true;
const check = (ok, label) => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}`);
  pass = pass && ok;
  return ok;
};

async function run(cmd, tag, ms) {
  const start = s.snapshot().length;
  s.send(`${cmd}; echo ${tag}=$?\n`);
  const got = await s.waitForOutput(new RegExp(`${tag}=[0-9]`), ms);
  const transcript = s.snapshot();
  const rc = got ? (transcript.match(new RegExp(`${tag}=([0-9]+)`))?.[1] ?? "?") : null;
  if (rc !== "0") {
    console.log(`\n── ${tag} guest output tail ──\n${transcript.slice(start).slice(-12000)}`);
  }
  return rc;
}

// Run a build under a cheap guest-side memory sampler. Each gate reports wall
// time plus the drop from starting MemAvailable to its sampled minimum, making
// M2's spawn/configure cost and the MMU memory ceiling visible in every CI log.
function measured(cmd, label) {
  return (
    `metric_start=$(date +%s); ` +
    `metric_available_start=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo); ` +
    `metric_available_min=$metric_available_start; ` +
    `(${cmd}) & metric_pid=$!; ` +
    `while kill -0 $metric_pid 2>/dev/null; do ` +
    `metric_available=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo); ` +
    `[ "$metric_available" -lt "$metric_available_min" ] && metric_available_min=$metric_available; ` +
    `sleep 2; done; ` +
    `wait $metric_pid; metric_rc=$?; metric_end=$(date +%s); ` +
    `echo NATIVE_METRIC ${label} elapsed_seconds=$((metric_end-metric_start)) ` +
    `available_start_kib=$metric_available_start available_min_kib=$metric_available_min ` +
    `available_drop_kib=$((metric_available_start-metric_available_min)); ` +
    `(exit $metric_rc)`
  );
}

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[native-nixpkgs-e2e] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  if (!check(reached, "shell prompt reached")) {
    s.kill();
    process.exit(1);
  }
  check(
    s.snapshot().includes("yore: registered seed Nix closure"),
    "seed closure registered in the guest Nix database",
  );
  await primeLocalNixCache(s);

  // M1: no source or compiler is needed; this exercises genericBuild/setup.sh
  // under the asyncified GNU Bash seed and BusyBox initialPath.
  console.log("  [M1: trivial native stdenv derivation …]");
  const m1 = await run(
    measured(
      `nix-build --no-out-link -E 'let p = import /root/.nix-defexpr/nixpkgs; in ` +
        `p.native.stdenv.mkDerivation { name = "native-stdenv-probe"; dontUnpack = true; ` +
        `installPhase = "mkdir -p $out; echo NATIVE_STDENV_OK > $out/result"; }' 2>&1`,
      "m1-stdenv",
    ),
    "M1RC",
    1800000,
  );
  check(m1 === "0", `native stdenv.mkDerivation builds in-guest (M1RC=${m1 ?? "timeout"})`);

  // M2: install through the real nix-env channel surface. The output is absent
  // from the local cache; only its source and bootstrap closure are present.
  console.log("  [M2: GNU hello from source …]");
  const m2 = await run(
    measured(
      `nix-env -iA nixpkgs.native.hello > /tmp/native-hello.log 2>&1; ` +
        `rc=$?; cat /tmp/native-hello.log; [ $rc -eq 0 ] && ` +
        `grep -q 'building .*hello-static.*drv' /tmp/native-hello.log && hello`,
      "m2-hello",
    ),
    "M2RC",
    3600000,
  );
  check(m2 === "0", `nixpkgs.native.hello builds, installs, and runs (M2RC=${m2 ?? "timeout"})`);

  // M3: wget itself is native; ABI-identical foundational libraries/build tools
  // are host-crossed seeds. This is the measured choice from the issue's M3
  // fork: reach the real package without rebuilding Perl/OpenSSL first.
  console.log("  [M3: GNU wget from source …]");
  const m3 = await run(
    measured(
      `nix-env -iA nixpkgs.native.wget > /tmp/native-wget.log 2>&1; ` +
        `rc=$?; cat /tmp/native-wget.log; [ $rc -eq 0 ] && ` +
        `grep -q 'building .*wget-static.*drv' /tmp/native-wget.log && wget --version`,
      "m3-wget",
    ),
    "M3RC",
    10800000,
  );
  check(m3 === "0", `nixpkgs.native.wget builds, installs, and runs (M3RC=${m3 ?? "timeout"})`);

  console.log(`\n[native-nixpkgs-e2e] ${pass ? "PASS" : "FAIL"}`);
} finally {
  if (!pass) {
    const oom = describeGuestOom(s.snapshot());
    if (oom) console.log(`\n[native-nixpkgs-e2e] ${oom}`);
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-5000));
  }
  s.kill();
}
process.exit(pass ? 0 : 1);
