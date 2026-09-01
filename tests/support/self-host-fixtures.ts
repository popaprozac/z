import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type SelfHostDifferentialCase = {
  readonly entry: string;
  readonly arguments?: readonly string[];
  readonly expectedStatus?: number;
  readonly expectedStdout?: string;
};

export const selfHostExecutableDifferentialCorpus: readonly SelfHostDifferentialCase[] = [
  { entry: "tests/fixtures/match-wildcard.zs" },
  {
    entry: "examples/language/collections/map-identities.zs",
    expectedStdout: "open: Draft\nfound: Draft\nclosed Draft\n",
  },
  { entry: "tests/fixtures/self-host-emit-class-field-order.zs" },
  { entry: "tests/fixtures/self-host-emit-fixed-array.zs" },
  {
    entry: "tests/fixtures/self-host-emit-fixed-array-owned.zs",
    expectedStatus: 0,
    expectedStdout: "drop 1\ndrop 2\ndrop 1\n",
  },
  { entry: "tests/fixtures/self-host-emit-fixed-array-modules/main.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-struct.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-struct-modules/main.zs" },
  { entry: "tests/fixtures/self-host-emit-class-constructor.zs" },
  {
    entry: "tests/fixtures/self-host-emit-generic-class.zs",
    expectedStdout: "drop 2\ndrop 1\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-generic-class-modules/main.zs",
    expectedStdout: "private drop 7\nmodule drop 3\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-weak.zs",
    expectedStdout: "released session 42\nreleased controller 9\nreleased session 7\n",
  },
  { entry: "tests/fixtures/self-host-emit-forward-weak.zs" },
  {
    entry: "tests/fixtures/self-host-emit-generic-weak.zs",
    expectedStdout: "released cell 1\nreleased cell 2\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-generic-weak-modules/main.zs",
    expectedStdout: "released module cell 1\nreleased module cell 2\n",
  },
  { entry: "tests/fixtures/self-host-emit-generic-defaults.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-defaults-modules/main.zs" },
  {
    entry: "tests/fixtures/self-host-emit-generic-deinit.zs",
    expectedStdout: "drop 2\ndrop 1\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-generic-deinit-modules/main.zs",
    expectedStdout: "module drop 3\n",
  },
  { entry: "tests/fixtures/self-host-emit-generic-methods.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-methods-modules/main.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-functions.zs" },
  { entry: "tests/fixtures/self-host-emit-generic-functions-modules/main.zs" },
  { entry: "tests/fixtures/self-host-emit-static-method.zs" },
  { entry: "tests/fixtures/self-host-emit-static-trait.zs" },
  {
    entry: "tests/fixtures/self-host-emit-static-trait-modules/main.zs",
    expectedStdout: "released owned\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-static-trait-method-modules/main.zs",
    expectedStdout: "released private\n",
  },
  { entry: "tests/fixtures/self-host-emit-array-destructure.zs" },
  { entry: "tests/fixtures/self-host-emit-slice-signature.zs" },
  { entry: "tests/fixtures/self-host-emit-input.zs" },
  { entry: "tests/fixtures/self-host-emit-control-flow.zs" },
  { entry: "tests/fixtures/self-host-emit-callables.zs" },
  { entry: "tests/fixtures/self-host-emit-try-closure-owned-match.zs" },
  { entry: "tests/fixtures/self-host-emit-readonly-method-capture.zs" },
  { entry: "tests/fixtures/self-host-emit-arena.zs" },
  { entry: "tests/fixtures/self-host-emit-arena-graph.zs" },
  { entry: "tests/fixtures/self-host-emit-arena-owner-bundle.zs" },
  { entry: "tests/fixtures/self-host-emit-arena-set.zs" },
  { entry: "tests/fixtures/self-host-emit-map.zs" },
  { entry: "tests/fixtures/self-host-emit-custom-map-key.zs" },
  { entry: "tests/fixtures/self-host-emit-custom-set-key.zs" },
  { entry: "tests/fixtures/self-host-emit-set.zs" },
  { entry: "tests/fixtures/self-host-emit-option.zs" },
  { entry: "tests/fixtures/self-host-emit-module-enum-constructor.zs" },
  { entry: "tests/fixtures/self-host-emit-optional-field-direct.zs" },
  { entry: "tests/fixtures/self-host-emit-optional-chain.zs" },
  { entry: "tests/fixtures/self-host-emit-owned-object-destructure.zs" },
  { entry: "tests/fixtures/self-host-emit-parameter-scope.zs" },
  { entry: "tests/fixtures/self-host-emit-struct-spread.zs" },
  { entry: "tests/fixtures/self-host-emit-result.zs" },
  { entry: "tests/fixtures/self-host-emit-throwing-method.zs" },
  { entry: "tests/fixtures/self-host-emit-mutex-field.zs" },
  { entry: "tests/fixtures/self-host-emit-thread-task.zs" },
  { entry: "tests/fixtures/self-host-emit-thread-owned-capture-consume.zs" },
  { entry: "tests/fixtures/self-host-emit-thread-shared-capture.zs" },
  { entry: "tests/fixtures/self-host-differential-thread-owned.zs" },
  {
    entry: "tests/fixtures/self-host-emit-async-callable-task-cancel.zs",
    expectedStdout: "released 42\n",
  },
  {
    entry: "tests/fixtures/self-host-emit-async-callable-task-join.zs",
    expectedStdout: "released 41\n",
  },
  { entry: "tests/fixtures/self-host-callable-collision/main.zs" },
  { entry: "examples/applications/message-router/main.zs" },
  { entry: "examples/applications/source-inspector/lexer-smoke.zs" },
  {
    entry: "examples/applications/source-inspector/main.zs",
    arguments: [resolve(
      import.meta.dir,
      "../..",
      "examples/applications/source-inspector/lexer-smoke.zs",
    )],
  },
];

