// exec-churn-smoke.mjs — #192 targeted repro/regression gate: exec fragmentation
// on the software-MMU guest from repeatedly exec'ing the SAME on-disk binary.
//
// Before the fix (kernel patch 0030, arch/wasm/mm/exec_image.c): every exec of
// a wasm binary under CONFIG_MMU alloc_pages_exact()s + kernel_read()s a FRESH
// physically-contiguous kernel buffer (fs/binfmt_wasm.c), even when it's the
// exact same on-disk file as the previous exec. A build loop re-invoking the
// same ~57 MB clang.wasm dozens of times (the real-world trigger — an autoconf
// `configure` probing the compiler over and over) alloc/free-churns the NOMMU-
// style buddy heap until an allocation fails outright — an Nth-exec cliff,
// empirically the 5th-7th large exec in a row (see CLAUDE.md's #192 entry and
// wrapperless-cc-e2e.mjs, which independently hits this cliff via its own 4
// clang/clang++ invocations plus their internal wasm-ld spawns).
//
// This smoke drives PAST that cliff on purpose: >=12 consecutive
// `clang hello.c -o a.out && ./a.out` cycles in ONE boot (>=24 large execs
// counting each cycle's clang driver + its posix_spawn'd wasm-ld — 4-5x past
// the observed cliff), asserting every cycle's compile AND run exit codes
// individually, plus that the console never shows the kernel's warn_alloc
// signature for the exec-image's allocation order (mm/page_alloc.c:
// "page allocation failure: order:%u" — the 57 MB image is an order-14+
// request; this smoke checks it directly against the console transcript, NOT
// via a kernel.nix postPatch assertion — kernel.nix's #192 assertions check
// the C SOURCE is wired correctly, not this runtime symptom string). With the
// cache in place, cycles 2..N are pure spinlock-only hits (no allocation, no
// read) instead of repeating the alloc/free churn, so the allocator never
// fragments and the order-14 failure never appears.
//
// All markers use `=$?` so the regex matches the EXPANDED rc in OUTPUT, never
// the echoed command text, and no marker is a substring of another (#96):
// each cycle gets its own zero-padded 2-digit index, so e.g. `CH01C` and
// `CH11C` differ at the digit position and neither is a substring of the
// other; `CH01C` (compile) and `CH01R` (run) differ at the trailing letter.
//
// Every `run()` polls for a kernel panic ALONGSIDE the marker, same signal
// `waitForPrompt()` uses at boot — without this, a mid-loop panic (which
// this smoke exists to be ABLE to trigger, pre-fix) would just look like the
// marker never showing up: a plain timeout, reported as a FAIL (exit 1)
// instead of the INCONCLUSIVE (exit 2) a panic actually is, which would also
// mean run_smoke()'s CI panic-retry never engages. The cycle loop BREAKS on
// the first failed check (with a transcript dump) instead of grinding through
// up to 12 more 120s per-call timeouts after the outcome is already decided.
//
// LINUX_WASM_ARTIFACTS must point at the MMU/fork artifact set (.#kernel-mmu-a2
// + .#wasm-initramfs-fork + .#wasm-base-squashfs-fork + .#wasm-binary-cache) —
// same as build-from-source-e2e.mjs / autotools-fork-smoke.mjs and
// nix-boot-smoke-mmu's `core` shard, which this is wired into.
//
// Exit 0 pass / 1 fail / 2 inconclusive (kernel panic — re-run).
import { bootNode, primeLocalNixCache } from "./boot-node.mjs";

const CYCLES = Number(process.env.EXEC_CHURN_CYCLES) || 12;
// The order the #192 alloc block requested (a ~57 MB exec image rounds up to
// order 14 under alloc_pages_exact's __GFP_COMP power-of-two allocation — see
// mm/page_alloc.c's warn_alloc() format string, "page allocation failure:
// order:%u").
const WARN_ALLOC_ORDER = 14;

const s = await bootNode({ nix: true });
let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
  return ok;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send `cmd; echo <tag>=$?`, then poll for EITHER the tag's expansion OR a
