// autotools-fork-smoke.mjs — the 2026-08-05 MMU ship-plan Phase-1 precondition's
// TOOLCHAIN half (the shell half is already boot-verified — nix-wasm#188/#189,
// CLAUDE.md's "In-guest autotools also works" caveat). This is the FIRST
// automated regression gate for that 2026-06-17 milestone on ANY guest: a real
// `./configure && make && ./prog` runs end-to-end inside the booted guest.
//
// FORMER BLOCKER, NOW FIXED: busybox hush's parser used to reject the
// VARIABLE-fd redirect autoconf's generated `as_fn_error` helper uses
// (`>&$4` — the fd number is a shell variable, not a literal `>&5`) — the
// actual source of the classic "hush: ambiguous redirect" / "hush: syntax
// error at 'fi'" failures CLAUDE.md's autotools caveat used to document (the
// #189 hush measurement matrix only exercised LITERAL fds and did not catch
// it). Fixed by patches/busybox/0009-hush-variable-fd-redirect.patch +
// 0010-hush-internally-opened-fd0.patch (wired into busybox-fork.nix, the
// fork guest's actual `/bin/sh`), landed in the same change as this comment
// update. This smoke invokes plain `sh ./configure` (i.e. hush) and CFGRC is
// expected to be 0 — a genuine boot confirmation, not a known-gap
// reproduction. See userspace/autotools-fixture-hush-check.nix for the
// host-side, hermetic, hard-gated proof of the same fix on a native build.
//
// Flow (boots the software-MMU / real-fork artifact set — same mechanism
// build-from-source-e2e.mjs uses, see its header comment):
//   1. Boot nix:true with a 9P-exposed VFS carrying the .#autotools-fixture
//      tree (configure.ac/configure/Makefile.in/prog.c) under /mnt/pc.
//   2. Substitute the in-guest toolchain from the cache: `nix-env -iA
//      wasm-tools.guest-cc wasm-tools.make-wasm32` (both already published in
//      the wasm-tools catalog — see userspace/binary-cache.nix's devPaths /
//      flake.nix's wasmDevPaths; make-wasm32 is the `pname` of
//      toolchain/make.nix's pdpmake port, ALREADY catalogued — nothing to add).
//   3. `cp -r` the fixture from the /mnt/pc mount (`cache=none` — the
//      unbuffered 9P read path bootstrap.nix documents as fragile for large
//      reads on this guest, and no sibling smoke has ever cp -r'd a nested
//      tree out of it before) to a writable ramfs location (/tmp) —
//      configure/make must write to cwd (config.status, Makefile, prog,
//      *.o), which a 9P-mounted source tree cannot support the same way a
//      real local filesystem does. This is the staging design the
//      2026-08-05 parity-plan doc's Phase-1 Remaining item specifies. The
//      SAME command that copies also prints the staged byte/file count, and
//      that gets compared against the known host-side values BEFORE
//      touching configure/make — a truncated/failed copy fails right here
//      with a clear message, not as a mystery CFGRC failure later.
//   4. `sh ./configure` (never rely on the generated script's shebang or exec
//      bit — see autotools-fixture.nix's dontPatchShebangs comment) — a REAL
//      compiler-probe run ("checking whether the C compiler works" etc.)
//      against the IN-GUEST cc, not a stub. See the KNOWN BLOCKER note above.
//   5. `make` — pdpmake spawns the compile recipe via system() → posix_spawn /
//      clone-with-fn (see toolchain/make.nix), producing ./prog.
//   6. `./prog` — asserts BOTH the distinctive stdout marker
//      (AUTOTOOLS_FIXTURE_OK) AND the process exit status (0).
//
// Every precondition step (boot reached, toolchain installed, fixture
// staged byte-exact) BAILS immediately on failure — there is no point
// spending the rest of the step's timeout budget on configure/make/prog
// once one of those is known broken. configure/make/prog themselves do NOT
// bail on each other's failure (matching build-from-source-e2e.mjs's
// BUILD1/BUILD2/BUILD3/PROG chain) — each still runs so a single boot
// surfaces maximal diagnostic signal.
//
// MARKER RULES (#96, restated in CLAUDE.md): every rc marker below is
// `${TAG}=$?` — sent as LITERAL `$?` text, so the terminal's echo of the
// command line never matches the regex (only the shell's real expansion,
// printed after the command runs, does) — and no two tags (INSTCC, CPRC,
// STAGE_BYTES, STAGE_FILES, CFGRC, MAKERC, RUNRC) are a substring of one
// another.
//
// Env: AUTOTOOLS_FIXTURE must point at the .#autotools-fixture output
// (nix build .#autotools-fixture --print-out-paths); LINUX_WASM_ARTIFACTS at
// the MMU/fork artifact set (.#kernel-mmu-a2 + .#wasm-initramfs-fork +
// .#wasm-base-squashfs-fork + .#wasm-binary-cache), same as
// build-from-source-e2e.mjs / nix-boot-smoke-mmu's `core` shard.
//
// Exit 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bootNode, primeLocalNixCache } from "./boot-node.mjs";
import { MemVfs } from "../../ninep/mem-vfs.js";

