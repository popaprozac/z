import {
  assert, check, cli, compileToC, completions, diagnostics, hover, hostToolchainTest,
  mkdtempSync, projectRoot, readFileSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/wrapping-shift.zs");
const example = resolve(projectRoot, "examples/language/basics/wrapping-shift.zs");
const source = readFileSync(fixture, "utf8");
const types = ["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"];
const width = (type: string) => type.endsWith("size") ? (process.arch.includes("64") ? 64 : 32) : Number(type.slice(1));
const invalidCounts = types.flatMap(type => [-1, width(type), width(type) + 1].map(count =>
  `function shift(value: ${type}): ${type} { return value.wrappingShiftLeft(${count}); }
   function main(): i32 { return 0; }`)).concat([
  "type Word = u32; function shift(value: Word): Word { return value.wrappingShiftLeft(32); } function main(): i32 { return 0; }",
  "function main(): i32 { const word: u32 = 1; const bits = word.wrappingShiftLeft(1 << 5); return 0; }",
]);
const invalidShapes = [
  "value.wrappingShiftLeft()", "value.wrappingShiftLeft(1, 2)",
  "value.wrappingShiftLeft(true)", "value.wrappingShiftLeft(1.0)",
  "value.wrappingShiftLeft(u32(1))", "value.wrappingShiftLeft(i32(1))",
  "value.wrappingShiftLeft(count: 1)",
].map(expression => `function main(): i32 { const value: u32 = 1; const shifted = ${expression}; return 0; }`);

const asyncSource = `import { scheduler } from "std/async";
type Word = u32;
async function main(): i32 {
  const word: Word = 3;
  const count: usize = 31;
  const before = word.wrappingShiftLeft(count);
  await scheduler.yield();
  const after = word.wrappingShiftLeft(count);
  const negative: i32 = -1;
  if (before != after || after != 0x8000_0000) return 1;
  if (negative.wrappingShiftLeft(count) != -2147483648) return 2;
  if (word != 3) return 3;
  if (word.wrappingMultiply(2).wrappingSubtract(1).wrappingAdd(1) != 6) return 4;
  return 0;
}`;

test("wrapping left shifts retain receiver types and check usize counts", () => {
  check(source, fixture);
  check(readFileSync(example, "utf8"), example);
  compileToC(asyncSource, "async-wrapping-shift.zs");
  for (const input of invalidCounts) {
    assert.throws(() => check(input, "invalid-shift.zs"), /shift count .* outside the range/);
    assert.equal(diagnostics(input, "invalid-shift.zs")[0]?.code, "Z0103");
  }
  for (const input of invalidShapes) assert.throws(() => check(input, "invalid-shift.zs"));
  assert.throws(() => check("function main(): i32 { const bits: u32 = 3 << 31; return 0; }", "checked-shift.zs"), /overflows u32/);
  assert.throws(() => check("function main(): i32 { const bits: u32 = 1; const n = bits.wrappingShiftLeft(1 << 5); return 0; }", "invalid-shift.zs"), /shift count .* outside the range/);
});

test("wrapping left shifts have matching hover and completion contracts", () => {
  for (const type of types) {
    const input = `function main(): i32 { const value: ${type} = 1; const bits = value.wrappingShiftLeft(1); return 0; }`;
    const detail = hover(input, "shift-editor.zs", input.indexOf("wrappingShiftLeft") + 3)?.contents.value ?? "";
    assert.ok(detail.includes(`wrappingShiftLeft(count: usize): ${type}`), detail);
    assert.match(detail, /not masked/);
    assert.match(detail, /no mutation or allocation/);
    const partial = `function main(): i32 { const value: ${type} = 1; value. }`;
    const choice = completions(partial, "shift-editor.zs", partial.lastIndexOf(".") + 1)
      .find(item => item.label === "wrappingShiftLeft");
    assert.ok(choice?.detail?.includes(`count: usize): ${type}`));
  }
});

hostToolchainTest("wrapping shifts execute in both compilers with defined signed and narrow semantics", () => {
  const directory = mkdtempSync("/tmp/z-wrapping-shift-");
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  try {
    const asyncPath = resolve(directory, "async.zs");
    writeFileSync(asyncPath, asyncSource);
    for (const path of [fixture, example, asyncPath]) {
      const parity = run(process.execPath, [cli, "check", path, "--native-frontend"]);
      assert.equal(parity.status, 0, parity.stderr);
      for (const native of [false, true]) {
        const emitted = native ? run(process.execPath, [cli, "self-host-emit", path]) : null;
        if (emitted) assert.equal(emitted.status, 0, emitted.stderr);
        const c = resolve(directory, "output.c");
        writeFileSync(c, emitted?.stdout ?? compileToC(readFileSync(path, "utf8"), path));
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(directory, "probe");
          const built = run("clang", [c, "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
            "-fsanitize=undefined", "-fno-sanitize-recover=all", "-pthread", "-o", executable]);
          assert.equal(built.status, 0, built.stderr);
          const result = run(executable, []);
          assert.equal(result.status, 0, `${path}, native=${native}, ${optimization}: ${result.stderr}`);
        }
      }
    }
    for (const input of [...invalidCounts, ...invalidShapes]) {
      const path = resolve(directory, "invalid.zs");
      writeFileSync(path, input);
      const result = run(process.execPath, [cli, "self-host-emit", path]);
      assert.notEqual(result.status, 0, input);
      assert.doesNotMatch(result.stderr, /internal compiler error/);
      assert.match(result.stderr, /shift|argument|fit|expected|requires|label/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

hostToolchainTest("dynamic wrapping shift counts trap instead of being masked", () => {
  const directory = mkdtempSync("/tmp/z-wrapping-shift-count-");
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  try {
    const input = types.map(type => `function shift_${type}(value: ${type}, count: usize): ${type} {
      return value.wrappingShiftLeft(count);
    }`).join("\n") + "\nfunction main(): i32 { return 0; }";
    const path = resolve(directory, "counts.zs");
    writeFileSync(path, input);
    for (const native of [false, true]) {
      const emitted = native ? run(process.execPath, [cli, "self-host-emit", path]) : null;
      if (emitted) assert.equal(emitted.status, 0, emitted.stderr);
      const generated = emitted?.stdout ?? compileToC(input, path);
      const cPath = resolve(directory, "counts.c");
      // Intercept the generated trap to avoid OS crash reports. Exit is not a
      // return: an invalid shift still must never execute or produce a value.
      const driver = types.map((type, index) => `case ${index}: (void)${native ? "z_stage1_" : "z_"}wrapping_shift_left_${type}(3, count); break;`).join("\n");
      writeFileSync(cPath, `#include <stdlib.h>\nstatic void invalid_count(void) { _Exit(73); }\n#define abort invalid_count\n#define main generated_main\n${generated}\n#undef main\n
        int main(int argc, char **argv) { if (argc != 3) return 90;
          size_t count = (size_t)strtoull(argv[2], NULL, 10);
          switch (atoi(argv[1])) { ${driver} default: return 91; } return 0;
        }`);
      const executable = resolve(directory, "counts");
      const built = run("clang", [cPath, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", executable]);
      assert.equal(built.status, 0, built.stderr);
      for (const [index, type] of types.entries()) {
        for (const count of [width(type), width(type) + 1, 1000]) {
          assert.equal(run(executable, [String(index), String(count)]).status, 73, `${type} count ${count}`);
        }
        assert.equal(run(executable, [String(index), String(width(type) - 1)]).status, 0);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

hostToolchainTest("constant-count wrapping shifts optimize to native shifts without runtime calls", () => {
  const c = compileToC(`function shift(value: i32): i32 { return value.wrappingShiftLeft(13); }
    function main(): i32 { return 0; }`, "shift-assembly.zs")
    + "\nint32_t probe_shift(int32_t value) { return z_wrapping_shift_left_i32(value, 13); }";
  for (const [dialect, standard] of [["c", "c11"], ["c++", "c++17"], ["objective-c", "c11"]]) {
    const result = spawnSync("clang", ["-x", dialect, `-std=${standard}`, "-O2", "-Wall", "-Wextra", "-Werror", "-S", "-", "-o", "-"], {
      input: c, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /probe_shift/);
    assert.doesNotMatch(result.stdout, /(?:callq?|bl)\s+_?(?:memcpy|malloc|abort|z_wrapping)/);
    if (process.arch === "arm64") assert.match(result.stdout, /lsl\s+w\d+, w\d+, #13/);
    if (process.arch === "x64") assert.match(result.stdout, /shll?\s+\$13/);
  }
});
