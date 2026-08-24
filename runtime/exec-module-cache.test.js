import { describe, expect, test } from "bun:test";
import {
  EXEC_MODULE_CACHE_MIN_BYTES,
  EXEC_MODULE_FORCE_HELPER_MIN_BYTES,
  shouldCacheExecModule,
  shouldForceHelperExecModule,
} from "./exec-module-cache.js";

describe("software-MMU exec module cache admission", () => {
  test("rejects one-shot configure-sized modules", () => {
    expect(shouldCacheExecModule(0)).toBe(false);
    expect(shouldCacheExecModule(EXEC_MODULE_CACHE_MIN_BYTES - 1)).toBe(false);
  });

  test("keeps expensive shared executables", () => {
    expect(shouldCacheExecModule(EXEC_MODULE_CACHE_MIN_BYTES)).toBe(true);
    expect(shouldCacheExecModule(57 * 1024 * 1024)).toBe(true);
  });

  test("rejects invalid lengths", () => {
    expect(shouldCacheExecModule(-1)).toBe(false);
    expect(shouldCacheExecModule(Number.NaN)).toBe(false);
    expect(shouldCacheExecModule(1.5)).toBe(false);
  });

  test("forces memory-bounded translation only for very large executables", () => {
    expect(shouldForceHelperExecModule(EXEC_MODULE_FORCE_HELPER_MIN_BYTES - 1)).toBe(false);
    expect(shouldForceHelperExecModule(EXEC_MODULE_FORCE_HELPER_MIN_BYTES)).toBe(true);
    expect(shouldForceHelperExecModule(57 * 1024 * 1024)).toBe(true);
  });
});
