import {
  analyzeSource,
  assert,
  cli,
  compileTestsToNative,
  compileToNative,
  completions,
  decodeSemanticTokens,
  diagnostics,
  hover,
  hostToolchainTest,
  mkdtempSync,
  readFileSync,
  resolve,
  semanticTokens,
  semanticTokenTypes,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("parses top-level tests as hidden void functions", () => {
  const fileName = "/tmp/z-test-syntax.zs";
  const source = `
    function add(left: i32, right: i32): i32 {
      return left + right;
    }

    test "add combines values" {
      const answer = add(20, 22);
    }
  `;
  const analysis = analyzeSource(source, fileName, { requireMain: false });
  const declaration = analysis.sourceProgram.functions.find(
    (candidate) => candidate.testName === "add combines values",
  );
  assert.equal(declaration?.name.startsWith("__z_test_"), true);
  assert.equal(declaration?.parameters.length, 0);
  assert.equal(declaration?.returnType.name, "void");
  assert.equal(declaration?.body.length, 1);
});

test("ordinary native builds omit test declarations completely", () => {
  const fileName = "/tmp/z-test-omission.zs";
  const source = `
    function helper(): i32 {
      return 42;
    }

    test "hidden from production" {
      const observed = helper();
    }

    function main(): i32 {
      return helper() - 42;
    }
  `;
  const artifact = compileToNative(source, fileName);
  assert.doesNotMatch(artifact.source, /__z_test_/);
  assert.doesNotMatch(artifact.source, /hidden from production/);
  assert.doesNotMatch(artifact.source, /running 1 test/);
});

test("ordinary builds also erase imported test helpers", () => {
  const fileName = "/tmp/z-test-helper-omission.zs";
  const source = `
    import { expect, fail } from "std/test";

    test "hidden expectation" {
      expect(42).toEqual(42);
      fail("also hidden");
    }

    function main(): i32 {
      return 0;
    }
  `;
  const artifact = compileToNative(source, fileName);
  assert.doesNotMatch(artifact.source, /__z_test_/);
  assert.doesNotMatch(artifact.source, /hidden expectation|also hidden/);
  assert.doesNotMatch(artifact.source, /Z_Result_void_String/);
});

test("test compilation emits a runner and ignores an ordinary main", () => {
  const fileName = "/tmp/z-test-runner.zs";
  const source = `
    function main(): i32 {
      return 1;
    }

    test "first" {
      return;
    }

    test "quotes: \\" and unicode: λ" {
      const value = 42;
    }
  `;
  const artifact = compileTestsToNative(source, fileName);
  assert.deepEqual(artifact.testNames, ["first", 'quotes: " and unicode: λ']);
  assert.match(artifact.source, /running 2 tests/);
  assert.match(artifact.source, /test result: %s\. %llu passed; %llu failed/);
  assert.equal((artifact.source.match(/int main\(int argc, char \*\*argv\)/g) ?? []).length, 1);
  assert.doesNotMatch(artifact.source, /return 1;/);
});

test("reports malformed and duplicate test declarations", () => {
  const duplicate = `
    test "same name" {}
    test "same name" {}
  `;
  assert.match(
    diagnostics(duplicate, "/tmp/z-duplicate-tests.zs")[0]?.message ?? "",
    /duplicate test name "same name"/,
  );
  assert.match(
    diagnostics('test "" {}', "/tmp/z-empty-test.zs")[0]?.message ?? "",
    /test name cannot be empty/,
  );
  assert.match(
    diagnostics('export test "not public" {}', "/tmp/z-exported-test.zs")[0]?.message ?? "",
    /tests cannot be exported/,
  );
  assert.match(
    diagnostics('async test "later" {}', "/tmp/z-async-test.zs")[0]?.message ?? "",
    /async tests are not implemented yet/,
  );
});

test("offers test as a source keyword completion", () => {
  const item = completions("te", "/tmp/z-test-completion.zs", 2)
    .find((candidate) => candidate.label === "test");
  assert.equal(item?.detail, "Z keyword");
});

test("completes and explains std/test expectations", () => {
  const fileName = "/tmp/z-test-editor.zs";
  const importSource = 'import { ex } from "std/test";';
  const importItems = completions(
    importSource,
    fileName,
    importSource.indexOf("ex") + 2,
  );
  assert.ok(importItems.some((item) => item.label === "expect"));

  const completionSource = `
    import { expect, fail } from "std/test";

    test "editor" {
      const answer = 42;
      expect(answer).toE
    }
  `;
  const matcherOffset = completionSource.indexOf("toE") + 3;
  const matcherItems = completions(completionSource, fileName, matcherOffset);
  assert.ok(matcherItems.some((item) => item.label === "toEqual"));

  const hoverSource = completionSource.replace("toE", "toEqual(42);");
  const expectOffset = hoverSource.indexOf("expect(answer)");
  const matcherHoverOffset = hoverSource.indexOf("toEqual");
  assert.match(
    hover(hoverSource, fileName, expectOffset)?.contents.value ?? "",
    /borrows for one expectation statement/,
  );
  assert.match(
    hover(hoverSource, fileName, matcherHoverOffset)?.contents.value ?? "",
    /uses Z `==`/,
  );

  const decoded = decodeSemanticTokens(semanticTokens(hoverSource, fileName).data);
  for (const [offset, type] of [
    [expectOffset, "function"],
    [matcherHoverOffset, "method"],
    [hoverSource.indexOf("fail }"), "function"],
  ] as const) {
    const beforeToken = hoverSource.slice(0, offset);
    const line = beforeToken.split("\n").length - 1;
    const character = offset - (beforeToken.lastIndexOf("\n") + 1);
    assert.ok(decoded.some((token) => (
      token.line === line
      && token.character === character
      && token.type === semanticTokenTypes.indexOf(type)
    )));
  }
});

test("accepts inferred and explicit immutable call-site borrows", () => {
  const fileName = "/tmp/z-explicit-in.zs";
  const source = `
    function byteCount(in value: String): usize {
      return value.byteLength;
    }

    function main(): i32 {
      const value = "answer";
      const inferred = byteCount(value);
      const explicit = byteCount(in value);
      return i32(inferred + explicit) - 12;
    }
  `;
  assert.deepEqual(diagnostics(source, fileName), []);
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /byteCount\(&\(value\)\)/);
  assert.doesNotMatch(artifact.source, /&\(&\(value\)\)/);
});

