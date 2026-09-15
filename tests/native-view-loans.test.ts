import {
  assert, check, cli, hostToolchainTest, mkdtempSync, resolve, rmSync,
  spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const prefix = `
  struct Instruction { value: i32; }
  struct Machine { code: Array<Instruction>; }
`;

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    encoding: "utf8", input, timeout: 120_000, killSignal: "SIGKILL",
    maxBuffer: 32 * 1024 * 1024,
  });
}

test("keeps inherited view loans live across native loop continuations", () => {
  const directory = mkdtempSync("/tmp/z-native-loop-view-");
  try {
    const setup = `
      let machine = Machine({ code: Array<Instruction>(Instruction({ value: 2 })) });
      const instruction = view machine.code[0];
      let total: i32 = 0;
      let index: usize = 0;
    `;
    const read = "total = total + instruction.value;";
    const grow = "machine.code.push(Instruction({ value: 10 }));";
    const cases = [
      `while (index < 2) { ${read} ${grow} index = index + 1; }`,
      `while (instruction.value > 0 && index < 2) { ${grow} index = index + 1; }`,
      `while (index < 2) { ${read} if (index == 0) { ${grow} } index = index + 1; }`,
      `while (index < 2) { ${read} ${grow} index = index + 1; continue; }`,
      `const steps = Array<i32>(1, 2); for (const step of steps) { ${read} ${grow} }`,
      `while (index < 2) { ${read} let inner: usize = 0; while (inner < 1) { ${grow} inner = inner + 1; } index = index + 1; }`,
      `while (index < 2) { ${grow} index = index + 1; } ${read}`,
      `while (index < 2) { const selected = view machine.code[0]; let inner: usize = 0;
        while (inner < 2) { total = total + selected.value; ${grow} inner = inner + 1; }
        index = index + 1; }`,
    ];
    for (const [index, body] of cases.entries()) {
      const source = `${prefix} function main(): i32 { ${setup} ${body} return total; }`;
      const input = resolve(directory, `loop-${index}.zs`);
      writeFileSync(input, source);
      assert.throws(() => check(source, input), /cannot mutate .*while view .* is live/, body);
      const result = run(process.execPath, [cli, "self-host-resolve", input]);
      assert.notEqual(result.status, 0, `native checker accepted ${body}`);
      assert.match(result.stderr, /cannot mutate .*while view .* is live/, body);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("releases completed loop and iteration-local views before mutation", () => {
  const source = `${prefix}
    function main(): i32 {
      let machine = Machine({ code: Array<Instruction>(Instruction({ value: 2 })) });
      const instruction = view machine.code[0];
      let total: i32 = 0;
      let index: usize = 0;
      while (index < 2) { total = total + instruction.value; index = index + 1; }
      machine.code.push(Instruction({ value: 3 }));
      index = 0;
      while (index < 2) {
        const local = view machine.code[0];
        total = total + local.value;
        machine.code.push(Instruction({ value: 4 }));
        index = index + 1;
      }
      const steps = Array<i32>(1, 2);
      const final = view machine.code[1];
      for (const step of steps) { if (step < 1) return 2; total = total + final.value; }
      machine.code.push(Instruction({ value: 5 }));
      if (total != 14 || machine.code.length != 5) return 1;
      return 0;
    }
  `;
  const directory = mkdtempSync("/tmp/z-native-loop-view-release-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    assert.doesNotThrow(() => check(source, input));
    for (const mode of ["emit", "self-host-emit"]) {
      const emitted = run(process.execPath, [cli, mode, input]);
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, "program");
        const compiled = run("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], emitted.stdout);
        assert.equal(compiled.status, 0, compiled.stderr);
        const result = run(binary, []);
        assert.equal(result.status, 0, result.stderr);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
