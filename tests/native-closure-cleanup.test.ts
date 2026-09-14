import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function execute(source: string, expected: string, expectedAllocations?: number, optimization = "-O1"): void {
  const directory = mkdtempSync("/tmp/z-closure-cleanup-");
  try {
    const executable = resolve(directory, "program");
    // UBSan checks generated operations; this ledger additionally proves that
    // invocation-local Strings and captured environments do not leak. It also
    // fails deterministically on double/foreign frees without an ASan process.
    const trackedSource = `
#include <stdlib.h>
#include <stdio.h>
static void *allocations[4096];
static size_t allocation_count;
static size_t allocation_calls;
static size_t allocation_index(void *pointer) {
  for (size_t i = 0; i < allocation_count; ++i) if (allocations[i] == pointer) return i;
  fprintf(stderr, "untracked allocation\\n"); exit(90);
}
static void record_allocation(void *pointer) {
  if (!pointer || allocation_count == 4096) exit(91);
  allocations[allocation_count++] = pointer;
  allocation_calls += 1;
}
static __attribute__((unused)) void *probe_malloc(size_t size) {
  void *pointer = malloc(size); record_allocation(pointer); return pointer;
}
static __attribute__((unused)) void *probe_calloc(size_t count, size_t size) {
  void *pointer = calloc(count, size); record_allocation(pointer); return pointer;
}
static __attribute__((unused)) void *probe_realloc(void *pointer, size_t size) {
  const size_t index = pointer ? allocation_index(pointer) : allocation_count;
  void *replacement = realloc(pointer, size);
  if (!replacement) exit(92);
  if (index == allocation_count) record_allocation(replacement);
  else allocations[index] = replacement;
  return replacement;
}
static __attribute__((unused)) void probe_free(void *pointer) {
  if (!pointer) return;
  const size_t index = allocation_index(pointer);
  allocations[index] = allocations[--allocation_count]; free(pointer);
}
#define malloc probe_malloc
#define calloc probe_calloc
#define realloc probe_realloc
#define free probe_free
#define main fixture_main
${source}
#undef main
int main(void) {
  const int status = fixture_main(${/\bmain\(int argc/.test(source) ? "0, NULL" : ""});
  if (allocation_count) { fprintf(stderr, "leaked %zu allocations\\n", allocation_count); return 93; }
  ${expectedAllocations === undefined ? "" : `if (allocation_calls != ${expectedAllocations}) { fprintf(stderr, "unexpected allocation count %zu\\n", allocation_calls); return 94; }`}
  return status;
}
`;
    const compilation = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable,
    ], { input: trackedSource, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error));
    const result = spawnSync(executable, [], {
      encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [fixture, expected] of [
  ["weak-array-storage.zs", "released observed item\n"],
  ["parenthesized-conditional-arms.zs", ""],
  ["nested-owned-callback-assignment.zs", "token\nrealm\nclosed pending\n"],
  ["closure-parameter-captures.zs", "owned parameter\nupdated parameter\n42\nouter parameter\n"],
  ["weak-inline-receiver.zs", "released owner\n"],
  ["weak-temporary-transfer.zs", "released item\n"],
  ["embedded-constant-inference.zs", ""],
  ["callback-shadowing.zs", ""],
  ["match-assignment.zs", "value\nindex\nindex arm\nold local\nfailed arm\nfailed arm\nrejected\nold field\nnew local\nnew field\n"],
  ["match-assignment-ownership.zs", "subject failed\nold local\nold field\nshared\n"],
  ["match-assignment-constructor.zs", "initial\nfallback\nreplacement\nreplacement\n"],
  ["named-callback-fields.zs", "callbacks reset\n"],
  ["lifecycle-callbacks.zs", "released owner\nreleased owner\nreleased owner\nreleased owner\n"],
  ["nested-match-construction.zs", "released selected arm\nanswer\nreleased fallback arm\nmissing\nreleased early arm\nreleased outer\nanswer\nanswer\nrejected\nanswer\n"],
  ["self-host-emit-block-closure-owners.zs",
    'notes: {"text":"early"}\nreleased early\n'
    + 'notes: {"text":"move"}\nconsumed move\nreleased move\n'
    + 'notes: {"text":"normal"}\npayload\nreleased nested\n'
    + "released payload\nreleased normal\nreleased listener notes\n"],
  ["self-host-emit-block-closure-cleanup-edges.zs",
    "released delivery\nprepare\nreleased error prepare\n"
    + "released prepared\nreleased delivery\ncallback\nreleased error callback\n"
    + "released iteration 1\nreleased iteration 2\nreleased prepared\nreleased delivery\ndelivered\n"
    + "released iteration 1\nreleased iteration 2\nfirst 3\nsecond 3\nreleased prepared\nreleased delivery\ndelivered\n"],
] as const) {
  test(`owns invocation-local storage in ${fixture}`, () => {
    const input = resolve(projectRoot, "tests/fixtures", fixture);
    const stage0 = compileToC(readFileSync(input, "utf8"), input);
    for (const optimization of ["-O0", "-O2"]) execute(stage0, expected, undefined, optimization);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error ?? emitted.signal));
    for (const optimization of ["-O0", "-O2"]) execute(emitted.stdout, expected, undefined, optimization);
  }, 240_000);
}

