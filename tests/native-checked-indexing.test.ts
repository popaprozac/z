import {
  assert, cli, hostToolchainTest, mkdtempSync, resolve, rmSync, spawnSync,
  writeFileSync,
} from "./support/bootstrap.ts";

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, { input, encoding: "utf8", timeout: 120_000,
    killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
}

const source = `
  struct Row { values: Array<i32>; }
  struct Machine { code: Array<i32>; registers: Array<i32>;
    function run(inout this): i32 {
      const program = view this.code;
      let index: usize = 0;
      while (index < program.length) {
        this.registers[0] = this.registers[0] + program[index];
        index = index + 1;
      }
      return this.registers[0];
    }
  }
  function next(inout calls: i32): usize { calls = calls + 1; return 0; }
  function first(values: Slice<i32>): i32 { return values[0]; }
  export c function checkedRead(index: usize): i32 {
    const values = Array<i32>(7, 11);
    return values[index];
  }
  export c function checkedView(index: usize): i32 {
    const row = Row({ values: Array<i32>(7, 11) });
    const values = view row.values;
    return values[index];
  }
  export c function checkedWrite(index: usize): i32 {
    let row = Row({ values: Array<i32>(7, 11) });
    row.values[index] = 19;
    return row.values[index];
  }
  export c function checkedEmpty(index: usize): i32 {
    const values = Array<i32>();
    return values[index];
  }
  function main(): i32 {
    let machine = Machine({ code: Array<i32>(2, 3), registers: Array<i32>(0) });
    if (machine.run() != 5) return 1;
    let calls = 0;
    let values = Array<i32>(3);
    values[next(inout calls)] = values[next(inout calls)] + 1;
    if (calls != 2 || values[0] != 4) return 2;
    let rows = Array<Row>(Row({ values: Array<i32>(6) }));
    rows[next(inout calls)].values[0] = 8;
    if (calls != 3 || rows[next(inout calls)].values[0] != 8) return 3;
    if (calls != 4) return 4;
    const words = Array<String>("hello", "world");
    if (words[0].byteLength != 5) return 5;
    let fixed = [7, 8];
    fixed[0] = fixed[1];
    if (fixed[0] != 8 || first(values) != 4) return 6;
    return 0;
  }
`;

hostToolchainTest("native checked subscripts preserve effects, storage, and bounds failures", () => {
  const directory = mkdtempSync("/tmp/z-native-checked-index-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    for (const mode of ["emit", "self-host-emit"]) {
      const emitted = run(process.execPath, [cli, mode, input]);
      assert.equal(emitted.status, 0, emitted.stderr);
      if (mode === "self-host-emit") {
        assert.match(emitted.stdout, /_ConstData\)\(program\)->data\)\[z_stage1_bounds_index\(index, \(program\)->length\)\]/);
        assert.match(emitted.stdout, /_Data\)\(self->registers\)\.data\)\[z_stage1_bounds_index/);
        assert.match(emitted.stdout, /_at_mut\(&\(values\), next\(/);
        assert.match(emitted.stdout, /_at_mut\(&\(\(\*Z_.*_at_mut\(&\(rows\), next\(/);
      }
      // Intercept abort only in this harness: out-of-range tests exit with a
      // distinct code instead of creating OS crash reports. Guards are intact.
      const harness = `#include <stdlib.h>\nstatic _Noreturn void z_test_abort(void) { _Exit(73); }\n#define abort z_test_abort\n`
        + emitted.stdout.replace(/int32_t main\(/g, "int32_t z_test_main(")
        + `\nint main(int argc, char **argv) {
          if (argc == 1) return z_test_main(${emitted.stdout.includes("int32_t main(void)") ? "" : "argc, argv"});
          size_t index = (size_t)strtoull(argv[2], NULL, 10);
          int value = 0;
          switch (argv[1][0]) {
            case 'r': value = checkedRead(index); break;
            case 'v': value = checkedView(index); break;
            case 'w': value = checkedWrite(index); break;
            case 'e': value = checkedEmpty(index); break;
            default: return 99;
          }
          return value;
        }\n`;
      for (const optimization of ["-O0", "-O2", "-O3"]) {
        const binary = resolve(directory, "program");
        const compiled = run("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], harness);
        assert.equal(compiled.status, 0, compiled.stderr);
        const executed = run(binary, []);
        assert.equal(executed.status, 0, executed.stderr);
        for (const shape of ["read", "view", "write", "empty"]) {
          if (shape !== "empty") {
            const valid = run(binary, [shape, "1"]);
            assert.equal(valid.status, shape === "write" ? 19 : 11, valid.stderr);
          }
          for (const index of shape === "empty" ? ["0"] : ["2", "18446744073709551615"]) {
            const invalid = run(binary, [shape, index]);
            assert.equal(invalid.status, 73, `${mode}/${optimization}/${shape}/${index}: ${invalid.stderr}`);
            assert.equal(invalid.stderr, "");
          }
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
