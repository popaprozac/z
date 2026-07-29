import {
  analyzeSource,
  assert,
  cli,
  compileTestsToNative,
  compileToNative,
  completions,
  diagnostics,
  hostToolchainTest,
  mkdtempSync,
  readFileSync,
  resolve,
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
  assert.match(artifact.source, /test result: ok\. 2 passed; 0 failed/);
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
