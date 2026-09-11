import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, diagnostics, hostToolchainTest, readFileSync, resolve, projectRoot,
  hover, completions, mkdtempSync, rmSync, spawnSync, writeFileSync, resolveForeignFunctionDeclarationStreams,
  decodeSemanticTokens, semanticTokens, semanticTokenTypes, positionForOffset,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-object.zs");
const source = readFileSync(fixture, "utf8");
const contract = resolve(directory, "objc-object.h.zd");
const aliased = source.replaceAll("objc.Object", "bridge.Object").replace('import objc from', 'import bridge from');
const modular = `import { NativeObject, identity } from "./objc-object-model.zs";\n${source}`
  .replace('function identity(in value: objc.Object): objc.Object {\n  return value;\n}', '')
  .replace('const retained: objc.Object', 'const retained: NativeObject');
const stored = source.replace('function main()', 'struct Holder { object: objc.Object | null; }\nfunction main()')
  .replace('const value: objc.Object | null = native.ZObjectSource.text();',
    'const holder = Holder({ object: native.ZObjectSource.text() }); const value: objc.Object | null = holder.object;');
const shadowed = source.replace('function main()', 'class id { value: i32; }\nfunction main()')
  .replace('native.ZObjectSource.accept(value);', 'native.ZObjectSource.accept(value); const local = new id({ value: 42 }); if (local.value != 42) return 8;');
const subclassSource = `import { thread } from "std/thread";\n${source}`.replace('function main()', `
class Inspector extends native.ZObjectBase on thread.main {
  constructor(marker: i32) { super.initWithMarker(marker); }
  override function inspect(inout this, in sender: objc.Object | null): i32 as "inspect:" {
    return super.inspect(sender);
  }
}
function main()`).replace('native.ZObjectSource.accept(value);', `
  native.ZObjectSource.accept(value);
  const inspector = new Inspector(0);
  if (inspector.inspect(value) != 7) return 6;`);
const cases: [string, string, RegExp][] = [
  ["nullable to nonnull", source.replace('if (value == null) return 1;', ''), /nullable|expected.*Object|expected.*id|expected a non-null/],
  ["number is not an object", source.replace('native.ZObjectSource.text()', '42'), /expected.*(Object|id).*found i32/],
  ["native parameter displays public type", source.replace('native.ZObjectSource.accept(value);', 'native.ZObjectSource.accept(42);'), /expect(?:ed|s).*objc.Object.*found i32/],
  ["String is not an object", source.replace('native.ZObjectSource.text()', '"hello"'), /expected.*(Object|id).*found String/],
  ["Z class is not an object", source.replace('function main()', 'class Local { count: i32; }\nfunction main()').replace('native.ZObjectSource.text()', 'new Local({ count: 1 })'), /expected.*(Object|id).*found.*Local/],
  ["Z struct is not an object", source.replace('function main()', 'struct Local { count: i32; }\nfunction main()').replace('native.ZObjectSource.text()', 'Local({ count: 1 })'), /expected.*Object.*found.*Local/],
  ["native record is not an object", source.replace('native.ZObjectSource.text()', 'native.ZObjectRecord({ value: 42 })'), /expected.*Object.*found.*ZObjectRecord/],
  ["source id is not native id", shadowed.replace('native.ZObjectSource.text()', 'new id({ value: 42 })'), /expected.*Object.*found.*id/],
  ["no arbitrary members", source.replace('native.ZObjectSource.accept(value);', 'value.description();'), /method|member|receiver/],
  ["not constructible", source.replace('native.ZObjectSource.proxy()', 'new objc.Object()'), /constructor|class|new|Object/],
  ["not a generic", source.replace('in value: objc.Object)', 'in value: objc.Object<i32>)'), /generic|type|Object/],
  ["narrow before String copy", source.replace('function identity(in value: objc.Object): objc.Object {\n  return value;', 'function identity(in value: objc.Object): objc.Object {\n  const text: String = value; return value;'), /expected String/],
  ["not transferable", source.replace('import objc', 'import { thread } from "std/thread";\nimport objc').replace('function main()', 'async function main()').replace('native.ZObjectSource.accept(value);', 'const worker = thread.spawn(move (): i32 => textLength(value)); const count = await worker;'), /transfer|capture.*(thread|value)/],
  ["not shareable", source.replace('import objc', 'import { thread } from "std/thread";\ntype Handler = () => i32 on thread.any;\nimport objc')
    .replace('native.ZObjectSource.accept(value);', 'const handler: Handler = move (): i32 => textLength(value);'), /capture.*(thread|shareable)/],
  ["no aggregate thread escape", stored.replace('import objc', 'import { thread } from "std/thread";\nimport objc')
    .replace('function main()', 'async function main()').replace('native.ZObjectSource.accept(value);', 'const worker = thread.spawn(move (): i32 => textLength(holder.object)); const count = await worker;'), /transfer|capture|ownership-bearing/],
];

