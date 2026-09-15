import {
  assert, check, cli, compileToC, completions, diagnostics, hover, hostToolchainTest,
  mkdtempSync, projectRoot, readFileSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "examples/language/basics/integer-bits.zs");
const source = readFileSync(fixture, "utf8");
const pairs = [["i8", "u8"], ["i16", "u16"], ["i32", "u32"], ["i64", "u64"], ["isize", "usize"]] as const;
const invalid = [
  ...pairs.map(([signed]) => `const n: ${signed} = -1; const value = ${signed}.fromBits(n);`),
  ...pairs.map(([, unsigned]) => `const n: ${unsigned} = 0; const value = n.toBits();`),
  ...pairs.map(([, unsigned]) => `const value = ${unsigned}.fromBits(0);`),
  ...pairs.map(([signed]) => `const n: ${signed} = -1; const value = n.toBits(0);`),
  `const n: u16 = 1; const value = i32.fromBits(n);`,
  `const n: u64 = 1; const value = i32.fromBits(n);`,
  `const n: usize = 1; const value = i64.fromBits(n);`,
  `const n: u64 = 1; const value = isize.fromBits(n);`,
  `const n: i32 = -42; const value = u32.fromBits(n);`,
  `const value = i8.fromBits(0x100);`,
  `const value = i32.fromBits(-1);`,
  `const value = i32.fromBits(1.0);`,
  `const value = i32.fromBits(true);`,
  `const value = i32.fromBits();`,
  `const value = i32.fromBits(0, 0);`,
  `const value = i32(1).fromBits(0);`,
  `const value = true.toBits();`,
];

const roundTrips = pairs.map(([signed, unsigned]) => `
  function roundTrip_${signed}(bits: ${unsigned}): boolean {
    const value = ${signed}.fromBits(bits);
    return value.toBits() == bits;
  }
`).join("\n");

const composition = `import { scheduler } from "std/async";
  type Signed = i32;
  type Bits = u32;
  struct Sample { value: i32; bits: u32; }
  ${roundTrips}
  function inspectViews(): i32 {
    const aliased: Signed = Signed.fromBits(0xFFFF_FFD6);
    const aliasedBits: Bits = aliased.toBits();
    const sample = Sample({ value: -42, bits: aliasedBits });
    const borrowed = view sample.value;
    const bitView = view sample.bits;
    if (borrowed.toBits() != aliasedBits) return 1;
    if (i32.fromBits(bitView) != -42) return 2;
    const optional = Option<i32>.some(-42);
    const found = match (in optional) {
      some(value) => value.toBits();
      none => u32(0);
    };
    const viewOption = Option<view i32>.some(borrowed);
    const viewed = match (in viewOption) {
      some(value) => value.toBits();
      none => u32(0);
    };
    if (found != viewed) return 3;
    return 0;
  }
  async function main(): i32 {
    const aliased: Signed = Signed.fromBits(0xFFFF_FFD6);
    const aliasedBits: Bits = aliased.toBits();
    await scheduler.yield();
    if (inspectViews() != 0) return 10;
    if (i32.fromBits(aliasedBits) != aliased) return 4;
    if (!roundTrip_i8(0) || !roundTrip_i8(0xFF)) return 5;
    if (!roundTrip_i16(0x7FFF) || !roundTrip_i16(0x8000) || !roundTrip_i16(0xFFFF)) return 6;
    if (!roundTrip_i32(0x7FFF_FFFF) || !roundTrip_i32(0x8000_0000) || !roundTrip_i32(0xFFFF_FFFF)) return 7;
    if (!roundTrip_i64(0x7FFF_FFFF_FFFF_FFFF) || !roundTrip_i64(0x8000_0000_0000_0000) || !roundTrip_i64(0xFFFF_FFFF_FFFF_FFFF)) return 8;
    const nativeNegative: isize = -1;
    if (!roundTrip_isize(nativeNegative.toBits())) return 9;
    return 0;
  }`;

test("signed integer bit methods preserve exact carrier types and checked construction", () => {
  check(source, fixture);
  check(composition, "integer-bits-composition.zs");
  for (const body of invalid) {
    const input = `function main(): i32 { ${body} return 0; }`;
    assert.throws(() => check(input, "invalid-integer-bits.zs"), undefined, body);
    assert.ok(diagnostics(input, "invalid-integer-bits.zs").length > 0, body);
  }
  assert.throws(() => check("function main(): i32 { const n = u32(-42); return 0; }", "checked-integer.zs"));
  const checked = compileToC(`function convert(value: i32): u32 { return u32(value); }
    function main(): i32 { return convert(0) == 0 ? 0 : 1; }`, "checked-integer.zs");
  assert.match(checked, /z_checked_convert_i32_to_u32/);
  assert.match(checked, /if \(value < 0\) abort\(\)/);
});