test("rejects unproven native owned indexed match destinations before emission", () => {
  const directory = mkdtempSync("/tmp/z-match-indexed-owner-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `struct Resource { value: i32; deinit {} }
      function main(): i32 {
        let values = Array<Resource>(Resource({ value: 1 }));
        const option = Option<i32>.some(42);
        values[0] = match (option) {
          some(value) => Resource({ value });
          none => Resource({ value: 0 });
        };
        return 0;
      }`;
    writeFileSync(input, source);
    execute(compileToC(source, input), "");
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 1, emitted.stderr || String(emitted.error ?? emitted.signal));
    assert.match(emitted.stderr, /native owned match assignment requires a named local or fixed field path/);
    assert.equal(emitted.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps nested block-callable cleanup and same-named parameters in separate invocation scopes", () => {
  const input = resolve(projectRoot, "tests/fixtures/block-closure-nested.zs");
  const expected = "nested true\nnested true\nnested true done\ntrue\nfalse\n"
    + "nested false\nnested false\nnested false done\ntrue\nfalse\n";
  execute(compileToC(readFileSync(input, "utf8"), input), expected);
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  execute(emitted.stdout, expected);
}, 240_000);

test("keeps inferred lexical environments callable without converting them to owned function values", () => {
  const directory = mkdtempSync("/tmp/z-lexical-closures-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `function main(): i32 {
      const offset = 2;
      const add = (value: i32): i32 => value + offset;
      let seed = 10;
      const snapshot = move (value: i32): i32 => seed + value;
      seed = 100;
      if (add(40) == 42 && snapshot(5) == 15 && seed == 100) return 0;
      return 1;
    }`;
    writeFileSync(input, source);
    execute(compileToC(source, input), "");
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("retains an owned callback returned through an in parameter beyond its creator", () => {
  const directory = mkdtempSync("/tmp/z-owned-callback-forwarding-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `type Callback = () => i32;
      struct Failure { code: i32; }
      function preserve(in callback: Callback): Callback { return callback; }
      function make(): Callback {
        const text = "snapshot";
        return preserve(move (): i32 => i32(text.byteLength));
      }
      function reject(in callback: Callback): void throws Failure {
        throw Failure({ code: callback() });
      }
      function rejected(): i32 {
        const text = "rejected";
        const result = attempt reject(move (): i32 => i32(text.byteLength));
        return match (result) { success => 1; failure(error) => error.code - 8; };
      }
      function main(): i32 {
        const callback = make();
        if (callback() != 8) return 1;
        return rejected();
      }`;
    writeFileSync(input, source);
    execute(compileToC(source, input), "");
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, source] of [
  ["reads the current parent binding", `function main(): i32 {
    let total = 10;
    const read = (): i32 => total;
    total = 42;
    return read() - 42;
  }`],
  ["mutates the original binding through a helper", `
    function increment(inout total: i32): i32 {
      total = total + 21;
      return total;
    }
    function main(): i32 {
      let total = 0;
      const add = (): i32 => increment(inout total);
      if (add() != 21 || add() != 42) return 1;
      return total - 42;
    }`],
  ["observes cleanup-free aggregate fields", `
    struct Counter { count: i32; }
    function main(): i32 {
      let counter = Counter({ count: 10 });
      const read = (): i32 => counter.count;
      counter.count = 42;
      return read() - 42;
    }`],
  ["borrows parent input and inout parameters", `
    function add(inout total: i32, in amount: i32): i32 {
      total = total + amount;
      return total;
    }
    function update(inout total: i32, in amount: i32): i32 {
      const increment = (): i32 => add(inout total, in amount);
      if (increment() != 21) return 1;
      return increment() - 42;
    }
    function main(): i32 {
      let total = 0;
      const amount = 21;
      if (update(inout total, in amount) != 0) return 1;
      return total - 42;
    }`],
  ["forwards nested borrowed expressions without capturing their bodies", `
    function invoke(in callback: () => i32): i32 { return callback(); }
    function main(): i32 {
      let total = 10;
      const read = (): i32 => invoke((): i32 => total);
      total = 42;
      return read() - 42;
    }`],
  ["separates nested parameter capabilities", `
    function invoke(in callback: (value: i32) => i32): i32 { return callback(41); }
    function calculate(inout value: i32): i32 {
      const outer = (in value: i32): i32 => invoke((value: i32): i32 => value + 1);
      return outer(in value) - 42;
    }
    function main(): i32 {
      let value = 0;
      return calculate(inout value);
    }`],
  ["borrows a mutable enclosing closure parameter", `
    function increment(inout total: i32): i32 {
      total = total + 21;
      return total;
    }
    function invoke(in callback: () => i32): i32 { return callback(); }
    function main(): i32 {
      let count = 0;
      const update = (inout total: i32): i32 => invoke((): i32 => increment(inout total));
      if (update(inout count) != 21 || update(inout count) != 42) return 1;
      return count - 42;
    }`],
  ["uses contextual closure parameter types instead of same-named parent locals", `
    function increment(inout total: i32): i32 {
      total = total + 21;
      return total;
    }
    function invoke(in callback: () => i32): i32 { return callback(); }
    function main(): i32 {
      const total = false;
      let count = 0;
      const update: (inout total: i32) => i32 = (inout total): i32 => invoke((): i32 => increment(inout total));
      if (update(inout count) != 21 || update(inout count) != 42 || total) return 1;
      return count - 42;
    }`],
  ["preserves user names that resemble environment internals", `
    function main(): i32 {
      let environment = 1;
      let refcount = 2;
      const read = (): i32 => environment + refcount;
      environment = 20;
      refcount = 22;
      return read() - 42;
    }`],
] as const) {
  test(`borrowed expression closure ${name}`, () => {
    const directory = mkdtempSync("/tmp/z-expression-captures-");
    try {
      const input = resolve(directory, "main.zs");
      writeFileSync(input, source);
      execute(compileToC(source, input), "", 0);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
      execute(emitted.stdout, "", 0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 240_000);
}

test("mutates lexical block captures without replacing them with invocation-local snapshots", () => {
  const directory = mkdtempSync("/tmp/z-mutable-lexical-closure-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `function main(): i32 {
      let total = 0;
      const add = (value: i32): void => { total = total + value; };
      add(20);
      add(22);
      return total - 42;
    }`;
    writeFileSync(input, source);
    execute(compileToC(source, input), "", 0);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, "", 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, source, expected] of [
  ["shares persistent scalar state across retained handles", `
    function increment(inout count: i32): i32 { count = count + 1; return count; }
    function make(): () => i32 {
      let count = 40;
      return move (): i32 => increment(inout count);
    }
    function main(): i32 {
      const next = make();
      const same = next;
      if (next() != 41) return 1;
      return same() - 42;
    }`, ""],
  ["keeps the parent scalar independent", `
    function increment(inout count: i32): i32 { count = count + 21; return count; }
    function main(): i32 {
      let count = 0;
      const next: () => i32 = move (): i32 => increment(inout count);
      count = 100;
      if (next() != 21 || next() != 42) return 1;
      return count - 100;
    }`, ""],
  ["owns mutable cleanup-bearing state exactly once", `
    import console from "std/console";
    struct Counter {
      count: i32;
      label: String;
      deinit { console.log(\`released \${this.label} at \${this.count}\`); }
    }
    function increment(inout counter: Counter): i32 {
      counter.count = counter.count + 1;
      return counter.count;
    }
    function make(): () => i32 {
      let counter = Counter({ count: 40, label: "counter" });
      return move (): i32 => increment(inout counter);
    }
    function main(): i32 {
      const next = make();
      const same = next;
      if (next() != 41) return 1;
      return same() - 42;
    }`, "released counter at 42\n"],
  ["forwards nested lexical mutation into its owned environment", `
    function increment(inout count: i32): i32 { count = count + 21; return count; }
    function invoke(in callback: () => i32): i32 { return callback(); }
    function make(): () => i32 {
      let count = 0;
      return move (): i32 => invoke((): i32 => increment(inout count));
    }
    function main(): i32 {
      const next = make();
      if (next() != 21) return 1;
      return next() - 42;
    }`, ""],
] as const) test(`owned expression closure ${name}`, () => {
  const directory = mkdtempSync("/tmp/z-owned-expression-captures-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    execute(compileToC(source, input), expected);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, body, expected] of [
  ["non-void return type independent of its enclosing function", `
    import console from "std/console";
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function main(): i32 {
      const answer = (): u8 => {
        const receipt = Receipt({ label: "narrow return" });
        return 42;
      };
      return i32(answer()) - 42;
    }`, "narrow return\n"],
  ["owned String result and invocation-local cleanup", `
    import console from "std/console";
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function main(): i32 {
      const message = (early: boolean): String => {
        const receipt = Receipt({ label: "released invocation" });
        const text = "answer";
        if (early) return text;
        const other = "later";
        return other;
      };
      const first = message(true);
      console.log(first);
      const second = message(false);
      console.log(second);
      return 0;
    }`, "released invocation\nanswer\nreleased invocation\nlater\n"],
  ["plain result inside a differently throwing parent", `
    struct ParentError { code: i32; }
    function check(): i32 throws ParentError {
      const answer = (): String => { return "answer"; };
      const text = answer();
      return i32(text.byteLength) - 6;
    }
    function main(): i32 {
      return match (attempt check()) { success(value) => value; failure(error) => error.code; };
    }`, ""],
  ["independent callback error and nested try result", `
    import console from "std/console";
    struct ParentError { message: String; }
    struct CallbackError { code: i32; }
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function fetch(fail: boolean): i32 throws CallbackError {
      if (fail) throw CallbackError({ code: 7 });
      return 42;
    }
    function check(): i32 throws ParentError {
      const answer = (fail: boolean): i64 throws CallbackError => {
        const receipt = Receipt({ label: "released callback" });
        return i64(try fetch(fail));
      };
      const success = attempt answer(false);
      match (success) { success(value) => { if (value != 42) return 1; } failure(_) => return 2; }
      const failure = attempt answer(true);
      return match (failure) { success(_) => 3; failure(error) => error.code - 7; };
    }
    function main(): i32 {
      return match (attempt check()) { success(value) => value; failure(_) => 4; };
    }`, "released callback\nreleased callback\n"],
  ["value matches and selecting blocks use the callback return type", `
    import console from "std/console";
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function main(): i32 {
      const answer = (option: Option<i32>): i64 => {
        const receipt = Receipt({ label: "released match" });
        return match (option) {
          some(value) => { const text = "payload"; console.log(text); select i64(value); }
          none => 42;
        };
      };
      if (answer(Option<i32>.some(42)) != 42) return 1;
      return i32(answer(Option<i32>.none)) - 42;
    }`, "payload\nreleased match\nreleased match\n"],
  ["owned parameters on returned, unused, and throwing paths", `
    import console from "std/console";
    struct Failure { message: String; }
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function main(): i32 {
      const choose = (text: String, keep: boolean): String => {
        if (keep) return text;
        return "fallback";
      };
      const input = "answer source";
      const returnedInput = input.copyBytes(0, 6);
      const unusedInput = input.copyBytes(0, 6);
      const first = choose(move returnedInput, true);
      const second = choose(move unusedInput, false);
      console.log(first);
      console.log(second);
      const reject = (text: String): i32 throws Failure => {
        throw Failure({ message: text });
      };
      const failureSource = "failure source";
      const failureInput = failureSource.copyBytes(0, 7);
      const inspect = (receipt: Receipt): i32 => { return i32(receipt.label.byteLength); };
      const receipt = Receipt({ label: "released parameter" });
      if (inspect(move receipt) != 18) return 5;
      const result = attempt reject(move failureInput);
      return match (result) {
        success(_) => 1;
        failure(error) => { console.log(error.message); select 0; }
      };
    }`, "answer\nfallback\nreleased parameter\nfailure\n"],
  ["nested conditional try and explicit match-arm returns", `
    struct Failure { code: i32; }
    function fetch(fail: boolean): i32 throws Failure {
      if (fail) throw Failure({ code: 7 });
      return 42;
    }
    function main(): i32 {
      const choose = (option: Option<boolean>): i64 throws Failure => {
        return match (option) {
          some(fail) => { return i64(fail ? try fetch(true) : try fetch(false)); }
          none => 0;
        };
      };
      const first = attempt choose(Option<boolean>.some(false));
      match (first) { success(value) => { if (value != 42) return 1; } failure(_) => return 2; }
      return match (attempt choose(Option<boolean>.some(true))) {
        success(_) => 3; failure(error) => error.code - 7;
      };
    }`, ""],
  ["direct try returns and borrowed owned results", `
    import console from "std/console";
    struct ParentError { code: i32; }
    struct Failure { message: String; }
    function fetch(fail: boolean): String throws Failure {
      const source = "answer";
      if (fail) throw Failure({ message: source.copyBytes(0, 6) });
      return source.copyBytes(0, 6);
    }
    function check(): i32 throws ParentError {
      const forward = (fail: boolean): String throws Failure => { return try fetch(fail); };
      const borrowed = (in source: String): String => { return copy source; };
      const observed = attempt forward(false);
      match (observed) {
        success(text) => { const result = borrowed(in text); console.log(result); }
        failure(_) => return 1;
      }
      return match (attempt forward(true)) {
        success(_) => 2;
        failure(error) => { console.log(error.message); select 0; }
      };
    }
    function main(): i32 {
      return match (attempt check()) { success(value) => value; failure(error) => error.code; };
    }`, "answer\nanswer\n"],
  ["void callbacks release owned parameters on fallthrough", `
    import console from "std/console";
    struct Receipt { label: String; deinit { console.log(this.label); } }
    function main(): i32 {
      const inspect = (receipt: Receipt): void => { console.log(receipt.label); };
      const receipt = Receipt({ label: "owned parameter" });
      inspect(move receipt);
      return 0;
    }`, "owned parameter\nowned parameter\n"],
  ["borrowed value fields and later parent updates", `
    struct Counter { count: i32; }
    function main(): i32 {
      let counter = Counter({ count: 10 });
      const add = (value: i32): void => { counter.count = counter.count + value; };
      counter.count = 20;
      add(22);
      return counter.count - 42;
    }`, ""],
  ["borrowed parent parameters", `
    function update(inout total: i32, in amount: i32): void {
      const add = (): void => { total = total + amount; };
      add();
      add();
    }
    function main(): i32 {
      let total = 0;
      const amount = 21;
      update(inout total, in amount);
      return total - 42;
    }`, ""],
  ["borrowed mutation through an inout call", `
    function increment(inout value: i32): void { value = value + 21; }
    function main(): i32 {
      let total = 0;
      const add = (): void => { increment(inout total); };
      add();
      add();
      return total - 42;
    }`, ""],
  ["compiler environment name hygiene", `
    import console from "std/console";
    function main(): i32 {
      let environment = 0;
      const add = (): void => { environment = environment + 21; };
      add();
      add();
      let refcount = 40;
      const snapshot: () => void = move (): void => {
        refcount = refcount + 2;
        console.log(\`\${refcount}\`);
      };
      snapshot();
      return environment + refcount - 82;
    }`, "42\n"],
  ["persistent owned scalar state", `
    import console from "std/console";
    function main(): i32 {
      let total = 10;
      const add: (value: i32) => void = move (value: i32): void => {
        total = total + value;
        console.log(\`\${total}\`);
      };
      total = 100;
      add(20);
      add(12);
      return total - 100;
    }`, "30\n42\n"],
  ["closure parameter shadowing", `
    function main(): i32 {
      let total = 40;
      let observed = 0;
      const add = (total: i32): void => {
        observed = observed + total;
      };
      add(2);
      return total + observed - 42;
    }`, ""],
  ["nested lexical invocation scopes", `
    import console from "std/console";
    function main(): i32 {
      const outer = (value: i32): void => {
        let total = value;
        const inner = (amount: i32): void => { total = total + amount; };
        inner(20);
        inner(22);
        console.log(\`\${total}\`);
      };
      outer(0);
      outer(1);
      return 0;
    }`, "42\n43\n"],
  ["nested parameter capability shadowing", `
    import console from "std/console";
    function main(): i32 {
      const outer = (in value: i32): void => {
        const inner = (value: i32): void => { console.log(\`\${value}\`); };
        inner(21);
        console.log(\`\${value}\`);
      };
      const value = 42;
      outer(in value);
      return 0;
    }`, "21\n42\n"],
  ["enclosing function parameter shadowing", `
    import console from "std/console";
    function update(inout value: i32): void {
      const inner = (value: i32): void => { console.log(\`\${value}\`); };
      inner(21);
      value = 42;
    }
    function main(): i32 {
      let value = 0;
      update(inout value);
      return value - 42;
    }`, "21\n"],
  ["proven synchronous forwarding and error cleanup", `
    import console from "std/console";
    struct Failure { message: String; }
    function invoke(in callback: () => void throws Failure): void throws Failure {
      try callback();
    }
    function main(): i32 {
      let total = 0;
      const result = attempt invoke((): void throws Failure => {
        const text = "invocation";
        total = total + 42;
        console.log(text);
        throw Failure({ message: "failed" });
      });
      match (result) {
        success => return 1;
        failure(error) => console.log(error.message);
      }
      return total - 42;
    }`, "invocation\nfailed\n"],
] as const) {
  test(`preserves block capture storage through ${name}`, () => {
    const directory = mkdtempSync("/tmp/z-block-capture-storage-");
    try {
      const input = resolve(directory, "main.zs");
      writeFileSync(input, body);
      execute(compileToC(body, input), expected);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
      execute(emitted.stdout, expected);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 240_000);
}

for (const [suspension, rejection] of [
  ["", /borrowed block environments in async functions require suspension-stable storage/],
  ["await scheduler.yield();", /native yield-frame local "add" requires supported owned frame storage/],
] as const) test(`gates native borrowed callback frame storage (${suspension || "async parent"})`, () => {
  const directory = mkdtempSync("/tmp/z-async-borrowed-block-environment-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, `import { scheduler } from "std/async";
      async function main(): i32 {
        let total = 0;
        const add = (): void => { total = total + 42; };
        ${suspension}
        add();
        return total - 42;
      }`);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(emitted.status, null, String(emitted.error));
    assert.notEqual(emitted.status, 0, emitted.stdout);
    assert.match(emitted.stderr, rejection);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, source, expected, allocations] of [
  ["String observes replaced owner storage", `function main(): i32 {
    const source = "first second end";
    let text = source.copyBytes(0, 5);
    const read = (): usize => text.byteLength;
    if (read() != 5) return 1;
    text = source.copyBytes(6, 12);
    return i32(read()) - 6;
  }`, "", 2],
  ["block mutation leaves custom cleanup with its owner", `
    import console from "std/console";
    struct Counter {
      count: i32; label: String;
      deinit { console.log(\`released \${this.count}\`); }
    }
    function main(): i32 {
      const source = "owned";
      let counter = Counter({ count: 0, label: source.copyBytes(0, 5) });
      const add = (amount: i32): i32 => {
        counter.count = counter.count + amount;
        return counter.count;
      };
      if (add(20) != 20 || add(22) != 42) return 1;
      return counter.count - 42;
    }`, "released 42\n", undefined],
  ["input parameters stay borrowed across synchronous forwarding", `
    struct Counter { count: i32; label: String; }
    function invoke(in callback: () => i32): i32 { return callback(); }
    function increment(inout counter: Counter, in label: String): i32 {
      counter.count = counter.count + i32(label.byteLength);
      return counter.count;
    }
    function update(inout counter: Counter, in label: String): i32 {
      return invoke((): i32 => increment(inout counter, in label));
    }
    function main(): i32 {
      const source = "answer";
      const label = source.copyBytes(0, 6);
      let counter = Counter({ count: 30, label: "counter" });
      if (update(inout counter, in label) != 36) return 1;
      return update(inout counter, in label) - 42;
    }`, "", 1],
  ["Array mutation and subsequent parent use", `
    function append(inout values: Array<i32>, value: i32): void { values.push(value); }
    function main(): i32 {
    let values = Array<i32>();
    const add = (value: i32): void => { append(inout values, value); };
    add(20);
    add(22);
    return values[0] + values[1] - 42;
  }`, "", undefined],
  ["throwing callback copies an error without consuming its captured String", `
    import console from "std/console";
    struct Failure { message: String; }
    function invoke(in callback: () => i32 throws Failure): i32 throws Failure {
      return try callback();
    }
    function main(): i32 {
      const source = "failure";
      const text = source.copyBytes(0, 7);
      const observed = attempt invoke((): i32 throws Failure => {
        throw Failure({ message: copy text });
      });
      match (observed) {
        success(_) => return 1;
        failure(error) => console.log(error.message);
      }
      return i32(text.byteLength) - 7;
    }`, "failure\n", undefined],
  ["nested expression forwarding borrows one String", `
    function invoke(in callback: () => usize): usize { return callback(); }
    function main(): i32 {
      const source = "answer";
      const text = source.copyBytes(0, 6);
      const read = (): usize => invoke((): usize => text.byteLength);
      return i32(read()) - 6;
    }`, "", 1],
  ["borrowed ARC identity survives callback invocation without an extra owner", `
    import console from "std/console";
    class Counter {
      count: i32;
      deinit { console.log(\`released \${this.count}\`); }
      function add(inout this, amount: i32): i32 {
        this.count = this.count + amount;
        return this.count;
      }
    }
    function main(): i32 {
      const counter = new Counter({ count: 0 });
      const add = (): i32 => counter.add(21);
      if (add() != 21) return 1;
      return add() - 42;
    }`, "released 42\n", undefined],
  ["block read and snapshot return keep the captured owner intact", `
    function main(): i32 {
      const source = "original source";
      const text = source.copyBytes(0, 8);
      const snapshot = (): String => { return copy text; };
      const first = snapshot();
      const second = snapshot();
      if (first.byteLength != 8 || second.byteLength != 8) return 1;
      return i32(text.byteLength) - 8;
    }`, "", 3],
  ["inline ARC mutation borrows the handle while reassignment still needs let", `
    class Counter {
      count: i32;
      function add(inout this): i32 { this.count = this.count + 1; return this.count; }
    }
    function invoke(in callback: () => i32): i32 { return callback(); }
    function main(): i32 {
      const counter = new Counter({ count: 40 });
      if (invoke((): i32 => counter.add()) != 41) return 1;
      return invoke((): i32 => invoke((): i32 => counter.add())) - 42;
    }`, "", 1],
  ["ARC handle replacement remains writable for a let capture", `
    import console from "std/console";
    class Counter {
      count: i32;
      deinit { console.log(\`released \${this.count}\`); }
    }
    function main(): i32 {
      let counter = new Counter({ count: 1 });
      const reset = (): void => { counter = new Counter({ count: 42 }); };
      reset();
      return counter.count - 42;
    }`, "released 1\nreleased 42\n", undefined],
  ["String replacement inside the callback cleans the former borrowed value", `
    function main(): i32 {
      const source = "before after";
      let text = source.copyBytes(0, 6);
      const reset = (): void => { text = source.copyBytes(7, 12); };
      reset();
      reset();
      return i32(text.byteLength) - 5;
    }`, "", 3],
] as const) test(`borrows cleanup-bearing capture: ${name}`, () => {
  const directory = mkdtempSync("/tmp/z-owned-storage-borrow-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    execute(compileToC(source, input), expected, allocations);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, expected, allocations);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("native inline borrowed callbacks preserve conditional and loop evaluation", () => {
  const directory = mkdtempSync("/tmp/z-borrowed-loop-callback-");
  const source = `function invoke(in callback: () => boolean): boolean { return callback(); }
    function increment(inout count: i32): boolean { count = count + 1; return count < 3; }
    function main(): i32 {
      let count = 0;
      if (false && invoke((): boolean => increment(inout count))) return 1;
      if (true || invoke((): boolean => increment(inout count))) {
        if (count != 0) return 2;
      }
      const selected = false ? invoke((): boolean => increment(inout count)) : true;
      if (!selected || count != 0) return 3;
      while (invoke((): boolean => increment(inout count))) {}
      return count - 3;
    }`;
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    // Stage 0's nested conditional/while argument-preparation gap is independent of
    // native callback storage. Keep it explicit until that emitter is extended.
    assert.throws(() => compileToC(source, input), /closure must be lowered from its const binding/);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, "", 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, source, rejection] of [
  ["borrowed String closure cannot escape its owner", `
    function make(): () => usize {
      const text = "owned source";
      return (): usize => text.byteLength;
    }
    function main(): i32 { return 0; }
  `, /borrowed capturing closure cannot become a function value/],
  ["callback cannot consume a captured String", `
    function main(): i32 {
      const text = "owned source";
      const take = (): String => { return move text; };
      const result = take();
      return 0;
    }
  `, /cannot move borrowed|cannot transfer ownership of "text" while it is borrowed/],
  ["borrowed class capture cannot gain mutable instance access", `
    class Counter {
      count: i32;
      function add(inout this): i32 { this.count = this.count + 1; return this.count; }
    }
    function read(in counter: Counter): i32 {
      const mutate = (): i32 => counter.add();
      return mutate();
    }
    function main(): i32 { return 0; }
  `, /immutable capture|immutable borrowed|immutable binding "counter"/],
] as const) test(`rejects invalid cleanup-bearing capture: ${name}`, () => {
  const directory = mkdtempSync("/tmp/z-owned-storage-borrow-rejection-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    assert.throws(() => compileToC(source, input), rejection);
    const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
    });
    assert.notEqual(native.status, null, String(native.error));
    assert.notEqual(native.status, 0, native.stdout);
    assert.match(native.stderr, rejection);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

for (const [name, source, rejection] of [
  ["borrowed expression in an async parent", `async function main(): i32 {
    let total = 10;
    const read = (): i32 => total;
    total = 42;
    return read() - 42;
  }`, /borrowed expression environments in async functions require suspension-stable storage/],
] as const) test(`gates unproven native storage for ${name}`, () => {
  const directory = mkdtempSync("/tmp/z-expression-capture-gate-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    if (name === "borrowed expression in an async parent") {
      assert.throws(() => compileToC(source, input), /needs owned task-frame lowering/);
    } else execute(compileToC(source, input), "");
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(emitted.status, null, String(emitted.error));
    assert.notEqual(emitted.status, 0, emitted.stdout);
    assert.match(emitted.stderr, rejection);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