export type SelfHostEmitFixtureClassification =
  | { readonly kind: "differential" }
  | { readonly kind: "focused-positive" }
  | { readonly kind: "focused-negative" }
  | { readonly kind: "excluded"; readonly reason: string };

const differential = { kind: "differential" } as const;
const focusedPositive = { kind: "focused-positive" } as const;
const focusedNegative = { kind: "focused-negative" } as const;

// Keep this catalog explicit and fail-closed. Adding a top-level
// self-host-emit-*.zs fixture requires choosing whether it belongs in the
// executable differential corpus, a focused positive/negative test, or a
// deliberate exclusion with a reviewable reason.
export const selfHostEmitFixtureClassifications: Readonly<
  Record<string, SelfHostEmitFixtureClassification>
> = {
  "self-host-emit-borrowed-task-control-cancel.zs": focusedPositive,
  "self-host-emit-class-field-order.zs": differential,
  "self-host-emit-class-constructor.zs": differential,
  "self-host-emit-fixed-array.zs": differential,
  "self-host-emit-fixed-array-owned.zs": differential,
  "self-host-emit-generic-struct.zs": differential,
  "self-host-emit-generic-class.zs": differential,
  "self-host-emit-weak.zs": differential,
  "self-host-emit-forward-weak.zs": differential,
  "self-host-emit-generic-weak.zs": differential,
  "self-host-emit-generic-defaults.zs": differential,
  "self-host-emit-generic-deinit.zs": differential,
  "self-host-emit-generic-methods.zs": differential,
  "self-host-emit-generic-functions.zs": differential,
  "self-host-emit-static-method.zs": differential,
  "self-host-emit-static-trait.zs": differential,
  "self-host-emit-array-destructure.zs": differential,
  "self-host-emit-slice-signature.zs": differential,
  "self-host-emit-arena.zs": differential,
  "self-host-emit-arena-graph.zs": differential,
  "self-host-emit-arena-owner-bundle.zs": differential,
  "self-host-emit-arena-set.zs": differential,
  "self-host-emit-cleanup-flow.zs": focusedPositive,
  "self-host-emit-cleanup.zs": focusedPositive,
  "self-host-emit-callables.zs": differential,
  "self-host-emit-try-closure-owned-match.zs": differential,
  "self-host-emit-readonly-method-capture.zs": differential,
  "self-host-emit-control-flow.zs": differential,
  "self-host-emit-custom-map-key.zs": differential,
  "self-host-emit-custom-set-key.zs": differential,
  "self-host-emit-enum.zs": focusedPositive,
  "self-host-emit-input.zs": differential,
  "self-host-emit-local-cleanup.zs": focusedPositive,
  "self-host-emit-map.zs": differential,
  "self-host-emit-match-try.zs": focusedPositive,
  "self-host-emit-move.zs": focusedPositive,
  "self-host-emit-mutex-field.zs": differential,
  "self-host-emit-nested-value-match.zs": focusedPositive,
  "self-host-emit-option.zs": differential,
  "self-host-emit-module-enum-constructor.zs": differential,
  "self-host-emit-optional-chain.zs": differential,
  "self-host-emit-optional-field-direct.zs": differential,
  "self-host-emit-owned-enum.zs": focusedPositive,
  "self-host-emit-owned-object-destructure.zs": differential,
  "self-host-emit-parameter-scope.zs": differential,
  "self-host-emit-payload-enum.zs": focusedPositive,
  "self-host-emit-result.zs": differential,
  "self-host-emit-set.zs": differential,
  "self-host-emit-struct-spread.zs": differential,
  "self-host-emit-struct.zs": focusedPositive,
  "self-host-emit-throwing-method.zs": differential,
  "self-host-emit-thread-affine-capture-invalid.zs": focusedNegative,
  "self-host-emit-thread-affine-result-invalid.zs": focusedNegative,
  "self-host-emit-generic-thread-any-callable.zs": focusedPositive,
  "self-host-emit-async-callable-layout.zs": focusedPositive,
  "self-host-emit-async-callable.zs": focusedPositive,
  "self-host-emit-async-callable-owned-result.zs": focusedPositive,
  "self-host-emit-async-method-yield.zs": focusedPositive,
  "self-host-emit-async-method-throws.zs": focusedPositive,
  "self-host-emit-async-method-main-placement.zs": focusedPositive,
  "self-host-emit-async-function-main-placement.zs": focusedPositive,
  "self-host-emit-async-function-main-placement-local.zs": focusedPositive,
  "self-host-emit-async-function-main-placement-local-throws.zs": focusedPositive,
  "self-host-emit-async-function-main-placement-structured-invalid.zs": focusedNegative,
  "self-host-emit-async-prefixed-tail-method.zs": focusedPositive,
  "self-host-emit-async-branch-tail-method.zs": focusedPositive,
  "self-host-emit-async-match-tail-method.zs": focusedPositive,
  "self-host-emit-async-match-tail-function.zs": focusedPositive,
  "self-host-emit-async-linear-method.zs": focusedPositive,
  "self-host-emit-async-captured-method.zs": focusedPositive,
  "self-host-emit-async-double-await.zs": focusedPositive,
  "self-host-emit-async-service-main-publication.zs": focusedPositive,
  "self-host-emit-async-service-composition.zs": focusedPositive,
  "self-host-emit-async-service-owned-error.zs": focusedPositive,
  "self-host-emit-async-owned-closure-parameter.zs": focusedPositive,
  "self-host-emit-async-tail-callable.zs": focusedPositive,
  "self-host-emit-async-tail-method.zs": focusedPositive,
  "self-host-emit-async-struct-method-invalid.zs": focusedNegative,
  "self-host-emit-async-callable-yield.zs": focusedPositive,
  "self-host-emit-async-callable-parent-local.zs": focusedPositive,
  "self-host-emit-async-callable-parent-owned-local.zs": focusedPositive,
  "self-host-emit-async-callable-task-cancel.zs": differential,
  "self-host-emit-async-callable-task-join.zs": differential,
  "self-host-emit-task-scope-owned-capture.zs": focusedPositive,
  "self-host-emit-task-scope-field.zs": focusedPositive,
  "self-host-emit-task-scope-delay-method.zs": focusedPositive,
  "self-host-emit-thread-any-callable.zs": focusedPositive,
  "self-host-emit-thread-main-callable.zs": focusedPositive,
  "self-host-emit-thread-cancel-main-match.zs": focusedPositive,
  "self-host-emit-thread-cancel-main-while.zs": focusedPositive,
  "self-host-emit-thread-cancel-main.zs": focusedPositive,
  "self-host-emit-thread-cancel.zs": focusedPositive,
  "self-host-emit-thread-capture-result.zs": focusedPositive,
  "self-host-emit-thread-custom-deinit-capture-invalid.zs": focusedNegative,
  "self-host-emit-thread-error.zs": focusedPositive,
  "self-host-emit-thread-main-control-flow-suspension-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-error.zs": focusedPositive,
  "self-host-emit-thread-main-if-owned.zs": focusedPositive,
  "self-host-emit-thread-main-if.zs": focusedPositive,
  "self-host-emit-thread-main-locals.zs": focusedPositive,
  "self-host-emit-thread-main-match-computed-constructor.zs": focusedPositive,
  "self-host-emit-thread-main-match-computed-payload.zs": focusedPositive,
  "self-host-emit-thread-main-match-owned-error.zs": focusedPositive,
  "self-host-emit-thread-main-match-owned-payload.zs": focusedPositive,
  "self-host-emit-thread-main-match-owned.zs": focusedPositive,
  "self-host-emit-thread-main-match-payload-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-match-payload.zs": focusedPositive,
  "self-host-emit-thread-main-match.zs": focusedPositive,
  "self-host-emit-thread-main-nested-if-suspension-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-nontail-suspension-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-owned-local.zs": focusedPositive,
  "self-host-emit-thread-main-owned.zs": focusedPositive,
  "self-host-emit-thread-main-result.zs": focusedPositive,
  "self-host-emit-thread-main-segments.zs": focusedPositive,
  "self-host-emit-thread-main-synchronous.zs": focusedPositive,
  "self-host-emit-thread-main-uninitialized-local-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-inherited-async.zs": focusedPositive,
  "self-host-emit-thread-main-while-control-invalid.zs": focusedNegative,
  "self-host-emit-thread-main-while-control.zs": focusedPositive,
  "self-host-emit-thread-main-while-owned.zs": focusedPositive,
  "self-host-emit-thread-main-while-return.zs": focusedPositive,
  "self-host-emit-thread-main-while-throw.zs": focusedPositive,
  "self-host-emit-thread-main-while-try.zs": focusedPositive,
  "self-host-emit-thread-main-while.zs": focusedPositive,
  "self-host-emit-thread-nested-try-await-failure.zs": focusedPositive,
  "self-host-emit-thread-nested-try-await.zs": focusedPositive,
  "self-host-emit-thread-owned-capture-consume.zs": differential,
  "self-host-emit-thread-owned-capture.zs": focusedPositive,
  "self-host-emit-thread-owned-error.zs": focusedPositive,
  "self-host-emit-thread-owned-local.zs": focusedPositive,
  "self-host-emit-thread-owned-result.zs": focusedPositive,
  "self-host-emit-thread-shared-capture.zs": differential,
  "self-host-emit-thread-shared-removal-invalid.zs": focusedNegative,
  "self-host-emit-thread-task.zs": differential,
  "self-host-emit-thread-try-await-positions.zs": focusedPositive,
  "self-host-emit-thread-try-await.zs": focusedPositive,
  "self-host-emit-thread-unshareable-capture-invalid.zs": focusedNegative,
};

