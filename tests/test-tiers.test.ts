import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "bun:test";
import {
  TestTierCoverageError,
  verifyTestTierCoverage,
  type TestTier,
} from "../scripts/test-tiers.ts";

function fixture(files: readonly string[]): { readonly root: string; readonly tests: string } {
  const root = mkdtempSync("/tmp/z-test-tiers-");
  const tests = resolve(root, "tests");
  mkdirSync(tests);
  for (const file of files) writeFileSync(resolve(tests, file), "");
  return { root, tests };
}

function tiers(assignments: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, TestTier>> {
  return Object.fromEntries(Object.entries(assignments).map(([name, files]) => [
    name,
    { timeoutMilliseconds: 1_000, files },
  ]));
}

test("accepts exactly one tier assignment for every top-level test", () => {
  const directory = fixture(["alpha.test.ts", "beta.test.ts"]);
  try {
    expect(() => verifyTestTierCoverage(directory.tests, tiers({
      language: ["tests/alpha.test.ts"],
      async: ["tests/beta.test.ts"],
    }))).not.toThrow();
  } finally {
    rmSync(directory.root, { recursive: true, force: true });
  }
});

test("reports missing, duplicate, and stale tier entries by file name", () => {
  const directory = fixture(["missing.test.ts", "duplicate.test.ts"]);
  try {
    expect(() => verifyTestTierCoverage(directory.tests, tiers({
      language: ["tests/duplicate.test.ts", "tests/stale.test.ts"],
      async: ["tests/duplicate.test.ts"],
    }))).toThrow(TestTierCoverageError);
    try {
      verifyTestTierCoverage(directory.tests, tiers({
        language: ["tests/duplicate.test.ts", "tests/stale.test.ts"],
        async: ["tests/duplicate.test.ts"],
      }));
    } catch (error) {
      const message = String(error);
      expect(message).toContain("missing tier assignment: tests/missing.test.ts");
      expect(message).toContain("duplicate tier assignment: tests/duplicate.test.ts (language, async)");
      expect(message).toContain("tier lists a missing test file: tests/stale.test.ts");
    }
  } finally {
    rmSync(directory.root, { recursive: true, force: true });
  }
});
