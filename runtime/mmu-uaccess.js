// mmu-uaccess.js — HOST-side software uaccess for the wasm software MMU
// (#126/#128): translate USER virtual addresses through the guest's 2-level
// page table before a host import reads/writes guest memory on the guest's
// behalf.
//
// Three parties touch user memory under CONFIG_MMU=y, and each has its own
// translation mechanism:
//   1. instrumented guest code — the softmmu pass's inline walk (softmmu-pass.js);
//   2. the kernel — its soft uaccess (patch 0023 mm/uaccess.c) for syscall copies;
//   3. HOST IMPORTS that take raw user pointers — THIS module.
// Party 3 was missed when the ABI-8 dlopen/dlsym surface landed (#130 predates
// the first MMU boot): __wasm_dlsym read the symbol NAME at the untranslated
// VA → garbage → "Symbol not found" (the widget-factory GModule failure on
// .#kernel-mmu-a2), and __wasm_dl_probe/__wasm_dlopen read the module image at
// the untranslated VA → "not a wasm dylink module". Correct on NOMMU only
// because VA == linear-memory offset there. (The other half of the same
// finding — runtime-instantiated side modules / ffi trampolines being
// un-instrumented guest code — is refused loudly for now: nix-wasm#185.)
//
// Walk format — MUST match arch/wasm's 2-level tables and softmmu-pass.js's
// emitTranslate bit-for-bit (the A2 keystone lesson: the present TEST DIFFERS
// BY LEVEL — a validly-populated pgd entry has NO flag bits, so testing bit 0
// there faults forever on real tables):
//   pgd_e = u32[pt_base + (va>>>22)<<2]        present: entry != 0
//   pte   = u32[(pgd_e & ~0xfff) + ((va>>>12 & 0x3ff)<<2)]
//           present: pte & 1 (_PAGE_PRESENT); a WRITE additionally needs
//           pte & 2 (_PAGE_WRITE) — enforcing it on the write path is what
//           keeps COW pages (mapped present-but-read-only) from being
//           corrupted through a host-side store
//   phys  = (pte & ~0xfff) + (va & 0xfff)
//
// NO FAULT-AND-RETRY: instrumented guest code present-faults via
// NR_MMU_FAULT and re-walks; a host import has no safe way to re-enter the
// kernel's fault path mid-call. A non-present (or non-writable, for writes)
// page throws UserFault — the caller turns that into its surface's clean
// failure code and logs loudly (the #179 posture: fail the one operation,
// never read/write through a wrong translation). In practice the buffers
// these imports receive were written by the guest in the same synchronous
// call chain (no scheduling point in between, single CPU, no swap), so their
// pages are present; the throw guards the invariant instead of assuming it.

const PAGE = 0x1000;
const PAGE_MASK = 0xfff;

export class UserFault extends Error {
  /**
   * @param {number} va      faulting user virtual address
   * @param {"load"|"store"} kind
   * @param {string} detail  which level / which test failed
   */
  constructor(va, kind, detail) {
    super(`mmu-uaccess: ${kind} fault at user VA 0x${(va >>> 0).toString(16)} (${detail})`);
    this.name = "UserFault";
    this.va = va >>> 0;
    this.kind = kind;
  }
}

/**
 * Translate one user VA to a physical (= linear-memory) offset.
 * @param {DataView} dv     over the guest Memory's buffer
 * @param {number} ptBase   the task's page-table root (mm->pgd); 0 = identity
 * @param {number} va       user virtual address
 * @param {boolean} write   require _PAGE_WRITE as well as _PAGE_PRESENT
 * @returns {number} physical offset
 */
