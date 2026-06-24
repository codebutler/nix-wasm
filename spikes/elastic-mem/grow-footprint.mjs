// Compare process memory after allocating N memories of each kind.
import fs from 'fs';

const N = 64;

function rssMB() {
  return Math.round(process.memoryUsage().rss / 1048576);
}

function getVmSizeKB() {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const match = status.match(/^VmSize:\s+(\d+)\s+kB$/m);
  if (!match) {
    throw new Error('Could not parse VmSize from /proc/self/status');
  }
  return parseInt(match[1], 10);
}

function getVmSizeMB() {
  return Math.round(getVmSizeKB() / 1024);
}

const PAGE = 65536;

const baseRss = rssMB();
const baseVmSizeMB = getVmSizeMB();
const baseVmSizeKB = getVmSizeKB();

const nonShared = [];
for (let i = 0; i < N; i++) {
  const m = new WebAssembly.Memory({ initial: 4 }); // non-shared, no explicit maximum
  m.grow(8); // commit 12 pages (~0.75 MiB) each
  nonShared.push(m);
}
const afterNonSharedRss = rssMB();
const afterNonSharedVmSizeMB = getVmSizeMB();
const afterNonSharedVmSizeKB = getVmSizeKB();

const shared = [];
for (let i = 0; i < N; i++) {
  // shared MUST declare maximum; mirror today's 0x2000 (512 MiB) cap
  const m = new WebAssembly.Memory({ initial: 4, maximum: 0x2000, shared: true });
  shared.push(m);
}
const afterSharedRss = rssMB();
const afterSharedVmSizeMB = getVmSizeMB();
const afterSharedVmSizeKB = getVmSizeKB();

// ---------------------------------------------------------------------------
// Follow-up: does an EXPLICIT SMALL maximum (0x400 = 64 MiB) reserve only that
// much VA, for both memory types? Each: initial:4, grow(8), maximum:0x400.
// ---------------------------------------------------------------------------
const MAX_SMALL = 0x400; // 1024 pages = 64 MiB

const beforeNS64VmSizeKB = getVmSizeKB();
const nonShared64 = [];
for (let i = 0; i < N; i++) {
  const m = new WebAssembly.Memory({ initial: 4, maximum: MAX_SMALL });
  m.grow(8);
  nonShared64.push(m);
}
const afterNS64VmSizeKB = getVmSizeKB();

const beforeS64VmSizeKB = getVmSizeKB();
const shared64 = [];
for (let i = 0; i < N; i++) {
  const m = new WebAssembly.Memory({ initial: 4, maximum: MAX_SMALL, shared: true });
  m.grow(8);
  shared64.push(m);
}
const afterS64VmSizeKB = getVmSizeKB();

const nonShared64MaxDeltaMB_perMem =
  Math.round((afterNS64VmSizeKB - beforeNS64VmSizeKB) / 1024 / N);
const shared64MaxDeltaMB_perMem =
  Math.round((afterS64VmSizeKB - beforeS64VmSizeKB) / 1024 / N);

console.log(JSON.stringify({
  N,
  baseRssMB: baseRss,
  baseVmSizeMB,
  baseVmSizeKB,
  nonSharedRssDeltaMB: afterNonSharedRss - baseRss,
  nonSharedVmSizeDeltaMB: afterNonSharedVmSizeMB - baseVmSizeMB,
  nonSharedVmSizeDeltaKB: afterNonSharedVmSizeKB - baseVmSizeKB,
  sharedRssDeltaMB: afterSharedRss - afterNonSharedRss,
  sharedVmSizeDeltaMB: afterSharedVmSizeMB - afterNonSharedVmSizeMB,
  sharedVmSizeDeltaKB: afterSharedVmSizeKB - afterNonSharedVmSizeKB,
  // Follow-up: explicit small maximum (0x400 = 64 MiB) per memory:
  nonShared64MaxDeltaMB_perMem,
  shared64MaxDeltaMB_perMem,
  nodeVersion: process.version,
}, null, 2));
