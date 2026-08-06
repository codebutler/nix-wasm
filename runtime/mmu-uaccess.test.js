// mmu-uaccess.test.js — the host-side software uaccess walk (mmu-uaccess.js)
// against a hand-built 2-level page table in the exact arch/wasm format
// (pgd entry = bare pte-page physical address, present = nonzero; leaf pte =
// frame | _PAGE_PRESENT(1) | _PAGE_WRITE(2)). The A2 keystone lesson is
// pinned here on the host side too: flag-bit masking at BOTH levels, the
// per-level present tests, and the write-permission test that keeps COW
// pages safe from host-side stores.
import { describe, expect, test } from "bun:test";
import { UserFault, readUser, readUserCString, translateUser, writeUser } from "./mmu-uaccess.js";

const PT_BASE = 0x1000;
const PTE_PAGE = 0x2000; // pte page for pgd index 2 (VAs 0x0080_0000..0x00bf_ffff)

// Build a memory image with a page table mapping:
//   va 0x0080_1000..0x0080_1fff -> phys 0x3000 (present, writable)
//   va 0x0080_2000..0x0080_2fff -> phys 0x5000 (present, writable) — NON-adjacent
//   va 0x0080_3000..0x0080_3fff -> phys 0x6000 (present, READ-ONLY)
//   va 0x0080_4000..           -> not present (pte 0)
//   va 0x00c0_0000..           -> pgd not present (entry 0)
function makeMemory() {
  const buffer = new ArrayBuffer(0x10000);
  const dv = new DataView(buffer);
  // pgd[2] carries the pte-page address with FLAG-LIKE LOW BITS SET (0x7):
  // the walk must mask them (low 12 bits), and level-1 present is nonzero,
  // NOT bit 0 — using 0x7 here would pass a wrong bit-0 test too, so the
  // masking is what this value actually pins.
  dv.setUint32(PT_BASE + 2 * 4, PTE_PAGE | 0x7, true);
  dv.setUint32(PTE_PAGE + 1 * 4, 0x3000 | 3, true); // present | write
  dv.setUint32(PTE_PAGE + 2 * 4, 0x5000 | 3, true); // present | write
  dv.setUint32(PTE_PAGE + 3 * 4, 0x6000 | 1, true); // present, NOT writable
  return { buffer, dv };
}

describe("translateUser", () => {
  test("identity when ptBase is 0 (NOMMU path)", () => {
    const { dv } = makeMemory();
    expect(translateUser(dv, 0, 0xdeadbeef)).toBe(0xdeadbeef);
  });

  test("two-level walk with flag-bit masking at both levels", () => {
    const { dv } = makeMemory();
    expect(translateUser(dv, PT_BASE, 0x00801234)).toBe(0x3234);
    expect(translateUser(dv, PT_BASE, 0x00802000)).toBe(0x5000);
  });

  test("non-present pte faults", () => {
    const { dv } = makeMemory();
    expect(() => translateUser(dv, PT_BASE, 0x00804000)).toThrow(UserFault);
  });

  test("non-present pgd entry faults", () => {
    const { dv } = makeMemory();
    expect(() => translateUser(dv, PT_BASE, 0x00c00000)).toThrow(UserFault);
  });

  test("store to a present-but-read-only (COW) page faults; load does not", () => {
    const { dv } = makeMemory();
    expect(translateUser(dv, PT_BASE, 0x00803010, false)).toBe(0x6010);
    expect(() => translateUser(dv, PT_BASE, 0x00803010, true)).toThrow(UserFault);
  });

  test("bit-31 pgd entry stays unsigned: UserFault (bounds), never a RangeError", () => {
    // JS bitwise & is SIGNED — a pte-page address with bit 31 set would go
    // negative after masking, pass the upper-bound-only check, and blow up as
    // a DataView RangeError that escapes the dl imports' UserFault-only catch
    // (Codex review on #186). Normalized, it's a huge POSITIVE offset that the
    // bounds check turns into a clean UserFault on this small test buffer.
    const { dv } = makeMemory();
    dv.setUint32(PT_BASE + 2 * 4, 0x80002000, true);
    expect(() => translateUser(dv, PT_BASE, 0x00801234)).toThrow(UserFault);
  });

  test("negative (i32-signed) ptBase is normalized, not treated as identity or crash", () => {
    // ptBase crosses a host import as an i32: above 2 GiB it arrives negative.
    // -0x80000000 >>> 0 = 0x80000000 — out of this buffer, so the pgd read
    // must be a clean bounds UserFault (and NOT the identity fast path, which
    // a signed-truthiness bug could never hit anyway, nor a RangeError).
    const { dv } = makeMemory();
    expect(() => translateUser(dv, -0x80000000, 0x00801234)).toThrow(UserFault);
  });
});

