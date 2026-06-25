import { test, expect } from "bun:test";
import { ENGINE_ABI } from "./index.js";
import { ENGINE_ABI as DIRECT } from "./abi.js";

test("ENGINE_ABI is a positive integer, exported from index and abi", () => {
  expect(Number.isInteger(ENGINE_ABI)).toBe(true);
  expect(ENGINE_ABI).toBeGreaterThanOrEqual(1);
  expect(DIRECT).toBe(ENGINE_ABI);
});
