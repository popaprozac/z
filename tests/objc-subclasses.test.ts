import { assert, cli, compileToNative, completions, decodeSemanticTokens, diagnostics, hover, hostToolchainTest, mkdtempSync, positionForOffset, readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, semanticTokens, semanticTokenTypes, spawnSync, writeFileSync, projectRoot } from "./support/bootstrap.ts";
import { tmpdir } from "node:os";

const fixture = resolve(projectRoot, "tests/fixtures/objc-subclass.zs");
const baseline = `
import native from "./objc-subclass.h";
import { thread } from "std/thread";
class Counter extends native.ZSubclassFixture on thread.main {
  constructor(value: i32) { super.initWithValue(value); }
  override function value(): i32 as "value" { return super.value() + 2; }
}
function main(): i32 { const counter = new Counter(40); return counter.readVirtualValue() - 42; }
`;

hostToolchainTest("checks native subclass declarations using normalized Clang safety evidence", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync(resolve(tmpdir(), "z-subclass-wire-"));
  try {
    const decoder = resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-evidence.zs");
    const stream = resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null,
      header: "objc-subclass-wire.h",
      location: { fileName: decoder, offset: 0, line: 1, column: 1 },
    }], decoder, [resolve(projectRoot, "tests/fixtures")]).get("native")!;
    assert.match(stream, /^ZFDCL000000000000000e\n/);
    const emission = spawnSync(process.execPath, [cli, "self-host-emit", decoder], {
      encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const executable = resolve(directory, "decoder");
    const compilation = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
      encoding: "utf8", input: emission.stdout, timeout: 30_000,
    });
    assert.equal(compilation.status, 0, compilation.stderr);
    const input = resolve(directory, "declarations.zfdcl");
    const run = (source: string) => {
      writeFileSync(input, source);
      return spawnSync(executable, [input], { encoding: "utf8", timeout: 5_000 });
    };
    const result = run(stream);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const sourcePath = resolve(directory, "probe.zs");
    const nativeBaseline = baseline.replace("./objc-subclass.h", "objc-subclass-wire.h")
      .replaceAll("ZSubclassFixture", "ZWireBase")
      .replace("counter.readVirtualValue()", "counter.value()");
    const runDeclaration = (source: string, gate = false) => {
      writeFileSync(input, stream);
      writeFileSync(sourcePath, source);
      return spawnSync(executable, [input, sourcePath, ...(gate ? ["gate"] : [])], {
        encoding: "utf8", timeout: 5_000,
      });
    };
    for (const source of [nativeBaseline, nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireChild"),
      nativeBaseline.replace('return super.value() + 2;', 'return 42;')
        .replace('override function value()', 'override function observed()'),
      nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function sum(left: i32, right: i32): i32 as "add:to:" { return left + right; }'),
      nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function read(in object: native.ZWireBase): i32 as "readObject:" { return 0; }'),
    ]) {
      const checked = runDeclaration(source);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
    const gated = runDeclaration(nativeBaseline, true);
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(gated.stdout, /Z0814:.*native body ownership checking and emission/);
    const cases: [string, string, RegExp][] = [
      ["ordinary base", nativeBaseline.replace("native.ZWireBase", "Parent").replace("class Counter", "class Parent {}\nclass Counter"), /imported Objective-C class/],
      ["struct", nativeBaseline.replace("class Counter", "struct Counter"), /native Objective-C class declaration/],
      ["generic", nativeBaseline.replace("class Counter", "class Counter<T>"), /generic native subclasses/],
      ["affinity", nativeBaseline.replace(" on thread.main", ""), /must declare `on thread.main`/],
      ["state", nativeBaseline.replace("constructor(value", "stored: i32; constructor(value"), /state-lifetime tier/],
      ["deinit", nativeBaseline.replace("constructor(value", "deinit {} constructor(value"), /state-lifetime tier/],
      ["constructor", nativeBaseline.replace("constructor(value: i32) { super.initWithValue(value); }", ""), /explicit constructor/],
      ["first initializer", nativeBaseline.replace("{ super.initWithValue", "{ const before = 1; super.initWithValue"), /must begin/],
      ["throwing initializer", nativeBaseline.replace("constructor(value: i32)", "constructor(value: i32) throws i32"), /fallible native subclass construction/],
      ["borrowed argument", nativeBaseline.replace("constructor(value: i32)", "constructor(in value: i32)"), /constructor parameters must be scalar/],
      ["owned argument", nativeBaseline.replace("constructor(value: i32)", "constructor(value: String)"), /constructor parameters must be scalar/],
      ["override", nativeBaseline.replace("override function", "function"), /requires `override function`/],
      ["selector", nativeBaseline.replace(' as "value"', ""), /explicit `as/],
      ["async", nativeBaseline.replace("override function", "override async function"), /synchronous, non-throwing/],
      ["static", nativeBaseline.replace("override function", "override static function"), /synchronous, non-throwing/],
      ["throwing", nativeBaseline.replace('i32 as "value"', 'i32 throws i32 as "value"'), /synchronous, non-throwing/],
      ["final", nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireFinal"), /forbids subclassing/],
      ["unisolated", nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireUnisolated"), /main-executor contract/],
      ["unknown selector", nativeBaseline.replace('as "value"', 'as "missing"'), /no inherited.*selector/],
      ["wrong return", nativeBaseline.replace('value(): i32 as', 'value(): i64 as'), /returns i32.*returns i64/],
      ["wrong arity", nativeBaseline.replace('value(): i32 as', 'value(extra: i32): i32 as'), /expects 0 parameter/],
      ["wrong parameter type", nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function sum(left: i64, right: i32): i32 as "add:to:" { return 0; }'), /parameter 1 expects i32, found i64/],
      ["wrong scalar capability", nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function sum(in left: i32, right: i32): i32 as "add:to:" { return 0; }'), /incompatible passing capability/],
      ["owned object parameter", nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function read(object: native.ZWireBase): i32 as "readObject:" { return 0; }'), /incompatible passing capability/],
      ["requires super", nativeBaseline.replace('as "value"', 'as "requiredValue"'), /superclass-call path validation/],
      ["direct", nativeBaseline.replace('as "value"', 'as "directValue"'), /direct Objective-C method cannot be overridden/],
      ["unrepresentable direct", nativeBaseline.replace('as "value"', 'as "extendedValue"'), /direct Objective-C method cannot be overridden/],
      ["inherited direct", nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireChild").replace('as "value"', 'as "directValue"'), /direct Objective-C method cannot be overridden/],
      ["consuming self", nativeBaseline.replace('as "value"', 'as "consume"'), /consuming native override ownership/],
      ["consuming parameter", nativeBaseline.replace('as "value"', 'as "takeIndex:object:"'), /consuming native override ownership/],
      ["variadic", nativeBaseline.replace('as "value"', 'as "log:"'), /variadic and block-receiving/],
      ["lifecycle", nativeBaseline.replace('as "value"', 'as "dealloc"'), /lifecycle or runtime selector/],
      ["non-designated", nativeBaseline.replace("super.initWithValue(value)", "super.value()"), /designated `init`/],
      ["nullable", nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireNullable")
        .replace('override function value(): i32 as "value" { return super.value() + 2; }', ""), /nullable superclass initializers/],
      ["duplicate selector", nativeBaseline.replace('return super.value() + 2; }', 'return super.value() + 2; } override function other(): i32 as "value" { return 0; }'), /duplicate native override selector/],
      ["override without base", nativeBaseline.replace(" extends native.ZWireBase", ""), /`override` requires an imported/],
    ];
    for (const [name, source, expected] of cases) {
      const checked = runDeclaration(source);
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /Z0814/, name);
      assert.match(checked.stdout, expected, name);
    }
    const obsolete = run(stream.replace("ZFDCL000000000000000e", "ZFDCL000000000000000d"));
    assert.equal(obsolete.status, 1, obsolete.stderr);
    assert.match(obsolete.stdout, /unsupported foreign declaration stream version 13/);
    // Skip the J record's owner, indices, selector, and base name, then its
    // instance/instancetype booleans. The next byte is the new initializer fact.
    let flagOffset = stream.indexOf("\nJ") + 2;
    const skipText = () => { flagOffset += 16 + Number.parseInt(stream.slice(flagOffset, flagOffset + 16), 16); };
    skipText();
    flagOffset += 32;
    skipText();
    skipText();
    flagOffset += 2;
    assert.match(stream[flagOffset], /[01]/);
    const invalidFlag = run(stream.slice(0, flagOffset) + "2" + stream.slice(flagOffset + 1));
    assert.equal(invalidFlag.status, 1, invalidFlag.stderr);
    assert.match(invalidFlag.stdout, /invalid boolean/);
    const truncated = run(stream.slice(0, stream.indexOf("\nJ") + 8));
    assert.equal(truncated.status, 1, truncated.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("surfaces native subclass identity, overrides, and superclass members in the editor", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(baseline, fixture), []);
  const tokens = decodeSemanticTokens(semanticTokens(baseline, fixture).data);
  for (const word of ["extends", "override", "super"]) {
    const offset = baseline.indexOf(word);
    const position = positionForOffset(baseline, offset);
    assert.ok(tokens.some((token) => token.line === position.line && token.character === position.character
      && token.length === word.length && semanticTokenTypes[token.type] === "keyword"), word);
    assert.ok(hover(baseline, fixture, offset + 1)?.contents.value.includes(word), word);
  }
  assert.match(hover(baseline, fixture, baseline.indexOf("Counter") + 1)?.contents.value ?? "", /class Counter extends native.ZSubclassFixture/);
  assert.match(hover(baseline, fixture, baseline.indexOf("function value") + 10)?.contents.value ?? "", /override function value.*as "value"/);
  const superOffset = baseline.indexOf("super.value") + "super.v".length;
  assert.ok(completions(baseline, fixture, superOffset).some((item) => item.label === "value"));
  assert.match(hover(baseline, fixture, baseline.indexOf("super.value") + 7)?.contents.value ?? "", /value\(\): i32/);
  const inheritedOffset = baseline.indexOf("counter.readVirtualValue") + "counter.read".length;
  assert.ok(completions(baseline, fixture, inheritedOffset).some((item) => item.label === "readVirtualValue"));
  const grammar = JSON.parse(readFileSync(resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"), "utf8"));
  for (const [name, source] of [["storage.modifier.override.z", "override function value"], ["keyword.control.inheritance.z", "extends native.Base"], ["variable.language.super.z", "super.value()"]]) {
    const pattern = grammar.repository.keywords.patterns.find((item: { name?: string }) => item.name === name);
    assert.ok(pattern && new RegExp(pattern.match).test(source), name);
  }
}, 60_000);

hostToolchainTest("rejects unsupported native subclass construction, effects, and lifecycle shapes", () => {
  if (process.platform !== "darwin") return;
  const cases: [string, string, RegExp][] = [
    ["ordinary inheritance", baseline.replace("native.ZSubclassFixture", "Parent").replace("class Counter", "class Parent {}\nclass Counter"), /imported Objective-C class/],
    ["struct inheritance", baseline.replace("class Counter", "struct Counter"), /native Objective-C class declaration/],
    ["missing affinity", baseline.replace(" on thread.main", ""), /must declare `on thread.main`/],
    ["stored state", baseline.replace("constructor(value", "stored: i32; constructor(value"), /state-lifetime tier/],
    ["deinit", baseline.replace("constructor(value", "deinit {} constructor(value"), /state-lifetime tier/],
    ["missing constructor", baseline.replace("constructor(value: i32) { super.initWithValue(value); }", ""), /explicit constructor/],
    ["non-first init", baseline.replace("{ super.initWithValue", "{ const before = 1; super.initWithValue"), /must begin/],
    ["double init", baseline.replace("super.initWithValue(value);", "super.initWithValue(value); super.initWithValue(value);"), /exactly once/],
    ["uninitialized receiver", baseline.replace("super.initWithValue(value)", "super.initWithValue(this.value())"), /before superclass initialization/],
    ["non-designated init", baseline.replace("super.initWithValue(value)", "super.init()"), /designated `init`/],
    ["nullable init", baseline.replace("native.ZSubclassFixture", "native.ZNullableSubclassFixture").replace('override function value(): i32 as "value" { return super.value() + 2; }', ""), /nullable superclass initializers/],
    ["early return", baseline.replace("super.initWithValue(value);", "super.initWithValue(value); return;"), /must fall through/],
    ["constructor borrow", baseline.replace("constructor(value: i32)", "constructor(in value: i32)"), /constructor parameters must be scalar/],
    ["owned parameter", baseline.replace("constructor(value: i32)", "constructor(value: String)"), /constructor parameters must be scalar/],
    ["missing override", baseline.replace("override function", "function"), /requires `override function`/],
    ["missing selector", baseline.replace(' as "value"', ""), /explicit `as/],
    ["unknown selector", baseline.replace('as "value"', 'as "missing"'), /no inherited.*selector/],
    ["wrong ABI", baseline.replace('value(): i32 as', 'value(): i64 as'), /returns i32.*returns i64/],
    ["wrong arity", baseline.replace('value(): i32 as', 'value(extra: i32): i32 as'), /expects 0 parameter/],
    ["async override", baseline.replace("override function", "override async function"), /synchronous, non-throwing/],
    ["throwing override", baseline.replace('i32 as "value"', 'i32 throws i32 as "value"'), /synchronous, non-throwing/],
    ["static override", baseline.replace("override function", "override static function"), /synchronous, non-throwing/],
    ["restricted base", baseline.replace("native.ZSubclassFixture", "native.ZFinalSubclassFixture"), /forbids subclassing/],
    ["required super", baseline.replace('as "value"', 'as "requiredValue"'), /superclass-call path validation/],
    ["direct method", baseline.replace('as "value"', 'as "directValue"'), /direct Objective-C method cannot be overridden/],
    ["consuming argument", baseline.replace('as "value"', 'as "takeObject:"'), /consuming native override ownership/],
    ["implicit receiver shadow", baseline.replace("constructor(value: i32)", "constructor(self: i32)"), /cannot be shadowed/],
    ["raw generated identity", baseline + '\nfunction bypass(): i32 = raw objc { return [ZNative_Counter new] != nil; }\n', /compiler-owned symbol/],
    ["lifecycle override", baseline.replace('as "value"', 'as "dealloc"'), /lifecycle or runtime selector/],
    ["manual release", baseline.replace("return super.value() + 2;", "super.release(); return 42;"), /ARC lifecycle methods/],
    ["super value", baseline.replace("return super.value() + 2;", "const base = super; return 42;"), /direct receiver/],
    ["captured super", baseline.replace("return super.value() + 2;", "const callback = (): i32 => super.value(); return callback();"), /cannot be captured/],
    ["reinit after construction", baseline.replace("return counter.readVirtualValue() - 42;", "counter.initWithValue(1); return 0;"), /checked constructor/],
    ["native weak", baseline.replace("return counter.readVirtualValue() - 42;", "const observed = weak counter; return 0;"), /native weak-reference tier/],
    ["async composition", baseline.replace("function main", "async function main"), /cannot compose with async lowering/],
  ];
  for (const [name, source, expected] of cases) {
    assert.throws(() => compileToNative(source, fixture), expected, name);
  }
}, 60_000);