hostToolchainTest("names erased native Objective-C identity without boxing or losing nullability", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, fixture), []);
  const emitted = compileToNative(source, fixture).source;
  assert.match(emitted, /id identity\(id value\)/);
  assert.doesNotMatch(emitted, /NSObject \*.*\bvalue\b/);
  assert.deepEqual(diagnostics(aliased, fixture), []);
  assert.deepEqual(diagnostics(modular, fixture), []);
  assert.deepEqual(diagnostics(stored, fixture), []);
  assert.deepEqual(diagnostics(shadowed, fixture), []);
  assert.deepEqual(diagnostics(subclassSource, fixture), []);
  assert.doesNotMatch(compileToNative(subclassSource, fixture).source, /_z_native_subclass_handoff_begin\(&_z_native_subclass_loan\)/);
  const memberOffset = source.indexOf("objc.Object") + "objc.".length;
  assert.match(hover(source, fixture, memberOffset + 2)?.contents.value ?? "", /native Objective-C id/);
  const choices = completions(source, fixture, memberOffset);
  assert.equal(choices.find((entry) => entry.label === "Object")?.insertText, "Object");
  const position = positionForOffset(source, memberOffset);
  const tokens = decodeSemanticTokens(semanticTokens(source, fixture).data);
  assert.ok(tokens.some((token) => token.line === position.line && token.character === position.character
    && token.length === 6 && semanticTokenTypes[token.type] === "class"));
  const before = source.indexOf("value == null");
  const after = source.indexOf("value);", source.indexOf("native.ZObjectSource.accept(value)"));
  assert.match(hover(source, fixture, before + 1)?.contents.value ?? "", /value: objc.Object \| null/);
  assert.match(hover(source, fixture, after + 1)?.contents.value ?? "", /value: objc.Object/);
  assert.doesNotMatch(hover(source, fixture, after + 1)?.contents.value ?? "", /\| null|__z_objc/);
  for (const [label, candidate, expected] of cases) assert.throws(() => compileToNative(candidate, fixture), expected, label);
});

hostToolchainTest("keeps erased identity checked through the hybrid native frontend", () => {
  if (process.platform !== "darwin") return;
  const checked = spawnSync(process.execPath, [cli, "check", resolve(projectRoot, "examples/interop/objc/erased-object.zs"), "--native-frontend"], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL",
  });
  assert.equal(checked.status, 0, checked.stderr);
}, 180_000);

hostToolchainTest("executes erased objects through independent native lowering and ARC at O0/O2", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-objc-object-"));
  try {
    symlinkSync(resolve(directory, "objc-object.h"), resolve(temporary, "objc-object.h"));
    symlinkSync(contract, resolve(temporary, "objc-object.h.zd"));
    const emittedOracle = spawnSync(process.execPath, [cli, "self-host-emit", resolve(directory, "self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emittedOracle.status, 0, emittedOracle.stderr);
    const oracle = resolve(temporary, "emitter");
    const builtOracle = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      encoding: "utf8", input: emittedOracle.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(builtOracle.status, 0, builtOracle.stderr);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-object.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    const companion = resolve(temporary, "objc-object-model.zs");
    writeFileSync(companion, readFileSync(resolve(directory, "objc-object-model.zs"), "utf8"));
    const native = (candidate: string) => {
      writeFileSync(input, candidate);
      return spawnSync(oracle, [wire, input, candidate === modular ? companion : "", contract], {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
    };
    for (const candidate of [source, aliased, modular, stored, shadowed, subclassSource]) {
      const emitted = native(candidate);
      assert.equal(emitted.status, 0, emitted.stderr);
      if (candidate === subclassSource) assert.doesNotMatch(emitted.stdout, /_z_native_subclass_handoff_begin\(&_z_native_subclass_loan\)/);
      for (const [compiler, output] of [["stage0", compileToNative(candidate, fixture).source], ["native", emitted.stdout]]) {
        const generated = resolve(temporary, `${compiler}.m`);
        writeFileSync(generated, output);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "probe");
          const built = spawnSync("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
            "-I", directory, "-framework", "Foundation", generated, "-o", executable], {
            encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
          });
          assert.equal(built.status, 0, `${compiler}: ${built.stderr}`);
          const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
          assert.equal(result.status, 0, `${compiler}: ${result.stderr}`);
          assert.doesNotMatch(result.stderr, /runtime error|UndefinedBehaviorSanitizer/);
        }
      }
    }
    for (const [label, candidate, expected] of cases) {
      const rejected = native(candidate);
      assert.notEqual(rejected.status, 0, label);
      assert.match(rejected.stderr, expected, `${label}: ${rejected.stderr}`);
      assert.doesNotMatch(rejected.stderr, /__z_objc:/);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 180_000);
