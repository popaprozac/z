import {
  assert, check, cli, diagnostics, hostToolchainTest, mkdtempSync, resolve,
  rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, { encoding: "utf8", input, timeout: 120_000,
    killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
}

const source = `
  type Registers = Array<i32>;
  struct Work { cells: Registers; }
  class Shared { code: Array<i32>; registers: Array<i32>; }
  function aliasCheck(): i32 {
    const shared = new Shared({ code: Array<i32>(2), registers: Array<i32>(0) });
    let alias = shared;
    const code = view shared.code;
    alias.registers[0] = code[0];
    return code[0] - alias.registers[0];
  }
  struct Machine {
    code: Array<i32>;
    registers: Array<i32>;
    scratch: Work;
    work: Array<Work>;
    fixed: i32[2];
    function run(inout this): i32 {
      const program = view this.code;
      let ip: usize = 0;
      while (ip < program.length) {
        const instruction = program[ip];
        this.registers[0] = this.registers[0] + instruction;
        this.scratch.cells[0] = this.scratch.cells[0] + instruction;
        this.work[0].cells[0] = this.work[0].cells[0] + instruction;
        this.fixed[0] = this.fixed[0] + instruction;
        this.registers.push(instruction);
        this.scratch.cells.push(instruction);
        this.work[0].cells.push(instruction);
        ip = ip + 1;
      }
      this.registers.clear();
      this.registers.push(program[0]);
      const removed = this.registers.pop();
      const popped = match (removed) { some(value) => value; none => 0; };
      for (const instruction of program) { this.registers.push(instruction); }
      const result = this.scratch.cells[0] + this.work[0].cells[0] + this.fixed[0] + popped;
      this.code.push(9);
      return result;
    }
  }
  function main(): i32 {
    if (aliasCheck() != 0) return 2;
    let machine = Machine({ code: Array<i32>(2, 3), registers: Array<i32>(0),
      scratch: Work({ cells: Array<i32>(0) }),
      work: Array<Work>(Work({ cells: Array<i32>(0) })), fixed: [0, 0] });
    if (machine.run() != 17 || machine.code.length != 3) return 1;
    return 0;
  }
`;

hostToolchainTest("borrows an array field while mutating disjoint owned array storage", () => {
  const directory = mkdtempSync("/tmp/z-sibling-array-borrow-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    assert.doesNotThrow(() => check(source, input));
    assert.equal(diagnostics(source, input).length, 0);
    for (const mode of ["emit", "self-host-emit"]) {
      const emitted = run(process.execPath, [cli, mode, input]);
      assert.equal(emitted.status, 0, emitted.stderr);
      // The view remains a pointer to the original Array descriptor, not a copy.
      const viewDeclaration = emitted.stdout.split("\n").find((line) => line.includes("* const program ="));
      assert.match(viewDeclaration ?? "", /const Z_\w+ \* const program = &\(?\(?self->code/);
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

test("rejects overlapping array mutations and hidden reference paths while viewed", () => {
  const directory = mkdtempSync("/tmp/z-sibling-array-overlap-");
  try {
    const prefix = `
      class Box { values: Array<i32>; }
      struct Store { code: Array<i32>; registers: Array<i32>; boxes: Array<Box>; }
      function mutate(inout store: Store): void { store.code.push(1); }
      function mutateIndex(inout store: Store): usize { store.code.push(1); return 0; }
      function main(): i32 {
        let store = Store({ code: Array<i32>(2), registers: Array<i32>(0),
          boxes: Array<Box>(new Box({ values: Array<i32>(0) })) });
        const program = view store.code;
    `;
    const mutations = [
      "store.code[0] = 3;", "store.code.push(3);", "store.code.clear();",
      "const popped = store.code.pop();", "store.code = Array<i32>(3);",
      "mutate(inout store);", "store.boxes[0].values[0] = 3;",
      "store.boxes[0].values.push(3);",
      "store.registers[mutateIndex(inout store)] = 3;",
    ];
    for (const [index, mutation] of mutations.entries()) {
      const text = `${prefix} ${mutation} return program[0]; }`;
      const input = resolve(directory, `overlap-${index}.zs`);
      writeFileSync(input, text);
      assert.throws(() => check(text, input), /cannot mutate .*while view .* is live/, mutation);
      const native = run(process.execPath, [cli, "self-host-resolve", input]);
      assert.notEqual(native.status, 0, mutation);
      assert.match(native.stderr, /cannot mutate .*while view .* is live/, `${mutation}\n${native.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps array-view alias, mutability, and dynamic-index boundaries conservative", () => {
  const cases = [
    `class Machine { code: Array<i32>; registers: Array<i32>; }
      function main(): i32 {
        let machine = new Machine({ code: Array<i32>(2), registers: Array<i32>(0) });
        let alias = machine;
        const program = view machine.code;
        alias.code[0] = 3;
        return program[0];
      }`,
    `struct Machine { code: Array<i32>; registers: Array<i32>;
      function run(): i32 {
        const program = view this.code;
        this.registers[0] = 3;
        return program[0];
      }
    } function main(): i32 { return 0; }`,
    `struct Row { code: Array<i32>; registers: Array<i32>; }
      struct Machine { rows: Array<Row>; }
      function main(): i32 {
        let machine = Machine({ rows: Array<Row>(Row({ code: Array<i32>(2), registers: Array<i32>(0) })) });
        const program = view machine.rows[0].code;
        machine.rows[0].registers[0] = 3;
        return program[0];
      }`,
    ...["store.registers[0] = 3;", "store.registers.push(3);"].map((mutation) => `
      struct Store { code: Array<i32>; readonly registers: Array<i32>; }
      function main(): i32 {
        let store = Store({ code: Array<i32>(2), registers: Array<i32>(0) });
        const program = view store.code;
        ${mutation}
        return program[0];
      }`),
  ];
  const directory = mkdtempSync("/tmp/z-sibling-array-safety-");
  try {
    for (const [index, source] of cases.entries()) {
      const input = resolve(directory, `safety-${index}.zs`);
      writeFileSync(input, source);
      assert.throws(() => check(source, input), /cannot mutate .*while view .* is live|immutable binding|readonly field/, source);
      const native = run(process.execPath, [cli, "self-host-resolve", input]);
      assert.notEqual(native.status, 0, source);
      assert.match(native.stderr, /cannot mutate .*while view .* is live|immutable binding|readonly field/, native.stderr);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
