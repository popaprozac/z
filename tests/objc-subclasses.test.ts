import { assert, compileToNative, completions, decodeSemanticTokens, diagnostics, hover, hostToolchainTest, mkdtempSync, positionForOffset, readFileSync, resolve, rmSync, semanticTokens, semanticTokenTypes, spawnSync, writeFileSync, projectRoot } from "./support/bootstrap.ts";
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
