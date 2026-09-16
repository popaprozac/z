import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, diagnostics, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-subclass-handoff.zs");
const source = readFileSync(fixture, "utf8");
const contract = resolve(directory, "objc-subclass.h.zd");
const cases: [string, string, RegExp][] = [
  ["field view", source.replace("const after = super.delegatedWrite(value);",
    "const held = view this.total; const after = super.delegatedWrite(value); if (held != after) return -9;"),
    /view.*(value storage|owner)|class-field projection requires locally contained ARC identity|receiver-field storage is borrowed/],
  ["field nullability", source.replace("const after = super.delegatedWrite(value);",
    "if (this.pending != null) { super.delegatedWrite(value); const read = this.pending.value(); } const after = super.delegatedWrite(value);"),
    /nullable|null.*(narrow|access)|narrow.*null/],
];

hostToolchainTest("keeps borrowed storage and nullable fields outside native superclass handoffs", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, fixture), []);
  for (const [name, candidate, expected] of cases) assert.throws(() => compileToNative(candidate, fixture), expected, name);
});

hostToolchainTest("delegates native superclass calls without dropping other loans or cleanup guards", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-subclass-handoff-"));
  try {
    symlinkSync(resolve(directory, "objc-subclass.h"), resolve(temporary, "objc-subclass.h"));
    symlinkSync(contract, resolve(temporary, "objc-subclass.h.zd"));
    const emittedOracle = spawnSync(process.execPath, [cli, "self-host-emit", resolve(directory, "self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emittedOracle.status, 0, emittedOracle.stderr);
    const oracle = resolve(temporary, "emitter");
    const oracleBuild = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      encoding: "utf8", input: emittedOracle.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(oracleBuild.status, 0, oracleBuild.stderr);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    const native = (candidate: string, corruption = "") => {
      writeFileSync(input, candidate);
      return spawnSync(oracle, [wire, input, "", contract, corruption], {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
    };
    const emitted = native(source);
    assert.equal(emitted.status, 0, emitted.stderr);
    for (const corruption of ["missing-lifetime", "wrong-lifetime"]) {
      const rejected = native(source, corruption);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /handoff.*(lost object lifetime evidence|object lifetime evidence disagrees)/);
    }
    for (const [compiler, output] of [["stage0", compileToNative(source, fixture).source], ["native", emitted.stdout]]) {
      assert.match(output, /_z_native_subclass_handoff_begin\(&_z_native_subclass_loan\)/);
      assert.match(output, /objc_precise_lifetime\)\) __strong id[^;]*_z_handoff_argument_0/);
      const generated = resolve(temporary, `${compiler}.m`);
      writeFileSync(generated, output);
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, "probe");
        const built = spawnSync("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-I", directory, "-framework", "Foundation", generated, resolve(directory, "objc-subclass.m"), "-o", executable], {
          encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, `${compiler} ${optimization}: ${built.stderr}`);
        // 0: repeated writer/reader delegation, value and void returns,
        //    conditional return, block/direct match arms, retained snapshot survives field replacement,
        //    ARC cleanup, and the last external owner released during reentry.
        // 1: restored guard; 2: argument evaluation; 3: local ARC destruction;
        // 4: another reader still active; 5: nested expression;
        // 6: safe receiver-as-object snapshot; 7: sender destructor reentry
        // after argument-temp cleanup (must happen AFTER guard reacquisition).
        // 8: nested super expression inside a match arm stays guarded;
        // 9: a match-arm handoff reacquires the guard before its next statement.
        for (let scenario = 0; scenario <= 9; scenario++) {
          const result = spawnSync(executable, [], {
            encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
            env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: String(scenario) },
          });
          assert.equal(result.error, undefined);
          assert.equal(result.signal, null);
          const succeeds = scenario === 0 || scenario === 6;
          assert.equal(result.status, succeeds ? 0 : 86, `${compiler} ${optimization} scenario ${scenario}: ${result.stderr}`);
          if (!succeeds) assert.match(result.stderr, /reentrant native subclass access conflicts with inout this/);
          else assert.doesNotMatch(result.stderr, /runtime error|UndefinedBehaviorSanitizer/);
        }
      }
    }
    for (const [name, candidate, expected] of cases) {
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, `${name}: ${rejected.stderr}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
