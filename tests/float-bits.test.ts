import {
  assert, check, cli, compileToC, completions, decodeSemanticTokens, diagnostics, hover, hostToolchainTest,
  mkdtempSync, projectRoot, readFileSync, resolve, rmSync, spawnSync, test, writeFileSync,
  semanticTokens, semanticTokenTypes, positionForOffset,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "examples/language/basics/float-bits.zs");
const source = readFileSync(fixture, "utf8");
const invalid = [
  `const n: u32 = 0; const value = f64.fromBits(n);`,
  `const n: u64 = 0; const value = f32.fromBits(n);`,
  `const n: i64 = 0; const value = f64.fromBits(n);`,
  `const value = f64.fromBits(1.0);`,
  `const value = f64.fromBits(true);`,
  `const value = f32.fromBits(0x1_0000_0000);`,
  `const value = f64.fromBits(-1);`,
  `const value = f64.fromBits();`,
  `const value = f64.fromBits(0, 0);`,
  `const value = f32(1).toBits(0);`,
  `const value = u64(1).toBits();`,
  `const value = u64.fromBits(1);`,
  `const value = f64(1).fromBits(0);`,
];

test("float bit methods preserve type widths and differ from numeric conversion", () => {
  check(source, fixture);
  const c = compileToC(source, fixture);
  assert.match(c, /#include <string.h>/);
  assert.match(c, /memcpy\(&result, &value, sizeof\(result\)\)/);
  assert.match(c, /z_bits_f64_to_u64\(observe\(&\(calls\)\)\)/);
  assert.doesNotMatch(c, /z_checked_convert/);
  for (const body of invalid) {
    const input = `function main(): i32 { ${body} return 0; }`;
    assert.throws(() => check(input, "invalid-bits.zs"), undefined, body);
    assert.ok(diagnostics(input, "invalid-bits.zs").length > 0, body);
  }
});

test("float bit methods have useful hover and completion", () => {
  const input = `function main(): i32 { const value: f64 = 1.0; const bits = value.toBits(); const restored = f64.fromBits(bits); return 0; }`;
  for (const method of ["toBits", "fromBits"]) {
    const help = hover(input, "float-bits-editor.zs", input.indexOf(method) + 2)?.contents.value ?? "";
    assert.match(help, /exact IEEE 754 bit pattern/);
    assert.match(help, /no numeric conversion, allocation/);
    assert.match(help, /u64/);
    const position = positionForOffset(input, input.indexOf(method));
    assert.ok(decodeSemanticTokens(semanticTokens(input, "float-bits-editor.zs").data).some(token =>
      token.line === position.line && token.character === position.character && semanticTokenTypes[token.type] === "method"));
  }
  for (const [receiver, method] of [["value", "toBits"], ["f64", "fromBits"]]) {
    const input = `function main(): i32 { const value: f64 = 1.0; ${receiver}. }`;
    const offset = input.lastIndexOf(".") + 1;
    assert.ok(completions(input, "float-bits-editor.zs", offset).some(item => item.label === method), receiver);
  }
});

hostToolchainTest("float bit representations execute in both compilers and async frames", () => {
  const directory = mkdtempSync("/tmp/z-float-bits-");
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  const executeC = (c: string, name: string, extra: string[] = []) => {
    const path = resolve(directory, `${name}.c`);
    writeFileSync(path, c);
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `${name}${optimization}`);
      const compiled = run("clang", [path, "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", ...extra, "-o", executable]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = run(executable, []);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  };
  try {
    executeC(compileToC(source, fixture), "stage0");
    const viewSource = `type Float = f64;
      struct Sample { value: f64; bits: u64; }
      function main(): i32 {
        const aliased: Float = Float.fromBits(0x3FF0_0000_0000_0000);
        if (aliased.toBits() != 0x3FF0_0000_0000_0000) return 3;
        const sample = Sample({value: 1.0, bits: 0x3FF0_0000_0000_0000});
        const borrowed = view sample.value;
        const bitView = view sample.bits;
        const restored = f64.fromBits(bitView);
        if (borrowed.toBits() != restored.toBits()) return 1;
        const optional = Option<f64>.some(1.0);
        const found = match (in optional) {
          some(value) => value.toBits();
          none => u64(0);
        };
        const viewOption = Option<view f64>.some(borrowed);
        const viewed = match (in viewOption) {
          some(value) => value.toBits();
          none => u64(0);
        };
        return found == viewed ? 0 : 2;
      }`;
    executeC(compileToC(viewSource, "float-bits-view.zs"), "stage0-view");
    const asyncSource = `import { scheduler } from "std/async";
      async function main(): i32 {
        const negativeZero = f64.fromBits(0x8000_0000_0000_0000);
        await scheduler.yield();
        if (negativeZero.toBits() != 0x8000_0000_0000_0000) return 1;
        return f32.fromBits(0xFFC0_0042).toBits() == 0xFFC0_0042 ? 0 : 2;
      }`;
    executeC(compileToC(asyncSource, "float-bits-async.zs"), "stage0-async", ["-pthread"]);
    for (const command of ["self-host-parse", "self-host-resolve"]) {
      const result = run(process.execPath, [cli, command, fixture]);
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    }
    const parity = run(process.execPath, [cli, "check", fixture, "--native-frontend"]);
    assert.equal(parity.status, 0, parity.stderr);
    const emitted = run(process.execPath, [cli, "self-host-emit", fixture]);
    assert.equal(emitted.status, 0, emitted.stderr);
    executeC(emitted.stdout, "native");
    const asyncInput = resolve(directory, "async.zs");
    writeFileSync(asyncInput, asyncSource);
    const nativeAsync = run(process.execPath, [cli, "self-host-emit", asyncInput]);
    assert.equal(nativeAsync.status, 0, nativeAsync.stderr);
    executeC(nativeAsync.stdout, "native-async", ["-pthread"]);
    const viewInput = resolve(directory, "view.zs");
    writeFileSync(viewInput, viewSource);
    const nativeView = run(process.execPath, [cli, "self-host-emit", viewInput]);
    assert.equal(nativeView.status, 0, nativeView.stderr);
    executeC(nativeView.stdout, "native-view");
    for (let i = 0; i < invalid.length; i++) {
      const input = resolve(directory, `invalid-${i}.zs`);
      writeFileSync(input, `function main(): i32 { ${invalid[i]} return 0; }`);
      const result = run(process.execPath, [cli, "self-host-emit", input]);
      assert.notEqual(result.status, 0, invalid[i]);
      assert.doesNotMatch(result.stderr, /internal compiler error/, invalid[i]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

hostToolchainTest("optimized float bit transfers need no wrapper or memory-copy calls", () => {
  const c = compileToC(source, fixture) + `
    uint64_t probeEncode(double value) { return z_bits_f64_to_u64(value); }
    double probeDecode(uint64_t bits) { return z_bits_u64_to_f64(bits); }
    uint32_t probeEncode32(float value) { return z_bits_f32_to_u32(value); }
    float probeDecode32(uint32_t bits) { return z_bits_u32_to_f32(bits); }
  `;
  for (const [dialect, standard] of [["c", "c11"], ["c++", "c++17"], ["objective-c", "c11"]]) {
    const result = spawnSync("clang", ["-x", dialect, `-std=${standard}`, "-O2", "-Wall", "-Wextra", "-Werror",
      "-S", "-", "-o", "-"], {
      input: c, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /probeEncode/);
    assert.match(result.stdout, /probeDecode/);
    assert.doesNotMatch(result.stdout, /(?:callq?|bl)\s+_?(?:memcpy|z_bits_|malloc|abort)/);
  }
});
