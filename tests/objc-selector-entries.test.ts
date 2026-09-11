import { tmpdir } from "node:os";
import { assert, cli, compileToNative, diagnostics, hover, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-selector-entries.zs");
const source = readFileSync(fixture, "utf8");

hostToolchainTest("shows new native entry selectors and lifecycle requirements in hover", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, fixture), []);
  assert.match(hover(source, fixture, source.indexOf("function receive") + 10)?.contents.value ?? "", /function receive.*as "receive:"/);
  assert.match(hover(source, fixture, source.indexOf("class Receiver") + 8)?.contents.value ?? "", /new callback entries trap outside Ready/);
});

hostToolchainTest("executes new native selector entries with Ready, main, and exclusivity guards in both compilers", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-selector-entries-"));
  try {
    const stage0 = compileToNative(source, fixture).source;
    const oracleSource = resolve(directory, "self-host-objc-subclass-execution.zs");
    const emission = spawnSync(process.execPath, [cli, "self-host-emit", oracleSource], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const oracle = resolve(temporary, "emitter");
    const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      encoding: "utf8", input: emission.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(built.status, 0, built.stderr);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    const native = (text: string) => {
      writeFileSync(input, text);
      return spawnSync(oracle, [wire, input], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    };
    const emitted = native(source);
    assert.equal(emitted.status, 0, emitted.stderr);
    const aliases = source.replace("value: i32): i32 as", "value: Delta): i32 as")
      .replace("in object: native.ZSubclassFixture", "in object: NativeReceiver")
      + "\ntype Delta = i32; type NativeReceiver = native.ZSubclassFixture;";
    assert.doesNotThrow(() => compileToNative(aliases, fixture));
    const aliasEmission = native(aliases);
    assert.equal(aliasEmission.status, 0, aliasEmission.stderr);
    for (const [label, text] of [["stage0", stage0], ["native", emitted.stdout], ["native-aliases", aliasEmission.stdout]]) {
      assert.match(text, /native callback entered before Ready or during teardown/);
      assert.doesNotMatch(text, /\[super (?:receive:|readFrom:|titleSize\])/);
      const generated = resolve(temporary, `${label}.m`);
      writeFileSync(generated, text);
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, "probe");
        const compilation = spawnSync("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", directory, "-framework", "Foundation",
          generated, resolve(directory, "objc-subclass.m"), "-o", executable], {
          encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compilation.status, 0, `${label}: ${compilation.stderr}`);
        for (const scenario of [0, 1, 2, 3, 4]) {
          const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
            env: { ...process.env, Z_SUBCLASS_ENTRY_SCENARIO: String(scenario), Z_SUBCLASS_ACCESS_SCENARIO: "0" },
          });
          assert.equal(result.status, scenario === 0 ? 0 : 86, `${label} ${optimization} scenario ${scenario}: ${result.stderr} ${result.signal}`);
          assert.equal(result.signal, null);
          if (scenario === 1 || scenario === 2) assert.match(result.stderr, /before Ready or during teardown/);
          if (scenario === 3) assert.match(result.stderr, /reentrant native subclass access/);
        }
      }
    }
    const cases: [string, string, RegExp][] = [
      ["missing override", source.replace('as "titleSize"', 'as "value"'), /requires `override function`/],
      ["nonexistent override", source.replace("function receive", "override function receive"), /no inherited/],
      ["selector arity", source.replace('as "receive:"', 'as "receive:extra:"'), /labels.*parameter count/],
      ["malformed selector", source.replace('as "receive:"', 'as "receive::"'), /labels.*parameter count/],
      ["scalar borrow", source.replace("value: i32): i32 as", "in value: i32): i32 as"), /passing/],
      ["object ownership", source.replace("in object:", "object:"), /passing/],
      ["nullable parameter", source.replace("in object: native.ZSubclassFixture", "in object: native.ZSubclassFixture | null"), /new native entries support/],
      ["object return", source.replace('titleSize(): usize', 'titleSize(): native.ZSubclassFixture'), /new native entries support/],
      ["aggregate parameter", source.replace("value: i32): i32 as", "value: native.ZSubclassPoint): i32 as"), /new native entries support/],
      ["throwing entry", source.replace('i32 as "receive:"', 'i32 throws i32 as "receive:"'), /synchronous, non-throwing/],
      ["shared mutation", source.replace("receive(inout this,", "receive("), /immutable|inout this|borrowed/],
      ["mismatched numeric alias", aliases.replace("type Delta = i32", "type Delta = i64"), /matching numeric|i64.*i32|i32.*i64|expected i32, found Delta/],
    ];
    for (const [name, candidate, expected] of cases) {
      assert.throws(() => compileToNative(candidate, fixture), expected, `Stage 0: ${name}`);
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, `${name}: ${rejected.stderr}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