describe("readUser / writeUser", () => {
  test("gathers a page-crossing read from non-adjacent physical pages", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    // Last 4 bytes of the 0x3000 page + first 4 of the 0x5000 page.
    u8.set([1, 2, 3, 4], 0x3ffc);
    u8.set([5, 6, 7, 8], 0x5000);
    const got = readUser(buffer, PT_BASE, 0x00801ffc, 8);
    expect([...got]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("scatters a page-crossing write, and it lands physically", () => {
    const { buffer } = makeMemory();
    writeUser(buffer, PT_BASE, 0x00801ffe, new Uint8Array([9, 8, 7, 6]));
    const u8 = new Uint8Array(buffer);
    expect([...u8.subarray(0x3ffe, 0x4000)]).toEqual([9, 8]);
    expect([...u8.subarray(0x5000, 0x5002)]).toEqual([7, 6]);
  });

  test("write spanning into a read-only page faults (partial-write guard)", () => {
    const { buffer } = makeMemory();
    expect(() => writeUser(buffer, PT_BASE, 0x00802ffe, new Uint8Array([1, 2, 3, 4]))).toThrow(
      UserFault,
    );
  });

  test("identity read is a live view; identity write is direct (NOMMU behavior)", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    u8[0x123] = 42;
    const view = readUser(buffer, 0, 0x120, 8);
    expect(view[3]).toBe(42);
    u8[0x123] = 43; // subarray = live view, exactly like the raw reads this replaces
    expect(view[3]).toBe(43);
    writeUser(buffer, 0, 0x200, new Uint8Array([7]));
    expect(u8[0x200]).toBe(7);
  });
});

describe("readUserCString", () => {
  test("reads a translated string across a page boundary", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    const s = "wf_on_buf_changed";
    // Place it straddling the 0x3000-page -> 0x5000-page boundary (va 0x00801ffa..).
    const bytes = new TextEncoder().encode(s + "\0");
    // first 6 bytes at end of page one, rest at start of page two
    u8.set(bytes.subarray(0, 6), 0x3ffa);
    u8.set(bytes.subarray(6), 0x5000);
    expect(readUserCString(buffer, PT_BASE, 0x00801ffa)).toBe(s);
  });

  test("identity path matches the raw scan", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    u8.set(new TextEncoder().encode("hello\0"), 0x40);
    expect(readUserCString(buffer, 0, 0x40)).toBe("hello");
  });

  test("unterminated string is bounded by max, not runaway", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    u8.fill(0x41, 0x3000, 0x4000); // 'A' across the whole page, no NUL
    const got = readUserCString(buffer, PT_BASE, 0x00801000, 64);
    expect(got.length).toBe(64);
  });

  test("scan that walks into a non-present page faults instead of fabricating", () => {
    const { buffer } = makeMemory();
    const u8 = new Uint8Array(buffer);
    u8.fill(0x42, 0x6000, 0x7000); // RO page: readable, all 'B', no NUL
    // va 0x00803xxx is the last present page; 0x00804000 is not present.
    expect(() => readUserCString(buffer, PT_BASE, 0x00803ff0)).toThrow(UserFault);
  });
});