test("rejects an explicit immutable borrow for an owned parameter", () => {
  const source = `
    function consume(value: String): usize {
      return value.byteLength;
    }

    function main(): i32 {
      const value = "answer";
      return i32(consume(in value));
    }
  `;
  assert.match(
    diagnostics(source, "/tmp/z-wrong-explicit-in.zs")[0]?.message ?? "",
    /expects an owned value, not an explicit in borrow/,
  );
});

test("rejects malformed and misplaced std/test expectations", () => {
  const outside = `
    import { expect } from "std/test";

    function main(): i32 {
      expect(42).toEqual(42);
      return 0;
    }
  `;
  assert.match(
    diagnostics(outside, "/tmp/z-expect-outside-test.zs")[0]?.message ?? "",
    /only available inside a test declaration/,
  );

  const matcher = `
    import { expect } from "std/test";

    test "unknown matcher" {
      expect(42).toBe(42);
    }
  `;
  assert.match(
    diagnostics(matcher, "/tmp/z-expect-matcher.zs")[0]?.message ?? "",
    /expect has no matcher "toBe"/,
  );

  const temporary = `
    import { expect } from "std/test";

    function status(): String {
      return "ready";
    }

    test "owned temporary" {
      expect(status()).toEqual("ready");
    }
  `;
  assert.match(
    diagnostics(temporary, "/tmp/z-expect-temporary.zs")[0]?.message ?? "",
    /cleanup-bearing test temporary must be bound/,
  );

  const thrown = `
    test "throw is not the test API" {
      throw "failure";
    }
  `;
  assert.match(
    diagnostics(thrown, "/tmp/z-test-throw.zs")[0]?.message ?? "",
    /tests do not declare an ordinary throws channel/,
  );
});

