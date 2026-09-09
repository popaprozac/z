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
    const runDeclaration = (source: string, mode: false | true | "types" = false) => {
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
    assert.equal(gated.status, 1, gated.stderr);
    assert.match(gated.stdout, /Z0814:.*availability checks, complete body ownership parity, and native emission/);
    const invalidBeforeGate = runDeclaration(nativeBaseline.replace("super.initWithValue(value)", 'super.initWithValue("bad")'), true);
    assert.equal(invalidBeforeGate.status, 1, invalidBeforeGate.stdout + invalidBeforeGate.stderr);
    assert.match(invalidBeforeGate.stdout, /i32.*String|String.*i32/);
    assert.doesNotMatch(invalidBeforeGate.stdout, /execution still requires/);
    const typed = runDeclaration(nativeBaseline, "types");
    assert.equal(typed.status, 0, typed.stdout + typed.stderr);
    assert.match(typed.stdout, /objcSuperInitializer:initWithValue::native.ZWireBase/);
    assert.match(typed.stdout, /objcSuper:value:i32/);
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
      ["owned String capture", overrideBody('const message = "hello"; const callback: () => i32 = move (): i32 => i32(message.byteLength); return callback();')],
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
    ]) {
      const checked = runDeclaration(overrideBody(body), "types");
      assert.equal(checked.status, 1, checked.stdout + checked.stderr);
      assert.match(checked.stdout, /consuming Objective-C calls/);
    }
    // Borrowed-closure escape proof is still a required ownership slice. Do not
    // let the limited typed oracle's accepted result authorize execution.
    const borrowedEscape = overrideBody("const alias = this; const callback: () => i32 on thread.main = (): i32 => alias.value(); return callback();");
    assert.throws(() => compileToNative(borrowedEscape, decoder), /borrowed capturing closure cannot become a function value/);
    const gatedBorrowedEscape = runDeclaration(borrowedEscape, true);
    assert.equal(gatedBorrowedEscape.status, 1, gatedBorrowedEscape.stdout + gatedBorrowedEscape.stderr);
    assert.match(gatedBorrowedEscape.stdout, /Z0814:.*execution still requires/);
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
    ] satisfies [string, string, string, RegExp][]) {
      const checked = runAvailability(source, version);
      assert.equal(checked.status, 1, `${name}: ${checked.stdout}${checked.stderr}`);
      assert.match(checked.stdout, /Z0802/, name);
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