const FIXTURE_DIR = process.env.AUTOTOOLS_FIXTURE;
if (!FIXTURE_DIR) {
  console.error(
    "[autotools-fork-smoke] AUTOTOOLS_FIXTURE is not set — point it at " +
      "`nix build .#autotools-fixture --print-out-paths`",
  );
  process.exit(1);
}
const FIXTURE_FILES = ["configure.ac", "configure", "Makefile.in", "prog.c"];
const fixtureTree = {};
for (const f of FIXTURE_FILES) {
  const p = path.join(FIXTURE_DIR, f);
  if (!existsSync(p)) {
    console.error(`[autotools-fork-smoke] AUTOTOOLS_FIXTURE is missing ${f} (looked at ${p})`);
    process.exit(1);
  }
  // readFileSync -> a Buffer (a Uint8Array subclass), so MemVfs.from treats it
  // as a byte file rather than recursing into it as a folder.
  fixtureTree[f] = readFileSync(p);
}
const vfs = MemVfs.from({ Home: { "autotools-fixture": fixtureTree } });
// Known-good host-side values for the post-copy staged-tree assertion below
// (P2-3): /mnt/pc is mounted `cache=none` (bootstrap.nix), the unbuffered 9P
// read path documented elsewhere as fragile for large reads on this guest —
// and no sibling smoke has ever `cp -r`'d a NESTED TREE out of it before. A
// truncated/failed copy must fail HERE, with its own clear marker, instead of
// surfacing 300 lines later as a mystery CFGRC failure.
const EXPECT_CONFIGURE_BYTES = fixtureTree["configure"].length;
const EXPECT_FILE_COUNT = FIXTURE_FILES.length;

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
  return ok;
};
// Run `cmd`, wait for `<tag>=<rc>` (the EXPANDED `$?`, never the echoed
// command — see the header comment), return the captured rc string.
async function run(cmd, tag, ms = 60000) {
  s.send(`${cmd}; echo ${tag}=$?\n`);
  const got = await s.waitForOutput(new RegExp(`${tag}=[0-9]`), ms);
  if (!got) return null;
  return s.snapshot().match(new RegExp(`${tag}=([0-9]+)`))?.[1] ?? "?";
}

