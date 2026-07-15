import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { compileToC } from "../compiler/src/compiler.ts";

const projectRoot = resolve(dirnameFromImportMeta(), "..");
const cli = resolve(projectRoot, "compiler/src/cli.ts");

test("emits functions and direct imported C calls", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.puts("hello");
      return 0;
    }
  `;
  const generated = compileToC(source, "memory.z");
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /puts\("hello"\);/);
  assert.doesNotMatch(generated, /stdio\.puts/);
});

test("reports source locations for parser errors", () => {
  assert.throws(
    () => compileToC("function main(: i32 {}", "broken.z"),
    /broken\.z:1:15: error:/,
  );
});

test("rejects unknown names during semantic analysis", () => {
  const source = `
    function main(): i32 {
      return missing;
    }
  `;
  assert.throws(
    () => compileToC(source, "unknown.z"),
    /unknown\.z:3:14: error: unknown name "missing"/,
  );
});

test("checks Z function arguments", () => {
  const source = `
    function identity(value: i32): i32 {
      return value;
    }
    function main(): i32 {
      return identity("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "arguments.z"),
    /arguments\.z:6:23: error: expected i32, found cstring/,
  );
});

test("infers primitive local types for C emission", () => {
  const source = `
    function answer(): i32 {
      return 42;
    }
    function main(): i32 {
      const value = answer();
      return value;
    }
  `;
  const generated = compileToC(source, "inference.z");
  assert.match(generated, /const int32_t value = answer\(\);/);
});

test("compiles boolean expressions and path-complete if statements", () => {
  const example = resolve(projectRoot, "examples/control-flow.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "disabled=0\nordinary=1\nspecial=2\n");
});

test("requires boolean if conditions", () => {
  const source = `
    function main(): i32 {
      if (42) { return 1; } else { return 0; }
    }
  `;
  assert.throws(
    () => compileToC(source, "if-condition.z"),
    /if-condition\.z:3:11: error: expected bool, found i32/,
  );
});

test("requires every reachable if path to return", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; }
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "if-return.z"),
    /function "choose" must end with a return value/,
  );
});

test("rejects statements after every branch exits", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; } else { return 2; }
      return 3;
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "unreachable.z"),
    /unreachable\.z:4:7: error: unreachable statement after guaranteed function exit/,
  );
});

test("checks logical operand types", () => {
  const source = `
    function main(): i32 {
      const invalid = true && 1;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "logical-types.z"),
    /operator "&&" requires bool operands/,
  );
});

test("emits struct layouts, literals, fields, and borrowed methods", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
      function sum(): i32 {
        return this.x + this.y;
      }
    }
    function main(): i32 {
      const point = Point { x: 20, y: 22 };
      return point.sum();
    }
  `;
  const generated = compileToC(source, "point.z");
  assert.match(generated, /struct Z_Point \{/);
  assert.match(generated, /static int32_t Z_Point_sum\(const Z_Point \*self\)/);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \};/);
  assert.match(generated, /return Z_Point_sum\(&\(point\)\);/);
});

test("requires every struct field exactly once", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
    }
    function main(): i32 {
      const point = Point { x: 1 };
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(source, "missing-field.z"),
    /missing-field\.z:7:21: error: missing field "y" when constructing "Point"/,
  );
});

test("checks struct method arguments", () => {
  const source = `
    struct Counter {
      value: i32;
      function add(amount: i32): i32 {
        return this.value + amount;
      }
    }
    function main(): i32 {
      const counter = Counter { value: 1 };
      return counter.add("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "method-arguments.z"),
    /method-arguments\.z:10:26: error: expected i32, found cstring/,
  );
});

test("requires exhaustive enum matches", () => {
  const source = `
    enum Outcome {
      success i32,
      failure i32,
    }
    function main(): i32 {
      const outcome = Outcome.success 42;
      match outcome {
        success value => return value;
      }
    }
  `;
  assert.throws(
    () => compileToC(source, "exhaustive.z"),
    /exhaustive\.z:8:7: error: non-exhaustive match; missing Outcome\.failure/,
  );
});

test("compiles payload enums and exhaustive matches", () => {
  const example = resolve(projectRoot, "examples/match.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "matched=42\n");
});

test("compiles expression matches with concise and yielding block arms", () => {
  const example = resolve(projectRoot, "examples/match-expression.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "code=41\ndirect=41\nyielded=42\n");
});

test("requires yield to target a value-producing block", () => {
  const source = `
    function main(): i32 {
      yield 42;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "orphan-yield.z"),
    /orphan-yield\.z:3:7: error: yield requires an enclosing value-producing block/,
  );
});

test("requires expression match arms to agree on a value type", () => {
  const source = `
    enum Choice { first i32, second i32, }
    function main(): i32 {
      const choice = Choice.first 42;
      const value = match choice {
        first number => number;
        second number => "wrong";
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(source, "match-types.z"),
    /match-types\.z:7:9: error: match arm produces cstring, but previous arms produce i32/,
  );
});

test("requires explicit handling for throwing calls", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "explicit-errors.z"),
    /throwing call requires `attempt` or `try`/,
  );
});

test("rejects throw outside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function main(): i32 { throw Problem { code: 1 }; }
  `;
  assert.throws(
    () => compileToC(source, "invalid-throw.z"),
    /function "main" does not declare an error type/,
  );
});

test("compiles typed Result success and failure paths", () => {
  const example = resolve(projectRoot, "examples/result.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "found=42\nerror=7\n");
});

test("requires try inside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return try fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "try-context.z"),
    /try requires an enclosing throwing function/,
  );
});

test("requires compatible propagated error types", () => {
  const source = `
    struct FirstError { code: i32; }
    struct SecondError { code: i32; }
    function first(): i32 throws FirstError { return 1; }
    function second(): i32 throws SecondError {
      const value = try first();
      return value;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "try-errors.z"),
    /cannot propagate FirstError from a function throwing SecondError/,
  );
});

test("propagates typed failures through try", () => {
  const example = resolve(projectRoot, "examples/try.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "id=42\nforwarded=9\nerror=7\n");
});

test("compiles and runs structs as native values", () => {
  const example = resolve(projectRoot, "examples/structs.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "original=42 translated=45\n");
});

test("compiles and runs the first native program", () => {
  const example = resolve(projectRoot, "examples/first.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z says 42\n");
});

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}

test("editor grammar tracks keywords without reserving Result variants", () => {
  const grammarPath = resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
  const keywordPattern = grammar.repository.keywords.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const constantPattern = grammar.repository.constants.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const operatorPattern = grammar.repository.operators.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /yield/);
  assert.match(constantPattern, /true\|false/);
  assert.match(operatorPattern, /&&/);
  assert.doesNotMatch(keywordPattern, /success|failure/);
});
