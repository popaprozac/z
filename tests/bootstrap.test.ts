import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
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

test("compiles and runs the first native program", () => {
  const example = resolve(projectRoot, "examples/first.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z says 42\n");
});

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}
