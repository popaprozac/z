import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  selfHostEmitFixtureClassifications,
  verifySelfHostEmitFixtureCoverage,
} from "../tests/support/self-host-fixtures.ts";

export type TestTier = {
  readonly timeoutMilliseconds: number;
  readonly files: readonly string[];
};

export const testTiers: Readonly<Record<string, TestTier>> = {
  language: {
    timeoutMilliseconds: 60_000,
    files: [
      "tests/language-core.test.ts",
      "tests/numeric-literals.test.ts",
      "tests/float-bits.test.ts",
      "tests/integer-bits.test.ts",
      "tests/wrapping-shift.test.ts",
      "tests/reference-identity.test.ts",
      "tests/callback-nonescape.test.ts",
      "tests/module-constants.test.ts",
      "tests/stdlib-sync.test.ts",
      "tests/stdlib-memory.test.ts",
      "tests/stdlib-collections.test.ts",
      "tests/stdlib-json.test.ts",
      "tests/generators-errors.test.ts",
      "tests/testing.test.ts",
      "tests/documentation.test.ts",
      "tests/editor-integration.test.ts",
      "tests/optional-chaining.test.ts",
      "tests/optional-chaining-dx.test.ts",
      "tests/optional-fields.test.ts",
      "tests/struct-spread.test.ts",
      "tests/struct-spread-dx.test.ts",
      "tests/program-metadata.test.ts",
      "tests/test-tiers.test.ts",
    ],
  },
  "native-interop": {
    timeoutMilliseconds: 60_000,
    files: [
      "tests/native-interop.test.ts",
      "tests/c-export-bytes.test.ts",
      "tests/project-commands.test.ts",
    ],
  },
  "objc-interop": {
    timeoutMilliseconds: 60_000,
    files: ["tests/objc-interop.test.ts", "tests/objc-object.test.ts", "tests/objc-instanceof-guards.test.ts", "tests/objc-subclasses.test.ts", "tests/objc-subclass-state.test.ts", "tests/objc-subclass-handoff.test.ts", "tests/objc-subclass-async.test.ts", "tests/objc-header-composition.test.ts", "tests/objc-callable-aliases.test.ts", "tests/objc-selector-contracts.test.ts", "tests/objc-selector-entries.test.ts", "tests/objc-selector-execution.test.ts", "tests/objc-adapter-lifetime.test.ts", "tests/objc-string-lifetime.test.ts", "tests/native-async-objc-storage.test.ts"],
  },
  "swift-interop": {
    timeoutMilliseconds: 60_000,
    files: ["tests/swift-interop.test.ts"],
  },
  "self-hosting": {
    timeoutMilliseconds: 120_000,
    files: ["tests/self-hosting.test.ts", "tests/native-view-loans.test.ts", "tests/native-channel.test.ts", "tests/native-closure-cleanup.test.ts", "tests/native-weak-temporaries.test.ts", "tests/native-out-cleanup.test.ts", "tests/native-destructure-cleanup.test.ts", "tests/native-async-yield.test.ts", "tests/native-async-yield-child.test.ts", "tests/native-async-yield-match.test.ts", "tests/native-main-timer-completion.test.ts", "tests/native-async-linear-tail.test.ts", "tests/native-worker-yield.test.ts", "tests/native-symbol-hygiene.test.ts"],
  },
  async: {
    timeoutMilliseconds: 60_000,
    files: [
      "tests/async-expressions.test.ts",
      "tests/async-runtime.test.ts",
      "tests/stdlib-channel.test.ts",
    ],
  },
};

export class TestTierCoverageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`test tier coverage is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "TestTierCoverageError";
  }
}

export function verifyTestTierCoverage(
  testsDirectory = resolve(import.meta.dir, "..", "tests"),
  tiers: Readonly<Record<string, TestTier>> = testTiers,
): void {
  const discovered = readdirSync(testsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => `tests/${entry.name}`)
    .sort();
  const discoveredSet = new Set(discovered);
  const assignments = new Map<string, string[]>();
  for (const [tier, definition] of Object.entries(tiers)) {
    for (const file of definition.files) {
      assignments.set(file, [...(assignments.get(file) ?? []), tier]);
    }
  }

  const missing = discovered.filter((file) => !assignments.has(file));
  const duplicates = discovered
    .map((file) => ({ file, tiers: assignments.get(file) ?? [] }))
    .filter((entry) => entry.tiers.length > 1);
  const stale = [...assignments.keys()]
    .filter((file) => !discoveredSet.has(file))
    .sort();
  const problems = [
    ...missing.map((file) => `missing tier assignment: ${file}`),
    ...duplicates.map((entry) => (
      `duplicate tier assignment: ${entry.file} (${entry.tiers.join(", ")})`
    )),
    ...stale.map((file) => `tier lists a missing test file: ${file}`),
  ];
  if (problems.length > 0) throw new TestTierCoverageError(problems);
}

function runTier(name: string): never {
  const tier = testTiers[name];
  if (!tier) {
    console.error(`unknown test tier ${JSON.stringify(name)}; expected one of ${Object.keys(testTiers).join(", ")}`);
    process.exit(2);
  }
  verifyTestTierCoverage();
  verifySelfHostEmitFixtureCoverage();
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      "--no-orphans",
      "--timeout",
      String(tier.timeoutMilliseconds),
      ...tier.files,
    ],
    cwd: resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      Z_BUN_TEST_TIMEOUT_MS: String(tier.timeoutMilliseconds),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(result.exitCode);
}

if (import.meta.main) {
  const [command, tier] = process.argv.slice(2);
  if (command === "verify") {
    verifyTestTierCoverage();
    verifySelfHostEmitFixtureCoverage();
    console.log(`test tier coverage: ${Object.keys(testTiers).length} tiers, all top-level test files assigned exactly once`);
    console.log(`self-host fixture coverage: ${Object.keys(selfHostEmitFixtureClassifications).length} direct emitter fixtures classified`);
  } else if (command === "run" && tier) {
    runTier(tier);
  } else {
    console.error("usage: bun scripts/test-tiers.ts verify | run <tier>");
    process.exit(2);
  }
}
