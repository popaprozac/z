import { lex } from "../compiler/src/lexer.ts";
import { parse } from "../compiler/src/parser.ts";
import { normalizeNumericLiteral } from "../compiler/src/numeric-literal.ts";
import {
  assert, check, cli, compileToC, diagnostics, hostToolchainTest, mkdtempSync,
  projectRoot, readFileSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const valid = [
  ["0xE5", "229"], ["0X1e5", "485"], ["0b1010_0101", "165"],
  ["0B00101010", "42"], ["1_024", "1024"], ["010", "10"],
  ["000_000", "0"], ["0xFFFF_FFFF_FFFF_FFFF", "18446744073709551615"],
  ["0x10000000000000000", "18446744073709551616"],
  ["1_024.5_0e+0_1", "1024.50e+01"], ["0.0_1e-0_2", "0.01e-02"],
] as const;
const malformed = [
  "0x", "0X", "0b", "0B", "0x_1", "0b_1", "0xg", "0b2",
  "0x1g", "0b102", "0x1_", "0b1__0", "1_", "1__0", "1_e2",
  "1.2_", "1.2__3", "1.2_e3", "1e_2", "1e+_2", "1e2_", "1e2__3",
];

test("numeric literals preserve source tokens and normalize AST values", () => {
  for (const [spelling, expected] of valid) {
    assert.equal(normalizeNumericLiteral(spelling), expected);
    const source = `// 🙂\nfunction main(): i32 { const value = ${spelling}; return 0; }`;
    const token = lex(source, "literal.zs").find(token => token.kind === "number");
    assert.equal(token?.text, spelling);
    assert.equal(token?.location.offset, source.indexOf(spelling));
    assert.equal(token?.location.line, 2);
    const parsed = parse(lex(source, "literal.zs"), "literal.zs");
    assert.ok(JSON.stringify(parsed).includes(`"value":"${expected}"`));
  }
  // Conversion must not overflow the compiler before semantic range checking.
  const enormous = "0x" + "f".repeat(128);
  assert.equal(normalizeNumericLiteral(enormous), BigInt(enormous).toString());
});

test("numeric literals retain contextual bounds and canonical C emission", () => {
  for (const [spelling, decimal, type] of [
    ["0xE5", "229", "i32"], ["0b1010_0101", "165", "u8"],
    ["-0x80", "-128", "i8"], ["-0B1000000000000000", "-32768", "i16"],
    ["0xFFFF_FFFF_FFFF_FFFF", "18446744073709551615", "u64"],
    ["-0x8000_0000_0000_0000", "-9223372036854775808", "i64"],
    ["010", "10", "i32"], ["1_024.5_0", "1024.50", "f64"],
  ]) {
    const source = (literal: string) => `function value(): ${type} { return ${literal}; } function main(): i32 { return 0; }`;
    assert.equal(compileToC(source(spelling), "literal.zs"), compileToC(source(decimal), "literal.zs"));
  }
  for (const [type, literal] of [
    ["u8", "0x100"], ["i8", "0x80"], ["i8", "-0x81"],
    ["u64", "0x1_0000_0000_0000_0000"], ["i64", "-0x8000_0000_0000_0001"],
    ["u8", "-0b1"],
  ]) {
    assert.throws(() => check(`function value(): ${type} { return ${literal}; }`, "range.zs"), /range|represent|fit/);
  }
  for (const body of [
    "const value = -0x8000_0000_0000_0000; return 0;",
    "-0x8000_0000_0000_0000; return 0;",
  ]) {
    assert.throws(() => check(`function main(): i32 { ${body} }`, "uncontextual.zs"), /fit|overflow/);
  }
  for (const size of ["0x0", "0b0", "0_0", "1.0", "0x20_0000_0000_0000"]) {
    assert.throws(() => parse(lex(`struct Buffer { values: u8[${size}]; }`, "array.zs"), "array.zs"), /fixed array length/);
  }
});

test("numeric literal errors reject malformed radices and separators in the editor", () => {
  for (const literal of malformed) {
    const source = `function main(): i32 { return ${literal}; }`;
    assert.throws(() => lex(source, "bad.zs"), /literal|digit|separator|exponent/);
    assert.ok(diagnostics(source, "bad.zs").length > 0);
  }
  const grammar = JSON.parse(readFileSync(resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"), "utf8"));
  const pattern = new RegExp(grammar.repository.numbers.patterns[0].match, "g");
  const source = valid.map(([spelling]) => spelling).join(" ");
  assert.deepEqual([...source.matchAll(pattern)].map(match => match[0]), valid.map(([spelling]) => spelling));
});

hostToolchainTest("numeric literals execute with lexer parser and native emitter parity", () => {
  const input = resolve(projectRoot, "examples/language/basics/numeric-literals.zs");
  const directory = mkdtempSync("/tmp/z-numeric-literals-");
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  try {
    for (const command of ["self-host-lex", "self-host-parse", "self-host-resolve", "run"]) {
      const result = run(process.execPath, [cli, command, input]);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
    const emitted = run(process.execPath, [cli, "self-host-emit", input]);
    assert.equal(emitted.status, 0, emitted.stderr);
    const c = resolve(directory, "main.c");
    writeFileSync(c, emitted.stdout);
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `probe${optimization}`);
      const compiled = run("clang", [c, "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-o", executable]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = run(executable, []);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "numeric literals: same values, clearer spelling\n");
    }
    for (const literal of malformed) {
      const file = resolve(directory, "bad.zs");
      writeFileSync(file, `function main(): i32 { return ${literal}; }`);
      const result = run(process.execPath, [cli, "self-host-lex", file]);
      assert.notEqual(result.status, 0, literal);
      assert.match(result.stderr, /literal|digit|separator|exponent/, literal);
    }
    for (const source of [
      "function main(): i32 { const value: u8 = 0x100; return 0; }",
      "function value(): i8 { return -0x81; } function main(): i32 { return 0; }",
      "const value: u64 = 0x10000000000000000; function main(): i32 { return 0; }",
      "function main(): i32 { const small: u8 = 1; if (small == 0b100000000) return 1; return 0; }",
      "struct Buffer { values: u8[0x0]; } function main(): i32 { return 0; }",
      "struct Buffer { values: u8[0x20000000000000]; } function main(): i32 { return 0; }",
    ]) {
      const file = resolve(directory, "range.zs");
      writeFileSync(file, source);
      assert.throws(() => check(source, file), /fit|fixed array length/);
      const result = run(process.execPath, [cli, "self-host-emit", file]);
      assert.notEqual(result.status, 0, source);
      assert.match(result.stderr, /fit|fixed array length/, source);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
