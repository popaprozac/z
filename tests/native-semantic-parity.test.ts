import {
  assert, check, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function native(command: "self-host-resolve" | "self-host-emit", input: string) {
  return spawnSync(process.execPath, [cli, command, input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
}

function execute(source: string, expected: string, flags: readonly string[] = []): void {
  const directory = mkdtempSync("/tmp/z-native-semantic-execute-");
  try {
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, "program");
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", ...flags, "-", "-o", executable], {
        input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
      const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(result.stdout, expected);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [fixture, expected] of [
  ["slice-length-expressions", "ok\n"],
  ["disjoint-indexed-call", "ok\n"],
  ["distinct-class-call", "ok\n"],
  ["deinit-mutable-field", "3\n0\n2\n0\n1\n0\ndone\n"],
  ["generic-element-equality", "ok\n"],
  ["generic-imported-equality", "ok\n"],
  ["generic-literal-arguments", "ok\n"],
  ["private-aggregate-reachability", "right 300\nleft 42\ndone\n"],
  ["named-callable-arguments", "released\nok\n"],
  ["callable-receiver-borrows", "ok\n"],
  ["rebound-unused-locals", "1\n2\nok\n"],
  ["generic-plain-instances", "ok\n"],
  ["optimization-marks", "counter 20\n"],
  ["constant-field-default", "poll 4096 1024 7 1024 true\n"],
  ["call-field-default", "7 2 3 1\n"],
  ["dispatch-loop", "acc 55\nsteps 35 shown 1\nresult 55\nsteps 7 shown 0\nlimited -2\nsum 55 2\n"],
  ["generic-instance-shapes", "ok\n"],
  ["borrowed-argument-storage", "67\n"],
  ["channel-local-class-payload", "3\n"],
  ["view-field-borrows", "8\n"],
  ["thread-block-captures", "16\n"],
  ["lock-callback-function-value", "11\n"],
  ["array-capacity-field", "true 1 true true\n"],
  ["console-closure-argument", "3\nheld 4 after 6\n"],
  ["console-formatting", "4\n-12 2.5 0.125 true 9\nname: zjs box 18446744073709551615\n5 -24 false -128 64\ntemplate 4 and zjs\ntemplate 4 4\nno newline 4 zjs\n1e+21 0.1 -0 100 0.333333\nfirst first\nsecond second\nsecond\n3 4 7\nround 0 0\nround 1 10\nround 2 20\nshown 7\n"],
]) {
  test(`executes ${fixture} with Stage 0 and native semantics`, () => {
    const input = resolve(projectRoot, `tests/fixtures/native-semantic-parity/${fixture}.zs`);
    const source = readFileSync(input, "utf8");
    execute(compileToC(source, input), expected);
    const emitted = native("self-host-emit", input);
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, expected);
  }, 240_000);
}

function rejects(source: string, stage0Message: RegExp, nativeMessage = stage0Message,
  commands: ("self-host-resolve" | "self-host-emit")[] = ["self-host-resolve", "self-host-emit"],
  files: Record<string, string> = {}): void {
  const directory = mkdtempSync("/tmp/z-native-semantic-reject-");
  try {
    const input = resolve(directory, "main.zs");
    for (const [name, text] of Object.entries(files)) writeFileSync(resolve(directory, name), text);
    writeFileSync(input, source);
    assert.throws(() => check(source, input), stage0Message);
    for (const command of commands) {
      const result = native(command, input);
      assert.equal(result.status, 1, result.stderr || String(result.error));
      assert.equal(result.stdout, "", "Invalid native semantics must not publish generated output");
      assert.match(result.stderr, nativeMessage);
      assert.doesNotMatch(result.stderr, /internal compiler error/);
      assert.ok(result.stderr.includes(directory), result.stderr);
      assert.match(result.stderr, /\.zs:\d+:\d+:/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("checks thread.spawn captures and results in both compilers", () => {
  const program = (declarations: string, body: string) => `
    import { thread } from "std/thread";
    ${declarations}
    async function main(): i32 {
      ${body}
    }
  `;
  rejects(program(`
    readonly class Managed { readonly value: i32; deinit {} }
  `, `
    const snapshot = new Managed({ value: 1 });
    const worker = thread.spawn(move (): i32 => snapshot.value);
    return await worker;
  `), /capture "snapshot" of type Managed cannot cross a native thread boundary: Managed has a custom deinit whose thread affinity is unknown/,
    undefined, ["self-host-resolve"]);
  rejects(program(`
    class Counter { total: i32; function increment(inout this): void { this.total = this.total + 1; } }
  `, `
    const counter = new Counter({ total: 1 });
    const worker = thread.spawn(move (): i32 => counter.total);
    return await worker;
  `), /capture "counter" of type Counter cannot cross a native thread boundary: Counter exposes mutable method "increment"/,
    undefined, ["self-host-resolve"]);
  rejects(program(`
    class Resource { value: i32; }
  `, `
    const worker = thread.spawn(move (): Resource => new Resource({ value: 1 }));
    const resource = await worker;
    return resource.value;
  `), /thread\.spawn result type "Resource" cannot cross a native thread boundary yet/,
    undefined, ["self-host-resolve"]);
  // A captured value is held to the same rule in a synchronous or an async
  // worker: no custom deinit of unknown thread affinity and no unshareable
  // class identity anywhere in its storage.
  const managed = "struct Managed { label: String; deinit {} }";
  for (const [declarations, setup, use, type] of [
    [managed, 'const held = Managed({ label: "m" });', "held.label.byteLength", "Managed"],
    [managed, 'let held = Array<Managed>(); held.push(Managed({ label: "m" }));', "held.length", "Array<Managed>"],
    [`${managed}\n    struct Holder { inner: Managed; }`, 'const held = Holder({ inner: Managed({ label: "m" }) });',
      "held.inner.label.byteLength", "Holder"],
    ["class Mutable { value: i32; }\n    struct WithMutable { target: Mutable; }",
      "const held = WithMutable({ target: new Mutable({ value: 1 }) });", "usize(held.target.value)", "WithMutable"],
  ]) {
    for (const [modifier, pause] of [["", ""], ["async ", "await delay(1);"]]) {
      rejects(program(`
        import { delay } from "std/time";
        ${declarations}
      `, `
        ${setup}
        const worker = thread.spawn(${modifier}move (): usize => { ${pause} return ${use}; });
        const result = await worker;
        return 0;
      `), new RegExp(`capture "held" of type ${type} cannot cross a native thread boundary yet`));
    }
  }
}, 240_000);

test("requires `move this` on async struct methods, as Stage 0 does", () => {
  rejects(`
    struct Counter {
      value: i32;
      async function read(): i32 { return this.value; }
    }
    async function main(): i32 { return 0; }
  `, /an async struct method must take ownership with `move this` in the first async tier/,
    /error\[Z0704\]: an async struct method must take ownership with `move this` in the first async tier/,
    ["self-host-resolve"]);
}, 240_000);

test("requires named storage for async borrows a task frame cannot hold, as Stage 0 does", () => {
  const program = (body: string) => `
    struct Report { value: i32; }
    async function inspect(in report: Report): i32 { return report.value; }
    async function make(): Report { return Report({ value: 1 }); }
    async function main(): i32 {
      ${body}
    }
  `;
  const message = /an async immutable borrow requires named storage in this task-frame tier/;
  const nativeMessage = /error\[Z0704\]: an async immutable borrow requires named storage in this task-frame tier/;
  // A spawned child outlives the statement, so a fresh value has no owner.
  rejects(program(`
    const pending = task inspect(Report({ value: 1 }));
    return await pending;
  `), message, nativeMessage, ["self-host-resolve"]);
  // A call result is not a fresh aggregate the awaiting frame materializes.
  rejects(program(`
    return await inspect(await make());
  `), message, nativeMessage, ["self-host-resolve"]);
}, 240_000);

test("checks view results and numeric constant conversions in both compilers", () => {
  const prelude = `
    struct Doc { id: i32; title: String; }
    struct Lib { docs: Array<Doc>; METHOD }
  `;
  const viewCases: [string, string, RegExp][] = [
    ["function title(): view String { return this.docs[0].title; }", "",
      /the first view tier requires a concrete Z struct target/],
    ["function first(inout this): view Doc { return this.docs[0]; }", "",
      /a view return requires a synchronous, non-throwing borrowed instance method/],
    ["static function first(in lib: Lib): view Doc { return lib.docs[0]; }", "",
      /a view return requires a synchronous, non-throwing borrowed instance method/],
    ["", "async function pick(in lib: Lib): view Doc { return lib.docs[0]; }",
      /a parameter-provenanced view result requires a synchronous, non-throwing Z function/],
    ["", "function longest(in lib: Lib): view String { return lib.docs[0].title; }",
      /the first parameter-view tier requires a concrete Z struct or borrowed native handle target/],
  ];
  for (const [method, declaration, message] of viewCases) {
    rejects(`${prelude.replace("METHOD", method)}
      ${declaration}
      function main(): i32 { return 0; }
    `, message, message, ["self-host-resolve"]);
  }
  // A literal takes the conversion's target type; a signed constant must fit it.
  const conversionCases: [string, RegExp][] = [
    ["u8(300)", /integer literal 300 does not fit u8/],
    ["u64(-1)", /constant integer value -1 cannot convert to u64/],
    ["i8(-200)", /constant integer value -200 cannot convert to i8/],
  ];
  for (const [conversion, message] of conversionCases) {
    rejects(`function main(): i32 {
      const value = ${conversion};
      return 0;
    }`, message, message, ["self-host-resolve"]);
  }
}, 240_000);

test("keeps named callable signatures and executor contracts checked", () => {
  rejects(`
    function wrong(value: String): i32 { return 0; }
    function apply(handler: (value: i32) => i32): i32 { return handler(1); }
    function main(): i32 { return apply(wrong); }
  `, /expected|assign|function type/, /expected|assign|function type/);
  rejects(`
    import { thread } from "std/thread";
    function mainOnly(value: i32): i32 on thread.main { return value; }
    function apply(handler: (value: i32) => i32 on thread.any): i32 { return handler(1); }
    function main(): i32 { return apply(mainOnly); }
  `, /thread|executor|expected/, /thread|executor|expected/);
}, 240_000);

test("does not permit mutable callable arguments from immutable receivers", () => {
  rejects(`
    struct Counter {
      value: i32;
      function invalid(handler: (inout counter: Counter) => i32): i32 {
        return handler(inout this);
      }
    }
    function main(): i32 { return 0; }
  `, /mutable|inout|immutable/, /mutable|inout|immutable/);
}, 240_000);

test("requires deinitializers to complete without nonlocal control flow", () => {
  for (const body of [
    "return;",
    "if (true) { return; }",
    "while (false) { return; }",
    "unsafe { return; }",
    "const selected = if (true) { return; select 1; } else { select 2; };",
    "match (Option<i32>.some(1)) { some(value) => { return; } none => {} }",
  ]) {
    for (const declaration of ["struct", "class"]) {
      rejects(`${declaration} Owner { deinit { ${body} } }
        function main(): i32 { return 0; }`, /deinit cannot contain/, /deinit cannot contain/);
    }
  }
}, 240_000);

test("checks dependent literal ranges and concrete parameter types at specialization", () => {
  for (const [type, literal, message] of [
    ["u8", "300", /literal 300.*u8.*specialization/],
    ["u8", "-1", /literal -1.*u8.*specialization/],
    ["String", "36", /(numeric type.*String|expected String, found i32).*specialization/],
  ] as const) {
    for (const body of [
      `let values = Array<T>(); values.push(${literal});`,
      `const value = accept<T>(${literal});`,
    ]) {
      rejects(`
        function accept<T>(value: T): T { return value; }
        function fill<T>(): void { ${body} }
        function main(): i32 { fill<${type}>(); return 0; }
      `, /does not fit|expected String|expected .*String|numeric/, message, ["self-host-emit"]);
    }
  }
}, 240_000);

test("keeps reachable implementation type names unimportable", () => {
  rejects(`
    import { Hidden } from "./implementation.zs";
    function main(): i32 { return 0; }
  `, /no export|not export/, /no export|not export/, undefined, {
    "implementation.zs": `struct Hidden { value: i32; }
      export struct Holder { items: Array<Hidden>; }`,
  });
}, 240_000);

test("keeps private and package-internal members restricted through hidden elements", () => {
  for (const visibility of ["private", "internal"]) {
    for (const use of ["holder.items[0].secret", "holder.items[0].hiddenMethod()"] ) {
      rejects(`
        import { createHolder } from "./implementation.zs";
        function main(): i32 { const holder = createHolder(); return ${use}; }
      `, /private|internal/, /private|internal/, undefined, {
        "implementation.zs": `
          struct Hidden {
            ${visibility} secret: i32;
            ${visibility} function hiddenMethod(): i32 { return this.secret; }
            static function create(): Hidden { return Hidden({ secret: 42 }); }
          }
          export struct Holder { items: Array<Hidden>; }
          export function createHolder(): Holder {
            let items = Array<Hidden>(); items.push(Hidden.create());
            return Holder({ items });
          }
        `,
      });
    }
  }
}, 240_000);

test("validates concrete generic equality operands before C emission", () => {
  for (const operator of ["==", "!="]) {
    for (const [declaration, type, value] of [
      ["struct Item { value: i32; }", "Item", "Item({ value: 1 })"],
      ["enum Item { some i32, none, }", "Item", "Item.some(1)"],
      ["", "Array<i32>", "Array<i32>(1)"],
    ]) {
      rejects(`
        ${declaration}
        function compare<T>(in a: Array<T>, in b: Array<T>): boolean { return a[0] ${operator} b[0]; }
        function main(): i32 {
          const a = Array<${type}>(${value});
          if (compare<${type}>(a, a)) return 1;
          return 0;
        }
      `, /requires matching .*operands/, /comparable operands/, ["self-host-emit"]);
    }
  }
}, 240_000);

test("validates imported and transitively demanded generic comparisons", () => {
  const library = resolve(projectRoot, "tests/fixtures/native-semantic-parity/generic-equality-library.zs");
  for (const [call, setup] of [
    ["forwarded<Item>(a, a)", ""],
    ["checker.same(a, a)", "const checker = Checker<Item>();"],
    ["method.different<Item>(a, a)", "const method = MethodChecker();"],
  ]) {
    rejects(`
      import { forwarded, Checker, MethodChecker } from "./generic-equality-library.zs";
      struct Item { value: i32; }
      function main(): i32 {
        const a = Array<Item>(Item({ value: 1 }));
        ${setup}
        if (${call}) return 1;
        return 0;
      }
    `, /requires matching .*operands/, /comparable operands/, ["self-host-emit"], {
      "generic-equality-library.zs": readFileSync(library, "utf8"),
    });
  }
}, 240_000);

test("keeps overlapping indexed call loans exclusive", () => {
  rejects(`
    function append(inout values: Array<i32>, in value: i32): void { values.push(value); }
    struct Lists {
      next: Array<i32>;
      function invalid(inout this): void { append(inout this.next, this.next[0]); }
    }
    function main(): i32 { return 0; }
  `, /overlapping/);
}, 240_000);

test("does not infer disjoint storage through potentially aliased ARC fields", () => {
  rejects(`
    class Counter { value: i32; }
    class Holder {
      counter: Counter;
      function inspect(inout this, in observed: Counter): void { this.counter.value = observed.value; }
    }
    function main(): i32 {
      let holder = new Holder({ counter: new Counter({ value: 7 }) });
      holder.inspect(in holder.counter);
      return 0;
    }
  `, /overlapping/);
  rejects(`
    class Counter {
      value: i32;
      function combine(inout this, in observed: Counter): void { this.value = observed.value; }
    }
    struct Pair { left: Counter; right: Counter; }
    function inspect(inout pair: Pair): void { pair.left.combine(pair.right); }
    function main(): i32 {
      const shared = new Counter({ value: 7 });
      let pair = Pair({ left: shared, right: shared });
      inspect(inout pair);
      return 0;
    }
  `, /overlapping/);
  rejects(`
    import { Counter as Left } from "./counter.zs";
    import { Counter as Right } from "./counter.zs";
    struct Pair { left: Left; right: Right; }
    function inspect(inout pair: Pair): void { pair.left.combine(pair.right); }
    function main(): i32 {
      const shared = new Left({ value: 7 });
      let pair = Pair({ left: shared, right: shared });
      inspect(inout pair);
      return 0;
    }
  `, /overlapping/, /overlapping/, ["self-host-resolve", "self-host-emit"], {
    "counter.zs": `export class Counter {
      value: i32;
      function combine(inout this, in observed: Counter): void { this.value = observed.value; }
    }`,
  });
}, 240_000);

test("does not permit main-only cleanup inside a thread-any deinitializer", () => {
  rejects(`
    import { thread } from "std/thread";
    struct Backend {
      handle: i32;
      function release(inout this): void on thread.main { this.handle = 0; }
    }
    struct Owner {
      backend: Backend;
      deinit on thread.any { this.backend.release(); }
    }
    function main(): i32 { return 0; }
  `, /thread.main/);
}, 240_000);

test("reports an unresolved capacity argument without an empty found type", () => {
  rejects(`
    function capacity(value: Slice<u8>): void {
      const bytes = Array<u8>.withCapacity(value.capacity);
    }
    function main(): i32 { return 0; }
  `, /capacity/, /argument type could not be resolved/);
}, 240_000);

test("does not give ordinary immutable receivers teardown privileges", () => {
  rejects(`
    struct Backend {
      handle: i32;
      function release(inout this): void { this.handle = 0; }
    }
    struct Owner {
      backend: Backend;
      function inspect(): void { this.backend.release(); }
    }
    function main(): i32 { return 0; }
  `, /immutable/);
}, 240_000);

test("does not consume the borrowed deinitializer receiver", () => {
  rejects(`
    struct Owner {
      value: String;
      function consume(move this): void {}
      deinit { this.consume(); }
    }
    function main(): i32 { const owner = Owner({ value: "owned" }); return 0; }
  `, /borrowed/);
}, 240_000);

test("keeps a view live through nested blocks when it is used after them", () => {
  const prefix = "function inspect(in value: i32): i32 { return value; }\nfunction main(): i32 {\n  let values = Array<i32>(1, 2);\n  let flag = true;\n  const first = view values[0];\n";
  for (const block of [
    "{ values.push(3); }",
    "unsafe { values.uncheckedSet(1, 3); }",
    "if (flag) { values.push(3); }",
    "while (flag) { values.push(3); flag = false; }",
  ]) {
    rejects(`${prefix}  ${block}\n  const seen = inspect(first);\n  return 0;\n}`,
      /cannot mutate "values" while view "first" is live/, undefined, ["self-host-resolve"]);
  }
  // A view whose last use comes first, or lies inside the block, is released.
  const directory = mkdtempSync("/tmp/z-native-nested-views-");
  try {
    for (const body of [
      "const seen = inspect(first); { values.push(3); }",
      "{ const seen = inspect(first); } values.push(3);",
      "if (flag) { const seen = inspect(first); } values.push(3);",
    ]) {
      const source = `${prefix}  ${body}\n  return 0;\n}`;
      const input = resolve(directory, "main.zs");
      writeFileSync(input, source);
      check(source, input);
      const result = native("self-host-resolve", input);
      assert.equal(result.status, 0, `${body}\n${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("native console formats numbers, booleans, and Strings and marks other values as its tier boundary", () => {
  const directory = mkdtempSync("/tmp/z-native-console-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
      struct Point { x: i32; y: i32; }
      function main(): i32 {
        const point = Point({ x: 1, y: 2 });
        console.log("point", point);
        return 0;
      }`;
    writeFileSync(input, source);
    check(source, input);
    const resolved = native("self-host-resolve", input);
    assert.equal(resolved.status, 1, resolved.stdout);
    assert.match(resolved.stderr, /error\[Z1000\]: console formatting of "Point" is not executable in the native compiler yet; numbers, booleans, and Strings are supported/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("native console borrows Strings only from storage or literals, like Stage 0", () => {
  const prefix = `import console from "std/console";
    struct Holder { text: String; }
    function make(): String { return "x"; }
    function main(): i32 {
      const name = make();
      const holder = Holder({ text: make() });
      const flag = true;
      `;
  const program = (argument: string) => `${prefix}console.log(${argument});\n      return 0;\n    }`;
  // Native used to accept these and emit C that takes the address of an rvalue.
  for (const argument of ["make()", "name, make()", "flag ? name : name"]) {
    rejects(program(argument),
      /console formatting of a cleanup-bearing temporary requires stored ownership/,
      /error\[Z0402\]: console formatting of a cleanup-bearing temporary requires stored ownership/);
  }
  const directory = mkdtempSync("/tmp/z-native-console-storage-");
  try {
    for (const argument of ["name", "holder.text", '"literal"', "`${name}!`", "`${make()}`"]) {
      const source = program(argument);
      const input = resolve(directory, "main.zs");
      writeFileSync(input, source);
      check(source, input);
      const result = native("self-host-resolve", input);
      assert.equal(result.status, 0, `${argument}\n${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("checks each generic instance with its concrete types in both compilers", () => {
  // A by-value T used twice moves it twice once T has cleanup.
  rejects(`
    function twice<T>(value: T): Array<T> {
      let items = Array<T>();
      items.push(value);
      items.push(value);
      return items;
    }
    function main(): i32 {
      const numbers = twice(7);
      const text: String = "owned";
      const texts = twice(text);
      return numbers.length == texts.length ? 0 : 1;
    }
  `, /use of moved value "value"/, /use of moved value "value" \(in specialization twice<T = String>\)/, ["self-host-emit"]);
  // A block copy needs cleanup-free elements.
  rejects(`
    function appendAll<T>(inout target: Array<T>, items: Slice<T>): void { target.append(items); }
    function main(): i32 {
      let names = Array<String>("a");
      const more = Array<String>("b");
      appendAll(inout names, more);
      return 0;
    }
  `, /Array\.append requires a cleanup-free element type, found String/,
    /Array\.append requires a cleanup-free element type, found String \(in specialization appendAll<T = String>\)/, ["self-host-emit"]);
  // A method of a generic aggregate is checked with its receiver's arguments.
  rejects(`
    struct Pair<T> {
      left: T;
      right: T;
      function both(): Array<T> {
        let items = Array<T>();
        items.push(this.left);
        return items;
      }
    }
    function main(): i32 {
      const pair = Pair<String>({ left: "a", right: "b" });
      return pair.both().length == 1 ? 0 : 1;
    }
  `, /cannot move an ownership-bearing field or element out of its owner/,
    /cannot move an ownership-bearing field or element out of its owner \(in specialization (both|Pair)<T = String>\)/, ["self-host-emit"]);
  // A generic class constructor and a generic deinit are checked per instance too.
  rejects(`
    class Keeper<T> {
      first: T;
      second: T;
      constructor(value: T) {
        this.first = value;
        this.second = value;
      }
    }
    function main(): i32 {
      const numbers = new Keeper<u32>(7);
      const text: String = "owned";
      const texts = new Keeper<String>(text);
      return numbers.first + numbers.second == 14 ? 0 : 1;
    }
  `, /use of moved value "value"/, /use of moved value "value" \(in specialization Keeper<T = String>\)/, ["self-host-emit"]);
  rejects(`
    struct Holder<T> {
      item: T;
      log: Array<T>;
      deinit {
        this.log.push(this.item);
      }
    }
    function main(): i32 {
      const numbers = Holder<u32>({ item: 1, log: Array<u32>() });
      const texts = Holder<String>({ item: "owned", log: Array<String>() });
      return 0;
    }
  `, /cannot move an ownership-bearing field or element out of its owner/,
    /cannot move an ownership-bearing field or element out of its owner \(in specialization Holder<T = String>\)/, ["self-host-emit"]);
}, 240_000);

test("lowers a dispatch loop into tail-called handlers and rejects loops it cannot lower", () => {
  const input = resolve(projectRoot, "tests/fixtures/native-semantic-parity/dispatch-loop.zs");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  assert.match(stage0, /__attribute__\(\(musttail\)\) return _z_dispatch_Z_Machine_run_\d+_table\[/);
  assert.match(stage0, /#if Z_DISPATCH_THREADED\n/);
  // A C compiler without the attributes gets the ordinary loop, same output.
  const expected = "acc 55\nsteps 35 shown 1\nresult 55\nsteps 7 shown 0\nlimited -2\nsum 55 2\n";
  execute(stage0, expected, ["-DZ_DISPATCH_THREADED=0"]);
  const emitted = native("self-host-emit", input);
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  assert.match(emitted.stdout, /__attribute__\(\(musttail\)\) return _z_dispatch_Z_Machine_run_\d+_table\[/);
  execute(emitted.stdout, expected, ["-DZ_DISPATCH_THREADED=0"]);
  const machine = (loop: string, enumeration = "enum Op { a, b }", before = "", extra = ""): string => `
    ${enumeration}
    struct M {
      ops: Array<Op>;
      function run(inout this): i32 {
        let i: usize = 0;
        ${before}
        ${loop}
        return 0;
      }
    }
    ${extra}
    function main(): i32 { let m = M({ ops: Array<Op>() }); m.ops.push(Op.b); return m.run(); }`;
  const ordinary = (arms: string, prefix = "const op = this.ops[i];\ni = i + 1;"): string => `dispatch while (true) {
    ${prefix}
    match (op) {
      ${arms}
    }
  }`;
  for (const [source, message] of [
    [machine(`dispatch while (i < 3) { const op = this.ops[i]; match (op) { a => { continue; } b => { break; } } }`),
      /dispatch loop: the condition must be `true`/],
    [machine(ordinary("a => { continue; }\nb => { return 1; }")), /dispatch loop: `return` cannot leave a dispatch loop/],
    [machine(`dispatch while (true) { i = i + 1; if (i > 3) { break; } }`),
      /dispatch loop: the body needs a `match`, whose arms become the handlers/],
    [machine(ordinary("a => { continue; }\nb => { break; }", "const op = this.ops[i];\nif (i > 3) { break; }")),
      /dispatch loop: only declarations, assignments, and expressions may come before the `match`/],
    [machine(ordinary("a => { const f = (): i32 => 1; continue; }\nb => { break; }")),
      /dispatch loop: a closure cannot be created in a dispatch loop/],
    [machine(ordinary("a(value) => { continue; }\nb => { break; }"), "enum Op { a i32, b }"),
      /dispatch loop: the `match` subject must be an enum without payloads/],
    [machine(ordinary("a => { const n = name.byteLength; continue; }\nb => { break; }"), undefined, `let name: String = "z";`),
      /dispatch loop: "name" is carried through the loop and must be plain data, not String/],
    [machine(ordinary(`a => { dispatch while (true) { const inner = this.ops[0]; match (inner) { a => { break; } b => { break; } } } continue; }
      b => { break; }`)), /dispatch loop: dispatch loops cannot nest/],
  ] as const) {
    rejects(source, message);
  }
}, 240_000);

test("places inline and cold functions in both compilers and rejects marks with nothing to place", () => {
  const input = resolve(projectRoot, "tests/fixtures/native-semantic-parity/optimization-marks.zs");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  assert.match(stage0, /static Z_INLINE_ALWAYS int32_t _z_function_add\(/);
  assert.match(stage0, /static Z_COLD_FUNCTION int32_t _z_function_fail\(/);
  assert.match(stage0, /#define Z_COLD_FUNCTION __attribute__\(\(cold, noinline, minsize\)\)/);
  const emitted = native("self-host-emit", input);
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /inline __attribute__\(\(always_inline\)\) int32_t _z_function_\d+_add\(/);
  assert.match(emitted.stdout, /Z_COLD_FUNCTION int32_t _z_function_\d+_fail\(/);
  for (const [source, message] of [
    [`inline function fact(n: i32): i32 { return n <= 1 ? 1 : n * fact(n - 1); }
      function main(): i32 { return fact(3) == 6 ? 0 : 1; }`, /inline function "fact" cannot call itself/],
    [`struct Walker { depth: i32; inline function walk(n: i32): i32 { return n == 0 ? 0 : this.walk(n - 1); } }
      function main(): i32 { const walker = Walker({ depth: 0 }); return walker.walk(2); }`, /inline function "walk" cannot call itself/],
    [`inline async function later(): i32 { return 1; }
      function main(): i32 { return 0; }`, /`inline` cannot modify an async function/],
    [`inline cold function both(): i32 { return 1; }
      function main(): i32 { return both() - 1; }`, /a function cannot be both `inline` and `cold`/],
    ["inline function main(): i32 { return 0; }", /`main` cannot be inline/],
    [`export c inline function answer(): i32 { return 42; }
      function main(): i32 { return 0; }`, /a C-exported function cannot be inline; C calls it by its symbol/],
  ] as const) {
    rejects(source, message);
  }
}, 240_000);

test("holds each generic instance's explicit copies to what native lowering copies", () => {
  const directory = mkdtempSync("/tmp/z-native-instance-copy-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import { Map } from "std/collections";
      function twin<T>(value: T): Array<T> {
        let items = Array<T>();
        items.push(copy value);
        items.push(value);
        return items;
      }
      function main(): i32 {
        const numbers = twin(u32(1));
        let table = Map<u32, u32>();
        table.set(1, 2);
        const tables = twin(table);
        return numbers.length + tables.length == 4 ? 0 : 1;
      }`;
    writeFileSync(input, source);
    check(source, input);
    const emitted = native("self-host-emit", input);
    assert.equal(emitted.status, 1, emitted.stdout);
    assert.match(emitted.stderr, /error\[Z1000\]: explicit copy of "Map<u32, u32>" is not executable in the native compiler yet \(in specialization twin<T = Map<u32, u32>>\)/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("holds in arguments to stored values and the temporaries a call can lend", () => {
  const prelude = `
    struct Named { name: String; }
    class Holder { readonly value: u32; constructor(in value: u32) { this.value = value; } }
    struct Counter { total: u32; function add(in amount: u32): u32 { return this.total + amount; } }
    function four(): u32 { return 4; }
    function show<T>(in value: T): void {}
    function take(in value: u32): u32 { return value; }
    function takeNamed(in value: Named): usize { return value.name.byteLength; }
  `;
  const stored = (name: string) => new RegExp(`borrowed argument to "${name}" must be stored or a struct literal`);
  const cases: [string, RegExp, RegExp?][] = [
    ["const result = take(x + 1);", stored("take")],
    ["const result = take(four());", stored("take")],
    ["const result = counter.add(2);", stored("add")],
    ["const holder = new Holder(3);", stored("constructor")],
    ["show(x + 1);", stored("show")],
  ];
  const program = (statement: string) => `${prelude}
    function main(): i32 {
      const x: u32 = 4;
      const counter = Counter({ total: 1 });
      ${statement}
      return 0;
    }
  `;
  // A literal lent to a call once reached C as the address of an rvalue.
  rejects(program("const result = take(7);"), stored("take"));
  for (const [statement, stage0Message, nativeMessage] of cases) {
    rejects(program(statement), stage0Message, nativeMessage ?? stage0Message, ["self-host-resolve"]);
  }
  rejects(`${prelude}
    function apply(handler: (in value: u32) => u32): u32 { return handler(7); }
    function main(): i32 { return 0; }
  `, stored("handler"), stored("handler"), ["self-host-resolve"]);
}, 240_000);

test("rejects calling a local value that shadows a function", () => {
  for (const signature of ["(value: u32): u32", "<T>(value: T): T"]) {
    rejects(`
      struct Pair { left: u32; right: u32; }
      function pair${signature} { return value; }
      function main(): i32 {
        const pair = Pair({ left: 3, right: 4 });
        const next = pair(u32(5));
        return 0;
      }
    `, /"pair" is not callable/, /"pair" is not callable/, ["self-host-resolve"]);
  }
}, 240_000);

test("reports an explicit Map copy native cannot lower as Z1000", () => {
  const directory = mkdtempSync("/tmp/z-native-map-copy-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import { Map } from "std/collections";
      function main(): i32 {
        let table = Map<u32, u32>();
        table.set(1, 2);
        const copied = copy table;
        return copied.length == 1 ? 0 : 1;
      }`;
    writeFileSync(input, source);
    check(source, input);
    const emitted = native("self-host-emit", input);
    assert.equal(emitted.status, 1, emitted.stdout);
    assert.match(emitted.stderr, /error\[Z1000\]: explicit copy of "Map<u32, u32>" is not executable in the native compiler yet/);
    assert.doesNotMatch(emitted.stderr, /internal compiler error/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("checks a channel's message type where an endpoint crosses threads", () => {
  rejects(`
    import { Channel } from "std/channel";
    import { thread } from "std/thread";
    class Node { weight: u32; }
    async function main(): i32 {
      const { sender, receiver } = Channel<Node>.bounded(4);
      const syncSender = sender.sync();
      const worker = thread.spawn(move (): i32 => {
        const outcome = attempt syncSender.send(new Node({ weight: 3 }));
        return 0;
      });
      const syncReceiver = receiver.sync();
      const next = syncReceiver.receive();
      const joined = await worker;
      return 0;
    }
  `, /capture "syncSender" of type SyncSender<Node> cannot cross a native thread boundary/);
  rejects(`
    import { Channel, SyncSender } from "std/channel";
    import { thread } from "std/thread";
    class Node { weight: u32; }
    struct Holder { sender: SyncSender<Node>; }
    async function main(): i32 {
      const { sender, receiver } = Channel<Node>.bounded(4);
      const holder = Holder({ sender: sender.sync() });
      const worker = thread.spawn(move (): i32 => { const held = move holder; return 0; });
      const joined = await worker;
      return 0;
    }
  `, /capture "holder" of type Holder cannot cross a native thread boundary/);
}, 240_000);

test("moves aggregates holding endpoints into block-bodied thread workers", () => {
  const directory = mkdtempSync("/tmp/z-native-thread-block-");
  try {
    const input = resolve(directory, "main.zs");
    for (const declaration of [
      "const held = Holder({ sender: sender.sync() });",
      "let held = Array<SyncSender<u32>>(); held.push(sender.sync());",
      "const held: Option<SyncSender<u32>> = Option.some(sender.sync());",
    ]) {
      const source = `import { Channel, SyncSender } from "std/channel";
        import { thread } from "std/thread";
        struct Holder { sender: SyncSender<u32>; }
        async function main(): i32 {
          const { sender, receiver } = Channel<u32>.bounded(4);
          ${declaration}
          const worker = thread.spawn(move (): i32 => {
            const moved = move held;
            return 0;
          });
          const joined = await worker;
          return 0;
        }`;
      writeFileSync(input, source);
      check(source, input);
      // The worker context owns the moved aggregate and releases it there.
      const emitted = native("self-host-emit", input);
      assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
      execute(emitted.stdout, "", ["-pthread"]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("names imported and generic call targets by their source names", () => {
  const library = `
    export function take(in value: u32): u32 { return value; }
    export function show<T>(in value: T): void {}
    export function pairUp(out first: u32, out second: u32): void { first = 1; second = 2; }
  `;
  const cases: [string, string, RegExp][] = [
    ["take", "const value = take(7);", /borrowed argument to "take" must be stored or a struct literal/],
    ["show", "const x: u32 = 4; show(x + 1);", /borrowed argument to "show" must be stored or a struct literal/],
    ["take", "const value = take(7, 8);", /(?:"take"|: take) expects 1 argument\(s\), received 2/],
    ["pairUp", "let a: u32 = 0; let b: u32 = 0; pairUp(a, out b);",
      /"pairUp" requires out <mutable binding> for parameter 1/],
  ];
  for (const [name, body, message] of cases) {
    rejects(`import { ${name} } from "./lib.zs";
      function main(): i32 { ${body} return 0; }`, message, message, ["self-host-resolve"], { "lib.zs": library });
  }
}, 240_000);
