// wl-shm-mmu-smoke.mjs — issue #11 items 2/3/5 parity check: does the
// virtio_wl wl_shm path (per-vfd anon inode + the host device model's
// pfn->host-offset resolution) still work under the software MMU
// (.#kernel-mmu-a2 + the fork-variant toolchain, per the 2026-08-05 parity
// plan's "Remaining" item)?
//
// Every existing GTK smoke is display-free (no compositor in the Node
// harness -> gtk_init_check fails -> wl_shm is never allocated), so nothing
// has ever driven a REAL wl_shm allocation under CONFIG_MMU=y before this.
// This smoke drives one directly, without needing a compositor:
// userspace/wl-shm-test.c opens /dev/wl0, creates a ctx, allocates TWO shm
// vfds (VIRTWL_IOCTL_NEW_ALLOC), attaches both to the ctx via ONE
// VIRTWL_IOCTL_SEND (the wire shape a real wl_shm_create_pool takes:
// message bytes + an out-of-band fd list) — BEFORE touching mmap at all —
// then mmaps each and writes a distinct deterministic byte pattern into it.
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
// the EXACT fds the host WlDevice's `_resolveShmFd` produced for that SEND:
// live Uint8Array VIEWS over the shared guest memory at the pfn-derived
// offset (runtime/virtio/wl-device.js). This is the SAME code path a real
// Greenfield compositor would receive; the smoke just intercepts it instead
// of feeding a compositor, so it is a genuine exercise of the accommodation,
// not a call directly into wl-device.js's internals.
//
// Three independent checks, reported separately (a mmap-content failure must
// not hide a wire-level pass, and vice versa):
//   ITEM2_INODE — guest-side: do the two NEW_ALLOC vfds get DISTINCT inodes
//     (fstat st_ino)? This is patch 0013's anon_inode_create_getfd fix (a
//     shared global inode was the pre-fix bug: two shm pools would alias).
//     Pure VFS/anon-inode correctness, independent of whether guest mmap
//     actually reaches the right physical page under a real MMU.
//   ITEM3_ADDR — host-side: does the SEND's fds array have the right SHAPE —
//     exactly 2 entries, each 4096 bytes, at DISTINCT byteOffsets? This is
//     _resolveShmFd's pfn*4096 arithmetic actually running and finding two
//     separate regions, which only requires the NEW_ALLOC wire messages to
//     have carried distinct pfns — independent of mmap, and exercised
//     BEFORE the guest even calls mmap (see wl-shm-test.c's ordering).
//   CONTENT — bit-exact: do the host-observed bytes match the pattern the
//     guest wrote via mmap? This needs the guest's userspace mmap of the shm
//     vfd to ACTUALLY reach the same physical buffer the host's pfn-derived
//     view reads. virtwl_vfd_mmap / virtwl_vfd_get_unmapped_area
//     (patches/kernel/0013, only fops-guarded for CONFIG_MMU by patch 0023 —
//     never given real MMU semantics: no vm_ops, no remap_pfn_range, no
//     VM_PFNMAP) are documented in their own comments as NOMMU-only ("do_mmap
//     already pointed the region at the guest buffer via ...
//     NOMMU_MAP_DIRECT"). This check is EXPECTED, on current code, to FAIL —
//     confirmed empirically while building this smoke, two ways: (1) an
//     earlier PID-1 variant of wl-shm-test reached "WLSHM: mmap ok" (the
//     mmap() syscall itself succeeds) and then died to a FATAL SIGNAL (guest
//     exit_code 0x07 = SIGBUS) on the first ACCESS into the mapped region,
//     taking the whole guest down with "Attempted to kill init!" — which is
//     why this smoke runs the test as an ordinary child instead; (2) with
//     that fixed, the guest console shows a plain "Bus error" and
//     wl-shm-test exits 135 (128+SIGBUS) at the SAME point — the read probe,
//     even before any write — with the shell surviving cleanly. That failure
//     IS the valuable finding this smoke exists to pin down (PRIME
//     DIRECTIVE: report what's real, don't fake a pass). If CONTENT (or the
//     child's exit status) ever starts passing, someone ported the mmap
//     path for real MMU semantics — promote this smoke.
//
// Exit: 0 all three checks PASS / 1 boot completed but >=1 check failed (a
// real finding — see CONTENT above) / 2 inconclusive (no boot, panic, or the
// shell never reached its witness line — re-run).
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
const SEND_PAYLOAD = "SHMPING!";
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
// CONTENT finding: a nonzero/killed status here, with the RESULT line missing,
// means the write step did not survive.
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
// resolved (live Uint8Array views — copy them out immediately since the
// underlying SharedArrayBuffer keeps changing).
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
          bytes: v.slice(), // copy out now
        })),
      });
    },
  },
});

