import {
  assert, cli, compileToC, diagnostics, mkdtempSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";
import { callbackParameterDoesNotEscape } from "../compiler/src/callback-nonescape.ts";
import { lex } from "../compiler/src/lexer.ts";
import { parse } from "../compiler/src/parser.ts";

function checkBoth(source: string, rejection = false, siblings: Record<string, string> = {}): void {
  const directory = mkdtempSync("/tmp/z-callback-nonescape-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, source);
    for (const [name, contents] of Object.entries(siblings)) writeFileSync(resolve(directory, name), contents);
    if (rejection) {
      assert.throws(() => compileToC(source, input), /borrowed callback.*proven non-escaping parameter/);
      assert.ok(diagnostics(source, input).some((diagnostic) => diagnostic.code === "Z0212"
        && /borrowed callback.*proven non-escaping parameter/.test(diagnostic.message)));
    } else {
      compileToC(source, input);
    }
    // Use the native resolver directly, not parity fallback through Stage 0.
    const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
    });
    if (rejection) {
      assert.notEqual(native.status, null, String(native.error));
      assert.notEqual(native.status, 0, native.stdout);
      assert.match(native.stderr, /Z0212\]:.*borrowed callback.*proven non-escaping parameter/);
    } else {
      assert.equal(native.status, 0, native.stderr || String(native.error));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [name, helper] of [
  ["return", "return callback;"],
  ["typed local", "const stored: Callback = callback; return stored;"],
  ["owned capture", "const stored: Callback = move (): i32 => callback(); return stored;"],
  ["aggregate storage", "const holder = Holder({ callback }); return holder.callback;"],
] as const) {
  test(`rejects borrowed callback escape through ${name} in both checkers`, () => {
    checkBoth(`type Callback = () => i32;
      struct Holder { callback: Callback; }
      function preserve(in callback: Callback): Callback { ${helper} }
      function main(): i32 {
        const count = 42;
        const stored = preserve((): i32 => count);
        return stored() - 42;
      }`, true);
  }, 240_000);
}

test("rejects escape hidden behind a synchronous forwarding chain", () => {
  checkBoth(`type Callback = () => i32;
    function retain(in callback: Callback): Callback { return callback; }
    function forward(in callback: Callback): Callback { return retain(in callback); }
    function main(): i32 {
      const count = 42;
      const stored = forward((): i32 => count);
      return stored() - 42;
    }`, true);
}, 240_000);

test("never assumes recursive forwarding is nonescaping", () => {
  checkBoth(`type Callback = () => i32;
    function recurse(in callback: Callback, done: boolean): i32 {
      if (done) return callback();
      return recurse(in callback, true);
    }
    function main(): i32 {
      const count = 42;
      return recurse((): i32 => count, false) - 42;
    }`, true);
}, 240_000);

test("does not mistake shadowed or unknown callees for a proven source body", () => {
  // Nested callable types remain gated by sema. Exercise the source-body proof
  // directly so that lifting that unrelated gate cannot invent nonescape.
  const source = `type Callback = () => i32;
    function inspect(in callback: Callback): i32 { return callback(); }
    function forward(in callback: Callback, inspect: (in callback: Callback) => i32): i32 {
      return inspect(in callback);
    }
    function unknown(in callback: Callback): i32 { return indirect(callback); }`;
  const program = parse(lex(source, "proof.zs"), "proof.zs");
  const resolve = (callee: import("../compiler/src/ast.ts").Expression) =>
    callee.kind === "identifier" ? program.functions.find((item) => item.name === callee.name) ?? null : null;
  assert.equal(callbackParameterDoesNotEscape(program.functions[0]!, 0, resolve), true);
  assert.equal(callbackParameterDoesNotEscape(program.functions[1]!, 0, resolve), false);
  assert.equal(callbackParameterDoesNotEscape(program.functions[2]!, 0, resolve), false);
}, 240_000);

test("proves direct synchronous invocation and named helper forwarding without changing in", () => {
  checkBoth(`type Callback = () => i32;
    function invoke(in callback: Callback): i32 { return callback(); }
    function forward(in callback: Callback): i32 { return invoke(in callback); }
    function conditional(in callback: Callback, use: boolean): i32 {
      if (use) return forward(callback);
      return 0;
    }
    struct Reader {
      function inspect(in callback: Callback): i32 { return callback(); }
    }
    function main(): i32 {
      const count = 21;
      const reader = Reader();
      return conditional((): i32 => count, true) + reader.inspect((): i32 => count) - 42;
    }`);
}, 240_000);

test("proves generic synchronous helpers and throwing invocation", () => {
  checkBoth(`function invoke<T>(in callback: () => T): T { return callback(); }
    function main(): i32 {
      const count = 42;
      return invoke<i32>((): i32 => count) - 42;
    }`);
  checkBoth(`struct Failure { code: i32; }
    function invoke(in callback: () => i32 throws Failure): i32 throws Failure {
      return try callback();
    }
    function observed(): i32 throws Failure {
      const count = 42;
      return try invoke((): i32 throws Failure => count) - 42;
    }
    function main(): i32 {
      return match (attempt observed()) { success(value) => value; failure(error) => error.code; };
    }`);
}, 240_000);

test("preserves body evidence through cross-module named imports and aliases", () => {
  checkBoth(`import { forward as inspect } from "./helpers.zs";
    function main(): i32 {
      const count = 42;
      return inspect((): i32 => count) - 42;
    }`, false, {
    "helpers.zs": `import { invoke as call } from "./invoke.zs";
      export function forward(in callback: () => i32): i32 { return call(in callback); }`,
    "invoke.zs": "export function invoke(in callback: () => i32): i32 { return callback(); }",
  });
}, 240_000);

test("keeps explicitly owned callbacks legal at retaining boundaries", () => {
  checkBoth(`type Callback = () => i32;
    function preserve(in callback: Callback): Callback { return callback; }
    function make(): Callback {
      const count = 42;
      return preserve(move (): i32 => count);
    }
    function main(): i32 { const stored = make(); return stored() - 42; }`);
}, 240_000);