export function translateUser(dv, ptBase, va, write = false) {
  va = va >>> 0;
  // EVERY address-valued quantity is normalized `>>> 0`: JS bitwise ops
  // return SIGNED 32-bit values, and both `ptBase` (an i32 crossing a host
  // import — arrives negative above 2 GiB) and a masked pgd/pte entry with
  // bit 31 set would otherwise go negative, slip past the upper-bound-only
  // checks below, and surface as a DataView RangeError instead of a
  // UserFault — escaping the dl imports' clean-failure catch. Unreachable
  // with today's kernel (BOOT_MEM_PAGES stays under the 2 GiB positive-
  // address limit) but the runtime permits a 4 GiB Memory, so the walk must
  // be correct over the full unsigned range. (Codex review on #186.)
  ptBase = ptBase >>> 0;
  if (!ptBase) return va; // NOMMU / identity — byte-identical to the raw path
  const kind = write ? "store" : "load";
  const pgdOff = ptBase + ((va >>> 22) << 2);
  if (pgdOff + 4 > dv.byteLength) throw new UserFault(va, kind, "pgd entry out of memory bounds");
  const pgdE = dv.getUint32(pgdOff, true);
  // Level-1 present = entry != 0 (bare pte-page physical address, NO flag bits).
  if (pgdE === 0) throw new UserFault(va, kind, "pgd entry not present");
  const pteOff = ((pgdE & ~PAGE_MASK) >>> 0) + ((((va >>> 12) & 0x3ff) >>> 0) << 2);
  if (pteOff + 4 > dv.byteLength) throw new UserFault(va, kind, "pte entry out of memory bounds");
  const pte = dv.getUint32(pteOff, true);
  if ((pte & 1) === 0) throw new UserFault(va, kind, "pte not present");
  if (write && (pte & 2) === 0) throw new UserFault(va, kind, "pte not writable (COW/RO page)");
  return ((pte & ~PAGE_MASK) >>> 0) + (va & PAGE_MASK);
}

/**
 * Read `len` bytes of user memory at `va`.
 * Identity (ptBase 0): a zero-copy subarray view — byte-identical behavior to
 * the raw reads this module replaces, so NOMMU is unaffected.
 * Translated: a page-wise gathered COPY (user pages are not physically
 * contiguous).
 * @returns {Uint8Array}
 */
export function readUser(buffer, ptBase, va, len) {
  va = va >>> 0;
  len = len >>> 0;
  const u8 = new Uint8Array(buffer);
  if (!ptBase) return u8.subarray(va, va + len);
  const dv = new DataView(buffer);
  const out = new Uint8Array(len);
  let done = 0;
  while (done < len) {
    const cur = va + done;
    const chunk = Math.min(len - done, PAGE - (cur & PAGE_MASK));
    const phys = translateUser(dv, ptBase, cur, false);
    out.set(u8.subarray(phys, phys + chunk), done);
    done += chunk;
  }
  return out;
}

/**
 * Read a NUL-terminated C string from user memory (page-wise under
 * translation; a page boundary mid-string is followed through the walk).
 * `max` bounds the scan so a missing terminator cannot run away.
 * @returns {string}
 */
export function readUserCString(buffer, ptBase, va, max = 4096) {
  va = va >>> 0;
  const u8 = new Uint8Array(buffer);
  const dec = new TextDecoder();
  if (!ptBase) {
    let end = va;
    const cap = Math.min(u8.length, va + max);
    while (end < cap && u8[end]) end++;
    return dec.decode(u8.slice(va, end));
  }
  const dv = new DataView(buffer);
  const parts = [];
  let scanned = 0;
  while (scanned < max) {
    const cur = va + scanned;
    const chunk = Math.min(max - scanned, PAGE - (cur & PAGE_MASK));
    const phys = translateUser(dv, ptBase, cur, false);
    const page = u8.subarray(phys, phys + chunk);
    const nul = page.indexOf(0);
    if (nul !== -1) {
      parts.push(page.slice(0, nul));
      break;
    }
    parts.push(page.slice());
    scanned += chunk;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return dec.decode(joined);
}

/**
 * Write `bytes` into user memory at `va` (page-wise scatter under
 * translation, with the write-permission test per page — see the COW note in
 * the header). Identity path writes directly, matching the raw stores this
 * replaces.
 */
export function writeUser(buffer, ptBase, va, bytes) {
  va = va >>> 0;
  const u8 = new Uint8Array(buffer);
  if (!ptBase) {
    u8.set(bytes, va);
    return;
  }
  const dv = new DataView(buffer);
  let done = 0;
  while (done < bytes.length) {
    const cur = va + done;
    const chunk = Math.min(bytes.length - done, PAGE - (cur & PAGE_MASK));
    const phys = translateUser(dv, ptBase, cur, true);
    u8.set(bytes.subarray(done, done + chunk), phys);
    done += chunk;
  }
}