let pass = false;
let transcript = "";
try {
  const ok = await s.waitForOutput(/WLSHMBOOT: script done/, 120000).catch((e) => {
    if (e && e.message === "KERNEL_PANIC") return "panic";
    return false;
  });
  transcript = s.snapshot();

  if (ok === "panic" || /Kernel panic|Aiee, killing interrupt handler/i.test(transcript)) {
    console.log("[wl-shm-mmu-smoke] INCONCLUSIVE — kernel panic on boot; re-run");
    console.log(transcript.slice(-2000));
    process.exit(2);
  }
  if (!ok) {
    console.log("[wl-shm-mmu-smoke] INCONCLUSIVE — shell never reached its witness line");
    console.log(transcript.slice(-2000));
    process.exit(2);
  }

  for (const line of transcript.split("\n")) {
    if (/WLSHM|RESULT wl_shm|WLSHMTEST_RC|WLSHMBOOT/.test(line)) console.log("  " + line.trim());
  }

  // --- guest-side child exit status ----------------------------------------
  const rcMatch = transcript.match(/^WLSHMTEST_RC=(\S+?)\r?$/m);
  const testRc = rcMatch ? rcMatch[1] : undefined;
  console.log(`GUEST_RC: wl-shm-test exited ${testRc ?? "<missing>"} (0 = clean exit)`);

  // --- item 2: guest-observed distinct inode --------------------------------
  const inodeLine = transcript.match(/^WLSHM: ino0=\S+ ino1=\S+ distinct_inode=(\d)\r?$/m);
  const item2 = !!inodeLine && inodeLine[1] === "1";
  console.log(
    `ITEM2_INODE: ${item2 ? "PASS" : "FAIL"} (${inodeLine ? inodeLine[0] : "no distinct_inode line"})`,
  );

  // --- item 3: host-observed addressing shape --------------------------------
  const send = sends.find((e) => dec.decode(e.data) === SEND_PAYLOAD);
  let item3 = false;
  let item3Detail = "no matching SEND observed";
  if (send) {
    const [f0, f1] = send.fds;
    if (send.fds.length !== 2) {
      item3Detail = `expected 2 fds, got ${send.fds.length}`;
    } else if (f0.byteLength !== SHM_SIZE || f1.byteLength !== SHM_SIZE) {
      item3Detail = `wrong byteLength: ${f0.byteLength}, ${f1.byteLength}`;
    } else if (f0.byteOffset === f1.byteOffset) {
      item3Detail = `both fds resolved to the SAME offset 0x${f0.byteOffset.toString(16)} (aliasing)`;
    } else {
      item3 = true;
      item3Detail = `2 fds, 4096B each, offsets 0x${f0.byteOffset.toString(16)} / 0x${f1.byteOffset.toString(16)}`;
    }
  }
  console.log(`ITEM3_ADDR: ${item3 ? "PASS" : "FAIL"} (${item3Detail})`);

  // --- content: bit-exact guest-write -> host-read round trip ---------------
  let content = false;
  let contentDetail = "n/a";
  if (!item3) {
    contentDetail = "n/a (item 3 failed first)";
  } else if (testRc !== "0") {
    contentDetail = `n/a (wl-shm-test did not exit cleanly: rc=${testRc ?? "<missing>"} — see CONTENT note in the file header)`;
  } else {
    const [f0, f1] = send.fds;
    const m0 = bytesEqual(f0.bytes, EXPECTED[0]);
    const m1 = bytesEqual(f1.bytes, EXPECTED[1]);
    content = m0 && m1;
    contentDetail = `pool0 match=${m0} pool1 match=${m1} (pool0 first 8B seen=[${Array.from(
      f0.bytes.subarray(0, 8),
    ).join(",")}] expected=[${Array.from(EXPECTED[0].subarray(0, 8)).join(",")}])`;
  }
  console.log(`CONTENT: ${content ? "PASS" : "FAIL"} (${contentDetail})`);

  pass = item2 && item3 && content;
  console.log(
    `RESULT wl_shm_mmu ${pass ? "PASS" : "FAIL"} item2_inode=${item2 ? 1 : 0} item3_addr=${
      item3 ? 1 : 0
    } content=${content ? 1 : 0} guest_rc=${testRc ?? "?"}`,
  );
} finally {
  if (!pass) console.log("\n── transcript tail ──\n" + transcript.slice(-4000));
  s.kill();
}
process.exit(pass ? 0 : 1);
