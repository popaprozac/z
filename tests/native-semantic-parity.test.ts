import {
  assert, check, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function native(command: "self-host-resolve" | "self-host-emit", input: string) {
  return spawnSync(process.execPath, [cli, command, input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
}

function execute(source: string, expected: string): void {
  const directory = mkdtempSync("/tmp/z-native-semantic-execute-");
  try {
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, "program");
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
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
  ["deinit-mutable-field", "3\n0\n2\n0\n1\n0\ndone\n"],
  ["generic-element-equality", "ok\n"],
  ["generic-imported-equality", "ok\n"],
  ["generic-literal-arguments", "ok\n"],
  ["private-aggregate-reachability", "right 300\nleft 42\ndone\n"],
  ["named-callable-arguments", "released\nok\n"],
  ["callable-receiver-borrows", "ok\n"],
  ["rebound-unused-locals", "1\n2\nok\n"],
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

test("checks dependent literal ranges and concrete parameter types at specialization", () => {
  for (const [type, literal, message] of [
    ["u8", "300", /literal 300.*u8.*specialization/],
    ["u8", "-1", /literal -1.*u8.*specialization/],
    ["String", "36", /numeric type.*String.*specialization/],
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
    function append(inout values: Array<i32>, value: i32): void { values.push(value); }
    struct Lists {
      next: Array<i32>;
      function invalid(inout this): void { append(inout this.next, this.next[0]); }
    }
    function main(): i32 { return 0; }
  `, /overlapping/);
}, 240_000);

test("does not infer disjoint storage through potentially aliased ARC fields", () => {
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