test("signed integer bit methods have accurate hover and completion", () => {
  for (const [signed, unsigned] of pairs) {
    const input = `function main(): i32 { const value: ${signed} = -1; const bits = value.toBits(); const restored = ${signed}.fromBits(bits); return 0; }`;
    for (const method of ["toBits", "fromBits"]) {
      const help = hover(input, "integer-bits-editor.zs", input.indexOf(method) + 2)?.contents.value ?? "";
      assert.match(help, /exact two's-complement bit pattern/);
      assert.match(help, /no numeric conversion, allocation/);
      assert.ok(help.includes(unsigned), help);
      assert.doesNotMatch(help, /IEEE|NaN/);
    }
    for (const [receiver, method] of [["value", "toBits"], [signed, "fromBits"]]) {
      const input = `function main(): i32 { const value: ${signed} = -1; ${receiver}. }`;
      const choices = completions(input, "integer-bits-editor.zs", input.lastIndexOf(".") + 1);
      assert.ok(choices.some(item => item.label === method), `${signed} ${receiver}.${method}`);
      if (receiver === "value") assert.ok(choices.some(item => item.label === "wrappingAdd"));
    }
    const unsignedInput = `function main(): i32 { const value: ${unsigned} = 0; value. }`;
    assert.ok(!completions(unsignedInput, "integer-bits-editor.zs", unsignedInput.lastIndexOf(".") + 1).some(item => item.label === "toBits"));
  }
});

hostToolchainTest("numeric bit methods do not erase native enum identity", () => {
  const geometry = JSON.stringify(resolve(projectRoot, "tests/fixtures/geometry.h"));
  const options = JSON.stringify(resolve(projectRoot, "tests/fixtures/typed-variadic.h"));
  assert.throws(() => check(`import native from ${geometry};
    function main(): i32 {
      const value = native.ZBackward;
      const bits = value.toBits();
      return 0;
    }`, "native-enum-bits.zs"), /has no method "toBits"/);
  assert.throws(() => check(`import native from ${options};
    function main(): i32 {
      const value = i32.fromBits(native.Z_TYPED_OK);
      return 0;
    }`, "native-enum-bits.zs"), /requires u32, not a native enum/);
});

hostToolchainTest("integer bit representations execute in both compilers and across suspension", () => {
  const directory = mkdtempSync("/tmp/z-integer-bits-");
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
  });
  const executeC = (c: string, name: string) => {
    const path = resolve(directory, `${name}.c`);
    writeFileSync(path, c);
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `${name}${optimization}`);
      const compiled = run("clang", [path, "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-pthread", "-o", executable]);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = run(executable, []);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
  };
  try {
    executeC(compileToC(source, fixture), "stage0");
    executeC(compileToC(composition, "integer-bits-composition.zs"), "stage0-composition");
    const input = resolve(directory, "composition.zs");
    writeFileSync(input, composition);
    for (const [path, name] of [[fixture, "native"], [input, "native-composition"]]) {
      const parity = run(process.execPath, [cli, "check", path, "--native-frontend"]);
      assert.equal(parity.status, 0, parity.stderr);
      const emitted = run(process.execPath, [cli, "self-host-emit", path]);
      assert.equal(emitted.status, 0, emitted.stderr);
      executeC(emitted.stdout, name);
    }
    for (let i = 0; i < invalid.length; i++) {
      const input = resolve(directory, `invalid-${i}.zs`);
      writeFileSync(input, `function main(): i32 { ${invalid[i]} return 0; }`);
      const result = run(process.execPath, [cli, "self-host-emit", input]);
      assert.notEqual(result.status, 0, invalid[i]);
      assert.doesNotMatch(result.stderr, /internal compiler error/, invalid[i]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

hostToolchainTest("optimized integer bit transfers have no allocation, checks, or helper calls", () => {
  const c = compileToC(`${roundTrips} function main(): i32 { return 0; }`, "integer-bits-assembly.zs")
    + pairs.map(([signed, unsigned]) => {
      const signedC = signed === "isize" ? "intptr_t" : `int${signed.slice(1)}_t`;
      const unsignedC = unsigned === "usize" ? "uintptr_t" : `uint${unsigned.slice(1)}_t`;
      return `\n${unsignedC} probeEncode_${signed}(${signedC} value) { return z_bits_${signed}_to_${unsigned}(value); }
        ${signedC} probeDecode_${signed}(${unsignedC} value) { return z_bits_${unsigned}_to_${signed}(value); }`;
    }).join("\n");
  for (const [dialect, standard] of [["c", "c11"], ["c++", "c++17"], ["objective-c", "c11"]]) {
    const result = spawnSync("clang", ["-x", dialect, `-std=${standard}`, "-O2", "-Wall", "-Wextra", "-Werror",
      "-S", "-", "-o", "-"], {
      input: c, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /probeEncode_i32/);
    assert.doesNotMatch(result.stdout, /(?:callq?|bl)\s+_?(?:memcpy|z_bits_|malloc|abort)/);
  }
});
