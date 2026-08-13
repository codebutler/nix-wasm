// wl-shm-mmu-smoke.mjs — issue #11 items 2/3 parity check: does the
// virtio_wl wl_shm path (per-vfd anon inode + the host device model's
// pfn->host-offset resolution) still work under the software MMU
// (.#kernel-mmu-a2 + the fork-variant toolchain, per the 2026-08-05 parity
// plan's "Remaining" item)? Item 5 (waylandproxyd's mmap+copy resync) is NOT
// covered here — that logic lives in the Sommelier Wayland-client bridge
// path, unreached without a real compositor boot (see the bottom of this
// header).
//
// Every existing GTK smoke is display-free (no compositor in the Node
// harness -> gtk_init_check fails -> wl_shm is never allocated), so nothing
// has ever driven a REAL wl_shm allocation under CONFIG_MMU=y before this.
// This smoke drives one directly, without needing a compositor:
// userspace/wl-shm-test.c opens /dev/wl0, creates a ctx, allocates TWO shm
// vfds (VIRTWL_IOCTL_NEW_ALLOC), attaches both to the ctx via a FIRST
// VIRTWL_IOCTL_SEND (the wire shape a real wl_shm_create_pool takes:
// message bytes + an out-of-band fd list) — BEFORE touching mmap at all —
// then mmaps each, writes a distinct deterministic byte pattern into it,
// and issues a SECOND SEND (same two fds, a distinct payload) to "commit"
// the drawn buffer. That two-SEND shape (attach, draw, commit) is the real
// wire shape a client uses, and is what lets CONTENT (see below) read a
// live host view captured AFTER the write.
//
// THE HELD-OPEN RACE (why the C program does not just exit after that
// second SEND): kernel-worker.js's `sendOut` posts only `{byteOffset,
// length}` for the fds — NOT copies — via an ASYNC postMessage, and
// completes the guest's SEND ioctl immediately; kernel-host.js re-views the
// shared `memory.buffer` at those offsets whenever it gets around to
// processing that message. If wl-shm-test exited (or closed the vfds) right
// after the ioctl returned, the anon inode's last reference would drop, the
// kernel would free the backing pages (do_vfd_close), and the host could
// end up building its view over freed/reused memory — wrong bytes, not a
// clean failure, and exactly the kind of thing that stays invisible while
// CONTENT fails for an unrelated reason (today: the SIGBUS below) and starts
// mattering the instant that reason goes away. So on a successful second
// SEND, wl-shm-test does NOT exit: it prints a distinct "WLSHM: held"
// witness and parks forever with the fds still open (see the comment at
// that call site in wl-shm-test.c) — the backing pages stay allocated and
// untouched until this smoke has copied the bytes out and torn the whole
// guest down itself. Today this path is UNREACHABLE (the guest always dies
// at the read probe before ever reaching the second SEND — see CONTENT
// below), so it is documented but not exercised by any CI run yet; the
// moment issue #203 is fixed, it is what makes CONTENT assert something
// real instead of a race.
//
// It boots the REAL-FORK busybox (.#userspace-busybox-fork) as PID 1, same
// shape as busybox-fork-smoke.mjs, and runs wl-shm-test as an ORDINARY CHILD
// from a shell script, deliberately NOT as PID-1: one of the things under
// test is whether writing into the mmap'd region is even safe on this
// kernel, and a first attempt that ran this program AS PID-1 confirmed it
// is not (see CONTENT below) — a fatal signal killed the whole guest
// ("Attempted to kill init!") before any evidence could be collected. As an
// ordinary child, a fatal signal there kills only that child; the shell
// survives, reports its exit status, and every WLSHM: line already flushed
// stays in the transcript.
//
// The Node side registers a `wayland.sendOut` bridge hook — already-shipped
// API (runtime/boot.js / kernel-host.js), no engine change — which receives
// the EXACT fds the host WlDevice's `_resolveShmFd` produced for EACH SEND:
// live Uint8Array VIEWS over the shared guest memory at the pfn-derived
// offset (runtime/virtio/wl-device.js), copied out synchronously inside the
// hook (so nothing races the vfd's teardown once the guest process exits).
// This is the SAME code path a real Greenfield compositor would receive;
// the smoke just intercepts it instead of feeding a compositor, so it is a
// genuine exercise of the accommodation, not a call directly into
// wl-device.js's internals.
//
// Three independent checks, reported separately (a mmap-content failure must
// not hide a wire-level pass, and vice versa):
//   ITEM2_INODE — guest-side: do the two NEW_ALLOC vfds get DISTINCT inodes
//     (fstat st_ino)? This is patch 0013's anon_inode_create_getfd fix (a
//     shared global inode was the pre-fix bug: two shm pools would alias).
//     Pure VFS/anon-inode correctness, independent of whether guest mmap
//     actually reaches the right physical page under a real MMU.
//   ITEM3_ADDR — host-side, sourced from the FIRST send (payload SHMPING!,
//     issued before mmap/write): does the SEND's fds array have the right
//     SHAPE — exactly 2 entries, each 4096 bytes, at DISTINCT byteOffsets
//     that don't overlap (|offset0 - offset1| >= 4096) and both within the
//     guest memory's current bounds? This is _resolveShmFd's pfn*4096
//     arithmetic actually running and finding two separate, valid regions,
//     which only requires the NEW_ALLOC wire messages to have carried
//     distinct pfns — independent of mmap.
//   CONTENT — bit-exact, sourced from the SECOND send (payload SHMDONE!,
//     issued after the pattern write): do the host-observed bytes match the
//     pattern the guest wrote via mmap? This needs the guest's userspace
//     mmap of the shm vfd to ACTUALLY reach the same physical buffer the
//     host's pfn-derived view reads.
//
//     The kernel code for this (patches/kernel/0013's virtwl_vfd_mmap /
//     virtwl_vfd_get_unmapped_area) was written for NOMMU's do_mmap
//     direct-mapping and was never given real (page-fault-driven) MMU
//     semantics. Precisely: patch 0023 ADDS an `#ifndef CONFIG_MMU` guard
//     around `virtwl_vfd_mmap_capabilities` and its fops slot — compiling
//     that NOMMU-only direct-map capability hook OUT under CONFIG_MMU —
//     while `.mmap` (virtwl_vfd_mmap) and `.get_unmapped_area`
//     (virtwl_vfd_get_unmapped_area) stay REGISTERED UNCHANGED; nothing was
//     "relaxed" for MMU, a guard was added around the one hook that can't
//     even exist there (fs.h only defines that struct field under
//     !CONFIG_MMU). Neither surviving hook does anything MMU-correct:
//     `.mmap` never sets `vma->vm_ops` and never calls remap_pfn_range (so
//     no page table entries are ever installed for the mapping), and
//     `.get_unmapped_area` returns `(unsigned long)vfd->shm_buf` — a KERNEL
//     address — as if it were the USER mapping address, which is not what
//     that hook means under a real MMU (a hint for a FREE user VA range,
//     not literally where the backing pages live). Filed as issue #203
//     (both corrections above were posted there) with these findings, which
//     this smoke reproduces on every boot: an earlier PID-1 variant of
//     wl-shm-test reached "WLSHM: mmap ok" (mmap() itself succeeds) and then
//     died to a FATAL SIGNAL (guest exit_code 0x07 = SIGBUS) on the first
//     ACCESS into the mapped region, taking the whole guest down with
//     "Attempted to kill init!"; with the test running as an ordinary child
//     instead, the guest console shows a plain "Bus error" and wl-shm-test
//     exits 135 (128+SIGBUS) at the SAME point — the read probe, even
//     before any write — with the shell surviving cleanly. See the
//     KNOWN_SIGBUS_SIGNATURE check below: this smoke asserts that EXACT,
//     reproduced signature so any OTHER outcome (a different signal, a
//     clean exit with wrong bytes, a hang) is flagged loudly as something
//     that needs a human, not silently absorbed as "still failing".
//
// PROMOTION: this step runs non-gating (continue-on-error) in CI for now.
// The next commit is expected to flip it to a hard XFAIL gate inside the
// existing `run_smoke` sequence — a ONE-LINE change to the `pass` line
// below, from `item2 && item3 && content` to
// `item2 && item3 && (content || matchesKnownSigbusSignature)` — once
// ITEM2/ITEM3 have recorded a green run in CI (see the workflow step's own
// comment for the exact criterion). If CONTENT ever starts passing for
// real, that is itself the interesting event (someone ported
// virtwl_vfd_mmap for real MMU semantics) — see the "#203 appears FIXED"
// message below.
//
// Exit: 0 all three checks PASS / 1 boot completed but >=1 check failed (a
// real, tracked finding — see CONTENT above) / 2 inconclusive (no boot,
// panic, or the shell never reached its witness line — re-run).
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { bootNode } from "./boot-node.mjs";