test("runs deterministic cleanup before returning a test failure", () => {
  const source = `
    import { expect } from "std/test";

    struct Resource {
      id: i32;
      deinit {}
    }

    test "cleanup before failure" {
      const resource = Resource({ id: 41 });
      expect(resource.id).toEqual(42);
    }
  `;
  const artifact = compileTestsToNative(source, "/tmp/z-test-cleanup.zs");
  assert.match(
    artifact.source,
    /if \(!\(_z_test_actual_\d+ == _z_test_expected_\d+\)\) \{[\s\S]*if \(_z_live_resource_\d+\) Z_Resource_deinit\(&\(resource\)\);[\s\S]*return \(Z_Result_void_String\)\{ \.tag = Z_Result_void_String_failure/,
  );
});

hostToolchainTest("reports expectation failures and continues with later tests", () => {
  const directory = mkdtempSync("/tmp/z-test-expectation-");
  const input = resolve(directory, "expectation.test.zs");
  writeFileSync(input, `
    import { expect, fail } from "std/test";

    test "explicit and inferred borrows pass" {
      const answer = 42;
      expect(answer).toEqual(42);
      expect(in answer).toEqual(42);
    }

    test "a failed equality is reported" {
      expect(41).toEqual(42);
    }

    test "an explicit failure is reported" {
      fail("deliberate failure");
    }

    test "later tests still run" {
      expect("still running").toEqual("still running");
    }
  `);
  const result = spawnSync(process.execPath, [cli, "test", input], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /test explicit and inferred borrows pass \.\.\. ok/);
  assert.match(result.stdout, /test a failed equality is reported \.\.\. FAILED/);
  assert.match(result.stdout, /expected 41 to equal 42/);
  assert.match(result.stdout, /test an explicit failure is reported \.\.\. FAILED/);
  assert.match(result.stdout, /deliberate failure/);
  assert.match(result.stdout, /test later tests still run \.\.\. ok/);
  assert.match(result.stdout, /test result: FAILED\. 2 passed; 2 failed/);
}, 20_000);

hostToolchainTest("runs tests from an entry module and its project-owned imports", () => {
  const directory = mkdtempSync("/tmp/z-test-command-");
  const dependency = resolve(directory, "calculator.zs");
  const entry = resolve(directory, "calculator.test.zs");
  writeFileSync(dependency, `
    function privateAnswer(): i32 {
      return 42;
    }

    export function answer(): i32 {
      return privateAnswer();
    }

    test "private implementation remains available" {
      const observed = privateAnswer();
    }
  `);
  writeFileSync(entry, `
    import { answer } from "./calculator.zs";

    test "public answer is reachable" {
      const observed = answer();
    }
  `);
  const result = spawnSync(process.execPath, [cli, "test", entry], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /running 2 tests/);
  assert.match(result.stdout, /test private implementation remains available \.\.\. ok/);
  assert.match(result.stdout, /test public answer is reachable \.\.\. ok/);
  assert.match(result.stdout, /test result: ok\. 2 passed; 0 failed/);
}, 20_000);

test("the TextMate grammar highlights test declarations as language syntax", () => {
  const grammar = readFileSync(
    resolve(import.meta.dir, "../editors/vscode/syntaxes/z.tmLanguage.json"),
    "utf8",
  );
  assert.match(grammar, /keyword\.control\.declaration\.test\.z/);
  assert.match(grammar, /\\\\btest\(\?=/);
});
