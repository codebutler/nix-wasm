// smoke.mjs — boots ONCE with the full nix-system wiring and runs the cheap
// per-boot assertions:
//   prompt → 9P read → write/overwrite/append → ls → nix-env -iA make-wasm32
//   → verify the real Nix store DB uses its profile's supported SQLite mode.
// The LINUX_WASM_ARTIFACTS nix-cache/ must be the .#wasm-binary-cache output
// (has the `make-wasm32` attr in pkgs.nix). See devtools-e2e.mjs for the full toolchain-install
// install-then-compile proof.
// Exit: 0 pass / 1 fail / 2 inconclusive (boot panic — re-run).
import { bootNode, primeLocalNixCache, describeGuestOom } from "./boot-node.mjs";
import { MemVfs } from "../../ninep/mem-vfs.js";

const vfs = MemVfs.from({
  Home: { "pc-9p-proof.txt": "written by pc's vfs.write\n" },
});

const expectedProfile = process.env.YORE_EXPECT_PROFILE;
const profileMarkers = {
  mmu: "yore: profile-fs=mmu shm=tmpfs nixcache=direct",
  nommu: "yore: profile-fs=nommu shm=ramfs nixcache=loose",
};
if (!Object.hasOwn(profileMarkers, expectedProfile)) {
  throw new Error("YORE_EXPECT_PROFILE must be either 'mmu' or 'nommu'");
}

let pass = true;
const check = (ok, label, extra = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${label}${extra}`);
  pass = pass && ok;
};

const s = await bootNode({ vfs });

try {
  let reached;
  try {
    reached = await s.waitForPrompt(90000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[smoke] INCONCLUSIVE — kernel panic on boot; re-run");
      s.kill();
      process.exit(2);
    }
    throw e;
  }
  check(reached, "shell prompt reached");
  if (!reached) {
    console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-2000));
    s.kill();
    process.exit(1);
  }
  // Offline CI: substitute from the local /nix-cache (the baked guest config is
  // Cachix-only, which has no egress here). Test-only; see primeLocalNixCache.
  await primeLocalNixCache(s);
  // The 9P-over-virtio transport negotiated a mount (printed per mount when the
  // guest clamps msize to the device max). This gates the #87 regression — if the
  // 9P virtio devices fail to register there is no mount and this line never prints
  // — and it is robust to the #83 console change: stock virtio-console attaches
  // hvc0 LATER than the retired hvc_wasm (no earlycon / hvc_instantiate, so the
  // pre-attach boot-log buffer is not replayed), which drops the earlier
  // "9pnet: Installing 9P2000 support" core-init line from the console. The
  // msize-clamp line is printed at boot mount time, after hvc0 is up, so it is
  // console-visible — and proves the *virtio* transport specifically, not just the
  // 9P protocol core. (9P function is independently proven by the read/write checks
  // below.)
  check(
    /9pnet:.*Limiting 'msize'.*supported by transport virtio/.test(s.snapshot()),
    "9P-over-virtio transport mounted",
  );
  check(
    s.snapshot().includes(profileMarkers[expectedProfile]),
    `${expectedProfile} /dev/shm and 9P cache policy`,
  );

  // read path
  s.send("cat /mnt/yore/Home/pc-9p-proof.txt\n");
  check(await s.waitForOutput(/written by pc's vfs\.write/), "cat reads a real-VFS file over 9P");

  // write / overwrite / append round-trip back to the host VFS
  const FILE = "/Home/smoke-wtest.txt";
  const readVfs = async () => (await vfs.readBlob(FILE)).text();
  const writeCheck = async (cmd, expect, label) => {
    s.send(cmd);
    await new Promise((r) => setTimeout(r, 2500));
    const got = await readVfs().catch((e) => "ERR:" + e.message);
    check(
      got === expect,
      label,
      got === expect
        ? ""
        : `: vfs sees ${JSON.stringify(got)} (expected ${JSON.stringify(expect)})`,
    );
  };
  await writeCheck(`echo hello-from-linux > /mnt/yore${FILE}\n`, "hello-from-linux\n", "write");
  await writeCheck(`echo hi > /mnt/yore${FILE}\n`, "hi\n", "overwrite (O_TRUNC)");
  await writeCheck(`echo more >> /mnt/yore${FILE}\n`, "hi\nmore\n", "append");

  // directory read-back
  s.send("ls /mnt/yore/Home\n");
  check(await s.waitForOutput(/smoke-wtest\.txt/), "ls lists the written file");

  // nix-system: substitute a package from the committed binary cache.
  // Use `make-wasm32` (lightweight pdpmake; in .#wasm-binary-cache pkgs.nix) as the
  // smoke substitution package — the full install+compile proof is in devtools-e2e.mjs.
  // The catalog attrs are `lib.getName`-derived (#79), so this is `make-wasm32`, not
  // `make` (the stale `make` attr is what nix-boot-smoke caught when it was first run
  // in CI — see #88).
  // The software-MMU guest translates every memory access (2-level walk) + splits
  // page-crossing scalar accesses byte-wise, so the same substitute+unpack runs
  // ~2-3x slower than the NOMMU path. Allow the MMU boot job to raise the ceiling
  // via NIX_MAKE_TIMEOUT_MS (default 180s keeps the NOMMU nix-boot-smoke unchanged).
  // Offline substitution runs off the local file:///nix-cache the harness primed
  // into the guest user nix.conf (primeLocalNixCache, above) — the baked guest
  // config is Cachix-only (#167) with no egress in CI. The software-MMU guest
  // translates every access (2-level walk) + splits page-crossing scalar accesses
  // byte-wise, so the same substitute+unpack runs ~2-3x slower than NOMMU; the MMU
  // boot job raises the ceiling via NIX_MAKE_TIMEOUT_MS (default 180s keeps the
  // NOMMU nix-boot-smoke unchanged).
  const makeTimeoutMs = Number(process.env.NIX_MAKE_TIMEOUT_MS) || 180000;
  s.send("nix-env -iA wasm-tools.make-wasm32 2>&1; echo NIX_MAKE_RC=$?\n");
  check(
    await s.waitForOutput(/NIX_MAKE_RC=0/, makeTimeoutMs),
    "nix-env -iA make-wasm32 substitutes from the cache",
  );

  // #131: query the actual database after the real store write. MMU must persist
  // WAL; NOMMU uses Nix's supported truncate-journal setting because SQLite's
  // WAL-index protocol still returns SQLITE_IOERR there. Both binaries link the
  // same serialized-threading cross.sqlite build.
  s.send("/bin/sqlite-wal-test --probe-db /nix/var/nix/db/db.sqlite\n");
  check(
    await s.waitForOutput(
      /SQLITE-STORE-DB: \/nix\/var\/nix\/db\/db\.sqlite threadsafe=[12] journal=(?:wal|delete) profile=(?:mmu-wal|nommu-rollback) OK/,
      30000,
    ),
    "Nix store DB uses the profile journal mode with serialized SQLite",
  );
} finally {
  if (!pass) {
    const oom = describeGuestOom(s.snapshot());
    if (oom) console.log(`\n[smoke] ${oom}`);
    console.log("\n── console transcript (tail) ──\n" + s.snapshot().slice(-2000));
  }
  s.kill();
}

console.log("\n[smoke] " + (pass ? "PASS" : "FAIL"));
process.exit(pass ? 0 : 1);