const s = await bootNode({ nix: true, vfs });

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[autotools-fork-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
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

  // Substitute cc + make from the cache. The software-MMU guest runs the
  // substitute+unpack ~2-3x slower than NOMMU (see CLAUDE.md's
  // NIX_MAKE_TIMEOUT_MS note); reuse that same knob so the MMU CI job's
  // already-widened budget (600000ms) applies here too.
  const installTimeoutMs = Number(process.env.NIX_MAKE_TIMEOUT_MS) || 180000;
  console.log("  [installing wasm-tools.guest-cc + wasm-tools.make-wasm32 …]");
  const inst = await run(
    "nix-env -iA wasm-tools.guest-cc wasm-tools.make-wasm32 2>&1",
    "INSTCC",
    installTimeoutMs,
  );
  if (!check(inst === "0", "nix-env -iA guest-cc + make-wasm32 substitutes from the cache")) {
    console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3000));
    s.kill();
    process.exit(1);
  }
  // Refresh PATH so `cc`/`make` resolve in this shell (matches
  // wrapperless-cc-e2e.mjs's own post-install re-source).
  s.send(". /etc/set-environment 2>/dev/null\n");
  await s.waitForPrompt(10000);

  // Stage the fixture from the (possibly-9P-unbuffered, cache=none) /mnt/pc
  // mount onto writable ramfs — configure/make need to write config.status/
  // Makefile/prog/*.o into the source tree's own directory, and print the
  // staged byte/file count in the SAME command so a truncated copy is
  // attributable right here (P2-3).
  console.log("  [staging the fixture onto ramfs …]");
  const cp = await run(
    "rm -rf /tmp/fixture && cp -r /mnt/pc/Home/autotools-fixture /tmp/fixture && " +
      "cd /tmp/fixture && " +
      "B=$(wc -c < configure) && echo STAGE_BYTES=$B && " +
      "N=$(ls -1 | wc -l) && echo STAGE_FILES=$N",
    "CPRC",
    60000,
  );
  const stagedBytes = s.snapshot().match(/STAGE_BYTES=(\d+)/)?.[1] ?? null;
  const stagedFiles = s.snapshot().match(/STAGE_FILES=(\d+)/)?.[1] ?? null;
  // Report all three independently (no short-circuiting `&&`) so a cp
  // failure doesn't hide whatever the byte/file-count markers DID capture —
  // maximal diagnostic signal from one boot, same rationale as the
  // configure/make/prog chain below.
  const cpOk = check(cp === "0", "fixture staged to /tmp/fixture (CPRC=0)");
  const bytesOk = check(
    stagedBytes === String(EXPECT_CONFIGURE_BYTES),
    `staged configure is byte-exact (STAGE_BYTES=${stagedBytes}, expected ${EXPECT_CONFIGURE_BYTES})`,
  );
  const filesOk = check(
    stagedFiles === String(EXPECT_FILE_COUNT),
    `staged file count matches (STAGE_FILES=${stagedFiles}, expected ${EXPECT_FILE_COUNT})`,
  );
  const stageOk = cpOk && bytesOk && filesOk;
  if (!stageOk) {
    // Attribute the failure to staging (9P cache=none / a nested cp -r has no
    // sibling precedent) rather than letting it surface as a mystery CFGRC.
    console.log("\n── staging transcript tail ──\n" + s.snapshot().slice(-3000));
    s.kill();
    process.exit(1);
  }

  // ./configure — a REAL compiler probe against the in-guest cc: measured at
  // ~24 real compiler invocations (AC_PROG_CC's own probes + one per
  // AC_CHECK_HEADERS/AC_CHECK_FUNCS check), each paying the in-guest exec
  // cost of the 57 MB guest-clang (softmmu-instrumented at load) plus its
  // own compile — a MEASURED worst case near 19 minutes, far past the
  // previous 240s budget (P2-2). Budget = 19 min measured + ~6 min margin =
  // 1,500,000ms (25 min) — the previous 900,000ms (15 min) budget was BELOW
  // its own documented 19-min worst case (Codex P2, 2026-08-12): a
  // slow-but-genuinely-fine run would time out and report a false CFGRC
  // failure. This still fits the step's overall time budget — see the
  // `timeout-minutes: 200` comment on nix-wasm.yml's "Boot full nix system
  // on MMU + ${{ matrix.shard }} smokes — hard gates" step for the full
  // arithmetic (install + CFGRC + MAKERC + boot/staging). Never rely on the generated
  // script's shebang/exec bit (see autotools-fixture.nix); invoke via `sh`.
  console.log("  [./configure …]");
  const cfg = await run("sh ./configure 2>&1", "CFGRC", 1500000);
  const cfgOk = check(cfg === "0", "./configure succeeds against the in-guest cc (CFGRC=0)");
  if (!cfgOk) console.log("\n── configure transcript tail ──\n" + s.snapshot().slice(-3000));

  // make — pdpmake compiles prog.c with the in-guest cc via
  // system()->posix_spawn/clone-with-fn (toolchain/make.nix). Only ONE
  // compiler invocation (vs configure's ~24), but still pays the same
  // per-exec 57 MB guest-clang cost under the software-MMU guest; 600s is a
  // generous ceiling above that single-compile cost (P2-2) — unchanged by
  // the Codex P2 fix above (only CFGRC's budget was inconsistent with its
  // own documented worst case; MAKERC's single-compile ceiling was fine).
  console.log("  [make …]");
  const mk = await run("make 2>&1", "MAKERC", 600000);
  const mkOk = check(mk === "0", "make builds ./prog with the in-guest cc (MAKERC=0)");
  if (!mkOk) console.log("\n── make transcript tail ──\n" + s.snapshot().slice(-3000));

  // ./prog — assert BOTH the distinctive stdout marker and the exit status.
  console.log("  [./prog …]");
  const run3 = await run("./prog", "RUNRC", 30000);
  check(/AUTOTOOLS_FIXTURE_OK/.test(s.snapshot()), "./prog prints the AUTOTOOLS_FIXTURE_OK marker");
  check(run3 === "0", "./prog exits 0 (RUNRC=0)");

  console.log("\n[autotools-fork-smoke] " + (pass ? "PASS" : "FAIL"));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3500));
  s.kill();
}
process.exit(pass ? 0 : 1);