const vmlinuxPath = process.env.MMU_VMLINUX;
const bbDir = process.env.BUSYBOX_FORK; // $out/bin of .#userspace-busybox-fork
const testPath = process.env.WL_SHM_TEST; // $out/bin/wl-shm-test of .#wl-shm-test
if (!vmlinuxPath || !bbDir || !testPath) {
  console.error(
    "wl-shm-mmu-smoke: set MMU_VMLINUX (.#kernel-mmu-a2), BUSYBOX_FORK (.#userspace-busybox-fork /bin dir), WL_SHM_TEST (.#wl-shm-test /bin/wl-shm-test)",
  );
  process.exit(1);
}

const SHM_SIZE = 4096;
const SEND1_PAYLOAD = "SHMPING!"; // attach (before the buffer is drawn) -> ITEM3_ADDR
const SEND2_PAYLOAD = "SHMDONE!"; // commit (after the buffer is drawn) -> CONTENT
// Mirrors userspace/wl-shm-test.c's pattern_byte(): two distinct deterministic
// formulas so the two allocations are distinguishable from each other AND
// from an untouched (GFP_ZERO) buffer.
function expectedPattern(which) {
  const out = new Uint8Array(SHM_SIZE);
  for (let i = 0; i < SHM_SIZE; i++) out[i] = (which === 0 ? i * 3 + 7 : i * 5 + 11) & 0xff;
  return out;
}
const EXPECTED = [expectedPattern(0), expectedPattern(1)];

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// newc cpio with regular-file AND symlink support — same helper as
// busybox-fork-smoke.mjs (busybox ships as one binary plus a symlink per
// applet).
function cpioNewc(entries) {
  const chunks = [];
  let ino = 1;
  const pad4 = (n) => (4 - (n % 4)) % 4;
  const hdr = (name, mode, size) => {
    const h =
      "070701" +
      [ino++, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, name.length + 1, 0]
        .map((x) => x.toString(16).padStart(8, "0"))
        .join("");
    const nameB = enc.encode(name + "\0");
    const head = new Uint8Array(110 + nameB.length + pad4(110 + nameB.length));
    head.set(enc.encode(h), 0);
    head.set(nameB, 110);
    return head;
  };
  for (const e of entries) {
    const data = e.data ? e.data : new Uint8Array(0);
    chunks.push(hdr(e.name, e.mode, data.length));
    if (data.length) {
      const body = new Uint8Array(data.length + pad4(data.length));
      body.set(data, 0);
      chunks.push(body);
    }
  }
  chunks.push(hdr("TRAILER!!!", 0, 0));
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// wl-shm-test's own exit status, captured via `$?` right after it runs — the
// #96 lesson: matched by the shell's EXPANSION, not the echoed command text,
// and never a substring of another marker. A killing signal shows up here as
// 128+signum (POSIX shell convention; busybox hush follows it) — e.g. 135 for
// SIGBUS(7), 139 for SIGSEGV(11) — so this is also the guest-side half of the
// CONTENT finding: a nonzero/killed status here, with the second SEND's
// marker missing, means the write step did not survive.
const initScript = [
  "exec >/dev/console 2>&1",
  'echo "WLSHMBOOT: init alive pid=$$"',
  "/bin/wl-shm-test",
  'echo "WLSHMTEST_RC=$?"',
  'echo "WLSHMBOOT: script done"',
].join("; ");
const inittab =
  "::sysinit:/bin/mount -t devtmpfs devtmpfs /dev\n" +
  "::sysinit:/bin/sh -c '" +
  initScript.replace(/'/g, "'\\''") +
  "'\n";

// Walk the busybox /bin dir: the binary as a regular file, everything else as
// a symlink -> busybox (exactly how it is installed on disk) — same as
// busybox-fork-smoke.mjs.
const bbEntries = [];
for (const name of readdirSync(bbDir)) {
  const st = lstatSync(join(bbDir, name));
  if (st.isSymbolicLink()) {
    bbEntries.push({
      name: "bin/" + name,
      mode: 0o120777,
      data: enc.encode(readlinkSync(join(bbDir, name))),
    });
  } else if (st.isFile()) {
    bbEntries.push({
      name: "bin/" + name,
      mode: 0o100755,
      data: new Uint8Array(readFileSync(join(bbDir, name))),
    });
  }
}

const cpio = cpioNewc([
  { name: "dev", mode: 0o040755 },
  { name: "proc", mode: 0o040755 },
  { name: "etc", mode: 0o040755 },
  { name: "bin", mode: 0o040755 },
  { name: "etc/inittab", mode: 0o100644, data: enc.encode(inittab) },
  // /init = busybox (argv[0] basename "init" -> busybox runs the init applet).
  { name: "init", mode: 0o100755, data: new Uint8Array(readFileSync(join(bbDir, "busybox"))) },
  { name: "bin/wl-shm-test", mode: 0o100755, data: new Uint8Array(readFileSync(testPath)) },
  ...bbEntries,
]);

const dir = mkdtempSync(join(tmpdir(), "wl-shm-mmu-smoke-"));
writeFileSync(join(dir, "vmlinux.wasm"), readFileSync(vmlinuxPath));
writeFileSync(join(dir, "initramfs.cpio.gz"), gzipSync(cpio));

// Every VFD_SEND the guest issued, with the exact fds the host WlDevice
// resolved (live Uint8Array views — copy the BYTES out immediately since the
// underlying SharedArrayBuffer keeps changing; also record the memory's
// CURRENT total size at hook-fire time for the bounds check below, since
// memory.grow() would otherwise make a later comparison meaningless).
const sends = [];
const s = await bootNode({
  nix: false,
  baseUrl: pathToFileURL(dir + "/").href,
  wayland: {
    sendOut: (clientId, buffer, fds) => {
      sends.push({
        clientId,
        data: new Uint8Array(buffer),
        fds: fds.map((v) => ({
          byteOffset: v.byteOffset,
          byteLength: v.byteLength,
          memoryByteLength: v.buffer.byteLength,
          bytes: v.slice(), // copy out now
        })),
      });
    },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = false;
let transcript = "";
try {
  // Fold BOTH end-of-boot witnesses AND the panic patterns into ONE wait
  // regex so this returns as soon as ANY of them appears, instead of
  // burning the full timeout on a panicked (or held-open) boot
  // (waitForOutput never rejects — only waitForPrompt does — so a separate
  // .catch(KERNEL_PANIC) branch here would be dead code). Two DIFFERENT
  // witnesses, not one, because wl-shm-test.c has two deliberate exit
  // paths (see the HELD-OPEN RACE note above):
  //   - `WLSHMBOOT: script done` — the shell's own echo AFTER wl-shm-test
  //     returned (today's path: the child dies at the read probe, and the
  //     shell's `$?` capture + script-done echo still run).
  //   - `WLSHM: held` — wl-shm-test's OWN witness, printed BEFORE it parks
  //     forever with the fds open. On this path the shell's `wl-shm-test`
  //     invocation never returns, so `WLSHMBOOT: script done` (and
  //     `WLSHMTEST_RC=`) are NEVER printed — this smoke must not wait for
  //     them, and must not treat their absence as an error, on this path.
  // Both are anchored to a LINE START (^...$, multiline) so neither can
  // match a substring inside busybox init's OWN "starting pid N, tty '':
  // '<command>'" announcement of the inittab command line itself (the #96
  // hazard) — a survives-by-luck risk with an unanchored pattern, since
  // that announcement embeds this script's full text and busybox's
  // message() truncation is not a contract this smoke should depend on.
  const ok = await s.waitForOutput(
    /^WLSHMBOOT: script done\r?$|^WLSHM: held\r?$|Kernel panic|Aiee, killing interrupt handler/m,
    120000,
  );
  transcript = s.snapshot();

  if (/Kernel panic|Aiee, killing interrupt handler/i.test(transcript)) {
    console.log("[wl-shm-mmu-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
    console.log(transcript.slice(-2000));
    process.exit(2);
  }
  const held = /^WLSHM: held\r?$/m.test(transcript);
  const scriptDone = /^WLSHMBOOT: script done\r?$/m.test(transcript);
  if (!ok || (!held && !scriptDone)) {
    console.log("[wl-shm-mmu-smoke] INCONCLUSIVE — shell never reached either witness line");
    console.log(transcript.slice(-2000));
    process.exit(2);
  }
  if (held) {
    // The race this smoke exists to close (see the HELD-OPEN RACE note
    // above): wl-shm-test's second SEND already returned by the time its
    // OWN process printed "held" (single-threaded guest: ioctl return,
    // THEN printf), and that SEND's postMessage — sent on the SAME
    // worker→main channel, strictly earlier in program order — is
    // therefore already enqueued ahead of the console byte we just
    // observed. A short, BOUNDED settle delay here is cheap defense-in-
    // depth against any remaining scheduling slack (e.g. a real
    // compositor bridge wrapping sendOut in a Promise chain) — it does
    // NOT replace the fds-still-open hold itself, which is what actually
    // keeps the bytes correct; this is only about giving the already-
    // enqueued message a moment to be drained before we read `sends`.
    await sleep(500);
    transcript = s.snapshot();
  }

  for (const line of transcript.split("\n")) {
    if (/WLSHM|RESULT wl_shm|WLSHMTEST_RC|WLSHMBOOT/.test(line)) console.log("  " + line.trim());
  }

  // --- guest-side child exit status ----------------------------------------
  // On the HELD path wl-shm-test never returns to the shell, so
  // WLSHMTEST_RC is NEVER printed — that is expected, not a missing-data
  // failure, and must not be treated as one below.
  const rcMatch = transcript.match(/^WLSHMTEST_RC=(\S+?)\r?$/m);
  const testRc = rcMatch ? rcMatch[1] : undefined;
  if (held) {
    console.log(
      "GUEST_RC: n/a — wl-shm-test is HELD open (parked with its fds still open, per the HELD-OPEN RACE note); it never returns to the shell on this path",
    );
  } else {
    console.log(`GUEST_RC: wl-shm-test exited ${testRc ?? "<missing>"} (0 = clean exit)`);
  }

  // --- item 2: guest-observed distinct inode --------------------------------
  const inodeLine = transcript.match(/^WLSHM: ino0=\S+ ino1=\S+ distinct_inode=(\d)\r?$/m);
  const item2 = !!inodeLine && inodeLine[1] === "1";
  console.log(
    `ITEM2_INODE: ${item2 ? "PASS" : "FAIL"} (${inodeLine ? inodeLine[0] : "no distinct_inode line"})`,
  );

  // --- guest-side SEND ioctl status (distinct from host-side resolution:
  // a guest ioctl failure here would otherwise surface only as "no matching
  // SEND observed" below, which reads like a HOST bug) --------------------
  const send1RcMatch = transcript.match(/^WLSHM: send1_ret=(-?\d+)/m);
  const send1Rc = send1RcMatch ? send1RcMatch[1] : undefined;
  if (send1Rc !== "0") {
    console.log(
      `GUEST_SEND1_RC: FAIL — wl-shm-test's first SEND ioctl returned ${
        send1Rc ?? "<missing>"
      } (a GUEST-side failure, not a host resolution failure)`,
    );
  } else {
    console.log("GUEST_SEND1_RC: OK (0)");
  }

  // --- item 3: host-observed addressing shape --------------------------------
  const send1 = sends.find((e) => dec.decode(e.data) === SEND1_PAYLOAD);
  let item3 = false;
  let item3Detail = "no matching first SEND observed";
  if (send1) {
    const [f0, f1] = send1.fds;
    if (send1.fds.length !== 2) {
      item3Detail = `expected 2 fds, got ${send1.fds.length}`;
    } else if (f0.byteLength !== SHM_SIZE || f1.byteLength !== SHM_SIZE) {
      item3Detail = `wrong byteLength: ${f0.byteLength}, ${f1.byteLength}`;
    } else if (f0.byteOffset < 0 || f0.byteOffset + f0.byteLength > f0.memoryByteLength) {
      item3Detail = `pool0 offset 0x${f0.byteOffset.toString(16)}+${f0.byteLength} is out of bounds of guest memory (${f0.memoryByteLength}B)`;
    } else if (f1.byteOffset < 0 || f1.byteOffset + f1.byteLength > f1.memoryByteLength) {
      item3Detail = `pool1 offset 0x${f1.byteOffset.toString(16)}+${f1.byteLength} is out of bounds of guest memory (${f1.memoryByteLength}B)`;
    } else if (Math.abs(f0.byteOffset - f1.byteOffset) < SHM_SIZE) {
      item3Detail = `pools OVERLAP: offsets 0x${f0.byteOffset.toString(16)} / 0x${f1.byteOffset.toString(16)} are closer than ${SHM_SIZE}B apart`;
    } else {
      item3 = true;
      item3Detail = `2 fds, 4096B each, non-overlapping in-bounds offsets 0x${f0.byteOffset.toString(16)} / 0x${f1.byteOffset.toString(16)} (memory ${f0.memoryByteLength}B)`;
    }
  }
  console.log(`ITEM3_ADDR: ${item3 ? "PASS" : "FAIL"} (${item3Detail})`);

  // --- content: bit-exact guest-write -> host-read round trip, read from the
  // SECOND send (issued after the pattern write) -----------------------------
  const send2 = sends.find((e) => dec.decode(e.data) === SEND2_PAYLOAD);
  let content = false;
  let contentDetail = "n/a";
  if (!item3) {
    contentDetail = "n/a (item 3 failed first)";
  } else if (!send2) {
    contentDetail =
      "no second SEND observed — matches the known SIGBUS state (see CONTENT in the file header); distinct from a second SEND with wrong bytes";
  } else {
    const [f0, f1] = send2.fds;
    const m0 = bytesEqual(f0.bytes, EXPECTED[0]);
    const m1 = bytesEqual(f1.bytes, EXPECTED[1]);
    content = m0 && m1;
    contentDetail = `pool0 match=${m0} pool1 match=${m1} (pool0 first 8B seen=[${Array.from(
      f0.bytes.subarray(0, 8),
    ).join(",")}] expected=[${Array.from(EXPECTED[0].subarray(0, 8)).join(",")}])`;
  }
  console.log(`CONTENT: ${content ? "PASS" : "FAIL"} (${contentDetail})`);

  // --- the exact, reproduced SIGBUS signature (issue #203) ------------------
  // The current, EXPECTED state on unfixed code: mmap() succeeds, then the
  // very first ACCESS (even a read) into the region raises SIGBUS, printed
  // by the shell as a bare "Bus error", with wl-shm-test exiting
  // 128+SIGBUS=135 and no read_probe/pattern-written/second-SEND line past
  // "WLSHM: mmap ok". Checking this EXACT signature (not just "content
  // failed") is what makes the eventual XFAIL promotion (see the file
  // header) meaningful: any OTHER outcome — a different signal, a clean exit
  // with wrong bytes, a hang — must be flagged loudly, not silently treated
  // as "still the known failure".
  const mmapOk = /^WLSHM: mmap ok\r?$/m.test(transcript);
  const readProbeSeen = /^WLSHM: read_probe0=/m.test(transcript);
  const busError = /Bus error/.test(transcript);
  const matchesKnownSigbusSignature = mmapOk && !readProbeSeen && busError && testRc === "135";

  if (matchesKnownSigbusSignature && !content) {
    console.log("XFAIL(#203) wl_shm mmap SIGBUS — expected, tracked");
  } else if (content) {
    console.log(
      '#203 appears FIXED — promote this XFAIL to a hard CONTENT assertion (drop the "|| matchesKnownSigbusSignature" fallback below once this is confirmed on more than one run)',
    );
  } else {
    console.log(
      `UNEXPECTED — outcome matches neither the known SIGBUS signature nor a clean content pass ` +
        `(mmapOk=${mmapOk} readProbeSeen=${readProbeSeen} busError=${busError} testRc=${testRc ?? "?"}); needs investigation, not just a re-run`,
    );
  }

  // One-line flip point for the future hard-gate promotion (see the file
  // header's PROMOTION note): today `pass` requires content===true; the
  // promoted XFAIL gate instead requires (content || matchesKnownSigbusSignature).
  pass = item2 && item3 && content;
  console.log(
    `RESULT wl_shm_mmu ${pass ? "PASS" : "FAIL"} item2_inode=${item2 ? 1 : 0} item3_addr=${
      item3 ? 1 : 0
    } content=${content ? 1 : 0} known_sigbus_signature=${
      matchesKnownSigbusSignature ? 1 : 0
    } held=${held ? 1 : 0} guest_rc=${testRc ?? "?"}`,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + transcript.slice(-4000));
  s.kill();
}
process.exit(pass ? 0 : 1);