// kernel panic — mirrors boot-node.mjs's own waitForPrompt() panic check, so
// a panic mid-cycle is distinguishable from an ordinary timeout. Returns
// { rc } on a normal completion, { panic: true } on a panic, or
// { timedOut: true } if neither showed up within `ms`.
async function run(cmd, tag, ms = 120000) {
  s.send(`${cmd}; echo ${tag}=$?\n`);
  const rcRe = new RegExp(`${tag}=([0-9]+)`);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const snap = s.snapshot();
    if (/panic/i.test(snap)) return { panic: true };
    const m = snap.match(rcRe);
    if (m) return { rc: m[1] };
    await sleep(200);
  }
  return { timedOut: true };
}

// A panic (or an unexpected timeout) during the cycle loop is INCONCLUSIVE
// (exit 2, same as a boot-time panic — run_smoke()'s CI retry wrapper acts on
// this), never a plain FAIL: killing the guest mid-loop is exactly the
// symptom class this smoke exists to be able to trigger pre-fix, and it must
// not be reported as if the compile/run itself returned a bad exit code.
function handlePanicOrTimeout(result, where) {
  if (result.panic) {
    console.log(`[exec-churn-smoke] INCONCLUSIVE — kernel panic ${where}; re-run`);
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
    s.kill();
    process.exit(2);
  }
  if (result.timedOut) {
    console.log(
      `[exec-churn-smoke] INCONCLUSIVE — no response ${where} (hang, not a panic); re-run`,
    );
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
    s.kill();
    process.exit(2);
  }
}

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[exec-churn-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
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

  console.log("  [installing guest-clang-wasm32 from the cache …]");
  const inst = await run("nix-env -iA wasm-tools.guest-clang-wasm32 2>&1", "INSTALL", 300000);
  handlePanicOrTimeout(inst, "during guest-clang-wasm32 install");
  if (!check(inst.rc === "0", "nix-env -iA guest-clang-wasm32 substitutes from the cache")) {
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
    s.kill();
    process.exit(1);
  }
  s.send(". /etc/set-environment 2>/dev/null\n");
  await s.waitForPrompt(10000);

  s.send("printf 'int main(){return 42;}' > /tmp/hello.c\n");
  await s.waitForPrompt(10000);

  console.log(`  [${CYCLES} consecutive clang hello.c -> ./a.out cycles, one boot …]`);
  for (let i = 1; i <= CYCLES; i++) {
    const idx = String(i).padStart(2, "0");
    // Fresh output file per cycle: a stale $out from a previous FAILED compile
    // must not be mistaken for this cycle's fresh build.
    const cc = await run(`rm -f /tmp/a.out; clang /tmp/hello.c -o /tmp/a.out 2>&1`, `CH${idx}C`);
    handlePanicOrTimeout(cc, `during cycle ${idx} compile`);
    if (!check(cc.rc === "0", `cycle ${idx}: clang hello.c -o a.out (CH${idx}C=0)`)) break;

    const rn = await run(`/tmp/a.out`, `CH${idx}R`);
    handlePanicOrTimeout(rn, `during cycle ${idx} run`);
    if (!check(rn.rc === "42", `cycle ${idx}: ./a.out exits 42 (CH${idx}R=42)`)) break;
  }

  // The regression signature itself: with the cache in place, the exec-image
  // allocation happens once (the first cycle's miss) and every later cycle is
  // a cache hit — no alloc_pages_exact() call at all, so no order-14 failure
  // can appear, no matter how fragmented the rest of the heap gets. Without
  // the cache, this reliably fires by cycle 5-7.
  const warnAllocRe = new RegExp(`page allocation failure: order:${WARN_ALLOC_ORDER}\\b`);
  check(
    !warnAllocRe.test(s.snapshot()),
    `console never shows the order:${WARN_ALLOC_ORDER} page-allocation-failure signature`,
  );

  console.log("\n[exec-churn-smoke] " + (pass ? "PASS" : "FAIL"));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-4000));
  s.kill();
}
process.exit(pass ? 0 : 1);