hostToolchainTest("keeps subclass vocabulary contextual for ordinary Z bindings", () => {
  const source = `
    class Reader { function value(): i32 { return 42; } }
    function main(): i32 {
      const super = new Reader({});
      const override = 0;
      const extends = 0;
      return super.value() + override + extends - 42;
    }
  `;
  assert.doesNotThrow(() => compileToNative(source, "/tmp/contextual-subclass-words.zs"));
});

hostToolchainTest("compiles an actual AppKit subclass without launching an application", () => {
  if (process.platform !== "darwin") return;
  const source = `
    import AppKit from "AppKit/AppKit.h";
    import { thread } from "std/thread";
    class SmoothWindow extends AppKit.NSWindow on thread.main {
      constructor(frame: AppKit.NSRect) {
        super.initWithContentRect(frame, styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskResizable,
          backing: AppKit.NSBackingStoreBuffered, defer: false);
        this.releasedWhenClosed = false;
      }
      override function animationResizeTime(frame: AppKit.NSRect): f64 as "animationResizeTime:" {
        return super.animationResizeTime(frame);
      }
    }
    function main(): i32 { return 0; }
  `;
  const artifact = compileToNative(source, "/tmp/z-subclass-appkit.zs");
  assert.match(artifact.source, /@interface ZNative_.* : NSWindow/);
  const built = spawnSync("xcrun", ["clang", "-x", "objective-c", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], { input: artifact.source, encoding: "utf8", timeout: 30_000 });
  assert.equal(built.status, 0, built.stderr);
}, 60_000);

hostToolchainTest("executes a field-free native subclass with true virtual and superclass dispatch", () => {
  if (process.platform !== "darwin") return;
  const file = resolve(projectRoot, "tests/fixtures/objc-subclass.zs");
  const artifact = compileToNative(readFileSync(file, "utf8"), file);
  assert.match(artifact.source, /@interface ZNative_.* : ZSubclassFixture/);
  assert.match(artifact.source, /\[super value\]/);
  assert.match(artifact.source, /self = \[super initWithValue:value\]/);
  assert.doesNotMatch(artifact.source, /Z_Counter.*_z_refcount/);
  const directory = mkdtempSync(resolve(tmpdir(), "z-native-subclass-"));
  try {
    const generated = resolve(directory, "main.m");
    const executable = resolve(directory, "probe");
    writeFileSync(generated, artifact.source);
    const built = spawnSync("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", resolve(projectRoot, "tests/fixtures"), "-framework", "Foundation", generated, resolve(projectRoot, "tests/fixtures/objc-subclass.m"), "-o", executable], { encoding: "utf8", timeout: 30_000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
