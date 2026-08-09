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
import {
  SelfHostFixtureCoverageError,
  selfHostEmitFixtureClassifications,
  verifySelfHostEmitFixtureCoverage,
  type SelfHostDifferentialCase,
  type SelfHostEmitFixtureClassification,
} from "./support/self-host-fixtures.ts";

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

test("classifies every direct native-emitter fixture", () => {
  expect(() => verifySelfHostEmitFixtureCoverage()).not.toThrow();
  expect(Object.keys(selfHostEmitFixtureClassifications).length).toBeGreaterThan(0);
});

test("reports unclassified, stale, untested, and mismatched native-emitter fixtures", () => {
  const directory = fixture([
    "self-host-emit-differential.zs",
    "self-host-emit-focused.zs",
    "self-host-emit-unclassified.zs",
  ]);
  const selfHostingTest = resolve(directory.root, "self-hosting.test.ts");
  writeFileSync(selfHostingTest, "self-host-emit-something-else.zs\n");
  const classifications: Readonly<Record<string, SelfHostEmitFixtureClassification>> = {
    "self-host-emit-differential.zs": { kind: "focused-positive" },
    "self-host-emit-focused.zs": { kind: "focused-negative" },
    "self-host-emit-stale.zs": { kind: "excluded", reason: "" },
  };
  const corpus: readonly SelfHostDifferentialCase[] = [
    { entry: "tests/fixtures/self-host-emit-differential.zs" },
    { entry: "tests/fixtures/self-host-emit-missing.zs" },
  ];
  try {
    expect(() => verifySelfHostEmitFixtureCoverage(
      directory.tests,
      selfHostingTest,
      classifications,
      corpus,
    )).toThrow(SelfHostFixtureCoverageError);
    try {
      verifySelfHostEmitFixtureCoverage(
        directory.tests,
        selfHostingTest,
        classifications,
        corpus,
      );
    } catch (error) {
      const message = String(error);
      expect(message).toContain("missing classification: self-host-emit-unclassified.zs");
      expect(message).toContain("classification lists a missing fixture: self-host-emit-stale.zs");
      expect(message).toContain("executable corpus fixture is classified focused-positive: self-host-emit-differential.zs");
      expect(message).toContain("focused fixture is not named by self-hosting tests: self-host-emit-focused.zs");
      expect(message).toContain("excluded fixture has no reason: self-host-emit-stale.zs");
      expect(message).toContain("executable corpus lists a missing fixture: self-host-emit-missing.zs");
    }
  } finally {
    rmSync(directory.root, { recursive: true, force: true });
  }
});