export class SelfHostFixtureCoverageError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`self-host fixture coverage is invalid:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "SelfHostFixtureCoverageError";
  }
}

function directFixtureName(entry: string): string | undefined {
  const prefix = "tests/fixtures/";
  if (!entry.startsWith(prefix)) return undefined;
  const name = entry.slice(prefix.length);
  if (name.includes("/") || !name.startsWith("self-host-emit-") || !name.endsWith(".zs")) {
    return undefined;
  }
  return name;
}

export function verifySelfHostEmitFixtureCoverage(
  fixturesDirectory = resolve(import.meta.dir, "..", "fixtures"),
  selfHostingTestFile = resolve(import.meta.dir, "..", "self-hosting.test.ts"),
  classifications: Readonly<Record<string, SelfHostEmitFixtureClassification>> = selfHostEmitFixtureClassifications,
  corpus: readonly SelfHostDifferentialCase[] = selfHostExecutableDifferentialCorpus,
): void {
  const discovered = readdirSync(fixturesDirectory, { withFileTypes: true })
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith("self-host-emit-")
      && entry.name.endsWith(".zs")
    ))
    .map((entry) => entry.name)
    .sort();
  const discoveredSet = new Set(discovered);
  const classified = Object.keys(classifications).sort();
  const classifiedSet = new Set(classified);
  const testSource = readFileSync(selfHostingTestFile, "utf8");
  const differentialFixtures = new Set(
    corpus.map((entry) => directFixtureName(entry.entry)).filter((name): name is string => name !== undefined),
  );
  const problems: string[] = [];

  for (const name of discovered) {
    if (!classifiedSet.has(name)) problems.push(`missing classification: ${name}`);
  }
  for (const name of classified) {
    if (!discoveredSet.has(name)) problems.push(`classification lists a missing fixture: ${name}`);
  }
  for (const [name, classification] of Object.entries(classifications)) {
    if (classification.kind === "differential" && !differentialFixtures.has(name)) {
      problems.push(`differential fixture is absent from executable corpus: ${name}`);
    }
    if (classification.kind !== "differential" && differentialFixtures.has(name)) {
      problems.push(`executable corpus fixture is classified ${classification.kind}: ${name}`);
    }
    if (classification.kind === "excluded" && classification.reason.trim().length === 0) {
      problems.push(`excluded fixture has no reason: ${name}`);
    }
    if (
      (classification.kind === "focused-positive" || classification.kind === "focused-negative")
      && !testSource.includes(name)
    ) {
      problems.push(`focused fixture is not named by self-hosting tests: ${name}`);
    }
  }

  for (const name of differentialFixtures) {
    if (!discoveredSet.has(name)) {
      problems.push(`executable corpus lists a missing fixture: ${name}`);
    } else if (classifications[name]?.kind !== "differential") {
      problems.push(`executable corpus fixture lacks differential classification: ${name}`);
    }
  }

  if (problems.length > 0) throw new SelfHostFixtureCoverageError(problems);
}
