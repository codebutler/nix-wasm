// selftests-batch.mjs — issue #88: run the LIGHT, display-free `--selftest` smokes
// for the M2/M3a graphics + FFI stack in ONE nix:true boot, instead of a separate
// boot per smoke. Each selftest binary is baked into the boot image (verified
// present in /bin), so no install is needed — we boot once and run them in
// sequence, amortising the one squashfs+cache substitution over all of them.
//
// Covered (each is the exact command + assertion of its standalone *-smoke.mjs):
//   glib-selftest            — gobject + libffi double marshaller (M3a)
//   libffi-selftest          — libffi raw wasm backend (f32/f64/i64 by-value)
//   pango-text --selftest    — pango_cairo layout → fontconfig → cairo-ft (M3a)
//   wl-text --selftest       — M2 text stack (freetype/fontconfig/harfbuzz/cairo)
//
// NOT batched here — the HEAVY GTK selftests (gtk-hello, galculator,
// gtk3-widget-factory): each is a ~14 MB binary, and running them back-to-back in
// ONE boot WEDGES the guest (the NOMMU buddy heap fragments across successive big
// GTK inits + their wl_shm/order-11 allocations — the same fragmentation class as
// the 1.75 GiB RAM bump; a later big GTK exec then stalls). They pass FINE one per
// fresh boot, so nix-boot-smoke runs their standalone gtk-smoke / galculator-smoke
// / widget-factory-smoke as separate gates. Batch where cheap, isolate where heavy.
//
// Also NOT here: the `sommelier-*` wayland-compositor smokes (need a real display —
// Greenfield + WebGL/xvfb+SwiftShader; tracked separately per #88). The
// compiler/install smokes (wrapperless-cc-e2e, profile-install-e2e,
// build-from-source-e2e) are their own gates; devtools-e2e is a subset of
// wrapperless-cc-e2e, so it is intentionally not duplicated.
//
// Assertions match program OUTPUT (the "<X>-SELFTEST: … OK" lines), which never
// appear in the typed command, so there is no echo/substring false-match (cf. #96).
//
// LINUX_WASM_ARTIFACTS must point at vmlinux.wasm / initramfs.cpio.gz /
// base.squashfs / nix-cache/. Wired into the nix-wasm.yml `nix-boot-smoke` job.
// Exit 0 pass / 1 fail / 2 inconclusive (kernel panic — re-run).
import { bootNode } from "./boot-node.mjs";

const TESTS = [
  {
    name: "glib",
    cmd: "/bin/glib-selftest",
    re: /GLIB-SELFTEST: signal_double=42\.5 OK/,
    ms: 30000,
  },
  { name: "libffi", cmd: "/bin/libffi-selftest", re: /LIBFFI-SELFTEST: ALL PASS/, ms: 30000 },
  {
    name: "pango",
    cmd: "/bin/pango-text --selftest",
    re: /PANGO-TEXT-SELFTEST: nonzero_px=[1-9][0-9]* OK/,
    ms: 60000,
  },
  {
    name: "wl-text",
    cmd: "/bin/wl-text --selftest",
    re: /WL-TEXT-SELFTEST: glyphs=[1-9][0-9]* nonzero_px=[1-9][0-9]* OK/,
    ms: 60000,
  },
];

const s = await bootNode({ nix: true });
let pass = true;
const check = (ok, label) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  pass = pass && ok;
  return ok;
};

try {
  let reached;
  try {
    reached = await s.waitForPrompt(120000);
  } catch (e) {
    if (e.message === "KERNEL_PANIC") {
      console.log("[selftests-batch] INCONCLUSIVE — kernel panic on boot; re-run");
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

  for (const t of TESTS) {
    console.log(`  [running ${t.name} selftest …]`);
    s.send(t.cmd + "\n");
    const ok = await s.waitForOutput(t.re, t.ms);
    check(ok, `${t.name} selftest`);
    if (!ok) {
      // Re-sync to a prompt so a failed/hung selftest doesn't bleed into the next.
      s.send("echo SYNC_$?\n");
      await s.waitForOutput(/SYNC_[0-9]/, 15000);
    }
  }

  console.log("\n[selftests-batch] " + (pass ? "PASS" : "FAIL"));
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + s.snapshot().slice(-3500));
  s.kill();
}
process.exit(pass ? 0 : 1);
