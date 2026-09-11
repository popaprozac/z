import { assert, cli, compileToNative, completions, decodeSemanticTokens, diagnostics, hover, hostToolchainTest, mkdtempSync, positionForOffset, readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, semanticTokens, semanticTokenTypes, spawnSync, writeFileSync, projectRoot } from "./support/bootstrap.ts";
import { tmpdir } from "node:os";
import { prepareProject } from "../compiler/src/project.ts";

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
    assert.match(stream, /^ZFDCL000000000000000f\n/);
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
    const runDeclaration = (source: string, mode: false | true | "types" | "plans" | "interfaces" | "missing-super" | "wrong-dispatch" | "wrong-abi" | "missing-access" | "wrong-access" = false) => {
      writeFileSync(input, stream);
      writeFileSync(sourcePath, source);
      return spawnSync(executable, [input, sourcePath, ...(mode ? [mode === true ? "gate" : mode] : [])], {
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
    assert.equal(gated.status, 0, gated.stdout + gated.stderr);
    const invalidBeforeGate = runDeclaration(nativeBaseline.replace("super.initWithValue(value)", 'super.initWithValue("bad")'), true);
    assert.equal(invalidBeforeGate.status, 1, invalidBeforeGate.stdout + invalidBeforeGate.stderr);
    assert.match(invalidBeforeGate.stdout, /i32.*String|String.*i32/);
    assert.doesNotMatch(invalidBeforeGate.stdout, /execution still requires/);
    const typed = runDeclaration(nativeBaseline, "types");
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    assert.match(typed.stdout, /objcSuperInitializer:initWithValue::native.ZWireBase/);
    assert.match(typed.stdout, /objcSuper:value:i32/);
    const planned = runDeclaration(nativeBaseline, "plans");
    assert.equal(planned.status, 0, planned.stdout + planned.stderr);
    assert.match(planned.stdout, /class Counter:ZNative_0_Counter:ZWireBase:objc-subclass-wire.h/);
    assert.match(planned.stdout, /initializer initZGeneratedWithArgument0::instancetype/);
    for (const mode of ["missing-access", "wrong-access"] as const) {
      const rejected = runDeclaration(nativeBaseline, mode);
      assert.equal(rejected.status, 1, `${mode}: ${rejected.stdout}${rejected.stderr}`);
      assert.match(rejected.stdout, /Z0814:.*lost checked receiver access evidence/);
    }
    assert.match(planned.stdout, /argument int32_t/);
    assert.match(planned.stdout, /entry value:value:int/);
    assert.match(planned.stdout, /dispatch true:initWithValue:/);
    assert.match(planned.stdout, /dispatch false:value:int/);
    for (const mode of ["missing-super", "wrong-dispatch", "wrong-abi"] as const) {
      const rejected = runDeclaration(nativeBaseline, mode);
      assert.equal(rejected.status, 1, `${mode}: ${rejected.stdout}${rejected.stderr}`);
      assert.match(rejected.stdout, /Z0814:.*(typed|ABI).*superclass|Z0814:.*superclass.*(typed|ABI)/);
    }
    const interfaces = runDeclaration(nativeBaseline, "interfaces");
    assert.equal(interfaces.status, 0, interfaces.stdout + interfaces.stderr);
    assert.match(interfaces.stdout, /@interface ZNative_0_Counter : ZWireBase/);
    assert.match(interfaces.stdout, /initWithValue:.*unavailable/);
    assert.match(interfaces.stdout, /initZGeneratedWithArgument0:.*objc_designated_initializer/);
    assert.doesNotMatch(interfaces.stdout, /Z_Counter|z_refcount|@implementation/);
    const checkInterfaces = (source: string) => {
      const checked = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fsyntax-only",
        "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "tests/fixtures"), "-"], {
        encoding: "utf8", input: '#include <stdint.h>\n#include <stdbool.h>\n#import "objc-subclass-wire.h"\n' + source,
        timeout: 10_000,
      });
      assert.equal(checked.status, 0, checked.stderr);
    };
    checkInterfaces(interfaces.stdout);
    const entryShapes = [
      nativeBaseline.replace("extends native.ZWireBase", "extends native.ZWireChild"),
      nativeBaseline.replace("constructor(value: i32) { super.initWithValue(value); }", "constructor() { super.initWithValue(40); }"),
      nativeBaseline.replace("constructor(value: i32)", "constructor(value: i32, point: native.ZWirePoint, choice: native.ZWireChoice, flag: boolean)"),
      nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function sum(left: i32, right: i32): i32 as "add:to:" { return super.add(left, to: right); }'),
      nativeBaseline.replace('override function value(): i32 as "value" { return super.value() + 2; }',
        'override function read(in object: native.ZWireBase): i32 as "readObject:" { return object.value(); }'),
      nativeBaseline.replace('override function value()', 'override function observed()'),
      nativeBaseline.replace('function main()', 'class Other extends native.ZWireBase on thread.main { constructor(value: i32) { super.initWithValue(value); } }\nfunction main()'),
    ];
    for (const [index, source] of entryShapes.entries()) {
      const emitted = runDeclaration(source, "interfaces");
      assert.equal(emitted.status, 0, `entry ${index} (${emitted.signal}, ${emitted.error}): ${emitted.stdout}${emitted.stderr}`);
      checkInterfaces(emitted.stdout);
    }
    const recordEntry = runDeclaration(entryShapes[2]!, "interfaces");
    assert.match(recordEntry.stdout, /argument1:\(ZWirePoint\)point/);
    assert.match(recordEntry.stdout, /argument2:\(ZWireChoice\)choice/);
    assert.match(recordEntry.stdout, /argument3:\(bool\)flag/);
    const borrowedEntry = runDeclaration(entryShapes[4]!, "interfaces");
    assert.match(borrowedEntry.stdout, /readObject:\(ZWireBase \*\)object/);
    assert.doesNotMatch(borrowedEntry.stdout, /ZWireBase \*\*/);
    const renamedEntry = runDeclaration(entryShapes[5]!, "interfaces");
    assert.match(renamedEntry.stdout, /- \(int\)value;/);
    assert.doesNotMatch(renamedEntry.stdout, /observed/);
    const cases: [string, string, RegExp][] = [
      ["ordinary base", nativeBaseline.replace("native.ZWireBase", "Parent").replace("class Counter", "class Parent {}\nclass Counter"), /imported Objective-C class/],
      ["struct", nativeBaseline.replace("class Counter", "struct Counter"), /native Objective-C class declaration/],
      ["generic", nativeBaseline.replace("class Counter", "class Counter<T>"), /generic native subclasses/],
      ["affinity", nativeBaseline.replace(" on thread.main", ""), /must declare `on thread.main`/],
      ["state", nativeBaseline.replace("constructor(value", "stored: i32; constructor(value"), /must be private/],
      ["dying receiver", nativeBaseline.replace("constructor(value", "deinit { const alias = this; } constructor(value"), /dying receiver/],
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
    const constructorTail = (body: string) => nativeBaseline.replace(
      "super.initWithValue(value);", `super.initWithValue(value); ${body}`,
    );
    const overrideBody = (body: string) => nativeBaseline.replace("return super.value() + 2;", body);
    const bodyCases: [string, string, RegExp][] = [
      ["double initialization", constructorTail("super.initWithValue(value);"), /exactly once/],
      ["conditional initialization", constructorTail("if (value == 0) { super.initWithValue(value); }"), /exactly once/],
      ["match initialization", constructorTail("match (Option<i32>.some(value)) { some(item) => { super.initWithValue(item); } none => {} }"), /exactly once/],
      ["expression initialization", constructorTail("const observed = if (value == 0) { super.initWithValue(value); select 0; } else { select 1; };"), /exactly once/],
      ["method initialization", overrideBody("super.initWithValue(42); return 42;"), /exactly once/],
      ["early receiver", nativeBaseline.replace("super.initWithValue(value)", "super.initWithValue(this.value())"), /before superclass initialization/],
      ["early super", nativeBaseline.replace("super.initWithValue(value)", "super.initWithValue(super.value())"), /before superclass initialization/],
      ["early closure receiver", nativeBaseline.replace("super.initWithValue(value)", "super.initWithValue(((): i32 => this.value())())"), /before superclass initialization/],
      ["early expression receiver", nativeBaseline.replace("super.initWithValue(value)", "super.initWithValue(if (true) { select this.value(); } else { select value; })"), /before superclass initialization/],
      ["constructor return", constructorTail("return;"), /must fall through/],
      ["conditional return", constructorTail("if (value == 0) return;"), /must fall through/],
      ["match return", constructorTail("match (Option<i32>.some(value)) { some(item) => return; none => {} }"), /must fall through/],
      ["expression return", constructorTail("const observed = if (value == 0) { return; } else { select 1; };"), /must fall through/],
      ["match expression return", constructorTail("const observed = match (Option<i32>.some(value)) { some(item) => return; none => 0; };"), /must fall through/],
      ["bare super", overrideBody("const observed = super; return 42;"), /direct receiver/],
      ["extracted super method", overrideBody("const callback = super.value; return 42;"), /direct receiver/],
      ["super expression closure", overrideBody("const callback = (): i32 => super.value(); return callback();"), /cannot be captured/],
      ["super block closure", overrideBody("const callback = (): i32 => { return super.value(); }; return callback();"), /cannot be captured/],
      ["super nested closure", overrideBody("const callback = (): i32 => { const inner = (): i32 => super.value(); return inner(); }; return callback();"), /cannot be captured/],
      ["direct receiver capture", overrideBody("const callback: () => i32 on thread.main = move (): i32 => this.value(); return callback();"), /capturing `this`/],
      ["receiver capture without dispatch", overrideBody("const callback: () => i32 = move (): i32 => { const alias = this; return 42; }; return callback();"), /capturing `this`/],
      ["nested receiver capture", overrideBody("const callback = (): i32 => { const inner = (): i32 => { const alias = this; return 42; }; return inner(); }; return callback();"), /capturing `this`/],
      ["constructor receiver capture", constructorTail("const callback = (): i32 => { const alias = this; return 42; }; const observed = callback();"), /capturing `this`/],
      ["constructor closure initialization", constructorTail("const callback = (): void => { super.initWithValue(value); }; callback();"), /cannot be captured/],
      ["constructor parameter shadow", nativeBaseline.replace("constructor(value: i32)", "constructor(self: i32)"), /cannot be shadowed/],
      ["local receiver shadow", constructorTail("const self = value;"), /cannot be shadowed/],
      ["local selector shadow", overrideBody("const _cmd = 42; return _cmd;"), /cannot be shadowed/],
      ["closure parameter shadow", overrideBody("const callback = (_cmd: i32): i32 => _cmd; return callback(42);"), /cannot be shadowed/],
      ["closure local shadow", overrideBody("const callback = (): i32 => { const self = 42; return self; }; return callback();"), /cannot be shadowed/],
      ["object binding shadow", constructorTail("const { self } = Metadata({ self: value });"), /cannot be shadowed/],
      ["renamed object binding shadow", constructorTail("const { value: _cmd } = Metadata({ value });"), /cannot be shadowed/],
      ["array binding shadow", constructorTail("const [self] = Array<i32>(value);"), /cannot be shadowed/],
      ["array rest shadow", constructorTail("const [first, ..._cmd] = Array<i32>(value, value);"), /cannot be shadowed/],
      ["match binding shadow", constructorTail("match (Option<i32>.some(value)) { some(self) => {} none => {} }"), /cannot be shadowed/],
      ["loop binding shadow", constructorTail("for (const _cmd of Array<i32>(value)) {}"), /cannot be shadowed/],
      ["loop destructuring shadow", constructorTail("for (const { value: self } of Array<i32>(value).entries()) {}"), /cannot be shadowed/],
      ["manual release", overrideBody("super.release(); return 42;"), /ARC lifecycle methods/],
      ["unknown superclass call", overrideBody("return super.missing();"), /resolve to one imported/],
      ["wrong superclass arity", overrideBody("return super.add(42);"), /resolve to one imported/],
      ["wrong superclass label", overrideBody("return super.add(20, other: 22);"), /resolve to one imported/],
      ["labelled first argument", overrideBody("return super.add(left: 20, to: 22);"), /resolve to one imported/],
      ["labelled initializer argument", nativeBaseline.replace("super.initWithValue(value)", "super.initWithValue(value: value)"), /resolve to one imported/],
      ["consuming superclass receiver", overrideBody("super.consume(); return 42;"), /consuming superclass calls/],
      ["consumed superclass argument", overrideBody("super.takeIndex(0, this); return 42;"), /consuming superclass calls/],
      ["variadic superclass call", overrideBody("super.log(1); return 42;"), /non-variadic native ABI/],
      ["unsupported superclass result", overrideBody("super.extendedValue(); return 42;"), /unsupported superclass return ABI/],
    ];
    for (const [name, source, expected] of bodyCases) {
      const checked = runDeclaration(source);
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /Z0814/, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, expected, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.throws(() => compileToNative(source, decoder), undefined, `Stage 0 rejection: ${name}`);
    }
    const validBodies: [string, string][] = [
      ["unlabelled superclass arguments", overrideBody("return super.add(20, 22);")],
      ["labelled superclass arguments", overrideBody("return super.add(20, to: 22);")],
      ["inherited superclass call", overrideBody("return super.add(20, to: 22);").replace("extends native.ZWireBase", "extends native.ZWireChild")],
      ["closure-local return", constructorTail("const callback = (): i32 => { return 42; }; const observed = callback();")],
      ["nested closure-local return", constructorTail("const callback = (): i32 => { const inner = (): i32 => { return 42; }; return inner(); }; const observed = callback();")],
      ["constructor select", constructorTail("const observed = if (value == 0) { select 0; } else { select value; };")],
      ["string and comment vocabulary", constructorTail('const text = "self _cmd this super"; /* super.init(); return; */')],
      ["renamed property", constructorTail("const metadata = Metadata({ self: value }); const { self: observed } = metadata;") + "\nstruct Metadata { self: i32; }\n"],
    ];
    for (const [name, source] of validBodies) {
      const checked = runDeclaration(source);
      assert.equal(checked.status, 0, `${name}: ${checked.stdout}${checked.stderr}`);
      // The native structural checker must not reject ordinary legal bodies.
      // Stage 0 still supplies their complete typed/ownership/emission oracle.
      assert.doesNotThrow(() => compileToNative(source, decoder), name);
    }
    for (const [name, source, expected] of [
      ["initializer argument type", nativeBaseline.replace("super.initWithValue(value)", 'super.initWithValue("bad")'), /i32.*String|String.*i32/],
      ["missing executor capability", nativeBaseline.replace('import { thread } from "std/thread";', ''), /imported thread.main capability/],
      ["super argument type", overrideBody('return super.add(20, to: "bad");'), /i32.*String|String.*i32/],
      ["override result type", overrideBody('return "bad";'), /i32.*String|String.*i32/],
      ["unknown receiver property", overrideBody("return this.missing;"), /missing/],
      ["unknown local", overrideBody("return absent;"), /absent/],
      ["nominal downcast", overrideBody("const base: native.ZWireBase = this; const child: Counter = base; return child.value();"), /Counter/],
      ["sibling nominal identity", overrideBody("const sibling: Sibling = this; return sibling.value();")
        + '\nclass Sibling extends native.ZWireBase on thread.main { constructor(value: i32) { super.initWithValue(value); } }', /Sibling/],
      ["missing return", overrideBody("const observed = super.value();"), /return.*continuing path/],
      ["this reinitialization", overrideBody("this.initWithValue(1); return 42;"), /checked constructor/],
      ["alias reinitialization", overrideBody("const alias = this; alias.initWithValue(1); return 42;"), /checked constructor/],
      ["readonly native property", constructorTail("this.readOnlyValue = value;"), /readonly/],
      ["native setter argument", constructorTail('this.configuredValue = "bad";'), /i32.*String|String.*i32/],
      ["uncontracted explicit borrow", overrideBody("return super.readObject(in this);"), /in is not valid/],
      ["receiver alias overlap", constructorTail("const alias = this; observe(inout this, in alias);") + "\nfunction observe(inout left: Counter, in right: Counter): void {}", /overlap|alias/],
      ["move native receiver", overrideBody("const alias = move this; return 42;"), /no unique ownership to move/],
      ["move retained native alias", overrideBody("const alias = this; const other = move alias; return other.value();"), /no unique ownership to move/],
      ["move imported base alias", overrideBody("const alias: native.ZWireBase = this; const other = move alias; return other.value();"), /no unique ownership to move/],
      ["move nullable base alias", overrideBody("const alias: native.ZWireBase | null = this; const other = move alias; return 42;"), /no unique ownership to move/],
      ["move transparent native alias", overrideBody("const alias: CounterAlias = this; const other = move alias; return 42;") + "\ntype CounterAlias = Counter;", /no unique ownership to move/],
      ["copy native receiver", overrideBody("const alias = copy this; return alias.value();"), /cannot be explicitly copied/],
      ["moved String use", overrideBody('const message = "hello"; const moved = move message; return i32(message.byteLength);'), /use of moved value/],
      ["owned String capture use", overrideBody('const message = "hello"; const callback: () => i32 = move (): i32 => i32(message.byteLength); return i32(message.byteLength);'), /use of moved value/],
      ["borrowed String move inside callback", overrideBody('const text = "hello"; const take = (): String => { return move text; }; return 42;'), /cannot transfer ownership|cannot move borrowed/],
      ["async scope in synchronous override", overrideBody('async scope {} return 42;'), /async/],
      ["async scope in native constructor", constructorTail('async scope {}'), /async/],
    ] satisfies [string, string, RegExp][]) {
      const checked = runDeclaration(source, "types");
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, expected, name);
      assert.throws(() => compileToNative(source, decoder), undefined, `Stage 0: ${name}`);
    }
    for (const [name, source] of [
      ["native this dispatch", overrideBody("return this.add(20, to: 22);")],
      ["native base conversion", overrideBody("const base: native.ZWireBase = this; return base.add(20, to: 22);")],
      ["native receiver argument", overrideBody("return super.readObject(this);")],
      ["ordinary local computation", overrideBody("let total = super.value(); if (total > 0) { total = total + 2; } return total;")],
      ["native property read", overrideBody("return this.configuredValue;")],
      ["native property initialization", constructorTail("this.configuredValue = value;")],
      ["ordinary retained argument", overrideBody("consume(this); return this.value();") + "\nfunction consume(value: Counter): void {}"],
      ["owned native alias capture", overrideBody("const alias = this; const callback: () => i32 on thread.main = move (): i32 => alias.value(); return callback() + alias.value();")],
      ["inline borrowed alias capture", overrideBody("const alias = this; return inspect((): i32 => alias.value());") + "\nfunction inspect(in callback: () => i32 on thread.main): i32 on thread.main { return callback(); }"],
      ["inferred lexical scalar capture", overrideBody("const count = 42; const callback = (): i32 => count; return callback();")],
      ["noncapturing function value", overrideBody("const callback: () => i32 = (): i32 => 42; return callback();")],
      ["owned scalar function value", overrideBody("const count = 42; const callback: () => i32 = move (): i32 => count; return callback();")],
      ["owned String capture", overrideBody('const message = "hello"; const callback: () => i32 = move (): i32 => i32(message.byteLength); return callback();')],
      ["borrowed String storage", overrideBody('const source = "first second"; let text = source.copyBytes(0, 5); const read = (): usize => text.byteLength; text = source.copyBytes(6, 12); return i32(read());')],
      ["borrowed cleanup-bearing block", overrideBody('let state = State({ count: 40, text: "owned" }); const add = (): i32 => { state.count = state.count + 1; return state.count; }; return add();') + '\nstruct State { count: i32; text: String; deinit {} }'],
      ["locally handled typed error", overrideBody('const callback = (): i32 throws Failure => { throw Failure({ message: "rejected" }); }; return match (attempt callback()) { success(value) => value; failure(error) => i32(error.message.byteLength); };') + '\nstruct Failure { message: String; }'],
      ["ordinary Z ARC move and id shadowing", overrideBody("const item = new id({ value: 42 }); const other = move item; return other.value;") + "\nclass id { value: i32; }"],
      ["retained borrowed object capture", overrideBody("const callback: () => i32 on thread.main = move (): i32 => object.value(); return callback() + object.value();")
        .replace('override function value()', 'override function read(in object: native.ZWireBase)')
        .replace('as "value"', 'as "readObject:"')],
      ["declared override borrow", overrideBody("return this.read(in this);")
        .replace('override function value()', 'override function read(in object: native.ZWireBase)')
        .replace('as "value"', 'as "readObject:"')],
      ["unaliased override borrow", overrideBody("return this.readObject(in this);")
        .replace('override function value()', 'override function readObject(in object: native.ZWireBase)')
        .replace('as "value"', 'as "readObject:"')],
    ]) {
      const checked = runDeclaration(source, "types");
      assert.equal(checked.status, 0, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.doesNotThrow(() => compileToNative(source, decoder), name);
    }
    for (const body of [
      "this.consume(); return 42;",
      "const alias: native.ZWireBase = this; alias.consume(); return 42;",
      "this.takeIndex(0, this); return 42;",
      "const alias: native.ZWireBase = this; alias.initWithValue(1); return 42;",
      "const alias: native.ZWireBase = this; const callback: () => i32 on thread.main = move (): i32 => { alias.consume(); return 42; }; return callback();",
    ]) {
      const checked = runDeclaration(overrideBody(body), "types");
      assert.equal(checked.status, 1, checked.stdout + checked.stderr);
      assert.match(checked.stdout, /consuming Objective-C calls/);
      assert.throws(() => compileToNative(overrideBody(body), decoder), /consuming Objective-C calls/);
    }
    for (const body of ["this.log(1); return 42;", "const alias = this; alias.log(1); return 42;"]) {
      const source = overrideBody(body);
      const checked = runDeclaration(source, "types");
      assert.equal(checked.status, 1, checked.stdout + checked.stderr);
      assert.match(checked.stdout, /synchronous, non-variadic Objective-C calls/);
      assert.throws(() => compileToNative(source, decoder), /synchronous, non-variadic Objective-C calls/);
    }
    // Inferred lexical closures retain environment provenance through generic
    // inference and owned storage. Rejection must precede the execution gate.
    const capturedScalar = "const count = 42; const callback = (): i32 => count; ";
    for (const [name, source] of [
      ["typed receiver capture", overrideBody("const alias = this; const callback: () => i32 on thread.main = (): i32 => alias.value(); return callback();")],
      ["typed scalar capture", overrideBody("const count = 42; const callback: () => i32 = (): i32 => count; return callback();")],
      ["inferred alias conversion", overrideBody(capturedScalar + "const stored: () => i32 = callback; return stored();")],
      ["transparent alias conversion", overrideBody(capturedScalar + "const stored: Callback = callback; return stored();") + "\ntype Callback = () => i32;"],
      ["owned argument", overrideBody("const count = 42; save((): i32 => count); return 0;") + "\nfunction save(callback: () => i32): void {}"],
      ["generic owned argument", overrideBody(capturedScalar + "save(callback); return 0;") + "\nfunction save<T>(value: T): void {}"],
      ["aggregate field", overrideBody(capturedScalar + "const holder = Holder({ callback }); return 0;") + "\nstruct Holder { callback: () => i32; }"],
      ["generic aggregate field", overrideBody(capturedScalar + "const holder = Holder({ callback }); return 0;") + "\nstruct Holder<T> { callback: T; }"],
      ["fixed array element", overrideBody(capturedScalar + "const callbacks = [callback]; return 0;")],
      ["optional payload", overrideBody(capturedScalar + "const stored = Option.some(callback); return 0;")],
      ["owned nested capture", overrideBody(capturedScalar + "const stored: () => i32 = move (): i32 => callback(); return stored();")],
      ["return boundary", overrideBody("const factory: () => () => i32 = (): () => i32 => { const count = 42; const callback = (): i32 => count; return callback; }; return 0;")],
      ["named lexical callback conversion", overrideBody(capturedScalar + "return inspect(in callback);") + "\nfunction inspect(in callback: () => i32): i32 { return callback(); }"],
    ]) {
      const checked = runDeclaration(source, "types");
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /Z0212:.*borrowed capturing closure cannot become a function value/, name);
      assert.throws(() => compileToNative(source, decoder), undefined, `Stage 0 rejects ${name}`);
      const gated = runDeclaration(source, true);
      assert.equal(gated.status, 1, `${name}: ${gated.stdout}${gated.stderr}`);
      assert.match(gated.stdout, /Z0212:/, name);
      assert.doesNotMatch(gated.stdout, /execution still requires/, name);
    }
    const availabilityHeader = "objc-subclass-availability.h";
    const availabilityStream = resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: availabilityHeader,
      location: { fileName: decoder, offset: 0, line: 1, column: 1 },
    }], decoder, [resolve(projectRoot, "tests/fixtures")]).get("native")!;
    const availableBaseline = nativeBaseline.replace("objc-subclass-wire.h", availabilityHeader)
      .replace("extends native.ZWireBase", "extends native.ZWireAvailable");
    const availabilityBody = (body: string) => availableBaseline.replace("return super.value() + 2;", body);
    const runAvailability = (source: string, version = "13.0", platform = "macos", mode = "types") => {
      writeFileSync(input, availabilityStream);
      writeFileSync(sourcePath, source);
      return spawnSync(executable, [input, sourcePath, mode, platform, version, availabilityHeader], { encoding: "utf8", timeout: 5_000 });
    };
    for (const [name, source, version, expected] of [
      ["base introduced", availableBaseline.replace("ZWireAvailable", "ZWireFuture"), "13.0", /ZWireFuture.*requires macos 14.0/],
      ["base unavailable", availableBaseline.replace("ZWireAvailable", "ZWireUnavailable"), "13.0", /unavailable.*retired base/],
      ["override introduced", availableBaseline.replace('as "value"', 'as "futureValue"'), "13.0", /futureValue.*requires macos 14.2/],
      ["initializer introduced", availableBaseline.replace("super.initWithValue(value)", "super.initForFuture(value)"), "13.0", /initForFuture.*requires macos 14.1/],
      ["super call introduced", availabilityBody("return super.futureValue();"), "13.0", /futureValue.*requires macos 14.2/],
      ["virtual call introduced", availabilityBody("return this.futureValue();"), "13.0", /futureValue.*requires macos 14.2/],
      ["obsoleted", availabilityBody("return this.removedValue();"), "13.1", /removedValue.*obsoleted.*13.1/],
      ["unavailable method", availabilityBody("return this.forbiddenValue();"), "13.0", /unavailable.*retired method/],
      ["getter introduced", availabilityBody("return this.futureProperty;"), "13.0", /futureProperty.*requires macos 14.3/],
      ["setter introduced", availableBaseline.replace("super.initWithValue(value);", "super.initWithValue(value); this.futureProperty = value;"), "13.0", /futureProperty.*requires macos 14.3/],
      ["aliased method introduced", availabilityBody("const alias = this; return alias.futureValue();"), "13.0", /futureValue.*requires macos 14.2/],
      ["borrowed callback availability", availabilityBody("const alias = this; return inspect((): i32 => alias.futureValue());") + '\nfunction inspect(in callback: () => i32 on thread.main): i32 on thread.main { return callback(); }', "13.0", /futureValue.*requires macos 14.2/],
      ["owned callback availability", availabilityBody("const alias = this; const read: () => i32 on thread.main = move (): i32 => alias.futureProperty; return read();"), "13.0", /futureProperty.*requires macos 14.3/],
    ] satisfies [string, string, string, RegExp][]) {
      const checked = runAvailability(source, version);
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /Z0802/, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, expected, name);
      assert.throws(() => compileToNative(source, decoder, {
        projectBuild: { ...prepareProject(decoder), deploymentTarget: { platform: "macos", minimumVersion: version } },
      }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "Z0802", `Stage 0 availability rejection: ${name}`);
    }
    for (const [source, version] of [
      [availableBaseline.replace("ZWireAvailable", "ZWireFuture"), "14.0"],
      [availabilityBody("return this.futureValue();"), "014.002.0"],
      [availabilityBody("return this.removedValue();"), "13.0.9"],
      [availabilityBody("return this.otherPlatform();"), "13.0"],
      [availabilityBody("return this.deprecatedValue();"), "13.0"],
      [availabilityBody("return this.futureProperty;"), "14.3"],
      [availabilityBody("return this.futureValue();"), ""],
    ]) {
      const checked = runAvailability(source, version);
      assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    }
    const foreignPlatform = runAvailability(availabilityBody("return this.otherPlatform();"), "17.0", "ios");
    assert.equal(foreignPlatform.status, 1, foreignPlatform.stdout + foreignPlatform.stderr);
    assert.match(foreignPlatform.stdout, /Z0802:.*unavailable on ios/);
    const absentPlatform = runAvailability(availableBaseline, "", "");
    assert.equal(absentPlatform.status, 1, absentPlatform.stdout + absentPlatform.stderr);
    assert.match(absentPlatform.stdout, /Z0814:.*target platform evidence/);
    const gatedAvailability = runAvailability(availabilityBody("return this.futureValue();"), "13.0", "macos", "gate");
    assert.equal(gatedAvailability.status, 1, gatedAvailability.stdout + gatedAvailability.stderr);
    assert.match(gatedAvailability.stdout, /Z0802:.*futureValue/);
    const availableRecordStart = availabilityStream.lastIndexOf("\nI", availabilityStream.indexOf("ZWireAvailable")) + 1;
    const availableRecordEnd = availabilityStream.indexOf("\n", availableRecordStart);
    const incompleteAvailability = run(availabilityStream.slice(0, availableRecordEnd - 2));
    assert.equal(incompleteAvailability.status, 1, incompleteAvailability.stdout + incompleteAvailability.stderr);
    assert.match(incompleteAvailability.stdout, /ended|expected|invalid/);

    const obsolete = run(stream.replace("ZFDCL000000000000000f", "ZFDCL000000000000000e"));
    assert.equal(obsolete.status, 1, obsolete.stderr);
    assert.match(obsolete.stdout, /unsupported foreign declaration stream version 14/);
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
  assert.match(hover(baseline, fixture, baseline.indexOf("Counter") + 1)?.contents.value ?? "", /after constructor cleanup/);
  assert.match(hover(baseline, fixture, baseline.indexOf("override") + 1)?.contents.value ?? "", /superclass during construction and destruction/);
  assert.match(hover(baseline, fixture, baseline.indexOf("override") + 1)?.contents.value ?? "", /reentry conflicting with inout this traps/);
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
    ["public stored state", baseline.replace("constructor(value", "stored: i32; constructor(value"), /must be private/],
    ["dying receiver", baseline.replace("constructor(value", "deinit { const alias = this; } constructor(value"), /dying receiver/],
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
    import QuartzCore from "QuartzCore/CADisplayLink.h";
    import objc from "std/objc";
    import { thread } from "std/thread";
    class SmoothWindow extends AppKit.NSWindow on thread.main {
      private displayLink: QuartzCore.CADisplayLink | null;
      constructor(frame: AppKit.NSRect) {
        super.initWithContentRect(frame, styleMask: AppKit.NSWindowStyleMaskTitled | AppKit.NSWindowStyleMaskResizable,
          backing: AppKit.NSBackingStoreBuffered, defer: false);
        this.displayLink = null;
        this.releasedWhenClosed = false;
      }
      override function animationResizeTime(frame: AppKit.NSRect): f64 as "animationResizeTime:" {
        return super.animationResizeTime(frame);
      }
      function onDisplay(inout this, in link: QuartzCore.CADisplayLink): void as "display:" {
        const timestamp = link.timestamp;
      }
      function startDisplay(inout this): void as "startDisplay" {
        this.displayLink = this.displayLinkWithTarget(this, selector: objc.selector(SmoothWindow.onDisplay));
      }
    }
    function main(): i32 { return 0; }
  `;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-selector-appkit-"));
  try {
    writeFileSync(resolve(temporary, "AppKit.h.zd"), `declare module "AppKit/AppKit.h" {
      export function NSWindow.displayLinkWithTarget(target: _, selector: _): _ {
        callback selector { target target; type (in link: CADisplayLink) => void on thread.main; invoked repeatedly; }
      }
    }`);
    const artifact = compileToNative(source, resolve(temporary, "main.zs"));
    assert.match(artifact.source, /@interface ZNative_.* : NSWindow/);
    assert.match(artifact.source, /@selector\(display:\)/);
    const built = spawnSync("xcrun", ["clang", "-x", "objective-c", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], { input: artifact.source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(built.status, 0, built.stderr);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 60_000);

hostToolchainTest("records the real AppKit zoom integration boundaries without opening windows", () => {
  if (process.platform !== "darwin") return;
  const file = resolve(projectRoot, "tests/fixtures/objc-subclass-appkit-reentry.zs");
  const source = readFileSync(file, "utf8");
  const artifact = compileToNative(source, file);
  assert.match(artifact.source, /objc_precise_lifetime\)\) __strong id _z_handoff_argument_0 = sender/);
  assert.match(artifact.source, /\[super zoom:_z_handoff_argument_0\]/);
  assert.match(artifact.source, /access_begin\(&self->_z_native_subclass_access, true\)/);
  assert.match(artifact.source, /\[super setFrame:_z_handoff_argument_0 display:_z_handoff_argument_1 animate:_z_handoff_argument_2\]/);
  // NSObject is not a sound substitute for Objective-C id: a native sender
  // need not inherit from NSObject. Source-nameable objc.Object preserves the
  // exact native signature; a narrowed substitute remains unsound.
  const narrowSender = source.replace("in sender: objc.Object | null", "in sender: AppKit.NSObject | null");
  assert.throws(() => compileToNative(narrowSender, file), /parameter 1 expects objc\.Object \| null, found AppKit.NSObject \| null/);
  assert.throws(() => compileToNative(source.replace("function main()", "async function main()"), file),
    /native Objective-C subclasses cannot compose with async lowering yet/);
}, 60_000);

hostToolchainTest("executes native subclass lifecycle and reentrant receiver access guards", () => {
  if (process.platform !== "darwin") return;
  const file = resolve(projectRoot, "tests/fixtures/objc-subclass.zs");
  const artifact = compileToNative(readFileSync(file, "utf8"), file);
  assert.match(artifact.source, /@interface ZNative_.* : ZSubclassFixture/);
  assert.match(artifact.source, /\[super value\]/);
  assert.match(artifact.source, /self = \[super initWithValue:value\]/);
  assert.match(artifact.source, /@private\s+unsigned char _z_native_subclass_ready/);
  assert.match(artifact.source, /if \(!self->_z_native_subclass_ready\) \{ return \[super value\]; \}/);
  assert.match(artifact.source, /- \(void\)dealloc \{\s+if \(!\[NSThread isMainThread\]\) abort\(\);\s+self->_z_native_subclass_ready = 0;/);
  assert.doesNotMatch(artifact.source, /Z_Counter.*_z_refcount/);
  assert.match(artifact.source, /intptr_t _z_native_subclass_access;/);
  assert.match(artifact.source, /objc_precise_lifetime.*_z_native_subclass_owner = self/);
  assert.match(artifact.source, /access_begin\(&self->_z_native_subclass_access, true\)/);
  assert.match(artifact.source, /ns_returns_retained.*Z_Counter_new/);
  const directory = mkdtempSync(resolve(tmpdir(), "z-native-subclass-"));
  try {
    const generated = resolve(directory, "main.m");
    const executable = resolve(directory, "probe");
    const compileAndRun = (source: string, label: string, optimization = "-O0") => {
      writeFileSync(generated, source);
      const built = spawnSync("xcrun", ["clang", optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", resolve(projectRoot, "tests/fixtures"), "-framework", "Foundation", generated, resolve(projectRoot, "tests/fixtures/objc-subclass.m"), "-o", executable], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(built.status, 0, `${label} ${optimization}: ${built.stderr}`);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: "0" } });
      assert.equal(run.status, 0, `${label} ${optimization}: ${run.stderr} ${run.error ?? ""} ${run.signal ?? ""}`);
      for (const scenario of [1, 2, 3, 4, 5, 6]) {
        const rejected = spawnSync(executable, [], {
          encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
          env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: String(scenario) },
        });
        assert.equal(rejected.status, 86, `${label} ${optimization} conflict ${scenario}: ${rejected.stderr} ${rejected.error ?? ""} ${rejected.signal ?? ""}`);
        assert.equal(rejected.signal, null);
        assert.match(rejected.stderr, /reentrant native subclass access conflicts with inout this/);
      }
    };
    compileAndRun(artifact.source, "Stage 0");
    compileAndRun(artifact.source, "Stage 0", "-O2");
    const oracleSource = resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-execution.zs");
    const oracleC = spawnSync(process.execPath, [cli, "self-host-emit", oracleSource], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(oracleC.status, 0, oracleC.stderr);
    const oracle = resolve(directory, "native-emitter");
    const oracleBuild = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: oracleC.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(oracleBuild.status, 0, oracleBuild.stderr);
    const stream = resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: file, offset: 0, line: 1, column: 1 },
    }], file, [resolve(projectRoot, "tests/fixtures")]).get("native")!;
    const wire = resolve(directory, "native.zfdcl");
    writeFileSync(wire, stream);
    const native = spawnSync(oracle, [wire, file], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(native.status, 0, native.stderr);
    assert.match(native.stdout, /@implementation ZNative_0_Counter/);
    assert.match(native.stdout, /\[super value\]/);
    assert.match(native.stdout, /object_getClass\(self\) != \[ZNative_0_Counter class\]/);
    assert.match(native.stdout, /if \(!self->_z_native_subclass_ready\) \{ return \[super value\]; \}/);
    assert.match(native.stdout, /- \(void\)dealloc \{\s+(?:\(void\)self;\s+)?if \(!\[NSThread isMainThread\]\) abort\(\);\s+self->_z_native_subclass_ready = 0;/);
    assert.doesNotMatch(native.stdout, /Z_Counter.*_z_refcount|typedef struct Z_ZNative_0_Counter/);
    assert.match(native.stdout, /access_begin\(&self->_z_native_subclass_access, true\)/);
    assert.match(native.stdout, /ns_returns_retained.*ZNative_0_Counter_new/);
    compileAndRun(native.stdout, "native");
    compileAndRun(native.stdout, "native", "-O2");
    for (const source of [artifact.source, native.stdout]) {
      assert.match(source, /Z_String _z_native_field_title;/);
      assert.match(source, /ZSubclassPoint _z_native_field_point;/);
      assert.match(source, /__strong ZSubclassStoredResource \* _z_native_field_resource;/);
      assert.match(source, /__strong ZSubclassStoredResource \* _z_native_field_pending;/);
      assert.match(source, /self->_z_native_field_resource = nil;/);
      assert.match(source, /self->_z_native_field_pending = nil;/);
      assert.match(source, /free\(\(void \*\).*_z_native_field_title/);
      assert.doesNotMatch(source, /\[super dealloc\]/);
    }
    const stored = baseline.replace("constructor(value", "private readonly offset: i32; private text: String; constructor(value")
      .replace("super.initWithValue(value);", 'super.initWithValue(value); this.offset = 2; this.text = "ok";')
      .replace("super.value() + 2", "super.value() + this.offset");
    const nativeStored = stored.replace("private text: String;",
      "private text: String; private readonly owned: native.ZSubclassStoredResource; private optional: native.ZSubclassStoredResource | null;")
      .replace('this.text = "ok";', 'this.text = "ok"; this.owned = native.z_subclass_stored_resource(1); this.optional = null;');
    const storageProbe = resolve(directory, "storage.zs");
    const emitStorage = (source: string) => {
      writeFileSync(storageProbe, source);
      return spawnSync(oracle, [wire, storageProbe], { encoding: "utf8", timeout: 5_000,
        killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    };
    for (const source of [stored, stored.replace("constructor(value", "deinit {} constructor(value"), nativeStored,
      nativeStored.replace("constructor(value", "deinit { const snapshot = this.owned; snapshot.touch(); } constructor(value")]) {
      const checked = emitStorage(source);
      assert.equal(checked.status, 0, checked.stderr);
      compileToNative(source, fixture);
      writeFileSync(generated, checked.stdout);
      const compiled = spawnSync("clang", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsyntax-only",
        "-I", resolve(projectRoot, "tests/fixtures"), generated], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      assert.equal(compiled.status, 0, compiled.stderr);
    }
    const storageCases: [string, string, RegExp][] = [
      ["uninitialized", stored.replace(' this.text = "ok";', ""), /not initialized/],
      ["initialization order", stored.replace("this.offset = 2;", "const before = 2; this.offset = before;"), /directly after super/],
      ["partial receiver", stored.replace("this.offset = 2;", "this.offset = this.value();"), /partially initialized|before superclass initialization/],
      ["readonly replacement", stored.replace('this.text = "ok";', 'this.text = "ok"; this.offset = 3;'), /readonly/],
      ["shared write", stored.replace("return super.value() + this.offset;", 'this.text = "bad"; return 0;'), /immutable|inout this|borrowed/],
      ["nested shared write", stored.replace("private text: String;", "private text: String; private point: native.ZSubclassPoint;")
        .replace('this.text = "ok";', 'this.text = "ok"; this.point = native.ZSubclassPoint({ x: 1, y: 2 });')
        .replace("return super.value() + this.offset;", "this.point.x = 4; return 0;"), /immutable|inout this|borrowed/],
      ["alias field", stored.replace("return super.value() + this.offset;", "const alias = this; return alias.offset;"), /direct this access/],
      ["move field", stored.replace("return super.value() + this.offset;", "const moved = move this.text; return 0;"), /borrow|move|consum/],
      ["captured field", stored.replace("return super.value() + this.offset;", "const callback = (): i32 => this.offset; return callback();"), /captur/],
      ["unsupported storage", stored.replace("private text: String;", "private text: Array<String>;"), /stored fields currently support/],
      ["source subclass storage", baseline.slice(baseline.indexOf("class Counter"), baseline.indexOf("function main")).replaceAll("Counter", "Companion")
        + stored.replace("private text: String;", "private text: Companion;"), /stored fields currently support/],
      ["nonnull field initialized null", nativeStored.replace("this.owned = native.z_subclass_stored_resource(1)", "this.owned = null"), /null|assign|expected/],
      ["nullable field dereference", nativeStored.replace("return super.value() + this.offset;", "return this.optional.value();"), /null/],
      ["nullable property dereference", nativeStored.replace("return super.value() + this.offset;", "return this.optional.storedValue;"), /null/],
      ["nullable local dereference", nativeStored.replace("return super.value() + this.offset;", "const snapshot = this.optional; return snapshot.value();"), /null/],
      ["nullable alias dereference", nativeStored.replace("native.ZSubclassStoredResource | null", "MaybeResource")
        .replace("return super.value() + this.offset;", "return this.optional.value();")
        + "\ntype MaybeResource = native.ZSubclassStoredResource | null;", /null/],
      ["readonly native field", nativeStored.replace('this.optional = null;', 'this.optional = null; this.owned = native.z_subclass_stored_resource(2);'), /readonly/],
      ["shared native field write", nativeStored.replace("return super.value() + this.offset;", "this.optional = null; return 0;"), /immutable|inout this|borrowed/],
      ["native field move", nativeStored.replace("return super.value() + this.offset;", "const taken = move this.owned; return 0;"), /borrow|move|consum|ARC/],
      ["field default", stored.replace("private text: String;", 'private text: String = "default";'), /defaults or optional fields/],
      ["writable argument", stored.replace("return super.value() + this.offset;", "alter(inout this.text); return 0;")
        + '\nfunction alter(inout text: String): void { text = "updated"; }', /borrow|mutable|inout|locally contained ARC identity/],
      ["dying native call", stored.replace("constructor(value", "deinit { this.value(); } constructor(value"), /dying receiver/],
      ["dying super call", stored.replace("constructor(value", "deinit { super.value(); } constructor(value"), /dying receiver/],
      ["dying native property", stored.replace("constructor(value", "deinit { const v = this.configuredValue; } constructor(value"), /dying receiver/],
      ["dying capture", stored.replace("constructor(value", "deinit { const callback = (): usize => this.text.byteLength; } constructor(value"), /dying receiver|captur/],
      ["dying field move", stored.replace("constructor(value", "deinit { const taken = move this.text; } constructor(value"), /borrow|move|consum/],
      ["exclusive field move", stored.replace('override function value(): i32', 'override function value(inout this): i32')
        .replace("return super.value() + this.offset;", "const taken = move this.text; return 0;"), /borrow|move|consum/],
    ];
    for (const [name, source, expected] of storageCases) {
      assert.throws(() => compileToNative(source, fixture), expected, `Stage 0 ${name}`);
      const rejected = emitStorage(source);
      assert.equal(rejected.status, 1, `native ${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, `native ${name}`);
    }
    const rawProbe = resolve(directory, "raw-probe.zs");
    const emitRaw = (body: string) => {
      writeFileSync(rawProbe, baseline + `\nfunction rawProbe(): i32 = raw c { ${body} }\n`);
      return spawnSync(oracle, [wire, rawProbe], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    };
    for (const name of ["ZNative_0_Counter", "ZNative_0_Counter_new", "_z_native_subclass_ready", "_z_native_subclass_access", "_z_native_subclass_access_begin", "_z_native_subclass_access_end", "_z_native_subclass_access_guard", "_z_native_subclass_owner", "_z_native_subclass_loan"]) {
      const rejected = emitRaw(`return (int)sizeof(${name});`);
      assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
      assert.match(rejected.stderr, /Z0820: raw native source cannot reference compiler-owned symbol/);
    }
    assert.throws(() => compileToNative(baseline + '\nfunction rawProbe(): i32 = raw c { return (int)sizeof(_z_native_subclass_ready); }', fixture), /compiler-owned symbol "_z_native_subclass_ready"/);
    assert.throws(() => compileToNative(baseline + '\nfunction rawProbe(): i32 = raw c { return (int)sizeof(_z_native_subclass_access); }', fixture), /compiler-owned symbol "_z_native_subclass_access"/);
    // The existing compiler-storage prefix restriction applies to native bodies too.
    const shadowSource = baseline.replaceAll("value: i32", "_z_native_subclass_ready: i32")
      .replace("super.initWithValue(value)", "super.initWithValue(_z_native_subclass_ready)");
    assert.throws(() => compileToNative(shadowSource, fixture), /reserved for compiler-generated storage/);
    writeFileSync(rawProbe, shadowSource);
    const shadow = spawnSync(oracle, [wire, rawProbe], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(shadow.status, 1, shadow.stderr);
    assert.match(shadow.stderr, /reserved for compiler-generated storage/);
    const allowed = emitRaw('int Z_OK = 0; /* ZNative_0_Counter */ const char *message = "ZNative_0_Counter_new"; (void)message; return Z_OK;');
    assert.equal(allowed.status, 0, allowed.stderr);
    const companion = resolve(directory, "counter.zs");
    const entry = resolve(directory, "imported.zs");
    writeFileSync(companion, nativeStored.slice(0, nativeStored.indexOf("function main")).replace("class Counter", "export class Counter"));
    writeFileSync(entry, 'import { Counter as Reading } from "./counter.zs"; function main(): i32 { const counter = new Reading(40); return counter.value() - 42; }');
    const imported = spawnSync(oracle, [wire, entry, companion], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(imported.status, 0, imported.stderr);
    writeFileSync(generated, imported.stdout);
    const importedBuild = spawnSync("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "tests/fixtures"), "-framework", "Foundation", generated, resolve(projectRoot, "tests/fixtures/objc-subclass.m"), "-o", executable], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(importedBuild.status, 0, importedBuild.stderr);
    const importedRun = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(importedRun.status, 0, importedRun.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
