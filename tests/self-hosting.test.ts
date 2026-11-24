import { chmodSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ApiNoteConflictError,
  DiagnosticError,
  NativeFrontendDiagnosticError,
  analyzeSource,
  assert,
  basename,
  buildStage0ModuleGraph,
  check,
  cli,
  compileToC,
  compileToNative,
  completions,
  decodeSemanticTokens,
  decodeStage1DeclarationStream,
  decodeStage1ModuleGraphStream,
  decodeStage1ProgramBatchStream,
  decodeStage1ProgramStream,
  decodeStage1TokenStream,
  definition,
  delimiter,
  diagnostics,
  encodeForeignFunctionDeclarationStream,
  encodeStage1ModuleBatch,
  existsSync,
  formatDiagnostic,
  hostToolchainTest,
  hover,
  isProcessOutputOverflowError,
  mergeApiNotes,
  mkdirSync,
  mkdtempSync,
  normalizeForeignContracts,
  positionForOffset,
  projectRoot,
  readFileSync,
  readdirSync,
  realpathSync,
  resolve,
  resolveForeignFunctionDeclarationStreams,
  rmSync,
  runWithBufferedStdoutOrSpill,
  semanticTokens,
  semanticTokenTypes,
  spawn,
  spawnSync,
  statSync,
  test,
  utimesSync,
  writeFileSync,
} from "./support/bootstrap.ts";
import type {
  ForeignFunctionDeclaration,
  ForeignModuleDeclarations,
  ImportDeclaration,
} from "./support/bootstrap.ts";
import { selfHostExecutableDifferentialCorpus } from "./support/self-host-fixtures.ts";
import { createHash } from "node:crypto";
import { exerciseGeneratedAdapterLinking } from "./support/generated-adapter-linking.ts";
import { exerciseModuleHeaderBuilds } from "./support/module-header-builds.ts";

hostToolchainTest("releases captured class arguments and mutable deinit cleanup natively", () => {
  const directory = mkdtempSync("/tmp/z-native-capture-cleanup-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, `
      import console from "std/console";
      class Document {
        closed: boolean;
        constructor() { this.closed = false; }
        function close(inout this): void { this.closed = true; }
        deinit { if (this.closed) { console.log("closed"); } else { console.log("open"); } }
      }
      class Reservation {
        readonly document: Document;
        deinit { this.document.close(); }
      }
      function observe(reservation: Reservation): void { console.log("observed"); }
      function make(): () => void {
        const reservation = new Reservation({ document: new Document() });
        const callback: () => void = move (): void => observe(reservation);
        return callback;
      }
      function run(): void { const callback = make(); callback(); callback(); }
      function main(): i32 { run(); console.log("done"); return 0; }
    `);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(emitted.status, 0, emitted.stderr);
    const source = resolve(directory, "main.c");
    writeFileSync(source, emitted.stdout);
    for (const optimization of ["-O0", "-O2"]) {
      const binary = resolve(directory, `probe${optimization}`);
      const compiled = spawnSync("clang", [source, optimization, "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-o", binary], { encoding: "utf8", timeout: 30_000 });
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "observed\nobserved\nclosed\ndone\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

hostToolchainTest("transfers only the selected owned conditional arm", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-conditional-owned.zs");
  const directory = mkdtempSync("/tmp/z-owned-conditional-");
  try {
    for (const mode of ["emit", "self-host-emit"]) {
      const emitted = spawnSync(process.execPath, [cli, mode, fixture], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, "probe");
        const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
          input: emitted.stdout, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compiled.status, 0, compiled.stderr);
        const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(run.status, 0, run.stderr || String(run.signal));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

hostToolchainTest("preserves checked thread-any cleanup through native modules and final-owner release", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-emit-thread-any-deinit.zs");
  const source = readFileSync(fixture, "utf8");
  const directory = mkdtempSync("/tmp/z-native-deinit-any-");
  try {
    const marker = source.indexOf("async function main");
    writeFileSync(resolve(directory, "resources.zs"), source.slice(0, marker)
      .replace("struct Resource", "export struct Resource")
      .replace("readonly class SharedResource", "export readonly class SharedResource")
      .replace('"./thread-any-deinit.h"', JSON.stringify(resolve(projectRoot, "tests/fixtures/thread-any-deinit.h"))));
    const entry = resolve(directory, "main.zs");
    const genericEntry = resolve(directory, "generic.zs");
    writeFileSync(genericEntry, `import { Mutex } from "std/sync";
      import { thread } from "std/thread";
      struct Parcel<T> { value: T; deinit on thread.any {} }
      readonly class Holder { value: Mutex<Parcel<i32>>; }
      async function main(): i32 {
        const owner = new Holder({value: Mutex(Parcel<i32>({value: 42}))});
        const worker = thread.spawn(move (): i32 => owner.value.withLock((in value): i32 => value.value));
        const answer = await worker;
        return answer - 42;
      }`);
    writeFileSync(entry, `import { Mutex } from "std/sync";
      import { thread } from "std/thread";
      import { Resource, SharedResource } from "./resources.zs";
      import { z_cleanup_begin } from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/thread-any-deinit.h"))};
      ${source.slice(marker)}`);
    for (const input of [fixture, entry, genericEntry]) {
      const parity = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.equal(parity.status, 0, parity.stderr);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, "probe");
        const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
          "-I", resolve(projectRoot, "tests/fixtures"), optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary],
        { input: emitted.stdout, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
        assert.equal(compiled.status, 0, compiled.stderr);
        for (let run = 0; run < 8; run++) {
          const executed = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          assert.equal(executed.status, 0, executed.stderr || String(executed.signal));
        }
      }
    }
    const invalid = [
      `struct Inner { deinit {} } struct Owner { inner: Inner; deinit on thread.any {} }`,
      `class UI on thread.main { deinit on thread.any {} }`,
      `function update(): void on thread.main {} struct Owner { deinit on thread.any { update(); } }`,
      `struct Owner { deinit on fake.any {} }`,
    ];
    for (const declarations of invalid) {
      writeFileSync(entry, `import { thread } from "std/thread"; ${declarations} function main(): i32 { return 0; }`);
      const result = spawnSync(process.execPath, [cli, "self-host-emit", entry], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.notEqual(result.status, 0, declarations);
      assert.match(result.stderr, /arbitrary thread|executor-bound|thread.main|thread capability/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("preserves native subclass syntax while requiring ABI evidence for stored native fields", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/objc-subclass.zs");
  const result = spawnSync(process.execPath, [cli, "self-host-parse", fixture], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stage-1 parser matches/);
  const resolution = spawnSync(process.execPath, [cli, "self-host-emit", fixture], {
    encoding: "utf8", timeout: 180_000,
  });
  assert.equal(resolution.status, 1, resolution.stderr);
  assert.match(resolution.stderr, /Z0814/);
  assert.match(resolution.stderr, /native stored fields currently support owned String, scalars, plain native value records, strong imported Objective-C references, and Weak<T> or Option<Weak<T>>/);
  const directory = mkdtempSync("/tmp/z-subclass-parser-");
  try {
    const vocabulary = resolve(directory, "main.zs");
    writeFileSync(vocabulary, `
      class Vocabulary { override: i32; }
      function main(): i32 {
        const super = new Vocabulary({ override: 1 });
        const extends = 1;
        return super.override - extends;
      }
    `);
    const contextual = spawnSync(process.execPath, [cli, "self-host-parse", vocabulary], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(contextual.status, 0, contextual.stderr);
    writeFileSync(vocabulary, 'class Ordinary { override function value(): i32 as "value" { return 0; } }\nfunction main(): i32 { return 0; }\n');
    const ordinary = spawnSync(process.execPath, [cli, "self-host-emit", vocabulary], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(ordinary.status, 1, ordinary.stderr);
    assert.match(ordinary.stderr, /Z0814/);
    assert.match(ordinary.stderr, /`override` requires an imported Objective-C superclass/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 330_000);

test("checks async scope against the innermost native function context", () => {
  const directory = mkdtempSync("/tmp/z-async-scope-context-");
  try {
    const input = resolve(directory, "main.zs");
    for (const source of [
      "function main(): i32 { async scope {} return 0; }",
      "struct Runner { function run(): void { async scope {} } } function main(): i32 { return 0; }",
      "async function main(): i32 { const callback = (): void => { async scope {} }; return 0; }",
    ]) {
      writeFileSync(input, source);
      assert.throws(() => check(source, input), /async scope requires.*async function/);
      const result = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 1, result.stderr || String(result.error));
      assert.match(result.stderr, /Z0703.*async scope requires.*async function/);
    }
    const source = "async function main(): i32 { async scope {} return 0; }";
    writeFileSync(input, source);
    assert.doesNotThrow(() => check(source, input));
    const valid = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL",
    });
    assert.equal(valid.status, 0, valid.stderr || String(valid.error));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("tokenizes real Z source with checked UTF-8 operations and TextBuffer", () => {
  const application = resolve(projectRoot, "examples/applications/source-inspector/main.zs");
  const lexer = resolve(projectRoot, "compiler/frontend/lexer.zs");
  const smoke = resolve(projectRoot, "examples/applications/source-inspector/lexer-smoke.zs");
  const smokeResult = spawnSync(process.execPath, [cli, "run", smoke], { encoding: "utf8" });
  assert.equal(smokeResult.status, 0, smokeResult.stderr);
  const generatorSmoke = resolve(projectRoot, "examples/applications/source-inspector/generator-smoke.zs");
  const generatorResult = spawnSync(process.execPath, [cli, "run", generatorSmoke], { encoding: "utf8" });
  assert.equal(generatorResult.status, 0, generatorResult.stderr);
  assert.equal(
    generatorResult.stdout,
    "identifier answer\nidentifier value\n"
      + "summary bytes=27 lines=2 tokens=7 identifiers=2\n"
      + "error 1:1 unexpected source byte 64\n",
  );
  const nativeGenerator = spawnSync(
    process.execPath,
    [cli, "check", generatorSmoke, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeGenerator.status, 0, nativeGenerator.stderr);
  assert.match(nativeGenerator.stdout, /native frontend hybrid/);
  const result = spawnSync(process.execPath, [cli, "run", application, "--", lexer], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lexer\.zs: \d+ lines, \d+ UTF-8 bytes/);
  assert.match(result.stdout, /\d+ tokens: \d+ identifiers, \d+ numbers/);
  assert.match(result.stdout, /\d+ strings/);
  assert.match(result.stdout, /first identifier: TextBuffer/);

  const parityInput = resolve(projectRoot, "tests/fixtures/self-host-lexer-input.zs");
  assert.doesNotThrow(() => check(readFileSync(parityInput, "utf8"), parityInput));
  const parityResult = spawnSync(process.execPath, [cli, "self-host-lex", parityInput, lexer], { encoding: "utf8" });
  assert.equal(parityResult.status, 0, parityResult.stderr);
  assert.match(parityResult.stdout, /self-host-lexer-input\.zs: stage-1 lexer matches \d+ tokens/);
  assert.match(parityResult.stdout, /lexer\.zs: stage-1 lexer matches \d+ tokens/);

  assert.throws(
    () => check("const value = 1; /* open", "unterminated-comment.zs"),
    /unterminated block comment/,
  );

  assert.throws(
    () => decodeStage1TokenStream("identifier\tnope\t0000000000000001\t0000000000000001\t61\n", parityInput),
    /malformed stage-1 token offset/,
  );
}, 60_000);

test("parses declarations, function bodies, and type shapes in native Z", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-parser-input.zs");
  const asyncClosureFixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-parser-async-closure.zs",
  );
  const lexer = resolve(projectRoot, "compiler/frontend/lexer.zs");
  const parser = resolve(projectRoot, "compiler/frontend/parser.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "self-host-parse", fixture, asyncClosureFixture, lexer, parser, "--timings"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-host-parser-input\.zs: stage-1 parser matches 17 declarations, 4 imports, 7 function signatures, 7 function bodies, and 6 type shapes/);
  assert.match(result.stdout, /self-host-parser-async-closure\.zs: stage-1 parser matches 4 declarations, 1 imports, 3 function signatures, 3 function bodies, and 0 type shapes/);
  assert.match(result.stdout, /lexer\.zs: stage-1 parser matches 20 declarations, 1 imports, 15 function signatures, 15 function bodies, and 4 type shapes/);
  assert.match(result.stdout, /parser\.zs: stage-1 parser matches \d+ declarations, \d+ imports, \d+ function signatures, \d+ function bodies, and \d+ type shapes/);
  assert.match(result.stdout, /stage-1 parser timing \(4 files, cache (?:hit|miss; seed compile \+ self-emission \+ native build \+ fixed-point verification included)\)/);
  assert.match(result.stdout, /native in-process batch \(host file I\/O \+ FFI \+ lex \+ parse \+ encode\): \d+\.\d{2} ms/);

  const directory = mkdtempSync("/tmp/z-self-host-parser-");
  const invalidPath = resolve(directory, "invalid.zs");
  writeFileSync(invalidPath, "function incomplete(): i32 {\n");
  const invalid = spawnSync(process.execPath, [cli, "self-host-parse", invalidPath], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /parser error at 1:\d+: unterminated the body of incomplete/);

  assert.throws(
    () => decodeStage1DeclarationStream("function\tmaybe\t0\t0000000000000000\t0000000000000001\t0000000000000001\t6d61696e\n", fixture),
    /malformed stage-1 declaration export state/,
  );
  assert.throws(
    () => decodeStage1ProgramStream("signature\t0000000000000000\t0000000000000001\t0000000000000001\tnot-hex\n", fixture),
    /malformed stage-1 function signature text/,
  );
  assert.throws(
    () => decodeStage1ProgramStream("shape\tfunction\t0000000000000000\t0000000000000001\t0000000000000001\t6d61696e\n", fixture),
    /malformed stage-1 type shape kind/,
  );
  assert.throws(
    () => decodeStage1ProgramStream("importShape\t0000000000000000\t0000000000000001\t0000000000000001\tnot-hex\n", fixture),
    /malformed stage-1 import shape text/,
  );
  assert.throws(
    () => decodeStage1ProgramStream("body\t0000000000000000\t0000000000000001\t0000000000000001\tnot-hex\n", fixture),
    /malformed stage-1 function body text/,
  );
  const batch = decodeStage1ProgramBatchStream(
    `file\t${Buffer.from(fixture).toString("hex")}\nfunction\t0\t0\t0000000000000000\t0000000000000001\t0000000000000001\t6d61696e\n`,
  );
  assert.equal(batch.get(fixture)?.declarations[0]?.name, "main");
  assert.throws(
    () => decodeStage1ProgramBatchStream("function\t0\t0\t0000000000000000\t0000000000000001\t0000000000000001\t6d61696e\n"),
    /before its file header/,
  );
}, 10_000);

test("keeps raw native bodies opaque across native lexer and parser parity", () => {
  const input = resolve(projectRoot, "examples/interop/raw/native-boundary.zs");
  const lexical = spawnSync(
    process.execPath,
    [cli, "self-host-lex", input],
    { encoding: "utf8" },
  );
  assert.equal(lexical.status, 0, lexical.stderr);
  assert.match(lexical.stdout, /native-boundary\.zs: stage-1 lexer matches \d+ tokens/);

  const structural = spawnSync(
    process.execPath,
    [cli, "self-host-parse", input],
    { encoding: "utf8" },
  );
  assert.equal(structural.status, 0, structural.stderr);
  assert.match(
    structural.stdout,
    /native-boundary\.zs: stage-1 parser matches 2 declarations, 0 imports, 2 function signatures, 2 function bodies, and 0 type shapes/,
  );

  const native = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(native.status, 0, native.stderr);
  const observedExpressions = native.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = native.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(observedExpressions, "7");
  assert.equal(authoritativeExpressions, observedExpressions);

  const rawEmissionDirectory = mkdtempSync("/tmp/z-native-raw-emission-");
  const rawEmissionInput = resolve(rawEmissionDirectory, "main.zs");
  writeFileSync(
    rawEmissionInput,
    "function add(left: i32, right: i32): i32 = raw c {\n"
      + "  return left + right;\n"
      + "}\n"
      + "function main(): i32 { return add(20, 22) - 42; }\n",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", rawEmissionInput],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /int32_t _z_function_\d+_add\(int32_t left, int32_t right\)[\s\S]*return left \+ right;/);
  assert.doesNotMatch(
    emission.stdout,
    /int32_t _z_function_\d+_add\(int32_t left, int32_t right\) \{\s*\(void\)left;\s*\(void\)right;\s*\}/,
  );

  const directory = mkdtempSync("/tmp/z-native-contextual-raw-");
  const ordinaryBinding = resolve(directory, "main.zs");
  writeFileSync(
    ordinaryBinding,
    "function main(): i32 {\n"
      + "  const raw: i32 = 42;\n"
      + "  const c: i32 = raw;\n"
      + "  return c - 42;\n"
      + "}\n",
  );
  const ordinary = spawnSync(
    process.execPath,
    [cli, "check", ordinaryBinding, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(ordinary.status, 0, ordinary.stderr);
}, 20_000);

test("keeps explicit immutable call-site borrows in native frontend parity", () => {
  const input = resolve(projectRoot, "tests/fixtures/native-explicit-in.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /uses 2 function, 0 method, and 0 constructor native-authoritative contracts/,
  );
  assert.match(
    result.stdout,
    /uses 11 expression native-authoritative contracts/,
  );
});

test("emits disjoint projected inout field paths natively", () => {
  const directory = mkdtempSync("/tmp/z-native-projected-inout-");
  const input = resolve(directory, "main.zs");
  writeFileSync(
    input,
    "struct Point { x: i32; y: i32; }\n"
      + "function adjust(inout x: i32, inout y: i32): void {\n"
      + "  x = x + 1;\n"
      + "  y = y - 1;\n"
      + "}\n"
      + "function main(): i32 {\n"
      + "  let point = Point({ x: 20, y: 22 });\n"
      + "  adjust(inout point.x, inout point.y);\n"
      + "  return point.x - point.y;\n"
      + "}\n",
  );

  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /adjust\(&\(point\.x\), &\(point\.y\)\);/);

  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  writeFileSync(
    input,
    readFileSync(input, "utf8").replace(
      "adjust(inout point.x, inout point.y);",
      "adjust(inout point.x, inout point.x);",
    ),
  );
  const duplicate = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(duplicate.status, 1);
  assert.match(
    duplicate.stderr,
    /overlapping inout and inout uses of "point\.x" in one call are not allowed/,
  );

  writeFileSync(
    input,
    "class Counter { value: i32; }\n"
      + "struct Holder { counter: Counter; }\n"
      + "function inspect(in counter: Counter): void {}\n"
      + "function main(): i32 {\n"
      + "  let holder = Holder({ counter: new Counter({ value: 42 }) });\n"
      + "  inspect(in holder.counter);\n"
      + "  return 0;\n"
      + "}\n",
  );
  const hiddenClassAlias = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(hiddenClassAlias.status, 1);
  assert.match(
    hiddenClassAlias.stderr,
    /projected capability access cannot borrow ARC class identity/,
  );

  writeFileSync(
    input,
    "struct Stats { visits: i32; }\n"
      + "class Document { title: String; revision: i32; stats: Stats; }\n"
      + "function adjust(inout first: i32, inout second: i32): void { first = first + 1; second = second + 1; }\n"
      + "function main(): i32 {\n"
      + "  const document = new Document({ title: \"Draft\", revision: 0, stats: Stats({ visits: 0 }) });\n"
      + "  const alias = document;\n"
      + "  const title = view document.title;\n"
      + "  alias.revision = alias.revision + 1;\n"
      + "  adjust(inout document.revision, inout alias.stats.visits);\n"
      + "  const length = i32(title.byteLength);\n"
      + "  alias.title = \"Published\";\n"
      + "  return length + document.revision + alias.stats.visits - 9;\n"
      + "}\n",
  );
  const classProjection = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(classProjection.status, 0, classProjection.stderr);

  writeFileSync(
    input,
    readFileSync(input, "utf8").replace(
      "alias.revision = alias.revision + 1;",
      "alias.title = \"Changed too early\";",
    ),
  );
  const aliasedViewMutation = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(aliasedViewMutation.status, 1);
  assert.match(
    aliasedViewMutation.stderr,
    /cannot mutate "alias\.title" while view "title" is live/,
  );
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

test("keeps optional struct fields ownership-safe through native parsing and emission", () => {
  const directory = mkdtempSync("/tmp/z-native-optional-fields-");
  const input = resolve(directory, "main.zs");
  writeFileSync(
    input,
    "struct Resource {\n"
      + "  value: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "\n"
      + "struct Envelope {\n"
      + "  payload?: Resource;\n"
      + "}\n"
      + "\n"
      + "function main(): i32 {\n"
      + "  const omitted = Envelope();\n"
      + "  const resource = Resource({ value: 42 });\n"
      + "  const lifted = Envelope({ payload: move resource });\n"
      + "  const option = Option<Resource>.some(Resource({ value: 42 }));\n"
      + "  const forwarded = Envelope({ payload: move option });\n"
      + "  const absent = match (in omitted.payload) {\n"
      + "    some(value) => value.value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  const present = match (in lifted.payload) {\n"
      + "    some(value) => value.value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  const forwardedValue = match (in forwarded.payload) {\n"
      + "    some(value) => value.value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  return absent + present + forwardedValue - 84;\n"
      + "}\n",
  );

  const parsed = spawnSync(
    process.execPath,
    [cli, "self-host-parse", input],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(
    parsed.stdout,
    /main\.zs: stage-1 parser matches 3 declarations, 0 imports, 1 function signatures, 1 function bodies, and 2 type shapes/,
  );

  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /\.payload = \(Z___z_Option_Resource\)\{\.tag = Z___z_Option_ResourceTag_none\}/);
  assert.match(
    emission.stdout,
    /\.payload = \(Z___z_Option_Resource\)\{\.tag = Z___z_Option_ResourceTag_some, \.payload = \{ \.some = \(_z_stage1_live_resource = false, resource\)\}\}/,
  );
  assert.match(emission.stdout, /\.payload = \(_z_stage1_live_option = false, option\)/);
  assert.doesNotMatch(
    emission.stdout,
    /\.payload = \{ \.some = option/,
  );
  // The source owner is disarmed at transfer; shared cleanup may remain, but
  // must be conditional rather than destroying the moved value again.
  assert.match(emission.stdout, /if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/);
  assert.doesNotMatch(emission.stdout, /^\s*Z_Resource_deinit\(&resource\);/m);

  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 20_000);

test("parses, lowers, and runs stable optional field and intrinsic call projection natively", () => {
  const directory = mkdtempSync("/tmp/z-native-optional-chain-");
  const input = resolve(directory, "main.zs");
  writeFileSync(
    input,
    "struct Item {\n"
      + "  value: i32;\n"
      + "}\n"
      + "\n"
      + "struct Envelope {\n"
      + "  item?: Item;\n"
      + "}\n"
      + "\n"
      + "function main(): i32 {\n"
      + "  const presentEnvelope = Envelope({ item: Item({ value: 42 }) });\n"
      + "  const present = presentEnvelope.item;\n"
      + "  const selected = present?.value;\n"
      + "  const absentEnvelope = Envelope();\n"
      + "  const absent = absentEnvelope.item;\n"
      + "  const missing = absent?.value;\n"
      + "  const text = Option<String>.some(\"z\");\n"
      + "  const byte = text?.byteAt(0);\n"
      + "  const selectedValue = match (selected) {\n"
      + "    some(value) => value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  const missingValue = match (missing) {\n"
      + "    some(value) => value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  const byteValue = match (byte) {\n"
      + "    some(value) => i32(value);\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  return selectedValue + missingValue + byteValue - 164;\n"
      + "}\n",
  );

  const parsed = spawnSync(
    process.execPath,
    [cli, "self-host-parse", input],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);

  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Tag_some \? \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_some/,
  );
  assert.match(emission.stdout, /z_string_byte_at/);
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 20_000);

test("keeps unsupported native optional-chain shapes explicit", () => {
  const directory = mkdtempSync("/tmp/z-native-optional-chain-boundaries-");
  const cases = [
    {
      name: "temporary",
      source: `
        struct Item { value: i32; }
        function find(): Option<Item> {
          return Option<Item>.some(Item({ value: 42 }));
        }
        function main(): i32 {
          const selected = find()?.value;
          return match (selected) { some(value) => value - 42; none => 1; };
        }
      `,
      expected: /error\[Z1000\]: temporary optional-chain receivers are not executable in the native compiler yet/,
    },
    {
      name: "view",
      source: `
        struct Document { title: String; }
        struct Library { document: Document; }
        function main(): i32 {
          const library = Option<Library>.some(Library({
            document: Document({ title: "draft" }),
          }));
          const document = library?.document;
          return match (in document) {
            some(value) => i32(value.title.byteLength) - 5;
            none => 1;
          };
        }
      `,
      expected: /error\[Z1000\]: cleanup-bearing optional-chain view projections are not executable in the native compiler yet/,
    },
    {
      name: "method",
      source: `
        function main(): i32 {
          const text = Option<String>.some("z");
          const selected = text?.copyBytes(0, 1);
          return match (selected) {
            some(value) => i32(value.byteLength) - 1;
            none => 1;
          };
        }
      `,
      expected: /error\[Z1000\]: optional-chain method "copyBytes" is not executable in the native compiler yet/,
    },
  ] as const;

  for (const testCase of cases) {
    const input = resolve(directory, `${testCase.name}.zs`);
    writeFileSync(input, testCase.source);
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 1);
    assert.match(emission.stderr, testCase.expected);
  }
  rmSync(directory, { recursive: true, force: true });
}, 40_000);

test("reports evidence-dependent native iteration boundaries before lowering", () => {
  const input = resolve(projectRoot, "examples/language/collections/set.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 1);
  assert.match(
    emission.stderr,
    /error\[Z1000\]: iteration over "Set<String>" is not executable in the native compiler yet; Array, fixed arrays, Map, and Slice<u8> are supported/,
  );
  assert.match(emission.stderr, /for \(const path of openDocuments\)/);
}, 20_000);

test("preserves local views through native lowering and C emission", () => {
  const input = resolve(projectRoot, "tests/fixtures/native-local-view.zs");
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /const Z_Node \* const node = &\(tree\.node\);/);
  assert.match(emission.stdout, /const Z___z_Array_i32 \* const numbers = &\(tree\.values\);/);
  assert.match(emission.stdout, /const Z_String \* const label = &\(tree\.label\);/);
  assert.match(emission.stdout, /Z___z_Array_i32_at\(&\(\(\*\(numbers\)\)\)/);
  assert.match(emission.stdout, /z_string_copy_bytes\(\(\*\(label\)\), (?:0|UINT64_C\(0\)), \(label\)->length\)/);
  assert.match(emission.stdout, /z_string_equal\(\(\*\(label\)\), Z_STRING_LITERAL\("ready"\)\)/);
  assert.match(emission.stdout, /observe\(node\)\), 5\)/);
  assert.doesNotMatch(emission.stdout, /Z_Node_deinit\(&\(node\)\)/);
  assert.doesNotMatch(emission.stdout, /Z___z_Array_i32_deinit\(&\(numbers\)\)/);
  assert.doesNotMatch(emission.stdout, /Z_String_deinit\(&\(label\)\)/);
  assert.match(emission.stdout, /Z_Tree_deinit\(&tree\)/);

  const directory = mkdtempSync("/tmp/z-native-local-view-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
}, 20_000);

test("infers chained collection method results during native lowering", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-chained-map-package/main.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z_Item_retain\(_z_stage1_match_payload_/);
  assert.match(emission.stdout, /Z_Item_read\(_z_stage1_match_payload_/);

  const directory = mkdtempSync("/tmp/z-native-chained-map-get-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
}, 60_000);

test("tracks direct local view loans by fixed-layout field path natively", () => {
  const directory = mkdtempSync("/tmp/z-native-local-view-path-");
  const input = resolve(directory, "main.zs");
  const prefix = [
    "struct Document { title: String; revision: i32; }",
    "function increment(inout value: i32): void { value = value + 1; }",
    "function retitle(inout value: String): void { value = \"Published\"; }",
  ];

  try {
    writeFileSync(input, [
      ...prefix,
      "function main(): i32 {",
      "  let document = Document({ title: \"Draft\", revision: 0 });",
      "  const title = view document.title;",
      "  increment(inout document.revision);",
      "  const length = title.byteLength;",
      "  document.title = \"Published\";",
      "  return i32(length) - 5;",
      "}",
      "",
    ].join("\n"));
    const valid = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(valid.status, 0, valid.stderr);

    writeFileSync(input, [
      ...prefix,
      "function main(): i32 {",
      "  let document = Document({ title: \"Draft\", revision: 0 });",
      "  const title = view document.title;",
      "  document.title = \"Published\";",
      "  return i32(title.byteLength);",
      "}",
      "",
    ].join("\n"));
    const sameField = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(sameField.status, 1);
    assert.match(
      sameField.stderr,
      /cannot mutate "document\.title" while view "title" is live/,
    );

    writeFileSync(input, [
      ...prefix,
      "function main(): i32 {",
      "  let document = Document({ title: \"Draft\", revision: 0 });",
      "  const title = view document.title;",
      "  retitle(inout document.title);",
      "  return i32(title.byteLength);",
      "}",
      "",
    ].join("\n"));
    const sameFieldCall = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(sameFieldCall.status, 1);
    assert.match(
      sameFieldCall.stderr,
      /cannot mutate "document\.title" while view "title" is live/,
    );

    writeFileSync(input, [
      ...prefix,
      "function main(): i32 {",
      "  let document = Document({ title: \"Draft\", revision: 0 });",
      "  const title = view document.title;",
      "  document = Document({ title: \"Published\", revision: 1 });",
      "  return i32(title.byteLength);",
      "}",
      "",
    ].join("\n"));
    const parent = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(parent.status, 1);
    assert.match(
      parent.stderr,
      /cannot mutate "document" while view "title" is live/,
    );

    writeFileSync(input, [
      "struct Document { title: String; }",
      "function main(): i32 {",
      "  let documents = Array<Document>(Document({ title: \"Draft\" }));",
      "  const title = view documents[0].title;",
      "  documents.push(Document({ title: \"Published\" }));",
      "  return i32(title.byteLength);",
      "}",
      "",
    ].join("\n"));
    const indexed = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(indexed.status, 1);
    assert.match(
      indexed.stderr,
      /cannot mutate "documents" while view "title" is live/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test("preserves multi-owner optional parameter views through native semantics and emission", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-resolve-parameter-optional-view.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /typedef Z_Document const \* Z___z_NicheViewOption_Document;/,
  );
  assert.match(
    emission.stdout,
    /return &\(\(\(\(Z___z_Array_Document_ConstData\)\(\(\*active\)\.documents\)\.data\)\[z_stage1_bounds_index\(index, \(\(\*active\)\.documents\)\.length\)\]\)\);/,
  );
  assert.match(
    emission.stdout,
    /return &\(\(\(\(Z___z_Array_Document_ConstData\)\(\(\*archive\)\.documents\)\.data\)\[z_stage1_bounds_index\(index, \(\(\*archive\)\.documents\)\.length\)\]\)\);/,
  );

  const directory = mkdtempSync("/tmp/z-native-parameter-optional-view-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const composition = resolve(
      projectRoot,
      "tests/fixtures/self-host-resolve-parameter-view-composition.zs",
    );
    const compositionEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", composition],
      { encoding: "utf8" },
    );
    assert.equal(compositionEmission.status, 0, compositionEmission.stderr);
    assert.match(
      compositionEmission.stdout,
      /Z_DocumentSelection Z_Workspace_endpoints\(const Z_Workspace \*self\)/,
    );
    assert.match(
      compositionEmission.stdout,
      /const Z_Document \* const first = _z_destructure_[0-9]+\.first;/,
    );
    const compositionExecutable = resolve(directory, "composition");
    const compositionCompilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", compositionExecutable],
      { encoding: "utf8", input: compositionEmission.stdout },
    );
    assert.equal(compositionCompilation.status, 0, compositionCompilation.stderr);
    const compositionExecution = spawnSync(compositionExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(compositionExecution.status, 0, compositionExecution.stderr);

    const destructureInvalid = resolve(
      projectRoot,
      "tests/fixtures/self-host-reject-parameter-view-destructure-mutation.zs",
    );
    const destructureInvalidResult = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", destructureInvalid],
      { encoding: "utf8" },
    );
    assert.equal(destructureInvalidResult.status, 1);
    assert.match(
      destructureInvalidResult.stderr,
      /cannot mutate "workspace" while view "last" is live/,
    );

    const invalid = resolve(
      projectRoot,
      "tests/fixtures/self-host-resolve-parameter-optional-view-invalid.zs",
    );
    const archiveResult = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", invalid],
      { encoding: "utf8" },
    );
    assert.equal(archiveResult.status, 1);
    assert.match(
      archiveResult.stderr,
      /cannot mutate "archive" while view "found" is live/,
    );

    const armInvalid = resolve(directory, "invalid-arm.zs");
    writeFileSync(
      armInvalid,
      readFileSync(input, "utf8").replace(
        "      const id = document.id;\n      active.add(Document({ id: 24 }));",
        "      active.add(Document({ id: 24 }));\n      const id = document.id;",
      ),
    );
    const armResult = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", armInvalid],
      { encoding: "utf8" },
    );
    assert.equal(armResult.status, 1);
    assert.match(
      armResult.stderr,
      /cannot mutate "active" while view "document" is live/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("returns retained parameter view aggregates through native semantics and emission", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-resolve-parameter-view-aggregate.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /typedef struct Z_DocumentSpan \{\n  Z_Document const \* first;\n  Z_Document const \* last;/,
  );
  assert.match(
    emission.stdout,
    /return \(Z_DocumentSpan\)\{\.first = &/,
  );
  assert.doesNotMatch(emission.stdout, /malloc\(sizeof\(Z_DocumentSpan\)/);

  const directory = mkdtempSync("/tmp/z-native-parameter-view-aggregate-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const invalid = resolve(
      projectRoot,
      "tests/fixtures/self-host-reject-parameter-view-aggregate-mutation.zs",
    );
    const invalidResult = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", invalid],
      { encoding: "utf8" },
    );
    assert.equal(invalidResult.status, 1);
    assert.match(
      invalidResult.stderr,
      /cannot mutate "workspace" while view "selected" is live/,
    );

    const localEscape = resolve(directory, "local-escape.zs");
    writeFileSync(localEscape, [
      "struct Document { id: i32; }",
      "struct DocumentSpan { first: view Document; last: view Document; }",
      "function invalid(): DocumentSpan {",
      "  const documents = Array<Document>(Document({ id: 20 }), Document({ id: 22 }));",
      "  return DocumentSpan({",
      "    first: view documents[0],",
      "    last: view documents[1],",
      "  });",
      "}",
      "function main(): i32 { return 0; }",
      "",
    ].join("\n"));
    const localResult = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", localEscape],
      { encoding: "utf8" },
    );
    assert.equal(localResult.status, 1);
    assert.match(
      localResult.stderr,
      /must borrow every view field from one immutable input or receiver/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("copies and moves owned fields through native object destructuring", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-owned-object-destructure.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_FileRecord z_stage1_copy_FileRecord\(Z_FileRecord source\)/,
  );
  assert.match(
    emission.stdout,
    /\.label = z_stage1_copy_Label\(source\.label\)/,
  );
  assert.match(
    emission.stdout,
    /\.tags = z_stage1_copy___z_Array_String\(source\.tags\)/,
  );
  assert.match(
    emission.stdout,
    /\.state = z_stage1_copy_RecordState\(source\.state\)/,
  );
  assert.match(
    emission.stdout,
    /_z_stage1_live_original = false, original/,
  );
  assert.match(
    emission.stdout,
    /_z_destructure_\d+\.path = \(__typeof__\(_z_destructure_\d+\.path\)\)\{\}/,
  );
  assert.match(
    emission.stdout,
    /Z_FileRecord_deinit\(&_z_destructure_\d+\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-owned-destructure-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const invalid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-owned-object-destructure-use-after-move.zs",
  );
  const invalidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", invalid],
    { encoding: "utf8" },
  );
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /use of moved value "record"/);
}, 240_000);

test("materializes concrete generic value structs through native ownership", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-generic-struct.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /typedef struct Z___z_mono_[A-Za-z0-9_]+ \{\s+int32_t first;\s+int32_t second;/,
  );
  assert.match(
    emission.stdout,
    /typedef struct Z___z_mono_[A-Za-z0-9_]+ \{\s+Z_String first;\s+Z_String second;/,
  );
  assert.match(
    emission.stdout,
    /z_string_copy\(words\.first\)/,
  );
  assert.match(
    emission.stdout,
    /Z_String_deinit\(&\(copied\.first\)\)/,
  );
  assert.match(
    emission.stdout,
    /_z_destructure_\d+\.first = \(__typeof__\(_z_destructure_\d+\.first\)\)\{\}/,
  );
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ Z___z_mono_[A-Za-z0-9_]+_create\(int32_t value\)/,
  );
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ Z___z_mono_[A-Za-z0-9_]+_create\(Z_String value\)/,
  );
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ number = Z___z_mono_[A-Za-z0-9_]+_create\(20\);/,
  );
  assert.match(
    emission.stdout,
    /static __attribute__\(\(unused\)\) void Z___z_mono_[A-Za-z0-9_]+_replace\(Z___z_mono_[A-Za-z0-9_]+ \*self, Z_String next\)/,
  );
  assert.match(
    emission.stdout,
    /static __attribute__\(\(unused\)\) bool Z___z_mono_[A-Za-z0-9_]+_occupied\(const Z___z_mono_[A-Za-z0-9_]+ \*self\)/,
  );
  assert.match(
    emission.stdout,
    /Z_String _z_stage1_assignment_(\d+) = next;\s+Z_String \*_z_stage1_assignment_slot_\1 = &\(self->value\);\s+Z_String_deinit\(_z_stage1_assignment_slot_\1\);\s+\*_z_stage1_assignment_slot_\1 = _z_stage1_assignment_\1;/,
  );
  assert.match(
    emission.stdout,
    /Z_String _z_stage1_return_\d+ = \(_z_stage1_live_this = false, self\.value\);/,
  );

  const moduleInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-generic-struct-modules/main.zs",
  );
  const moduleEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", moduleInput],
    { encoding: "utf8" },
  );
  assert.equal(moduleEmission.status, 0, moduleEmission.stderr);
  assert.equal(
    [
      ...moduleEmission.stdout.matchAll(
        /typedef struct Z___z_mono_[A-Za-z0-9_]+ \{/g,
      ),
    ].length,
    1,
    "one nominal specialization must cross the module ABI under every local spelling",
  );
  assert.match(
    moduleEmission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ Z___z_mono_[A-Za-z0-9_]+_create\(int32_t first, int32_t second\)/,
  );
  assert.match(
    moduleEmission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ pair = Z___z_mono_[A-Za-z0-9_]+_create\(20, 22\);/,
  );
  assert.match(
    moduleEmission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+ _z_function_\d+_makePair\(int32_t first, int32_t second\)/,
  );
  assert.match(
    moduleEmission.stdout,
    /int32_t _z_function_\d+_total\(Z___z_mono_[A-Za-z0-9_]+ const \*pair\)/,
  );
  assert.match(
    moduleEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z___z_mono_[A-Za-z0-9_]+_replaceSecond\(Z___z_mono_[A-Za-z0-9_]+ \*self, int32_t value\)/,
  );
  assert.match(
    moduleEmission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+_replaceSecond\(&\(updated\), 23\);/,
  );

  const directory = mkdtempSync("/tmp/z-native-generic-struct-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const moduleExecutable = resolve(directory, "module-program");
    const moduleCompilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", moduleExecutable],
      { encoding: "utf8", input: moduleEmission.stdout },
    );
    assert.equal(moduleCompilation.status, 0, moduleCompilation.stderr);
    const moduleExecution = spawnSync(moduleExecutable, [], { encoding: "utf8" });
    assert.equal(moduleExecution.status, 0, moduleExecution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("executes statically dispatched trait constraints natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-static-trait.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z_Service_start\(&\(\(\*service\)\), value\)/);
  assert.doesNotMatch(emission.stdout, /service\.start/);

  const directory = mkdtempSync("/tmp/z-native-static-trait-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("specializes exported trait adapters for private downstream types", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-static-trait-modules/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_PrivateLifecycle_start\(&\(\(_z_stage1_callable_environment->service\)\), &\(\(\*context\)\)\)/,
  );
  assert.doesNotMatch(emission.stdout, /service\.start/);

  const directory = mkdtempSync("/tmp/z-native-static-trait-modules-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released owned\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("specializes exported generic methods for private downstream types", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-static-trait-method-modules/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_PrivateLifecycle_start\(&\(service\)\)/,
  );
  assert.doesNotMatch(emission.stdout, /service\.start/);

  const directory = mkdtempSync("/tmp/z-native-static-trait-method-modules-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released private\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("forwards constrained generic parameters into imported generic methods", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-generic-constraint-forwarding/main.zs",
  );
  const invalid = resolve(
    projectRoot,
    "tests/fixtures/self-host-generic-constraint-forwarding/invalid.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const stage0Execution = spawnSync(
    process.execPath,
    [cli, "run", input],
    { encoding: "utf8" },
  );
  assert.equal(stage0Execution.status, 0, stage0Execution.stderr);

  for (const command of [
    ["check", invalid],
    ["self-host-resolve", invalid],
  ]) {
    const rejection = spawnSync(process.execPath, [cli, ...command], {
      encoding: "utf8",
    });
    assert.equal(rejection.status, 1, rejection.stderr);
    assert.match(
      rejection.stderr,
      /T does not satisfy Service for T in "(?:ServicesBuilder\.)?register"/,
    );
  }

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  const directory = mkdtempSync("/tmp/z-native-generic-constraint-forwarding-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("resolves trait conformance for a factory-returned imported type", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-imported-trait-factory/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-imported-trait-factory-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("transfers one retained captured callable into aggregate storage", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-callables.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_TransformAdapter_new\(Z_Function_[A-Za-z0-9_]+_retain\(operation\)\)/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /Z_TransformAdapter_new\(Z_Function_[A-Za-z0-9_]+_retain\(Z_Function_[A-Za-z0-9_]+_retain\(operation\)\)\)/,
  );
}, 240_000);

test("lowers early try closures and transfers cleanup-bearing match payloads once", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-try-closure-owned-match.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /static void z_stage1_callable__z_function_\d+_run_\d+_call\([\s\S]*if \(\(\*value\) != 42\)/,
  );
  assert.match(
    emission.stdout,
    /bool _z_stage1_live__z_stage1_match_payload_\d+_\d+ = true;/,
  );
  assert.match(
    emission.stdout,
    /Z_Record current = \(_z_stage1_live__z_stage1_match_payload_\d+_\d+ = false, _z_stage1_match_payload_\d+_\d+\);/,
  );

  const directory = mkdtempSync("/tmp/z-native-try-closure-match-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("transfers nested TaskControl ownership through matches and Map storage once", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-task-control-owned-match.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_Request request = \(_z_stage1_live__z_stage1_match_payload_\d+_\d+ = false, _z_stage1_match_payload_\d+_\d+\);/,
  );
  assert.match(
    emission.stdout,
    /Z___z_Map_3_u64Request_set\(&\(requests\), UINT64_C\(1\), \(_z_stage1_live_request = false, request\)\);/,
  );

  const directory = mkdtempSync("/tmp/z-native-task-control-owned-match-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("executes one scheduler-yield suspension in an imported async function", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-function-modules/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-function-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /frame->result = _z_function_\d+_loadValue\(frame->argument0\);/,
    );
    assert.match(emission.stdout, /if \(task->cancellation_requested\)/);
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 1;\n    z_stage1_async_enqueue\(task->executor, task\);/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("retains a class receiver and owned result across async method suspension", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-method-yield.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /frame->receiver = Z_Service_retain\(receiver\);/);
    assert.match(emission.stdout, /Z_Service_release\(frame->receiver\);/);
    assert.match(emission.stdout, /frame->result = Z_Service_invoke\(/);
    assert.match(emission.stdout, /if \(task->cancellation_requested\)/);
    assert.match(emission.stdout, /frame->live_result = true;/);
    assert.match(emission.stdout, /frame->live_result = false;/);
    assert.match(emission.stdout, /Z_Response_deinit\(&frame->result\);/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released async service\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("materializes typed errors from directly awaited async methods", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-method-throws.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-method-error-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /Z___z_Result_i32_DecodeError result;/,
    );
    assert.match(
      emission.stdout,
      /frame->result = Z_Decoder_decode\(frame->receiver\);/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("joins a native worker task from an async class method", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-method-thread-await.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-method-thread-await-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /frame->child = z_stage1_async_thread_await_Task___z_Result_usize_ReadError_start/,
    );
    assert.doesNotMatch(
      emission.stdout,
      /frame->result = Z_Reader_measure\(frame->receiver/,
    );
    assert.match(emission.stdout, /frame->receiver = Z_Reader_retain\(receiver\);/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("joins a fallible void native worker task from an async class method", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-method-thread-await-void.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-method-thread-await-void-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /frame->child = z_stage1_async_thread_await_Task___z_Result_void_WriteError_start/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("keeps typed worker try propagation inside the worker result context", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-worker-result-context.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-worker-result-context-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.doesNotMatch(
      emission.stdout,
      /\.payload = \{ \.success = _z_function_\d+_loadText\(/,
    );
    assert.doesNotMatch(
      emission.stdout,
      /Z___z_Result_void_FileError _z_stage1_failure/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("joins a non-throwing void native worker task", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-void.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-thread-void-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("preserves owned requests and typed errors across a placed async service call", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-service-owned-error.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-service-owned-error-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    // `dispatch` is a general frame: the Result and the arm's locals live in
    // it, and the placed call hops to main, moving `request` and retaining
    // `service`.
    assert.match(
      emission.stdout,
      /Z___z_Result_String_ServiceError _z_binding_called;/,
    );
    assert.match(emission.stdout, /Z_AsyncInvocation child;/);
    assert.match(
      emission.stdout,
      /z_stage1_async_main_executor\(\), Z_Service_retain\(_z_stage1_frame_binding_service\), \(_z_stage1_live_request = false, _z_stage1_frame_binding_request\)\)\);/,
    );
    assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    assert.match(
      emission.stdout,
      /switch \(_z_stage1_match_[0-9]+\.tag\)/,
    );
    assert.match(emission.stdout, /Z_ServiceError_deinit\(&_z_stage1_frame_binding_scratch\)/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("retains owned arguments and results across a dynamic child await", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-tail-callable.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-tail-callable-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_AsyncInvocation child;/);
    assert.match(emission.stdout, /frame->task\.request_cancel = .*_cancel;/);
    assert.match(emission.stdout, /z_stage1_async_request_cancel\(frame->child\.task\)/);
    assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
    assert.match(emission.stdout, /frame->child\.take_result\(frame->child\.task, &frame->result\)/);
    assert.match(emission.stdout, /live_argument0/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released relay source\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("transfers an owned async closure parameter into its awaited child", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-owned-closure-parameter.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-owned-closure-parameter-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /task->executor, \(frame->live_argument0 = false, resource\)\)/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("retains a class receiver while its method awaits a dynamic child", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-tail-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-tail-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /frame->receiver = Z_Relay_retain\(receiver\);/);
    assert.match(emission.stdout, /Z_Relay_release\(frame->receiver\);/);
    assert.match(emission.stdout, /Z_AsyncInvocation child;/);
    assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
    assert.match(emission.stdout, /frame->task\.request_cancel = .*_cancel;/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      "released method source\nreleased relay method\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("keeps a cleanup-bearing method local alive across a dynamic child", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-prefixed-tail-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-prefixed-tail-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_Request _z_local_forwarded;/);
    assert.match(emission.stdout, /bool _z_stage1_live_forwarded;/);
    assert.match(
      emission.stdout,
      /#define _z_stage1_frame_binding_forwarded \(frame->_z_local_forwarded\)/,
    );
    assert.match(
      emission.stdout,
      /_start\([^\n]*&\(_z_stage1_frame_binding_forwarded\)\)/,
    );
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_forwarded\) \{ Z_Request_deinit\(&_z_stage1_frame_binding_forwarded\); _z_stage1_live_forwarded = false; \}/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      "released forwarded request\nreleased forwarded request\nreleased prefixed source\nreleased prefixed relay\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("propagates a synchronous typed failure before a dynamic tail await", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-prefix-try.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-prefix-try-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /requireRun\(shouldFail\)/);
    assert.match(emission.stdout, /frame->result = .*\.payload\.failure/);
    assert.match(emission.stdout, /Z_RunLifetime_deinit\(&lifetime\)/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released run 1\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("selects an immediate method result before a dynamic child path", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-branch-tail-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-branch-tail-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /if \(\(!enabled\) \|\| \(separator == UINT64_C\(0\)\)\) \{[\s\S]*frame->result = Z_STRING_LITERAL\("disabled"\);[\s\S]*task->completed = true;[\s\S]*return;/,
    );
    assert.match(emission.stdout, /size_t separator = UINT64_C\(0\);/);
    assert.doesNotMatch(emission.stdout, /frame->separator/);
    assert.match(emission.stdout, /while \(\(separator </);
    assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("preserves synchronous work around branched tail awaits", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-branched-prefix-function.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-branched-prefix-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /frame->_z_local_permission/);
    assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("moves a matched async handler into its suspending method frame", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-match-tail-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-match-tail-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /bool _z_stage1_async_live_/);
    assert.match(
      emission.stdout,
      /_z_stage1_live_option = false;[\s\S]*switch \(_z_stage1_match_/,
    );
    assert.match(
      emission.stdout,
      /\.payload\.some;[\s\S]*_start\([^\n]*task->executor/,
    );
    assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
    assert.match(
      emission.stdout,
      /case Z_OperationOptionTag_none:[\s\S]*frame->result = Z_STRING_LITERAL\("missing"\);[\s\S]*task->completed = true;/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("moves a matched async handler into a free-function frame", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-match-tail-function.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-match-tail-function-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_Request _z_local_forwarded;/);
    assert.match(emission.stdout, /bool _z_stage1_async_live_/);
    assert.match(
      emission.stdout,
      /\.payload\.some;[\s\S]*frame->child\.task->waiter = task;/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("continues a free-function frame after an awaited method result", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-linear-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-linear-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_String _z_local_loaded;/);
    assert.match(
      emission.stdout,
      /_start_invocation\(task->executor, source, &\(\(\*request\)\)\)/,
    );
    assert.match(
      emission.stdout,
      /take_result\(frame->child\.task, &_z_stage1_frame_binding_loaded\);[\s\S]*frame->_z_resume_state = 2;/,
    );
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 2;[\s\S]*frame->result = \([^;]*_z_stage1_frame_binding_loaded\);/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("continues a throwing method frame after materializing an awaited method Result", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-linear-attempt-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-linear-attempt-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /Z___z_Result___z_Option_String_DialogError selected = z_stage1_async_callable_await_Z_TransferService_importFile_/,
    );
    assert.match(
      emission.stdout,
      /Z___z_Result___z_Option_String_DialogError result = frame->result;/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("resumes a reusable function through two awaited children", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-double-await.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-double-await-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /uint32_t _z_resume_state;[\s\S]*Z_String _z_local_loaded;[\s\S]*Z_String _z_local_separator;[\s\S]*Z_String _z_local_decorated;[\s\S]*Z_AsyncInvocation child;/);
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 1;[\s\S]*frame->child\.take_result\(frame->child\.task, &_z_stage1_frame_binding_loaded\);[\s\S]*frame->_z_resume_state = 2;/,
    );
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 2;[\s\S]*frame->child\.take_result\(frame->child\.task, &_z_stage1_frame_binding_decorated\);[\s\S]*frame->_z_resume_state = 3;/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("resumes a class method through two awaited children", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-double-await-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-double-await-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /uint32_t _z_resume_state;[\s\S]*int32_t _z_local_first;[\s\S]*int32_t _z_local_second;[\s\S]*Z_AsyncInvocation child;/,
    );
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 1;[\s\S]*frame->child\.take_result\(frame->child\.task, &_z_stage1_frame_binding_first\);[\s\S]*frame->_z_resume_state = 2;/,
    );
    assert.match(
      emission.stdout,
      /frame->_z_resume_state = 2;[\s\S]*frame->child\.take_result\(frame->child\.task, &_z_stage1_frame_binding_second\);[\s\S]*frame->_z_resume_state = 3;/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("routes a service result before publishing it on the main executor", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-service-main-publication.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-service-main-publication-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    // `handle` is a general frame: both results live in it across suspension,
    // and the placed call hops to the main executor (directly when `handle`
    // already runs there).
    assert.match(
      emission.stdout,
      /Z_RoutedResponse _z_binding_routed;[\s\S]*Z_PublishedResponse _z_binding_published;/,
    );
    assert.match(
      emission.stdout,
      /frame->child = z_stage1_async_hop_start\(task->executor, Z_\w+_start\(z_stage1_callable_\w+_value\(\), z_stage1_async_main_executor\(\)/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      [
        "published routed service response",
        "released routed routed service response",
        "observed routed service response",
        "released published routed service response",
        "released request service response",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("awaits a method from a captured generic async closure", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-captured-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-captured-method-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /_environment \*environment;/);
    assert.match(emission.stdout, /frame->environment = environment;/);
    assert.match(
      emission.stdout,
      /_start_invocation\(task->executor, source, request\)/,
    );
    assert.match(
      emission.stdout,
      /take_result\(frame->child\.task, &frame->result\);/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("materializes a stored async closure failure as Result", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-attempt-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-callable-attempt-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /frame->child\.take_result\(frame->child\.task, &frame->result\);/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("inherits main-executor lowering for an async class method", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-inherited-main-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-inherited-main-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("composes owned matches, ARC arguments, and post-await control flow", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-service-composition.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const directory = mkdtempSync("/tmp/z-native-async-service-composition-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /_z_stage1_live_decoded = false;[\s\S]*switch \(_z_stage1_match_/,
    );
    assert.match(
      emission.stdout,
      /_z_stage1_live__z_stage1_match_payload_.* = false[\s\S]*Z_Service_retain\(service\)/,
    );
    assert.match(
      emission.stdout,
      /_z_stage1_live_outcome = false;[\s\S]*switch \(_z_stage1_match_/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("rejects a suspending value-struct receiver before native lowering", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-struct-method-invalid.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 1);
  // The resolver rejects it as Stage 0 does: a borrowed struct receiver cannot
  // stay live in a suspended frame.
  assert.match(emission.stderr, /6:9: error\[Z0704\]: an async struct method must take ownership with `move this` in the first async tier/);
  assert.doesNotMatch(emission.stderr, /internal compiler error/);
});

test("retains a readonly class receiver captured by a non-consuming method", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-readonly-method-capture.zs",
  );
  const directory = mkdtempSync("/tmp/z-native-readonly-method-capture-");
  try {
    const executable = resolve(directory, "program");
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /Z_Snapshot \*Z_Snapshot_retain\(const Z_Snapshot \*borrowed\)/,
    );
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("materializes demand-driven generic ARC classes natively", () => {
  const cases = [
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-class.zs",
      ),
      expectedStdout: "drop 2\ndrop 1\n",
      specializationCount: 2,
    },
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-class-modules/main.zs",
      ),
      expectedStdout: "private drop 7\nmodule drop 3\n",
      specializationCount: 2,
    },
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-class-transitive/main.zs",
      ),
      expectedStdout: "event 42\nconstructed callback\n",
      specializationCount: 1,
    },
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-class-nested/main.zs",
      ),
      expectedStdout: "nested worker value 42\n",
      specializationCount: 2,
    },
  ];
  const directory = mkdtempSync("/tmp/z-native-generic-class-");
  try {
    for (const [index, testCase] of cases.entries()) {
      const parity = spawnSync(
        process.execPath,
        [cli, "check", testCase.input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", testCase.input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.equal(
        [...emission.stdout.matchAll(
          /typedef struct Z___z_mono_[A-Za-z0-9_]+ \{\s+size_t _z_refcount;/g,
        )].length,
        testCase.specializationCount,
      );
      assert.equal(
        [...emission.stdout.matchAll(
          /static inline __attribute__\(\(unused\)\) Z___z_mono_[A-Za-z0-9_]+ \*Z___z_mono_[A-Za-z0-9_]+_retain\([^;{]*\) \{/g,
        )].length,
        testCase.specializationCount,
      );
      assert.equal(
        [...emission.stdout.matchAll(
          /static __attribute__\(\(unused\)\) void Z___z_mono_[A-Za-z0-9_]+_release\([^;{]*\) \{/g,
        )].length,
        testCase.specializationCount,
      );
      if (index < 2) {
        assert.match(
          emission.stdout,
          /const shared(?:Number|Words)? = Z___z_mono_[A-Za-z0-9_]+_retain\(/,
        );
      }
      if (index === 0) {
        assert.match(
          emission.stdout,
          /static __attribute__\(\(unused\)\) void Z___z_mono_[A-Za-z0-9_]+_replace\(Z___z_mono_[A-Za-z0-9_]+ \*self, Z_String value\)/,
        );
        assert.match(
          emission.stdout,
          /Z_String_deinit\(&self->value\)/,
        );
      }

      const executable = resolve(directory, `program-${index}`);
      const compilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, testCase.expectedStdout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("executes non-throwing class constructors in fixed-point output", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-class-constructor.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_Manager \*Z_Manager_new\(int32_t value\)/,
  );
  assert.match(
    emission.stdout,
    /Z_Window \*Z_Window_new\(Z_String title, Z_Weak manager\)/,
  );
  assert.match(emission.stdout, /Z_String \*_z_stage1_assignment_slot_(\d+) = &\(self->title\);[\s\S]*\*_z_stage1_assignment_slot_\1 = _z_stage1_assignment_\1;/);
  assert.match(emission.stdout, /Z_Weak \*_z_stage1_assignment_slot_(\d+) = &\(self->manager\);[\s\S]*\*_z_stage1_assignment_slot_\1 = _z_stage1_assignment_\1;/);
  assert.match(
    emission.stdout,
    /Z_Window \* __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.success;/,
  );

  const directory = mkdtempSync("/tmp/z-native-class-constructor-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("zeroes and upgrades ARC weak references in fixed-point output", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-weak.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct Z_WeakControl/);
  assert.match(emission.stdout, /Z_WeakControl \*_z_weak;/);
  assert.match(emission.stdout, /_z_stage1_weak_control->value = NULL;/);
  assert.match(emission.stdout, /Z_Session_weak_upgrade\(Z_Weak weak\)/);
  assert.match(emission.stdout, /Z_Session_weak_retain\(observer\)/);
  assert.match(
    emission.stdout,
    /copyObserver\(Z_Session_weak_retain\(sharedObserver\)\)/,
  );
  assert.match(
    emission.stdout,
    /Z_SessionObserver_new\(Z_Session_weak_retain\(observer\)\)/,
  );
  assert.match(
    emission.stdout,
    /typedef struct Z_(Function_[A-Za-z0-9_]+) \{[\s\S]*?typedef struct Z_Controller \{[\s\S]*?Z_\1 handler;/,
  );
  assert.match(
    emission.stdout,
    /typedef struct z_stage1_callable_Z_Controller_install_[0-9]+_environment \{[\s\S]*?Z_Weak owner;/,
  );
  assert.match(
    emission.stdout,
    /Z_Controller_weak_deinit\(&environment->owner\)/,
  );
  assert.match(
    emission.stdout,
    /Z_Function_[A-Za-z0-9_]+_deinit\(&self->handler\)/,
  );
  assert.match(
    emission.stdout,
    /_z_stage1_assignment_[0-9]+ = Z_Function_[A-Za-z0-9_]+_retain\(controller->handler\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-weak-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      "released session 42\nreleased controller 9\nreleased session 7\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("preserves weak identity for generic ARC class specializations", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-generic-weak.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+_weak_upgrade\(Z_Weak weak\)/,
  );
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+_weak\(const Z___z_mono_[A-Za-z0-9_]+ \*borrowed\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-generic-weak-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      "released cell 1\nreleased cell 2\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("preserves weak generic class identity across modules", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-generic-weak-modules/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z___z_mono_[A-Za-z0-9_]+_weak_upgrade\(Z_Weak weak\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-module-generic-weak-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      "released module cell 1\nreleased module cell 2\n",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("evaluates generic value-struct defaults per native construction", () => {
  const inputs = [
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-defaults.zs",
    ),
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-defaults-modules/main.zs",
    ),
  ];
  const directory = mkdtempSync("/tmp/z-native-generic-defaults-");
  try {
    for (const [index, input] of inputs.entries()) {
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.match(
        emission.stdout,
        /Z___z_mono_[A-Za-z0-9_]+___default_attempts\(void\)/,
      );
      assert.match(
        emission.stdout,
        /Z___z_mono_[A-Za-z0-9_]+___default_history\(void\)/,
      );
      assert.match(
        emission.stdout,
        /\.attempts = Z___z_mono_[A-Za-z0-9_]+___default_attempts\(\)/,
      );
      assert.match(
        emission.stdout,
        /\.history = Z___z_mono_[A-Za-z0-9_]+___default_history\(\)/,
      );

      const executable = resolve(directory, `program-${index}`);
      const compilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("evaluates ordinary value-struct defaults across native modules", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-struct-defaults-modules/main.zs",
  );
  const directory = mkdtempSync("/tmp/z-native-struct-defaults-");
  try {
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_Application___default_builder\(\)/);

    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("specializes generic value-struct deinit through native cleanup", () => {
  const cases = [
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-deinit.zs",
      ),
      expectedStdout: "drop 2\ndrop 1\n",
      specializationCount: 2,
    },
    {
      input: resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-generic-deinit-modules/main.zs",
      ),
      expectedStdout: "module drop 3\n",
      specializationCount: 1,
    },
  ];
  const directory = mkdtempSync("/tmp/z-native-generic-deinit-");
  try {
    for (const [index, testCase] of cases.entries()) {
      const parity = spawnSync(
        process.execPath,
        [cli, "check", testCase.input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", testCase.input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.equal(
        [...emission.stdout.matchAll(
          /static __attribute__\(\(unused\)\) void Z___z_mono_[A-Za-z0-9_]+_deinit\([^)]*\) \{/g,
        )].length,
        testCase.specializationCount,
      );
      const executable = resolve(directory, `program-${index}`);
      const compilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, testCase.expectedStdout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("specializes independently generic aggregate methods natively", () => {
  const inputs = [
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-methods.zs",
    ),
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-methods-modules/main.zs",
    ),
  ];
  const directory = mkdtempSync("/tmp/z-native-generic-methods-");
  try {
    for (const [index, input] of inputs.entries()) {
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.match(
        emission.stdout,
        /Z_[A-Za-z0-9_]+_[A-Za-z0-9_]+__Function_[A-Za-z0-9_]+\(/,
      );
      assert.doesNotMatch(emission.stdout, /preserve<i32>/);
      if (index === 0) {
        assert.match(
          emission.stdout,
          /Z_String Z_[A-Za-z0-9_]+_choose__Function_[A-Za-z0-9_]+\(/,
        );
        assert.match(emission.stdout, /Z_String_deinit\(&selected\)/);
      }

      const executable = resolve(directory, `program-${index}`);
      const compilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("specializes demand-driven generic free functions natively", () => {
  const inputs = [
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-functions.zs",
    ),
    resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-generic-functions-modules/main.zs",
    ),
  ];
  const directory = mkdtempSync("/tmp/z-native-generic-functions-");
  try {
    for (const [index, input] of inputs.entries()) {
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.match(
        emission.stdout,
        /[A-Za-z0-9_]+__Function_[A-Za-z0-9_]+\(/,
      );
      assert.doesNotMatch(emission.stdout, /identity<i32>|preserve<String>/);
      if (index === 0) {
        const i32IdentityDefinitions = emission.stdout.match(
          /int32_t _z_function_\d+_identity__Function_[A-Za-z0-9_]+\(int32_t value\) \{/g,
        ) ?? [];
        assert.equal(i32IdentityDefinitions.length, 1);
        assert.match(
          emission.stdout,
          /Z___z_Result_String_GenericFunctionError _z_function_\d+_require__Function_[A-Za-z0-9_]+\(Z_String value, bool fail\)/,
        );
        assert.match(emission.stdout, /Z_String_deinit\(&value\)/);
      } else {
        assert.match(
          emission.stdout,
          /_z_function_[0-9]+_identity__Function_[A-Za-z0-9_]+/,
        );
      }

      const executable = resolve(directory, `program-${index}`);
      const compilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("emits static struct and class methods as direct native calls", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-static-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_Range Z_Range_normalized\(int32_t left, int32_t right\)/,
  );
  assert.match(
    emission.stdout,
    /Z___z_Result_Range_InvalidRange Z_Range_checked\(int32_t left, int32_t right\)/,
  );
  assert.match(
    emission.stdout,
    /int32_t Z_NumberPolicy_clamp\(int32_t value, int32_t minimum, int32_t maximum\)/,
  );
  assert.match(
    emission.stdout,
    /\.payload = \{ \.success = Z_Range_normalized\(left, right\)/,
  );
  assert.match(
    emission.stdout,
    /Z_Range normalized = Z_Range_normalized\(9, 2\);/,
  );
  assert.match(
    emission.stdout,
    /int32_t clamped = Z_NumberPolicy_clamp\(50, 0, 10\);/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /Z_Range_normalized\([^)]*self/,
  );

  const directory = mkdtempSync("/tmp/z-native-static-method-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("materializes populated Array temporaries for native call-scoped borrows", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-borrowed-array-temporary.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z___z_Array_i32 _z_stage1_borrow_\d+ = Z___z_Array_i32_from/,
  );
  assert.match(
    emission.stdout,
    /sum\(&\(_z_stage1_borrow_\d+\)\)/,
  );
  assert.match(
    emission.stdout,
    /Z___z_Array_i32_deinit\(&_z_stage1_borrow_\d+\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-borrowed-array-temporary-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("scopes borrowed temporaries to short-circuit operands and loop conditions in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/short-circuit-borrowed-temporaries.zs");
  // A skipped right operand makes no temporary and runs no call; a loop
  // condition makes its temporaries again on every iteration.
  const expected = [
    "or taken", "evaluated 2", "or right", "named r1", "evaluated 1", "named n22", "both",
    "evaluated 2", "evaluated 2", "evaluated 2", "named m00", "named m11", "n=3 m=2", "",
  ].join("\n");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const directory = mkdtempSync("/tmp/z-short-circuit-temporaries-");
  try {
    for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, tier + optimization);
        const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          encoding: "utf8", input: generated, timeout: 30_000,
        });
        assert.equal(built.status, 0, `${tier}: ${built.stderr}`);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, 0, `${tier}${optimization}: ${run.stderr}`);
        assert.equal(run.stdout, expected, `${tier}${optimization}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("lends cleanup-bearing aggregate temporaries for one call in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/borrowed-aggregate-temporaries.zs");
  // Each fresh aggregate lent with `in` is destroyed exactly once, right after
  // its call, on every call shape. A skipped operand or ternary branch
  // creates no temporary and evaluates nothing.
  const expected = [
    "released call", "call 6", "released m6", "method 12", "released ctor", "ctor 4", "label 7",
    "released discarded", "released cond", "released loop", "released loop", "released loop", "count 4",
    "released else!", "pick 5", "evaluated 2", "pick text 6", "released ret1", "early 4",
    "released good", "released bad", "good 4", "bad rejected", "",
  ].join("\n");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const directory = mkdtempSync("/tmp/z-borrowed-aggregate-temporaries-");
  try {
    for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, tier + optimization);
        const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=address,undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          encoding: "utf8", input: generated, timeout: 30_000,
        });
        assert.equal(built.status, 0, `${tier}: ${built.stderr}`);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, 0, `${tier}${optimization}: ${run.stderr}`);
        assert.equal(run.stdout, expected, `${tier}${optimization}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("emits the String runtime when String appears only inside another type", () => {
  const source = `function empty(in values: Array<String>): boolean { return values.length == 0; }
    function main(): i32 { return empty(Array<String>()) ? 0 : 1; }`;
  const directory = mkdtempSync("/tmp/z-string-runtime-nested-");
  try {
    const executable = resolve(directory, "program");
    const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
      encoding: "utf8", input: compileToC(source, "nested-string.zs"), timeout: 30_000,
    });
    assert.equal(built.status, 0, built.stderr);
    assert.equal(spawnSync(executable, [], { encoding: "utf8" }).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects unknown dynamic Array methods in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-array-methods-");
  const input = resolve(directory, "main.zs");
  const sources = [
    `function main(): i32 {
      let values = Array<i32>(); values.unshift(1); return 0;
    }`,
    `class Collection {
      values: Array<i32>;
      function add(inout this): void { this.values.unshift(1); }
    }`,
    `type Values = Array<i32>;
    function add(inout values: Values): void { values.unshift(1); }`,
    `import { Values } from "./model.zs";
    function add(inout values: Values): void { values.unshift(1); }`,
    `function inspect(in values: readonly Array<i32>): void { values.unshift(1); }`,
    `struct Holder { values: Array<i32>; }
    function inspect(in holder: Holder): void {
      const observed = view holder.values; observed.unshift(1);
    }`,
  ];
  try {
    writeFileSync(resolve(directory, "model.zs"), "export type Values = Array<i32>;\n");
    for (const source of sources) {
      writeFileSync(input, source);
      // Check native resolution directly: a Stage 0-first parity check could
      // reject the input before exercising the missing native diagnostic.
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.equal(result.status, 1, `${command}\n${source}\n${result.stderr}`);
        assert.match(result.stderr, /Array has no method "unshift"/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

test("rejects readonly intermediate assignment paths in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-readonly-paths-");
  const input = resolve(directory, "main.zs");
  const sources = [
    `class State { count: i32; }
    class Owner {
      readonly state: State;
      function update(inout this): void { this.state.count = 1; }
    }`,
    `struct State { count: i32; }
    struct Owner { readonly state: State; }
    function update(inout owner: Owner): void { owner.state.count = 1; }`,
    `import { Owner } from "./model.zs";
    function update(inout owner: Owner): void { owner.state.count = 1; }`,
    `class State { count: i32; }
    struct Middle { inner: State; }
    struct Owner { readonly state: Middle; }
    function update(inout owner: Owner): void { owner.state.inner.count = 1; }`,
    `class State { count: i32; }
    struct Owner<T> { readonly state: T; }
    type Application = Owner<State>;
    function update(inout owner: Application): void { owner.state.count = 1; }`,
    `class State { count: i32; }
    struct Owner { readonly state: Array<State>; }
    function update(inout owner: Owner): void { owner.state[0].count = 1; }`,
    `class State { count: i32; }
    class Owner {
      readonly state: State;
      constructor(state: State) { this.state = state; this.state.count = 1; }
    }`,
  ];
  try {
    writeFileSync(resolve(directory, "model.zs"),
      "export class State { count: i32; }\nexport struct Owner { readonly state: State; }\n");
    for (const source of sources) {
      writeFileSync(input, source);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.equal(result.status, 1, `${command}\n${source}\n${result.stderr}`);
        assert.match(result.stderr, /cannot assign to readonly field "state"/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

test("checks where task and await on thread.main may be written in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-placement-context-");
  const input = resolve(directory, "main.zs");
  const rejected: Array<[string, RegExp]> = [
    // A synchronous helper has no task scope to own the child.
    [`import console from "std/console";
import { thread } from "std/thread";
function helper(): void {
  task on thread.main {
    console.log("nope");
  }
}
async function main(): i32 {
  const worker = thread.spawn((): void => {
    helper();
  });
  await worker;
  return 0;
}`, /:4:3: (error(\[Z0711\])?: )?task on thread\.main requires an enclosing async function or a direct synchronous thread\.spawn closure/],
    [`import { thread } from "std/thread";
function value(): i32 { return 1; }
function helper(): i32 {
  return await on thread.main value();
}
function main(): i32 { return helper(); }`,
    /:4:10: (error(\[Z0711\])?: )?await on thread\.main requires an enclosing async function/],
  ];
  // Directly in a synchronous worker body, and in a closure nested in one.
  const accepted = [`import console from "std/console";
import { thread } from "std/thread";
async function main(): i32 {
  const worker = thread.spawn((): void => {
    task on thread.main {
      console.log("direct");
    }
  });
  await worker;
  return 0;
}`, `import console from "std/console";
import { thread } from "std/thread";
async function main(): i32 {
  const worker = thread.spawn((): void => {
    const nested = (): void => {
      task on thread.main {
        console.log("nested");
      }
    };
    nested();
  });
  await worker;
  return 0;
}`];
  try {
    for (const [source, expected] of rejected) {
      writeFileSync(input, source);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.notEqual(result.status, 0, `${command}: ${source}`);
        assert.match(result.stderr, expected, command);
      }
    }
    for (const source of accepted) {
      writeFileSync(input, source);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      }
    }
    // The nested form has no frame to own the child natively yet.
    writeFileSync(input, accepted[1]);
    const nested = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.notEqual(nested.status, 0);
    assert.match(nested.stderr, /:6:7: error\[Z0700\]: task on thread\.main inside a closure nested in a worker is not executable in the native compiler yet/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("rejects class construction without new and non-reference T | null in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-construction-nullability-");
  const input = resolve(directory, "main.zs");
  const rejected: Array<[string, RegExp]> = [
    [`class Box {
  value: i32;
}
function main(): i32 {
  const box = Box({ value: 1 });
  return box.value - 1;
}`, /:5:15: (error: )?class construction requires new Box\(\{ \.\.\. \}\)/],
    [`class Holder<T> { value: T; }
type Alias = Holder<i32>;
function main(): i32 { const held = Alias({ value: 1 }); return held.value - 1; }`,
    /:3:37: (error: )?class construction requires new Holder<i32>\(\{ \.\.\. \}\)/],
    [`class Box { value: i32; constructor(value: i32) { this.value = value; } }
function main(): i32 { const box = Box(1); return box.value - 1; }`,
    /:2:36: (error: )?class construction requires new Box\(\{ \.\.\. \}\)/],
    [`struct Point { x: i32; }
function take(value: Point | null): i32 { return 0; }
function main(): i32 { return 0; }`,
    /:2:22: (error: )?"Point \| null" currently requires an imported Objective-C reference type/],
    [`class Box { value: i32; }
struct Holder { box: Box | null; }
function main(): i32 { return 0; }`,
    /:2:22: (error: )?"Box \| null" currently requires an imported Objective-C reference type/],
    [`function main(): i32 { const value: i32 | null = null; return 0; }`,
    /:1:37: (error: )?"i32 \| null" currently requires an imported Objective-C reference type/],
    [`struct Point { x: i32; }
function visit(callback: (value: i32) => Point | null): i32 { return 0; }
function main(): i32 { return 0; }`,
    /:2:26: (error: )?"Point \| null" currently requires an imported Objective-C reference type/],
  ];
  const accepted = `class Box { value: i32; }
struct Point { x: i32; }
function main(): i32 {
  const box = new Box({ value: 1 });
  const point = Point({ x: 1 });
  return box.value - point.x;
}`;
  try {
    for (const [source, expected] of rejected) {
      writeFileSync(input, source);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.equal(result.status, 1, `${command}\n${source}\n${result.stderr}`);
        assert.match(result.stderr, expected, `${command}\n${source}`);
      }
    }
    writeFileSync(input, accepted);
    for (const command of ["check", "self-host-resolve"]) {
      const result = spawnSync(process.execPath, [cli, command, input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

test("checks scoped child-task borrows of whole bindings and struct fields in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-task-loans-");
  const input = resolve(directory, "main.zs");
  const prelude = `import { delay } from "std/time";
import { thread } from "std/thread";
struct Point { x: i32; y: i32; }
struct Inner { x: i32; y: i32; }
struct Holder { inner: Inner; count: i32; }
class Counter { value: i32; }
struct Shared { counter: Counter; count: i32; }
struct Wrapper { shared: Shared; count: i32; }
async function bump(inout value: i32): void { await delay(1); value = value + 1; }
async function bumpBoth(inout first: i32, inout second: i32): void { await delay(1); first = first + 1; second = second + 1; }
async function observe(in value: i32): i32 { await delay(1); return value; }
async function inspect(in point: Point): i32 { await delay(1); return point.x; }
async function replace(inout point: Point): void { point.x = 0; }
async function fill(out point: Point): void { point = Point({ x: 1, y: 1 }); }
async function share(inout shared: Shared): void { return; }
async function sum(values: Slice<i32>): i32 { return values[0]; }
function touch(inout point: Point): void { point.x = 2; }
`;
  // Each body becomes `main`; an expected `line:column: error` is the
  // diagnostic both frontends must report, and null means both accept.
  const cases: Array<[string, string, string | null]> = [
    ["acceptance", `let point = Point({ x: 40, y: 41 });
  async scope {
    const x = task bump(inout point.x);
    task bump(inout point.y);
    await x;
    point.x = point.x + 1;
  }
  return (point.x == 42 && point.y == 42) ? 0 : 1;`, null],
    ["direct-await", `let point = Point({ x: 41, y: 0 });
  await bump(inout point.x);
  const seen = await observe(in point.x);
  return seen - 42;`, null],
    ["two-fields-one-child", `let point = Point({ x: 41, y: 41 });
  async scope {
    const both = task bumpBoth(inout point.x, inout point.y);
    await both;
    point.x = point.x + 0;
  }
  return 0;`, null],
    ["cancel-release", `let point = Point({ x: 41, y: 41 });
  async scope {
    const x = task bump(inout point.x);
    await x.cancel();
    point.x = 42;
  }
  return 0;`, null],
    ["scope-exit-release", `let point = Point({ x: 40, y: 41 });
  async scope {
    task bump(inout point.x);
    task bump(inout point.y);
  }
  point.x = point.x + 1;
  return 0;`, null],
    ["sibling-access", `let holder = Holder({ inner: Inner({ x: 1, y: 1 }), count: 0 });
  async scope {
    const x = task bump(inout holder.inner.x);
    holder.inner.y = holder.inner.y + 1;
    holder.count = 1;
    await x;
  }
  return 0;`, null],
    ["every-path-join", `let point = Point({ x: 41, y: 0 });
  const normal = true;
  async scope {
    const x = task bump(inout point.x);
    if (normal) {
      await x;
    } else {
      await x.cancel();
    }
    point.x = point.x + 1;
  }
  return 0;`, null],
    ["same-field", `let point = Point({ x: 40, y: 41 });
  async scope {
    task bump(inout point.x);
    task bump(inout point.x);
  }
  return 0;`, "22:27: error[Z0704]: cannot borrow \"point.x\" as inout while an active inout loan exists"],
    ["whole-borrow", `let point = Point({ x: 40, y: 41 });
  async scope {
    task bump(inout point.x);
    task replace(inout point);
  }
  return 0;`, "22:18: error[Z0704]: cannot borrow \"point\" as inout while an active inout loan exists"],
    ["whole-read", `let point = Point({ x: 40, y: 41 });
  async scope {
    task bump(inout point.x);
    const seen = await inspect(in point);
  }
  return 0;`, "22:35: error[Z0704]: cannot read \"point\" while a child task mutably borrows it"],
    ["whole-replace", `let point = Point({ x: 40, y: 41 });
  async scope {
    task bump(inout point.x);
    point = Point({ x: 0, y: 0 });
  }
  return 0;`, "22:5: error[Z0704]: cannot mutate \"point\" while a child task borrows it"],
    ["one-branch-join", `let point = Point({ x: 40, y: 41 });
  const join = true;
  async scope {
    const x = task bump(inout point.x);
    if (join) { await x; }
    point.x = 1;
  }
  return 0;`, "24:5: error[Z0704]: cannot read \"point.x\" while a child task mutably borrows it"],
    ["other-loan-after-join", `let point = Point({ x: 40, y: 41 });
  async scope {
    const x = task bump(inout point.x);
    task bump(inout point.y);
    await x;
    point.x = point.x + 1;
    const seen = point.y;
  }
  return 0;`, "25:18: error[Z0704]: cannot read \"point.y\" while a child task mutably borrows it"],
    ["in-field-then-write", `let point = Point({ x: 42, y: 0 });
  async scope {
    task observe(in point.x);
    point.y = 1;
    point.x = 1;
  }
  return 0;`, "23:11: error[Z0704]: cannot mutate \"point.x\" while a child task borrows it"],
    ["sync-inout-same-field", `let point = Point({ x: 40, y: 41 });
  async scope {
    task observe(in point.x);
    touch(inout point);
  }
  return 0;`, "22:11: error[Z0704]: cannot mutate \"point\" while a child task borrows it"],
    ["placed-field", `let point = Point({ x: 40, y: 41 });
  await on thread.main bump(inout point.x);
  return 0;`, "20:41: error[Z0704]: a projected field borrow cannot cross to another executor in this tier"],
    ["class-root-field", `let counter = new Counter({ value: 1 });
  await bump(inout counter.value);
  return 0;`, "20:28: error[Z0704]: a projected borrow across an async suspension requires a stored value-struct field without ARC class or view storage"],
    ["arc-storage-field", `let wrapper = Wrapper({ shared: Shared({ counter: new Counter({ value: 1 }), count: 0 }), count: 0 });
  await share(inout wrapper.shared);
  return 0;`, "20:29: error[Z0704]: a projected borrow across an async suspension requires a stored value-struct field without ARC class or view storage"],
    ["no-scope", `let point = Point({ x: 40, y: 41 });
  const x = task bump(inout point.x);
  await x;
  return 0;`, "20:35: error[Z0704]: child-task mutable borrow of \"point\" requires an explicit async scope"],
    ["in-no-scope", `const point = Point({ x: 40, y: 41 });
  const seen = task inspect(point);
  return await seen;`, "20:29: error[Z0704]: child-task borrow of \"point\" requires an explicit async scope"],
    ["slice-no-scope", `let values = [1, 2, 3];
  const total = task sum(values);
  return await total;`, "20:26: error[Z0704]: child-task Slice borrow of \"values\" requires an explicit async scope"],
    ["out-child", `let point = Point({ x: 40, y: 41 });
  async scope {
    task fill(out point);
  }
  return 0;`, "21:15: error[Z0704]: child-task output borrow of \"point\" is not supported"],
    ["in-then-inout", `let point = Point({ x: 40, y: 41 });
  async scope {
    task inspect(point);
    task replace(inout point);
  }
  return 0;`, "22:18: error[Z0704]: cannot borrow \"point\" as inout while an active in loan exists"],
    ["in-then-mutate", `let point = Point({ x: 40, y: 41 });
  async scope {
    task inspect(point);
    point.x = 1;
  }
  return 0;`, "22:11: error[Z0704]: cannot mutate \"point\" while a child task borrows it"],
    ["loop-join", `let point = Point({ x: 40, y: 41 });
  let index = 0;
  while (index < 1) {
    async scope {
      const child = task replace(inout point);
      await child;
      point.x = 2;
    }
    index = index + 1;
  }
  return 0;`, "25:7: error[Z0704]: cannot read \"point\" while a child task mutably borrows it"],
    ["placed-capture-no-scope", `let point = Point({ x: 40, y: 41 });
  const child = task on thread.main using (inout point) { point.x = 2; };
  await child;
  return 0;`, "20:50: error[Z0704]: child-task inout capture of \"point\" requires an explicit async scope"],
  ];
  try {
    for (const [name, body, expected] of cases) {
      writeFileSync(input, `${prelude}async function main(): i32 {\n  ${body}\n}\n`);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        if (expected === null) {
          assert.equal(result.status, 0, `${command} ${name}\n${result.stderr}`);
        } else {
          assert.equal(result.status, 1, `${command} ${name}\n${result.stderr}`);
          assert.ok(result.stderr.includes(`main.zs:${expected}`), `${command} ${name}\n${result.stderr}`);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 600_000);

test("runs scoped async field borrows natively as Stage 0 does", () => {
  const directory = mkdtempSync("/tmp/z-native-field-borrows-");
  const prelude = `import { delay } from "std/time";
struct Point { x: i32; y: i32; }
struct Inner { x: i32; y: i32; }
struct Holder { inner: Inner; count: i32; }
async function bump(inout value: i32): void { await delay(1); value = value + 1; }
async function bumpBoth(inout first: i32, inout second: i32): void { await delay(1); first = first + 1; second = second + 1; }
async function bumpLater(inout value: i32): void { await delay(1000); value = value + 100; }
async function bumpOrFail(inout value: i32, fail: boolean): void throws i32 {
  await delay(1);
  value = value + 1;
  if (fail) throw 7;
}
async function both(inout point: Point): void {
  async scope {
    task bump(inout point.x);
    task bump(inout point.y);
  }
}
async function directHelper(): i32 {
  let point = Point({ x: 41, y: 0 });
  await bump(inout point.x);
  return point.x;
}
async function observe(in value: i32): i32 { await delay(1); return value; }
`;
  // Each body becomes `main` and must return 0 from both compilers.
  const cases: Array<[string, string]> = [
    ["acceptance", `let point = Point({ x: 40, y: 41 });
  async scope {
    const x = task bump(inout point.x);
    task bump(inout point.y);
    await x;
    point.x = point.x + 1;
  }
  return (point.x == 42 && point.y == 42) ? 0 : 1;`],
    ["two-fields-one-child", `let point = Point({ x: 41, y: 41 });
  async scope {
    const pair = task bumpBoth(inout point.x, inout point.y);
    await pair;
  }
  return (point.x == 42 && point.y == 42) ? 0 : 1;`],
    ["nested-fields", `let holder = Holder({ inner: Inner({ x: 41, y: 41 }), count: 0 });
  async scope {
    const x = task bump(inout holder.inner.x);
    task bump(inout holder.inner.y);
    holder.count = 5;
    await x;
  }
  return (holder.inner.x == 42 && holder.inner.y == 42 && holder.count == 5) ? 0 : 1;`],
    ["borrowed-parameter-root", `let point = Point({ x: 41, y: 41 });
  await both(inout point);
  return (point.x == 42 && point.y == 42) ? 0 : 1;`],
    ["throwing-child", `let point = Point({ x: 41, y: 41 });
  async scope {
    const x = task bumpOrFail(inout point.x, true);
    task bump(inout point.y);
    const outcome = attempt await x;
    const code = match (outcome) {
      success => 0;
      failure(error) => error;
    };
    if (code != 7) return 2;
  }
  return (point.x == 42 && point.y == 42) ? 0 : 1;`],
    ["cancel-in-flight", `let point = Point({ x: 41, y: 41 });
  async scope {
    const x = task bumpLater(inout point.x);
    task bump(inout point.y);
    await delay(1);
    await x.cancel();
    point.x = point.x + 1;
  }
  return (point.x == 42 && point.y == 42) ? 0 : 1;`],
    ["direct-await-helper", `const value = await directHelper();
  return value == 42 ? 0 : 1;`],
    ["implicit-in-field", `let point = Point({ x: 42, y: 0 });
  async scope {
    const seen = task observe(point.x);
    point.y = 42;
    const value = await seen;
    point.y = point.y - value;
  }
  return point.y;`],
  ];
  try {
    for (const [name, body] of cases) {
      const input = resolve(directory, `${name}.zs`);
      writeFileSync(input, `${prelude}async function main(): i32 {\n  ${body}\n}\n`);
      const stage0 = spawnSync(process.execPath, [cli, "run", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.equal(stage0.status, 0, `stage0 ${name}\n${stage0.stderr}`);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, `native ${name}\n${native.stderr}`);
      if (name === "acceptance") {
        // The child borrows the field in place, not a copy of it.
        assert.match(native.stdout, /&\(_z_stage1_frame_binding_point\.x\)/);
        assert.match(native.stdout, /&\(_z_stage1_frame_binding_point\.y\)/);
      }
      const executable = resolve(directory, name);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", "-pthread",
        "-fsanitize=address,undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        encoding: "utf8", input: native.stdout, timeout: 60_000,
      });
      assert.equal(built.status, 0, `${name}\n${built.stderr}`);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      assert.equal(run.status, 0, `native ${name}\n${run.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 600_000);

hostToolchainTest("preserves valid Array methods and readonly reference operations natively", () => {
  const input = resolve(projectRoot, "tests/fixtures/self-host-array-readonly-controls.zs");
  const directory = mkdtempSync("/tmp/z-native-readonly-controls-");
  try {
    for (const command of ["check", "self-host-resolve"]) {
      const result = spawnSync(process.execPath, [cli, command, input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    for (const command of ["emit", "self-host-emit"]) {
      const emitted = spawnSync(process.execPath, [cli, command, input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, "probe");
        const compilation = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          encoding: "utf8", input: emitted.stdout, timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compilation.status, 0, compilation.stderr);
        const execution = spawnSync(executable, [], {
          encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
        });
        assert.equal(execution.status, 0, execution.stderr || String(execution.signal));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

test("clears dynamic Arrays through native semantic and emission parity", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-array-clear.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z___z_Array_Resource_clear\(&\(self->values\)\)/);
  assert.match(emission.stdout, /while \(self->length > 0\).*Z_Resource_deinit/s);

  const directory = mkdtempSync("/tmp/z-native-array-clear-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("composes native Array destructuring, zero-copy rest, and Slice parameters", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-array-destructure.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /const Z___z_Array_i32 \* const _z_array_destructure_\d+ = &\(batch\.values\)/,
  );
  assert.match(
    emission.stdout,
    /->length < 3 \? abort\(\) : \(void\)0/,
  );
  assert.match(
    emission.stdout,
    /\*Z___z_Array_i32_at_unchecked\(_z_array_destructure_\d+, 2\)/,
  );
  assert.match(
    emission.stdout,
    /const Z_Document \* const current = &\(\(\*Z___z_Array_Document_at_unchecked\(_z_array_destructure_\d+, 0\)\)\)/,
  );
  assert.match(
    emission.stdout,
    /typedef struct Z___z_Slice_i32 \{\s+void \*data;\s+size_t length;\s+\} Z___z_Slice_i32;/,
  );
  assert.match(
    emission.stdout,
    /const Z___z_Slice_i32 remaining = Z___z_Array_i32_slice_unchecked\(_z_array_destructure_\d+, 1\)/,
  );
  assert.match(
    emission.stdout,
    /\*Z___z_Slice_i32_at\(&\(remaining\), 1\)/,
  );
  assert.match(
    emission.stdout,
    /const Z___z_Slice_i32 nothing = Z___z_Array_i32_slice_unchecked\(_z_array_destructure_\d+, 0\)/,
  );
  assert.match(
    emission.stdout,
    /const Z___z_Slice_Document remainingDocuments = Z___z_Array_Document_slice_unchecked\(_z_array_destructure_\d+, 1\)/,
  );
  assert.match(
    emission.stdout,
    /\*Z___z_Slice_Document_at\(&\(remainingDocuments\), 0\)/,
  );
  assert.match(
    emission.stdout,
    /int32_t _z_function_\d+_addFirstTwo\(Z___z_Slice_i32 values\)/,
  );
  assert.match(
    emission.stdout,
    /addFirstTwo\(Z___z_Array_i32_slice_unchecked\(&\(batch\.values\), 0\)\)/,
  );
  assert.match(
    emission.stdout,
    /firstTitleLength\(Z___z_Array_Document_slice_unchecked\(&\(documents\), 0\)\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-array-destructure-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const missingView = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-array-destructure-without-view.zs",
  );
  const missingViewResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", missingView],
    { encoding: "utf8" },
  );
  assert.equal(missingViewResult.status, 1);
  assert.match(
    missingViewResult.stderr,
    /destructuring ownership-bearing Document elements requires an explicit view/,
  );

  const liveView = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-array-destructure-live-view-mutation.zs",
  );
  const liveViewResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", liveView],
    { encoding: "utf8" },
  );
  assert.equal(liveViewResult.status, 1);
  assert.match(
    liveViewResult.stderr,
    /cannot mutate "documents" while view "current" is live/,
  );
}, 240_000);

test("keeps native inferred binding evidence inside its declaration scope", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-parameter-scope.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /size_t _z_function_\d+_inspectRecords\(Z___z_Array_Record const \*records\)/,
  );
  assert.match(emission.stdout, /return _z_function_\d+_takeLength\(&\(\(\*records\)\)\);/);
  assert.doesNotMatch(emission.stdout, /takeLength\(\(\*records\)\)/);

  const directory = mkdtempSync("/tmp/z-native-parameter-scope-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 20_000);

test("keeps native test expectations in parser and semantic parity", () => {
  const input = resolve(projectRoot, "tests/fixtures/native-test-expectations.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /uses 2 inferred local binding native-authoritative contracts/,
  );
  assert.match(
    result.stdout,
    /uses 9 expression native-authoritative contracts/,
  );
});

test("owns Mutex fields through native aggregate lowering", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-mutex-field.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct Z_Mutex_RuntimeState/);
  assert.match(emission.stdout, /pthread_mutex_init/);
  assert.match(emission.stdout, /Z_Mutex_RuntimeState_deinit/);
  assert.match(
    emission.stdout,
    /static __attribute__\(\(unused\)\) int32_t Z_Application_answer\(const Z_Application \*self\)/,
  );
  assert.match(
    emission.stdout,
    /static __attribute__\(\(unused\)\) void Z_Application_publish\(Z_Application \*self, int32_t status\)/,
  );
  assert.match(emission.stdout, /Z_Application_publish\(installed, 7\)/);
  assert.match(emission.stdout, /pthread_mutex_lock/);
  assert.match(emission.stdout, /pthread_mutex_unlock/);
  assert.match(emission.stdout, /mutex_with_lock_Z_Application_increment_[0-9]+_body/);
  assert.match(emission.stdout, /int32_t const \*completed/);
  assert.match(
    emission.stdout,
    /Z_Snapshot_release\(snapshot\);[\s\S]*return _z_stage1_return_/,
  );
  assert.match(emission.stdout, /PTHREAD_MUTEX_INITIALIZER/);
  assert.match(
    emission.stdout,
    /__atomic_fetch_sub\(&self->_z_refcount, 1, __ATOMIC_ACQ_REL\)/,
  );

  const directory = mkdtempSync("/tmp/z-native-mutex-field-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 30_000);

test("emits and runs source-backed std/json through the native Z AST", () => {
  const input = resolve(projectRoot, "tests/fixtures/std-json-smoke.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /const Z___z_Map_6_StringJsonValue_Entry entry = .*?\.entries\[/);
  assert.match(emission.stdout, /Z_TEMPLATE_U64/);
  assert.match(emission.stdout, /Z_TEMPLATE_F64/);
  assert.doesNotMatch(emission.stdout, /json\.(?:parse|stringify)/);

  const directory = mkdtempSync("/tmp/z-self-host-json-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

test("derives typed JSON codecs through the native Z AST", () => {
  const input = resolve(projectRoot, "tests/fixtures/std-json-typed.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z_JsonDerivedReader/);
  assert.doesNotMatch(
    emission.stdout,
    /the compiler did not materialize json\.decode<T>/,
  );

  const directory = mkdtempSync("/tmp/z-self-host-json-typed-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

test("rejects ambiguous and unsupported Option JSON codecs natively", () => {
  const directory = mkdtempSync("/tmp/z-self-host-json-option-negative-");
  const input = resolve(directory, "main.zs");
  try {
    for (const [type, message] of [
      ["Option<Option<String>>", /JSON null cannot distinguish none from some\(none\)/],
      ["Option<f32>", /does not support field type f32/],
      ["Array<Option<String>>", /does not support Array element type/],
    ] as const) {
      writeFileSync(input, `
        import json from "std/json";
        struct Value { value: ${type}; }
        function encode(in value: Value): String throws json.JsonEncodeError { return try json.encode(in value); }
        function main(): i32 { return 0; }
      `);
      const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(emission.status, 1, emission.stderr);
      assert.match(emission.stderr, message);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("emits nested value-producing matches through the native Z AST", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-nested-value-match.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);

  const directory = mkdtempSync("/tmp/z-self-host-nested-value-match-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

test("emits and runs the first program directly from the native Z AST", () => {
  const input = resolve(projectRoot, "tests/fixtures/self-host-emit-input.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /int32_t _z_function_\d+_add\(int32_t a, int32_t b\);/);
  assert.match(emission.stdout, /const int32_t answer = _z_function_\d+_add\(20, 22\);/);

  const directory = mkdtempSync("/tmp/z-self-host-emit-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 42, execution.stderr);

  const defaultsInput = resolve(
    projectRoot,
    "examples/language/basics/struct-defaults.zs",
  );
  const defaultsEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", defaultsInput],
    { encoding: "utf8" },
  );
  assert.equal(defaultsEmission.status, 0, defaultsEmission.stderr);
  assert.match(
    defaultsEmission.stdout,
    /Z_RequestOptions defaults = \(Z_RequestOptions\)\{\.retries = 3, \.timeoutMilliseconds = 1000, \.headers = /,
  );
  assert.match(
    defaultsEmission.stdout,
    /Z_RequestOptions patient = \(Z_RequestOptions\)\{\.retries = 3, \.timeoutMilliseconds = 5000/,
  );
  const defaultsExecutable = resolve(directory, "defaults");
  const defaultsCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", defaultsExecutable],
    { encoding: "utf8", input: defaultsEmission.stdout },
  );
  assert.equal(defaultsCompilation.status, 0, defaultsCompilation.stderr);
  const defaultsExecution = spawnSync(defaultsExecutable, [], { encoding: "utf8" });
  assert.equal(defaultsExecution.status, 0, defaultsExecution.stderr);
  assert.equal(defaultsExecution.stdout, "defaults=3, equivalent=3, timeout=5000\n");

  const mapInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-map.zs",
  );
  const mapEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", mapInput],
    { encoding: "utf8" },
  );
  assert.equal(mapEmission.status, 0, mapEmission.stderr);
  assert.match(mapEmission.stdout, /_rehash\(.*?calloc\(capacity, sizeof\(size_t\)\)/s);
  assert.match(mapEmission.stdout, /_set\(&\(indices\), Z_STRING_LITERAL\("answer"\), 42\)/);
  assert.match(mapEmission.stdout, /_get\(&\(indices\), Z_STRING_LITERAL\("answer"\)\)/);
  const mapExecutable = resolve(directory, "map");
  const mapCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", mapExecutable],
    { encoding: "utf8", input: mapEmission.stdout },
  );
  assert.equal(mapCompilation.status, 0, mapCompilation.stderr);
  const mapExecution = spawnSync(mapExecutable, [], { encoding: "utf8" });
  assert.equal(mapExecution.status, 42, mapExecution.stderr);

  const setInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-set.zs",
  );
  const setEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", setInput],
    { encoding: "utf8" },
  );
  assert.equal(setEmission.status, 0, setEmission.stderr);
  assert.match(setEmission.stdout, /_rehash\(.*?calloc\(capacity, sizeof\(size_t\)\)/s);
  assert.match(setEmission.stdout, /_add\(&\(names\), Z_STRING_LITERAL\("alpha"\)\)/);
  assert.match(setEmission.stdout, /_has\(&\(names\), Z_STRING_LITERAL\("missing"\)\)/);
  const setExecutable = resolve(directory, "set");
  const setCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", setExecutable],
    { encoding: "utf8", input: setEmission.stdout },
  );
  assert.equal(setCompilation.status, 0, setCompilation.stderr);
  const setExecution = spawnSync(setExecutable, [], { encoding: "utf8" });
  assert.equal(setExecution.status, 42, setExecution.stderr);

  const transitiveTypeInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-transitive-types/main.zs",
  );
  const transitiveTypeEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", transitiveTypeInput],
    { encoding: "utf8" },
  );
  assert.equal(transitiveTypeEmission.status, 0, transitiveTypeEmission.stderr);
  assert.match(
    transitiveTypeEmission.stdout,
    /int32_t _z_function_\d+_readValue\(Z_Wrapper const \*wrapper\).*?_z_stage1_match_payload_\d+_\d+\.value/s,
  );
  const transitiveTypeExecutable = resolve(directory, "transitive-types");
  const transitiveTypeCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", transitiveTypeExecutable],
    { encoding: "utf8", input: transitiveTypeEmission.stdout },
  );
  assert.equal(transitiveTypeCompilation.status, 0, transitiveTypeCompilation.stderr);
  const transitiveTypeExecution = spawnSync(
    transitiveTypeExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(transitiveTypeExecution.status, 42, transitiveTypeExecution.stderr);

  const matchTryInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-match-try.zs",
  );
  const matchTryEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", matchTryInput],
    { encoding: "utf8" },
  );
  assert.equal(matchTryEmission.status, 0, matchTryEmission.stderr);
  assert.match(
    matchTryEmission.stdout,
    /case Z___z_Option_i32Tag_some:.*?return _z_function_\d+_readValue\(_z_stage1_match_payload_\d+_\d+\);/s,
  );
  const matchTryExecutable = resolve(directory, "match-try");
  const matchTryCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", matchTryExecutable],
    { encoding: "utf8", input: matchTryEmission.stdout },
  );
  assert.equal(matchTryCompilation.status, 0, matchTryCompilation.stderr);
  const matchTryExecution = spawnSync(
    matchTryExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(matchTryExecution.status, 42, matchTryExecution.stderr);

  const moduleInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-modules/main.zs",
  );
  const moduleEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", moduleInput],
    { encoding: "utf8" },
  );
  assert.equal(moduleEmission.status, 0, moduleEmission.stderr);
  assert.match(
    moduleEmission.stdout,
    /typedef struct Z_Point.*?int32_t _z_function_\d+_add\(int32_t first, int32_t second\);.*?Z_Point _z_function_\d+_makePoint\(int32_t x, int32_t y\);.*?int32_t _z_function_\d+_sum\(Z_Point point\);.*?int32_t main\(void\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /typedef struct Z_Session \{.*?Z_Resource resource;.*?static __attribute__\(\(unused\)\) void Z_Session_deinit\(Z_Session \*self\) \{.*?Z_Resource_deinit\(&self->resource\);.*?int32_t _z_function_\d+_resourceId\(Z_Session session\) \{.*?Z_Session_deinit\(&session\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /typedef struct Z_ResourceState \{.*?Z_Resource ready;.*?static __attribute__\(\(unused\)\) void Z_ResourceState_deinit\(Z_ResourceState \*self\) \{.*?Z_Resource_deinit\(&self->payload\.ready\);.*?int32_t _z_function_\d+_stateId\(Z_ResourceState value\) \{.*?case Z_ResourceStateTag_ready:.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /int32_t main\(void\) \{.*?Z_Point point = _z_function_\d+_makePoint\(20, 20\);.*?Z_Point directPoint = \(Z_Point\)\{\.x = 1, \.y = 1\};.*?Z_Resource resource = _z_function_\d+_makeResource\(0\);.*?Z_Session session = \(Z_Session\)\{\.resource = resource\};.*?Z_ResourceState current = _z_function_\d+_makeState\(0\);.*?Z_ResourceState direct = \(Z_ResourceState\)\{\.tag = Z_ResourceStateTag_ready, \.payload = \{ \.ready = _z_function_\d+_makeResource\(0\)\}\};.*?Z_ResourceState empty = \(Z_ResourceState\)\{\.tag = Z_ResourceStateTag_empty\};/s,
  );
  assert.equal(
    moduleEmission.stdout.match(/Z_Resource_deinit\(&self->resource\);/g)?.length,
    1,
  );
  const moduleMainBody = moduleEmission.stdout.slice(
    moduleEmission.stdout.indexOf("int32_t main(void) {"),
  );
  assert.doesNotMatch(moduleMainBody, /Z_Resource_deinit\(&resource\);/);
  const moduleExecutable = resolve(directory, "modules");
  const moduleCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", moduleExecutable],
    { encoding: "utf8", input: moduleEmission.stdout },
  );
  assert.equal(moduleCompilation.status, 0, moduleCompilation.stderr);
  const moduleExecution = spawnSync(moduleExecutable, [], { encoding: "utf8" });
  assert.equal(moduleExecution.status, 42, moduleExecution.stderr);

  const collisionA = resolve(directory, "collision-a.zs");
  const collisionB = resolve(directory, "collision-b.zs");
  const collisionMain = resolve(directory, "collision-main.zs");
  writeFileSync(
    collisionA,
    "function helper(value: i32): i32 { return value; }\n"
      + "export function first(value: i32): i32 { return helper(value); }\n",
  );
  writeFileSync(
    collisionB,
    "function helper(value: i32): i32 { return value; }\n"
      + "export function second(value: i32): i32 { return helper(value); }\n",
  );
  writeFileSync(
    collisionMain,
    "import { first } from \"./collision-a.zs\";\n"
      + "import { second } from \"./collision-b.zs\";\n"
      + "function main(): i32 { return first(20) + second(22); }\n",
  );
  const collisionEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", collisionMain],
    { encoding: "utf8" },
  );
  assert.equal(collisionEmission.status, 0, collisionEmission.stderr);
  assert.equal(
    collisionEmission.stdout.match(
      /int32_t _z_function_\d+_helper\(int32_t value\)/g,
    )?.length,
    4,
  );
  assert.doesNotMatch(
    collisionEmission.stdout,
    /(?:^|\n)int32_t helper\(int32_t value\)/,
  );
  const collisionExecutable = resolve(directory, "collision-modules");
  const collisionCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", collisionExecutable],
    { encoding: "utf8", input: collisionEmission.stdout },
  );
  assert.equal(collisionCompilation.status, 0, collisionCompilation.stderr);
  const collisionExecution = spawnSync(
    collisionExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(collisionExecution.status, 42, collisionExecution.stderr);

  const typeCollisionA = resolve(directory, "type-collision-a.zs");
  const typeCollisionB = resolve(directory, "type-collision-b.zs");
  const typeCollisionMain = resolve(directory, "type-collision-main.zs");
  writeFileSync(
    typeCollisionA,
    "struct Value { amount: i32; deinit {} }\n"
      + "enum State { ready Value, }\n"
      + "export function first(amount: i32): i32 {\n"
      + "  const discarded = State.ready(Value({ amount: 0 }));\n"
      + "  const state = State.ready(Value({ amount }));\n"
      + "  return match (state) { ready(value) => value.amount; };\n"
      + "}\n",
  );
  writeFileSync(
    typeCollisionB,
    "struct Value { amount: i32; deinit {} }\n"
      + "enum State { ready Value, }\n"
      + "export function second(amount: i32): i32 {\n"
      + "  const discarded = State.ready(Value({ amount: 0 }));\n"
      + "  const state = State.ready(Value({ amount }));\n"
      + "  return match (state) { ready(value) => value.amount; };\n"
      + "}\n",
  );
  writeFileSync(
    typeCollisionMain,
    "import { first } from \"./type-collision-a.zs\";\n"
      + "import { second } from \"./type-collision-b.zs\";\n"
      + "function main(): i32 { return first(20) + second(22); }\n",
  );
  const typeCollisionEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", typeCollisionMain],
    { encoding: "utf8" },
  );
  assert.equal(typeCollisionEmission.status, 0, typeCollisionEmission.stderr);
  assert.equal(
    typeCollisionEmission.stdout.match(
      /typedef struct Z_module_\d+_Value \{/g,
    )?.length,
    2,
  );
  assert.equal(
    typeCollisionEmission.stdout.match(
      /typedef struct Z_module_\d+_State \{/g,
    )?.length,
    2,
  );
  assert.doesNotMatch(
    typeCollisionEmission.stdout,
    /typedef struct Z_(?:Value|State) \{/,
  );
  assert.equal(
    typeCollisionEmission.stdout.match(
      /static __attribute__\(\(unused\)\) void Z_module_\d+_State_deinit\(Z_module_\d+_State \*self\)/g,
    )?.length,
    4,
  );
  const typeCollisionExecutable = resolve(directory, "type-collision-modules");
  const typeCollisionCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", typeCollisionExecutable],
    { encoding: "utf8", input: typeCollisionEmission.stdout },
  );
  assert.equal(typeCollisionCompilation.status, 0, typeCollisionCompilation.stderr);
  const typeCollisionExecution = spawnSync(
    typeCollisionExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(typeCollisionExecution.status, 42, typeCollisionExecution.stderr);

  const exportedCollisionA = resolve(directory, "exported-collision-a.zs");
  const exportedCollisionB = resolve(directory, "exported-collision-b.zs");
  const exportedCollisionMain = resolve(directory, "exported-collision-main.zs");
  writeFileSync(
    exportedCollisionA,
    "export function duplicate(value: i32): i32 { return value; }\n",
  );
  writeFileSync(
    exportedCollisionB,
    "export function duplicate(value: i32): i32 { return value; }\n",
  );
  writeFileSync(
    exportedCollisionMain,
    "import { duplicate as first } from \"./exported-collision-a.zs\";\n"
      + "import { duplicate as second } from \"./exported-collision-b.zs\";\n"
      + "function main(): i32 { return first(20) + second(22); }\n",
  );
  const exportedCollisionEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", exportedCollisionMain],
    { encoding: "utf8" },
  );
  assert.equal(exportedCollisionEmission.status, 0, exportedCollisionEmission.stderr);
  const exportedCollisionExecutable = resolve(directory, "exported-collision-modules");
  const exportedCollisionCompilation = spawnSync("clang", [
    "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", exportedCollisionExecutable,
  ], { encoding: "utf8", input: exportedCollisionEmission.stdout, timeout: 30_000, killSignal: "SIGKILL" });
  assert.equal(exportedCollisionCompilation.status, 0, exportedCollisionCompilation.stderr);
  const exportedCollisionExecution = spawnSync(exportedCollisionExecutable, [], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
  });
  assert.equal(exportedCollisionExecution.status, 42, exportedCollisionExecution.stderr);

  const exportedTypeCollisionA = resolve(
    directory,
    "exported-type-collision-a.zs",
  );
  const exportedTypeCollisionB = resolve(
    directory,
    "exported-type-collision-b.zs",
  );
  const exportedTypeCollisionMain = resolve(
    directory,
    "exported-type-collision-main.zs",
  );
  writeFileSync(
    exportedTypeCollisionA,
    "export struct Shared { value: i32; }\n",
  );
  writeFileSync(
    exportedTypeCollisionB,
    "export struct Shared { value: i32; }\n",
  );
  writeFileSync(
    exportedTypeCollisionMain,
    "import { Shared as First } from \"./exported-type-collision-a.zs\";\n"
      + "import { Shared as Second } from \"./exported-type-collision-b.zs\";\n"
      + "function main(): i32 { return 0; }\n",
  );
  const exportedTypeCollisionEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", exportedTypeCollisionMain],
    { encoding: "utf8" },
  );
  assert.notEqual(exportedTypeCollisionEmission.status, 0);
  assert.match(
    exportedTypeCollisionEmission.stderr,
    /native module emission requires collision-safe type identity for Shared/,
  );

  const controlFlowInput = resolve(projectRoot, "tests/fixtures/self-host-emit-control-flow.zs");
  const controlFlowEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", controlFlowInput],
    { encoding: "utf8" },
  );
  assert.equal(controlFlowEmission.status, 0, controlFlowEmission.stderr);
  assert.match(controlFlowEmission.stdout, /while \(current <= limit\)/);
  assert.match(controlFlowEmission.stdout, /if \(answer == 120\)/);
  const controlFlowExecutable = resolve(directory, "control-flow");
  const controlFlowCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", controlFlowExecutable],
    { encoding: "utf8", input: controlFlowEmission.stdout },
  );
  assert.equal(controlFlowCompilation.status, 0, controlFlowCompilation.stderr);
  const controlFlowExecution = spawnSync(controlFlowExecutable, [], { encoding: "utf8" });
  assert.equal(controlFlowExecution.status, 0, controlFlowExecution.stderr);

  const nativeIntegerInput = resolve(directory, "native-integers.zs");
  writeFileSync(
    nativeIntegerInput,
    "function addSize(value: usize): usize { return value + 2; }\n"
      + "function doubleByte(value: u8): u8 { return value * 2; }\n"
      + "function halveSize(value: usize): usize { return value / 2; }\n"
      + "function remainderByte(value: u8): u8 { return value % 5; }\n"
      + "function halveSigned(value: i32): i32 { return value / 2; }\n"
      + "function discard(values: Array<i32>): usize { return 0; }\n"
      + "function main(): i32 {\n"
      + "  const size: usize = 20;\n"
      + "  const byte: u8 = 11;\n"
      + "  if (addSize(size) == 22 && doubleByte(byte) == 22 && halveSize(size) == 10 && remainderByte(byte) == 1 && halveSigned(42) == 21) return 0;\n"
      + "  return 1;\n"
      + "}\n",
  );
  const nativeIntegerEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", nativeIntegerInput],
    { encoding: "utf8" },
  );
  assert.equal(nativeIntegerEmission.status, 0, nativeIntegerEmission.stderr);
  assert.match(
    nativeIntegerEmission.stdout,
    /size_t _z_function_\d+_addSize\(size_t value\).*?z_stage1_checked_add_usize\(value, (?:2|UINT64_C\(2\))\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /uint8_t _z_function_\d+_doubleByte\(uint8_t value\).*?z_stage1_checked_multiply_u8\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /size_t _z_function_\d+_halveSize\(size_t value\).*?z_stage1_checked_divide_usize\(value, (?:2|UINT64_C\(2\))\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /uint8_t _z_function_\d+_remainderByte\(uint8_t value\).*?z_stage1_checked_remainder_u8\(value, 5\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /int32_t _z_function_\d+_halveSigned\(int32_t value\).*?z_stage1_checked_divide_i32\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /typedef struct Z___z_Array_i32 \{.*?void \*data;.*?size_t length;.*?size_t capacity;.*?static __attribute__\(\(unused\)\) void Z___z_Array_i32_deinit\(Z___z_Array_i32 \*self\).*?size_t _z_function_\d+_discard\(Z___z_Array_i32 values\).*?Z___z_Array_i32_deinit\(&values\);/s,
  );
  const nativeIntegerExecutable = resolve(directory, "native-integers");
  const nativeIntegerCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", nativeIntegerExecutable],
    { encoding: "utf8", input: nativeIntegerEmission.stdout },
  );
  assert.equal(nativeIntegerCompilation.status, 0, nativeIntegerCompilation.stderr);
  const nativeIntegerExecution = spawnSync(
    nativeIntegerExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(nativeIntegerExecution.status, 0, nativeIntegerExecution.stderr);

  const nativeStringInput = resolve(directory, "native-string.zs");
  writeFileSync(
    nativeStringInput,
    "import { TextBuffer } from \"std/text\";\n"
      + "function inspect(value: String): usize {\n"
      + "  const middle = value.copyBytes(1, 4);\n"
      + "  if (middle == \"ell\" && value.byteAt(0) == 104 && value.byteLength == 5 && !value.isEmpty) {\n"
      + "    return middle.byteLength;\n"
      + "  }\n"
      + "  return 0;\n"
      + "}\n"
      + "function borrowedLength(in value: String): usize { return value.byteLength; }\n"
      + "function initialize(out value: usize): void { value = 20; }\n"
      + "function increment(inout value: usize): void { value = value + 2; }\n"
      + "function build(): String {\n"
      + "  let output = TextBuffer();\n"
      + "  output.append(\"he\");\n"
      + "  output.appendBytes(\"llo!\", 0, 1);\n"
      + "  output.appendAscii(108);\n"
      + "  output.appendCodePoint(111);\n"
      + "  return output.finish();\n"
      + "}\n"
      + "function main(): i32 {\n"
      + "  let answer: usize;\n"
      + "  const built = build();\n"
      + "  initialize(out answer);\n"
      + "  increment(inout answer);\n"
      + "  if (inspect(\"hello\") == 3 && borrowedLength(\"ok\") == 2 && answer == 22 && built == \"hello\") return 0;\n"
      + "  return 1;\n"
      + "}\n",
  );
  const nativeStringEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", nativeStringInput],
    { encoding: "utf8" },
  );
  assert.equal(nativeStringEmission.status, 0, nativeStringEmission.stderr);
  assert.match(
    nativeStringEmission.stdout,
    /Z_String _z_function_\d+_inspect\(Z_String value\)|size_t _z_function_\d+_inspect\(Z_String value\)/,
  );
  assert.match(nativeStringEmission.stdout, /z_string_copy_bytes\(value, (?:1|UINT64_C\(1\)), (?:4|UINT64_C\(4\))\)/);
  assert.match(nativeStringEmission.stdout, /z_string_equal\(middle, Z_STRING_LITERAL\("ell"\)\)/);
  assert.match(nativeStringEmission.stdout, /z_string_byte_at\(value, (?:0|UINT64_C\(0\))\)/);
  assert.match(nativeStringEmission.stdout, /Z_String_deinit\(&middle\)/);
  assert.match(nativeStringEmission.stdout, /Z_String_deinit\(&value\)/);
  assert.match(
    nativeStringEmission.stdout,
    /size_t _z_function_\d+_borrowedLength\(Z_String const \*value\).*?\(\(\*value\)\)\.length/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /void _z_function_\d+_initialize\(size_t \*value\).*?\(\*value\) = (?:20|UINT64_C\(20\));/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /void _z_function_\d+_increment\(size_t \*value\).*?\(\*value\) = z_stage1_checked_add_usize\(\(\*value\), (?:2|UINT64_C\(2\))\);/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /_z_function_\d+_borrowedLength\(Z_STRING_LITERAL_ADDRESS\("ok"\)\)/,
  );
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append\(&\(output\), Z_STRING_LITERAL\("he"\)\)/);
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append_bytes\(&\(output\), Z_STRING_LITERAL\("llo!"\), (?:0|UINT64_C\(0\)), (?:1|UINT64_C\(1\))\)/);
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append_ascii\(&\(output\), 108\)/);
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append_code_point\(&\(output\), 111\)/);
  assert.doesNotMatch(
    nativeStringEmission.stdout,
    /Z_String_deinit\(&output\)/,
  );
  assert.match(nativeStringEmission.stdout, /Z_String_deinit\(&built\)/);
  const nativeStringExecutable = resolve(directory, "native-string");
  const nativeStringCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", nativeStringExecutable],
    { encoding: "utf8", input: nativeStringEmission.stdout },
  );
  assert.equal(nativeStringCompilation.status, 0, nativeStringCompilation.stderr);
  const nativeStringExecution = spawnSync(
    nativeStringExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(nativeStringExecution.status, 0, nativeStringExecution.stderr);

  const overflowInput = resolve(directory, "overflow.zs");
  writeFileSync(
    overflowInput,
    "function main(): i32 {\n"
      + "  const maximum: i32 = 2147483647;\n"
      + "  return maximum + 1;\n"
      + "}\n",
  );
  const overflowEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", overflowInput],
    { encoding: "utf8" },
  );
  assert.equal(overflowEmission.status, 0, overflowEmission.stderr);
  assert.match(overflowEmission.stdout, /z_stage1_checked_add_i32\(maximum, 1\)/);
  const overflowExecutable = resolve(directory, "overflow");
  const overflowCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", overflowExecutable],
    { encoding: "utf8", input: overflowEmission.stdout },
  );
  assert.equal(overflowCompilation.status, 0, overflowCompilation.stderr);
  const overflowExecution = spawnSync(overflowExecutable, [], { encoding: "utf8" });
  assert.notEqual(overflowExecution.status, 0);

  const structInput = resolve(projectRoot, "tests/fixtures/self-host-emit-struct.zs");
  const structEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", structInput],
    { encoding: "utf8" },
  );
  assert.equal(structEmission.status, 0, structEmission.stderr);
  assert.match(structEmission.stdout, /typedef struct Z_Point/);
  assert.match(structEmission.stdout, /Z_Point point = \(Z_Point\)\{\.x = 20, \.y = 22\};/);
  const structExecutable = resolve(directory, "struct");
  const structCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", structExecutable],
    { encoding: "utf8", input: structEmission.stdout },
  );
  assert.equal(structCompilation.status, 0, structCompilation.stderr);
  const structExecution = spawnSync(structExecutable, [], { encoding: "utf8" });
  assert.equal(structExecution.status, 42, structExecution.stderr);

  const enumInput = resolve(projectRoot, "tests/fixtures/self-host-emit-enum.zs");
  const enumEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", enumInput],
    { encoding: "utf8" },
  );
  assert.equal(enumEmission.status, 0, enumEmission.stderr);
  assert.match(enumEmission.stdout, /typedef enum Z_Mode/);
  assert.match(enumEmission.stdout, /Z_Mode_active/);
  assert.match(
    enumEmission.stdout,
    /Z_Snapshot snapshot = \(Z_Snapshot\)\{\.mode = Z_Mode_active, \.count = 2\};/,
  );
  const enumExecutable = resolve(directory, "enum");
  const enumCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", enumExecutable],
    { encoding: "utf8", input: enumEmission.stdout },
  );
  assert.equal(enumCompilation.status, 0, enumCompilation.stderr);
  const enumExecution = spawnSync(enumExecutable, [], { encoding: "utf8" });
  assert.equal(enumExecution.status, 42, enumExecution.stderr);

  const payloadEnumInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-payload-enum.zs",
  );
  const payloadEnumEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", payloadEnumInput],
    { encoding: "utf8" },
  );
  assert.equal(payloadEnumEmission.status, 0, payloadEnumEmission.stderr);
  assert.match(payloadEnumEmission.stdout, /typedef enum Z_ReadingTag/);
  assert.match(
    payloadEnumEmission.stdout,
    /typedef struct Z_Reading.*?int32_t count;.*?\} payload;/s,
  );
  assert.match(
    payloadEnumEmission.stdout,
    /return \(Z_Reading\)\{\.tag = Z_ReadingTag_count, \.payload = \{ \.count = value\}\};/,
  );
  assert.match(
    payloadEnumEmission.stdout,
    /return \(Z_Reading\)\{\.tag = Z_ReadingTag_idle\};/,
  );
  assert.match(
    payloadEnumEmission.stdout,
    /Z_Reading _z_stage1_match_\d+ = reading;\n  switch \(_z_stage1_match_\d+\.tag\).*?case Z_ReadingTag_count: \{\n      const int32_t __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.count;\n      return _z_stage1_match_payload_\d+_\d+;/s,
  );
  const payloadEnumExecutable = resolve(directory, "payload-enum");
  const payloadEnumCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", payloadEnumExecutable],
    { encoding: "utf8", input: payloadEnumEmission.stdout },
  );
  assert.equal(payloadEnumCompilation.status, 0, payloadEnumCompilation.stderr);
  const payloadEnumExecution = spawnSync(payloadEnumExecutable, [], { encoding: "utf8" });
  assert.equal(payloadEnumExecution.status, 42, payloadEnumExecution.stderr);

  const optionInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-option.zs",
  );
  const optionEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", optionInput],
    { encoding: "utf8" },
  );
  assert.equal(optionEmission.status, 0, optionEmission.stderr);
  assert.match(optionEmission.stdout, /typedef enum Z___z_Option_i32Tag/);
  assert.match(
    optionEmission.stdout,
    /Z___z_Option_i32Tag_some,.*?Z___z_Option_i32Tag_none/s,
  );
  assert.match(
    optionEmission.stdout,
    /return \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_some, \.payload = \{ \.some = value\}\};/,
  );
  assert.match(
    optionEmission.stdout,
    /return \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_none\};/,
  );
  assert.match(
    optionEmission.stdout,
    /_z_function_\d+_inspect\(Z___z_Option_i32 option\).*?switch \(_z_stage1_match_\d+\.tag\)/s,
  );
  assert.match(
    optionEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z___z_Option_Resource_deinit\(Z___z_Option_Resource \*self\) \{.*?case Z___z_Option_ResourceTag_some:.*?Z_Resource_deinit\(&self->payload\.some\);/s,
  );
  assert.match(
    optionEmission.stdout,
    /inspectResource\(Z___z_Option_Resource option\).*?Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.some;.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);/s,
  );
  assert.match(
    optionEmission.stdout,
    /discardResource\(void\).*?__attribute__\(\(unused\)\) Z___z_Option_Resource held = _z_function_\d+_resource\(0\);.*?Z___z_Option_Resource_deinit\(&held\);/s,
  );
  assert.match(
    optionEmission.stdout,
    /Z___z_Option_i32 scalar = \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_some, \.payload = \{ \.some = 42\}\};/,
  );
  assert.match(
    optionEmission.stdout,
    /Z___z_Option_i32 noScalar = \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_none\};/,
  );
  assert.match(
    optionEmission.stdout,
    /present \? \(Z___z_Option_String\)\{\.tag = Z___z_Option_StringTag_some, \.payload = \{ \.some = Z_STRING_LITERAL\("z"\)\}\} : \(Z___z_Option_String\)\{\.tag = Z___z_Option_StringTag_none\}/,
  );
  assert.match(
    optionEmission.stdout,
    /Z___z_Option_Note storedNote = .*?_z_stage1_live_note = false, note/s,
  );
  assert.match(
    optionEmission.stdout,
    /Z___z_Option_User storedUser = .*?\.payload = \{ \.some = Z_User_retain\(user\)/s,
  );
  assert.match(
    optionEmission.stdout,
    /userId\(Z___z_Option_User const \*option\).*?const Z___z_Option_User \* const _z_stage1_match_\d+ = &\(\(\*option\)\);.*?_z_stage1_match_\d+->payload\.some.*?return _z_stage1_match_payload_/s,
  );
  assert.doesNotMatch(optionEmission.stdout, /Option\.(?:some|none)/);
  const optionExecutable = resolve(directory, "option");
  const optionCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", optionExecutable],
    { encoding: "utf8", input: optionEmission.stdout },
  );
  assert.equal(optionCompilation.status, 0, optionCompilation.stderr);
  const optionExecution = spawnSync(optionExecutable, [], { encoding: "utf8" });
  assert.equal(optionExecution.status, 42, optionExecution.stderr);

  const resultInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-result.zs",
  );
  const resultEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", resultInput],
    { encoding: "utf8" },
  );
  assert.equal(resultEmission.status, 0, resultEmission.stderr);
  assert.match(resultEmission.stdout, /typedef enum Z___z_Result_i32_ProblemTag/);
  assert.match(
    resultEmission.stdout,
    /return \(Z___z_Result_i32_Problem\)\{\.tag = Z___z_Result_i32_ProblemTag_failure, \.payload = \{ \.failure = \(Z_Problem\)\{\.code = 7\}\}\};/,
  );
  assert.match(
    resultEmission.stdout,
    /return \(Z___z_Result_i32_Problem\)\{\.tag = Z___z_Result_i32_ProblemTag_success, \.payload = \{ \.success = 42\}\};/,
  );
  assert.match(
    resultEmission.stdout,
    /Z___z_Result_i32_Problem result = _z_function_\d+_relay\(shouldFail\);.*?case Z___z_Result_i32_ProblemTag_success:.*?case Z___z_Result_i32_ProblemTag_failure:/s,
  );
  assert.match(
    resultEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z___z_Result_Resource_Problem_deinit\(Z___z_Result_Resource_Problem \*self\) \{.*?case Z___z_Result_Resource_ProblemTag_success:.*?Z_Resource_deinit\(&self->payload\.success\);.*?case Z___z_Result_Resource_ProblemTag_failure:.*?Z_Problem_deinit\(&self->payload\.failure\);/s,
  );
  assert.match(
    resultEmission.stdout,
    /inspectResource\(bool shouldFail\).*?Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.success;.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);.*?Z_Problem __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.failure;.*?Z_Problem_deinit\(&_z_stage1_match_payload_\d+_\d+\);/s,
  );
  assert.match(
    resultEmission.stdout,
    /discardResult\(void\).*?__attribute__\(\(unused\)\) Z___z_Result_Resource_Problem result = _z_function_\d+_loadResource\(false\);.*?Z___z_Result_Resource_Problem_deinit\(&result\);/s,
  );
  assert.match(
    resultEmission.stdout,
    /_z_function_\d+_relay\(bool shouldFail\).*?_z_stage1_return_\d+ = _z_function_\d+_load\(shouldFail\);\n  Z_Resource_deinit\(&audit\);\n  return _z_stage1_return_\d+;/s,
  );
  assert.match(
    resultEmission.stdout,
    /adjusted\(bool shouldFail\).*?_z_stage1_try_\d+ = _z_function_\d+_load\(shouldFail\);.*?if \(_z_stage1_try_\d+\.tag == Z___z_Result_i32_ProblemTag_failure\).*?Z_Resource_deinit\(&audit\);\n    return _z_stage1_failure_\d+;.*?value = _z_stage1_try_\d+\.payload\.success;/s,
  );
  assert.match(
    resultEmission.stdout,
    /typedef struct Z___z_Result_void_Problem \{.*?union \{\n    Z_Problem failure;\n  \} payload;/s,
  );
  assert.match(
    resultEmission.stdout,
    /validate\(bool shouldFail\).*?return \(Z___z_Result_void_Problem\)\{\.tag = Z___z_Result_void_ProblemTag_failure, \.payload = \{ \.failure = .*?return \(Z___z_Result_void_Problem\)\{\.tag = Z___z_Result_void_ProblemTag_success\};/s,
  );
  assert.match(
    resultEmission.stdout,
    /relayVoid\(bool shouldFail\).*?_z_stage1_try_\d+ = _z_function_\d+_validate\(shouldFail\);.*?if \(_z_stage1_try_\d+\.tag == Z___z_Result_void_ProblemTag_failure\).*?Z_Resource_deinit\(&audit\);\n    return _z_stage1_failure_\d+;.*?Z___z_Result_void_Problem _z_stage1_return_\d+ = .*?Z_Resource_deinit\(&audit\);/s,
  );
  const resultExecutable = resolve(directory, "result");
  const resultCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", resultExecutable],
    { encoding: "utf8", input: resultEmission.stdout },
  );
  assert.equal(resultCompilation.status, 0, resultCompilation.stderr);
  const resultExecution = spawnSync(resultExecutable, [], { encoding: "utf8" });
  assert.equal(resultExecution.status, 42, resultExecution.stderr);

  const ownedEnumInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-owned-enum.zs",
  );
  const ownedEnumEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", ownedEnumInput],
    { encoding: "utf8" },
  );
  assert.equal(ownedEnumEmission.status, 0, ownedEnumEmission.stderr);
  assert.match(
    ownedEnumEmission.stdout,
    /typedef struct Z_Resource \{[\s\S]*typedef enum Z_ResourceStateTag[\s\S]*typedef struct Z_Container \{/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_ResourceState_deinit\(Z_ResourceState \*self\) \{[\s\S]*case Z_ResourceStateTag_ready:[\s\S]*Z_Resource_deinit\(&self->payload\.ready\);/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_Container_deinit\(Z_Container \*self\) \{[\s\S]*Z_ResourceState_deinit\(&self->state\);/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /_z_function_\d+_inspect\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;\n  switch \(_z_stage1_match_\d+\.tag\).*?case Z_ResourceStateTag_ready: \{\n      Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;.*?_z_stage1_return_\d+ = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n      if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n      return/s,
  );
  const inspectDefinition = ownedEnumEmission.stdout.match(
    /int32_t _z_function_\d+_inspect\(Z_ResourceState state\) \{[^]*?\n\}/,
  )?.[0] ?? "";
  assert.doesNotMatch(
    inspectDefinition,
    /^\s*Z_ResourceState_deinit\(&state\)/m,
  );
  assert.match(
    inspectDefinition,
    /bool _z_stage1_live_state = true;\n  _z_stage1_live_state = false;\n  Z_ResourceState _z_stage1_match_\d+ = state;/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectValue\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;.*?case Z_ResourceStateTag_ready: \{\n      Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;\n      int32_t _z_stage1_return_\d+ = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n      if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n      return/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectLocal\(Z_ResourceState state\) \{\n  \(void\)state;\n  bool _z_stage1_live_state = true;\n  __attribute__\(\(unused\)\) int32_t value;\n  _z_stage1_live_state = false;\n  Z_ResourceState _z_stage1_match_\d+ = state;\n  switch \(_z_stage1_match_\d+\.tag\).*?value = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);.*?int32_t _z_stage1_return_\d+ = value;\n  if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n  return _z_stage1_return_\d+;/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /selectResource\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;.*?case Z_ResourceStateTag_ready: \{\n      Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;\n      bool _z_stage1_live__z_stage1_match_payload_\d+_\d+ = true;\n      Z_Resource _z_stage1_return_\d+ = \(_z_stage1_live__z_stage1_match_payload_\d+_\d+ = false, _z_stage1_match_payload_\d+_\d+\);\n      if \(_z_stage1_live__z_stage1_match_payload_\d+_\d+\) Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n      if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n      return _z_stage1_return_\d+;/s,
  );
  const ownedLocalDefinition = ownedEnumEmission.stdout.match(
    /int32_t _z_function_\d+_inspectOwnedLocal\(void\) \{[^]*?\n\}/,
  )?.[0] ?? "";
  assert.match(
    ownedLocalDefinition,
    /Z_Resource selected;[\s\S]*selected = \(_z_stage1_live__z_stage1_match_payload_\d+_\d+ = false, _z_stage1_match_payload_\d+_\d+\);[\s\S]*Z_Resource_deinit\(&selected\);/,
  );
  assert.doesNotMatch(
    ownedLocalDefinition,
    /^\s*Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\)/m,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectCall\(void\) \{\n  Z_ResourceState _z_stage1_match_\d+ = _z_function_\d+_makeState\(42\);\n  switch \(_z_stage1_match_\d+\.tag\)/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectReturnBlock\(Z_ResourceState state\).*?Z_Resource audit = .*?_z_stage1_return_\d+ = audit\.id;\n        Z_Resource_deinit\(&audit\);\n        Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n        if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n        return/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectLocalBlock\(Z_ResourceState state\) \{\n  \(void\)state;\n  bool _z_stage1_live_state = true;\n  __attribute__\(\(unused\)\) int32_t value;.*?value = audit\.id;\n        Z_Resource_deinit\(&audit\);.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);.*?int32_t _z_stage1_return_\d+ = value;\n  if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);\n  return _z_stage1_return_\d+;/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectIf\(Z_ResourceState state, bool inspectNow\) \{\n  \(void\)state;\n  \(void\)inspectNow;\n  bool _z_stage1_live_state = true;.*?_z_stage1_live_state = false;\n    Z_ResourceState _z_stage1_match_\d+ = state;\n    switch \(_z_stage1_match_\d+\.tag\).*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n        if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /observe\(void\).*?Z_Container_deinit\(&container\);\n  Z_ResourceState_deinit\(&state\);\n  return/s,
  );
  const ownedEnumExecutable = resolve(directory, "owned-enum");
  const ownedEnumCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", ownedEnumExecutable],
    { encoding: "utf8", input: ownedEnumEmission.stdout },
  );
  assert.equal(ownedEnumCompilation.status, 0, ownedEnumCompilation.stderr);
  const ownedEnumExecution = spawnSync(ownedEnumExecutable, [], { encoding: "utf8" });
  assert.equal(ownedEnumExecution.status, 42, ownedEnumExecution.stderr);

  const cleanupInput = resolve(projectRoot, "tests/fixtures/self-host-emit-cleanup.zs");
  const cleanupEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", cleanupInput],
    { encoding: "utf8" },
  );
  assert.equal(cleanupEmission.status, 0, cleanupEmission.stderr);
  assert.match(
    cleanupEmission.stdout,
    /_z_stage1_return_\d+ = resource\.id;\n  Z_Resource_deinit\(&resource\);\n  return _z_stage1_return_\d+;/,
  );
  const cleanupExecutable = resolve(directory, "cleanup");
  const cleanupCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", cleanupExecutable],
    { encoding: "utf8", input: cleanupEmission.stdout },
  );
  assert.equal(cleanupCompilation.status, 0, cleanupCompilation.stderr);
  const cleanupExecution = spawnSync(cleanupExecutable, [], { encoding: "utf8" });
  assert.equal(cleanupExecution.status, 42, cleanupExecution.stderr);

  const moveInput = resolve(projectRoot, "tests/fixtures/self-host-emit-move.zs");
  const moveEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", moveInput],
    { encoding: "utf8" },
  );
  assert.equal(moveEmission.status, 0, moveEmission.stderr);
  assert.match(moveEmission.stdout, /int32_t _z_function_\d+_relay\(Z_Resource resource\) \{\n  \(void\)resource;\n  return _z_function_\d+_inspect\(resource\);\n\}/);
  const moveExecutable = resolve(directory, "move");
  const moveCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", moveExecutable],
    { encoding: "utf8", input: moveEmission.stdout },
  );
  assert.equal(moveCompilation.status, 0, moveCompilation.stderr);
  const moveExecution = spawnSync(moveExecutable, [], { encoding: "utf8" });
  assert.equal(moveExecution.status, 42, moveExecution.stderr);

  const localCleanupInput = resolve(projectRoot, "tests/fixtures/self-host-emit-local-cleanup.zs");
  const localCleanupEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", localCleanupInput],
    { encoding: "utf8" },
  );
  assert.equal(localCleanupEmission.status, 0, localCleanupEmission.stderr);
  assert.match(
    localCleanupEmission.stdout,
    /observeLocal\(void\).*?_z_stage1_return_\d+ = .*?;\n  Z_Resource_deinit\(&resource\);\n  return/s,
  );
  assert.match(
    localCleanupEmission.stdout,
    /moveLocal\(void\) \{\n  __attribute__\(\(unused\)\) Z_Resource resource = .*?;\n  return _z_function_\d+_inspect\(resource\);\n\}/s,
  );
  const localCleanupExecutable = resolve(directory, "local-cleanup");
  const localCleanupCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", localCleanupExecutable],
    { encoding: "utf8", input: localCleanupEmission.stdout },
  );
  assert.equal(localCleanupCompilation.status, 0, localCleanupCompilation.stderr);
  const localCleanupExecution = spawnSync(localCleanupExecutable, [], { encoding: "utf8" });
  assert.equal(localCleanupExecution.status, 42, localCleanupExecution.stderr);

  const cleanupFlowInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-cleanup-flow.zs",
  );
  const cleanupFlowEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", cleanupFlowInput],
    { encoding: "utf8" },
  );
  assert.equal(cleanupFlowEmission.status, 0, cleanupFlowEmission.stderr);
  assert.match(
    cleanupFlowEmission.stdout,
    /inspectBranch\(Z_Resource resource, bool chooseFirst\).*?if \(chooseFirst\).*?Z_Resource_deinit\(&resource\);.*?Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /localBranch\(bool chooseFirst\).*?if \(chooseFirst\).*?Z_Resource_deinit\(&resource\);.*?Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /branchLocal\(bool chooseFirst\).*?observed = branch\.id;\n    Z_Resource_deinit\(&branch\);.*?observed = alternate\.id;\n    Z_Resource_deinit\(&alternate\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /earlyBranch\(bool chooseFirst\).*?_z_stage1_return_\d+ = branch\.id;\n    Z_Resource_deinit\(&branch\);\n    return/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /loopLocal\(int32_t limit\).*?Z_Resource_deinit\(&resource\);\n      continue;.*?Z_Resource_deinit\(&resource\);\n      goto (_z_stage1_loop_exit_\d+);.*?Z_Resource_deinit\(&resource\);\n  \}\n  \1: __attribute__\(\(unused\)\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /replaceOwner\(int32_t next, bool replace\).*?_z_stage1_assignment_(\d+) = \(Z_Resource\)\{\.id = z_stage1_checked_add_i32\(resource\.id, next\)\};\n    Z_Resource \*_z_stage1_assignment_slot_\1 = &\(resource\);\n    Z_Resource_deinit\(_z_stage1_assignment_slot_\1\);\n    \*_z_stage1_assignment_slot_\1 = _z_stage1_assignment_\1;.*?Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_Envelope_deinit\(Z_Envelope \*self\) \{\n  \(void\)self;\n  Z_Resource_deinit\(&self->resource\);\n\}/,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_AuditedEnvelope_deinit\(Z_AuditedEnvelope \*self\) \{\n  \(void\)self;\n  __attribute__\(\(unused\)\) Z_Resource audit = \(Z_Resource\)\{\.id = self->resource\.id\};\n  _z_function_\d+_record\(audit\.id\);\n  Z_Resource_deinit\(&audit\);\n  Z_Resource_deinit\(&self->resource\);\n\}/,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /nestedCleanup\(void\).*?_z_stage1_return_\d+ = envelope\.resource\.id;\n  Z_Envelope_deinit\(&envelope\);\n  return/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /customCleanup\(void\).*?_z_stage1_return_\d+ = envelope\.resource\.id;\n  Z_AuditedEnvelope_deinit\(&envelope\);\n  return/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /conditionalParameter\(Z_Resource resource, bool transfer\).*?bool _z_stage1_live_resource = true;.*?\(_z_stage1_live_resource = false, resource\).*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);.*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /conditionalLocal\(bool transfer\).*?Z_Resource resource = .*?;\n  bool _z_stage1_live_resource = true;.*?\(_z_stage1_live_resource = false, resource\).*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /matchCleanup\(Z_Resource resource, Z_Decision decision\).*?case Z_Decision_keep: \{.*?Z_Resource_deinit\(&resource\);.*?case Z_Decision_use: \{.*?Z_Resource_deinit\(&resource\);/s,
  );
  const cleanupFlowExecutable = resolve(directory, "cleanup-flow");
  const cleanupFlowCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", cleanupFlowExecutable],
    { encoding: "utf8", input: cleanupFlowEmission.stdout },
  );
  assert.equal(cleanupFlowCompilation.status, 0, cleanupFlowCompilation.stderr);
  const cleanupFlowExecution = spawnSync(cleanupFlowExecutable, [], { encoding: "utf8" });
  assert.equal(cleanupFlowExecution.status, 42, cleanupFlowExecution.stderr);

  const loopTransferInput = resolve(directory, "loop-transfer.zs");
  writeFileSync(
    loopTransferInput,
    [
      "struct Resource {",
      "  id: i32;",
      "  deinit {}",
      "}",
      "function consume(resource: Resource): i32 { return resource.id; }",
      "function inspect(resource: Resource, limit: i32): i32 {",
      "  let index: i32 = 0;",
      "  while (index < limit) {",
      "    if (index == 0) return consume(move resource);",
      "    index = index + 1;",
      "  }",
      "  return resource.id;",
      "}",
      "function main(): i32 { return inspect(Resource({ id: 42 }), 0); }",
      "",
    ].join("\n"),
  );
  const loopTransferEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", loopTransferInput],
    { encoding: "utf8" },
  );
  assert.equal(loopTransferEmission.status, 0, loopTransferEmission.stderr);
  assert.match(
    loopTransferEmission.stdout,
    /_z_function_\d+_inspect\(Z_Resource resource, int32_t limit\).*?bool _z_stage1_live_resource = true;.*?\(_z_stage1_live_resource = false, resource\).*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/s,
  );
  const loopTransferExecutable = resolve(directory, "loop-transfer");
  const loopTransferCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", loopTransferExecutable],
    { encoding: "utf8", input: loopTransferEmission.stdout },
  );
  assert.equal(loopTransferCompilation.status, 0, loopTransferCompilation.stderr);
  const loopTransferExecution = spawnSync(
    loopTransferExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(loopTransferExecution.status, 42, loopTransferExecution.stderr);

  const invalidInput = resolve(directory, "invalid.zs");
  writeFileSync(invalidInput, "function main(): i32 { return missing; }\n");
  const invalidEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", invalidInput],
    { encoding: "utf8" },
  );
  assert.equal(invalidEmission.status, 1);
  assert.match(invalidEmission.stderr, /invalid\.zs:1:\d+: unknown name missing/);
}, 45_000);

test("emits consuming receivers with guarded cleanup and sole-field transfer", () => {
  const directory = mkdtempSync("/tmp/z-self-host-move-this-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    struct Wrapper {
      value: String;

      function measure(move this): i32 {
        return i32(this.value.byteLength);
      }

      function take(move this): String {
        return this.value;
      }
    }

    function main(): i32 {
      const measuredSource = Wrapper({ value: "abc" });
      const measured = measuredSource.measure();
      const takenSource = Wrapper({ value: "ready" });
      const taken = takenSource.take();
      return measured + i32(taken.byteLength) - 8;
    }
  `);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_Wrapper_measure\(Z_Wrapper self\).*?bool _z_stage1_live_this = true;.*?if \(_z_stage1_live_this\) Z_Wrapper_deinit\(&self\);/s,
  );
  assert.match(
    emission.stdout,
    /Z_Wrapper_take\(Z_Wrapper self\).*?\(_z_stage1_live_this = false, self\.value\).*?if \(_z_stage1_live_this\) Z_Wrapper_deinit\(&self\);/s,
  );
  assert.match(
    emission.stdout,
    /const int32_t measured = Z_Wrapper_measure\(measuredSource\);/,
  );
  assert.match(
    emission.stdout,
    /Z_String taken = Z_Wrapper_take\(takenSource\);/,
  );

  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 90_000);

test("emits cleanup-free module constants through the native frontend", () => {
  const directory = mkdtempSync("/tmp/z-self-host-constants-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-module-constants/main.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) const int32_t __z_module_\d+_BASE = 40;/,
    );
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) const Z_String __z_module_\d+_LABEL = \{ \.data = "native constants"/,
    );
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) const char \* const __z_module_\d+_NATIVE_LABEL = "native-constants";/,
    );
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) const double __z_module_\d+_INTERNAL_RATIO = 1\.5;/,
    );

    const executable = resolve(directory, "module-constants");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 42, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("embeds static bytes through the fixed-point native frontend", () => {
  const directory = mkdtempSync("/tmp/z-self-host-embed-");
  const input = resolve(
    projectRoot,
    "examples/language/modules/embedded-assets.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /typedef struct Z_StaticBytes/);
    assert.match(
      emission.stdout,
      /static const uint8_t z_stage1_embedded_bytes_\d+_\d+\[\d+\] = \{ 90, 32, 101, 109, 98, 101, 100, 115/,
    );
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) const Z_StaticBytes __z_module_\d+_MESSAGE = \{ \.data = z_stage1_embedded_bytes_\d+_\d+, \.length = \d+ \};/,
    );

    const executable = resolve(directory, "embedded-assets");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("emits type-only static byte catalogs through the fixed-point frontend", () => {
  const directory = mkdtempSync("/tmp/z-self-host-static-bytes-type-only-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/static-bytes-type-only.zs",
  );
  try {
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /typedef struct Z_StaticBytes/);
    assert.match(emission.stdout, /Z_StaticBytes bytes;/);
    assert.equal(/z_stage1_embedded_bytes_/.test(emission.stdout), false);

    const executable = resolve(directory, "static-bytes-type-only");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("preserves imported StaticBytes fields through native module lowering", () => {
  const directory = mkdtempSync("/tmp/z-self-host-static-bytes-module-");
  const assetModule = resolve(directory, "asset.zs");
  const input = resolve(directory, "main.zs");
  try {
    writeFileSync(resolve(directory, "payload.txt"), "Z");
    writeFileSync(assetModule, [
      'import embed from "std/embed";',
      "export struct Asset {",
      "  bytes: embed.StaticBytes;",
      "}",
      "",
    ].join("\n"));
    writeFileSync(input, [
      'import embed from "std/embed";',
      'import { Asset } from "./asset.zs";',
      'const PAYLOAD: embed.StaticBytes = embed.bytes("./payload.txt");',
      "function main(): i32 {",
      "  const asset = Asset({ bytes: PAYLOAD });",
      "  return asset.bytes.length == 1 ? 0 : 1;",
      "}",
      "",
    ].join("\n"));

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_StaticBytes bytes;/);

    const executable = resolve(directory, "static-bytes-module");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("keeps ordinary native Z functions out of the host link namespace", () => {
  const directory = mkdtempSync("/tmp/z-self-host-private-linkage-");
  const input = resolve(directory, "main.zs");
  try {
    writeFileSync(input, [
      "function advance(): i32 {",
      "  return 42;",
      "}",
      "function main(): i32 {",
      "  return advance() - 42;",
      "}",
      "",
    ].join("\n"));
    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /static __attribute__\(\(unused\)\) int32_t _z_function_\d+_advance\(void\)/,
    );

    const generated = resolve(directory, "generated.c");
    const host = resolve(directory, "host.c");
    const executable = resolve(directory, "private-linkage");
    writeFileSync(generated, emission.stdout);
    writeFileSync(host, "int advance(void) { return 7; }\n");
    const compilation = spawnSync(
      "clang",
      [generated, host, "-std=c11", "-Wall", "-Wextra", "-Werror", "-o", executable],
      { encoding: "utf8" },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

hostToolchainTest("borrows embedded bytes into NSData through the fixed-point frontend", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-self-host-embedded-data-");
  const input = resolve(
    projectRoot,
    "examples/interop/objc/embedded-data.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /static inline __attribute__\(\(unused\)\) NSData \*z_stage1_nsdata_borrow_static_bytes\(Z_StaticBytes bytes\)/,
    );
    assert.match(
      emission.stdout,
      /initWithBytesNoCopy:source length:\(NSUInteger\)bytes\.length freeWhenDone:NO/,
    );
    assert.match(
      emission.stdout,
      /z_stage1_nsdata_borrow_static_bytes\(__z_module_\d+_PAYLOAD\)/,
    );

    const executable = resolve(directory, "embedded-data");
    const compilation = spawnSync(
      "clang",
      [
        "-x", "objective-c",
        "-fobjc-arc",
        "-framework", "Foundation",
        "-Wall", "-Wextra", "-Werror",
        "-",
        "-o", executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

hostToolchainTest("copies byte slices into NSData through the fixed-point frontend", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-self-host-data-copy-");
  const input = resolve(
    projectRoot,
    "examples/interop/objc/data-copy.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /static inline __attribute__\(\(unused\)\) NSData \*z_stage1_nsdata_copy_bytes\(Z___z_Slice_u8 bytes\)/,
    );
    assert.match(
      emission.stdout,
      /\[\[NSData alloc\] initWithBytes:source length:\(NSUInteger\)bytes\.length\]/,
    );
    assert.match(
      emission.stdout,
      /z_stage1_nsdata_copy_bytes\(bytes\)/,
    );

    const executable = resolve(directory, "data-copy");
    const compilation = spawnSync(
      "clang",
      [
        "-x", "objective-c",
        "-fobjc-arc",
        "-framework", "Foundation",
        "-Wall", "-Wextra", "-Werror",
        "-",
        "-o", executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

hostToolchainTest("lowers lexical Objective-C pools without closure allocation natively", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-self-host-objc-pool-");
  const input = resolve(
    projectRoot,
    "examples/interop/objc/autorelease-pool.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /z_stage1_objc_pool__z_function_\d+_pooledValue_\d+\(const bool \*shouldFail\) \{\n  @autoreleasepool \{/,
    );
    assert.match(
      emission.stdout,
      /return z_stage1_objc_pool__z_function_\d+_pooledValue_\d+\(&\(shouldFail\)\);/,
    );
    assert.doesNotMatch(emission.stdout, /malloc\(sizeof\([^\n]*objc_pool/);
    assert.doesNotMatch(emission.stdout, /_Block_copy|Z_ObjCClosureBox/);

    const executable = resolve(directory, "objc-pool");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "objective-c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-",
        "-framework",
        "Foundation",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("emits module-owned Once class lifetimes through the native frontend", () => {
  const directory = mkdtempSync("/tmp/z-self-host-once-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-once/main.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Once/);
    assert.match(emission.stdout, /OnceLifetime/);
    assert.match(
      emission.stdout,
      /cell->state = 2;/,
      "dropping the lifetime must permanently close the Once cell",
    );
    assert.match(emission.stdout, /Z_Once_Application_state/);
    assert.match(emission.stdout, /Z_OnceState_initialized/);
    assert.match(emission.stdout, /Z_Application_release/);
    assert.match(emission.stdout, /free\(self\);/);

    const executable = resolve(directory, "once");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "released 42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("emits, joins, and cleans up a native worker task", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-task-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-task.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /typedef struct Z_Task_i32Storage/);
    assert.match(emission.stdout, /pthread_create/);
    assert.match(emission.stdout, /pthread_join/);
    assert.match(emission.stdout, /Z_Task_i32_await/);
    assert.match(emission.stdout, /Z_Task_i32_deinit\(&worker\)/);
    assert.match(emission.stdout, /thread_spawn_main_\d+_Context/);
    assert.match(emission.stdout, /worker_context->adjustment = adjustment;/);
    assert.match(emission.stdout, /free\(worker_context\);/);

    const executable = resolve(directory, "thread-task");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const ownedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-owned-capture.zs",
    );
    const ownedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", ownedInput],
      { encoding: "utf8" },
    );
    assert.equal(ownedEmission.status, 0, ownedEmission.stderr);
    assert.match(
      ownedEmission.stdout,
      /Z_String_deinit\(&worker_context->message\);/,
    );
    assert.match(
      ownedEmission.stdout,
      /Z_String_deinit\(&worker_context->blockMessage\);/,
    );
    assert.match(
      ownedEmission.stdout,
      /Z_String_deinit\(&worker_context->input\);/,
    );
    assert.doesNotMatch(ownedEmission.stdout, /Z_String_deinit\(&input\);/);
    assert.match(
      ownedEmission.stdout,
      /_z_stage1_live_message = false/,
    );
    assert.match(
      ownedEmission.stdout,
      /if \(_z_stage1_live_message\) Z_String_deinit\(&message\);/,
    );

    const ownedExecutable = resolve(directory, "thread-owned-capture");
    const ownedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        ownedExecutable,
      ],
      { encoding: "utf8", input: ownedEmission.stdout },
    );
    assert.equal(ownedCompilation.status, 0, ownedCompilation.stderr);
    const ownedExecution = spawnSync(ownedExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(ownedExecution.status, 0, ownedExecution.stderr);

    const consumingInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-owned-capture-consume.zs",
    );
    const consumingEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", consumingInput],
      { encoding: "utf8" },
    );
    assert.equal(consumingEmission.status, 0, consumingEmission.stderr);
    assert.match(
      consumingEmission.stdout,
      /\(\*_z_stage1_capture_live_0\) = false/,
    );
    const consumingExecutable = resolve(directory, "thread-capture-consume");
    const consumingCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        consumingExecutable,
      ],
      { encoding: "utf8", input: consumingEmission.stdout },
    );
    assert.equal(
      consumingCompilation.status,
      0,
      consumingCompilation.stderr,
    );
    const consumingExecution = spawnSync(consumingExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(consumingExecution.status, 0, consumingExecution.stderr);

    const sharedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-shared-capture.zs",
    );
    const sharedParity = spawnSync(
      process.execPath,
      [cli, "check", sharedInput],
      { encoding: "utf8" },
    );
    assert.equal(sharedParity.status, 0, sharedParity.stderr);
    const sharedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", sharedInput],
      { encoding: "utf8" },
    );
    assert.equal(sharedEmission.status, 0, sharedEmission.stderr);
    assert.match(
      sharedEmission.stdout,
      /Z_Snapshot_retain\(worker_context->snapshot\);/,
    );
    assert.match(
      sharedEmission.stdout,
      /Z_Snapshot_release\(worker_context->snapshot\);/,
    );
    assert.match(
      sharedEmission.stdout,
      /Z_Snapshot_release\(snapshot\);/,
    );

    const sharedExecutable = resolve(directory, "thread-shared-capture");
    const sharedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        sharedExecutable,
      ],
      { encoding: "utf8", input: sharedEmission.stdout },
    );
    assert.equal(sharedCompilation.status, 0, sharedCompilation.stderr);
    const sharedExecution = spawnSync(sharedExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(sharedExecution.status, 0, sharedExecution.stderr);

    const sharedModuleInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-thread-shared-module/main.zs",
    );
    const sharedModuleEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", sharedModuleInput],
      { encoding: "utf8" },
    );
    assert.equal(
      sharedModuleEmission.status,
      0,
      sharedModuleEmission.stderr,
    );
    assert.match(
      sharedModuleEmission.stdout,
      /Z_Snapshot_retain\(worker_context->snapshot\);/,
    );
    assert.match(
      sharedModuleEmission.stdout,
      /Z_SharedCounter_retain\(worker_context->shared\);/,
    );
    const sharedModuleExecutable = resolve(
      directory,
      "thread-shared-module",
    );
    const sharedModuleCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        sharedModuleExecutable,
      ],
      { encoding: "utf8", input: sharedModuleEmission.stdout },
    );
    assert.equal(
      sharedModuleCompilation.status,
      0,
      sharedModuleCompilation.stderr,
    );
    const sharedModuleExecution = spawnSync(sharedModuleExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(
      sharedModuleExecution.status,
      0,
      sharedModuleExecution.stderr,
    );

    const unshareableInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-unshareable-capture-invalid.zs",
    );
    const unshareable = spawnSync(
      process.execPath,
      [cli, "self-host-emit", unshareableInput],
      { encoding: "utf8" },
    );
    assert.equal(unshareable.status, 1);
    // The native resolver now reports Stage 0's Z0704 reason before lowering.
    assert.match(
      unshareable.stderr,
      /error\[Z0704\]: capture "snapshot" of type MutableSnapshot cannot cross a native thread boundary: MutableSnapshot exposes mutable method "increment"/,
    );

    for (const [fixture, binding, type] of [[
      "self-host-emit-thread-custom-deinit-capture-invalid.zs",
      "snapshot",
      "ManagedSnapshot",
    ]] as const) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const result = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(
          `capture "${binding}" of type ${type} cannot cross a native thread boundary: ${type} has a custom deinit whose thread affinity is unknown`,
        ),
      );
    }

    const affineInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-affine-capture-invalid.zs",
    );
    const affine = spawnSync(
      process.execPath,
      [cli, "self-host-emit", affineInput],
      { encoding: "utf8" },
    );
    assert.equal(affine.status, 1);
    assert.match(
      affine.stderr,
      /field "Presenter\.value" requires thread\.main executor context/,
    );

    const sharedRemovalInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-shared-removal-invalid.zs",
    );
    const sharedRemoval = spawnSync(
      process.execPath,
      [cli, "self-host-emit", sharedRemovalInput],
      { encoding: "utf8" },
    );
    assert.equal(sharedRemoval.status, 1);
    assert.match(
      sharedRemoval.stderr,
      /thread\.spawn cannot consume shared ARC capture snapshot/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("runs the Zapp worker and main-thread publication natively", () => {
  const directory = mkdtempSync("/tmp/z-self-host-zapp-");
  const input = resolve(
    projectRoot,
    "examples/applications/zapp-skeleton/main.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    // The worker frame hops its placed call to the main executor, which
    // `main` starts and drives while it waits.
    assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    assert.match(emission.stdout, /z_stage1_async_main_executor_start\(\);/);
    assert.match(emission.stdout, /z_stage1_sleep\(10\)/);

    const executable = resolve(directory, "zapp");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "Zapp: Ready after background job 1\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("transfers and discards owned native worker results exactly once", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-owned-result-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-owned-result.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /struct Z_Task_StringStorage/);
    assert.match(emission.stdout, /bool result_live;/);
    assert.match(emission.stdout, /storage->result_live = true;/);
    assert.match(
      emission.stdout,
      /Z_String result = storage->result;\n  storage->result_live = false;/,
    );
    assert.match(
      emission.stdout,
      /if \(task->storage->result_live\) \{ Z_String_deinit\(&task->storage->result\);/,
    );

    const executable = resolve(directory, "thread-owned-result");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const invalidInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-affine-result-invalid.zs",
    );
    const invalid = spawnSync(
      process.execPath,
      [cli, "self-host-emit", invalidInput],
      { encoding: "utf8" },
    );
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stderr,
      /error\[Z0704\]: thread\.spawn result type "AffineResource" cannot cross a native thread boundary yet/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("transfers a typed worker failure through attempt await", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-error-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-error.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /Z_Task___z_Result_i32_WorkErrorStorage/);
    assert.match(
      emission.stdout,
      /Z___z_Result_i32_WorkErrorTag_failure/,
    );
    assert.match(
      emission.stdout,
      /Z___z_Result_i32_WorkErrorTag_success/,
    );

    const executable = resolve(directory, "thread-error");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const ownedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-owned-error.zs",
    );
    const ownedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", ownedInput],
      { encoding: "utf8" },
    );
    assert.equal(ownedEmission.status, 0, ownedEmission.stderr);
    assert.match(
      ownedEmission.stdout,
      /if \(task->storage->result_live\) \{ Z___z_Result_String_OwnedError_deinit\(&task->storage->result\);/,
    );
    assert.match(
      ownedEmission.stdout,
      /case Z___z_Result_String_OwnedErrorTag_failure:[\s\S]*Z_OwnedError_deinit\(&self->payload\.failure\);/,
    );
    assert.match(
      ownedEmission.stdout,
      /case Z___z_Result_String_OwnedErrorTag_success:[\s\S]*Z_String_deinit\(&self->payload\.success\);/,
    );
    const ownedExecutable = resolve(directory, "thread-owned-error");
    const ownedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        ownedExecutable,
      ],
      { encoding: "utf8", input: ownedEmission.stdout },
    );
    assert.equal(ownedCompilation.status, 0, ownedCompilation.stderr);
    const ownedExecution = spawnSync(ownedExecutable, [], { encoding: "utf8" });
    assert.equal(ownedExecution.status, 0, ownedExecution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("cleans owned native worker locals across return and throw", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-owned-local-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-owned-local.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /bool _z_stage1_live_local = true;/);
    assert.match(emission.stdout, /bool _z_stage1_live_scratch = true;/);
    assert.match(emission.stdout, /bool _z_stage1_live_error = true;/);
    assert.match(
      emission.stdout,
      /\(_z_stage1_live_local = false, local\)/,
    );
    assert.match(
      emission.stdout,
      /\(_z_stage1_live_scratch = false, scratch\)/,
    );
    assert.match(
      emission.stdout,
      /\(_z_stage1_live_error = false, error\)/,
    );
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_scratch\) Z_String_deinit\(&scratch\);/,
    );
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_error\) Z_WorkError_deinit\(&error\);/,
    );

    const executable = resolve(directory, "thread-owned-local");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("transfers consumed worker captures into results and failures", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-capture-result-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-capture-result.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(emission.stdout, /bool _z_stage1_capture_live_0;/);
    assert.match(emission.stdout, /bool _z_stage1_capture_live_1;/);
    assert.match(
      emission.stdout,
      /worker_context->_z_stage1_capture_live_0 = true;/,
    );
    assert.match(
      emission.stdout,
      /if \(worker_context->_z_stage1_capture_live_0\) Z_String_deinit/,
    );
    assert.match(
      emission.stdout,
      /\(\*_z_stage1_capture_live_0\) = false/,
    );
    assert.match(
      emission.stdout,
      /\(\*_z_stage1_capture_live_1\) = false/,
    );
    assert.match(
      emission.stdout,
      /Z___z_Result_i32_WorkErrorTag_failure/,
    );
    assert.match(emission.stdout, /_z_stage1_live_directSource = false/);
    assert.match(emission.stdout, /_z_stage1_live_blockSource = false/);
    assert.match(emission.stdout, /_z_stage1_live_errorSource = false/);
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_directSource\) Z_String_deinit\(&directSource\);/,
    );
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_blockSource\) Z_String_deinit\(&blockSource\);/,
    );
    assert.match(
      emission.stdout,
      /if \(_z_stage1_live_errorSource\) Z_String_deinit\(&errorSource\);/,
    );
    assert.match(emission.stdout, /Z_Task_String_deinit\(&discarded\)/);

    const executable = resolve(directory, "thread-capture-result");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);

test("propagates an owned worker failure through native try await", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-try-await-");
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-try-await.zs",
  );
  try {
    const parity = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(parity.status, 0, parity.stderr);

    const emission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8" },
    );
    assert.equal(emission.status, 0, emission.stderr);
    assert.match(
      emission.stdout,
      /Z___z_Result_String_OwnedError _z_stage1_try_\d+ = Z_Task___z_Result_String_OwnedError_await/,
    );
    assert.match(
      emission.stdout,
      /Z___z_Result_i32_OwnedErrorTag_failure, \.payload = \{ \.failure = _z_stage1_try_\d+\.payload\.failure/,
    );
    assert.match(
      emission.stdout,
      /Z_String_deinit\(&value\);[\s\S]*Z_Task___z_Result_String_OwnedError_deinit\(&worker\);/,
    );

    const wrapped = `${emission.stdout}
#undef main
int main(void) {
  Z___z_Result_i32_OwnedError result = z_stage1_main_result();
  if (result.tag != Z___z_Result_i32_OwnedErrorTag_failure) {
    Z___z_Result_i32_OwnedError_deinit(&result);
    return 1;
  }
  const int status = result.payload.failure.message.length == 13 ? 0 : 2;
  Z___z_Result_i32_OwnedError_deinit(&result);
  return status;
}
`;
    const executable = resolve(directory, "thread-try-await");
    const compilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-Dmain=z_entry",
        "-",
        "-o",
        executable,
      ],
      { encoding: "utf8", input: wrapped },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);

    const positionsInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-try-await-positions.zs",
    );
    const positionsParity = spawnSync(
      process.execPath,
      [cli, "check", positionsInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(positionsParity.status, 0, positionsParity.stderr);
    const positionsEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", positionsInput],
      { encoding: "utf8" },
    );
    assert.equal(positionsEmission.status, 0, positionsEmission.stderr);
    assert.match(positionsEmission.stdout, /Z_String inferred;/);
    assert.match(
      positionsEmission.stdout,
      /Z___z_Result_String_WorkError _z_stage1_try_\d+ =/,
    );
    assert.match(
      positionsEmission.stdout,
      /Z___z_Result_i32_WorkError _z_stage1_return_\d+ = Z_Task___z_Result_i32_WorkError_await/,
    );
    const positionsWrapped = `${positionsEmission.stdout}
#undef main
int main(void) {
  Z___z_Result_i32_WorkError result = z_stage1_main_result();
  if (result.tag != Z___z_Result_i32_WorkErrorTag_success) {
    Z___z_Result_i32_WorkError_deinit(&result);
    return 1;
  }
  const int status = result.payload.success;
  Z___z_Result_i32_WorkError_deinit(&result);
  return status;
}
`;
    const positionsExecutable = resolve(directory, "thread-try-positions");
    const positionsCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-Dmain=z_entry",
        "-",
        "-o",
        positionsExecutable,
      ],
      { encoding: "utf8", input: positionsWrapped },
    );
    assert.equal(
      positionsCompilation.status,
      0,
      positionsCompilation.stderr,
    );
    const positionsExecution = spawnSync(positionsExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(positionsExecution.status, 0, positionsExecution.stderr);

    const nestedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-nested-try-await.zs",
    );
    const nestedParity = spawnSync(
      process.execPath,
      [cli, "check", nestedInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(nestedParity.status, 0, nestedParity.stderr);
    const nestedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", nestedInput],
      { encoding: "utf8" },
    );
    assert.equal(nestedEmission.status, 0, nestedEmission.stderr);
    const firstAwait = nestedEmission.stdout.indexOf(
      "Z_Task___z_Result_i32_WorkError_await(&(firstWorker))",
    );
    const secondAwait = nestedEmission.stdout.indexOf(
      "Z_Task___z_Result_i32_WorkError_await(&(secondWorker))",
    );
    assert.ok(firstAwait >= 0 && secondAwait > firstAwait);
    assert.match(
      nestedEmission.stdout,
      /measure\(&\(_z_stage1_nested_try_\d+\)\);\n  Z_String_deinit\(&_z_stage1_nested_try_\d+\);/,
    );
    const consumedCall = /consume\((_z_stage1_nested_try_\d+)\)/.exec(
      nestedEmission.stdout,
    );
    assert.ok(consumedCall);
    assert.doesNotMatch(
      nestedEmission.stdout,
      new RegExp(`Z_String_deinit\\(&${consumedCall[1]}\\)`),
    );
    const nestedWrapped = `${nestedEmission.stdout}
#undef main
int main(void) {
  Z___z_Result_i32_WorkError result = z_stage1_main_result();
  if (result.tag != Z___z_Result_i32_WorkErrorTag_success) {
    Z___z_Result_i32_WorkError_deinit(&result);
    return 1;
  }
  const int status = result.payload.success;
  Z___z_Result_i32_WorkError_deinit(&result);
  return status;
}
`;
    const nestedExecutable = resolve(directory, "thread-nested-try-await");
    const nestedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-Dmain=z_entry",
        "-",
        "-o",
        nestedExecutable,
      ],
      { encoding: "utf8", input: nestedWrapped },
    );
    assert.equal(nestedCompilation.status, 0, nestedCompilation.stderr);
    const nestedExecution = spawnSync(nestedExecutable, [], {
      encoding: "utf8",
    });
    assert.equal(nestedExecution.status, 0, nestedExecution.stderr);

    const nestedFailureInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-nested-try-await-failure.zs",
    );
    const nestedFailureEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", nestedFailureInput],
      { encoding: "utf8" },
    );
    assert.equal(
      nestedFailureEmission.status,
      0,
      nestedFailureEmission.stderr,
    );
    const nestedFailureWrapped = `${nestedFailureEmission.stdout}
#undef main
int main(void) {
  Z___z_Result_i32_WorkError result = z_stage1_main_result();
  if (result.tag != Z___z_Result_i32_WorkErrorTag_failure) {
    Z___z_Result_i32_WorkError_deinit(&result);
    return 1;
  }
  const int valid = z_string_equal(
    result.payload.failure.message,
    Z_STRING_LITERAL("selected failure")
  ) ? 0 : 2;
  Z___z_Result_i32_WorkError_deinit(&result);
  return valid;
}
`;
    const nestedFailureExecutable = resolve(
      directory,
      "thread-nested-try-await-failure",
    );
    const nestedFailureCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-Dmain=z_entry",
        "-",
        "-o",
        nestedFailureExecutable,
      ],
      { encoding: "utf8", input: nestedFailureWrapped },
    );
    assert.equal(
      nestedFailureCompilation.status,
      0,
      nestedFailureCompilation.stderr,
    );
    const nestedFailureExecution = spawnSync(
      nestedFailureExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      nestedFailureExecution.status,
      0,
      nestedFailureExecution.stderr,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("returns scalar, owned, and typed-error values through native thread.main placement", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-main-result-");
  const fixtures = [
    "self-host-emit-thread-main-result.zs",
    "self-host-emit-thread-main-owned.zs",
    "self-host-emit-thread-main-error.zs",
  ];
  try {
    for (const fixture of fixtures) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      // The worker frame hops its placed call to main, where the callee runs
      // on its own async tier.
      assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);

      const executable = resolve(directory, fixture.replace(/\.zs$/, ""));
      const compilation = spawnSync(
        "clang",
        [
          "-x",
          "c",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          "-",
          "-o",
          executable,
        ],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }

    const synchronousInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-synchronous.zs",
    );
    const synchronousEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", synchronousInput],
      { encoding: "utf8" },
    );
    assert.equal(synchronousEmission.status, 0, synchronousEmission.stderr);
    // A synchronous placed callee runs in a lifted frame hopped to main.
    assert.match(synchronousEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    const synchronousExecutable = resolve(directory, "thread-main-sync");
    const synchronousCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        synchronousExecutable,
      ],
      { encoding: "utf8", input: synchronousEmission.stdout },
    );
    assert.equal(
      synchronousCompilation.status,
      0,
      synchronousCompilation.stderr,
    );
    const synchronousExecution = spawnSync(
      synchronousExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      synchronousExecution.status,
      0,
      synchronousExecution.stderr,
    );

    const unplacedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-inherited-async.zs",
    );
    const unplacedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", unplacedInput],
      { encoding: "utf8" },
    );
    assert.equal(
      unplacedEmission.status,
      0,
      unplacedEmission.stderr,
    );
    const unplacedExecutable = resolve(directory, "thread-main-inherited");
    const unplacedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        unplacedExecutable,
      ],
      { encoding: "utf8", input: unplacedEmission.stdout },
    );
    assert.equal(
      unplacedCompilation.status,
      0,
      unplacedCompilation.stderr,
    );
    const unplacedExecution = spawnSync(
      unplacedExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      unplacedExecution.status,
      0,
      unplacedExecution.stderr,
    );

    const segmentsInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-segments.zs",
    );
    const segmentsParity = spawnSync(
      process.execPath,
      [cli, "check", segmentsInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(segmentsParity.status, 0, segmentsParity.stderr);
    const segmentsEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", segmentsInput],
      { encoding: "utf8" },
    );
    assert.equal(segmentsEmission.status, 0, segmentsEmission.stderr);
    // The callee's delays run on the main executor's timers, inside the hop.
    assert.match(segmentsEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    assert.match(segmentsEmission.stdout, /z_stage1_async_schedule_delay\(task, 1\)/);
    const segmentsExecutable = resolve(directory, "thread-main-segments");
    const segmentsCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        segmentsExecutable,
      ],
      { encoding: "utf8", input: segmentsEmission.stdout },
    );
    assert.equal(
      segmentsCompilation.status,
      0,
      segmentsCompilation.stderr,
    );
    const segmentsExecution = spawnSync(
      segmentsExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(segmentsExecution.status, 0, segmentsExecution.stderr);
    assert.equal(
      segmentsExecution.stdout,
      "main segment 1: 0\nmain segment 2: 0\n",
    );

    for (const fixture of [
      "self-host-emit-thread-main-locals.zs",
      "self-host-emit-thread-main-owned-local.zs",
    ]) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);
      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      // The callee's locals live in its async frame on main, inside the hop.
      assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
      const executable = resolve(directory, fixture.replace(/\.zs$/, ""));
      const compilation = spawnSync(
        "clang",
        [
          "-x",
          "c",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          "-",
          "-o",
          executable,
        ],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
    }

    const structuredIfInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-if.zs",
    );
    const structuredIfParity = spawnSync(
      process.execPath,
      [cli, "check", structuredIfInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(structuredIfParity.status, 0, structuredIfParity.stderr);
    const structuredIfEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", structuredIfInput],
      { encoding: "utf8" },
    );
    assert.equal(structuredIfEmission.status, 0, structuredIfEmission.stderr);
    // The callee's suspending `if` runs in its general frame, hopped to main.
    assert.match(structuredIfEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    assert.doesNotMatch(structuredIfEmission.stdout, /bool branch_0;/);
    const structuredIfExecutable = resolve(directory, "thread-main-if");
    const structuredIfCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        structuredIfExecutable,
      ],
      { encoding: "utf8", input: structuredIfEmission.stdout },
    );
    assert.equal(
      structuredIfCompilation.status,
      0,
      structuredIfCompilation.stderr,
    );
    const structuredIfExecution = spawnSync(
      structuredIfExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredIfExecution.status,
      0,
      structuredIfExecution.stderr,
    );

    const structuredIfOwnedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-if-owned.zs",
    );
    const structuredIfOwnedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", structuredIfOwnedInput],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredIfOwnedEmission.status,
      0,
      structuredIfOwnedEmission.stderr,
    );
    // The callee's owned branch local lives in its general frame, hopped to main.
    assert.match(structuredIfOwnedEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    const structuredIfOwnedExecutable = resolve(
      directory,
      "thread-main-if-owned",
    );
    const structuredIfOwnedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        structuredIfOwnedExecutable,
      ],
      { encoding: "utf8", input: structuredIfOwnedEmission.stdout },
    );
    assert.equal(
      structuredIfOwnedCompilation.status,
      0,
      structuredIfOwnedCompilation.stderr,
    );
    const structuredIfOwnedExecution = spawnSync(
      structuredIfOwnedExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredIfOwnedExecution.status,
      0,
      structuredIfOwnedExecution.stderr,
    );
    assert.equal(structuredIfOwnedExecution.stdout, "released branch 42\n");

    const structuredMatchInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-match.zs",
    );
    const structuredMatchParity = spawnSync(
      process.execPath,
      [cli, "check", structuredMatchInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(structuredMatchParity.status, 0, structuredMatchParity.stderr);
    const structuredMatchEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", structuredMatchInput],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchEmission.status,
      0,
      structuredMatchEmission.stderr,
    );
    // The callee's suspending `match` runs in its general frame, hopped to main.
    assert.match(structuredMatchEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    assert.doesNotMatch(structuredMatchEmission.stdout, /size_t arm_0;/);
    const structuredMatchExecutable = resolve(directory, "thread-main-match");
    const structuredMatchCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        structuredMatchExecutable,
      ],
      { encoding: "utf8", input: structuredMatchEmission.stdout },
    );
    assert.equal(
      structuredMatchCompilation.status,
      0,
      structuredMatchCompilation.stderr,
    );
    const structuredMatchExecution = spawnSync(
      structuredMatchExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchExecution.status,
      0,
      structuredMatchExecution.stderr,
    );

    const structuredMatchPayloadInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-match-payload.zs",
    );
    const structuredMatchPayloadParity = spawnSync(
      process.execPath,
      [cli, "check", structuredMatchPayloadInput, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchPayloadParity.status,
      0,
      structuredMatchPayloadParity.stderr,
    );
    const structuredMatchPayloadEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", structuredMatchPayloadInput],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchPayloadEmission.status,
      0,
      structuredMatchPayloadEmission.stderr,
    );
    // The callee's payload match runs in its general frame, hopped to main.
    assert.match(structuredMatchPayloadEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    const structuredMatchPayloadExecutable = resolve(
      directory,
      "thread-main-match-payload",
    );
    const structuredMatchPayloadCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        structuredMatchPayloadExecutable,
      ],
      { encoding: "utf8", input: structuredMatchPayloadEmission.stdout },
    );
    assert.equal(
      structuredMatchPayloadCompilation.status,
      0,
      structuredMatchPayloadCompilation.stderr,
    );
    const structuredMatchPayloadExecution = spawnSync(
      structuredMatchPayloadExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchPayloadExecution.status,
      0,
      structuredMatchPayloadExecution.stderr,
    );

    const structuredMatchOwnedInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-emit-thread-main-match-owned.zs",
    );
    const structuredMatchOwnedEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", structuredMatchOwnedInput],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchOwnedEmission.status,
      0,
      structuredMatchOwnedEmission.stderr,
    );
    // The callee's owned match subject lives in its general frame, hopped to main.
    assert.match(structuredMatchOwnedEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
    const structuredMatchOwnedExecutable = resolve(
      directory,
      "thread-main-match-owned",
    );
    const structuredMatchOwnedCompilation = spawnSync(
      "clang",
      [
        "-x",
        "c",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "-",
        "-o",
        structuredMatchOwnedExecutable,
      ],
      { encoding: "utf8", input: structuredMatchOwnedEmission.stdout },
    );
    assert.equal(
      structuredMatchOwnedCompilation.status,
      0,
      structuredMatchOwnedCompilation.stderr,
    );
    const structuredMatchOwnedExecution = spawnSync(
      structuredMatchOwnedExecutable,
      [],
      { encoding: "utf8" },
    );
    assert.equal(
      structuredMatchOwnedExecution.status,
      0,
      structuredMatchOwnedExecution.stderr,
    );
    assert.equal(
      structuredMatchOwnedExecution.stdout,
      "released match branch 42\n",
    );

    for (const [fixture, executableName, expectedOutput] of [
      [
        "self-host-emit-thread-main-match-owned-payload.zs",
        "thread-main-match-owned-payload",
        "",
      ],
      [
        "self-host-emit-thread-main-match-owned-error.zs",
        "thread-main-match-owned-error",
        "released failed match payload 42\n",
      ],
      [
        "self-host-emit-thread-main-match-computed-payload.zs",
        "thread-main-match-computed-payload",
        "released computed match payload 42\n",
      ],
      [
        "self-host-emit-thread-main-match-computed-constructor.zs",
        "thread-main-match-computed-constructor",
        "",
      ],
    ] as const) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);
      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      // Owned match payloads live in the callee's general frame, hopped to main.
      assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
      const executable = resolve(directory, executableName);
      const compilation = spawnSync(
        "clang",
        [
          "-x",
          "c",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          "-",
          "-o",
          executable,
        ],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, expectedOutput);
    }

    for (const [fixture, diagnostic] of [
      [
        "self-host-emit-thread-main-uninitialized-local-invalid.zs",
        /requires local staged to be initialized before it crosses a suspension/,
      ],
    ] as const) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 1);
      assert.match(emission.stderr, diagnostic);
    }

    for (const [fixture, line] of [
      ["self-host-emit-thread-main-match-payload-invalid.zs", 16],
      ["self-host-borrowed-match-scalar-suspension-invalid.zs", 11],
      ["self-host-borrowed-match-expression-suspension-invalid.zs", 11],
    ] as const) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const stage0Diagnostic = diagnostics(
        readFileSync(input, "utf8"),
        input,
      )[0];
      assert.equal(stage0Diagnostic?.code, "Z0704");
      assert.match(
        stage0Diagnostic?.message ?? "",
        /cannot await while borrowed storage "(?:route|mode)" is live/,
      );
      const resolution = spawnSync(
        process.execPath,
        [cli, "self-host-resolve", input],
        { encoding: "utf8" },
      );
      assert.equal(resolution.status, 1);
      assert.match(
        resolution.stderr,
        new RegExp(`:${line}:7: error\\[Z0704\\]: cannot await while borrowed storage \\"(?:route|mode)\\" is live`),
      );
    }

    const generatorBorrowInput = resolve(
      projectRoot,
      "tests/fixtures/self-host-async-generator-borrowed-match.zs",
    );
    assert.doesNotThrow(() => check(
      readFileSync(generatorBorrowInput, "utf8"),
      generatorBorrowInput,
    ));
    const generatorBorrowResolution = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", generatorBorrowInput],
      { encoding: "utf8" },
    );
    assert.equal(
      generatorBorrowResolution.status,
      0,
      generatorBorrowResolution.stderr,
    );

    // A worker frame with a suspension inside an `if`, or a non-tail placed
    // call, hops to main, as does a worker awaiting a main-affine callee that
    // returns early ahead of its delay; all run as in Stage 0.
    for (const [fixture, status] of [
      ["self-host-emit-thread-main-control-flow-suspension.zs", 42],
      ["self-host-emit-thread-main-nested-if-suspension.zs", 42],
      ["self-host-emit-thread-main-nontail-suspension.zs", 0],
    ] as const) {
      const hopInput = resolve(projectRoot, "tests/fixtures", fixture);
      const hopEmission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", hopInput],
        { encoding: "utf8" },
      );
      assert.equal(hopEmission.status, 0, hopEmission.stderr);
      assert.match(hopEmission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
      const hopExecutable = resolve(directory, fixture.replace(/\.zs$/, ""));
      const hopCompilation = spawnSync(
        "clang",
        ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", hopExecutable],
        { encoding: "utf8", input: hopEmission.stdout },
      );
      assert.equal(hopCompilation.status, 0, hopCompilation.stderr);
      const hopExecution = spawnSync(hopExecutable, [], { encoding: "utf8" });
      assert.equal(hopExecution.status, status, hopExecution.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);

test("preserves while iteration, loop control, and owned locals across main suspension", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-main-while-");
  // Each callee's suspending loop runs in its general frame, hopped to main:
  // loop control, owned iteration locals, and `try` inside the loop.
  const fixtures = [
    ["self-host-emit-thread-main-while.zs", ""],
    ["self-host-emit-thread-main-while-control.zs", ""],
    [
      "self-host-emit-thread-main-while-owned.zs",
      "released iteration 1\nreleased iteration 2\nreleased iteration 3\nreleased iteration 4\n",
    ],
    [
      "self-host-emit-thread-main-while-return.zs",
      "released return iteration 1\nreleased return iteration 1\nreleased return iteration 2\n",
    ],
    [
      "self-host-emit-thread-main-while-throw.zs",
      "released throw iteration 1\nreleased throw iteration 2\n",
    ],
    [
      "self-host-emit-thread-main-while-try.zs",
      "released try iteration 1\nreleased try iteration 2\nreleased try iteration 1\nreleased try iteration 1\nreleased try iteration 2\n",
    ],
  ] as const;
  try {
    for (const [fixture, expectedOutput] of fixtures) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
      if (fixture.endsWith("-try.zs")) {
        // A `try` assigned over an owned frame local destroys the old value
        // while it is live.
        assert.match(
          emission.stdout,
          /if \(_z_stage1_live_replacement\) Z_String_deinit\(&_z_stage1_frame_binding_replacement\);/,
        );
      }

      const executable = resolve(directory, fixture.replace(/\.zs$/, ""));
      const compilation = spawnSync(
        "clang",
        [
          "-x",
          "c",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          "-",
          "-o",
          executable,
        ],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(execution.stdout, expectedOutput);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);

test("requests native worker cancellation and joins owned cleanup", () => {
  const directory = mkdtempSync("/tmp/z-self-host-thread-cancel-");
  const fixtures = [
    "self-host-emit-thread-cancel.zs",
    "self-host-emit-thread-cancel-main.zs",
    "self-host-emit-thread-cancel-main-match.zs",
    "self-host-emit-thread-cancel-main-while.zs",
  ];
  try {
    for (const fixture of fixtures) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const parity = spawnSync(
        process.execPath,
        [cli, "check", input, "--native-frontend"],
        { encoding: "utf8" },
      );
      assert.equal(parity.status, 0, parity.stderr);

      const emission = spawnSync(
        process.execPath,
        [cli, "self-host-emit", input],
        { encoding: "utf8" },
      );
      assert.equal(emission.status, 0, emission.stderr);
      assert.match(emission.stdout, /bool cancellation_requested;/);
      assert.match(emission.stdout, /_is_cancellation_requested\(/);
      assert.match(emission.stdout, /storage->cancellation_requested = true;/);
      assert.match(emission.stdout, /_cancel\(&\(worker\)\);/);
      if (
        !fixture.endsWith("-match.zs")
        && !fixture.endsWith("-while.zs")
      ) {
        assert.match(
          emission.stdout,
          /if \(task->storage->result_live\) \{ Z_.*_deinit\(&task->storage->result\); task->storage->result_live = false; \}/,
        );
      }

      if (fixture.includes("thread-cancel-main")) {
        // The callee takes the general frame: the worker frame hops to it,
        // and cancelling the worker cancels the hopped frame on main.
        assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
        assert.match(emission.stdout, /z_stage1_async_cancel_from_thread\(hop->target, hop->child\.task\)/);
        assert.match(emission.stdout, /z_stage1_sleep\(10\);/);
      }

      const executable = resolve(directory, fixture.replace(/\.zs$/, ""));
      const compilation = spawnSync(
        "clang",
        [
          "-x",
          "c",
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          "-",
          "-o",
          executable,
        ],
        { encoding: "utf8", input: emission.stdout },
      );
      assert.equal(compilation.status, 0, compilation.stderr);
      const execution = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(execution.status, 0, execution.stderr);
      if (fixture == "self-host-emit-thread-cancel-main.zs") {
        assert.equal(
          execution.stdout,
          "entered main segment\nreleased pending main request\n",
        );
      }
      if (fixture == "self-host-emit-thread-cancel-main-match.zs") {
        assert.equal(
          execution.stdout,
          "entered match main segment\nreleased match payload frame\n",
        );
      }
      if (fixture == "self-host-emit-thread-cancel-main-while.zs") {
        assert.equal(
          execution.stdout,
          "entered loop main segment\nreleased loop frame 1\n",
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("lowers filesystem lock ownership through the native frontend", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-fs-lock.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct Z_FsLock/);
  assert.match(emission.stdout, /z_stage1_fs_lock/);
  assert.match(
    emission.stdout,
    /Z_FsLock_deinit\(&\(lock\)\);\n  return/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /Z_FsLock_deinit\(&\(lock\)\);[\s\S]*Z_FsLock_deinit\(&lock\)/,
  );

  const directory = mkdtempSync("/tmp/z-self-host-fs-lock-");
  const executable = resolve(directory, "fs-lock");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
});

test("allocates and reversely cleans Arena values through the native frontend", () => {
  const input = resolve(
    projectRoot,
    "examples/language/ownership/arena.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct Z_Arena/);
  assert.match(emission.stdout, /z_stage1_arena_create_\d+_ParsedRecord/);
  assert.match(emission.stdout, /z_stage1_arena_register_cleanup/);
  assert.match(emission.stdout, /z_stage1_arena_reset\(&\(scratch\)\)/);

  const directory = mkdtempSync("/tmp/z-self-host-arena-");
  const executable = resolve(directory, "arena");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(
    execution.stdout,
    [
      "record 20 came from line 1",
      "record 22 came from line 8",
      "released record 22",
      "released record 20",
      "record 42 came from line 12",
      "released record 42",
      "",
    ].join("\n"),
  );

  const managedInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-arena.zs",
  );
  const managedParity = spawnSync(
    process.execPath,
    [cli, "check", managedInput, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(managedParity.status, 0, managedParity.stderr);
  const managedEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", managedInput],
    { encoding: "utf8" },
  );
  assert.equal(managedEmission.status, 0, managedEmission.stderr);
  assert.match(managedEmission.stdout, /Z_Arena scratch = z_stage1_arena_new/);
  assert.match(
    managedEmission.stdout,
    /z_stage1_arena_create_\d+_ScratchBatch/,
  );
  assert.match(managedEmission.stdout, /Z_ScratchBatch_deinit/);
  assert.doesNotMatch(managedEmission.stdout, /Z___z_Array_i32_deinit\(&values\)/);
  assert.match(
    managedEmission.stdout,
    /void _z_function_\d+_finish\(Z_Arena region\) \{\n  \(void\)region;\n  Z_Arena_deinit\(&region\);/,
  );
  assert.match(managedEmission.stdout, /finish\(scratch\);/);
  assert.doesNotMatch(managedEmission.stdout, /Z_Arena_deinit\(&scratch\)/);

  const managedExecutable = resolve(directory, "managed-arena");
  const managedCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      managedExecutable,
    ],
    { encoding: "utf8", input: managedEmission.stdout },
  );
  assert.equal(managedCompilation.status, 0, managedCompilation.stderr);
  const managedExecution = spawnSync(
    managedExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(managedExecution.status, 0, managedExecution.stderr);
  assert.equal(
    managedExecution.stdout,
    "compiler scratch: 42\n"
      + "released compiler scratch\n"
      + "released identity 7\n",
  );

  const pressureInput = resolve(
    projectRoot,
    "examples/applications/source-inspector/arena-smoke.zs",
  );
  const pressureEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", pressureInput],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(pressureEmission.status, 0, pressureEmission.stderr);
  assert.match(
    pressureEmission.stdout,
    /z_stage1_arena_create_\d+_TokenCoordinate/,
  );
  const coordinateHelper = pressureEmission.stdout.match(
    /static inline[^\n]*const Z_TokenCoordinate \*z_stage1_arena_create_\d+_TokenCoordinate\([^]*?\n}\n/,
  )?.[0] ?? "";
  assert.notEqual(coordinateHelper, "");
  assert.doesNotMatch(coordinateHelper, /z_stage1_arena_register_cleanup/);

  const pressureExecutable = resolve(directory, "arena-source-inspector");
  const pressureCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      pressureExecutable,
    ],
    { encoding: "utf8", input: pressureEmission.stdout },
  );
  assert.equal(pressureCompilation.status, 0, pressureCompilation.stderr);
  const pressureExecution = spawnSync(
    pressureExecutable,
    [],
    { encoding: "utf8", cwd: projectRoot },
  );
  assert.equal(pressureExecution.status, 0, pressureExecution.stderr);
  assert.match(
    pressureExecution.stdout,
    /^inspected \d+ compiler tokens with checksum \d+\n$/,
  );

  const graphInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-arena-graph.zs",
  );
  const graphParity = spawnSync(
    process.execPath,
    [cli, "check", graphInput, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(graphParity.status, 0, graphParity.stderr);
  const ownerlessJoinInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-check-arena-ownerless-joins.zs",
  );
  const ownerlessJoinParity = spawnSync(
    process.execPath,
    [cli, "check", ownerlessJoinInput, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(ownerlessJoinParity.status, 0, ownerlessJoinParity.stderr);
  const graphEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", graphInput],
    { encoding: "utf8" },
  );
  assert.equal(graphEmission.status, 0, graphEmission.stderr);
  assert.match(
    graphEmission.stdout,
    /typedef struct Z_TokenSpan \{\n  Z_TokenCoordinate const \* first;\n  Z_TokenCoordinate const \* last;/,
  );
  assert.match(
    graphEmission.stdout,
    /const Z_TokenCoordinate \* const first = \(\*span\)\.first;/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Array_TokenSpan_from\(/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Array_TokenSpan_push\(&\(pendingSpans\), pending\)/,
  );
  assert.match(
    graphEmission.stdout,
    /typedef Z_LinkedNode const \* Z___z_NicheViewOption_LinkedNode;/,
  );
  assert.match(
    graphEmission.stdout,
    /Z_LinkedNode linkedTailPending = \(Z_LinkedNode\)\{\.value = 22, \.next = NULL\};/,
  );
  assert.match(
    graphEmission.stdout,
    /Z_LinkedNode linkedHeadPending = \(Z_LinkedNode\)\{\.value = 20, \.next = linkedTail\};/,
  );
  assert.doesNotMatch(
    graphEmission.stdout,
    /Z___z_NicheViewOption_LinkedNodeTag/,
  );
  assert.match(
    graphEmission.stdout,
    /struct Z___z_Map_6_StringLinkedNode_Entry \{\n  Z_String key;\n  Z_LinkedNode value;/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Map_6_StringLinkedNode_get\(storedLinks, Z_STRING_LITERAL\("stored"\)\)/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Option_LinkedNode Z___z_Map_6_StringLinkedNode_remove/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Map_6_StringLinkedNode_remove\(&\(linkedByName\), Z_STRING_LITERAL\("compiler"\)\)/,
  );
  assert.match(
    graphEmission.stdout,
    /z_stage1_arena_create_\d+___z_Option_LinkedNode/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Map_6_StringLinkedNode_delete\(&\(linkedByName\), Z_STRING_LITERAL\("retained"\)\)/,
  );
  assert.match(
    graphEmission.stdout,
    /Z___z_Map_6_StringLinkedNode_clear\(&\(linkedByName\)\)/,
  );
  const namedMapDelete = graphEmission.stdout.match(
    /static __attribute__\(\(unused\)\) bool Z___z_Map_6_StringNamedTokenSpan_delete[^]*?\n\}/,
  )?.[0] ?? "";
  assert.match(namedMapDelete, /Z_NamedTokenSpan_deinit\(&self->entries\[entry\]\.value\)/);
  const namedMapClear = graphEmission.stdout.match(
    /static __attribute__\(\(unused\)\) void Z___z_Map_6_StringNamedTokenSpan_clear[^]*?\n\}/,
  )?.[0] ?? "";
  assert.match(namedMapClear, /Z_NamedTokenSpan_deinit\(&self->entries\[self->length\]\.value\)/);
  assert.match(namedMapClear, /memset\(self->buckets, 0, self->bucketCount \* sizeof\(size_t\)\)/);
  assert.match(
    graphEmission.stdout,
    /z_stage1_arena_create_\d+___z_Map_6_StringLinkedNode/,
  );
  const namedDestructor = graphEmission.stdout.match(
    /static __attribute__\(\(unused\)\) void Z_NamedTokenSpan_deinit\(Z_NamedTokenSpan \*self\) \{[^]*?\n\}/,
  )?.[0] ?? "";
  assert.notEqual(namedDestructor, "");
  assert.match(namedDestructor, /Z_String_deinit\(&self->name\)/);
  assert.doesNotMatch(namedDestructor, /self->span/);
  assert.match(
    graphEmission.stdout,
    /_z_stage1_live_namedPending = false, namedPending/,
  );
  assert.match(
    graphEmission.stdout,
    /if \(_z_stage1_live_namedPending\) Z_NamedTokenSpan_deinit\(&namedPending\)/,
  );
  const graphExecutable = resolve(directory, "arena-graph");
  const graphCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      graphExecutable,
    ],
    { encoding: "utf8", input: graphEmission.stdout },
  );
  assert.equal(graphCompilation.status, 0, graphCompilation.stderr);
  const graphExecution = spawnSync(
    graphExecutable,
    [],
    { encoding: "utf8" },
  );
  assert.equal(graphExecution.status, 0, graphExecution.stderr);
  assert.equal(graphExecution.stdout, "stored arena span 42\n");

  const bundleInput = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-arena-owner-bundle.zs",
  );
  const bundleEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", bundleInput],
    { encoding: "utf8" },
  );
  assert.equal(bundleEmission.status, 0, bundleEmission.stderr);
  assert.match(bundleEmission.stdout, /return \(Z_ParsedFile\)\{\.arena = arena, \.roots = roots\};/);
  assert.doesNotMatch(bundleEmission.stdout, /malloc\(sizeof\(Z_ParsedFile\)\)/);
  const bundleDestructor = bundleEmission.stdout.match(
    /static __attribute__\(\(unused\)\) void Z_ParsedFile_deinit\(Z_ParsedFile \*self\) \{[^]*?\n\}/,
  )?.[0] ?? "";
  assert.notEqual(bundleDestructor, "");
  assert.ok(
    bundleDestructor.indexOf("Z___z_Array_NodeRef_deinit(&self->roots)")
      < bundleDestructor.indexOf("Z_Arena_deinit(&self->arena)"),
  );

  const invalidCases = [
    {
      name: "arena-owner-bundle-mutable",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct ItemRef { item: view Item; }",
        "struct Bundle { arena: Arena; roots: Array<ItemRef>; }",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /must be a readonly struct/,
    },
    {
      name: "arena-owner-bundle-wrong-owner",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct ItemRef { item: view Item; }",
        "readonly struct Bundle { arena: Arena; roots: Array<ItemRef>; }",
        "function build(): Bundle {",
        "  let arena = Arena();",
        "  let other = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  const roots = Array<ItemRef>(ItemRef({ item }));",
        "  return Bundle({ arena: move other, roots: move roots });",
        "}",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /must borrow from the moved Arena "other"/,
    },
    {
      name: "arena-owner-bundle-stale-view",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct ItemRef { item: view Item; }",
        "readonly struct Bundle { arena: Arena; roots: Array<ItemRef>; }",
        "function build(): Bundle {",
        "  let arena = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  const roots = Array<ItemRef>(ItemRef({ item }));",
        "  const bundle = Bundle({ arena: move arena, roots: move roots });",
        "  const invalid = item.value;",
        "  return bundle;",
        "}",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /use of moved value "item"/,
    },
    {
      name: "arena-live-reset",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  arena.reset();",
        "  return item.value;",
        "}",
        "",
      ].join("\n"),
      expected: /cannot reset Arena "arena" while view "item" is live/,
    },
    {
      name: "arena-immutable",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "function main(): i32 {",
        "  const arena = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  return item.value;",
        "}",
        "",
      ].join("\n"),
      expected: /Arena\.create requires addressable let storage/,
    },
    {
      name: "arena-async",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "async function main(): i32 {",
        "  let arena = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  return item.value;",
        "}",
        "",
      ].join("\n"),
      expected: /Arena access cannot cross suspension/,
    },
    {
      name: "arena-class-root",
      source: [
        'import { Arena } from "std/memory";',
        "class Session { id: i32; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const session = arena.create(new Session({ id: 42 }));",
        "  return session.id;",
        "}",
        "",
      ].join("\n"),
      expected: /Arena\.create does not directly root reference-identity objects/,
    },
    {
      name: "arena-local-view-return",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "function leak(): view Item {",
        "  let arena = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  return item;",
        "}",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /parameter-provenanced view must return an immutable input/,
    },
    {
      name: "arena-nested-region",
      source: [
        'import { Arena as Region } from "std/memory";',
        "function main(): i32 {",
        "  let outer = Region();",
        "  let inner = Region();",
        "  const nested = outer.create(inner);",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /Arena\.create cannot store Region/,
    },
    {
      name: "arena-stored-view-wrong-region",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let source = Arena();",
        "  let destination = Arena();",
        "  const first = source.create(Item({ value: 20 }));",
        "  const last = source.create(Item({ value: 22 }));",
        "  const pending = Pair({ first, last });",
        "  const stored = destination.create(pending);",
        "  return stored.first.value;",
        "}",
        "",
      ].join("\n"),
      expected: /only in the Arena that owns every embedded view/,
    },
    {
      name: "arena-stored-view-copy",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const first = arena.create(Item({ value: 20 }));",
        "  const last = arena.create(Item({ value: 22 }));",
        "  const pending = Pair({ first, last });",
        "  const copied = pending;",
        "  const stored = arena.create(pending);",
        "  return stored.first.value + copied.last.value;",
        "}",
        "",
      ].join("\n"),
      expected: /view-bearing value "pending" cannot be copied/,
    },
    {
      name: "arena-stored-array-empty",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const pending = Array<Pair>();",
        "  const stored = arena.create(pending);",
        "  return i32(stored.length);",
        "}",
        "",
      ].join("\n"),
      expected: /empty view-bearing Array must use let/,
    },
    {
      name: "arena-stored-array-mixed",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const last = secondArena.create(Item({ value: 22 }));",
        "  const pending = Array<Pair>(Pair({ first, last }));",
        "  return i32(pending.length);",
        "}",
        "",
      ].join("\n"),
      expected: /must borrow from exactly one owner/,
    },
    {
      name: "arena-stored-map-empty",
      source: [
        'import { Map } from "std/collections";',
        "struct Item { value: i32; }",
        "struct Link { item: view Item; }",
        "function main(): i32 {",
        "  const links = Map<String, Link>();",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /empty view-bearing Map must use let/,
    },
    {
      name: "arena-stored-map-mixed",
      source: [
        'import { Map } from "std/collections";',
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Link { item: view Item; }",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const second = secondArena.create(Item({ value: 22 }));",
        "  let links = Map<String, Link>();",
        '  links.set("first", Link({ item: first }));',
        '  links.set("second", Link({ item: second }));',
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /already carries provenance from another Arena/,
    },
    {
      name: "arena-stored-map-wrong-region",
      source: [
        'import { Map } from "std/collections";',
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Link { item: view Item; }",
        "function main(): i32 {",
        "  let source = Arena();",
        "  let destination = Arena();",
        "  const item = source.create(Item({ value: 42 }));",
        "  let links = Map<String, Link>();",
        '  links.set("item", Link({ item }));',
        "  const stored = destination.create(links);",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /only in the Arena that owns every embedded view/,
    },
    {
      name: "arena-stored-array-wrong-region",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let source = Arena();",
        "  let destination = Arena();",
        "  const first = source.create(Item({ value: 20 }));",
        "  const last = source.create(Item({ value: 22 }));",
        "  const pending = Pair({ first, last });",
        "  const pendingPairs = Array<Pair>(pending);",
        "  const stored = destination.create(pendingPairs);",
        "  return i32(stored.length);",
        "}",
        "",
      ].join("\n"),
      expected: /only in the Arena that owns every embedded view/,
    },
    {
      name: "arena-stored-array-element-reuse",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const first = arena.create(Item({ value: 20 }));",
        "  const last = arena.create(Item({ value: 22 }));",
        "  const pending = Pair({ first, last });",
        "  const pendingPairs = Array<Pair>(pending);",
        "  return pending.first.value + i32(pendingPairs.length);",
        "}",
        "",
      ].join("\n"),
      expected: /(?:moved value "pending"|value "pending" was moved)/,
    },
    {
      name: "arena-stored-array-push-wrong-owner",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const last = firstArena.create(Item({ value: 22 }));",
        "  let pendingPairs = Array<Pair>();",
        "  pendingPairs.push(Pair({ first, last }));",
        "  const otherFirst = secondArena.create(Item({ value: 1 }));",
        "  const otherLast = secondArena.create(Item({ value: 2 }));",
        "  pendingPairs.push(Pair({ first: otherFirst, last: otherLast }));",
        "  return i32(pendingPairs.length);",
        "}",
        "",
      ].join("\n"),
      expected: /already carries provenance from another Arena/,
    },
    {
      name: "arena-stored-array-conditional-first-push",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const first = arena.create(Item({ value: 20 }));",
        "  const last = arena.create(Item({ value: 22 }));",
        "  let pendingPairs = Array<Pair>();",
        "  if (true) pendingPairs.push(Pair({ first, last }));",
        "  return i32(pendingPairs.length);",
        "}",
        "",
      ].join("\n"),
      expected: /same Arena provenance on every continuing path/,
    },
    {
      name: "arena-stored-array-loop-first-push",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  const first = arena.create(Item({ value: 20 }));",
        "  const last = arena.create(Item({ value: 22 }));",
        "  let pendingPairs = Array<Pair>();",
        "  while (pendingPairs.length == 0) {",
        "    pendingPairs.push(Pair({ first, last }));",
        "  }",
        "  return i32(pendingPairs.length);",
        "}",
        "",
      ].join("\n"),
      expected: /first push.*cannot occur in a loop/,
    },
    {
      name: "arena-stored-array-mixed-branch-owners",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Pair { first: view Item; last: view Item; }",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const second = secondArena.create(Item({ value: 22 }));",
        "  let pendingPairs = Array<Pair>();",
        "  if (true) {",
        "    pendingPairs.push(Pair({ first, last: first }));",
        "  } else {",
        "    pendingPairs.push(Pair({ first: second, last: second }));",
        "  }",
        "  return i32(pendingPairs.length);",
        "}",
        "",
      ].join("\n"),
      expected: /same Arena provenance on every continuing path/,
    },
    {
      name: "arena-stored-view-class",
      source: [
        "struct Item { value: i32; }",
        "class Holder { item: view Item; }",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /ARC class fields cannot store owner-tied views/,
    },
    {
      name: "arena-stored-view-async",
      source: [
        "struct Item { value: i32; }",
        "struct Holder { item: view Item; }",
        "async function inspect(in holder: Holder): i32 { return holder.item.value; }",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /view-bearing value can only enter a synchronous immutable in parameter/,
    },
    {
      name: "arena-stored-direct-view-enum",
      source: [
        "struct Item { value: i32; }",
        "enum MaybeItem { first view Item, second view Item, }",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /view-bearing enum payload must be a named value struct/,
    },
    {
      name: "arena-stored-view-enum-mixed-join",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Holder { item: view Item; }",
        "enum MaybeHolder { some Holder, none, }",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const second = secondArena.create(Item({ value: 22 }));",
        "  const mixed = if (true) {",
        "    select MaybeHolder.some(Holder({ item: first }));",
        "  } else {",
        "    select MaybeHolder.some(Holder({ item: second }));",
        "  };",
        "  const stored = firstArena.create(mixed);",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /cannot join values from different Arena owners/,
    },
    {
      name: "arena-stored-view-enum-consuming-match",
      source: [
        "struct Item { value: i32; }",
        "struct Holder { item: view Item; }",
        "enum StoredHolder { first Holder, second Holder, }",
        "function inspect(in value: StoredHolder): i32 {",
        "  return match (value) {",
        "    first(holder) => holder.item.value;",
        "    second(holder) => holder.item.value;",
        "  };",
        "}",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      expected: /view-bearing enum must be matched from proven storage with match \(in value\)/,
    },
    {
      name: "arena-stored-view-enum-wrong-region",
      source: [
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "struct Holder { item: view Item; }",
        "enum StoredHolder { first Holder, second Holder, }",
        "struct Node { holder: StoredHolder; }",
        "function main(): i32 {",
        "  let arena = Arena();",
        "  let other = Arena();",
        "  const item = arena.create(Item({ value: 42 }));",
        "  const holder = StoredHolder.first(Holder({ item }));",
        "  const pending = Node({ holder });",
        "  const stored = other.create(pending);",
        "  return stored.holder == stored.holder;",
        "}",
        "",
      ].join("\n"),
      expected: /only in the Arena that owns every embedded view/,
    },
    {
      name: "arena-stored-option-view-wrong-region",
      source: [
        'import { Arena } from "std/memory";',
        "struct Node { value: i32; next: Option<view Node>; }",
        "function main(): i32 {",
        "  let source = Arena();",
        "  let destination = Arena();",
        "  const tail = source.create(Node({",
        "    value: 22,",
        "    next: Option<view Node>.none,",
        "  }));",
        "  const pending = Node({",
        "    value: 20,",
        "    next: Option<view Node>.some(tail),",
        "  });",
        "  const head = destination.create(pending);",
        "  return head.value;",
        "}",
        "",
      ].join("\n"),
      expected: /only in the Arena that owns every embedded view/,
    },
    {
      name: "arena-stored-option-view-unproven",
      source: [
        "struct Node { value: i32; next: Option<view Node>; }",
        "function main(): i32 {",
        "  const local = Node({",
        "    value: 22,",
        "    next: Option<view Node>.none,",
        "  });",
        "  const pending = Node({",
        "    value: 20,",
        "    next: Option<view Node>.some(local),",
        "  });",
        "  return pending.value;",
        "}",
        "",
      ].join("\n"),
      expected: /proven borrowed storage/,
    },
    {
      name: "arena-stored-set-empty",
      source: [
        'import { Set } from "std/collections";',
        'import { Hashable, Hasher } from "std/hash";',
        "struct Item { value: i32; }",
        "readonly struct ItemKey implements Hashable {",
        "  item: view Item;",
        "  function equals(in other: ItemKey): boolean {",
        "    const left = this.item;",
        "    const right = other.item;",
        "    return left.value == right.value;",
        "  }",
        "  function hash(inout hasher: Hasher): void {",
        "    const item = this.item;",
        "    hasher.add(item.value);",
        "  }",
        "}",
        "function main(): i32 {",
        "  const keys = Set<ItemKey>();",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /empty view-bearing Set must use let/,
    },
    {
      name: "arena-stored-set-mixed",
      source: [
        'import { Set } from "std/collections";',
        'import { Hashable, Hasher } from "std/hash";',
        'import { Arena } from "std/memory";',
        "struct Item { value: i32; }",
        "readonly struct ItemKey implements Hashable {",
        "  item: view Item;",
        "  function equals(in other: ItemKey): boolean {",
        "    const left = this.item;",
        "    const right = other.item;",
        "    return left.value == right.value;",
        "  }",
        "  function hash(inout hasher: Hasher): void {",
        "    const item = this.item;",
        "    hasher.add(item.value);",
        "  }",
        "}",
        "function main(): i32 {",
        "  let firstArena = Arena();",
        "  let secondArena = Arena();",
        "  const first = firstArena.create(Item({ value: 20 }));",
        "  const second = secondArena.create(Item({ value: 22 }));",
        "  let keys = Set<ItemKey>();",
        "  keys.add(ItemKey({ item: first }));",
        "  keys.add(ItemKey({ item: second }));",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      expected: /already carries provenance from another Arena/,
    },
    {
      name: "arena-stored-set-conditional-first-add",
      source: readFileSync(
        resolve(projectRoot, "tests/fixtures/self-host-emit-arena-set.zs"),
        "utf8",
      ).replace(
        "keys.add(CoordinateKey({ coordinate: first }));",
        "if (true) keys.add(CoordinateKey({ coordinate: first }));",
      ),
      expected: /same Arena provenance on every continuing path/,
    },
    {
      name: "arena-stored-set-loop-first-add",
      source: readFileSync(
        resolve(projectRoot, "tests/fixtures/self-host-emit-arena-set.zs"),
        "utf8",
      ).replace(
        "keys.add(CoordinateKey({ coordinate: first }));",
        "while (false) { keys.add(CoordinateKey({ coordinate: first })); }",
      ),
      expected: /first add.*cannot occur in a loop/,
    },
  ] as const;
  for (const invalidCase of invalidCases) {
    const invalidInput = resolve(directory, `${invalidCase.name}.zs`);
    writeFileSync(invalidInput, invalidCase.source);
    const invalidEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", invalidInput],
      { encoding: "utf8" },
    );
    assert.equal(
      invalidEmission.status,
      1,
      `${invalidCase.name}\n${invalidEmission.stderr}`,
    );
    assert.match(invalidEmission.stderr, invalidCase.expected);
  }

  const importedClassModule = resolve(directory, "arena-session.zs");
  writeFileSync(
    importedClassModule,
    "export class Session { id: i32; }\n",
  );
  const importedClassRoot = resolve(directory, "arena-imported-class.zs");
  writeFileSync(
    importedClassRoot,
    [
      'import { Arena } from "std/memory";',
      'import { Session } from "./arena-session.zs";',
      "function main(): i32 {",
      "  let arena = Arena();",
      "  const session = arena.create(new Session({ id: 42 }));",
      "  return session.id;",
      "}",
      "",
    ].join("\n"),
  );
  const importedClassEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", importedClassRoot],
    { encoding: "utf8" },
  );
  assert.equal(importedClassEmission.status, 1);
  assert.match(
    importedClassEmission.stderr,
    /Arena\.create does not directly root reference-identity objects/,
  );

  rmSync(directory, { recursive: true, force: true });
});

test("emits and runs a standalone native Z driver with arguments and checked file I/O", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-native-driver.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /int32_t main\(int argc, char \*\*argv\);/);
  assert.match(emission.stdout, /z_stage1_process_args\(\)/);
  assert.match(emission.stdout, /z_stage1_fs_exists\(/);
  assert.match(emission.stdout, /z_stage1_fs_read_text\(/);

  const directory = mkdtempSync("/tmp/z-self-host-native-driver-");
  const executable = resolve(directory, "driver");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);

  const noArguments = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(noArguments.status, 2, noArguments.stderr);
  const existing = spawnSync(executable, [input], { encoding: "utf8" });
  assert.equal(existing.status, 0, existing.stderr);
  const missing = spawnSync(
    executable,
    [resolve(directory, "missing.zs")],
    { encoding: "utf8" },
  );
  assert.equal(missing.status, 1, missing.stderr);
  const invalidUtf8 = resolve(directory, "invalid-utf8.zs");
  writeFileSync(invalidUtf8, Buffer.from([0xc3, 0x28]));
  const invalid = spawnSync(executable, [invalidUtf8], { encoding: "utf8" });
  assert.equal(invalid.status, 1, invalid.stderr);
}, 15_000);

test("runs the source stager through native file, process, and console runtimes", () => {
  const input = resolve(
    projectRoot,
    "examples/applications/source-stager/main.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /z_stage1_fs_write_text\(/);
  assert.match(emission.stdout, /z_stage1_process_run\(/);
  assert.match(emission.stdout, /z_stage1_console_log\(/);

  const directory = mkdtempSync("/tmp/z-self-host-source-stager-");
  const executable = resolve(directory, "source-stager");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  mkdirSync(resolve(directory, ".z-cache"));
  const source = resolve(
    projectRoot,
    "tests/fixtures/self-host-parser-input.zs",
  );
  const execution = spawnSync(
    executable,
    [source],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /Apple clang version|clang version/);
  assert.match(execution.stdout, /staged .*self-host-parser-input\.zs.*clang exited 0/);
  assert.equal(
    readFileSync(resolve(directory, ".z-cache/self-host-input.zs"), "utf8"),
    readFileSync(source, "utf8"),
  );
}, 15_000);

test("runs Stage 0 and the native compiler against the same executable corpus", () => {
  const directory = mkdtempSync("/tmp/z-stage0-native-differential-");

  for (let index = 0; index < selfHostExecutableDifferentialCorpus.length; index += 1) {
    const testCase = selfHostExecutableDifferentialCorpus[index]!;
    const input = resolve(projectRoot, testCase.entry);
    const source = readFileSync(input, "utf8");
    const stage0 = compileToNative(source, input);
    assert.equal(
      stage0.language,
      "c",
      `${testCase.entry} left the portable native differential tier`,
    );

    const nativeEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", input],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(
      nativeEmission.status,
      0,
      `${testCase.entry}\n${nativeEmission.stderr}`,
    );

    const stage0Executable = resolve(directory, `stage0-${index}`);
    const nativeExecutable = resolve(directory, `native-${index}`);
    const stage0Compilation = spawnSync(
      "clang",
      [
        "-x", "c", "-std=c11", "-O2", "-DNDEBUG",
        "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", stage0Executable,
      ],
      { encoding: "utf8", input: stage0.source },
    );
    assert.equal(
      stage0Compilation.status,
      0,
      `${testCase.entry} Stage-0 C\n${stage0Compilation.stderr}`,
    );
    const nativeCompilation = spawnSync(
      "clang",
      [
        "-x", "c", "-std=c11", "-O2", "-DNDEBUG",
        "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", nativeExecutable,
      ],
      { encoding: "utf8", input: nativeEmission.stdout },
    );
    assert.equal(
      nativeCompilation.status,
      0,
      `${testCase.entry} native C\n${nativeCompilation.stderr}`,
    );

    const programArguments = [...(testCase.arguments ?? [])];
    const stage0Run = spawnSync(
      stage0Executable,
      programArguments,
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    const nativeRun = spawnSync(
      nativeExecutable,
      programArguments,
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    assert.notEqual(stage0Run.status, null, `${testCase.entry} Stage-0 runtime did not exit: ${stage0Run.error ?? stage0Run.signal}`);
    assert.notEqual(nativeRun.status, null, `${testCase.entry} native runtime did not exit: ${nativeRun.error ?? nativeRun.signal}`);
    assert.equal(
      nativeRun.status,
      stage0Run.status,
      `${testCase.entry} returned different exit statuses`,
    );
    assert.equal(
      nativeRun.stdout,
      stage0Run.stdout,
      `${testCase.entry} produced different stdout`,
    );
    assert.equal(
      nativeRun.stderr,
      stage0Run.stderr,
      `${testCase.entry} produced different stderr`,
    );
    if (testCase.expectedStatus !== undefined) {
      assert.equal(
        stage0Run.status,
        testCase.expectedStatus,
        `${testCase.entry} returned an unexpected exit status`,
      );
    }
    if (testCase.expectedStdout !== undefined) {
      assert.equal(
        stage0Run.stdout,
        testCase.expectedStdout,
        `${testCase.entry} produced unexpected stdout`,
      );
    }
  }
}, 150_000);

test("bootstraps a fixed-point native z executable for local use", () => {
  const directory = mkdtempSync("/tmp/z-native-bootstrap-");
  const executable = resolve(
    directory,
    process.platform === "win32" ? "z.exe" : "z",
  );
  const bootstrap = spawnSync(
    process.execPath,
    [resolve(projectRoot, "scripts/bootstrap-native.ts"), executable],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.match(
    bootstrap.stdout,
    /bootstrapped fixed-point native z \(\d+ C bytes\)/,
  );
  assert.equal(bootstrap.stdout.trimEnd().split("\n").at(-1), executable);
  assert.equal(existsSync(executable), true);
  assert.equal(existsSync(`${executable}.c`), true);
  assert.equal(existsSync(`${executable}.pending`), false);
  assert.equal(existsSync(`${executable}.c.pending`), false);
  assert.equal(existsSync(resolve(directory, "stdlib/json.zs")), true);
  const foreignAdapter = resolve(
    directory,
    process.platform === "win32"
      ? "z-foreign-adapter.exe"
      : "z-foreign-adapter",
  );
  assert.equal(existsSync(foreignAdapter), true);
  exerciseModuleHeaderBuilds([executable], true);

  const typedScalarConstant = spawnSync(
    executable,
    ["run", resolve(projectRoot, "tests/fixtures/typed-scalar-constant.zs")],
    { encoding: "utf8" },
  );
  assert.equal(typedScalarConstant.status, 0, typedScalarConstant.stderr);

  if (process.platform === "darwin") {
    const subclassAvailabilitySource = resolve(directory, "subclass-availability.zs");
    const subclassAvailabilityManifest = resolve(directory, "z.json");
    writeFileSync(subclassAvailabilitySource, `
      import native from "objc-subclass-availability.h";
      import { thread } from "std/thread";
      class Future extends native.ZWireFuture on thread.main {
        constructor(value: i32) { super.initWithValue(value); }
      }
      function main(): i32 { return 0; }
    `);
    for (const minimumVersion of ["13.0", "14.0"]) {
      writeFileSync(subclassAvailabilityManifest, JSON.stringify({ target: {
        name: "subclass-availability", kind: "executable", entry: "subclass-availability.zs", platform: "macos", minimumVersion,
        includeDirectories: [resolve(projectRoot, "tests/fixtures")],
      } }));
      const checked = spawnSync(executable, ["check", subclassAvailabilitySource], { encoding: "utf8", timeout: 30_000 });
      assert.equal(checked.status, minimumVersion === "13.0" ? 1 : 0, checked.stdout + checked.stderr);
      if (minimumVersion === "13.0") {
        assert.match(checked.stderr, /Z0802/);
        assert.match(checked.stderr, /ZWireFuture.*requires macos 14.0/);
      }
    }
    rmSync(subclassAvailabilityManifest);
    const borrowedObjCString = spawnSync(
      executable,
      ["run", resolve(projectRoot, "tests/fixtures/objc-borrow-method.zs")],
      { encoding: "utf8" },
    );
    assert.equal(
      borrowedObjCString.status,
      0,
      borrowedObjCString.stderr,
    );
  }

  const version = spawnSync(executable, ["version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  const stage0Version = spawnSync(process.execPath, [cli, "version"], {
    encoding: "utf8",
  });
  assert.equal(stage0Version.status, 0, stage0Version.stderr);
  assert.equal(version.stdout, stage0Version.stdout);

  const metadata = spawnSync(
    executable,
    [
      "metadata",
      resolve(projectRoot, "tests/fixtures/self-host-program-metadata.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(metadata.status, 0, metadata.stderr);
  const decodedMetadata = JSON.parse(metadata.stdout);
  assert.equal(decodedMetadata.schemaVersion, 1);
  assert.deepEqual(
    decodedMetadata.modules[0].symbols.map((symbol: { name: string }) => symbol.name),
    ["MetadataSource", "MetadataService", "register"],
  );
  const metadataSource = decodedMetadata.modules[0].symbols.find(
    (symbol: { name: string }) => symbol.name === "MetadataSource",
  );
  assert.deepEqual(metadataSource.typeSignature.typeParameters, ["T"]);
  const metadataService = decodedMetadata.modules[0].symbols.find(
    (symbol: { name: string }) => symbol.name === "MetadataService",
  );
  assert.equal(
    metadataService.typeSignature.methods[0].signature.executorAffinity,
    "thread.main",
  );
  const stage0Metadata = spawnSync(
    process.execPath,
    [
      cli,
      "metadata",
      resolve(projectRoot, "tests/fixtures/self-host-program-metadata.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(stage0Metadata.status, 0, stage0Metadata.stderr);
  assert.deepEqual(decodedMetadata, JSON.parse(stage0Metadata.stdout));
  const registerMetadata = decodedMetadata.modules[0].calls.find(
    (call: { target: { name: string } }) => call.target.name === "register",
  );
  assert.deepEqual(registerMetadata.arguments, [
    { kind: "string", type: "String", value: "notes" },
    { kind: "other", type: "MetadataService" },
  ]);

  const constructorFixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-program-metadata-constructor.zs",
  );
  const constructorMetadata = spawnSync(
    executable,
    ["metadata", constructorFixture],
    { encoding: "utf8" },
  );
  assert.equal(constructorMetadata.status, 0, constructorMetadata.stderr);
  const decodedConstructorMetadata = JSON.parse(constructorMetadata.stdout);
  const constructorCall = decodedConstructorMetadata.modules[0].calls.find(
    (call: { target: { kind: string } }) => call.target.kind === "constructor",
  );
  assert.deepEqual(constructorCall.target, {
    module: constructorFixture,
    symbol: "Application",
    kind: "constructor",
    name: "Application.constructor",
  });
  assert.deepEqual(constructorCall.arguments, [{
    kind: "string",
    type: "String",
    value: "Notes",
  }]);
  const stage0ConstructorMetadata = spawnSync(
    process.execPath,
    [cli, "metadata", constructorFixture],
    { encoding: "utf8" },
  );
  assert.equal(
    stage0ConstructorMetadata.status,
    0,
    stage0ConstructorMetadata.stderr,
  );
  assert.deepEqual(
    decodedConstructorMetadata,
    JSON.parse(stage0ConstructorMetadata.stdout),
  );

  const aliasConstructorFixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-program-metadata-alias-constructor.zs",
  );
  const aliasConstructorMetadata = spawnSync(
    executable,
    ["metadata", aliasConstructorFixture],
    { encoding: "utf8" },
  );
  assert.equal(aliasConstructorMetadata.status, 0, aliasConstructorMetadata.stderr);
  const decodedAliasConstructorMetadata = JSON.parse(aliasConstructorMetadata.stdout);
  const aliasGetCall = decodedAliasConstructorMetadata.modules[0].calls.find(
    (call: { target: { name: string } }) => call.target.name === "Registry.get",
  );
  assert.deepEqual(aliasGetCall.typeArguments, ["Command", "Message"]);
  assert.deepEqual(aliasGetCall.parameterTypes, ["Protocol<Command, Message>"]);
  assert.deepEqual(aliasGetCall.arguments, [{
    kind: "other",
    type: "Protocol<Command, Message>",
  }]);
  const stage0AliasConstructorMetadata = spawnSync(
    process.execPath,
    [cli, "metadata", aliasConstructorFixture],
    { encoding: "utf8" },
  );
  assert.equal(
    stage0AliasConstructorMetadata.status,
    0,
    stage0AliasConstructorMetadata.stderr,
  );
  assert.deepEqual(
    decodedAliasConstructorMetadata,
    JSON.parse(stage0AliasConstructorMetadata.stdout),
  );

  const checking = spawnSync(
    executable,
    ["check", resolve(projectRoot, "tests/fixtures/self-host-emit-input.zs")],
    { encoding: "utf8" },
  );
  assert.equal(checking.status, 0, checking.stderr);
  assert.match(checking.stdout, /checked 1 Z modules/);

  if (process.platform === "darwin") {
    const protocolAdapter = resolve(
      projectRoot,
      "examples/interop/objc/protocol-adapter.zs",
    );
    const protocolChecking = spawnSync(
      executable,
      ["check", protocolAdapter],
      { encoding: "utf8" },
    );
    assert.equal(protocolChecking.status, 0, protocolChecking.stderr);
    const protocolOutput = resolve(directory, "protocol-adapter.m");
    const protocolEmission = spawnSync(
      executable,
      ["emit", protocolAdapter, protocolOutput],
      { encoding: "utf8" },
    );
    assert.equal(protocolEmission.status, 0, protocolEmission.stderr);
    const protocolSource = readFileSync(protocolOutput, "utf8");
    assert.match(protocolSource, /__strong id<WKURLSchemeHandler> adapter;/);
    assert.match(
      protocolSource,
      /id<WKURLSchemeTask> task/,
    );
    assert.match(
      protocolSource,
      /\[NSArray arrayWithObject:\s*task\]/,
    );
    assert.match(
      protocolSource,
      /int32_t _z_init_id, id<WKURLSchemeHandler> _z_init_adapter/,
    );
    assert.match(
      protocolSource,
      /z_stage1_objc_adapt_[0-9_]+\(handler\)/,
    );

    const projectedBorrowFixture = resolve(
      projectRoot,
      "tests/fixtures/objc-projected-borrow.zs",
    );
    const projectedBorrowRun = spawnSync(executable, ["run", projectedBorrowFixture], {
      encoding: "utf8", timeout: 60_000,
    });
    assert.equal(projectedBorrowRun.status, 0, projectedBorrowRun.stderr);
    assert.equal(projectedBorrowRun.stdout.split("\n").filter((line) => line.startsWith("released ")).join("\n"),
      "released 4\nreleased 4");

    const objectiveCStringFixture = resolve(
      projectRoot,
      "tests/fixtures/objc-strings.zs",
    );
    const objectiveCStringRun = spawnSync(
      executable,
      ["run", objectiveCStringFixture],
      { encoding: "utf8" },
    );
    assert.equal(objectiveCStringRun.status, 0, objectiveCStringRun.stderr);
    assert.equal(
      objectiveCStringRun.stdout.split("\n").slice(1).join("\n"),
      "round trip=answer=42\n"
        + "property=answer=42\n"
        + "scheme=https\n"
        + "nullable=answer=42\n"
        + "narrowed=yes\n"
        + "embedded=a\0b\n",
    );
    const objectiveCStringOutput = resolve(directory, "objc-strings.m");
    const objectiveCStringEmission = spawnSync(
      executable,
      ["emit", objectiveCStringFixture, objectiveCStringOutput],
      { encoding: "utf8" },
    );
    assert.equal(
      objectiveCStringEmission.status,
      0,
      objectiveCStringEmission.stderr,
    );
    const objectiveCStringSource = readFileSync(
      objectiveCStringOutput,
      "utf8",
    );
    assert.match(objectiveCStringSource, /isEqualToString:/);
    assert.doesNotMatch(objectiveCStringSource, /\.isEqualToString\(/);
    assert.match(objectiveCStringSource, /NSLocalizedDescriptionKey/);
    assert.doesNotMatch(
      objectiveCStringSource,
      /Foundation\.NSLocalizedDescriptionKey/,
    );
  }

  const contextualOptionChecking = spawnSync(
    executable,
    ["check", resolve(projectRoot, "tests/fixtures/self-host-emit-option.zs")],
    { encoding: "utf8" },
  );
  assert.equal(
    contextualOptionChecking.status,
    0,
    contextualOptionChecking.stderr,
  );
  assert.match(contextualOptionChecking.stdout, /checked 1 Z modules/);

  const jsonRun = spawnSync(
    executable,
    ["run", resolve(projectRoot, "tests/fixtures/std-json-smoke.zs")],
    { encoding: "utf8" },
  );
  assert.equal(jsonRun.status, 0, jsonRun.stderr);

  // A non-tail placed call in a worker frame hops to main.
  const nonTailChecking = spawnSync(
    executable,
    [
      "check",
      resolve(
        projectRoot,
        "tests/fixtures/self-host-emit-thread-main-nontail-suspension.zs",
      ),
    ],
    { encoding: "utf8" },
  );
  assert.equal(nonTailChecking.status, 0, nonTailChecking.stderr);

  const nativeTests = spawnSync(
    executable,
    [
      "test",
      resolve(projectRoot, "tests/fixtures/native-test-project/main.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(nativeTests.status, 0, nativeTests.stderr);
  assert.equal(
    nativeTests.stdout,
    "running 2 tests\n"
      + "test imported module tests are discovered ... ok\n"
      + "test entry module expectations run ... ok\n"
      + "test result: ok. 2 passed; 0 failed\n",
  );

  for (const name of [
    "numeric-expression-context", "numeric-conditional-operands", "integer-shift-widths",
    "borrowed-capture-retention", "indexed-owned-replacement",
  ]) {
    const result = spawnSync(executable, ["run", resolve(projectRoot, `tests/fixtures/${name}.zs`)], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const invalidNumericFile = resolve(directory, "invalid-numeric-context.zs");
  for (const body of [
    "const value: u8 = true ? 256 : 0;",
    "const value: u64 = 1 << 64;",
    "const value: u64 = 0xFFFF_FFFF_FFFF_FFFF << 1;",
    "const typed: i32 = 7; const value: u64 = true ? typed : 0;",
    "const typed: i32 = 7; const value: u64 = typed << 1;",
    "const value: Small = 256;",
    "const index: usize = 1; const value = index + (true ? -1 : 0);",
    "const index: usize = 1; const typed: i32 = 2; const value = index + (true ? typed : 0);",
  ]) {
    writeFileSync(invalidNumericFile, `type Small = u8; function main(): i32 { ${body} return 0; }`);
    const result = spawnSync(executable, ["check", invalidNumericFile], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.notEqual(result.status, 0, body);
    assert.match(result.stderr, /invalid-numeric-context\.zs:\d+:\d+: error/);
    assert.doesNotMatch(result.stderr, /internal compiler error|\.c:\d+|\[-W/);
  }

  for (const [name, status] of [["test-numeric-context", 0], ["test-numeric-context-failure", 1]] as const) {
    const result = spawnSync(executable, ["test", resolve(projectRoot, `tests/fixtures/${name}.zs`)], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, status, result.stderr);
    if (status === 1) {
      assert.match(result.stdout, /expected 0 to equal 18446744073709551615/);
      assert.match(result.stdout, /expected 18446744073709551615 to equal 0/);
      assert.match(result.stdout, /expected 0 to equal -9223372036854775808/);
    }
  }

  const invalidExpectationFile = resolve(directory, "invalid-expectation.zs");
  for (const body of [
    "const value: u8 = 1; expect(value).toEqual(256);",
    "const value: u8 = 1; expect(256).toEqual(value);",
    "const value: u32 = 1; expect(value).toEqual(-1);",
    "const value: u32 = 1; expect(-1).toEqual(value);",
    "const value: u32 = 1; const other: i32 = 1; expect(value).toEqual(other);",
    "const value: u32 = 1; const other: i32 = 1; expect(other).toEqual(value);",
  ]) {
    writeFileSync(invalidExpectationFile, `import { expect } from "std/test"; test "invalid comparison" { ${body} }`);
    const result = spawnSync(executable, ["test", invalidExpectationFile], { encoding: "utf8", timeout: 30_000 });
    assert.notEqual(result.status, 0, body);
    assert.match(result.stderr, /invalid-expectation\.zs:\d+:\d+: error/);
    assert.doesNotMatch(result.stderr, /internal compiler error|\.c:\d+|\[-W/);
  }

  const failingNativeTests = spawnSync(
    executable,
    [
      "test",
      resolve(projectRoot, "tests/fixtures/native-test-expectations.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(failingNativeTests.status, 1);
  assert.match(failingNativeTests.stdout, /^running 4 tests/m);
  assert.match(
    failingNativeTests.stdout,
    /test native parser sees expectations \.\.\. ok/,
  );
  assert.match(
    failingNativeTests.stdout,
    /test native runner reports expectation failures \.\.\. FAILED/,
  );
  assert.match(
    failingNativeTests.stdout,
    /native-test-expectations\.zs:\d+:\d+: expected 41 to equal 42/,
  );
  assert.match(
    failingNativeTests.stdout,
    /test native parser sees explicit failure \.\.\. FAILED\ndeliberate fixture failure/,
  );
  assert.match(
    failingNativeTests.stdout,
    /test native runner continues after failure \.\.\. ok/,
  );
  assert.match(
    failingNativeTests.stdout,
    /test result: FAILED\. 2 passed; 2 failed/,
  );

  const noNativeTests = spawnSync(
    executable,
    ["test", resolve(projectRoot, "tests/fixtures/self-host-emit-input.zs")],
    { encoding: "utf8" },
  );
  assert.equal(noNativeTests.status, 1);
  assert.match(
    noNativeTests.stderr,
    /no tests were found in this module or its imports/,
  );

  const usage = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^usage: z /);

  const adapterUsage = spawnSync(foreignAdapter, [], { encoding: "utf8" });
  assert.equal(adapterUsage.status, 2);
  assert.match(adapterUsage.stderr, /^usage: z-foreign-adapter /);

  const foreignProject = resolve(directory, "foreign-project");
  mkdirSync(foreignProject);
  const foreignSource = resolve(foreignProject, "main.zs");
  writeFileSync(
    foreignSource,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(foreignProject, "foreign-functions-only.h"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/foreign-functions-only.h"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(foreignProject, "foreign-functions-only.h.zd"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/foreign-functions-only.h.zd"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(foreignProject, "z.json"),
    JSON.stringify({
      target: {
        name: "foreign-project",
        entry: "main.zs",
        includeDirectories: ["."],
      },
    }),
  );
  const foreignChecking = spawnSync(
    executable,
    ["check", foreignSource],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
      },
    },
  );
  assert.equal(foreignChecking.status, 0, foreignChecking.stderr);
  assert.match(foreignChecking.stdout, /checked 1 Z modules/);
  assert.equal(
    readdirSync(resolve(foreignProject, ".z-cache/foreign"))
      .some((entry) => entry.endsWith(".zfdcl")),
    true,
  );

  if (process.platform === "darwin") {
    const sdk = spawnSync(
      "xcrun",
      ["--sdk", "macosx", "--show-sdk-path"],
      { encoding: "utf8" },
    );
    assert.equal(sdk.status, 0, sdk.stderr);
    const objcProject = resolve(directory, "objc-project");
    const objcLibraries = resolve(directory, "objc-libraries");
    mkdirSync(objcProject);
    mkdirSync(objcLibraries);
    const foundationStub = resolve(
      sdk.stdout.trim(),
      "System/Library/Frameworks/Foundation.framework/Foundation.tbd",
    );
    const foundationLink = spawnSync(
      "ln",
      ["-s", foundationStub, resolve(objcLibraries, "libFoundation.tbd")],
      { encoding: "utf8" },
    );
    assert.equal(foundationLink.status, 0, foundationLink.stderr);
    writeFileSync(
      resolve(objcProject, "NativeOwner.h"),
      [
        "typedef signed char BOOL;",
        "typedef struct objc_class *Class;",
        "#define nil ((id)0)",
        "#define NSUTF8StringEncoding 4UL",
        "",
        "typedef enum __attribute__((flag_enum)) NativeOptions : unsigned int {",
        "  NativeOptionFirst = 1,",
        "  NativeOptionSecond = 2",
        "} NativeOptions;",
        "",
        "typedef struct NativeRect {",
        "  int value;",
        "} NativeRect;",
        "typedef NativeRect NativeRectAlias;",
        "NativeRect native_make_rect(void) {",
        "  return (NativeRect){ .value = 42 };",
        "}",
        "int native_read_rect_alias(NativeRectAlias value) {",
        "  return value.value;",
        "}",
        "",
        "__attribute__((objc_root_class))",
        "@interface NSObject",
        "+ (instancetype)alloc;",
        "- (instancetype)init;",
        "+ (Class)class;",
        "- (BOOL)isKindOfClass:(Class)aClass;",
        "@end",
        "",
        "@interface NSString : NSObject",
        "- (instancetype)initWithBytes:(const void *)bytes",
        "                       length:(unsigned long)length",
        "                     encoding:(unsigned long)encoding;",
        "- (unsigned long)lengthOfBytesUsingEncoding:(unsigned long)encoding;",
        "- (const char *)UTF8String;",
        "@end",
        "",
        "@interface NativeBase : NSObject",
        "@property(nonatomic, readonly) int baseValue;",
        "@end",
        "",
        "@interface NativeOwner : NativeBase",
        "+ (instancetype)sharedOwner;",
        "@property(class, nonatomic, readonly) NativeOwner *currentOwner;",
        "@property(nonatomic, readonly, getter=answer) int value;",
        "@property(nonatomic) int writableValue;",
        "@property(nonatomic) NativeBase *writableBase;",
        "@property(nonatomic, readonly) NativeBase *base;",
        "@property(nonatomic, readonly) id body;",
        "@property(nonatomic, readonly) NSString *text;",
        "@property(nonatomic, copy) NSString *title;",
        "@end",
        "",
        "@implementation NativeBase",
        "- (int)baseValue {",
        "  return 40;",
        "}",
        "@end",
        "",
        "@implementation NativeOwner",
        "+ (instancetype)sharedOwner {",
        "  return [[self alloc] init];",
        "}",
        "",
        "+ (NativeOwner *)currentOwner {",
        "  return [self sharedOwner];",
        "}",
        "",
        "- (int)answer {",
        "  return 42;",
        "}",
        "",
        "- (int)writableValue {",
        "  return 0;",
        "}",
        "",
        "- (void)setWritableValue:(int)value {",
        "  (void)value;",
        "}",
        "",
        "- (NativeBase *)writableBase {",
        "  return (NativeBase *)0;",
        "}",
        "",
        "- (void)setWritableBase:(NativeBase *)value {",
        "  (void)value;",
        "}",
        "",
        "- (NativeBase *)base {",
        "  return self;",
        "}",
        "",
        "- (id)body {",
        "  return self;",
        "}",
        "",
        "- (NSString *)text {",
        "  return (NSString *)0;",
        "}",
        "",
        "- (NSString *)title {",
        "  return (NSString *)0;",
        "}",
        "",
        "- (void)setTitle:(NSString *)value {",
        "  (void)value;",
        "}",
        "@end",
        "",
      ].join("\n"),
    );
    writeFileSync(
      resolve(objcProject, "main.zs"),
      [
        'import native from "NativeOwner.h";',
        "",
        "class NativeRoot {",
        "  owner: native.NativeOwner;",
        "}",
        "",
        "function createOwnedNative(): native.NativeOwner throws i32 {",
        "  return native.NativeOwner.sharedOwner();",
        "}",
        "",
        "function inspectOwnedNativeContainers(): i32 throws i32 {",
        "  const created = try createOwnedNative();",
        "  let owners = Array<native.NativeOwner>();",
        "  owners.push(created);",
        "  owners.push(native.NativeOwner.sharedOwner());",
        "  return owners[0].value;",
        "}",
        "",
        "type ToggleHandler = (in enabled: boolean) => void;",
        "",
        "class ToggleObservation {",
        "  value: i32;",
        "}",
        "",
        "function registerToggle(handler: ToggleHandler): i32 throws i32 {",
        "  const enabled = true;",
        "  handler(in enabled);",
        "  return 1;",
        "}",
        "",
        "function inspectClosureInMatchSubject(): i32 {",
        "  const observed = new ToggleObservation({ value: 0 });",
        "  const registered = match (attempt registerToggle(",
        "    move (in enabled: boolean): void => {",
        "      if (enabled) observed.value = 41;",
        "    }",
        "  )) {",
        "    success(value) => value;",
        "    failure(_) => return -1;",
        "  };",
        "  return observed.value + registered;",
        "}",
        "",
        "function main(): i32 {",
        "  if (inspectClosureInMatchSubject() != 42) return 5;",
        "  const owned = attempt inspectOwnedNativeContainers();",
        "  const ownedValue = match (owned) {",
        "    success(value) => value;",
        "    failure(error) => -error;",
        "  };",
        "  if (ownedValue != 42) return 4;",
        "  const options = native.NativeOptionFirst | native.NativeOptionSecond;",
        "  if (options == native.NativeOptionFirst) return 2;",
        "  const rect = native.native_make_rect();",
        "  if (native.native_read_rect_alias(rect) != 42) return 3;",
        "  const owner = native.NativeOwner.currentOwner;",
        "  const root = new NativeRoot({ owner });",
        "  const base = owner.base;",
        "  const body = owner.body;",
        "  const nativeText = owner.text;",
        "  owner.writableValue = 9;",
        "  owner.writableBase = owner;",
        '  owner.title = "Native Z";',
        "  if (owner.value == 0) {",
        "    const text: String = nativeText;",
        "    return i32(text.byteLength);",
        "  }",
        "  if (body instanceof native.NativeBase) {",
        "    return owner.value + base.baseValue + body.baseValue - 80;",
        "  }",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      resolve(objcProject, "z.json"),
      JSON.stringify({
        target: {
          name: "native-objc-probe",
          entry: "main.zs",
          link: {
            directories: [objcLibraries],
            libraries: ["Foundation"],
          },
        },
      }),
    );
    const objcRun = spawnSync(executable, ["run", objcProject], {
      encoding: "utf8",
    });
    assert.equal(objcRun.status, 42, objcRun.stderr);
    assert.match(objcRun.stdout, /compiled 1 Z modules/);
    const objcEmissionPath = resolve(
      objcProject,
      ".z-cache/run/program.m",
    );
    assert.equal(existsSync(objcEmissionPath), true);
    assert.equal(
      existsSync(resolve(objcProject, ".z-cache/run/program.c")),
      false,
    );
    const objcEmission = readFileSync(objcEmissionPath, "utf8");
    assert.match(
      objcEmission,
      /typedef struct Z_ObjCOwned \{\s+__unsafe_unretained id value;/,
    );
    assert.match(
      objcEmission,
      /\.payload = \{ \.success = z_stage1_objc_owned\(\[NativeOwner sharedOwner\]\)/,
    );
    assert.match(
      objcEmission,
      /z_stage1_objc_take\(&_z_stage1_try_\d+\.payload\.success\)/,
    );
    assert.match(
      objcEmission,
      /NativeOwner \* __strong \*storage = \(NativeOwner \* __strong \*\)calloc/,
    );
    assert.match(
      objcEmission,
      /items\[self->length\] = nil;/,
    );
    assert.match(
      objcEmission,
      /NativeOwner \* const owner = \[NativeOwner currentOwner\]/,
    );
    assert.match(
      objcEmission,
      /NativeBase \* const base = \[owner base\]/,
    );
    assert.match(objcEmission, /id const body = \[owner body\]/);
    assert.match(objcEmission, /\[owner setWritableValue: 9\]/);
    assert.match(objcEmission, /\[owner setWritableBase: owner\]/);
    assert.match(
      objcEmission,
      /Z_NativeRoot \*self = \(Z_NativeRoot \*\)calloc\(1, sizeof\(Z_NativeRoot\)\)/,
    );
    assert.match(
      objcEmission,
      /Z_NativeRoot \* const root[^=]*= Z_NativeRoot_new\(owner\)/,
    );
    assert.match(
      objcEmission,
      /\[owner setTitle: z_stage1_nsstring_from_string\(Z_STRING_LITERAL\("Native Z"\)\)\]/,
    );
    assert.match(
      objcEmission,
      /Z_String text = z_stage1_string_from_nsstring\(nativeText\)/,
    );
    assert.match(
      objcEmission,
      /lengthOfBytesUsingEncoding:NSUTF8StringEncoding/,
    );
    assert.match(
      objcEmission,
      /\[body isKindOfClass:\[NativeBase class\]\]/,
    );
    assert.match(objcEmission, /\[owner answer\]/);
    assert.match(objcEmission, /\[base baseValue\]/);
    assert.match(objcEmission, /\[body baseValue\]/);

    writeFileSync(
      resolve(objcProject, "readonly-property-write.zs"),
      [
        'import native from "NativeOwner.h";',
        "",
        "function main(): i32 {",
        "  const owner = native.NativeOwner.sharedOwner();",
        "  owner.value = 1;",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );
    const propertyWriteCheck = spawnSync(
      executable,
      ["check", resolve(objcProject, "readonly-property-write.zs")],
      { encoding: "utf8" },
    );
    assert.notEqual(propertyWriteCheck.status, 0);
    assert.match(
      propertyWriteCheck.stderr,
      /cannot assign to readonly field "value"/,
    );

    const registrationProject = resolve(directory, "objc-registration-project");
    mkdirSync(registrationProject);
    for (const name of [
      "objc-registration-native.h",
      "objc-registration-native.zs",
    ]) {
      writeFileSync(
        resolve(registrationProject, name),
        readFileSync(resolve(projectRoot, "tests/fixtures", name)),
      );
    }
    writeFileSync(
      resolve(registrationProject, "z.json"),
      JSON.stringify({
        target: {
          name: "native-objc-registration",
          entry: "objc-registration-native.zs",
          link: {
            directories: [objcLibraries],
            libraries: ["Foundation"],
          },
        },
      }),
    );
    const registrationRun = spawnSync(
      executable,
      ["run", registrationProject, "--release"],
      { encoding: "utf8" },
    );
    assert.equal(registrationRun.status, 0, registrationRun.stderr);
    assert.match(registrationRun.stdout, /^compiled 1 Z modules to /);
    assert.match(
      registrationRun.stdout,
      /registered bridge\nreceived 42\nunregistered bridge\n$/,
    );
    const registrationEmission = readFileSync(
      resolve(registrationProject, ".z-cache/run/program.m"),
      "utf8",
    );
    assert.match(
      registrationEmission,
      /objc_precise_lifetime/,
    );
    assert.match(
      registrationEmission,
      /struct Z_NativeRegistrationRoot \{[^}]*__strong ZNativeRegistrationOwner \* owner;[^}]*__strong ZObjCRegistration \* registration;/,
    );
    assert.match(registrationEmission, /self->registration = nil;/);
    assert.match(
      registrationEmission,
      /Z_NativeRegistrationHandler_retain\(owner\)/,
    );
    assert.match(
      registrationEmission,
      /Z_NativeRegistrationRoot_publish\(root\)/,
    );
    assert.match(
      registrationEmission,
      /\[_z_object removeHandlerForName:_z_stored_1\]/,
    );
  }

  rmSync(directory, { recursive: true, force: true });
}, 300_000);

test("decodes versioned raw foreign function declarations in native Z", () => {
  const declarations: ForeignModuleDeclarations = {
    producer: "clang",
    functions: new Map([
      ["math.measureπ", {
        name: "measureπ",
        namespacePath: ["math"],
        qualifiedName: "math.measureπ",
        overloads: [{
          name: "measureπ",
          nativeName: "math::measure_pi",
          returnType: {
            nativeName: "long",
            canonicalNativeName: "long",
          },
          parameters: [
            {
              name: "value",
              type: { nativeName: "int", canonicalNativeName: "int" },
            },
            {
              name: null,
              type: { nativeName: "const char *" },
            },
          ],
          variadic: false,
          nativeSignature: "long (int, const char *)",
          metadata: {
            source: {
              fileName: "/native/math.hpp",
              line: 42,
              column: 7,
              length: 10,
            },
            availability: [{
              platform: "macos",
              introduced: "14.0",
              deprecated: true,
              deprecatedVersion: "15.0",
              obsoleted: null,
              unavailable: false,
              message: "prefer measure_next",
            }],
            executorAffinity: null,
          },
        }],
      }],
    ]),
    nativeTypes: new Map(),
    namedTypes: new Map([
      ["WirePoint", {
        kind: "record",
        exportName: "WirePoint",
        typeName: "WirePoint",
        cName: "WirePoint",
        canonicalNativeName: "WirePoint",
        layout: "struct",
        fields: [
          {
            name: "x",
            typeName: "int",
            metadata: {
              source: null,
              availability: [],
              executorAffinity: null,
            },
          },
          {
            name: "y",
            typeName: "int",
            metadata: {
              source: null,
              availability: [],
              executorAffinity: null,
            },
          },
        ],
        fieldProjections: [],
        nativeFields: [
          {
            name: "x",
            cName: "int",
            metadata: {
              source: null,
              availability: [],
              executorAffinity: null,
            },
          },
          {
            name: "y",
            cName: "int",
            metadata: {
              source: null,
              availability: [],
              executorAffinity: null,
            },
          },
        ],
        viewOnly: false,
        resource: null,
        namespacePath: [],
        qualifiedName: "WirePoint",
        metadata: {
          source: null,
          availability: [],
          executorAffinity: null,
        },
      }],
      ["WireFlags", {
        kind: "enum",
        exportName: "WireFlags",
        typeName: "WireFlags",
        cName: "WireFlags",
        flags: true,
        underlying: "u32",
        namespacePath: [],
        qualifiedName: "WireFlags",
        metadata: {
          source: null,
          availability: [],
          executorAffinity: null,
        },
      }],
    ]),
    constants: new Map(),
    objectTypes: new Map(),
    interfaces: new Map(),
    protocols: new Map(),
    framework: null,
    objectiveC: false,
    cPlusPlus: false,
  };
  const encoded = encodeForeignFunctionDeclarationStream(declarations, 8);
  assert.match(encoded, /^ZFDCL0000000000000010\nM/);
  assert.equal(
    encodeForeignFunctionDeclarationStream({
      ...declarations,
      namedTypes: new Map([
        ...declarations.namedTypes,
        ["unsupported", {} as never],
      ]),
      objectTypes: new Map([["unsupported", {} as never]]),
    }, 8),
    encoded,
  );

  const directory = mkdtempSync("/tmp/z-self-host-foreign-declarations-");
  const protocolPath = resolve(directory, "declarations.zfdcl");
  writeFileSync(protocolPath, encoded);
  const fixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-foreign-declarations.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", fixture],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /decodeRawForeignDeclarations/);
  const executable = resolve(directory, "foreign-declarations");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [protocolPath], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  const foreignFixture = resolve(
    projectRoot,
    "tests/fixtures/foreign-functions-only.h",
  );
  const foreignImport: ImportDeclaration = {
    kind: "import",
    moduleName: "native",
    bindings: null,
    header: basename(foreignFixture),
    location: {
      fileName: fixture,
      offset: 0,
      line: 1,
      column: 1,
    },
  };
  const clangStreams = resolveForeignFunctionDeclarationStreams(
    [foreignImport],
    fixture,
    [resolve(projectRoot, "tests/fixtures")],
  );
  const clangStream = clangStreams.get("native");
  assert.ok(clangStream);
  const clangPath = resolve(directory, "clang.zfdcl");
  const adapterSource = resolve(directory, "adapter-input.zs");
  writeFileSync(
    adapterSource,
    `import native from ${JSON.stringify(foreignFixture)};\n`,
  );
  const adapter = spawnSync(
    process.execPath,
    [cli, "self-host-foreign", adapterSource, foreignFixture, clangPath],
    { encoding: "utf8" },
  );
  assert.equal(adapter.status, 0, adapter.stderr);
  assert.equal(readFileSync(clangPath, "utf8"), clangStream);
  const clangExecution = spawnSync(
    executable,
    [clangPath, "clang"],
    { encoding: "utf8" },
  );
  assert.equal(clangExecution.status, 0, clangExecution.stderr);

  const objcFixture = resolve(directory, "objc-registration-wire.h");
  writeFileSync(objcFixture, `
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Wnullability-completeness"

    @protocol ZBaseHandler
    @end

    @protocol ZRegistrationHandler <ZBaseHandler>
    - (void)registrationOwner:(id)owner didReceiveValue:(int)value;
    @end

    @interface ZRegistrationOwner
    - (void)addHandler:(id<ZRegistrationHandler>)handler name:(const char *)name;
    - (void)removeHandlerForName:(const char *)name;
    - (int)compareOwner:(ZRegistrationOwner *)other;
    + (ZRegistrationOwner *)sharedOwner;
    + (ZRegistrationOwner * _Nullable)maybeOwner;
    - (void)fetchValue:(void (^ _Nonnull)(int))completionHandler;
    - (void)fetchValueOrError:(void (^ _Nonnull)(int, id _Nullable))completionHandler;
    - (void)fetchOwner:(void (^ _Nonnull)(ZRegistrationOwner * _Nonnull))completionHandler;
    @end

    @interface ZPropertyOwner
    @property(nonatomic, readonly, getter=answer) int value;
    @property(nonatomic, weak) id<ZRegistrationHandler> handler;
    @end

    #pragma clang diagnostic pop
  `);
  const objcImport: ImportDeclaration = {
    kind: "import",
    moduleName: "native",
    bindings: null,
    header: basename(objcFixture),
    location: {
      fileName: fixture,
      offset: 0,
      line: 1,
      column: 1,
    },
  };
  const objcStream = resolveForeignFunctionDeclarationStreams(
    [objcImport],
    fixture,
    [directory],
  ).get("native");
  assert.ok(objcStream);
  assert.match(objcStream, /^ZFDCL0000000000000010\nM/);
  assert.match(objcStream, /\nQ/);
  assert.match(objcStream, /\nI/);
  assert.match(objcStream, /\nJ/);
  assert.match(objcStream, /\nK/);
  assert.match(objcStream, /\nR/);
  const objcPath = resolve(directory, "objc.zfdcl");
  writeFileSync(objcPath, objcStream);
  const objcExecution = spawnSync(
    executable,
    [objcPath, "objc"],
    { encoding: "utf8" },
  );
  assert.equal(objcExecution.status, 0, objcExecution.stderr);

  const cppFixture = resolve(projectRoot, "tests/fixtures/foreign-values.hpp");
  const cppStream = resolveForeignFunctionDeclarationStreams(
    [{ ...objcImport, header: basename(cppFixture) }],
    fixture,
    [dirname(cppFixture)],
  ).get("native");
  assert.ok(cppStream);
  assert.match(cppStream, /\nX/);
  assert.match(cppStream, /\nY/);
  const cppPath = resolve(directory, "cpp.zfdcl");
  writeFileSync(cppPath, cppStream);
  const cppExecution = spawnSync(executable, [cppPath, "cpp"], { encoding: "utf8" });
  assert.equal(cppExecution.status, 0, cppExecution.stderr);

  const contractFixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-foreign-contracts.zs",
  );
  const contractEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", contractFixture],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(contractEmission.status, 0, contractEmission.stderr);
  assert.match(contractEmission.stdout, /parseForeignContracts/);
  assert.match(contractEmission.stdout, /normalizeForeignContracts/);
  const contractExecutable = resolve(directory, "foreign-contracts");
  const contractCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      contractExecutable,
    ],
    { encoding: "utf8", input: contractEmission.stdout },
  );
  assert.equal(contractCompilation.status, 0, contractCompilation.stderr);
  const objcContractPath = resolve(directory, "objc-registration-wire.h.zd");
  writeFileSync(
    objcContractPath,
    [
      'declare module "objc-registration-wire.h" {',
      "  export type ZPropertyOwner on thread.main;",
      "  export function ZRegistrationOwner.fetchValue(move completionHandler: _): _ {",
      "    callback completionHandler {",
      "      thread any;",
      "      invoked once;",
      "    }",
      "    async completionHandler;",
      "  }",
      "  export function ZRegistrationOwner.fetchValueOrError(move completionHandler: _): _ {",
      "    callback completionHandler {",
      "      thread any;",
      "      invoked once;",
      "    }",
      "    async completionHandler(value, error) {",
      "      return value;",
      "      throw error;",
      "    }",
      "  }",
      "  export function ZRegistrationOwner.fetchOwner(move completionHandler: _): _ {",
      "    callback completionHandler {",
      "      thread any;",
      "      invoked once;",
      "    }",
      "    async completionHandler;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  const objcSourcePath = resolve(directory, "objc-semantic-input.zs");
  writeFileSync(
    objcSourcePath,
    [
      'import native from "objc-registration-wire.h";',
      'import objc from "std/objc";',
      "",
      "class Handler implements native.ZRegistrationHandler {",
      "  function receive(in owner: native.ZRegistrationOwner, value: i32): void as \"registrationOwner:didReceiveValue:\" {",
      "    if (value == -1) owner.removeHandlerForName(\"never\");",
      "  }",
      "}",
      "",
      "function register(in owner: native.ZRegistrationOwner): objc.Registration on thread.main {",
      "  const handler = new Handler({});",
      "  const registration = objc.register({",
      '    add: owner.addHandler(handler, "zapp"),',
      '    remove: owner.removeHandlerForName("zapp"),',
      "  });",
      "  return registration;",
      "}",
      "",
    ].join("\n"),
  );
  const objcContractExecution = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcSourcePath,
      "objc",
      resolve(directory, "objc-registration.m"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcContractExecution.status,
    0,
    objcContractExecution.stderr,
  );
  const objcRegistrationEmission = readFileSync(
    resolve(directory, "objc-registration.m"),
    "utf8",
  );
  assert.match(
    objcRegistrationEmission,
    /@interface ZObjCProtocolAdapter_Handler : NSObject <ZRegistrationHandler>/,
  );
  assert.match(
    objcRegistrationEmission,
    /_z_owner = Z_Handler_retain\(owner\)/,
  );
  assert.match(
    objcRegistrationEmission,
    /\[_z_object addHandler:_z_adapter name:argument_1\]/,
  );
  assert.match(
    objcRegistrationEmission,
    /\[_z_object removeHandlerForName:_z_stored_1\]/,
  );
  const objcRuntimeStub = resolve(directory, "objc-runtime-stub.h");
  writeFileSync(
    objcRuntimeStub,
    // Use the SDK identity: async output may also include libdispatch, whose
    // OS-object declarations import NSObject themselves.
    '#import <Foundation/NSObject.h>\n',
  );
  const objcRegistrationCompilation = spawnSync(
    "clang",
    [
      "-x",
      "objective-c",
      "-fobjc-arc",
      "-fsyntax-only",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-include",
      objcRuntimeStub,
      resolve(directory, "objc-registration.m"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcRegistrationCompilation.status,
    0,
    objcRegistrationCompilation.stderr,
  );
  const objcDirectSourcePath = resolve(directory, "objc-direct-input.zs");
  writeFileSync(
    objcDirectSourcePath,
    [
      'import native from "objc-registration-wire.h";',
      "",
      "function main(): i32 on thread.main {",
      "  const owner = native.ZRegistrationOwner.sharedOwner();",
      '  owner.removeHandlerForName("zapp");',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  const objcDirectEmissionPath = resolve(directory, "objc-direct.m");
  const objcDirectExecution = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcDirectSourcePath,
      "objc-direct",
      objcDirectEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(objcDirectExecution.status, 0, objcDirectExecution.stderr);
  const objcDirectEmission = readFileSync(objcDirectEmissionPath, "utf8");
  assert.match(
    objcDirectEmission,
    /#include "objc-registration-wire\.h"/,
  );
  assert.match(objcDirectEmission, /\[ZRegistrationOwner sharedOwner\]/);
  assert.match(
    objcDirectEmission,
    /ZRegistrationOwner \* const owner = \[ZRegistrationOwner sharedOwner\]/,
  );
  assert.match(
    objcDirectEmission,
    /\[owner removeHandlerForName: "zapp"\]/,
  );
  const objcDirectCompilation = spawnSync(
    "clang",
    [
      "-x",
      "objective-c",
      "-fobjc-arc",
      "-fsyntax-only",
      "-Wall",
      "-Wextra",
      "-Werror",
      objcDirectEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcDirectCompilation.status,
    0,
    objcDirectCompilation.stderr,
  );
  const objcNullableGuardSourcePath = resolve(
    directory,
    "objc-nullable-guard-input.zs",
  );
  writeFileSync(
    objcNullableGuardSourcePath,
    [
      'import native from "objc-registration-wire.h";',
      "",
      "function main(): i32 on thread.main {",
      "  const first: native.ZRegistrationOwner | null = native.ZRegistrationOwner.maybeOwner();",
      "  const second: native.ZRegistrationOwner | null = native.ZRegistrationOwner.maybeOwner();",
      "  if (first == null || second == null) return 0;",
      "  return first.compareOwner(second);",
      "}",
      "",
    ].join("\n"),
  );
  const objcNullableGuardEmissionPath = resolve(
    directory,
    "objc-nullable-guard.m",
  );
  const objcNullableGuardExecution = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcNullableGuardSourcePath,
      "objc-direct",
      objcNullableGuardEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcNullableGuardExecution.status,
    0,
    objcNullableGuardExecution.stderr,
  );
  const objcNullableGuardEmission = readFileSync(
    objcNullableGuardEmissionPath,
    "utf8",
  );
  assert.match(
    objcNullableGuardEmission,
    /\[first compareOwner: second\]/,
  );
  const objcNullableGuardCompilation = spawnSync(
    "clang",
    [
      "-x",
      "objective-c",
      "-fobjc-arc",
      "-fsyntax-only",
      "-Wall",
      "-Wextra",
      "-Werror",
      objcNullableGuardEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcNullableGuardCompilation.status,
    0,
    objcNullableGuardCompilation.stderr,
  );
  const objcAsyncObjectSourcePath = resolve(
    directory,
    "objc-async-object-input.zs",
  );
  writeFileSync(
    objcAsyncObjectSourcePath,
    [
      'import native from "objc-registration-wire.h";',
      'import { thread } from "std/thread";',
      "",
      "type OwnerOperation = async () => i32 on thread.main;",
      "",
      "async function compareOwners(): i32 on thread.main {",
      "  const owner = native.ZRegistrationOwner.sharedOwner();",
      "  const received = await owner.fetchOwner();",
      "  return owner.compareOwner(received);",
      "}",
      "",
      "function ownerOperation(): OwnerOperation on thread.main {",
      "  const operation: OwnerOperation = async () => await compareOwners();",
      "  return operation;",
      "}",
      "",
      "async function main(): i32 on thread.main {",
      "  const operation = ownerOperation();",
      "  return await operation();",
      "}",
      "",
    ].join("\n"),
  );
  const objcAsyncObjectEmissionPath = resolve(
    directory,
    "objc-async-object.m",
  );
  const objcAsyncObjectExecution = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcAsyncObjectSourcePath,
      "objc-direct",
      objcAsyncObjectEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcAsyncObjectExecution.status,
    0,
    objcAsyncObjectExecution.stderr,
  );
  const objcAsyncObjectEmission = readFileSync(
    objcAsyncObjectEmissionPath,
    "utf8",
  );
  assert.match(
    objcAsyncObjectEmission,
    /extern void objc_storeStrong\(id __strong \*location, id value\)/,
  );
  assert.match(
    objcAsyncObjectEmission,
    /z_stage1_objc_store_strong\(destination, z_stage1_objc_take\(&frame->result\)\)/,
  );
  assert.match(
    objcAsyncObjectEmission,
    /z_stage1_objc_store_strong\(\(void \*\)&_z_stage1_frame_binding_received, nil\)/,
  );
  assert.doesNotMatch(
    objcAsyncObjectEmission,
    /memcpy\(destination, \(const void \*\)&result, sizeof\(result\)\)/,
  );
  const objcAsyncObjectCompilation = spawnSync(
    "clang",
    [
      "-x",
      "objective-c",
      "-fobjc-arc",
      "-fsyntax-only",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-include",
      objcRuntimeStub,
      objcAsyncObjectEmissionPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcAsyncObjectCompilation.status,
    0,
    objcAsyncObjectCompilation.stderr,
  );
  const objcProtocolNegativePath = resolve(
    directory,
    "objc-protocol-negative.zs",
  );
  writeFileSync(
    objcProtocolNegativePath,
    [
      'import native from "objc-registration-wire.h";',
      'import objc from "std/objc";',
      "",
      "class Handler {",
      "}",
      "",
      "function register(in owner: native.ZRegistrationOwner): objc.Registration on thread.main {",
      "  const handler = new Handler({});",
      "  const registration = objc.register({",
      '    add: owner.addHandler(handler, "zapp"),',
      '    remove: owner.removeHandlerForName("zapp"),',
      "  });",
      "  return registration;",
      "}",
      "",
    ].join("\n"),
  );
  const objcProtocolNegative = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcProtocolNegativePath,
      "objc-protocol-negative",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcProtocolNegative.status,
    0,
    objcProtocolNegative.stderr,
  );
  const objcTeardownNegativePath = resolve(
    directory,
    "objc-teardown-negative.zs",
  );
  writeFileSync(
    objcTeardownNegativePath,
    [
      'import native from "objc-registration-wire.h";',
      'import objc from "std/objc";',
      "",
      "class Handler implements native.ZRegistrationHandler {",
      "}",
      "",
      "function register(in owner: native.ZRegistrationOwner): objc.Registration on thread.main {",
      "  const handler = new Handler({});",
      "  const registration = objc.register({",
      '    add: owner.addHandler(handler, "zapp"),',
      '    remove: owner.removeHandlerForName("other"),',
      "  });",
      "  return registration;",
      "}",
      "",
    ].join("\n"),
  );
  const objcTeardownNegative = spawnSync(
    contractExecutable,
    [
      objcPath,
      objcContractPath,
      objcTeardownNegativePath,
      "objc-teardown-negative",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    objcTeardownNegative.status,
    0,
    objcTeardownNegative.stderr,
  );
  const contractPath = resolve(
    projectRoot,
    "tests/fixtures/foreign-functions-only.h.zd",
  );
  const emittedForeignPath = resolve(directory, "foreign-application.c");
  const contractExecution = spawnSync(
    contractExecutable,
    [
      clangPath,
      contractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(contractExecution.status, 0, contractExecution.stderr);
  const emittedForeignSource = readFileSync(emittedForeignPath, "utf8");
  assert.match(
    emittedForeignSource,
    /#include "foreign-functions-only\.h"/,
  );
  assert.match(
    emittedForeignSource,
    /status = z_foreign_status\(parameter_0\);/,
  );
  assert.match(
    emittedForeignSource,
    /status == Z_FOREIGN_OK \|\| status == Z_FOREIGN_RETRY/,
  );
  assert.match(
    emittedForeignSource,
    /status = z_foreign_enum_status\(parameter_0\);/,
  );
  assert.match(
    emittedForeignSource,
    /status == Z_FOREIGN_ENUM_OK/,
  );
  assert.match(
    emittedForeignSource,
    /ZForeignStatus status = z_foreign_enum_status\(parameter_0\);/,
  );
  assert.match(
    emittedForeignSource,
    /typedef struct Z___z_Result_void_ZForeignStatus/,
  );
  assert.match(
    emittedForeignSource,
    /ZForeignStatus failure;/,
  );
  assert.match(
    emittedForeignSource,
    /z_foreign_status_code\(Z_FOREIGN_ENUM_OK\)/,
  );
  assert.match(
    emittedForeignSource,
    /z_foreign_status_code\(Z_FOREIGN_ENUM_FAILED\)/,
  );
  assert.match(
    emittedForeignSource,
    /z_foreign_text_length\(z_stage1_string_cstring\(label\)\)/,
  );
  assert.doesNotMatch(emittedForeignSource, /native\.z_foreign_add/);
  const foreignApplication = resolve(directory, "foreign-application");
  const foreignApplicationCompilation = spawnSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      resolve(projectRoot, "tests/fixtures"),
      emittedForeignPath,
      resolve(projectRoot, "tests/fixtures/foreign-functions-only.c"),
      "-o",
      foreignApplication,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    foreignApplicationCompilation.status,
    0,
    foreignApplicationCompilation.stderr,
  );
  const foreignApplicationExecution = spawnSync(
    foreignApplication,
    [],
    { encoding: "utf8" },
  );
  assert.equal(foreignApplicationExecution.status, 42);

  const wrongForeignArityPath = resolve(directory, "wrong-foreign-arity.zs");
  writeFileSync(
    wrongForeignArityPath,
    [
      'import { z_foreign_add as add } from "foreign-functions-only.h";',
      "function main(): i32 {",
      "  return add(1);",
      "}",
      "",
    ].join("\n"),
  );
  const wrongForeignArity = spawnSync(
    contractExecutable,
    [clangPath, contractPath, wrongForeignArityPath, emittedForeignPath],
    { encoding: "utf8" },
  );
  assert.equal(wrongForeignArity.status, 3);

  const unhandledForeignStatusPath = resolve(
    directory,
    "unhandled-foreign-status.zs",
  );
  writeFileSync(
    unhandledForeignStatusPath,
    [
      'import { z_foreign_status as status } from "foreign-functions-only.h";',
      "function main(): i32 {",
      "  status(0);",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  const unhandledForeignStatus = spawnSync(
    contractExecutable,
    [clangPath, contractPath, unhandledForeignStatusPath, emittedForeignPath],
    { encoding: "utf8" },
  );
  assert.equal(unhandledForeignStatus.status, 3);

  const invalidForeignEnumPath = resolve(
    directory,
    "invalid-foreign-enum.zs",
  );
  writeFileSync(
    invalidForeignEnumPath,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      "utf8",
    ).replace(
      "native.z_foreign_status_code(native.Z_FOREIGN_ENUM_OK)",
      "native.z_foreign_status_code(0)",
    ),
  );
  const invalidForeignEnum = spawnSync(
    contractExecutable,
    [clangPath, contractPath, invalidForeignEnumPath, emittedForeignPath],
    { encoding: "utf8" },
  );
  assert.equal(invalidForeignEnum.status, 3, invalidForeignEnum.stderr);

  const unsupportedContractPath = resolve(directory, "unsupported.zd");
  writeFileSync(
    unsupportedContractPath,
    readFileSync(contractPath, "utf8").replace(
      "): _;",
      "): _ { owned; }",
    ),
  );
  const unsupportedContract = spawnSync(
    contractExecutable,
    [
      clangPath,
      unsupportedContractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(unsupportedContract.status, 3);

  const incompleteStatusContractPath = resolve(
    directory,
    "incomplete-status.zd",
  );
  writeFileSync(
    incompleteStatusContractPath,
    readFileSync(contractPath, "utf8").replace(
      "    success Z_FOREIGN_OK;\n    success Z_FOREIGN_RETRY;\n",
      "",
    ),
  );
  const incompleteStatusContract = spawnSync(
    contractExecutable,
    [
      clangPath,
      incompleteStatusContractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(incompleteStatusContract.status, 3);

  const unknownStatusContractPath = resolve(directory, "unknown-status.zd");
  writeFileSync(
    unknownStatusContractPath,
    readFileSync(contractPath, "utf8").replace(
      "Z_FOREIGN_OK",
      "Z_FOREIGN_MISSING",
    ),
  );
  const unknownStatusContract = spawnSync(
    contractExecutable,
    [
      clangPath,
      unknownStatusContractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(unknownStatusContract.status, 3);

  const mismatchedStatusContractPath = resolve(
    directory,
    "mismatched-status.zd",
  );
  writeFileSync(
    mismatchedStatusContractPath,
    readFileSync(contractPath, "utf8").replace(
      "Z_FOREIGN_OK",
      "Z_FOREIGN_UNSIGNED",
    ),
  );
  const mismatchedStatusContract = spawnSync(
    contractExecutable,
    [
      clangPath,
      mismatchedStatusContractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(mismatchedStatusContract.status, 3);

  const mismatchedEnumStatusContractPath = resolve(
    directory,
    "mismatched-enum-status.zd",
  );
  writeFileSync(
    mismatchedEnumStatusContractPath,
    readFileSync(contractPath, "utf8").replace(
      "Z_FOREIGN_ENUM_OK",
      "Z_FOREIGN_OK",
    ),
  );
  const mismatchedEnumStatusContract = spawnSync(
    contractExecutable,
    [
      clangPath,
      mismatchedEnumStatusContractPath,
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(mismatchedEnumStatusContract.status, 3);

  const geometryStream = resolveForeignFunctionDeclarationStreams(
    [{
      ...foreignImport,
      header: "geometry.h",
    }],
    fixture,
    [resolve(projectRoot, "tests/fixtures")],
  );
  const geometryDeclarations = geometryStream.get("native");
  assert.ok(geometryDeclarations);
  const geometryTypeRecords = geometryDeclarations
    .split("\n")
    .filter((record) => record.startsWith("T"));
  assert.equal(
    geometryTypeRecords.filter((record) => /ZDirection/.test(record)).length,
    1,
  );
  assert.equal(
    geometryTypeRecords.filter((record) => /ZPoint/.test(record)).length,
    1,
  );
  assert.equal(
    geometryTypeRecords.filter(
      (record) => /scalar/.test(record) && /ZIdentifier/.test(record),
    ).length,
    1,
  );
  assert.ok(
    geometryDeclarations
      .split("\n")
      .some((record) => record.startsWith("D") && /x/.test(record)),
  );

  if (process.platform === "darwin") {
    const objcBlocks = spawnSync(
      process.execPath,
      [
        cli,
        "run",
        resolve(projectRoot, "tests/fixtures/objc-block-native.zs"),
      ],
      { encoding: "utf8" },
    );
    assert.equal(objcBlocks.status, 0, objcBlocks.stderr);
  }

  const truncatedPath = resolve(directory, "truncated.zfdcl");
  writeFileSync(truncatedPath, encoded.slice(0, -2));
  const truncated = spawnSync(executable, [truncatedPath], { encoding: "utf8" });
  assert.equal(truncated.status, 3, truncated.stderr);
}, 240_000);

// The standalone native driver, built once and shared by the tests below. Each
// test asks for it, so any one of them can run alone.
let standaloneDriverBuild: ReturnType<typeof buildStandaloneDriver> | undefined;
function standaloneDriver() {
  standaloneDriverBuild ??= buildStandaloneDriver();
  return standaloneDriverBuild;
}
function buildStandaloneDriver() {
  const driverSource = resolve(projectRoot, "compiler/driver/main.zs");
  const driverEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", driverSource],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(driverEmission.status, 0, driverEmission.stderr);
  const directory = mkdtempSync("/tmp/z-self-host-native-compiler-");
  const driver = resolve(directory, "z-native");
  const driverCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-O2", "-DNDEBUG", "-Wall", "-Wextra", "-Werror", "-", "-o", driver],
    { encoding: "utf8", input: driverEmission.stdout },
  );
  assert.equal(driverCompilation.status, 0, driverCompilation.stderr);
  const foreignAdapterEnvironment = {
    ...process.env,
    PATH: `${resolve(projectRoot, "compiler/bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  return { driverSource, driverEmission, directory, driver, foreignAdapterEnvironment };
}

test("emits and compiles the standalone native driver", () => {
  const { driverEmission } = standaloneDriver();
  assert.match(driverEmission.stdout, /Z___z_Result_void_String _z_function_\d+_loadModule\(/);
  assert.match(driverEmission.stdout, /Z___z_Result_String_String _z_function_\d+_emitModulesC\(/);
  assert.match(driverEmission.stdout, /z_stage1_fs_lock\(/);
  assert.match(driverEmission.stdout, /z_stage1_fs_replace\(/);
  assert.match(driverEmission.stdout, /Z_FsLock_deinit\(&\(cacheLock\)\)/);
  assert.match(driverEmission.stdout, /z_stage1_fs_real_path\(/);
  assert.match(driverEmission.stdout, /Z_STRING_LITERAL\("-O2"\)/);
  assert.match(driverEmission.stdout, /Z_STRING_LITERAL\("-DNDEBUG"\)/);
}, 300_000);

test("builds a library and plain fixtures through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  exerciseGeneratedAdapterLinking([driver]);
  const sharedRootProject = resolve(directory, "shared-root-project");
  mkdirSync(sharedRootProject);
  for (const file of ["library.zs", "z.json", "consumer.c"]) {
    copyFileSync(
      resolve(projectRoot, "tests/fixtures/shareable-once-library", file),
      resolve(sharedRootProject, file),
    );
  }
  const sharedRootBuild = spawnSync(driver, ["build", sharedRootProject, "--release"], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(sharedRootBuild.status, 0, sharedRootBuild.stderr || String(sharedRootBuild.error));
  const sharedRootConsumer = resolve(sharedRootProject, "consumer");
  const sharedRootCompilation = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
    "-I", resolve(sharedRootProject, "build"), resolve(sharedRootProject, "consumer.c"),
    resolve(sharedRootProject, "build/libshared_root.a"), "-o", sharedRootConsumer,
  ], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  assert.equal(sharedRootCompilation.status, 0, sharedRootCompilation.stderr);
  const sharedRootRun = spawnSync(sharedRootConsumer, [], {
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
  });
  assert.equal(sharedRootRun.status, 0, sharedRootRun.stderr || String(sharedRootRun.error));
  assert.equal(sharedRootRun.stdout, "released shared root\nworker-first lifecycle ok\n");

  // A shared root cannot erase an unrelated main-bound requirement in the library.
  const sharedRootEntry = resolve(sharedRootProject, "library.zs");
  writeFileSync(sharedRootEntry, readFileSync(sharedRootEntry, "utf8")
    + "\nclass MainIdentity on thread.main { readonly value: i32; }\n");
  const mixedRootBuild = spawnSync(driver, ["build", sharedRootProject], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(mixedRootBuild.status, 0, mixedRootBuild.stderr || String(mixedRootBuild.error));
  const mixedRootHeader = readFileSync(resolve(sharedRootProject, "build/shared_root.h"), "utf8");
  assert.match(mixedRootHeader, /SHARED_ROOT_RUNTIME_REQUIRES_MAIN_THREAD 1/);
  assert.match(mixedRootHeader, /SHARED_ROOT_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1/);
  // Flags after `--` reach the C compiler and belong to the build cache key, so a
  // flagged build neither reuses the plain artifact nor poisons the next plain one.
  const rejectedFlagBuild = spawnSync(driver, ["build", sharedRootProject, "--", "-fthis-flag-does-not-exist"], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.notEqual(rejectedFlagBuild.status, 0);
  assert.match(`${rejectedFlagBuild.stderr}${rejectedFlagBuild.stdout}`, /unknown argument/);
  const flaggedBuild = spawnSync(driver, ["build", sharedRootProject, "--", "-DZ_EXTRA_FLAG_PROBE=1"], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(flaggedBuild.status, 0, flaggedBuild.stderr || String(flaggedBuild.error));
  assert.doesNotMatch(flaggedBuild.stdout, /cache hit/);
  const plainAfterFlagged = spawnSync(driver, ["build", sharedRootProject], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(plainAfterFlagged.status, 0, plainAfterFlagged.stderr || String(plainAfterFlagged.error));
  assert.doesNotMatch(plainAfterFlagged.stdout, /cache hit/);

  const readonlyLengthFixture = resolve(projectRoot, "tests/fixtures/self-host-emit-readonly-collection-length.zs");
  for (const operation of ["check", "metadata", "run"]) {
    const result = spawnSync(driver, [operation, readonlyLengthFixture], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    if (operation === "run") {
      assert.equal(result.stdout.replace(/^compiled [^\n]*\n/, ""),
        "callback 2/1/2\nviews 2/1/2\ncopy 2; original 2\ndetached kept\ncustom ordinary field\n");
    }
  }
  const contentHashRun = spawnSync(
    driver,
    [
      "run",
      resolve(projectRoot, "tests/fixtures/self-host-content-hash.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(contentHashRun.status, 0, contentHashRun.stderr);

  // C variadic calls: promoted scalars, String and template text lent as
  // cstrings, and fixed-array length, with Stage 0's output and diagnostics.
  const variadicFixture = resolve(projectRoot, "tests/fixtures/native-variadic-calls.zs");
  const variadicExpected = "plain\n3 1.5 0.5 1\nzed|literal|tmpl3\n7 -2147483647 4 4\nloop 0;loop 1;loop 2;\n";
  const stage0Variadic = spawnSync(process.execPath, [cli, "run", variadicFixture], { encoding: "utf8" });
  assert.equal(stage0Variadic.status, 0, stage0Variadic.stderr);
  assert.equal(stage0Variadic.stdout, variadicExpected);
  const variadicProgram = resolve(directory, "variadic");
  const variadicBuild = spawnSync(driver, ["build", variadicFixture, variadicProgram], {
    encoding: "utf8", env: foreignAdapterEnvironment, timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(variadicBuild.status, 0, variadicBuild.stderr);
  // Each loop iteration's template temporary is destroyed exactly once.
  const sanitizedVariadic = resolve(directory, "variadic-sanitized");
  const sanitizedVariadicBuild = spawnSync("clang", [
    "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined",
    "-fno-sanitize-recover=all", `${variadicProgram}.c`, "-o", sanitizedVariadic,
  ], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  assert.equal(sanitizedVariadicBuild.status, 0, sanitizedVariadicBuild.stderr);
  for (const program of [variadicProgram, sanitizedVariadic]) {
    const run = spawnSync(program, [], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, variadicExpected);
  }
  const variadicRejections: [string, string][] = [
    ["stdio.printf();", 'C function "printf" expects at least 1 argument(s), found 0'],
    ['stdio.printf("%d", Point({ x: 1 }));', 'unsupported variadic argument type Point for C function "printf"'],
    ['stdio.printf("%d", inout counter);', "inout is only valid for a classified imported C record-pointer parameter"],
    ['stdio.printf("%lld", 5000000000);', "variadic integer literal 5000000000 does not fit default i32; bind it to an explicit integer type first"],
  ];
  const variadicRejection = resolve(directory, "variadic-rejection.zs");
  for (const [statement, message] of variadicRejections) {
    writeFileSync(variadicRejection, [
      'import stdio from "stdio.h";',
      "struct Point { x: i32; }",
      "function main(): i32 {",
      "  let counter: i32 = 1;",
      `  ${statement}`,
      "  return counter - 1;",
      "}",
      "",
    ].join("\n"));
    const stage0Rejection = spawnSync(process.execPath, [cli, "check", variadicRejection], { encoding: "utf8" });
    const nativeRejection = spawnSync(driver, ["check", variadicRejection], {
      encoding: "utf8", env: foreignAdapterEnvironment,
    });
    for (const [tier, result] of [["stage0", stage0Rejection], ["native", nativeRejection]] as const) {
      assert.equal(result.status, 1, `${tier}: ${statement}`);
      assert.ok(result.stderr.includes(`5:`) && result.stderr.includes(message), `${tier}: ${result.stderr}`);
    }
  }

  // Programs the parity census found broken natively now match Stage 0:
  // destructor lifetimes, view results and captures, literal conversions,
  // exported enum aliases, imported frameworks, and objc.connect closures.
}, 300_000);

test("runs the parity fixtures identically through Stage 0 and the standalone native driver", () => {
  const { driver, foreignAdapterEnvironment } = standaloneDriver();
  const parityRuns = [
    "tests/fixtures/native-ownership-lifetimes.zs",
    "tests/fixtures/native-view-results.zs",
    "tests/fixtures/native-numeric-conversion-literals.zs",
    "tests/fixtures/native-exported-enum-alias/main.zs",
    "tests/fixtures/self-host-imported-function-value",
    "tests/fixtures/objc-class-protocol-collision.zs",
    "tests/fixtures/objc-notification-main-callback.zs",
    "tests/fixtures/objc-connection-array.zs",
    "examples/language/ownership/consuming-methods.zs",
    "examples/language/ownership/replacement.zs",
    "examples/language/ownership/optional-views.zs",
    "examples/language/ownership/parameter-views.zs",
    "examples/interop/c/native-out.zs",
    "examples/interop/c/deployment-target",
    // Native crashes the census found, now executed.
    "examples/interop/objc/target-action.zs",
    "tests/fixtures/objc-autorelease-pool.zs",
    "tests/fixtures/self-host-program-metadata-alias-constructor.zs",
    "tests/fixtures/native-imported-callable-alias/main.zs",
    // Copyable C++ values: inline storage, constructors, static and member
    // calls, with C++ copy and destruction counts matching Stage 0.
    "examples/interop/cpp/foreign-values.zs",
    "examples/interop/cpp/cpp-callables.zs",
    // Move-only C++ values: std::move at Z move points and C++ references,
    // with C++ move counts matching Stage 0.
    "examples/interop/cpp/cpp-move-only.zs",
    "examples/interop/cpp/cpp-references.zs",
    "tests/fixtures/native-cpp-option.zs",
    "examples/language/collections/map-native-values.zs",
    "examples/interop/cpp/cpp-arena.zs",
    "examples/applications/document-workspace/main.zs",
    "tests/fixtures/native-element-mutation.zs",
    "tests/fixtures/native-view-receiver.zs",
    // C++ values in general async frames: parameters, locals, results,
    // `try` propagation, borrows, and cancellation release.
    "examples/async/async-native-parameters.zs",
    "examples/async/async-native-ownership.zs",
    "examples/async/async-native-aggregate.zs",
    "examples/async/async-borrowing.zs",
    "examples/async/async-caller-cancellation.zs",
    // Synchronous generators: lazy start, `next()` steps, `for...of`,
    // completion values, thrown errors, and owner release on completion or drop.
    "examples/language/control-flow/generators.zs",
    "examples/language/control-flow/generator-return.zs",
    "examples/language/control-flow/generator-throws.zs",
    "tests/fixtures/native-generator-frames.zs",
    // Async generators: persistent stream frames stepped by `await next()`
    // and `for await`, typed errors, and owner release on finish or drop.
    "examples/language/control-flow/async-generators.zs",
    "examples/language/control-flow/async-for-await.zs",
    "examples/language/control-flow/async-for-await-errors.zs",
    "tests/fixtures/native-async-generator-frames.zs",
    // `on thread.main` placement from `main`: placed calls, awaits, tasks, and
    // `using` blocks run where they are, as in Stage 0.
    "examples/async/executor-placement.zs",
    "examples/async/appkit-main-result.zs",
    "tests/fixtures/native-main-placement.zs",
    // `thread.spawn` workers joined from async functions and general frames:
    // results, typed errors, and cancelling joins.
    "examples/async/thread-errors.zs",
    "examples/async/thread-spawn.zs",
    "tests/fixtures/native-frame-thread-awaits.zs",
    // Async worker bodies run as lifted general frames on the worker's
    // executor: awaits, delays, spawned children, owned captures, typed
    // errors, and prompt cancellation of a sleeping worker.
    "tests/fixtures/native-async-worker-frames.zs",
    // Outside `main`, `await on thread.main { ... }` hops: the block runs as
    // its own frame on the main executor and is awaited across executors,
    // with copied captures, typed errors, and cancellation routed to main.
    "examples/async/thread-affine-worker.zs",
    "tests/fixtures/native-main-hops.zs",
    // `await on thread.main f(...)` outside `main` hops too: synchronous,
    // throwing, and main-affine looping callees, from main and a worker.
    "tests/fixtures/native-main-hop-calls.zs",
    "examples/async/thread-main-loop.zs",
    // `task on thread.main ...` spawns a hopped child that its frame joins:
    // from a synchronous worker body (lifted to a frame), an async worker, an
    // ordinary async function, and `main` itself.
    "examples/async/thread-main-placement.zs",
    "tests/fixtures/native-main-task-hops.zs",
    // A worker's placed child runs while `main` is inside the Darwin main
    // run loop: work posted to the main executor also wakes the main queue.
    "examples/async/darwin-main-run-loop.zs",
    // A hopped block's `using (in|inout|move ...)` captures: the caller's
    // storage is lent for the block, or the value moves to it.
    "tests/fixtures/native-main-hop-capabilities.zs",
    // A synchronous worker owns its captures: copies it may assign, and
    // moved Array, String, TextBuffer, and aggregate owners released once.
    "examples/async/thread-text.zs",
    "examples/async/thread-transfer.zs",
    "tests/fixtures/native-worker-owned-captures.zs",
    // An expression-bodied worker's await is the worker's, also when the
    // spawning function suspends in a frame of its own.
    "tests/fixtures/native-worker-expression-frame.zs",
    // A placed block with no declared result takes its final `select`'s type.
    "tests/fixtures/native-main-select-results.zs",
    // `TaskScope.schedule` with a synchronous operation: one job on the
    // scope's executor, from main and from a worker thread.
    "tests/fixtures/native-task-scope-sync-jobs.zs",
    // A scheduled operation written as a block runs as a frame of its own;
    // `await scope.close()` and `await scope.cancel()` suspend the function.
    "tests/fixtures/native-async-block-operations.zs",
    // A foreign thread's callbacks submit synchronous and block-bodied async
    // operations to a named scope, after an explicit scope is cancelled.
    "examples/async/task-scope-native-callback.zs",
    // A block-bodied async closure is a reusable value: each call runs the
    // block as a frame, and captured state carries over to the next call.
    "tests/fixtures/native-async-block-closures.zs",
    "tests/fixtures/native-async-inout-methods.zs",
    "tests/fixtures/native-generic-inferred-types/main.zs",
    // A Mutex passed on by value moves to the callee, which drops it; a
    // channel sender is shared, and the channel is released with its last
    // holder.
    "tests/fixtures/native-shared-handle-release.zs",
    // A scope and its controls passed on, returned, and captured.
    "tests/fixtures/native-scope-handle-references.zs",
    // A named `async scope` owns a `TaskScope` handle: every way out of the
    // scope joins its operations, and a throw or cancellation cancels them.
    "tests/fixtures/native-async-named-scope.zs",
    // A foreign thread's callback submits to a named scope that `main` joins.
    "examples/async/foreign-thread-application-root.zs",
    // `break` and `continue` join an `async scope`'s children before leaving it.
    "tests/fixtures/native-async-scope-leave.zs",
    // A function joins each `new TaskScope()` it created before it completes.
    "tests/fixtures/native-async-owned-task-scope.zs",
    // A failed `try` cancels and joins a named scope's operations; a `return`
    // evaluates its value before the scope joins its children.
    "tests/fixtures/native-async-scope-failure.zs",
  ];
  for (const entry of parityRuns) {
    const path = resolve(projectRoot, entry);
    const stage0Run = spawnSync(process.execPath, [cli, "run", path], { encoding: "utf8", timeout: 120_000 });
    assert.equal(stage0Run.status, 0, `${entry} stage0: ${stage0Run.stderr}`);
    const nativeRun = spawnSync(driver, ["run", path], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(nativeRun.status, 0, `${entry} native: ${nativeRun.stderr}`);
    assert.equal(nativeRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), stage0Run.stdout, entry);
  }
}, 600_000);

test("runs native-only fixtures and reports tier limits through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  // A void expression closure runs its body as a statement.
  const voidClosureRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-void-expression-closure.zs")], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(voidClosureRun.status, 0, voidClosureRun.stderr);
  assert.equal(voidClosureRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), "applied\nannounced\n");
  // Owned captures and parameters of a reusable async closure: Stage 0 stops
  // at its own limits here (it emits invalid C for an owned capture, and
  // rejects `push` on a captured `let` collection).
  const closureOwnersRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-async-block-closure-owners.zs")], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(closureOwnersRun.status, 0, closureOwnersRun.stderr);
  assert.equal(closureOwnersRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""),
    "handled first 21\nhandled first 21\nhandler 42 42\nnamed ab 2\nnamed abc1 4\nnamer 2 4\ncollector 1 2\ntally 2\nshown 1 2\nshown 1 2\nloaded alpha\nfailed: loaded needs a name\n");
  // `async scope` as a value: Stage 0 is frozen and does not parse it.
  const scopeValuesRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-async-scope-values.zs")], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(scopeValuesRun.status, 0, scopeValuesRun.stderr);
  assert.equal(scopeValuesRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), [
    "loaded 1", "loaded 2", "sum after scope 3", "sum 3",
    "noted early", "branches after scope 10", "noted late", "loaded 20", "branches after scope 20", "branches 10 20",
    "noted text", "text built 4",
    "operation 1", "operation 2", "named after scope 2", "named 2",
    "noted returns", "noted returns", "returns -1 8",
    "slow 9 started", "failing failed",
    "noted round 0", "noted round 1", "noted round 2", "loops 102",
    "loaded 3", "noted inner", "nested 4",
    "loaded 4", "noted layered", "layered 5",
    "noted through early", "through after scope 30", "noted through late", "through after scope 40", "through 30 40",
    "noted matched", "matched 2", "",
  ].join("\n"));
  // Inside a larger statement the scope runs first and the statement reads
  // its value: `return`, assignment, arguments, operands, conditions.
  const scopePositionsRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-async-scope-value-positions.zs")], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(scopePositionsRun.status, 0, scopePositionsRun.stderr);
  assert.equal(scopePositionsRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), [
    "loaded 1", "loaded 2", "returned 3",
    "noted returned text", "returned text built 3",
    "operation 1", "operation 2", "returned named true",
    "slow 9 started", "returned failure failed",
    "noted assigned", "assigned after 6",
    "loaded 3", "loaded 4", "noted argument", "size 4", "arguments 7",
    "noted round 0", "noted round 1", "noted template", "interpolated 9", "operands 6",
    "loaded 5", "condition true",
    "noted outer", "loaded 6", "selected 6", "",
  ].join("\n"));
  // The Stage 0 parser stops at this form, so its rules are checked here,
  // through the driver, rather than through the Stage 0-hosted commands.
  const scopeValueProgram = (body: string, signature = "async function main(): i32") => `
    async function load(value: i32): i32 { return value; }
    function id(value: i32): i32 { return value; }
    enum Kind { one, two }
    ${signature} {
      ${body}
      return 0;
    }
  `;
  const scopeValueRejects: [string, RegExp, string?][] = [
    ["const v = async scope { select 1; id(2); };", /nothing may follow `select` in its block: it leaves the scope/],
    ["const v = async scope { task load(1); };", /must `select` a value on every path/],
    ["const early = true; const v = async scope { task load(1); if (early) { select 1; } };",
      /must `select` a value on every path/],
    ["const early = true; const v = async scope { if (early) { select \"text\"; } select 1; };",
      /expected String, found i32/],
    ["const v: String = async scope { select 1; };", /expected String, found i32/],
    ["let round = 0; while (round < 2) { const v = async scope { if (round == 1) break; select 1; }; round = round + 1; }",
      /cannot be left with `break` or `continue`/],
    // Where the scope would run conditionally, repeatedly, or in a closure.
    ["const flag = true; const v = flag ? async scope { select 1; } : id(0);",
      /error\[Z1000\]: a value-producing async scope is not executable here in the native compiler yet/],
    ["while (async scope { select false; }) { }",
      /error\[Z1000\]: a value-producing async scope is not executable here in the native compiler yet/],
    ["const run = async (): i32 => async scope { select 1; };",
      /error\[Z1000\]: a value-producing async scope is not executable here in the native compiler yet/],
    // A `select` in a `match` arm gives the arm's value, not the scope's.
    ["const kind = Kind.two; const v = async scope { match (kind) { one => { select 1; } two => { select 2; } } };",
      /must `select` a value on every path/],
    ["const v = async scope { select 1; };", /error\[Z0703\]: async scope requires an enclosing async function/,
      "function main(): i32"],
    ["const updates = 1; const v = async scope updates { select 1; };", /duplicate local "updates"/],
    ["const v = async scope updates { select 1; }; const again = updates;", /unknown name updates/],
  ];
  const scopeValueReject = resolve(directory, "scope-value-reject.zs");
  for (const [body, message, signature] of scopeValueRejects) {
    writeFileSync(scopeValueReject, scopeValueProgram(body, signature));
    const result = spawnSync(driver, ["check", scopeValueReject], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    assert.equal(result.status, 1, `${body}: ${result.stderr}`);
    assert.match(result.stderr, message, body);
    assert.match(result.stderr, /scope-value-reject\.zs:\d+:\d+:/, body);
    assert.doesNotMatch(result.stderr, /internal compiler error/, body);
  }
  // Stage 0 stops at an async-frame tier limit here; native runs it.
  const importedAliasRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/self-host-imported-thread-main-alias/main.zs")], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(importedAliasRun.status, 0, importedAliasRun.stderr);
  // Native tier limits are located diagnostics, not lowering failures.
  const tierLimits: [string, RegExp][] = [
    ["examples/interop/objc/protocol-conformance.zs", /error\[Z1000\]: objc\.bind is not executable in the native compiler yet/],
    ["tests/fixtures/objc-autorelease-pool-async.zs", /error\[Z1000\]: objc\.pool with an expression-bodied closure is not executable in the native compiler yet/],
    ["examples/async/member-affinity.zs", /error\[Z1000\]: thread\.spawn cannot carry main-isolated capture "application" of type Application in the native compiler yet/],
    // A synchronous worker's context is C storage, which cannot hold a C++ value.
    ["examples/async/thread-native.zs", /error\[Z1000\]: ownership-bearing thread\.spawn capture "measurement" of type "native\.zcpp\.UniqueValue" is not executable in the native compiler yet/],
    // Namespaces and overloads check natively; aggregate interpolation is a separate tier.
    ["examples/interop/cpp/cpp-interop.zs", /12:121: error\[Z1000\]: template interpolation of "cpp\.zcpp\.Point" is not executable in the native compiler yet/],
  ];
  for (const [entry, message] of tierLimits) {
    const result = spawnSync(driver, ["check", resolve(projectRoot, entry)], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
    assert.match(result.stderr, message, entry);
    assert.doesNotMatch(result.stderr, /internal compiler error/, entry);
  }
  // Emitted C is also valid C++20, so a C++ header import compiles the
  // program as C++ (this header is not valid C).
  const cppHeaderRun = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-cpp-header/main.zs")], {
    encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
  });
  assert.equal(cppHeaderRun.status, 0, cppHeaderRun.stderr);
  assert.equal(cppHeaderRun.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), "total=42\n");
  // C++ namespaces and overloads follow Stage 0: qualified paths, unique leaf
  // aliases, selective namespace imports, and per-call overload choice.
  const cppNamespaces = resolve(projectRoot, "tests/fixtures/native-cpp-namespaces/main.zs");
  for (const [entry, expected] of [
    [cppNamespaces, "area=42 tag=40 narrow=42 wide=5\nsigned=4 unsigned=6 deep=203 local=6 span=21\n"],
    [resolve(projectRoot, "examples/interop/cpp/cpp-selective-interop.zs"), "selective cpp=42, adjusted=40\n"],
  ]) {
    const run = spawnSync(driver, ["run", entry], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(run.status, 0, `${entry}: ${run.stderr}`);
    assert.equal(run.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), expected, entry);
  }
  const cppNamespaceSource = readFileSync(cppNamespaces, "utf8");
  copyFileSync(resolve(dirname(cppNamespaces), "shapes.hpp"), resolve(directory, "shapes.hpp"));
  const cppNamespaceVariant = resolve(directory, "cpp-namespace-variant.zs");
  for (const [from, to, message] of [
    ["shapes.geometry.pick(u64(5))", "shapes.geometry.pick(5)", '11:45: error[Z0803]: call to foreign function "geometry.pick" is ambiguous'],
    ['g.widen(2.0)', 'g.widen("x")', '9:28: error[Z0803]: no overload of foreign function "geometry.widen" accepts these arguments'],
    ["labels.Point({ id: 4 })", "shapes.Point({ id: 4 })", '7:24: error: native type "Point" is ambiguous across C++ namespaces'],
    ["labels.Point({ id: 4 })", 'labels.Point({ id: "x" })', "7:36: error: expected i32, found String"],
    ["const point: shapes.geometry.Point", "const point: shapes.labels.Point", "6:59: error: expected shapes.labels.Point, found shapes.geometry.Point"],
    ["shapes.geometry.inner.depth(1)", "shapes.geometry.missing(1)", '12:32: error: native contract for "shapes.hpp" has no checked function "geometry.missing"'],
  ]) {
    assert.ok(cppNamespaceSource.includes(from), from);
    writeFileSync(cppNamespaceVariant, cppNamespaceSource.replace(from, to));
    const rejection = spawnSync(driver, ["check", cppNamespaceVariant], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(rejection.status, 1, `${to}: ${rejection.stderr}`);
    assert.ok(rejection.stderr.includes(`${cppNamespaceVariant}:${message}`), `${to}: ${rejection.stderr}`);
  }
  // C++ value members follow Stage 0's overload choice, receiver access, and
  // messages; C++ values in union or heap storage are a later tier.
}, 300_000);

test("follows Stage 0 on C++ values through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const foreignValuesEntry = resolve(projectRoot, "examples/interop/cpp/foreign-values.zs");
  const foreignValuesSource = readFileSync(foreignValuesEntry, "utf8")
    .replace("../../../tests/fixtures/foreign-values.hpp", resolve(projectRoot, "tests/fixtures/foreign-values.hpp"));
  const foreignValuesVariant = resolve(directory, "foreign-values-variant.zs");
  for (const [from, to, expected] of [
    ["copied.value.value()", "copied.value.plus(0)", "answer=42, copies=2, drops=3, live=0\n"],
    ["copied.value.value()", "copied.value.plus(2.5) > 1.0 ? 1 : 0", "answer=1, copies=2, drops=3, live=0\n"],
    ["copied.value.value()", 'copied.value.plus("no")', '13:27: error[Z0803]: no overload of native method "zcpp.ManagedValue.plus" accepts these arguments'],
    ["let copied = owner;", "const copied = owner;", '12:10: error: mutable native method "add" requires addressable let storage'],
    ["struct NativeOwner {", "class NativeOwner {", '10:9: error[Z1000]: C++ value "zcpp::ManagedValue" stored in a class, Option, Result, enum payload, or collection is not executable in the native compiler yet'],
  ]) {
    assert.ok(foreignValuesSource.includes(from), from);
    let variantSource = foreignValuesSource.replace(from, to);
    if (to.startsWith("class ")) variantSource = variantSource.replace("NativeOwner({", "new NativeOwner({");
    writeFileSync(foreignValuesVariant, variantSource);
    const run = spawnSync(driver, ["run", foreignValuesVariant], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
    });
    if (expected.endsWith("\n")) {
      assert.equal(run.status, 0, `${to}: ${run.stderr}`);
      assert.equal(run.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), expected, to);
    } else {
      assert.notEqual(run.status, 0, `${to}: ${run.stdout}`);
      assert.ok(run.stderr.includes(`${foreignValuesVariant}:${expected}`), `${to}: ${run.stderr}`);
    }
  }
  // A conditional move of Z-cleanup + move-only C++ storage clears the Z
  // liveness flag and C++-moves the value (Stage 0 cannot compile this one).
  const mixedMove = spawnSync(driver, ["run", resolve(projectRoot, "tests/fixtures/native-cpp-move-mixed.zs")], {
    encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
  });
  assert.equal(mixedMove.status, 0, mixedMove.stderr);
  assert.equal(mixedMove.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), "taken=53 kept=1 moves=1 live=0\n");
  // Arrays construct, relocate, and destroy C++ elements in place. Move counts
  // depend on the growth policy (Stage 0 starts at 4, native at 8), so the
  // count is matched as Stage 0's own test does. Stage 0's clear() leaks
  // copyable C++ elements, so the copyable fixture is native-only.
  for (const [entry, expected] of [
    ["examples/interop/cpp/cpp-move-only-array.zs", /^array answer=42, moves=[1-9][0-9]*, live=0\n$/],
    // C++-payload enums elide a staged replacement move Stage 0 performs.
    ["examples/interop/cpp/cpp-move-only-enum.zs", /^enum answer=42, moves=[1-9][0-9]*, live=0\n$/],
    ["tests/fixtures/native-cpp-array-values.zs", /^len=1 copies=3 drops=5 live=1\n$/],
  ] as const) {
    const run = spawnSync(driver, ["run", resolve(projectRoot, entry)], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(run.status, 0, `${entry}: ${run.stderr}`);
    assert.match(run.stdout.replace(/^(compiled|cache hit)[^\n]*\n/gm, ""), expected, entry);
  }
  // Move-only native storage follows Stage 0's ownership rules (Z0240).
  const moveOnlyProbe = resolve(directory, "move-only-probe.zs");
  for (const [body, message] of [
    ["function main(): i32 {\n  const first = native.zcpp.UniqueValue(42);\n  const second = first;\n  return first.value();\n}\n", '5:10: error: use of moved value "first"'],
    ["class Session {\n  value: native.zcpp.UniqueValue;\n}\nfunction main(): i32 { return 0; }\n", "3:10: error[Z0240]: ARC class fields cannot store move-only native values in the first C++ ownership tier"],
    ["function main(): i32 {\n  let value: native.zcpp.UniqueValue;\n  return 0;\n}\n", "3:14: error[Z0240]: move-only native values must be initialized when their storage is declared"],
    ["function fill(out value: native.zcpp.UniqueValue): void {\n}\nfunction main(): i32 { return 0; }\n", '2:19: error[Z0240]: out parameter "value" cannot use move-only native storage in the first C++ ownership tier'],
  ]) {
    writeFileSync(moveOnlyProbe, `import native from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};\n${body}`);
    const checked = spawnSync(driver, ["check", moveOnlyProbe], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(checked.status, 1, `${body}: ${checked.stderr}`);
    assert.ok(checked.stderr.includes(`${moveOnlyProbe}:${message}`), `${body}: ${checked.stderr}`);
  }
  // C++ value-type `.zd` facts (`copy;`, bare `deinit;`, `thread { }`) parse
  // with Stage 0's validation, code, and locations.
  copyFileSync(resolve(projectRoot, "tests/fixtures/move-only.hpp"), resolve(directory, "move-only.hpp"));
  const valueContractEntry = resolve(directory, "value-contract.zs");
  writeFileSync(valueContractEntry, 'import native from "move-only.hpp";\nfunction main(): i32 {\n  return 0;\n}\n');
  const valueContractPath = resolve(directory, "move-only.hpp.zd");
  for (const [facts, message] of [
    ["move;\n    deinit;\n    thread {\n      transfer;\n      deinit;\n    }", ""],
    ["copy;\n    copy;\n    deinit;", '4:5: error[Z0801]: foreign type "zcpp.UniqueValue" cannot declare copy more than once'],
    ["move;", '2:10: error[Z0801]: foreign value type "zcpp.UniqueValue" must declare deterministic deinit'],
    ["deinit;", '2:10: error[Z0801]: foreign value type "zcpp.UniqueValue" must declare copy or move'],
    ["move;\n    deinit;\n    flip;", '5:5: error[Z0801]: expected "copy", "move", "deinit", "thread", "project", or "discriminant" in foreign type contract, found "flip"'],
    ["move;\n    deinit;\n    thread {\n      transfer;\n      share;\n    }", '7:7: error[Z0801]: foreign type "zcpp.UniqueValue" thread contract cannot declare both transfer and share; share already implies transfer'],
    ["move;\n    deinit;\n    thread {\n      deinit;\n    }", '5:5: error[Z0801]: foreign type "zcpp.UniqueValue" thread contract requires transfer or share'],
  ]) {
    writeFileSync(valueContractPath, `declare module "move-only.hpp" {\n  export type zcpp.UniqueValue {\n    ${facts}\n  }\n}\n`);
    const checked = spawnSync(driver, ["check", valueContractEntry], {
      encoding: "utf8", env: foreignAdapterEnvironment, timeout: 60_000, killSignal: "SIGKILL",
    });
    if (message.length === 0) {
      assert.equal(checked.status, 0, `${facts}: ${checked.stderr}`);
    } else {
      assert.equal(checked.status, 1, `${facts}: ${checked.stderr}`);
      assert.ok(checked.stderr.includes(`${valueContractPath}:${message}`), `${facts}: ${checked.stderr}`);
    }
  }
  for (const entry of [
    "compiler/driver/main.zs",
    "tests/fixtures/borrowed-aggregate-temporaries.zs",
    "tests/fixtures/native-ownership-lifetimes.zs",
    "tests/fixtures/self-host-channel-sync.zs",
    "tests/fixtures/async-linear-scope-join.zs",
    "examples/language/basics/closures.zs",
    "examples/language/basics/mutable-methods.zs",
    "examples/language/control-flow/result.zs",
  ]) {
    const emitted = spawnSync(driver, ["emit", resolve(projectRoot, entry)], {
      encoding: "utf8", env: foreignAdapterEnvironment, maxBuffer: 64 * 1024 * 1024, timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(emitted.status, 0, `${entry}: ${emitted.stderr}`);
    for (const language of [["-x", "c", "-std=c11"], ["-x", "c++", "-std=c++20", "-Wc99-designator"]]) {
      const checked = spawnSync("clang", [
        ...language, "-Wall", "-Wextra", "-Werror", "-fsyntax-only",
        "-I", dirname(resolve(projectRoot, entry)), "-",
      ], { input: emitted.stdout, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
      assert.equal(checked.status, 0, `${entry} as ${language[1]}: ${checked.stderr}`);
    }
  }

  const internalProject = resolve(directory, "internal-project");
  const internalFramework = resolve(internalProject, "framework");
  const internalApplication = resolve(internalProject, "application");
  mkdirSync(internalProject);
  mkdirSync(internalFramework);
  mkdirSync(resolve(internalFramework, "src"));
  mkdirSync(internalApplication);
  writeFileSync(resolve(internalFramework, "src/internals.zs"), [
    "internal const PACKAGE_BONUS: i32 = 0;",
    "internal struct PackageValue { value: i32; }",
    "internal function packageAnswer(): PackageValue {",
    "  return PackageValue({ value: 42 });",
    "}",
    "export struct PublicCounter {",
    "  function publicValue(): i32 { return 42; }",
    "  internal function secret(): i32 { return 1; }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(resolve(internalFramework, "src/api.zs"), [
    'import internals from "./internals.zs";',
    "export function answer(): i32 {",
    "  const packaged = internals.packageAnswer();",
    "  return packaged.value + internals.PACKAGE_BONUS;",
    "}",
    "",
  ].join("\n"));
  writeFileSync(resolve(internalFramework, "z.json"), JSON.stringify({
    package: { name: "framework", version: "0.1.0" },
    library: {
      entry: "src/api.zs",
      exports: { "./internals": "src/internals.zs" },
    },
  }));
  writeFileSync(resolve(internalApplication, "main.zs"), [
    'import { answer } from "framework";',
    "function main(): i32 { return answer() - 42; }",
    "",
  ].join("\n"));
  writeFileSync(resolve(internalApplication, "z.json"), JSON.stringify({
    dependencies: { framework: { path: "../framework" } },
    target: { name: "internal-application", entry: "main.zs" },
  }));
  const internalRun = spawnSync(
    driver,
    ["run", internalApplication],
    { encoding: "utf8" },
  );
  assert.equal(internalRun.status, 0, internalRun.stderr);
  const internalMetadata = spawnSync(
    driver,
    ["metadata", internalApplication],
    { encoding: "utf8" },
  );
  assert.equal(internalMetadata.status, 0, internalMetadata.stderr);
  assert.match(internalMetadata.stdout, /publicValue/);
  assert.doesNotMatch(
    internalMetadata.stdout,
    /packageAnswer|PACKAGE_BONUS|PackageValue|secret/,
  );
  writeFileSync(resolve(internalApplication, "main.zs"), [
    'import { packageAnswer } from "framework/internals";',
    "function main(): i32 { return packageAnswer(); }",
    "",
  ].join("\n"));
  const externalInternalCheck = spawnSync(
    driver,
    ["check", internalApplication],
    { encoding: "utf8" },
  );
  assert.equal(externalInternalCheck.status, 1);
  assert.match(
    externalInternalCheck.stderr,
    /packageAnswer.*internal to its package/,
  );
}, 300_000);

test("validates generated dispatch and foreign declaration streams through the standalone native driver", () => {
  const { directory, driver } = standaloneDriver();
  const generatedProject = resolve(directory, "generated-project");
  const generatedFramework = resolve(generatedProject, "framework");
  const generatedApplication = resolve(generatedProject, "application");
  const generatedOutput = resolve(generatedProject, "generated");
  mkdirSync(generatedProject);
  mkdirSync(generatedFramework);
  mkdirSync(generatedApplication);
  mkdirSync(generatedOutput);
  writeFileSync(resolve(generatedFramework, "framework.zs"), [
    "export struct Builder {",
    "  result: i32;",
    "  function register(inout this, name: String, value: i32): void {}",
    "  internal function install(inout this, name: String, value: i32): void {",
    "    this.result = value;",
    "  }",
    "}",
    "",
  ].join("\n"));
  writeFileSync(resolve(generatedFramework, "z.json"), JSON.stringify({
    package: { name: "framework", version: "0.1.0" },
    library: { entry: "framework.zs" },
  }));
  writeFileSync(resolve(generatedOutput, "adapters.zs"), [
    "export function adapt(value: i32): i32 { return value + 1; }",
    "",
  ].join("\n"));
  const generatedSource = [
    'import { Builder } from "framework";',
    "function answer(): i32 { return 41; }",
    "function main(): i32 {",
    "  let builder = Builder({ result: 0 });",
    '  builder.register("answer", answer());',
    "  return builder.result - 42;",
    "}",
    "",
  ].join("\n");
  const generatedEntry = resolve(generatedApplication, "main.zs");
  writeFileSync(generatedEntry, generatedSource);
  writeFileSync(resolve(generatedApplication, "z.json"), JSON.stringify({
    dependencies: { framework: { path: "../framework" } },
    target: { name: "generated-application", entry: "main.zs" },
  }));
  const generatedCallOverlay = resolve(generatedOutput, "services.zbuild.json");
  const generatedCallOverlayValue = {
    schemaVersion: 1,
    modules: {
      "framework/generated/services": {
        source: "adapters.zs",
        package: "framework",
      },
    },
    callAdapters: [{
      source: "../application/main.zs",
      sourceHash: createHash("sha256").update(generatedSource).digest("hex"),
      offset: generatedSource.indexOf("(\"answer\""),
      target: "Builder.register",
      replacement: "Builder.install",
      argument: 1,
      adapter: {
        module: "framework/generated/services",
        export: "adapt",
      },
    }],
  };
  writeFileSync(generatedCallOverlay, JSON.stringify(generatedCallOverlayValue));
  const generatedRun = spawnSync(
    driver,
    ["run", generatedApplication, "--generated", generatedCallOverlay],
    { encoding: "utf8" },
  );
  assert.equal(generatedRun.status, 0, generatedRun.stderr);
  // Zapp relies on the final build validating generated dispatch instead of
  // paying for a separate graph-wide check. Exercise this after a cache hit.
  const generatedBuild = () => spawnSync(driver,
    ["build", generatedApplication, "--generated", generatedCallOverlay],
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  const firstGeneratedBuild = generatedBuild();
  assert.equal(firstGeneratedBuild.status, 0, firstGeneratedBuild.stderr);
  const reusedGeneratedBuild = generatedBuild();
  assert.equal(reusedGeneratedBuild.status, 0, reusedGeneratedBuild.stderr);
  assert.match(reusedGeneratedBuild.stdout, /cache hit/);
  writeFileSync(resolve(generatedOutput, "adapters.zs"),
    "export function adapt(value: i32): i32 { return true; }\n");
  const invalidGeneratedBuild = generatedBuild();
  assert.equal(invalidGeneratedBuild.status, 1);
  assert.match(invalidGeneratedBuild.stderr, /boolean/);
  assert.doesNotMatch(invalidGeneratedBuild.stdout, /cache hit/);
  writeFileSync(resolve(generatedOutput, "adapters.zs"),
    "export function adapt(value: i32): i32 { return value + 1; }\n");
  writeFileSync(generatedCallOverlay, JSON.stringify({
    ...generatedCallOverlayValue,
    modules: {
      "framework/generated/services": {
        source: "adapters.zs",
      },
    },
  }));
  const unownedGeneratedCheck = spawnSync(
    driver,
    ["check", generatedApplication, "--generated", generatedCallOverlay],
    { encoding: "utf8" },
  );
  assert.equal(unownedGeneratedCheck.status, 1);
  assert.match(
    unownedGeneratedCheck.stderr,
    /method "install" is internal to its package/,
  );
  writeFileSync(generatedCallOverlay, JSON.stringify({
    ...generatedCallOverlayValue,
    callAdapters: [{
      ...generatedCallOverlayValue.callAdapters[0],
      sourceHash: "0".repeat(64),
    }],
  }));
  const staleGeneratedCheck = spawnSync(
    driver,
    ["check", generatedApplication, "--generated", generatedCallOverlay],
    { encoding: "utf8" },
  );
  assert.equal(staleGeneratedCheck.status, 1);
  assert.match(staleGeneratedCheck.stderr, /source hash is stale/);
  const staleGeneratedBuild = generatedBuild();
  assert.equal(staleGeneratedBuild.status, 1);
  assert.match(staleGeneratedBuild.stderr, /source hash is stale/);
  assert.doesNotMatch(staleGeneratedBuild.stdout, /cache hit/);

  const foreignAdapterSource = resolve(directory, "foreign-adapter-input.zs");
  const foreignAdapterHeader = resolve(
    projectRoot,
    "tests/fixtures/foreign-functions-only.h",
  );
  const foreignAdapterStream = resolve(directory, "foreign-adapter.zfdcl");
  writeFileSync(
    foreignAdapterSource,
    `import native from ${JSON.stringify(foreignAdapterHeader)};\n`,
  );
  const foreignAdapter = spawnSync(
    process.execPath,
    [
      cli,
      "self-host-foreign",
      foreignAdapterSource,
      foreignAdapterHeader,
      foreignAdapterStream,
    ],
    { encoding: "utf8" },
  );
  assert.equal(foreignAdapter.status, 0, foreignAdapter.stderr);
  const foreignInspection = spawnSync(
    driver,
    ["foreign-inspect", foreignAdapterStream],
    { encoding: "utf8" },
  );
  assert.equal(foreignInspection.status, 0, foreignInspection.stderr);
  assert.match(
    foreignInspection.stdout,
    /decoded 6 foreign functions from clang/,
  );
  const invalidForeignAdapterStream = resolve(
    directory,
    "invalid-foreign-adapter.zfdcl",
  );
  writeFileSync(
    invalidForeignAdapterStream,
    readFileSync(foreignAdapterStream, "utf8").slice(0, -2),
  );
  const invalidForeignInspection = spawnSync(
    driver,
    ["foreign-inspect", invalidForeignAdapterStream],
    { encoding: "utf8" },
  );
  assert.equal(invalidForeignInspection.status, 1);
  assert.match(
    invalidForeignInspection.stderr,
    /foreign declaration stream ended/,
  );
  const foreignContractInspection = spawnSync(
    driver,
    [
      "foreign-contract-inspect",
      foreignAdapterStream,
      "foreign-functions-only.h",
      resolve(
        projectRoot,
        "tests/fixtures/foreign-functions-only.h.zd",
      ),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    foreignContractInspection.status,
    0,
    foreignContractInspection.stderr,
  );
  assert.match(
    foreignContractInspection.stdout,
    /normalized 6 foreign function contracts for foreign-functions-only\.h/,
  );
  const mismatchedEnumContract = resolve(
    directory,
    "mismatched-enum-contract.zd",
  );
  writeFileSync(
    mismatchedEnumContract,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/foreign-functions-only.h.zd",
      ),
      "utf8",
    ).replace("Z_FOREIGN_ENUM_OK", "Z_FOREIGN_OK"),
  );
  const mismatchedEnumContractInspection = spawnSync(
    driver,
    [
      "foreign-contract-inspect",
      foreignAdapterStream,
      "foreign-functions-only.h",
      mismatchedEnumContract,
    ],
    { encoding: "utf8" },
  );
  assert.equal(mismatchedEnumContractInspection.status, 1);
  assert.match(
    mismatchedEnumContractInspection.stderr,
    /native success constant "Z_FOREIGN_OK" has type i32, expected enum ZForeignStatus/,
  );
  const unsupportedNativeContract = resolve(
    directory,
    "unsupported-native-contract.zd",
  );
  writeFileSync(
    unsupportedNativeContract,
    [
      'declare module "foreign-functions-only.h" {',
      "  export function z_foreign_add(left: _, right: _): _ { owned; }",
      "}",
      "",
    ].join("\n"),
  );
  const unsupportedNativeContractInspection = spawnSync(
    driver,
    [
      "foreign-contract-inspect",
      foreignAdapterStream,
      "foreign-functions-only.h",
      unsupportedNativeContract,
    ],
    { encoding: "utf8" },
  );
  assert.equal(unsupportedNativeContractInspection.status, 1);
  assert.match(
    unsupportedNativeContractInspection.stderr,
    /native function "z_foreign_add" declares owned but its result is not a classified C value resource/,
  );
  const incompleteNativeStatusContract = resolve(
    directory,
    "incomplete-native-status.zd",
  );
  writeFileSync(
    incompleteNativeStatusContract,
    [
      'declare module "foreign-functions-only.h" {',
      "  export function z_foreign_status(code: _): void throws _ {}",
      "}",
      "",
    ].join("\n"),
  );
  const incompleteNativeStatusInspection = spawnSync(
    driver,
    [
      "foreign-contract-inspect",
      foreignAdapterStream,
      "foreign-functions-only.h",
      incompleteNativeStatusContract,
    ],
    { encoding: "utf8" },
  );
  assert.equal(incompleteNativeStatusInspection.status, 1);
  assert.match(
    incompleteNativeStatusInspection.stderr,
    /incomplete-native-status\.zd:2:\d+: error\[Z0801\]: a native status contract requires at least one success value/,
  );
}, 300_000);

test("lowers native callback contexts through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const nativeCallbackExample = resolve(
    projectRoot,
    "examples/applications/message-router/native-callback.zs",
  );
  const nativeCallbackRun = spawnSync(
    driver,
    ["run", nativeCallbackExample],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    nativeCallbackRun.status,
    0,
    nativeCallbackRun.stderr,
  );
  assert.match(nativeCallbackRun.stdout, /native callback routed=42\n$/);
  const nativeCallbackC = readFileSync(
    resolve(
      projectRoot,
      "examples/applications/message-router/.z-cache/run/program.c",
    ),
    "utf8",
  );
  assert.match(nativeCallbackC, /retainOperation\(z_stage1_c_callback_Z_/);
  assert.match(nativeCallbackC, /_c_escape_box\(/);
  assert.match(nativeCallbackC, /_c_escape_box_release/);

  const anyThreadCallbackExample = resolve(
    projectRoot,
    "tests/fixtures/callbacks-any-thread.zs",
  );
  const anyThreadCallbackRun = spawnSync(
    driver,
    ["run", anyThreadCallbackExample],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    anyThreadCallbackRun.status,
    0,
    anyThreadCallbackRun.stderr,
  );
  const anyThreadCallbackC = readFileSync(
    resolve(
      projectRoot,
      "tests/fixtures/.z-cache/run/program.c",
    ),
    "utf8",
  );
  assert.match(anyThreadCallbackC, /_c_escape_box_storage/);
  assert.match(anyThreadCallbackC, /z_foreign_thread_enter\(/);
  assert.match(anyThreadCallbackC, /runtime_retain/);
  assert.match(
    anyThreadCallbackC,
    /__atomic_add_fetch\(&environment->_z_refcount, 1, __ATOMIC_RELAXED\)/,
  );

  // A call-scoped callback context: C is lent a closure that captures by
  // borrow, at the address of its function value in the caller's frame.
  const borrowedContextExample = resolve(
    projectRoot,
    "tests/fixtures/callbacks-borrowed-context.zs",
  );
  const borrowedContextRun = spawnSync(
    driver,
    ["run", borrowedContextExample],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedContextRun.status, 0, borrowedContextRun.stderr);
  assert.match(
    borrowedContextRun.stdout,
    /borrowed-context=5,17,76 total=13 calls=9 local=17\n$/,
  );
  const borrowedContextC = readFileSync(
    resolve(
      projectRoot,
      "tests/fixtures/.z-cache/run/program.c",
    ),
    "utf8",
  );
  assert.match(
    borrowedContextC,
    /z_apply_context_i32\(amount, \(void \*\)Z_TEMPORARY_ADDRESS\(Z_Function_[0-9a-f]+, [^;]*&\(\(\*counter\)\)\)\), z_stage1_c_callback_Z_Function_/,
  );
  assert.doesNotMatch(
    borrowedContextC,
    /z_apply_context(?:_twice)?_i32\([^;]*_c_escape_box\(/,
  );
  // Other callback values in that position are refused, not miscompiled.
  const namedContextDirectory = resolve(directory, "named-context");
  mkdirSync(namedContextDirectory);
  for (const file of ["callbacks.h", "callbacks.h.zd"]) {
    copyFileSync(
      resolve(projectRoot, "tests/fixtures", file),
      resolve(namedContextDirectory, file),
    );
  }
  for (const [name, call] of [
    ["named", "callbacks.z_apply_context_i32(41, plus)"],
    ["moved", "callbacks.z_apply_context_i32(41, move (value) => value + offset)"],
  ]) {
    const refused = resolve(namedContextDirectory, `${name}.zs`);
    writeFileSync(refused, `import callbacks from "callbacks.h";
function plus(value: i32): i32 { return value + 1; }
function main(): i32 {
  const offset = 1;
  return ${call} == 42 ? 0 : 1;
}
`);
    const refusedRun = spawnSync(
      driver,
      ["run", refused],
      {
        encoding: "utf8",
        env: foreignAdapterEnvironment,
      },
    );
    assert.equal(refusedRun.status, 1, name);
    assert.match(
      refusedRun.stderr,
      /call-scoped callback context only for a closure written at the call without move yet/,
      name,
    );
  }
}, 300_000);

test("rebuilds the standalone native driver with itself to the same C", () => {
  const { directory, driver, driverSource, driverEmission } = standaloneDriver();
  const recursiveDriver = resolve(directory, "z-native-generation-2");
  const recursiveCompilation = spawnSync(
    driver,
    ["build", driverSource, recursiveDriver],
    { encoding: "utf8" },
  );
  assert.equal(recursiveCompilation.status, 0, recursiveCompilation.stderr);
  assert.match(recursiveCompilation.stdout, /compiled \d+ Z modules/);
  assert.equal(
    readFileSync(`${recursiveDriver}.c`, "utf8"),
    driverEmission.stdout,
  );
  const nativeStandardOutputEmission = spawnSync(
    driver,
    ["emit", driverSource],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(
    nativeStandardOutputEmission.status,
    0,
    nativeStandardOutputEmission.stderr,
  );
  assert.equal(nativeStandardOutputEmission.stdout, driverEmission.stdout);
  const recursiveChecking = spawnSync(
    recursiveDriver,
    ["check", resolve(projectRoot, "tests/fixtures/self-host-emit-modules/main.zs")],
    { encoding: "utf8" },
  );
  assert.equal(recursiveChecking.status, 0, recursiveChecking.stderr);
  assert.match(recursiveChecking.stdout, /checked 2 Z modules/);
}, 300_000);

test("builds C export libraries through the standalone native driver", () => {
  const { directory, driver } = standaloneDriver();
  const cExportProject = resolve(
    projectRoot,
    "examples/interop/c/z-export",
  );
  const nativeLibraryBuild = spawnSync(
    driver,
    ["build"],
    {
      cwd: cExportProject,
      encoding: "utf8",
    },
  );
  assert.equal(
    nativeLibraryBuild.status,
    0,
    nativeLibraryBuild.stderr,
  );
  assert.match(nativeLibraryBuild.stdout, /build\/libzmath\.a/);
  assert.match(nativeLibraryBuild.stdout, /build\/zmath\.h/);
  const alternateDriver = resolve(directory, "z-native-alternate");
  copyFileSync(driver, alternateDriver);
  chmodSync(alternateDriver, 0o755);
  const alternateCompilerBuild = spawnSync(
    alternateDriver,
    ["build"],
    {
      cwd: cExportProject,
      encoding: "utf8",
    },
  );
  assert.equal(
    alternateCompilerBuild.status,
    0,
    alternateCompilerBuild.stderr,
  );
  assert.doesNotMatch(alternateCompilerBuild.stdout, /cache hit:/);
  assert.match(alternateCompilerBuild.stdout, /build\/libzmath\.a/);
  const nativeExportSource = readFileSync(
    resolve(cExportProject, ".z-cache/build/zmath.c"),
    "utf8",
  );
  assert.match(
    nativeExportSource,
    /int32_t __z_c_impl_0_z_math_add\(int32_t left, int32_t right\)/,
  );
  assert.match(
    nativeExportSource,
    /Z_API int32_t z_math_add\(int32_t left, int32_t right\)/,
  );
  assert.match(
    nativeExportSource,
    /Z_API uintptr_t z_math_text_byte_length\(const char \* text\)[\s\S]*__z_c_impl_0_z_math_text_byte_length\(z_stage1_string_from_cstring\(text\)\)/,
  );
  assert.match(
    nativeExportSource,
    /typedef struct ZMathPoint \{\s+int32_t x;\s+int32_t y;\s+\} ZMathPoint;/,
  );
  const nativeConsumer = resolve(directory, "native-zmath-consumer");
  const nativeConsumerCompilation = spawnSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      resolve(cExportProject, "build"),
      resolve(cExportProject, "consumer.c"),
      resolve(cExportProject, "build/libzmath.a"),
      "-o",
      nativeConsumer,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    nativeConsumerCompilation.status,
    0,
    nativeConsumerCompilation.stderr,
  );
  const nativeConsumerRun = spawnSync(
    nativeConsumer,
    [],
    { encoding: "utf8" },
  );
  assert.equal(nativeConsumerRun.status, 0, nativeConsumerRun.stderr);
  assert.equal(
    nativeConsumerRun.stdout,
    "sum=42 answer=42 even=true text=6 point=(21,22) status=1\n",
  );

  const runtimeRootProject = resolve(directory, "runtime-root-project");
  mkdirSync(runtimeRootProject);
  writeFileSync(
    resolve(runtimeRootProject, "library.zs"),
    [
      'import { thread } from "std/thread";',
      "",
      "class RuntimeRoot {",
      "  readonly label: String;",
      "  uiRevision: i32 on thread.main;",
      "}",
      "",
      "function initializeRuntime(): RuntimeRoot on thread.main {",
      '  return new RuntimeRoot({ label: "native",',
      "    uiRevision: 1,",
      "  });",
      "}",
      "",
      "export c function z_native_runtime_answer(): i32 { return 42; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(runtimeRootProject, "z.json"),
    JSON.stringify({
      target: {
        kind: "static-library",
        name: "native_runtime",
        entry: "library.zs",
        runtime: { initialize: "initializeRuntime" },
      },
    }),
  );
  const runtimeRootBuild = spawnSync(
    driver,
    ["build", runtimeRootProject],
    { encoding: "utf8" },
  );
  assert.equal(runtimeRootBuild.status, 0, runtimeRootBuild.stderr);
  const runtimeRootHeader = readFileSync(
    resolve(runtimeRootProject, "build/native_runtime.h"),
    "utf8",
  );
  assert.match(
    runtimeRootHeader,
    /#define NATIVE_RUNTIME_RUNTIME_REQUIRES_MAIN_THREAD 1/,
  );
  assert.match(
    runtimeRootHeader,
    /#define NATIVE_RUNTIME_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1/,
  );
  const runtimeRootSource = readFileSync(
    resolve(runtimeRootProject, ".z-cache/build/native_runtime.c"),
    "utf8",
  );
  assert.match(runtimeRootSource, /z_embedded_runtime_native_runtime_destroy_root/);
  assert.match(runtimeRootSource, /initializeRuntime\(\)/);
  assert.match(runtimeRootSource, /Z_ForeignThreadEntry z_embedded_runtime_native_runtime_enter/);
  assert.match(runtimeRootSource, /return z_foreign_thread_enter/);
  assert.match(
    runtimeRootSource,
    /z_embedded_runtime_native_runtime_retain\(&z_embedded_runtime_native_runtime\)/,
  );
  assert.match(
    runtimeRootSource,
    /z_embedded_runtime_native_runtime_enqueue_release/,
  );
  assert.match(
    runtimeRootSource,
    /\? NULL\s+: z_embedded_runtime_native_runtime_enqueue_release/,
  );
  assert.match(
    runtimeRootSource,
    /static void Z_RuntimeRoot_finalize_executor_bound\(void \*opaque\)/,
  );
  assert.match(
    runtimeRootSource,
    /static[^]*void Z_RuntimeRoot_release\(Z_RuntimeRoot \*self\)[^]*if \(z_executor_bound_release_enqueue != NULL\) \{[^]*z_executor_bound_release_enqueue\([^]*z_executor_bound_release_context,[^]*self,[^]*Z_RuntimeRoot_finalize_executor_bound[^]*\);[^]*return;[^]*\}[^]*Z_RuntimeRoot_finalize_executor_bound\(self\);/,
  );
  assert.match(runtimeRootSource, /z_foreign_thread_leave\(entry\)/);
  assert.match(runtimeRootHeader, /NATIVE_RUNTIME_RUNTIME_DRAINING = 7/);
  const runtimeRootConsumerSource = resolve(
    runtimeRootProject,
    "consumer.c",
  );
  writeFileSync(runtimeRootConsumerSource, [
    '#include "native_runtime.h"',
    "#include <stddef.h>",
    "",
    "static bool host_is_main(void *context) {",
    "  (void)context;",
    "  return true;",
    "}",
    "",
    "static void host_enqueue_release(",
    "  void *context,",
    "  void *value,",
    "  void (*finalize)(void *value)",
    ") {",
    "  (void)context;",
    "  finalize(value);",
    "}",
    "",
    "int main(void) {",
    "  const native_runtime_runtime_config config = {",
    "    .context = NULL,",
    "    .enqueue_release = host_enqueue_release,",
    "    .is_main_thread = host_is_main,",
    "  };",
    "  if (native_runtime_runtime_initialize(&config) != NATIVE_RUNTIME_RUNTIME_OK) return 1;",
    "  if (z_native_runtime_answer() != 42) return 2;",
    "  return native_runtime_runtime_shutdown() == NATIVE_RUNTIME_RUNTIME_OK ? 0 : 3;",
    "}",
    "",
  ].join("\n"));
  const runtimeRootConsumer = resolve(runtimeRootProject, "consumer");
  const runtimeRootCompilation = spawnSync(
    "clang",
    [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      resolve(runtimeRootProject, "build"),
      runtimeRootConsumerSource,
      resolve(runtimeRootProject, "build/libnative_runtime.a"),
      "-o",
      runtimeRootConsumer,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    runtimeRootCompilation.status,
    0,
    runtimeRootCompilation.stderr,
  );
  const runtimeRootRun = spawnSync(
    runtimeRootConsumer,
    [],
    { encoding: "utf8" },
  );
  assert.equal(runtimeRootRun.status, 0, runtimeRootRun.stderr);
}, 300_000);

test("builds runtime exports and reports lowering boundaries through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const releaseOnlyRuntimeProject = resolve(
    directory,
    "release-only-runtime-project",
  );
  mkdirSync(releaseOnlyRuntimeProject);
  writeFileSync(
    resolve(releaseOnlyRuntimeProject, "library.zs"),
    [
      'import { thread } from "std/thread";',
      "",
      "class MainIdentity on thread.main {",
      "  value: i32;",
      "}",
      "",
      "export c function z_release_marker(): i32 { return 42; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(releaseOnlyRuntimeProject, "z.json"),
    JSON.stringify({
      target: {
        kind: "static-library",
        name: "release_only",
        entry: "library.zs",
      },
    }),
  );
  const releaseOnlyRuntimeBuild = spawnSync(
    driver,
    ["build", releaseOnlyRuntimeProject],
    { encoding: "utf8" },
  );
  assert.equal(
    releaseOnlyRuntimeBuild.status,
    0,
    releaseOnlyRuntimeBuild.stderr,
  );
  const releaseOnlyRuntimeHeader = readFileSync(
    resolve(releaseOnlyRuntimeProject, "build/release_only.h"),
    "utf8",
  );
  assert.match(
    releaseOnlyRuntimeHeader,
    /#define RELEASE_ONLY_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1/,
  );
  assert.match(
    releaseOnlyRuntimeHeader,
    /#define RELEASE_ONLY_RUNTIME_REQUIRES_MAIN_THREAD 1/,
  );
  const releaseOnlyRuntimeSource = readFileSync(
    resolve(releaseOnlyRuntimeProject, ".z-cache/build/release_only.c"),
    "utf8",
  );
  assert.match(
    releaseOnlyRuntimeSource,
    /if \(config == NULL \|\| config->enqueue_release == NULL\)/,
  );
  assert.match(
    releaseOnlyRuntimeSource,
    /Z_MainIdentity_finalize_executor_bound/,
  );

  const synchronizedRuntimeProject = resolve(
    projectRoot,
    "examples/interop/c/z-runtime-export",
  );
  const synchronizedRuntimeCheck = spawnSync(
    driver,
    ["check", synchronizedRuntimeProject],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    synchronizedRuntimeCheck.status,
    0,
    synchronizedRuntimeCheck.stderr,
  );

  const byteProject = resolve(directory, "byte-library");
  mkdirSync(byteProject);
  const byteExample = resolve(projectRoot, "examples/interop/c/z-bytes-export");
  for (const name of ["library.zs", "z.json"]) {
    writeFileSync(resolve(byteProject, name), readFileSync(resolve(byteExample, name), "utf8"));
  }
  const byteBuild = spawnSync(driver, ["build", byteProject, "--release"], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(byteBuild.status, 0, byteBuild.stderr);
  const byteHeader = readFileSync(resolve(byteProject, "build/zbytes.h"), "utf8");
  assert.match(byteHeader, /byteCount\(const uint8_t \*bytes_data, uintptr_t bytes_length\)/);
  assert.doesNotMatch(byteHeader, /Z___z_Slice|__z_slice/);
  for (const cpp of [false, true]) {
    const consumer = resolve(byteProject, cpp ? "consumer-cpp" : "consumer");
    const built = spawnSync(cpp ? "clang++" : "clang", [
      "-x", cpp ? "c++" : "c", cpp ? "-std=c++20" : "-std=c11",
      "-Wall", "-Wextra", "-Werror", "-I", resolve(byteProject, "build"),
      resolve(byteExample, "consumer.c"), "-x", "none",
      resolve(byteProject, "build/libzbytes.a"), "-o", consumer,
    ], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(built.status, 0, built.stderr);
    const result = spawnSync(consumer, [], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "4 bytes, sum 386; empty input accepted\n");
  }

  const invalidNativeExport = resolve(
    directory,
    "invalid-native-export.zs",
  );
  writeFileSync(
    invalidNativeExport,
    [
      "export c function z_invalid(): String {",
      '  return "unsupported";',
      "}",
      "",
    ].join("\n"),
  );
  const invalidNativeExportCheck = spawnSync(
    driver,
    ["check", invalidNativeExport],
    { encoding: "utf8" },
  );
  assert.equal(invalidNativeExportCheck.status, 1);
  assert.match(
    invalidNativeExportCheck.stderr,
    /C export return type "String" is unsupported/,
  );

  const nativeLoweringBoundaries = [
    {
      name: "synchronous-placed-method-tail",
      source: [
        'import { thread } from "std/thread";',
        "readonly class Service {",
        "  function publish(): i32 on thread.main {",
        "    return 42;",
        "  }",
        "  async function invoke(): i32 {",
        "    return await on thread.main this.publish();",
        "  }",
        "}",
        "function main(): i32 { return 0; }",
        "",
      ].join("\n"),
      line: 6,
      column: 9,
      marker: "^^^^^",
      code: "Z0700",
      summary: 'suspending async function "invoke" is not executable in the native compiler yet',
    },
    {
      name: "async-scope",
      source: [
        "async function main(): i32 {",
        "  async scope {}",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      line: 2,
      column: 3,
      marker: "^^^^^",
      code: "Z0700",
      summary: "async scope is not executable in the native compiler yet",
    },
    {
      name: "loop-expression",
      source: [
        "function main(): i32 {",
        "  const values = Array<i32>(42);",
        "  const selected = for (const value of values) { select value; } else { select 0; };",
        "  return selected - 42;",
        "}",
        "",
      ].join("\n"),
      line: 3,
      column: 20,
      marker: "^^^",
      code: "Z1000",
      summary: "value-producing for expressions are not executable in the native compiler yet",
    },
    {
      name: "if-expression",
      source: [
        "function main(): i32 {",
        "  const selected = if (true) { select 42; } else { select 0; };",
        "  return selected - 42;",
        "}",
        "",
      ].join("\n"),
      line: 2,
      column: 20,
      marker: "^^",
      code: "Z1000",
      summary: "value-producing if expressions are not executable in the native compiler yet",
    },
    {
      name: "saturating-integer-method",
      source: [
        "function main(): i32 {",
        "  const maximum: u8 = 255;",
        "  const saturated = maximum.saturatingAdd(1);",
        "  return i32(saturated) - 255;",
        "}",
        "",
      ].join("\n"),
      line: 3,
      column: 29,
      marker: "^^^^^^^^^^^^^",
      code: "Z1000",
      summary: 'saturating integer method "saturatingAdd" is not executable in the native compiler yet; wrappingAdd, wrappingSubtract, and wrappingMultiply are supported',
    },
    {
      name: "map-value-representation",
      source: [
        'import { Map } from "std/collections";',
        "function main(): i32 {",
        '  let values = Map<String, String>();',
        '  return values.has("answer") ? 0 : 1;',
        "}",
        "",
      ].join("\n"),
      line: 3,
      column: 7,
      marker: "^^^^^^",
      code: "Z1000",
      summary: 'Map value type "String" is not executable in the native compiler yet; only cleanup-free scalar values are supported',
    },
    {
      name: "template-scalar-representation",
      source: [
        'import { console } from "std";',
        "function main(): i32 {",
        "  const value: f32 = 42;",
        "  console.log(`value ${value}`);",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
      line: 4,
      column: 24,
      marker: "^^^^^",
      code: "Z1000",
      summary: 'template interpolation of "f32" is not executable in the native compiler yet; supported native interpolation types are String (owned or viewed), boolean, all integer types, and f64',
    },
  ] as const;
  for (const boundary of nativeLoweringBoundaries) {
    const input = resolve(directory, `native-lowering-${boundary.name}.zs`);
    writeFileSync(input, boundary.source);
    assert.doesNotThrow(
      () => check(boundary.source, input),
      `${boundary.name} must remain valid Z`,
    );
    const checking = spawnSync(driver, ["check", input], { encoding: "utf8" });
    assert.equal(checking.status, 1, `${boundary.name}\n${checking.stderr}`);
    assert.ok(
      checking.stderr.includes(
        `${input}:${boundary.line}:${boundary.column}: error[${boundary.code}]: ${boundary.summary}`,
      ),
      checking.stderr,
    );
    assert.ok(
      checking.stderr.includes(
        `${boundary.line} | ${boundary.source.split("\n")[boundary.line - 1]}`,
      ),
    );
    assert.ok(checking.stderr.includes(`${boundary.marker} ${boundary.summary}`));
    assert.doesNotMatch(checking.stderr, /against \d+ local aggregate/);

  }

  const nativeStructSpread = spawnSync(
    driver,
    [
      "check",
      resolve(projectRoot, "tests/fixtures/self-host-emit-struct-spread.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(nativeStructSpread.status, 0, nativeStructSpread.stderr);

  for (const positiveControl of [
    "tests/fixtures/self-host-emit-control-flow.zs",
    "tests/fixtures/self-host-emit-thread-main-if.zs",
    "tests/fixtures/self-host-emit-enum.zs",
    "tests/fixtures/self-host-emit-thread-task.zs",
    "tests/fixtures/self-host-emit-mutex-field.zs",
    "tests/fixtures/self-host-emit-mutex-owned-result.zs",
    "tests/fixtures/self-host-emit-mutex-owned-capture.zs",
  ]) {
    const positive = spawnSync(
      driver,
      ["check", resolve(projectRoot, positiveControl)],
      { encoding: "utf8" },
    );
    assert.equal(positive.status, 0, `${positiveControl}\n${positive.stderr}`);
  }

  for (const [name, body] of [
    ["borrow", "state.withLock((in value): String => move request);"],
    ["moved", "state.withLock(move (in value): String => move request); return i32(request.byteLength);"],
    ["twice", "state.withLock(move (in value): void => { consume(move request); consume(move request); });"],
  ]) {
    const file = resolve(directory, `mutex-capture-${name}.zs`);
    writeFileSync(file, `
      import { Mutex } from "std/sync";
      function consume(value: String): void {}
      function main(): i32 {
        const state = Mutex(0);
        const request: String = "owned";
        ${body}
        return 0;
      }
    `);
    const rejected = spawnSync(driver, ["check", file], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
    assert.match(rejected.stderr, /borrowed|moved/);
  }

  const backendIceInput = resolve(
    projectRoot,
    "examples/language/collections/set.zs",
  );
  const backendIce = spawnSync(
    driver,
    ["check", backendIceInput],
    { encoding: "utf8" },
  );
  assert.equal(backendIce.status, 1, backendIce.stderr);
  assert.match(
    backendIce.stderr,
    /error\[Z1000\]: iteration over "Set<String>" is not executable in the native compiler yet; Array, fixed arrays, Map, and Slice<u8> are supported/,
  );

  const runtimeCollisionProject = resolve(directory, "runtime-collision");
  mkdirSync(runtimeCollisionProject);
  writeFileSync(
    resolve(runtimeCollisionProject, "library.zs"),
    "export c function runtime_collision_runtime_is_main_thread(): i32 { return 0; }\n",
  );
  writeFileSync(
    resolve(runtimeCollisionProject, "z.json"),
    JSON.stringify({
      target: {
        kind: "static-library",
        name: "runtime-collision",
        entry: "library.zs",
      },
    }),
  );
  const runtimeCollisionBuild = spawnSync(
    driver,
    ["build", runtimeCollisionProject],
    { encoding: "utf8" },
  );
  assert.equal(runtimeCollisionBuild.status, 1);
  assert.match(
    runtimeCollisionBuild.stderr,
    /collides with the generated runtime contract for target "runtime-collision"/,
  );

  const moduleOnlySource = resolve(
    projectRoot,
    "examples/language/modules/geometry.zs",
  );
  const moduleChecking = spawnSync(
    driver,
    ["check", moduleOnlySource],
    { encoding: "utf8" },
  );
  assert.equal(moduleChecking.status, 0, moduleChecking.stderr);
  const moduleEmission = spawnSync(
    driver,
    ["emit", moduleOnlySource, resolve(directory, "module.c")],
    { encoding: "utf8" },
  );
  assert.equal(moduleEmission.status, 1);
  assert.match(moduleEmission.stderr, /program must declare `function main\(\): i32`/);

  const invalidMain = resolve(directory, "invalid-main.zs");
  writeFileSync(invalidMain, "function main(value: i32): i32 { return value; }");
  const invalidMainCheck = spawnSync(
    driver,
    ["check", invalidMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidMainCheck.status, 1);
  assert.match(invalidMainCheck.stderr, /`main` must have signature `function main\(\): i32`/);

  const invalidSyntax = resolve(directory, "invalid-syntax.zs");
  writeFileSync(
    invalidSyntax,
    "function main(): i32 {\n  const answer = ;\n  return answer;\n}\n",
  );
  const invalidSyntaxCheck = spawnSync(
    driver,
    ["check", invalidSyntax],
    { encoding: "utf8" },
  );
  assert.equal(invalidSyntaxCheck.status, 1);
  assert.match(
    invalidSyntaxCheck.stderr,
    /:2:18: error: expected a variable initializer\n2 \|   const answer = ;\n  \|                  \^/,
  );

  const invalidName = resolve(directory, "invalid-name.zs");
  writeFileSync(
    invalidName,
    "function main(): i32 {\n  return missing;\n}\n",
  );
  const invalidNameCheck = spawnSync(
    driver,
    ["check", invalidName],
    { encoding: "utf8" },
  );
  assert.equal(invalidNameCheck.status, 1);
  assert.match(
    invalidNameCheck.stderr,
    /:2:10: error: unknown name missing\n2 \|   return missing;\n  \|          \^/,
  );

  const foreignImport = resolve(directory, "foreign-import.zs");
  writeFileSync(
    foreignImport,
    'import native from "stdint.h";\nfunction main(): i32 { return 0; }\n',
  );
  const foreignImportCheck = spawnSync(
    driver,
    ["check", foreignImport],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(foreignImportCheck.status, 0, foreignImportCheck.stderr);
  assert.match(foreignImportCheck.stdout, /checked 1 Z modules/);

  const uncontractedHeader = resolve(directory, "uncontracted.h");
  writeFileSync(
    uncontractedHeader,
    [
      "int z_uncontracted_status(void);",
      "void *z_uncontracted_pointer(void);",
      "",
    ].join("\n"),
  );
  const uncontractedUse = resolve(directory, "uncontracted-use.zs");
  writeFileSync(
    uncontractedUse,
    [
      'import native from "./uncontracted.h";',
      "function main(): i32 {",
      "  return native.z_uncontracted_status();",
      "}",
      "",
    ].join("\n"),
  );
  const uncontractedUseCheck = spawnSync(
    driver,
    ["check", uncontractedUse],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(
    uncontractedUseCheck.status,
    0,
    uncontractedUseCheck.stderr,
  );

  const uncontractedPointerUse = resolve(
    directory,
    "uncontracted-pointer-use.zs",
  );
  writeFileSync(
    uncontractedPointerUse,
    [
      'import native from "./uncontracted.h";',
      "function main(): i32 {",
      "  const pointer = native.z_uncontracted_pointer();",
      "  return pointer == null ? 1 : 0;",
      "}",
      "",
    ].join("\n"),
  );
  const uncontractedPointerUseCheck = spawnSync(
    driver,
    ["check", uncontractedPointerUse],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(uncontractedPointerUseCheck.status, 1);
  assert.match(
    uncontractedPointerUseCheck.stderr,
    /native contract for "\.\/uncontracted\.h" has no checked function "z_uncontracted_pointer"/,
  );
}, 300_000);

test("builds and caches a foreign-header project through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const foreignProject = resolve(directory, "foreign-project");
  mkdirSync(foreignProject, { recursive: true });
  const foreignProjectSource = resolve(foreignProject, "main.zs");
  const foreignProjectHeader = resolve(
    foreignProject,
    "foreign-functions-only.h",
  );
  const foreignProjectContract = `${foreignProjectHeader}.zd`;
  const foreignProjectImplementation = resolve(
    foreignProject,
    "foreign-functions-only.c",
  );
  const foreignProjectDependency = resolve(
    foreignProject,
    "foreign-dependency.h",
  );
  writeFileSync(
    foreignProjectSource,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-call-input.zs",
      ),
      "utf8",
    ).replaceAll(
      '"foreign-functions-only.h"',
      '"./foreign-functions-only.h"',
    ),
  );
  writeFileSync(
    foreignProjectHeader,
    '#include "foreign-dependency.h"\n'
      + "typedef struct ZForeignUnusedRecord { Z_FOREIGN_INT value; } ZForeignUnusedRecord;\n"
      + readFileSync(
        resolve(projectRoot, "tests/fixtures/foreign-functions-only.h"),
        "utf8",
      ).replace(/\bint\b/g, "Z_FOREIGN_INT"),
  );
  writeFileSync(foreignProjectDependency, "#define Z_FOREIGN_INT int\n");
  writeFileSync(
    foreignProjectContract,
    readFileSync(
      resolve(projectRoot, "tests/fixtures/foreign-functions-only.h.zd"),
      "utf8",
    ),
  );
  writeFileSync(
    foreignProjectImplementation,
    readFileSync(
      resolve(projectRoot, "tests/fixtures/foreign-functions-only.c"),
      "utf8",
    ),
  );
  const foreignObject = resolve(foreignProject, "foreign-functions-only.o");
  const foreignArchive = resolve(foreignProject, "libzforeignfixture.a");
  const foreignObjectCompilation = spawnSync(
    "clang",
    ["-c", foreignProjectImplementation, "-o", foreignObject],
    { encoding: "utf8" },
  );
  assert.equal(
    foreignObjectCompilation.status,
    0,
    foreignObjectCompilation.stderr,
  );
  const foreignArchiving = spawnSync(
    "ar",
    ["rcs", foreignArchive, foreignObject],
    { encoding: "utf8" },
  );
  assert.equal(foreignArchiving.status, 0, foreignArchiving.stderr);
  writeFileSync(
    resolve(foreignProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-project",
        entry: "main.zs",
        includeDirectories: ["."],
        link: {
          directories: ["."],
          libraries: ["zforeignfixture"],
        },
      },
    }, null, 2)}\n`,
  );
  const missingForeignAdapter = spawnSync(
    driver,
    ["check", foreignProjectSource],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
      },
    },
  );
  assert.equal(missingForeignAdapter.status, 1);
  assert.match(
    missingForeignAdapter.stderr,
    /:1:1: error: could not launch z-foreign-adapter for "\.\/foreign-functions-only\.h":/,
  );
  const adjacentAdapter = resolve(directory, "z-foreign-adapter");
  writeFileSync(adjacentAdapter, `#!${process.execPath}\nimport ${JSON.stringify(resolve(projectRoot, "compiler/src/foreign-adapter-cli.ts"))};\n`);
  chmodSync(adjacentAdapter, 0o755);
  const foreignProjectCheck = spawnSync(
    driver,
    ["check", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(foreignProjectCheck.status, 0, foreignProjectCheck.stderr);
  assert.match(foreignProjectCheck.stdout, /checked 1 Z modules/);
  assert.equal(existsSync(`${foreignProjectContract}.zfdcl`), false);

  const externalProject = resolve(directory, "external-foreign-project");
  const externalShared = resolve(directory, "external-foreign-shared");
  mkdirSync(externalProject);
  mkdirSync(externalShared);
  writeFileSync(
    resolve(externalProject, "main.zs"),
    [
      'import { externalAdd } from "../external-foreign-shared/helper.zs";',
      "function main(): i32 { return externalAdd(20, 22) - 42; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(externalShared, "helper.zs"),
    [
      'import native from "foreign-functions-only.h";',
      "export function externalAdd(left: i32, right: i32): i32 {",
      "  return native.z_foreign_add(left, right);",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(externalProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "external-foreign-project",
        entry: "main.zs",
        includeDirectories: ["../foreign-project"],
      },
    }, null, 2)}\n`,
  );
  const externalForeignCheck = spawnSync(
    driver,
    ["check", externalProject],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(
    externalForeignCheck.status,
    0,
    externalForeignCheck.stderr,
  );
  assert.match(externalForeignCheck.stdout, /checked 2 Z modules/);

  const foreignCacheDirectory = resolve(
    foreignProject,
    ".z-cache/foreign",
  );
  const cachedForeignArtifacts = readdirSync(foreignCacheDirectory)
    .filter((entry) => entry.endsWith(".zfdcl"));
  assert.equal(cachedForeignArtifacts.length, 1);
  const cachedForeignArtifact = resolve(
    foreignCacheDirectory,
    cachedForeignArtifacts[0],
  );
  const cachedForeignMetadata = `${cachedForeignArtifact}.meta`;
  assert.equal(existsSync(cachedForeignMetadata), true);
  utimesSync(cachedForeignArtifact, 0, 0);
  utimesSync(cachedForeignMetadata, 0, 0);
  const cachedForeignCheck = spawnSync(
    driver,
    ["check", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(cachedForeignCheck.status, 0, cachedForeignCheck.stderr);
  assert.equal(statSync(cachedForeignArtifact).mtimeMs, 0);
  assert.equal(statSync(cachedForeignMetadata).mtimeMs, 0);

  writeFileSync(
    foreignProjectDependency,
    "#define Z_FOREIGN_INT signed int\n",
  );
  const invalidatedForeignCheck = spawnSync(
    driver,
    ["check", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    invalidatedForeignCheck.status,
    0,
    invalidatedForeignCheck.stderr,
  );
  assert.ok(statSync(cachedForeignArtifact).mtimeMs > 0);
  assert.ok(statSync(cachedForeignMetadata).mtimeMs > 0);

  const additionalIncludeDirectory = resolve(
    foreignProject,
    "additional-include",
  );
  mkdirSync(additionalIncludeDirectory);
  writeFileSync(
    resolve(foreignProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-project",
        entry: "main.zs",
        includeDirectories: [".", "additional-include"],
        link: {
          directories: ["."],
          libraries: ["zforeignfixture"],
        },
      },
    }, null, 2)}\n`,
  );
  const targetChangedForeignCheck = spawnSync(
    driver,
    ["check", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    targetChangedForeignCheck.status,
    0,
    targetChangedForeignCheck.stderr,
  );
  assert.equal(
    readdirSync(foreignCacheDirectory)
      .filter((entry) => entry.endsWith(".zfdcl"))
      .length,
    2,
  );
  const firstForeignRun = spawnSync(
    driver,
    ["run", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(firstForeignRun.status, 42, firstForeignRun.stderr);
  assert.match(firstForeignRun.stdout, /compiled 1 Z modules/);
  const cachedForeignApplication = resolve(
    foreignProject,
    ".z-cache/run/program",
  );
  utimesSync(cachedForeignApplication, 0, 0);
  const cachedForeignRun = spawnSync(
    driver,
    ["run", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(cachedForeignRun.status, 42, cachedForeignRun.stderr);
  assert.match(
    cachedForeignRun.stdout,
    /cache hit: reused .*\.z-cache\/run\/program/,
  );
  assert.equal(statSync(cachedForeignApplication).mtimeMs, 0);

  writeFileSync(
    foreignProjectImplementation,
    `${readFileSync(foreignProjectImplementation, "utf8")}\nint z_foreign_cache_marker(void) { return 1; }\n`,
  );
  const changedForeignObjectCompilation = spawnSync(
    "clang",
    ["-c", foreignProjectImplementation, "-o", foreignObject],
    { encoding: "utf8" },
  );
  assert.equal(
    changedForeignObjectCompilation.status,
    0,
    changedForeignObjectCompilation.stderr,
  );
  const changedForeignArchiving = spawnSync(
    "ar",
    ["rcs", foreignArchive, foreignObject],
    { encoding: "utf8" },
  );
  assert.equal(
    changedForeignArchiving.status,
    0,
    changedForeignArchiving.stderr,
  );
  const libraryInvalidatedForeignRun = spawnSync(
    driver,
    ["run", foreignProjectSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    libraryInvalidatedForeignRun.status,
    42,
    libraryInvalidatedForeignRun.stderr,
  );
  assert.match(
    libraryInvalidatedForeignRun.stdout,
    /compiled 1 Z modules/,
  );
  assert.ok(statSync(cachedForeignApplication).mtimeMs > 0);

  const firstForeignBuild = spawnSync(
    driver,
    ["build", foreignProject],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(firstForeignBuild.status, 0, firstForeignBuild.stderr);
  assert.match(firstForeignBuild.stdout, /build\/foreign-project/);
  const builtForeignApplication = resolve(
    foreignProject,
    "build/foreign-project",
  );
  utimesSync(builtForeignApplication, 0, 0);
  const cachedForeignBuild = spawnSync(
    driver,
    ["build", foreignProject],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(cachedForeignBuild.status, 0, cachedForeignBuild.stderr);
  assert.match(
    cachedForeignBuild.stdout,
    /cache hit: reused build\/foreign-project/,
  );
  assert.equal(statSync(builtForeignApplication).mtimeMs, 0);

  // A helper-only update must invalidate the outer executable cache even when
  // neither the Z driver binary nor the application/header sources changed.
  writeFileSync(adjacentAdapter, readFileSync(adjacentAdapter, "utf8") + "// updated producer entry\n");
  const producerInvalidatedForeignBuild = spawnSync(
    driver,
    ["build", foreignProject],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(producerInvalidatedForeignBuild.status, 0, producerInvalidatedForeignBuild.stderr);
  assert.doesNotMatch(producerInvalidatedForeignBuild.stdout, /cache hit:/);
  assert.ok(statSync(builtForeignApplication).mtimeMs > 0);

  writeFileSync(
    foreignProjectDependency,
    `${readFileSync(foreignProjectDependency, "utf8")}\n`,
  );
  const headerInvalidatedForeignBuild = spawnSync(
    driver,
    ["build", foreignProject],
    { encoding: "utf8", env: foreignAdapterEnvironment },
  );
  assert.equal(
    headerInvalidatedForeignBuild.status,
    0,
    headerInvalidatedForeignBuild.stderr,
  );
  assert.doesNotMatch(headerInvalidatedForeignBuild.stdout, /cache hit:/);
  assert.ok(statSync(builtForeignApplication).mtimeMs > 0);

  const foreignApplication = resolve(directory, "foreign-application-native");
  const foreignBuild = spawnSync(
    driver,
    ["build", foreignProjectSource, foreignApplication],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(foreignBuild.status, 0, foreignBuild.stderr);
  assert.match(foreignBuild.stdout, /compiled 1 Z modules/);
  const foreignExecution = spawnSync(
    foreignApplication,
    [],
    { encoding: "utf8" },
  );
  assert.equal(foreignExecution.status, 42, foreignExecution.stderr);
}, 300_000);

test("checks header-only, scalar-pointer, and union headers through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const headerOnlyProject = resolve(directory, "header-only-project");
  const callableMethodContext = spawnSync(driver, [
    "run",
    resolve(projectRoot, "tests/fixtures/self-host-callable-method-context/main.zs"),
  ], { encoding: "utf8", env: foreignAdapterEnvironment });
  assert.equal(callableMethodContext.status, 0, callableMethodContext.stderr);
  assert.match(callableMethodContext.stdout, /compiled 2 Z modules/);
  const signatureOnly = spawnSync(driver, [
    "run",
    resolve(projectRoot, "tests/fixtures/self-host-signature-header/main.zs"),
  ], { encoding: "utf8", env: foreignAdapterEnvironment });
  assert.equal(signatureOnly.status, 0, signatureOnly.stderr);
  assert.match(signatureOnly.stdout, /compiled 2 Z modules/);
  mkdirSync(headerOnlyProject);
  const headerOnlyDependency = resolve(
    headerOnlyProject,
    "header-only-dependency.h",
  );
  const headerOnlyHeader = resolve(headerOnlyProject, "header-only.h");
  const headerOnlyContract = `${headerOnlyHeader}.zd`;
  const headerOnlySource = resolve(headerOnlyProject, "main.zs");
  writeFileSync(
    headerOnlyDependency,
    "#define HEADER_ONLY_CODE 0\n",
  );
  writeFileSync(
    headerOnlyHeader,
    '#include "header-only-dependency.h"\n'
      + "typedef enum {\n"
      + "  HEADER_ONLY_OK = HEADER_ONLY_CODE\n"
      + "} HeaderOnlyStatus;\n"
      + "static inline int header_only_status(void) {\n"
      + "  return HEADER_ONLY_CODE;\n"
      + "}\n",
  );
  writeFileSync(
    headerOnlyContract,
    'declare module "header-only.h" {\n'
      + "  export function header_only_status(): _;\n"
      + "}\n",
  );
  writeFileSync(
    headerOnlySource,
    'import native from "header-only.h";\n'
      + "function main(): i32 {\n"
      + "  return i32(native.header_only_status());\n"
      + "}\n",
  );
  writeFileSync(
    resolve(headerOnlyProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "header-only-project",
        entry: "main.zs",
        includeDirectories: ["."],
      },
    }, null, 2)}\n`,
  );
  const firstHeaderOnlyRun = spawnSync(
    driver,
    ["run", headerOnlySource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(firstHeaderOnlyRun.status, 0, firstHeaderOnlyRun.stderr);
  assert.match(
    firstHeaderOnlyRun.stdout,
    /compiled 1 Z modules/,
  );
  const cachedHeaderOnlyApplication = resolve(
    headerOnlyProject,
    ".z-cache/run/program",
  );
  utimesSync(cachedHeaderOnlyApplication, 0, 0);
  const cachedHeaderOnlyRun = spawnSync(
    driver,
    ["run", headerOnlySource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(cachedHeaderOnlyRun.status, 0, cachedHeaderOnlyRun.stderr);
  assert.match(
    cachedHeaderOnlyRun.stdout,
    /cache hit: reused .*\.z-cache\/run\/program/,
  );
  assert.equal(statSync(cachedHeaderOnlyApplication).mtimeMs, 0);

  writeFileSync(
    headerOnlyDependency,
    "#define HEADER_ONLY_CODE 1\n",
  );
  const headerInvalidatedRun = spawnSync(
    driver,
    ["run", headerOnlySource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    headerInvalidatedRun.status,
    1,
    headerInvalidatedRun.stderr,
  );
  assert.match(
    headerInvalidatedRun.stdout,
    /compiled 1 Z modules/,
  );
  assert.ok(statSync(cachedHeaderOnlyApplication).mtimeMs > 0);

  utimesSync(cachedHeaderOnlyApplication, 0, 0);
  const cacheIncludeDirectory = resolve(
    headerOnlyProject,
    "cache-include",
  );
  mkdirSync(cacheIncludeDirectory);
  writeFileSync(
    resolve(headerOnlyProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "header-only-project",
        entry: "main.zs",
        includeDirectories: [".", "cache-include"],
      },
    }, null, 2)}\n`,
  );
  const configInvalidatedRun = spawnSync(
    driver,
    ["run", headerOnlySource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(
    configInvalidatedRun.status,
    1,
    configInvalidatedRun.stderr,
  );
  assert.match(
    configInvalidatedRun.stdout,
    /compiled 1 Z modules/,
  );
  assert.ok(statSync(cachedHeaderOnlyApplication).mtimeMs > 0);

  const scalarPointerProject = resolve(
    directory,
    "foreign-scalar-pointer-project",
  );
  mkdirSync(scalarPointerProject);
  const scalarPointerSource = resolve(scalarPointerProject, "main.zs");
  for (const fixtureName of [
    "self-host-foreign-scalar-pointers-input.zs",
    "scalar-pointers.h",
    "scalar-pointers.h.zd",
  ]) {
    const targetName = fixtureName == "self-host-foreign-scalar-pointers-input.zs"
      ? "main.zs"
      : fixtureName;
    writeFileSync(
      resolve(scalarPointerProject, targetName),
      readFileSync(resolve(projectRoot, "tests/fixtures", fixtureName), "utf8"),
    );
  }
  writeFileSync(
    resolve(scalarPointerProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-scalar-pointer-project",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const scalarPointerRun = spawnSync(
    driver,
    ["run", scalarPointerSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(scalarPointerRun.status, 0, scalarPointerRun.stderr);
  const emittedScalarPointerSource = readFileSync(
    resolve(scalarPointerProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(
    emittedScalarPointerSource,
    /z_mouse_state\(&\(x\), &\(y\)\)/,
  );
  assert.match(
    emittedScalarPointerSource,
    /z_mouse_state_checked\(parameter_0, parameter_1\)/,
  );
  assert.match(
    emittedScalarPointerSource,
    /z_increment_float\(&\(x\)\)/,
  );
  assert.match(
    emittedScalarPointerSource,
    /z_read_float\(&\(x\)\)/,
  );

  const scalarPointerContractPath = resolve(
    scalarPointerProject,
    "scalar-pointers.h.zd",
  );
  const scalarPointerContractSource = readFileSync(
    scalarPointerContractPath,
    "utf8",
  );
  writeFileSync(
    scalarPointerContractPath,
    scalarPointerContractSource.replace("in value: _", "out value: _"),
  );
  const constScalarOutput = spawnSync(
    driver,
    ["check", scalarPointerSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(constScalarOutput.status, 1);
  assert.match(
    constScalarOutput.stderr,
    /out scalar parameter "value" requires a mutable native pointer/,
  );
  writeFileSync(scalarPointerContractPath, scalarPointerContractSource);

  const scalarPointerProgramSource = readFileSync(scalarPointerSource, "utf8");
  writeFileSync(
    scalarPointerSource,
    scalarPointerProgramSource.replace("out x, out y", "inout x, out y"),
  );
  const scalarCapabilityMismatch = spawnSync(
    driver,
    ["check", scalarPointerSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(scalarCapabilityMismatch.status, 1);
  assert.match(
    scalarCapabilityMismatch.stderr,
    /requires out <mutable binding> for parameter 1/,
  );
  writeFileSync(scalarPointerSource, scalarPointerProgramSource);

  const unionProject = resolve(directory, "foreign-union-project");
  mkdirSync(unionProject);
  const unionSource = resolve(unionProject, "main.zs");
  for (const fixtureName of [
    "self-host-foreign-union-input.zs",
    "native-union.h",
    "native-union.h.zd",
  ]) {
    const targetName = fixtureName == "self-host-foreign-union-input.zs"
      ? "main.zs"
      : fixtureName;
    writeFileSync(
      resolve(unionProject, targetName),
      readFileSync(resolve(projectRoot, "tests/fixtures", fixtureName), "utf8"),
    );
  }
  writeFileSync(
    resolve(unionProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-union-project",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const unionRun = spawnSync(
    driver,
    ["run", unionSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(unionRun.status, 0, unionRun.stderr);
  const emittedUnionSource = readFileSync(
    resolve(unionProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(emittedUnionSource, /ZNativeEvent event;/);
  assert.match(emittedUnionSource, /z_native_poll\(&\(event\)\)/);
  assert.match(emittedUnionSource, /switch \(_z_stage1_native_match_\d+->type\)/);
  assert.match(emittedUnionSource, /case Z_NATIVE_EVENT_VALUE:/);
  assert.match(emittedUnionSource, /case Z_NATIVE_EVENT_TEXT:/);
  assert.match(emittedUnionSource, /&\(_z_stage1_native_match_\d+->value\)/);
  assert.match(
    emittedUnionSource,
    /const ZNativeTextEvent \* const _z_stage1_match_payload_\d+_\d+ = &\(_z_stage1_native_match_\d+->text\)/,
  );
  assert.match(emittedUnionSource, /_z_stage1_match_payload_\d+_\d+->text/);
  assert.doesNotMatch(emittedUnionSource, /event\.payload/);

  const unionProgramSource = readFileSync(unionSource, "utf8");
  writeFileSync(
    unionSource,
    unionProgramSource.replace(
      "const eventType = match (in event) {",
      "const eventType = match (event) {",
    ),
  );
  const consumingUnionMatch = spawnSync(
    driver,
    ["check", unionSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(consumingUnionMatch.status, 1);
  assert.match(
    consumingUnionMatch.stderr,
    /discriminated native union match requires match \(in value\)/,
  );

  writeFileSync(
    unionSource,
    `import native from "native-union.h";

function main(): i32 {
  const event = native.ZNativeEvent({ type: 42 });
  return 0;
}
`,
  );
  const unionConstruction = spawnSync(
    driver,
    ["check", unionSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(unionConstruction.status, 1);
  assert.match(
    unionConstruction.stderr,
    /native union "native.ZNativeEvent" cannot be constructed as a Z struct/,
  );

  writeFileSync(
    unionSource,
    `import native from "native-union.h";

function main(): i32 {
  const input = native.ZNativeTextEvent({ type: 44, sequence: 7 });
  return input.sequence;
}
`,
  );
  const viewRecordConstruction = spawnSync(
    driver,
    ["check", unionSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(viewRecordConstruction.status, 1);
  assert.match(
    viewRecordConstruction.stderr,
    /native record "native.ZNativeTextEvent" is view-only and cannot be constructed as a Z value/,
  );

  writeFileSync(
    unionSource,
    `import native from "native-union.h";

function main(): i32 {
  let event;
  native.z_native_poll_text(out event);
  return match (in event) {
    idle => 0;
    value(value) => value.value;
    text(input) => {
      const text = input.text;
      native.z_native_pump();
      if (text == null) return 1;
      select input.sequence;
    }
    other(type) => type;
  };
}
`,
  );
  const invalidatedUnionView = spawnSync(
    driver,
    ["check", unionSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidatedUnionView.status, 1);
  assert.match(
    invalidatedUnionView.stderr,
    /invalidates native lifetime .*eventMemory.*view "text" is live/,
  );
  writeFileSync(unionSource, unionProgramSource);
}, 300_000);

test("passes foreign records and borrowed resources through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const recordProject = resolve(directory, "foreign-record-project");
  mkdirSync(recordProject);
  const recordSource = resolve(recordProject, "main.zs");
  writeFileSync(
    recordSource,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-record-input.zs",
      ),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(recordProject, "geometry.h"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/geometry.h"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(recordProject, "geometry.h.zd"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/geometry.h.zd"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(recordProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-record-project",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const recordRun = spawnSync(
    driver,
    ["run", recordSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(recordRun.status, 31, recordRun.stderr);
  assert.match(recordRun.stdout, /compiled 1 Z modules/);
  const emittedRecordSource = readFileSync(
    resolve(recordProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(emittedRecordSource, /ZPoint point = \(ZPoint\)/);
  assert.match(
    emittedRecordSource,
    /ZPoint translated = z_translate\(point, ZForward, 3\)/,
  );
  assert.match(emittedRecordSource, /\.direction = ZForward/);
  assert.match(emittedRecordSource, /z_score\(translated\)/);
  assert.match(emittedRecordSource, /ZSize\)\{\.width = 640, \.height = 480\}/);
  assert.match(emittedRecordSource, /ZRect rect = \(ZRect\)/);
  assert.match(emittedRecordSource, /z_rect_id\(rect\)/);
  assert.match(emittedRecordSource, /z_offset\(&\(point\), 3, 4\)/);
  assert.match(emittedRecordSource, /z_read\(&\(point\)\)/);
  assert.match(emittedRecordSource, /z_reset\(&\(point\)\)/);

  // Imported C fields keep their ABI spelling even when the name is a C++ keyword.
  const fieldHygieneSource = resolve(recordProject, "field-hygiene.zs");
  writeFileSync(fieldHygieneSource, readFileSync(
    resolve(projectRoot, "tests/fixtures/field-hygiene-foreign.zs"), "utf8",
  ));
  writeFileSync(resolve(recordProject, "field-hygiene.h"), readFileSync(
    resolve(projectRoot, "tests/fixtures/field-hygiene.h"), "utf8",
  ));
  const fieldHygieneRun = spawnSync(driver, ["run", fieldHygieneSource], {
    encoding: "utf8", env: foreignAdapterEnvironment,
  });
  assert.equal(fieldHygieneRun.status, 0, fieldHygieneRun.stderr);
  const emittedFieldHygiene = readFileSync(
    resolve(recordProject, ".z-cache/run/program.c"), "utf8",
  );
  assert.match(emittedFieldHygiene, /\.template/);
  assert.doesNotMatch(emittedFieldHygiene, /\._z_field_template/);

  const resourceProject = resolve(directory, "foreign-resource-project");
  mkdirSync(resourceProject);
  const resourceSource = resolve(resourceProject, "main.zs");
  writeFileSync(
    resourceSource,
    readFileSync(
      resolve(
        projectRoot,
        "tests/fixtures/self-host-foreign-resource-input.zs",
      ),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(resourceProject, "value-resource.h"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/value-resource.h"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(resourceProject, "value-resource.h.zd"),
    readFileSync(
      resolve(projectRoot, "tests/fixtures/value-resource.h.zd"),
      "utf8",
    ),
  );
  writeFileSync(
    resolve(resourceProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-resource-project",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const resourceRun = spawnSync(
    driver,
    ["run", resourceSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(resourceRun.status, 124, resourceRun.stderr);
  const emittedResourceSource = readFileSync(
    resolve(resourceProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(
    emittedResourceSource,
    /void Z_ZImage_deinit\(ZImage const \*self\).*z_image_drop\(\*self\)/s,
  );
  assert.match(
    emittedResourceSource,
    /void Z_ZTexture2D_deinit\(ZTexture2D const \*self\).*z_texture_drop\(\*self\)/s,
  );
  assert.match(emittedResourceSource, /z_image_width\(image\)/);
  assert.match(emittedResourceSource, /z_image_drop\(copied\)/);
  assert.doesNotMatch(emittedResourceSource, /z_texture_drop\(systemTexture\)/);

  writeFileSync(
    resourceSource,
    `import native from "value-resource.h";

function leak(): native.ZTexture2D {
  const texture = native.z_texture_default();
  return texture;
}

function main(): i32 {
  return 0;
}
`,
  );
  const borrowedEscapeCheck = spawnSync(
    driver,
    ["check", resourceSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedEscapeCheck.status, 1);
  assert.match(
    borrowedEscapeCheck.stderr,
    /a borrowed native resource cannot be returned from Z code/,
  );

  writeFileSync(
    resourceSource,
    `import native from "value-resource.h";

struct Theme {
  texture: native.ZTexture2D;
}

function main(): i32 {
  const texture = native.z_texture_default();
  const theme = Theme({ texture });
  return native.z_texture_width(theme.texture);
}
`,
  );
  const borrowedStorageCheck = spawnSync(
    driver,
    ["check", resourceSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedStorageCheck.status, 1);
  assert.match(
    borrowedStorageCheck.stderr,
    /a borrowed native resource cannot escape into owned storage or an owned value result/,
  );

  writeFileSync(
    resourceSource,
    `import native from "value-resource.h";

function main(): i32 {
  const image = native.z_image_make(1);
  native.z_image_drop(move image);
  return native.z_image_width(image);
}
`,
  );
  const resourceUseAfterMove = spawnSync(
    driver,
    ["check", resourceSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(resourceUseAfterMove.status, 1);
  assert.match(resourceUseAfterMove.stderr, /use of moved value "image"/);

  writeFileSync(
    resolve(recordProject, "geometry.h"),
    `${readFileSync(resolve(projectRoot, "tests/fixtures/geometry.h"), "utf8")}
typedef union ZBits {
  int integer;
  float decimal;
} ZBits;

static inline int z_bits_integer(ZBits bits) {
  return bits.integer;
}
`,
  );
  writeFileSync(
    resolve(recordProject, "geometry.h.zd"),
    `declare module "geometry.h" {
  export function z_bits_integer(bits: _): _;
}
`,
  );
  writeFileSync(
    recordSource,
    `import geometry from "geometry.h";

function main(): i32 {
  return 0;
}
`,
  );
  const unsupportedUnionCheck = spawnSync(
    driver,
    ["check", recordSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(unsupportedUnionCheck.status, 1);
  assert.match(
    unsupportedUnionCheck.stderr,
    /record value ZBits requires a scalar-field struct layout/,
  );
}, 300_000);

test("enforces owned foreign handle contracts through the standalone native driver", () => {
  const { directory, driver, foreignAdapterEnvironment } = standaloneDriver();
  const handleProject = resolve(directory, "foreign-handle-project");
  mkdirSync(handleProject);
  const handleSource = resolve(handleProject, "main.zs");
  for (const fixtureName of [
    "self-host-foreign-handle-input.zs",
    "owned-handle-native.h",
    "owned-handle-native.h.zd",
  ]) {
    const targetName = fixtureName == "self-host-foreign-handle-input.zs"
      ? "main.zs"
      : fixtureName;
    writeFileSync(
      resolve(handleProject, targetName),
      readFileSync(resolve(projectRoot, "tests/fixtures", fixtureName), "utf8"),
    );
  }
  writeFileSync(
    resolve(handleProject, "z.json"),
    `${JSON.stringify({
      target: {
        name: "foreign-handle-project",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const handleRun = spawnSync(
    driver,
    ["run", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(handleRun.status, 0, handleRun.stderr);
  const emittedHandleSource = readFileSync(
    resolve(handleProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(
    emittedHandleSource,
    /typedef ZOwnedHandle \* Z_Handle_native_ZOwnedHandle;/,
  );
  assert.match(
    emittedHandleSource,
    /Z___z_Option_Z_Handle_native_ZOwnedHandle_from_nullable/,
  );
  assert.match(
    emittedHandleSource,
    /Z_Handle_native_ZOwnedHandle handle = NULL;/,
  );
  assert.match(
    emittedHandleSource,
    /z_owned_handle_create\(parameter_0, parameter_1\)/,
  );
  assert.match(
    emittedHandleSource,
    /z_owned_handle_read_with_policy\(owner, Z_OWNED_HANDLE_POLICY\)/,
  );
  assert.match(
    emittedHandleSource,
    /z_owned_handle_apply_policy\(parameter_0, Z_OWNED_HANDLE_POLICY\)/,
  );
  assert.match(
    emittedHandleSource,
    /z_owned_handle_apply_callback_policy\(owner, Z_OWNED_HANDLE_CALLBACK_POLICY\)/,
  );
  assert.match(
    emittedHandleSource,
    /z_owned_handle_has_null_tail\(owner, NULL\)/,
  );
  assert.match(
    emittedHandleSource,
    /const char \* const label = \(\(const char \*\)\(z_owned_handle_unsigned_label\(owner\)\)\)/,
  );
  assert.match(
    emittedHandleSource,
    /Z_String text = z_stage1_string_from_cstring\(label\)/,
  );
  assert.match(
    emittedHandleSource,
    // A literal is already NUL-terminated static storage, passed as a C literal.
    /z_owned_handle_matches_label\(owner, "value"\)/,
  );
  assert.match(
    emittedHandleSource,
    /if \(self == NULL \|\| \*self == NULL\) return;\s+z_owned_handle_close\(\*self\)/,
  );

  const handleContractPath = resolve(
    handleProject,
    "owned-handle-native.h.zd",
  );
  const handleContractSource = readFileSync(handleContractPath, "utf8");
  writeFileSync(
    handleContractPath,
    handleContractSource.replace(
      "fixed Z_OWNED_HANDLE_POLICY;",
      "fixed Z_OWNED_HANDLE_UNKNOWN;",
    ),
  );
  const unknownFixedParameter = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(unknownFixedParameter.status, 1);
  assert.match(
    unknownFixedParameter.stderr,
    /unknown foreign constant "Z_OWNED_HANDLE_UNKNOWN"/,
  );

  writeFileSync(
    handleContractPath,
    handleContractSource.replace(
      "fixed Z_OWNED_HANDLE_CALLBACK_POLICY;",
      "fixed Z_OWNED_HANDLE_WRONG_CALLBACK_POLICY;",
    ),
  );
  const mismatchedFixedCallbackParameter = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(mismatchedFixedCallbackParameter.status, 1);
  assert.match(
    mismatchedFixedCallbackParameter.stderr,
    /fixed foreign constant "Z_OWNED_HANDLE_WRONG_CALLBACK_POLICY" has type int \(\*\)\(void \*\), expected ZOwnedHandleCallbackPolicy/,
  );

  writeFileSync(
    handleContractPath,
    handleContractSource.replace(
      "policy: _ { fixed Z_OWNED_HANDLE_POLICY; }",
      "policy: null",
    ),
  );
  const scalarNullOnlyParameter = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(scalarNullOnlyParameter.status, 1);
  assert.match(
    scalarNullOnlyParameter.stderr,
    /null-only foreign parameter "policy" requires a C pointer parameter/,
  );
  writeFileSync(handleContractPath, handleContractSource);

  writeFileSync(
    handleContractPath,
    handleContractSource.replace(
      "export function z_owned_handle_read(in handle: _): _;",
      "export function z_owned_handle_read(in handle: _): view cstring;",
    ),
  );
  const mismatchedTextView = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(mismatchedTextView.status, 1);
  assert.match(
    mismatchedTextView.stderr,
    /native borrowed text producer "z_owned_handle_read" must return a character pointer/,
  );
  writeFileSync(handleContractPath, handleContractSource);

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return 1;
  const child = Option.fromNullable(native.z_owned_handle_child(in owner));
  native.z_owned_handle_close(move owner);
  return match (in child) {
    some(value) => native.z_owned_child_read(in value);
    none => -1;
  };
}
`,
  );
  const ownerMoveWithLiveChild = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(ownerMoveWithLiveChild.status, 1);
  assert.match(
    ownerMoveWithLiveChild.stderr,
    /cannot move "owner" while view "child" is live/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return 1;
  const child = Option.fromNullable(native.z_owned_handle_child(in owner));
  native.z_owned_handle_advance(in owner);
  return match (in child) {
    some(value) => native.z_owned_child_read(in value);
    none => -1;
  };
}
`,
  );
  const invalidationWithLiveChild = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidationWithLiveChild.status, 1);
  assert.match(
    invalidationWithLiveChild.stderr,
    /cannot call "z_owned_handle_advance" because it can invalidate views derived from "owner" while view "child" is live/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return 1;
  {
    const child = native.z_owned_handle_child(in owner);
    if (child == null) return 2;
    if (native.z_owned_child_read(in child) != 43) return 3;
  }
  return native.z_owned_handle_advance(in owner) - 43;
}
`,
  );
  const invalidationAfterViewScope = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidationAfterViewScope.status, 0, invalidationAfterViewScope.stderr);

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const owner = native.z_owned_handle_open(42);
  if (owner == null) return 1;
  const label = native.z_owned_handle_label(in owner);
  native.z_owned_handle_advance(in owner);
  if (label == null) return 2;
  return native.z_owned_handle_read(in owner);
}
`,
  );
  const invalidationWithLiveText = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidationWithLiveText.status, 1);
  assert.match(
    invalidationWithLiveText.stderr,
    /cannot call "z_owned_handle_advance" because it can invalidate views derived from "owner" while view "label" is live/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const handle = native.z_owned_handle_open(42);
  if (handle == null) return 1;
  native.z_owned_handle_close(move handle);
  return native.z_owned_handle_read(in handle);
}
`,
  );
  const handleUseAfterMove = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(handleUseAfterMove.status, 1);
  assert.match(handleUseAfterMove.stderr, /use of moved value "handle"/);

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function exposeDefault(): native.ZOwnedHandle | null {
  return native.z_owned_handle_default();
}

function main(): i32 {
  return 0;
}
`,
  );
  const borrowedHandleReturn = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedHandleReturn.status, 1);
  assert.match(
    borrowedHandleReturn.stderr,
    /a borrowed native resource cannot be returned from Z code/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

struct StoredHandle {
  handle: native.ZOwnedHandle;
}

function main(): i32 {
  const handle = native.z_owned_handle_default();
  if (handle == null) return 1;
  const stored = StoredHandle({ handle });
  return native.z_owned_handle_read(in stored.handle);
}
`,
  );
  const borrowedHandleStorage = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedHandleStorage.status, 1);
  assert.match(
    borrowedHandleStorage.stderr,
    /a borrowed native resource cannot escape into owned storage or an owned value result/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const handle = native.z_owned_handle_default();
  if (handle == null) return 1;
  const inspect = (): i32 => native.z_owned_handle_read(in handle);
  return inspect();
}
`,
  );
  const borrowedHandleCapture = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedHandleCapture.status, 1);
  assert.match(
    borrowedHandleCapture.stderr,
    /borrowed native resource "handle" cannot escape into a closure/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const handle = native.z_owned_handle_default();
  if (handle == null) return 1;
  native.z_owned_handle_close(move handle);
  return 0;
}
`,
  );
  const borrowedHandleConsume = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedHandleConsume.status, 1);
  assert.match(
    borrowedHandleConsume.stderr,
    /cannot move a view because it does not own the referenced value/,
  );

  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const invalid = Option.fromNullable(native.z_owned_handle_default());
  return 0;
}
`,
  );
  const borrowedNullableLift = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedNullableLift.status, 1);
  assert.match(
    borrowedNullableLift.stderr,
    /Option\.fromNullable cannot lift a borrowed native resource into owned Option storage/,
  );

  writeFileSync(
    handleSource,
    `function main(): i32 {
  const invalid = Option.fromNullable(42);
  return 0;
}
`,
  );
  const invalidNullableLift = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidNullableLift.status, 1);
  assert.match(
    invalidNullableLift.stderr,
    /Option\.fromNullable expects T \| null, found i32/,
  );

  writeFileSync(
    resolve(handleProject, "owned-handle-native.h.zd"),
    `declare module "owned-handle-native.h" {
  export function z_owned_handle_default(): _ | null {
    borrowed;
  }
}
`,
  );
  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const handle = native.z_owned_handle_default();
  if (handle == null) return 1;
  return 0;
}
`,
  );
  const borrowedOnlyHandle = spawnSync(
    driver,
    ["run", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(borrowedOnlyHandle.status, 0, borrowedOnlyHandle.stderr);
  const borrowedOnlySource = readFileSync(
    resolve(handleProject, ".z-cache/run/program.c"),
    "utf8",
  );
  assert.match(
    borrowedOnlySource,
    /typedef ZOwnedHandle \* Z_Handle_native_ZOwnedHandle;/,
  );
  assert.doesNotMatch(
    borrowedOnlySource,
    /Z_Z_Handle_native_ZOwnedHandle_deinit/,
  );

  writeFileSync(
    resolve(handleProject, "owned-handle-native.h.zd"),
    `declare module "owned-handle-native.h" {
  export function z_owned_handle_open(value: _): _ | null {
    deinit z_owned_handle_read;
  }
}
`,
  );
  writeFileSync(
    handleSource,
    `import native from "owned-handle-native.h";

function main(): i32 {
  const handle = native.z_owned_handle_open(42);
  return 0;
}
`,
  );
  const invalidHandleRelease = spawnSync(
    driver,
    ["check", handleSource],
    {
      encoding: "utf8",
      env: foreignAdapterEnvironment,
    },
  );
  assert.equal(invalidHandleRelease.status, 1);
  assert.match(
    invalidHandleRelease.stderr,
    /API notes for "z_owned_handle_open" require "z_owned_handle_read" to consume exactly one ZOwnedHandle \*/,
  );
}, 300_000);

test("compiles a multi-module Z application through the standalone native driver", () => {
  const { directory, driver } = standaloneDriver();
  const applicationSource = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-modules/main.zs",
  );
  const checking = spawnSync(
    driver,
    [
      "check",
      applicationSource.replace(
        "/self-host-emit-modules/",
        "/self-host-emit-modules/../self-host-emit-modules/",
      ),
    ],
    { encoding: "utf8" },
  );
  assert.equal(checking.status, 0, checking.stderr);
  assert.match(checking.stdout, /checked 2 Z modules/);

  const emittedSource = resolve(directory, "emitted.c");
  const emitting = spawnSync(
    driver,
    ["emit", applicationSource, emittedSource],
    { encoding: "utf8" },
  );
  assert.equal(emitting.status, 0, emitting.stderr);
  assert.match(emitting.stdout, /emitted 2 Z modules/);
  const emittedApplicationSource = readFileSync(emittedSource, "utf8");
  assert.match(emittedApplicationSource, /int32_t main\(void\)/);
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_usize_to_i32\(widened\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_i32_to_usize\(z_signed\)/,
  );
  assert.match(
    emittedApplicationSource,
    /const int64_t wideSigned = \(\(int64_t\)\(z_signed\)\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_i64_to_i32\(wideSigned\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_i64_to_u64\(wideSigned\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_u64_to_i64\(unsignedWide\)/,
  );
  assert.match(
    emittedApplicationSource,
    /uint64_t z_stage1_checked_convert_i64_to_u64\(int64_t value\) \{\n  if \(value < 0\) abort\(\);/,
  );
  assert.match(
    emittedApplicationSource,
    /int64_t z_stage1_checked_convert_u64_to_i64\(uint64_t value\) \{\n  if \(value > \(uint64_t\)INT64_MAX\) abort\(\);/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_divide_i64\(z_stage1_checked_subtract_i64\(wideMaximum,/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_add_i64\(z_stage1_checked_multiply_i64\(wideSigned,/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_negate_i64\(wideMaximum\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_subtract_i64\(wideMinimum,/,
  );
  assert.match(
    emittedApplicationSource,
    /const int32_t minimum = (?:INT32_MIN|-2147483648);/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_checked_convert_usize_to_u8\(native\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_wrapping_add_u8\(maximum, 1\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_wrapping_subtract_u8\(wrappedAdd, 1\)/,
  );
  assert.match(
    emittedApplicationSource,
    /z_stage1_wrapping_multiply_u8\(maximum, 2\)/,
  );

  const application = resolve(directory, "application");
  const compilation = spawnSync(
    driver,
    ["build", applicationSource, application],
    { encoding: "utf8" },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  assert.match(compilation.stdout, /compiled 2 Z modules/);
  assert.equal(existsSync(`${application}.c`), true);

  const execution = spawnSync(application, [], { encoding: "utf8" });
  assert.equal(execution.status, 42, execution.stderr);

  const narrowingSource = resolve(directory, "native-narrowing.zs");
  const narrowingApplication = resolve(directory, "native-narrowing");
  writeFileSync(
    narrowingSource,
    "function main(): i32 {\n"
      + "  const signed: i32 = -1;\n"
      + "  return i32(u8(signed));\n"
      + "}\n",
  );
  const narrowingCompilation = spawnSync(
    driver,
    ["build", narrowingSource, narrowingApplication],
    { encoding: "utf8" },
  );
  assert.equal(
    narrowingCompilation.status,
    0,
    narrowingCompilation.stderr,
  );
  const narrowingExecution = spawnSync(
    narrowingApplication,
    [],
    { encoding: "utf8" },
  );
  assert.notEqual(narrowingExecution.status, 0);

  const floatingConversionSource = resolve(
    directory,
    "native-floating-conversion.zs",
  );
  writeFileSync(
    floatingConversionSource,
    'import math from "std/math";\n'
      + "function main(): i32 {\n"
      + "  const width: u32 = 42;\n"
      + "  const native = f64(width);\n"
      + "  return i32(u32(math.trunc(native + 0.75)));\n"
      + "}\n",
  );
  const floatingConversionCheck = spawnSync(
    driver,
    ["check", floatingConversionSource],
    { encoding: "utf8" },
  );
  assert.equal(
    floatingConversionCheck.status,
    0,
    floatingConversionCheck.stderr,
  );
  const floatingConversionApplication = resolve(
    directory,
    "native-floating-conversion",
  );
  const floatingConversionBuild = spawnSync(
    driver,
    ["build", floatingConversionSource, floatingConversionApplication],
    { encoding: "utf8" },
  );
  assert.equal(floatingConversionBuild.status, 0, floatingConversionBuild.stderr);
  const floatingConversionExecution = spawnSync(
    floatingConversionApplication,
    [],
    { encoding: "utf8" },
  );
  assert.equal(floatingConversionExecution.status, 42, floatingConversionExecution.stderr);
}, 300_000);

test("builds manifest and package projects through the standalone native driver", () => {
  const { directory, driver } = standaloneDriver();
  const applicationSource = resolve(projectRoot, "tests/fixtures/self-host-emit-modules/main.zs");
  const cExportProject = resolve(projectRoot, "examples/interop/c/z-export");
  const manifestProject = resolve(directory, "manifest-project");
  const manifestInclude = resolve(manifestProject, "include");
  const manifestLibrary = resolve(manifestProject, "lib");
  mkdirSync(manifestInclude, { recursive: true });
  mkdirSync(manifestLibrary, { recursive: true });
  writeFileSync(
    resolve(manifestProject, "main.zs"),
    [
      'import { answer } from "./value.zs";',
      "function main(): i32 { return answer(); }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(manifestProject, "value.zs"),
    "export function answer(): i32 { return 42; }\n",
  );
  const nativeLibrarySource = resolve(manifestProject, "native.c");
  const nativeLibraryObject = resolve(manifestLibrary, "native.o");
  const nativeLibraryArchive = resolve(manifestLibrary, "libzmanifest.a");
  writeFileSync(nativeLibrarySource, "int z_manifest_fixture(void) { return 1; }\n");
  const nativeLibraryCompilation = spawnSync(
    "clang",
    ["-c", nativeLibrarySource, "-o", nativeLibraryObject],
    { encoding: "utf8" },
  );
  assert.equal(nativeLibraryCompilation.status, 0, nativeLibraryCompilation.stderr);
  const nativeLibraryArchiving = spawnSync(
    "ar",
    ["rcs", nativeLibraryArchive, nativeLibraryObject],
    { encoding: "utf8" },
  );
  assert.equal(nativeLibraryArchiving.status, 0, nativeLibraryArchiving.stderr);
  const manifest = {
    target: {
      name: "manifest-application",
      entry: "main.zs",
      ...(process.platform === "darwin"
        ? { platform: "macos", minimumVersion: "14.0" }
        : {}),
      includeDirectories: ["include", "include"],
      link: {
        directories: ["lib", "lib"],
        libraries: ["zmanifest", "zmanifest"],
        ...(process.platform === "darwin"
          ? { frameworks: ["Foundation", "Foundation"] }
          : {}),
      },
    },
  };
  writeFileSync(
    resolve(manifestProject, "z.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const manifestApplication = resolve(directory, "manifest-application");
  const manifestCompilation = spawnSync(
    driver,
    ["build", resolve(manifestProject, "main.zs"), manifestApplication],
    { encoding: "utf8" },
  );
  assert.equal(manifestCompilation.status, 0, manifestCompilation.stderr);
  const manifestExecution = spawnSync(manifestApplication, [], { encoding: "utf8" });
  assert.equal(manifestExecution.status, 42, manifestExecution.stderr);

  const manifestProjectCheck = spawnSync(
    driver,
    ["check", manifestProject],
    { encoding: "utf8" },
  );
  assert.equal(
    manifestProjectCheck.status,
    0,
    manifestProjectCheck.stderr,
  );
  const defaultManifestProjectCheck = spawnSync(
    driver,
    ["check"],
    { cwd: manifestProject, encoding: "utf8" },
  );
  assert.equal(
    defaultManifestProjectCheck.status,
    0,
    defaultManifestProjectCheck.stderr,
  );
  const manifestFileCheck = spawnSync(
    driver,
    ["check", resolve(manifestProject, "value.zs")],
    { encoding: "utf8" },
  );
  assert.equal(manifestFileCheck.status, 0, manifestFileCheck.stderr);

  const packageImportProject = resolve(directory, "package-import-project");
  const packageRoot = resolve(directory, "package-import-zapp");
  const packageUtility = resolve(directory, "package-import-utility");
  mkdirSync(packageImportProject, { recursive: true });
  mkdirSync(resolve(packageRoot, "src"), { recursive: true });
  mkdirSync(resolve(packageUtility, "src"), { recursive: true });
  mkdirSync(resolve(packageUtility, "include"), { recursive: true });
  writeFileSync(
    resolve(packageImportProject, "main.zs"),
    [
      'import { frameworkAnswer } from "zapp";',
      'import { windowAnswer } from "zapp/window";',
      "function main(): i32 { return frameworkAnswer() + windowAnswer() - 42; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(packageRoot, "src/zapp.zs"),
    [
      'import { baseAnswer } from "utility";',
      "internal function generatedBaseAnswer(): i32 { return 40; }",
      "export function frameworkAnswer(): i32 { return baseAnswer(); }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(packageRoot, "src/window.zs"),
    "export function windowAnswer(): i32 { return 2; }\n",
  );
  writeFileSync(
    resolve(packageUtility, "src/utility.zs"),
    "export function baseAnswer(): i32 { return 40; }\n",
  );
  writeFileSync(
    resolve(packageUtility, "z.json"),
    `${JSON.stringify({
      package: { name: "utility", version: "0.1.0" },
      library: {
        entry: "src/utility.zs",
        native: { includeDirectories: ["include"] },
      },
    }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(packageRoot, "z.json"),
    `${JSON.stringify({
      package: { name: "zapp", version: "0.1.0-dev.1+local" },
      library: {
        entry: "src/zapp.zs",
        exports: { "./window": "src/window.zs" },
      },
      dependencies: { utility: { path: "../package-import-utility" } },
    }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(packageImportProject, "z.json"),
    `${JSON.stringify({
      dependencies: { zapp: { path: "../package-import-zapp" } },
      target: {
        name: "package-import-application",
        entry: "main.zs",
      },
    }, null, 2)}\n`,
  );
  const packageImportCheck = spawnSync(
    driver,
    ["check", packageImportProject],
    { encoding: "utf8" },
  );
  assert.equal(packageImportCheck.status, 0, packageImportCheck.stderr);
  const generatedDirectory = resolve(directory, "package-generated");
  mkdirSync(generatedDirectory, { recursive: true });
  writeFileSync(
    resolve(generatedDirectory, "services.zs"),
    [
      'import { generatedBaseAnswer } from "zapp";',
      "export function generatedAnswer(): i32 { return generatedBaseAnswer() + 2; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(packageImportProject, "generated-main.zs"),
    [
      'import { generatedAnswer } from "zapp/generated/services";',
      "function main(): i32 { return generatedAnswer() - 42; }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(packageImportProject, "z.json"),
    `${JSON.stringify({
      dependencies: { zapp: { path: "../package-import-zapp" } },
      target: {
        name: "package-import-application",
        entry: "generated-main.zs",
      },
    }, null, 2)}\n`,
  );
  const generatedOverlay = resolve(generatedDirectory, "services.zbuild.json");
  writeFileSync(
    generatedOverlay,
    `${JSON.stringify({
      schemaVersion: 1,
      modules: {
        "zapp/generated/services": {
          source: "services.zs",
          package: "zapp",
        },
      },
      callAdapters: [],
    }, null, 2)}\n`,
  );
  const generatedPackageCheck = spawnSync(
    driver,
    ["check", packageImportProject, "--generated", generatedOverlay],
    { encoding: "utf8" },
  );
  assert.equal(
    generatedPackageCheck.status,
    0,
    generatedPackageCheck.stderr,
  );
  assert.match(generatedPackageCheck.stdout, /checked 4 Z modules/);
  const generatedMetadata = spawnSync(
    driver,
    ["metadata", "--generated", generatedOverlay, packageImportProject],
    { encoding: "utf8" },
  );
  assert.equal(generatedMetadata.status, 0, generatedMetadata.stderr);
  assert.match(generatedMetadata.stdout, /generatedAnswer/);
  const packageLibraryCheck = spawnSync(
    driver,
    ["check", packageRoot],
    { encoding: "utf8" },
  );
  assert.equal(packageLibraryCheck.status, 0, packageLibraryCheck.stderr);
  const privatePackageImport = resolve(packageImportProject, "private-import.zs");
  writeFileSync(
    privatePackageImport,
    [
      'import { privateValue } from "zapp/private";',
      "function main(): i32 { return privateValue(); }",
      "",
    ].join("\n"),
  );
  const privatePackageCheck = spawnSync(
    driver,
    ["check", privatePackageImport],
    { encoding: "utf8" },
  );
  assert.notEqual(privatePackageCheck.status, 0);
  assert.match(
    privatePackageCheck.stderr,
    /package "zapp" does not export subpath "\.\/private"/,
  );

  const manifestProjectEmit = spawnSync(
    driver,
    ["emit", manifestProject],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(
    manifestProjectEmit.status,
    0,
    manifestProjectEmit.stderr,
  );
  const manifestPathEmit = spawnSync(
    driver,
    ["emit", resolve(manifestProject, "z.json")],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(manifestPathEmit.status, 0, manifestPathEmit.stderr);
  const defaultManifestProjectEmit = spawnSync(
    driver,
    ["emit"],
    {
      cwd: manifestProject,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(
    defaultManifestProjectEmit.status,
    0,
    defaultManifestProjectEmit.stderr,
  );
  assert.match(
    manifestProjectEmit.stdout,
    /int32_t main\(void\)/,
  );
  assert.equal(manifestPathEmit.stdout, manifestProjectEmit.stdout);
  assert.equal(defaultManifestProjectEmit.stdout, manifestProjectEmit.stdout);

  const manifestProjectBuild = spawnSync(
    driver,
    ["build", resolve(manifestProject, "z.json")],
    { encoding: "utf8" },
  );
  assert.equal(
    manifestProjectBuild.status,
    0,
    manifestProjectBuild.stderr,
  );
  assert.match(
    manifestProjectBuild.stdout,
    /build\/manifest-application/,
  );
  const builtManifestApplication = resolve(
    manifestProject,
    "build/manifest-application",
  );
  utimesSync(builtManifestApplication, 0, 0);
  const cachedManifestProjectBuild = spawnSync(
    driver,
    ["build", resolve(manifestProject, "z.json")],
    { encoding: "utf8" },
  );
  assert.equal(
    cachedManifestProjectBuild.status,
    0,
    cachedManifestProjectBuild.stderr,
  );
  assert.match(
    cachedManifestProjectBuild.stdout,
    /cache hit: reused build\/manifest-application/,
  );
  assert.equal(statSync(builtManifestApplication).mtimeMs, 0);
  const manifestValueSource = resolve(manifestProject, "value.zs");
  writeFileSync(
    manifestValueSource,
    `${readFileSync(manifestValueSource, "utf8")}\n`,
  );
  const invalidatedManifestProjectBuild = spawnSync(
    driver,
    ["build", resolve(manifestProject, "z.json")],
    { encoding: "utf8" },
  );
  assert.equal(
    invalidatedManifestProjectBuild.status,
    0,
    invalidatedManifestProjectBuild.stderr,
  );
  assert.doesNotMatch(invalidatedManifestProjectBuild.stdout, /cache hit:/);
  assert.ok(statSync(builtManifestApplication).mtimeMs > 0);
  const builtManifestExecution = spawnSync(
    builtManifestApplication,
    [],
    { encoding: "utf8" },
  );
  assert.equal(
    builtManifestExecution.status,
    42,
    builtManifestExecution.stderr,
  );
  const manifestProjectRun = spawnSync(
    driver,
    ["run", manifestProject],
    { encoding: "utf8" },
  );
  assert.equal(manifestProjectRun.status, 42, manifestProjectRun.stderr);
  const defaultManifestProjectRun = spawnSync(
    driver,
    ["run"],
    { cwd: manifestProject, encoding: "utf8" },
  );
  assert.equal(
    defaultManifestProjectRun.status,
    42,
    defaultManifestProjectRun.stderr,
  );

  const projectWithoutMain = resolve(directory, "project-without-main");
  mkdirSync(projectWithoutMain);
  const projectWithoutMainEntry = resolve(projectWithoutMain, "tests.zs");
  writeFileSync(
    projectWithoutMainEntry,
    [
      "export function answer(): i32 { return 42; }",
      'test "project tests do not require main" {}',
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(projectWithoutMain, "z.json"),
    JSON.stringify({
      target: {
        name: "project-without-main",
        entry: "tests.zs",
      },
    }),
  );
  const missingProjectMainCheck = spawnSync(
    driver,
    ["check", projectWithoutMain],
    { encoding: "utf8" },
  );
  assert.equal(missingProjectMainCheck.status, 1);
  assert.match(
    missingProjectMainCheck.stderr,
    /program must declare `function main\(\): i32`/,
  );
  const missingFileMainCheck = spawnSync(
    driver,
    ["check", projectWithoutMainEntry],
    { encoding: "utf8" },
  );
  assert.equal(
    missingFileMainCheck.status,
    0,
    missingFileMainCheck.stderr,
  );
  const projectTestWithoutMain = spawnSync(
    driver,
    ["test", projectWithoutMain],
    { encoding: "utf8" },
  );
  assert.equal(
    projectTestWithoutMain.status,
    0,
    projectTestWithoutMain.stderr,
  );
  const defaultProjectTestWithoutMain = spawnSync(
    driver,
    ["test"],
    { cwd: projectWithoutMain, encoding: "utf8" },
  );
  assert.equal(
    defaultProjectTestWithoutMain.status,
    0,
    defaultProjectTestWithoutMain.stderr,
  );

  const staticProjectCheck = spawnSync(
    driver,
    ["check", cExportProject],
    { encoding: "utf8" },
  );
  assert.equal(staticProjectCheck.status, 0, staticProjectCheck.stderr);
  const staticProjectRun = spawnSync(
    driver,
    ["run", cExportProject],
    { encoding: "utf8" },
  );
  assert.equal(staticProjectRun.status, 1);
  assert.match(
    staticProjectRun.stderr,
    /z run requires an executable project, but target.kind is "static-library"/,
  );

  const sharedProject = resolve(directory, "shared-project");
  mkdirSync(sharedProject);
  writeFileSync(
    resolve(sharedProject, "library.zs"),
    "export c function z_native_shared_answer(): i32 { return 42; }\n",
  );
  writeFileSync(
    resolve(sharedProject, "z.json"),
    JSON.stringify({
      target: {
        kind: "shared-library",
        name: "native_shared",
        entry: "library.zs",
      },
    }),
  );
  const sharedProjectCheck = spawnSync(
    driver,
    ["check", sharedProject],
    { encoding: "utf8" },
  );
  assert.equal(sharedProjectCheck.status, 0, sharedProjectCheck.stderr);
  const sharedProjectEmit = spawnSync(
    driver,
    ["emit", sharedProject],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(sharedProjectEmit.status, 0, sharedProjectEmit.stderr);
  assert.match(sharedProjectEmit.stdout, /z_native_shared_answer/);
  const sharedProjectBuild = spawnSync(
    driver,
    ["build", sharedProject, "--release"],
    { encoding: "utf8" },
  );
  assert.equal(sharedProjectBuild.status, 0, sharedProjectBuild.stderr);
  assert.equal(
    existsSync(resolve(sharedProject, "build/libnative_shared.dylib")),
    true,
  );
  assert.equal(
    existsSync(resolve(sharedProject, "build/native_shared.h")),
    true,
  );
  const sharedProjectRun = spawnSync(
    driver,
    ["run", sharedProject],
    { encoding: "utf8" },
  );
  assert.equal(sharedProjectRun.status, 1);
  assert.match(
    sharedProjectRun.stderr,
    /z run requires an executable project, but target.kind is "shared-library"/,
  );

  const staticFileModeProject = resolve(directory, "static-file-mode");
  mkdirSync(staticFileModeProject);
  writeFileSync(
    resolve(staticFileModeProject, "library.zs"),
    "export c function z_static_answer(): i32 { return 42; }\n",
  );
  const staticFileModeMain = resolve(staticFileModeProject, "main.zs");
  writeFileSync(
    staticFileModeMain,
    "function main(): i32 { return 0; }\n",
  );
  writeFileSync(
    resolve(staticFileModeProject, "z.json"),
    JSON.stringify({
      target: {
        kind: "static-library",
        name: "static-file-mode",
        entry: "library.zs",
      },
    }),
  );
  const staticAdHocRun = spawnSync(
    driver,
    ["run", staticFileModeMain],
    { encoding: "utf8" },
  );
  assert.equal(staticAdHocRun.status, 0, staticAdHocRun.stderr);

  const invalidExecutableManifest = resolve(
    directory,
    "invalid-executable-manifest",
  );
  mkdirSync(invalidExecutableManifest);
  writeFileSync(
    resolve(invalidExecutableManifest, "main.zs"),
    "function main(): i32 { return 0; }\n",
  );
  writeFileSync(
    resolve(invalidExecutableManifest, "z.json"),
    JSON.stringify({ target: { entry: "main.zs" } }),
  );
  const missingTargetName = spawnSync(
    driver,
    ["check", invalidExecutableManifest],
    { encoding: "utf8" },
  );
  assert.equal(missingTargetName.status, 1);
  assert.match(
    missingTargetName.stderr,
    /executable target requires target.name/,
  );
  writeFileSync(
    resolve(invalidExecutableManifest, "z.json"),
    JSON.stringify({ target: { name: "missing-entry" } }),
  );
  const missingTargetEntry = spawnSync(
    driver,
    ["check", invalidExecutableManifest],
    { encoding: "utf8" },
  );
  assert.equal(missingTargetEntry.status, 1);
  assert.match(
    missingTargetEntry.stderr,
    /executable target requires target.entry/,
  );
  writeFileSync(
    resolve(invalidExecutableManifest, "z.json"),
    JSON.stringify({
      target: {
        name: "unknown-field",
        entry: "main.zs",
        artifact: "typo",
      },
    }),
  );
  const unknownTargetField = spawnSync(
    driver,
    ["check", invalidExecutableManifest],
    { encoding: "utf8" },
  );
  assert.equal(unknownTargetField.status, 1);
  assert.match(
    unknownTargetField.stderr,
    /target contains unknown field "artifact"/,
  );

  const strictCheckOptions = spawnSync(
    driver,
    ["check", resolve(manifestProject, "main.zs"), "--unexpected"],
    { encoding: "utf8" },
  );
  assert.equal(strictCheckOptions.status, 2);
  const strictRunArguments = spawnSync(
    driver,
    ["run", resolve(manifestProject, "main.zs"), "argument"],
    { encoding: "utf8" },
  );
  assert.equal(strictRunArguments.status, 2);
  assert.match(
    strictRunArguments.stderr,
    /pass program arguments after --/,
  );
  const projectEmit = spawnSync(
    driver,
    ["emit", manifestProject, resolve(directory, "project-output.c")],
    { encoding: "utf8" },
  );
  assert.equal(projectEmit.status, 1);
  assert.match(
    projectEmit.stderr,
    /z emit currently requires an explicit .zs source file/,
  );

  writeFileSync(
    resolve(manifestProject, "z.json"),
    JSON.stringify({
      target: {
        name: "manifest-application",
        entry: "main.zs",
        includeDirectories: ["missing"],
      },
    }),
  );
  const missingDirectoryCheck = spawnSync(
    driver,
    ["check", resolve(manifestProject, "main.zs")],
    { encoding: "utf8" },
  );
  assert.equal(missingDirectoryCheck.status, 1);
  assert.match(
    missingDirectoryCheck.stderr,
    /target\.includeDirectories directory .*missing.* does not exist/,
  );

  writeFileSync(resolve(manifestProject, "z.json"), '{"target": ');
  const malformedManifestCheck = spawnSync(
    driver,
    ["check", resolve(manifestProject, "main.zs")],
    { encoding: "utf8" },
  );
  assert.equal(malformedManifestCheck.status, 1);
  assert.match(
    malformedManifestCheck.stderr,
    /z\.json:1:12: error: expected an object for target/,
  );

  const releaseApplication = resolve(directory, "release-application");
  const releaseCompilation = spawnSync(
    driver,
    ["build", applicationSource, releaseApplication, "--release"],
    { encoding: "utf8" },
  );
  assert.equal(releaseCompilation.status, 0, releaseCompilation.stderr);
  const releaseExecution = spawnSync(releaseApplication, [], { encoding: "utf8" });
  assert.equal(releaseExecution.status, 42, releaseExecution.stderr);
}, 300_000);

test("passes arguments and reuses the run cache through the standalone native driver", () => {
  const { directory, driver } = standaloneDriver();
  const argumentApplicationSource = resolve(
    projectRoot,
    "tests/fixtures/self-host-native-driver.zs",
  );
  const argumentProject = resolve(directory, "argument-project");
  mkdirSync(argumentProject);
  const argumentApplicationSourceCopy = resolve(argumentProject, "main.zs");
  writeFileSync(
    argumentApplicationSourceCopy,
    readFileSync(argumentApplicationSource, "utf8"),
  );
  const running = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--release",
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.equal(running.status, 0, running.stderr);
  assert.match(running.stdout, /compiled 1 Z modules/);
  assert.equal(
    existsSync(resolve(argumentProject, ".z-cache/run/program")),
    true,
  );
  assert.equal(
    existsSync(resolve(argumentProject, ".z-cache/run/program.c")),
    true,
  );
  assert.equal(
    existsSync(resolve(argumentProject, ".z-cache/run/program.meta")),
    true,
  );
  const cachedArgumentApplication = resolve(
    argumentProject,
    ".z-cache/run/program",
  );
  utimesSync(cachedArgumentApplication, 0, 0);
  const cachedRunning = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--release",
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.equal(cachedRunning.status, 0, cachedRunning.stderr);
  assert.match(cachedRunning.stdout, /cache hit: reused .*\.z-cache\/run\/program/);
  assert.equal(statSync(cachedArgumentApplication).mtimeMs, 0);

  const stableApplication = readFileSync(cachedArgumentApplication);
  const argumentMetadata = resolve(
    argumentProject,
    ".z-cache/run/program.meta",
  );
  const failingManifest = resolve(argumentProject, "z.json");
  writeFileSync(
    failingManifest,
    JSON.stringify({
      target: {
        name: "argument-application",
        entry: "main.zs",
        link: {
          libraries: ["z_intentionally_missing_cache_publication"],
        },
      },
    }),
  );
  const failedPublication = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--release",
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(failedPublication.status, 0);
  assert.deepEqual(
    readFileSync(cachedArgumentApplication),
    stableApplication,
    "a failed cache rebuild must not replace the stable executable",
  );
  assert.equal(
    readFileSync(argumentMetadata, "utf8"),
    "incomplete\n",
    "metadata must stay invalid until every cache artifact is published",
  );
  rmSync(failingManifest);

  const recoveredPublication = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--release",
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    recoveredPublication.status,
    0,
    recoveredPublication.stderr,
  );
  assert.match(recoveredPublication.stdout, /compiled 1 Z modules/);
  assert.notEqual(readFileSync(argumentMetadata, "utf8"), "incomplete\n");

  const debugRunning = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.equal(debugRunning.status, 0, debugRunning.stderr);
  assert.match(debugRunning.stdout, /compiled 1 Z modules/);
  assert.ok(statSync(cachedArgumentApplication).mtimeMs > 0);

  utimesSync(cachedArgumentApplication, 0, 0);
  writeFileSync(
    argumentApplicationSourceCopy,
    readFileSync(argumentApplicationSourceCopy, "utf8").replace(
      "if (!fs.exists(arguments[0])) return 1;",
      "if (!fs.exists(arguments[0])) return 4;",
    ),
  );
  const changedSourceRunning = spawnSync(
    driver,
    [
      "run",
      argumentApplicationSourceCopy,
      "--",
      argumentApplicationSourceCopy,
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    changedSourceRunning.status,
    0,
    changedSourceRunning.stderr,
  );
  assert.match(changedSourceRunning.stdout, /compiled 1 Z modules/);
  assert.ok(statSync(cachedArgumentApplication).mtimeMs > 0);
}, 300_000);

test("lowers the complete native frontend graph to C", () => {
  const frontend = resolve(projectRoot, "compiler/frontend/parser-library.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", frontend],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /void _z_function_\d+_appendCStringLiteral\(Z_String \*output, Z_String const \*value\);/);
  assert.match(
    emission.stdout,
    /Z___z_Result_String_String _z_function_\d+_emitLoweredC\(Z_LoweredProgram const \*program, Z_String const \*embeddedRuntimeName, Z_String const \*runtimeInitializerName, bool runtimeInitializerRequiresMain\);/,
  );
  assert.match(
    emission.stdout,
    /Z___z_Result_Stage1ModuleGraphResult_String _z_function_\d+_resolveModuleGraphPhase\(Z_String const \*entryPath, Z_String const \*batch\);/,
  );
  assert.match(
    emission.stdout,
    /typedef struct Z_ParsedModuleBatch \{\n  Z_Arena arena;\n  Z___z_Array_ParsedModule const \* modules;\n\} Z_ParsedModuleBatch;/,
  );
  assert.match(
    emission.stdout,
    /z_stage1_arena_create_\d+___z_Array_ParsedModule\(&\(arena\), parsed\)/,
  );
  assert.match(
    emission.stdout,
    /\.payload = \{ \.success = \(Z_ParsedModuleBatch\)\{\.arena = arena, \.modules = storedModules\}/,
  );
  const parsedBatchDestructor = emission.stdout.match(
    /static __attribute__\(\(unused\)\) void Z_ParsedModuleBatch_deinit\(Z_ParsedModuleBatch \*self\) \{[^]*?\n\}/,
  )?.[0] ?? "";
  assert.notEqual(parsedBatchDestructor, "");
  assert.match(parsedBatchDestructor, /Z_Arena_deinit\(&self->arena\)/);
  assert.doesNotMatch(parsedBatchDestructor, /modules/);
  const directory = mkdtempSync("/tmp/z-self-host-frontend-");
  const executable = resolve(directory, "frontend");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-O0",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
}, 240_000);

hostToolchainTest("resolves a canonical module graph directly from native Z ASTs", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-module-resolver.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  const main = resolve(projectRoot, "examples/language/modules/main.zs");
  const integrated = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", main, "--timings"],
    { encoding: "utf8" },
  );
  assert.equal(integrated.status, 0, integrated.stderr);
  assert.match(integrated.stdout, /stage-1 resolver matches 4 modules, 5 local edges, and 19 symbols \(app-config\.zs -> math\.zs -> geometry\.zs -> main\.zs\)/);
  assert.match(integrated.stdout, /stage-1 resolver compiler index matches \d+ binding\/signature queries/);
  assert.match(integrated.stdout, /host discovery \(file I\/O \+ stage-0 import parse\): \d+\.\d{2} ms/);
  assert.match(integrated.stdout, /native phase \(FFI \+ lex \+ parse \+ resolve \+ graph stream decode\): \d+\.\d{2} ms/);
  assert.doesNotMatch(integrated.stdout, /compatibility stream decode/);
  assert.match(integrated.stdout, /compiler parity \+ semantic queries \(reused AST\): \d+\.\d{2} ms/);

  const ordinaryCheck = spawnSync(
    process.execPath,
    [cli, "check", main, "--native-frontend", "--timings"],
    { encoding: "utf8" },
  );
  assert.equal(ordinaryCheck.status, 0, ordinaryCheck.stderr);
  assert.match(
    ordinaryCheck.stdout,
    /main\.zs: native frontend hybrid matches 4 modules, 5 local edges, and 19 symbols/,
  );
  assert.match(ordinaryCheck.stdout, /native frontend hybrid compiler index matches \d+ binding\/signature queries/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid exports 3 inferred local binding contracts/);
  // Includes the two String-valued arms of the audit conditional, separately
  // from its boolean condition at the same starting source position.
  assert.match(ordinaryCheck.stdout, /native frontend hybrid exports 33 expression type contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ function, \d+ method, and \d+ constructor stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ aggregate, \d+ field, and \d+ enum-variant stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ explicit type-use stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ inferred local binding stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes 33 expression stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ function, \d+ method, and \d+ constructor native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ aggregate, \d+ field, and \d+ enum-variant native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ explicit type-use native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 3 inferred local binding native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 33 expression native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid timing \(4 modules, cache hit\)/);
  assert.match(ordinaryCheck.stdout, /main\.zs: ok/);

  const timingsWithoutShadow = spawnSync(
    process.execPath,
    [cli, "check", main, "--timings"],
    { encoding: "utf8" },
  );
  assert.equal(timingsWithoutShadow.status, 1);
  assert.match(timingsWithoutShadow.stderr, /check --timings requires --native-frontend/);

  const invalidDirectory = mkdtempSync("/tmp/z-self-host-resolver-");
  const inferredBindings = resolve(invalidDirectory, "inferred-bindings.zs");
  writeFileSync(
    inferredBindings,
    "function identity<T>(value: T): T { return value; }\n"
      + "function main(): i32 {\n"
      + "  const value = identity(42);\n"
      + "  let answer = value;\n"
      + "  answer = answer + 1;\n"
      + "  const optional = Option<i32>.some(answer);\n"
      + "  return match (in optional) { some(value) => value; none => 0; };\n"
      + "}\n",
  );
  const inferredBindingEvidence = spawnSync(
    process.execPath,
    [cli, "check", inferredBindings, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(inferredBindingEvidence.status, 0, inferredBindingEvidence.stderr);
  assert.match(inferredBindingEvidence.stdout, /exports 4 inferred local binding contracts/);
  assert.match(inferredBindingEvidence.stdout, /observes 3 inferred local binding stage-0 Z resolutions/);
  assert.match(inferredBindingEvidence.stdout, /uses 3 inferred local binding native-authoritative contracts/);
  const inferredObservedExpressions = inferredBindingEvidence.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const inferredAuthoritativeExpressions = inferredBindingEvidence.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.match(inferredBindingEvidence.stdout, /exports [1-9]\d* expression type contracts/);
  assert.ok(inferredObservedExpressions);
  assert.equal(inferredAuthoritativeExpressions, inferredObservedExpressions);

  const wrappedBindingMain = resolve(invalidDirectory, "wrapped-binding-main.zs");
  const wrappedBindingModel = resolve(invalidDirectory, "wrapped-binding-model.zs");
  writeFileSync(
    wrappedBindingModel,
    "export struct Item { value: i32; }\n"
      + "export function optional(value: i32): Option<Item> {\n"
      + "  return Option.some(Item({ value }));\n"
      + "}\n",
  );
  writeFileSync(
    wrappedBindingMain,
    "import model from \"./wrapped-binding-model.zs\";\n"
      + "function main(): i32 {\n"
      + "  const wrapped = model.optional(42);\n"
      + "  return match (in wrapped) { some(item) => item.value; none => 0; };\n"
      + "}\n",
  );
  const wrappedBindingEvidence = spawnSync(
    process.execPath,
    [cli, "check", wrappedBindingMain, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(wrappedBindingEvidence.status, 0, wrappedBindingEvidence.stderr);
  assert.match(wrappedBindingEvidence.stdout, /exports 2 inferred local binding contracts/);
  assert.match(wrappedBindingEvidence.stdout, /observes 1 inferred local binding stage-0 Z resolutions/);
  assert.match(wrappedBindingEvidence.stdout, /uses 1 inferred local binding native-authoritative contracts/);
  const wrappedObservedExpressions = wrappedBindingEvidence.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const wrappedAuthoritativeExpressions = wrappedBindingEvidence.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.match(wrappedBindingEvidence.stdout, /exports [1-9]\d* expression type contracts/);
  assert.ok(wrappedObservedExpressions);
  assert.equal(wrappedAuthoritativeExpressions, wrappedObservedExpressions);

  const genericEvidenceMain = resolve(invalidDirectory, "generic-evidence-main.zs");
  const genericEvidenceModel = resolve(invalidDirectory, "generic-evidence-model.zs");
  writeFileSync(
    genericEvidenceModel,
    "export function identity<T>(value: T): T { return value; }\n"
      + "export struct Record<T> {\n"
      + "  value: T;\n"
      + "  function get(): T { return this.value; }\n"
      + "  function preserve<U>(candidate: U): U { return candidate; }\n"
      + "  static function echo(value: T): T { return value; }\n"
      + "}\n"
      + "export struct Utility {\n"
      + "  static function preserve<U>(candidate: U): U { return candidate; }\n"
      + "}\n"
      + "export class Holder<T> {\n"
      + "  value: T;\n"
      + "  constructor(value: T) { this.value = value; }\n"
      + "  function get(): T { return this.value; }\n"
      + "}\n"
      + "export class Slot<T> {\n"
      + "  value: T;\n"
      + "}\n"
      + "export class Choice<T> {\n"
      + "  constructor(left: T, right: T) {}\n"
      + "}\n",
  );
  writeFileSync(
    genericEvidenceMain,
    "import { identity as keep, Record as Entry, Holder as Stored, Slot as Cell, Utility } from \"./generic-evidence-model.zs\";\n"
      + "import model from \"./generic-evidence-model.zs\";\n"
      + "function main(): i32 {\n"
      + "  const label = \"é\";\n"
      + "  const record: Entry<i32> = Entry({ value: keep(20) });\n"
      + "  const echoed = Entry.echo(record.get());\n"
      + "  const preserved = record.preserve(1);\n"
      + "  const staticPreserved = Utility.preserve<i32>(1);\n"
      + "  const holder = new Stored(keep<i32>(22));\n"
      + "  const explicitHolder = new Stored<i32>(0);\n"
      + "  const namespacedHolder = new model.Holder(0);\n"
      + "  const cell = new Cell({ value: 0 });\n"
      + "  return echoed + preserved + staticPreserved + holder.get() + explicitHolder.get() + namespacedHolder.get() + cell.value;\n"
      + "}\n",
  );
  const genericEvidence = spawnSync(
    process.execPath,
    [cli, "check", genericEvidenceMain, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(genericEvidence.status, 0, genericEvidence.stderr);
  assert.match(genericEvidence.stdout, /native frontend hybrid exports 12 resolved call contracts/);
  assert.match(genericEvidence.stdout, /native frontend hybrid uses 2 function, 7 method, and 3 constructor native-authoritative contracts/);
  assert.match(genericEvidence.stdout, /native frontend hybrid uses 2 aggregate, 7 field, and 0 enum-variant native-authoritative contracts/);
  assert.match(genericEvidence.stdout, /native frontend hybrid uses 1 explicit type-use native-authoritative contract/);

  writeFileSync(
    genericEvidenceMain,
    "import { Choice } from \"./generic-evidence-model.zs\";\n"
      + "function main(): i32 { const choice = new Choice(1, true); return 0; }\n",
  );
  const conflictingConstructorInference = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", genericEvidenceMain],
    { encoding: "utf8" },
  );
  assert.equal(conflictingConstructorInference.status, 1);
  assert.match(conflictingConstructorInference.stderr, /conflicting inferred types for T in Choice\.constructor: i32 and boolean/);

  const genericErrorMain = resolve(invalidDirectory, "generic-error-main.zs");
  writeFileSync(
    genericErrorMain,
    "struct Failure { code: i32; }\n"
      + "function keep<T>(value: T): T throws Failure { return value; }\n"
      + "function load(): i32 throws Failure { return try keep(42); }\n"
      + "function main(): i32 { return 0; }\n",
  );
  const genericErrorEvidence = spawnSync(
    process.execPath,
    [cli, "check", genericErrorMain, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(genericErrorEvidence.status, 0, genericErrorEvidence.stderr);
  assert.match(genericErrorEvidence.stdout, /native frontend hybrid exports 1 resolved call contract/);
  assert.match(genericErrorEvidence.stdout, /native frontend hybrid uses 1 function, 0 method, and 0 constructor native-authoritative contracts/);

  const contextualClosureMain = resolve(invalidDirectory, "contextual-closure-main.zs");
  const contextualClosureModel = resolve(invalidDirectory, "contextual-closure-model.zs");
  writeFileSync(
    contextualClosureModel,
    "export struct Note { id: i32; }\n"
      + "export function apply<T>(in operation: (value: T) => T, value: T): T { return operation(value); }\n"
      + "export struct Store {\n"
      + "  function visit(in operation: (in note: Note) => i32): i32 {\n"
      + "    const note = Note({ id: 42 });\n"
      + "    return operation(note);\n"
      + "  }\n"
      + "}\n",
  );
  writeFileSync(
    contextualClosureMain,
    "import { apply, Store } from \"./contextual-closure-model.zs\";\n"
      + "function main(): i32 {\n"
      + "  const store = Store({});\n"
      + "  const applied = apply<i32>((value) => value + 1, 41);\n"
      + "  return store.visit((in note) => { return note.id; }) + applied - 42;\n"
      + "}\n",
  );
  const contextualClosure = spawnSync(
    process.execPath,
    [cli, "check", contextualClosureMain, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(contextualClosure.status, 0, contextualClosure.stderr);
  assert.match(contextualClosure.stdout, /native frontend hybrid uses 1 function, 1 method, and 0 constructor native-authoritative contracts/);

  const invalidMain = resolve(invalidDirectory, "main.zs");
  writeFileSync(invalidMain, `import { hidden } from "./values.zs"; function main(): i32 { return hidden(); }`);
  writeFileSync(resolve(invalidDirectory, "values.zs"), `function hidden(): i32 { return 42; }`);
  const invalid = spawnSync(process.execPath, [cli, "self-host-resolve", invalidMain], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /module \.\/values\.zs has no export hidden/);

  const unknownMain = resolve(invalidDirectory, "unknown.zs");
  writeFileSync(unknownMain, "function main(): i32 {\n  const known = 40;\n  return known + missing;\n}\n");
  const unknown = spawnSync(process.execPath, [cli, "self-host-resolve", unknownMain], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown\.zs:3:18: unknown name missing/);
  const authoritativeUnknown = spawnSync(
    process.execPath,
    [cli, "check", unknownMain, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(authoritativeUnknown.status, 1);
  assert.match(authoritativeUnknown.stderr, /unknown\.zs:3:18: error: unknown name missing/);
  assert.match(authoritativeUnknown.stderr, /return known \+ missing;/);

  const unknownTypeMain = resolve(invalidDirectory, "unknown-type.zs");
  writeFileSync(unknownTypeMain, "function load(value: Option<Missing>): void {\n  return;\n}\n");
  const unknownType = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", unknownTypeMain],
    { encoding: "utf8" },
  );
  assert.equal(unknownType.status, 1);
  assert.match(unknownType.stderr, /unknown-type\.zs:1:29: unknown type Missing/);

  const mismatchMain = resolve(invalidDirectory, "type-mismatch.zs");
  writeFileSync(
    mismatchMain,
    "function main(): boolean {\n  const answer = 42;\n  return answer;\n}\n",
  );
  const mismatch = spawnSync(process.execPath, [cli, "self-host-resolve", mismatchMain], { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /type-mismatch\.zs:3:10: expected boolean, found i32/);

  const operatorMain = resolve(invalidDirectory, "invalid-operator.zs");
  writeFileSync(operatorMain, "function main(): boolean {\n  return true + false;\n}\n");
  const operator = spawnSync(process.execPath, [cli, "self-host-resolve", operatorMain], { encoding: "utf8" });
  assert.equal(operator.status, 1);
  assert.match(operator.stderr, /invalid-operator\.zs:2:15: operator \+ requires matching numeric operands/);

  const callMain = resolve(invalidDirectory, "call-main.zs");
  writeFileSync(
    callMain,
    "import { add } from \"./math.zs\";\nfunction main(): i32 {\n  return add(true, 2);\n}\n",
  );
  writeFileSync(
    resolve(invalidDirectory, "math.zs"),
    "export function add(left: i32, right: i32): i32 { return left + right; }\n",
  );
  const invalidCall = spawnSync(process.execPath, [cli, "self-host-resolve", callMain], { encoding: "utf8" });
  assert.equal(invalidCall.status, 1);
  assert.match(invalidCall.stderr, /call-main\.zs:3:14: expected i32, found boolean/);

  const genericMain = resolve(invalidDirectory, "generic-main.zs");
  writeFileSync(
    genericMain,
    "import generic from \"./generic.zs\";\nfunction main(): i32 {\n  return generic.choose(42, true);\n}\n",
  );
  writeFileSync(
    resolve(invalidDirectory, "generic.zs"),
    "export function choose<T>(left: T, right: T): T { return left; }\n",
  );
  const invalidGeneric = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", genericMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidGeneric.status, 1);
  assert.match(
    invalidGeneric.stderr,
    /generic-main\.zs:3:29: expected i32, found boolean/,
  );

  const matchMain = resolve(invalidDirectory, "match-main.zs");
  writeFileSync(
    matchMain,
    "enum State { ready, stopped, }\nfunction inspect(value: State): i32 {\n  return match (value) { ready => 1; };\n}\n",
  );
  const invalidMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", matchMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidMatch.status, 1);
  assert.match(
    invalidMatch.stderr,
    /match-main\.zs:3:10: non-exhaustive match; missing State\.stopped/,
  );

  writeFileSync(
    matchMain,
    "enum State { ready, stopped, }\nfunction inspect(value: State): i32 {\n"
      + "  return match (value) { ready => 1; _ => 0; };\n}\n",
  );
  const wildcardMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", matchMain],
    { encoding: "utf8" },
  );
  assert.equal(wildcardMatch.status, 0, wildcardMatch.stderr);

  writeFileSync(
    matchMain,
    "enum State { ready, stopped, }\nfunction inspect(value: State): i32 {\n"
      + "  return match (value) { _ => 0; ready => 1; };\n}\n",
  );
  const unreachableWildcard = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", matchMain],
    { encoding: "utf8" },
  );
  assert.equal(unreachableWildcard.status, 1);
  assert.match(unreachableWildcard.stderr, /unreachable match arm after wildcard/);

  const importedMatchMain = resolve(invalidDirectory, "imported-match.zs");
  const importedMatchModel = resolve(invalidDirectory, "match-model.zs");
  writeFileSync(
    importedMatchModel,
    "export struct Envelope<T> {\n  value: T;\n}\n"
      + "export enum Lookup {\n  found Envelope<i32>,\n  missing,\n}\n",
  );
  writeFileSync(
    importedMatchMain,
    "import model from \"./match-model.zs\";\n"
      + "function inspect(value: model.Lookup): i32 {\n"
      + "  return match (value) {\n"
      + "    found({ value }) => value;\n"
      + "    missing => 0;\n"
      + "  };\n"
      + "}\n",
  );
  const importedMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", importedMatchMain],
    { encoding: "utf8" },
  );
  assert.equal(importedMatch.status, 0, importedMatch.stderr);
  assert.match(importedMatch.stdout, /stage-1 resolver matches 2 modules, 1 local edge, and 4 symbols/);

  writeFileSync(
    importedMatchMain,
    "import { Lookup as State } from \"./match-model.zs\";\n"
      + "function inspect(value: State): i32 {\n"
      + "  return match (value) { found({ value }) => value; };\n"
      + "}\n",
  );
  const incompleteImportedMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", importedMatchMain],
    { encoding: "utf8" },
  );
  assert.equal(incompleteImportedMatch.status, 1);
  assert.match(
    incompleteImportedMatch.stderr,
    /imported-match\.zs:3:10: non-exhaustive match; missing State\.missing/,
  );

  writeFileSync(
    importedMatchMain,
    "import model from \"./match-model.zs\";\n"
      + "function inspect(value: model.Lookup): i32 {\n"
      + "  return match (value) {\n"
      + "    found({ id }) => id;\n"
      + "    missing => 0;\n"
      + "  };\n"
      + "}\n",
  );
  const invalidImportedField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", importedMatchMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidImportedField.status, 1);
  assert.match(
    invalidImportedField.stderr,
    /payload model\.Envelope<i32> has no field id/,
  );

  const fieldMain = resolve(invalidDirectory, "field-main.zs");
  const fieldModel = resolve(invalidDirectory, "field-model.zs");
  writeFileSync(
    fieldModel,
    "export struct Record<T> {\n"
      + "  value: T;\n"
      + "  function get(): T { return this.value; }\n"
      + "  function preserve<U>(candidate: U): U { return candidate; }\n"
      + "  static function echo(candidate: T): T { return candidate; }\n"
      + "  private function hidden(): T { return this.value; }\n"
      + "}\n"
      + "export struct Frozen {\n  readonly value: i32;\n}\n"
      + "export class Secret {\n"
      + "  private value: i32;\n"
      + "  function same(other: Secret): boolean { return other.value == this.value; }\n"
      + "}\n"
      + "export class Constructed {\n"
      + "  value: i32;\n"
      + "  constructor(value: i32) { this.value = value; }\n"
      + "}\n"
      + "export class Holder<T> {\n"
      + "  value: T;\n"
      + "  constructor(value: T) { this.value = value; }\n"
      + "}\n",
  );
  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function read(record: model.Record<i32>): i32 { return record.value; }\n",
  );
  const importedField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(importedField.status, 0, importedField.stderr);

  writeFileSync(
    fieldMain,
    "import { Record as Entry } from \"./field-model.zs\";\n"
      + "function read(record: Entry<i32>): i32 { return record.missing; }\n",
  );
  const unknownImportedField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(unknownImportedField.status, 1);
  assert.match(unknownImportedField.stderr, /type Entry<i32> has no field missing/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function reveal(secret: model.Secret): i32 { return secret.value; }\n",
  );
  const privateImportedField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(privateImportedField.status, 1);
  assert.match(privateImportedField.stderr, /field "value" is private to class "Secret"/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function update(inout record: model.Record<i32>): void { record.value = true; }\n",
  );
  const invalidImportedFieldAssignment = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidImportedFieldAssignment.status, 1);
  assert.match(invalidImportedFieldAssignment.stderr, /expected i32, found boolean/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function update(inout frozen: model.Frozen): void { frozen.value = 42; }\n",
  );
  const readonlyImportedField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(readonlyImportedField.status, 1);
  assert.match(readonlyImportedField.stderr, /cannot assign to readonly field "value"/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function invalid(): model.Holder<i32> { return new model.Holder<i32>(true); }\n",
  );
  const invalidImportedConstructorArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(invalidImportedConstructorArgument.status, 1);
  assert.match(invalidImportedConstructorArgument.stderr, /expected i32, found boolean/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function read(record: model.Record<i32>): i32 {\n"
      + "  return record.get() + record.preserve(2) + model.Record.echo(3) - 5;\n"
      + "}\n",
  );
  const importedMethods = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(importedMethods.status, 0, importedMethods.stderr);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function read(record: model.Record<i32>): i32 { return record.preserve(true); }\n",
  );
  const mismatchedMethodResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(mismatchedMethodResult.status, 1);
  assert.match(mismatchedMethodResult.stderr, /expected i32, found boolean/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function read(record: model.Record<i32>): i32 { return record.hidden(); }\n",
  );
  const privateImportedMethod = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(privateImportedMethod.status, 1);
  assert.match(privateImportedMethod.stderr, /method "hidden" is private to type "Record"/);

  writeFileSync(
    fieldMain,
    "import model from \"./field-model.zs\";\n"
      + "function read(record: model.Record<i32>): i32 { return record.missing(); }\n",
  );
  const unknownImportedMethod = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", fieldMain],
    { encoding: "utf8" },
  );
  assert.equal(unknownImportedMethod.status, 1);
  assert.match(unknownImportedMethod.stderr, /type model.Record<i32> has no method missing/);

  const identityModel = resolve(invalidDirectory, "identity-model.zs");
  const identityBridge = resolve(invalidDirectory, "identity-bridge.zs");
  const identityMain = resolve(invalidDirectory, "identity-main.zs");
  writeFileSync(
    identityModel,
    "export struct Record {\n"
      + "  id: i32;\n"
      + "  function choose<U>(left: U, right: U): U { return left; }\n"
      + "}\n"
      + "export struct Holder {\n"
      + "  record: Record;\n"
      + "  function get(): Record { return this.record; }\n"
      + "  static function keep(value: Record): Record { return value; }\n"
      + "}\n"
      + "export enum Lookup { found Record, missing, }\n",
  );
  writeFileSync(
    identityBridge,
    "import { Record } from \"./identity-model.zs\";\n"
      + "export function forward(value: Record): Record { return value; }\n"
      + "export function choose<T>(left: T, right: T): T { return left; }\n"
      + "export function initialize(out value: i32): void { value = 42; }\n",
  );
  writeFileSync(
    identityMain,
    "import model from \"./identity-model.zs\";\n"
      + "import { Record as Entry, Holder, Lookup } from \"./identity-model.zs\";\n"
      + "import bridge from \"./identity-bridge.zs\";\n"
      + "function through(value: Entry): model.Record { return bridge.forward(value); }\n"
      + "function field(holder: Holder): model.Record { return holder.record; }\n"
      + "function method(holder: model.Holder): Entry { return holder.get(); }\n"
      + "function staticMethod(value: model.Record): Entry { return Holder.keep(value); }\n"
      + "function genericDirect(left: Entry, right: model.Record): model.Record {\n"
      + "  return bridge.choose(left, right);\n"
      + "}\n"
      + "function genericNested(left: Option<Entry>, right: Option<model.Record>): Option<Entry> {\n"
      + "  return bridge.choose(left, right);\n"
      + "}\n"
      + "function genericFixed(left: Entry[2], right: model.Record[2]): Entry[2] {\n"
      + "  return bridge.choose(left, right);\n"
      + "}\n"
      + "function genericMethod(owner: Entry, left: Entry, right: model.Record): model.Record {\n"
      + "  return owner.choose(left, right);\n"
      + "}\n"
      + "function importedOutput(): i32 {\n"
      + "  let value: i32;\n"
      + "  bridge.initialize(out value);\n"
      + "  return value;\n"
      + "}\n"
      + "function matched(value: Lookup, fallback: Entry): model.Record {\n"
      + "  return match (value) { found(record) => record; missing => fallback; };\n"
      + "}\n",
  );
  const canonicalIdentity = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", identityMain],
    { encoding: "utf8" },
  );
  assert.equal(canonicalIdentity.status, 0, canonicalIdentity.stderr);
  assert.match(canonicalIdentity.stdout, /stage-1 resolver matches 3 modules, 4 local edges/);

  const bindingState = resolve(invalidDirectory, "binding-state.zs");
  writeFileSync(
    bindingState,
    "function mutateLocal(): i32 {\n"
      + "  let value = 1;\n"
      + "  value = 2;\n"
      + "  return value;\n"
      + "}\n"
      + "function mutateParameter(inout value: i32): void { value = 2; }\n"
      + "function initializeParameter(out value: i32): void { value = 1; }\n"
      + "function initializeValue(out value: i32): i32 { value = 40; return 0; }\n"
      + "function increase(inout value: i32): void { value = value + 2; }\n"
      + "function useCapabilities(): i32 {\n"
      + "  let value: i32;\n"
      + "  initializeValue(out value);\n"
      + "  increase(inout value);\n"
      + "  return value;\n"
      + "}\n"
      + "struct Counter {\n"
      + "  value: i32;\n"
      + "  function add(inout this, amount: i32): void { this.value = this.value + amount; }\n"
      + "  function read(): i32 { return this.value; }\n"
      + "}\n"
      + "function useMutableReceiver(): i32 {\n"
      + "  let counter = Counter({ value: 40 });\n"
      + "  counter.add(2);\n"
      + "  return counter.read();\n"
      + "}\n"
      + "class SharedCounter {\n"
      + "  value: i32;\n"
      + "  function add(inout this, amount: i32): void { this.value = this.value + amount; }\n"
      + "  function read(): i32 { return this.value; }\n"
      + "}\n"
      + "function useClassReceiver(): i32 {\n"
      + "  const counter = new SharedCounter({ value: 40 });\n"
      + "  counter.add(2);\n"
      + "  return counter.read();\n"
      + "}\n"
      + "function observePair(in first: i32, in second: i32): i32 { return first + second; }\n"
      + "function useSharedInput(value: i32): i32 { return observePair(value, value); }\n"
      + "function initializeBranch(flag: boolean, out value: i32): void {\n"
      + "  if (flag) { value = 1; } else { value = 2; }\n"
      + "}\n"
      + "function readBranch(flag: boolean): i32 {\n"
      + "  let value: i32;\n"
      + "  if (flag) { value = 1; } else { value = 2; }\n"
      + "  return value;\n"
      + "}\n",
  );
  const mutableBindings = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(mutableBindings.status, 0, mutableBindings.stderr);

  writeFileSync(
    bindingState,
    "function invalid(): i32 {\n"
      + "  const value = 1;\n"
      + "  value = 2;\n"
      + "  return value;\n"
      + "}\n",
  );
  const immutableLocal = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableLocal.status, 1);
  assert.match(immutableLocal.stderr, /cannot assign to immutable binding "value"/);

  writeFileSync(
    bindingState,
    "function invalid(value: i32): void { value = 2; }\n",
  );
  const immutableValueParameter = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableValueParameter.status, 1);
  assert.match(immutableValueParameter.stderr, /cannot assign to immutable binding "value"/);

  writeFileSync(
    bindingState,
    "function invalid(in value: i32): void { value = 2; }\n",
  );
  const immutableInputParameter = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableInputParameter.status, 1);
  assert.match(immutableInputParameter.stderr, /cannot assign to immutable binding "value"/);

  writeFileSync(
    bindingState,
    "function invalid(): i32 {\n"
      + "  let value: i32;\n"
      + "  return value;\n"
      + "}\n",
  );
  const uninitializedRead = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(uninitializedRead.status, 1);
  assert.match(uninitializedRead.stderr, /use of uninitialized value "value"/);

  writeFileSync(
    bindingState,
    "function invalid(flag: boolean): i32 {\n"
      + "  let value: i32;\n"
      + "  if (flag) { value = 1; }\n"
      + "  return value;\n"
      + "}\n",
  );
  const maybeUninitializedRead = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(maybeUninitializedRead.status, 1);
  assert.match(
    maybeUninitializedRead.stderr,
    /value "value" may be uninitialized on another control-flow path/,
  );

  writeFileSync(
    bindingState,
    "function invalid(flag: boolean, out value: i32): void {\n"
      + "  if (flag) { value = 1; }\n"
      + "}\n",
  );
  const maybeUninitializedOutput = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(maybeUninitializedOutput.status, 1);
  assert.match(
    maybeUninitializedOutput.stderr,
    /out parameter "value" may be uninitialized on a successful return path/,
  );

  writeFileSync(
    bindingState,
    "function initialize(out value: i32): void { value = 1; }\n"
      + "function invalid(): i32 {\n"
      + "  let value: i32;\n"
      + "  initialize(value);\n"
      + "  return value;\n"
      + "}\n",
  );
  const missingOutCapability = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(missingOutCapability.status, 1);
  assert.match(
    missingOutCapability.stderr,
    /"initialize" requires out <mutable binding> for parameter 1/,
  );

  writeFileSync(
    bindingState,
    "function initialize(out value: i32): void { value = 1; }\n"
      + "function invalid(): void {\n"
      + "  const value = 0;\n"
      + "  initialize(out value);\n"
      + "}\n",
  );
  const immutableOutCapability = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableOutCapability.status, 1);
  assert.match(
    immutableOutCapability.stderr,
    /out argument "value" requires a mutable let binding/,
  );

  writeFileSync(
    bindingState,
    "function increase(inout value: i32): void { value = value + 1; }\n"
      + "function invalid(): void {\n"
      + "  let value: i32;\n"
      + "  increase(inout value);\n"
      + "}\n",
  );
  const uninitializedInoutCapability = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(uninitializedInoutCapability.status, 1);
  assert.match(
    uninitializedInoutCapability.stderr,
    /inout argument "value" must be initialized before the call/,
  );

  writeFileSync(
    bindingState,
    "function observe(in value: i32): i32 { return value; }\n"
      + "function invalid(): i32 {\n"
      + "  let value = 1;\n"
      + "  return observe(inout value);\n"
      + "}\n",
  );
  const invalidExplicitCapability = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(invalidExplicitCapability.status, 1);
  assert.match(
    invalidExplicitCapability.stderr,
    /inout is not valid for an immutable borrow/,
  );

  writeFileSync(
    bindingState,
    "struct Counter {\n"
      + "  value: i32;\n"
      + "  function add(inout this, amount: i32): void { this.value = this.value + amount; }\n"
      + "}\n"
      + "function invalid(): void {\n"
      + "  const counter = Counter({ value: 1 });\n"
      + "  counter.add(1);\n"
      + "}\n",
  );
  const immutableMethodReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableMethodReceiver.status, 1);
  assert.match(
    immutableMethodReceiver.stderr,
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  writeFileSync(
    bindingState,
    "class Counter {\n"
      + "  value: i32;\n"
      + "  function add(inout this, amount: i32): void { this.value = this.value + amount; }\n"
      + "}\n"
      + "function invalid(in counter: Counter): void { counter.add(1); }\n",
  );
  const immutableClassBorrow = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableClassBorrow.status, 1);
  assert.match(
    immutableClassBorrow.stderr,
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  writeFileSync(
    bindingState,
    "struct Counter {\n"
      + "  value: i32;\n"
      + "  function add(inout this, amount: i32): void { this.value = this.value + amount; }\n"
      + "}\n"
      + "function invalid(): void { Counter({ value: 1 }).add(1); }\n",
  );
  const temporaryMethodReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(temporaryMethodReceiver.status, 1);
  assert.match(
    temporaryMethodReceiver.stderr,
    /mutable method "add" requires addressable let storage/,
  );

  writeFileSync(
    bindingState,
    "function combine(inout first: i32, inout second: i32): void {}\n"
      + "function invalid(): i32 {\n"
      + "  let value = 1;\n"
      + "  combine(inout value, inout value);\n"
      + "  return value;\n"
      + "}\n",
  );
  const overlappingArguments = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(overlappingArguments.status, 1);
  assert.match(
    overlappingArguments.stderr,
    /overlapping inout and inout uses of "value" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "class Counter { value: i32; }\n"
      + "function combine(inout updated: Counter, in observed: Counter): i32 {\n"
      + "  updated.value = updated.value + 1;\n"
      + "  return observed.value;\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  let primary = new Counter({ value: 41 });\n"
      + "  const alias = primary;\n"
      + "  return combine(inout primary, alias);\n"
      + "}\n",
  );
  const overlappingClassAliases = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(overlappingClassAliases.status, 1);
  assert.match(
    overlappingClassAliases.stderr,
    /overlapping inout and in uses of ARC aliases "primary" and "alias" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "class Counter { value: i32; }\n"
      + "function updateAndInspect(inout updated: Counter, in inspect: () => i32): i32 {\n"
      + "  updated.value = updated.value + 1;\n"
      + "  return inspect();\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  let primary = new Counter({ value: 41 });\n"
      + "  const alias = primary;\n"
      + "  return updateAndInspect(inout primary, (): i32 => alias.value);\n"
      + "}\n",
  );
  const capturedClassAlias = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(capturedClassAlias.status, 1);
  assert.match(
    capturedClassAlias.stderr,
    /overlapping inout and in uses of ARC aliases "primary" and "alias" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "class Counter {\n"
      + "  value: i32;\n"
      + "  function increment(inout this): void { this.value = this.value + 1; }\n"
      + "}\n"
      + "function observe(in value: Counter, in update: () => void): i32 {\n"
      + "  update();\n"
      + "  return value.value;\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  const primary = new Counter({ value: 41 });\n"
      + "  let alias = primary;\n"
      + "  return observe(primary, (): void => { if (true) alias.increment(); });\n"
      + "}\n",
  );
  const capturedClassMutation = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(capturedClassMutation.status, 1);
  assert.match(
    capturedClassMutation.stderr,
    /overlapping in and inout uses of ARC aliases "primary" and "alias" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "class Counter {\n"
      + "  value: i32;\n"
      + "  function increment(inout this): void { this.value = this.value + 1; }\n"
      + "}\n"
      + "function inspect(in operation: () => i32): i32 { return operation(); }\n"
      + "function valid(): i32 {\n"
      + "  let primary = new Counter({ value: 41 });\n"
      + "  const alias = primary;\n"
      + "  return inspect((): i32 => { primary.increment(); return alias.value; });\n"
      + "}\n",
  );
  const sequentialCapturedAliases = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(
    sequentialCapturedAliases.status,
    0,
    sequentialCapturedAliases.stderr,
  );

  writeFileSync(
    bindingState,
    "class Counter {\n"
      + "  value: i32;\n"
      + "  function increment(inout this): void { this.value = this.value + 1; }\n"
      + "}\n"
      + "function inspect(in operation: () => i32): i32 { return operation(); }\n"
      + "function mutateBorrow(inout counter: Counter): i32 {\n"
      + "  return inspect((): i32 => { counter.increment(); return counter.value; });\n"
      + "}\n"
      + "function valid(): i32 {\n"
      + "  const counter = new Counter({ value: 41 });\n"
      + "  return inspect((): i32 => { counter.increment(); return counter.value; });\n"
      + "}\n"
      + "function nested(): i32 {\n"
      + "  const counter = new Counter({ value: 41 });\n"
      + "  return inspect((): i32 => inspect((): i32 => { counter.increment(); return counter.value; }));\n"
      + "}\n",
  );
  const capturedClassMutationCapabilities = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(
    capturedClassMutationCapabilities.status,
    0,
    capturedClassMutationCapabilities.stderr,
  );

  writeFileSync(
    bindingState,
    "class Counter {\n"
      + "  value: i32;\n"
      + "  function increment(inout this): void { this.value = this.value + 1; }\n"
      + "}\n"
      + "function inspect(in operation: () => void): void { operation(); }\n"
      + "function invalid(in counter: Counter): void {\n"
      + "  inspect((): void => { counter.increment(); });\n"
      + "}\n",
  );
  const capturedImmutableClassBorrow = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(capturedImmutableClassBorrow.status, 1);
  assert.match(
    capturedImmutableClassBorrow.stderr,
    /mutable method "increment" cannot be called through immutable binding "counter"/,
  );

  writeFileSync(
    bindingState,
    "class Counter { value: i32; }\n"
      + "function inspect(in operation: () => void): void { operation(); }\n"
      + "function invalid(): void {\n"
      + "  const counter = new Counter({ value: 41 });\n"
      + "  inspect((): void => { counter = new Counter({ value: 42 }); });\n"
      + "}\n",
  );
  const capturedConstReassignment = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(capturedConstReassignment.status, 1);
  assert.match(
    capturedConstReassignment.stderr,
    /cannot assign to immutable binding "counter"/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  function merge(inout this, other: Resource): void {}\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(): void {\n"
      + "  let resource = Resource({ id: 1 });\n"
      + "  resource.merge(resource);\n"
      + "}\n",
  );
  const overlappingReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(overlappingReceiver.status, 1);
  assert.match(
    overlappingReceiver.stderr,
    /overlapping inout and value uses of "resource" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  function finish(move this): void {}\n"
      + "  function invalid(): void { this.finish(); }\n"
      + "}\n",
  );
  const borrowedConsumingReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedConsumingReceiver.status, 1);
  assert.match(
    borrowedConsumingReceiver.stderr,
    /cannot move the borrowed method receiver `this`; declare `move this`/,
  );

  writeFileSync(
    bindingState,
    "struct Payload {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "struct Registry {\n"
      + "  payload: Payload;\n"
      + "  function finish(move this): Payload { return this.payload; }\n"
      + "}\n"
      + "function valid(): i32 {\n"
      + "  const registry = Registry({ payload: Payload({ id: 42 }) });\n"
      + "  const payload = registry.finish();\n"
      + "  return payload.id;\n"
      + "}\n",
  );
  const consumedReceiverField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(consumedReceiverField.status, 0, consumedReceiverField.stderr);

  writeFileSync(
    bindingState,
    "struct Payload { id: i32; deinit {} }\n"
      + "struct Registry {\n"
      + "  payload: Payload;\n"
      + "  remaining: Payload;\n"
      + "  function finish(move this): Payload { return this.payload; }\n"
      + "}\n",
  );
  const partialReceiverMove = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(partialReceiverMove.status, 1);
  assert.match(
    partialReceiverMove.stderr,
    /cannot move an ownership-bearing field or element out of its owner/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  function merge(move this, in other: Resource): void {}\n"
      + "}\n"
      + "function invalid(): void {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  resource.merge(resource);\n"
      + "}\n",
  );
  const overlappingConsumingReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(overlappingConsumingReceiver.status, 1);
  assert.match(
    overlappingConsumingReceiver.stderr,
    /overlapping move and in uses of "resource" in one call are not allowed/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  consume(resource);\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedOwnedArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedOwnedArgument.status, 1);
  assert.match(movedOwnedArgument.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(flag: boolean): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  if (flag) { consume(resource); }\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const maybeMovedOwnedArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(maybeMovedOwnedArgument.status, 1);
  assert.match(
    maybeMovedOwnedArgument.stderr,
    /value "resource" may have moved on another control-flow path/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(in resource: Resource): void { consume(resource); }\n",
  );
  const borrowedOwnedArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedOwnedArgument.status, 1);
  assert.match(borrowedOwnedArgument.stderr, /cannot move borrowed parameter "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  function finish(move this): void {}\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  resource.finish();\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedReceiver = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedReceiver.status, 1);
  assert.match(movedReceiver.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "class Session {\n"
      + "  id: i32;\n"
      + "}\n"
      + "function retain(session: Session): void {}\n"
      + "function valid(session: Session): i32 {\n"
      + "  retain(session);\n"
      + "  return session.id;\n"
      + "}\n",
  );
  const copiedClassArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(copiedClassArgument.status, 0, copiedClassArgument.stderr);

  const ownershipModel = resolve(invalidDirectory, "ownership-model.zs");
  const ownershipMain = resolve(invalidDirectory, "ownership-main.zs");
  writeFileSync(
    ownershipModel,
    "export struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "export struct Envelope { resource: Resource; }\n"
      + "export class Owner {\n"
      + "  resource: Resource;\n"
      + "  constructor(resource: Resource) { this.resource = resource; }\n"
      + "}\n"
      + "export function consume(resource: Resource): void {}\n",
  );
  writeFileSync(
    ownershipMain,
    "import native from \"./ownership-model.zs\";\n"
      + "function invalid(resource: native.Resource): i32 {\n"
      + "  native.consume(resource);\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const importedOwnedArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", ownershipMain],
    { encoding: "utf8" },
  );
  assert.equal(importedOwnedArgument.status, 1);
  assert.match(importedOwnedArgument.stderr, /use of moved value "resource"/);

  writeFileSync(
    ownershipMain,
    "import native from \"./ownership-model.zs\";\n"
      + "function invalid(resource: native.Resource): i32 {\n"
      + "  const envelope = native.Envelope({ resource });\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const importedAggregateField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", ownershipMain],
    { encoding: "utf8" },
  );
  assert.equal(importedAggregateField.status, 1);
  assert.match(importedAggregateField.stderr, /use of moved value "resource"/);

  writeFileSync(
    ownershipMain,
    "import native from \"./ownership-model.zs\";\n"
      + "function invalid(resource: native.Resource): i32 {\n"
      + "  const owner = new native.Owner(resource);\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const importedOwnedConstructorArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", ownershipMain],
    { encoding: "utf8" },
  );
  assert.equal(importedOwnedConstructorArgument.status, 1);
  assert.match(importedOwnedConstructorArgument.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum ResourceState { ready Resource, empty, }\n"
      + "function invalid(state: ResourceState): i32 {\n"
      + "  const observed = match (state) {\n"
      + "    ready(resource) => resource.id;\n"
      + "    empty => 0;\n"
      + "  };\n"
      + "  const again = state;\n"
      + "  return observed;\n"
      + "}\n",
  );
  const consumingMatchSubject = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(consumingMatchSubject.status, 1);
  assert.match(consumingMatchSubject.stderr, /use of moved value "state"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum ResourceState { ready Resource, empty, }\n"
      + "function valid(in state: ResourceState): i32 {\n"
      + "  const first = match (in state) { ready(resource) => resource.id; empty => 0; };\n"
      + "  const second = match (in state) { ready(resource) => resource.id; empty => 0; };\n"
      + "  return first + second;\n"
      + "}\n",
  );
  const repeatedBorrowedMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(repeatedBorrowedMatch.status, 0, repeatedBorrowedMatch.stderr);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum ResourceState { ready Resource, empty, }\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(in state: ResourceState): i32 {\n"
      + "  return match (in state) {\n"
      + "    ready(resource) => { consume(resource); select 1; }\n"
      + "    empty => 0;\n"
      + "  };\n"
      + "}\n",
  );
  const borrowedMatchPayload = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedMatchPayload.status, 1);
  assert.match(borrowedMatchPayload.stderr, /cannot move borrowed match binding "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum ResourceState { ready Resource, empty, }\n"
      + "function consume(resource: Resource): void {}\n"
      + "function valid(state: ResourceState): i32 {\n"
      + "  return match (state) {\n"
      + "    ready(resource) => { consume(resource); select 1; }\n"
      + "    empty => 0;\n"
      + "  };\n"
      + "}\n",
  );
  const transferredMatchPayload = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(transferredMatchPayload.status, 0, transferredMatchPayload.stderr);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum Choice { yes, no, }\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(choice: Choice, resource: Resource): i32 {\n"
      + "  const observed = match (choice) {\n"
      + "    yes => { consume(resource); select 1; }\n"
      + "    no => 0;\n"
      + "  };\n"
      + "  return resource.id + observed;\n"
      + "}\n",
  );
  const conditionalArmMove = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(conditionalArmMove.status, 1);
  assert.match(
    conditionalArmMove.stderr,
    /value "resource" may have moved on another control-flow path/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "enum Choice { yes, no, }\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(choice: Choice, resource: Resource): i32 {\n"
      + "  const observed = match (choice) {\n"
      + "    yes => { consume(resource); select 1; }\n"
      + "    no => { consume(resource); select 0; }\n"
      + "  };\n"
      + "  return resource.id + observed;\n"
      + "}\n",
  );
  const definiteArmMove = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(definiteArmMove.status, 1);
  assert.match(definiteArmMove.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "struct Envelope { resource: Resource; }\n"
      + "enum ResourceState { ready Envelope, empty, }\n"
      + "function consume(resource: Resource): void {}\n"
      + "function invalid(state: ResourceState): i32 {\n"
      + "  return match (state) {\n"
      + "    ready({ resource }) => { consume(resource); select 1; }\n"
      + "    empty => 0;\n"
      + "  };\n"
      + "}\n",
  );
  const borrowedDestructuredField = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedDestructuredField.status, 1);
  assert.match(
    borrowedDestructuredField.stderr,
    /cannot move borrowed match binding "resource"/,
  );

  writeFileSync(
    bindingState,
    "enum Choice { yes, no, }\n"
      + "function invalid(): i32 {\n"
      + "  return match (in Choice.yes) { yes => 1; no => 0; };\n"
      + "}\n",
  );
  const borrowedTemporaryMatch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedTemporaryMatch.status, 1);
  assert.match(
    borrowedTemporaryMatch.stderr,
    /match \(in \.\.\.\) requires stored enum storage/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  const first = Resource({ id: 1 });\n"
      + "  const second = first;\n"
      + "  return first.id;\n"
      + "}\n",
  );
  const movedInitializer = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedInitializer.status, 1);
  assert.match(movedInitializer.stderr, /use of moved value "first"/);

  writeFileSync(
    bindingState,
    "class Session { id: i32; }\n"
      + "function valid(): i32 {\n"
      + "  const first = new Session({ id: 20 });\n"
      + "  const second = first;\n"
      + "  return first.id + second.id;\n"
      + "}\n",
  );
  const copiedClassInitializer = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(copiedClassInitializer.status, 0, copiedClassInitializer.stderr);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "class Owner {\n"
      + "  resource: Resource;\n"
      + "  constructor(resource: Resource) { this.resource = resource; }\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  const owner = new Owner(resource);\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedConstructorArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedConstructorArgument.status, 1);
  assert.match(movedConstructorArgument.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "class Inspector { constructor(in resource: Resource) {} }\n"
      + "function valid(in resource: Resource): i32 {\n"
      + "  const inspector = new Inspector(resource);\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const borrowedConstructorArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedConstructorArgument.status, 0, borrowedConstructorArgument.stderr);

  writeFileSync(
    bindingState,
    "struct Counter { value: i32; }\n"
      + "class Mutator {\n"
      + "  constructor(inout counter: Counter) { counter.value = counter.value + 1; }\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  let counter = Counter({ value: 1 });\n"
      + "  const mutator = new Mutator(counter);\n"
      + "  return counter.value;\n"
      + "}\n",
  );
  const implicitMutableConstructorArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(implicitMutableConstructorArgument.status, 1);
  assert.match(
    implicitMutableConstructorArgument.stderr,
    /requires inout <mutable binding> for parameter 1/,
  );

  writeFileSync(
    bindingState,
    "struct Counter { value: i32; }\n"
      + "class Initializer { constructor(out value: i32) { value = 42; } }\n"
      + "function valid(): i32 {\n"
      + "  let value: i32;\n"
      + "  const initializer = new Initializer(out value);\n"
      + "  return value;\n"
      + "}\n",
  );
  const initializedConstructorOutput = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(initializedConstructorOutput.status, 0, initializedConstructorOutput.stderr);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  let target = Resource({ id: 1 });\n"
      + "  const source = Resource({ id: 2 });\n"
      + "  target = source;\n"
      + "  return source.id;\n"
      + "}\n",
  );
  const movedAssignment = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedAssignment.status, 1);
  assert.match(movedAssignment.stderr, /use of moved value "source"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  const values = [resource];\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedArrayElement = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedArrayElement.status, 1);
  assert.match(movedArrayElement.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "struct Envelope { resource: Resource; }\n"
      + "enum ResourceState { ready Envelope, empty, }\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 1 });\n"
      + "  const state = ResourceState.ready(Envelope({ resource }));\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedNestedConstruction = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedNestedConstruction.status, 1);
  assert.match(movedNestedConstruction.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(flag: boolean): i32 {\n"
      + "  const first = Resource({ id: 1 });\n"
      + "  const second = Resource({ id: 2 });\n"
      + "  const selected = flag ? first : second;\n"
      + "  return first.id;\n"
      + "}\n",
  );
  const conditionalDestinationMove = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(conditionalDestinationMove.status, 1);
  assert.match(
    conditionalDestinationMove.stderr,
    /value "first" may have moved on another control-flow path/,
  );

  writeFileSync(
    bindingState,
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  deinit {}\n"
      + "}\n"
      + "function invalid(in resource: Resource): Resource {\n"
      + "  return resource;\n"
      + "}\n",
  );
  const borrowedReturn = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedReturn.status, 1);
  assert.match(borrowedReturn.stderr, /cannot move borrowed parameter "resource"/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fallible(): i32 throws Problem { return 42; }\n"
      + "function invalid(): i32 { return fallible(); }\n",
  );
  const unhandledThrowingCall = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(unhandledThrowingCall.status, 1);
  assert.match(unhandledThrowingCall.stderr, /throwing call requires `attempt` or `try`/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fallible(): i32 throws Problem { return 42; }\n"
      + "function invalid(): String { return `value=${fallible()}`; }\n",
  );
  const interpolatedThrowingCall = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(interpolatedThrowingCall.status, 1);
  assert.match(interpolatedThrowingCall.stderr, /throwing call requires `attempt` or `try`/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fallible(): i32 throws Problem { return 42; }\n"
      + "function valid(): i32 {\n"
      + "  const result = attempt fallible();\n"
      + "  return match (result) {\n"
      + "    success(value) => value;\n"
      + "    failure(problem) => problem.code;\n"
      + "  };\n"
      + "}\n",
  );
  const materializedThrowingCall = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(materializedThrowingCall.status, 0, materializedThrowingCall.stderr);

  writeFileSync(
    bindingState,
    "function stable(): i32 { return 42; }\n"
      + "function invalid(): i32 { const result = attempt stable(); return 0; }\n",
  );
  const attemptNonThrowingCall = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(attemptNonThrowingCall.status, 1);
  assert.match(attemptNonThrowingCall.stderr, /attempt requires a throwing function call/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fallible(): i32 throws Problem { return 42; }\n"
      + "function invalid(): i32 { return try fallible(); }\n",
  );
  const propagatedWithoutErrorType = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(propagatedWithoutErrorType.status, 1);
  assert.match(propagatedWithoutErrorType.stderr, /try requires an enclosing throwing function/);

  writeFileSync(
    bindingState,
    "struct FirstError { code: i32; }\n"
      + "struct SecondError { code: i32; }\n"
      + "function first(): i32 throws FirstError { return 1; }\n"
      + "function invalid(): i32 throws SecondError { return try first(); }\n",
  );
  const incompatiblePropagatedError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(incompatiblePropagatedError.status, 1);
  assert.match(
    incompatiblePropagatedError.stderr,
    /cannot propagate FirstError from a function throwing SecondError/,
  );

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fallible(): i32 throws Problem { return 42; }\n"
      + "function valid(): i32 throws Problem { return try fallible(); }\n",
  );
  const compatiblePropagatedError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(compatiblePropagatedError.status, 0, compatiblePropagatedError.stderr);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function invalid(): i32 { throw Problem({ code: 1 }); }\n",
  );
  const throwWithoutErrorType = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(throwWithoutErrorType.status, 1);
  assert.match(throwWithoutErrorType.stderr, /function "invalid" does not declare an error type/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function invalid(): i32 throws Problem { throw 1; }\n",
  );
  const incompatibleThrownError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(incompatibleThrownError.status, 1);
  assert.match(incompatibleThrownError.stderr, /expected Problem, found i32/);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "class Session {\n"
      + "  id: i32;\n"
      + "  constructor(id: i32) throws Problem { this.id = id; }\n"
      + "}\n"
      + "function invalid(): i32 { return new Session(42).id; }\n",
  );
  const unhandledThrowingConstructor = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(unhandledThrowingConstructor.status, 1);
  assert.match(
    unhandledThrowingConstructor.stderr,
    /throwing constructor requires `attempt` or `try`/,
  );

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "class Session {\n"
      + "  id: i32;\n"
      + "  constructor(id: i32) throws Problem { this.id = id; }\n"
      + "}\n"
      + "function valid(): i32 {\n"
      + "  const result = attempt new Session(42);\n"
      + "  return match (result) {\n"
      + "    success(session) => session.id;\n"
      + "    failure(problem) => problem.code;\n"
      + "  };\n"
      + "}\n",
  );
  const materializedThrowingConstructor = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(materializedThrowingConstructor.status, 0, materializedThrowingConstructor.stderr);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "class Reader {\n"
      + "  function load(): i32 throws Problem { return 42; }\n"
      + "}\n"
      + "function valid(reader: Reader): i32 throws Problem { return try reader.load(); }\n",
  );
  const propagatedMethodError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(propagatedMethodError.status, 0, propagatedMethodError.stderr);

  writeFileSync(
    bindingState,
    "struct Problem { code: i32; }\n"
      + "function fail<T>(error: T): i32 throws T { throw error; }\n"
      + "function valid(): i32 {\n"
      + "  const result = attempt fail(Problem({ code: 7 }));\n"
      + "  return match (result) {\n"
      + "    success(value) => value;\n"
      + "    failure(problem) => problem.code;\n"
      + "  };\n"
      + "}\n",
  );
  const inferredGenericError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(inferredGenericError.status, 0, inferredGenericError.stderr);

  const errorModel = resolve(invalidDirectory, "error-model.zs");
  const errorMain = resolve(invalidDirectory, "error-main.zs");
  writeFileSync(
    errorModel,
    "export struct Problem { code: i32; }\n"
      + "export function fallible(): i32 throws Problem { return 42; }\n",
  );
  writeFileSync(
    errorMain,
    "import { Problem as Issue, fallible } from \"./error-model.zs\";\n"
      + "function valid(): i32 throws Issue { return try fallible(); }\n",
  );
  const importedPropagatedError = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", errorMain],
    { encoding: "utf8" },
  );
  assert.equal(importedPropagatedError.status, 0, importedPropagatedError.stderr);

  writeFileSync(
    bindingState,
    "function valid(): i32 {\n"
      + "  const add: (first: i32, second: i32) => i32 = (left: i32, right: i32): i32 => left + right;\n"
      + "  return add(20, 22);\n"
      + "}\n",
  );
  const localClosureCall = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(localClosureCall.status, 0, localClosureCall.stderr);

  writeFileSync(
    bindingState,
    "function invalid(): i32 {\n"
      + "  const identity = (value: i32): i32 => value;\n"
      + "  return identity(\"wrong\");\n"
      + "}\n",
  );
  const invalidClosureArgument = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(invalidClosureArgument.status, 1);
  assert.match(invalidClosureArgument.stderr, /expected i32, found String/);

  writeFileSync(
    bindingState,
    "function invalid(): i32 {\n"
      + "  const value = 41;\n"
      + "  const increment = (): i32 => { value = value + 1; return value; };\n"
      + "  return increment();\n"
      + "}\n",
  );
  const immutableClosureCapture = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(immutableClosureCapture.status, 1);
  assert.match(immutableClosureCapture.stderr, /cannot assign to immutable binding "value"/);

  writeFileSync(
    bindingState,
    "struct Resource { id: i32; deinit {} }\n"
      + "function valid(): i32 {\n"
      + "  const resource = Resource({ id: 21 });\n"
      + "  const inspect = (): i32 => resource.id;\n"
      + "  return inspect() + resource.id;\n"
      + "}\n",
  );
  const borrowedClosureCapture = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(borrowedClosureCapture.status, 0, borrowedClosureCapture.stderr);

  writeFileSync(
    bindingState,
    "struct Resource { id: i32; deinit {} }\n"
      + "function absent(): Option<Resource> { return Option<Resource>.none; }\n",
  );
  const emptyOwnedOption = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(emptyOwnedOption.status, 0, emptyOwnedOption.stderr);

  writeFileSync(
    bindingState,
    "enum Choice { yes, no }\n"
      + "function inspect(choice: Choice): i32 {\n"
      + "  match (choice) {\n"
      + "    yes => return 1;\n"
      + "    no => {}\n"
      + "  }\n"
      + "  return 0;\n"
      + "}\n",
  );
  const returnFromMatchArm = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(returnFromMatchArm.status, 0, returnFromMatchArm.stderr);

  writeFileSync(
    bindingState,
    "struct Resource { id: i32; deinit {} }\n"
      + "function choose(flag: boolean): Resource {\n"
      + "  const resource = Resource({ id: 42 });\n"
      + "  if (flag) return resource;\n"
      + "  return resource;\n"
      + "}\n",
  );
  const moveOnExitingBranch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(moveOnExitingBranch.status, 0, moveOnExitingBranch.stderr);

  writeFileSync(
    bindingState,
    "function initializedOnContinuingBranch(flag: boolean): i32 {\n"
      + "  let value: i32;\n"
      + "  if (flag) value = 42; else return 0;\n"
      + "  return value;\n"
      + "}\n",
  );
  const initializedContinuingBranch = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(initializedContinuingBranch.status, 0, initializedContinuingBranch.stderr);

  writeFileSync(
    bindingState,
    "struct Resource { id: i32; deinit {} }\n"
      + "function invalid(): i32 {\n"
      + "  const resource = Resource({ id: 42 });\n"
      + "  const inspect: () => i32 = move (): i32 => resource.id;\n"
      + "  return resource.id;\n"
      + "}\n",
  );
  const movedClosureCapture = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(movedClosureCapture.status, 1);
  assert.match(movedClosureCapture.stderr, /use of moved value "resource"/);

  writeFileSync(
    bindingState,
    "function valid(): i32 {\n"
      + "  let value = 40;\n"
      + "  const increment = (inout target: i32): void => { target = target + 2; };\n"
      + "  increment(inout value);\n"
      + "  return value;\n"
      + "}\n",
  );
  const closureCapability = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", bindingState],
    { encoding: "utf8" },
  );
  assert.equal(closureCapability.status, 0, closureCapability.stderr);

  const encoded = encodeStage1ModuleBatch([{
    path: "/a.zs",
    source: "é",
    packageSpecifiers: [],
  }]);
  assert.equal(encoded.byteLength, 64 + Buffer.byteLength("/a.zs") + Buffer.byteLength("é"));
  const callEvidenceGraph = decodeStage1ModuleGraphStream(
    "entry\t0000000000000000\n"
    + "module\t2f612e7a73\n"
    + "symbol\t0000000000000000\tfunction\t6964656e74697479\t1\t0\t-\t6964656e74697479\t0000000000000000\t0000000000000001\t0000000000000001\n"
    + "signature\t0000000000000000\t0000000000000000\t0\t54\t\t\t\t0000000000000001\t0000000000000001\t54\t76616c7565\t54\n"
    + "callResolution\t0000000000000000\t000000000000002a\t0000000000000002\t000000000000000a\t0000000000000000\t0000000000000000\t66756e6374696f6e\t6964656e74697479\t0\t\t693332\t\t0000000000000001\t0000000000000001\t0000000000000001\t54\t693332\t76616c7565\t693332\n"
    + "bindingResolution\t0000000000000000\t000000000000001e\t0000000000000002\t0000000000000007\t76616c7565\t0\t693332\t0000000000000000\n"
    + "expressionResolution\t0000000000000000\t000000000000002a\t0000000000000002\t000000000000000a\t693332\t\t0000000000000000\n"
    + "order\t0000000000000000\n",
  );
  assert.deepEqual(callEvidenceGraph.modules[0].callResolutions, [{
    offset: 42,
    line: 2,
    column: 10,
    targetModule: 0,
    targetSymbol: 0,
    kind: "function",
    targetName: "identity",
    asynchronous: false,
    receiverMode: "",
    callableTypeParameterCount: 1,
    returnType: "i32",
    errorType: null,
    typeParameters: ["T"],
    typeArguments: ["i32"],
    parameterModes: ["value"],
    parameterTypes: ["i32"],
  }]);
  assert.deepEqual(callEvidenceGraph.modules[0].bindingResolutions, [{
    offset: 30,
    line: 2,
    column: 7,
    name: "value",
    mutableBinding: false,
    typeName: "i32",
    typeIdentities: [],
  }]);
  assert.deepEqual(callEvidenceGraph.modules[0].expressionResolutions, [{
    offset: 42,
    line: 2,
    column: 10,
    typeName: "i32",
    targetName: "",
    typeIdentities: [],
  }]);
  const structuralTopology = decodeStage1ModuleGraphStream("", {
    entry: 1,
    modules: [
      {
        path: "/dependency.zs",
        dependencies: [],
        symbols: [{
          name: "value",
          kind: "function",
          exported: true,
          targetModule: null,
          importedName: "",
          functionSignature: {
            asynchronous: true,
            executorAffinity: "thread.main",
            threadContract: null,
            typeParameters: ["T"],
            typeParameterConstraints: [{ parameter: "T", traitName: "Named" }],
            parameterModes: ["in"],
            parameterTypes: ["T"],
            returnType: "T",
            errorType: "LookupError",
          },
          offset: 0,
          line: 1,
          column: 1,
        }, {
          name: "Resource",
          kind: "class",
          exported: true,
          targetModule: null,
          importedName: "",
          typeSignature: {
            typeParameters: ["T"],
            typeParameterConstraints: [{ parameter: "T", traitName: "Named" }],
            executorAffinity: "thread.main",
            implementedTraits: ["Measured"],
            fields: [{
              name: "value",
              typeName: "T",
              executorAffinity: null,
              visibility: "private",
              readonlyField: true,
              hasDefault: false,
              optionalField: false,
            }],
            methods: [{
              name: "read",
              staticMethod: false,
              visibility: "public",
              receiverMode: "in",
              signature: {
                asynchronous: false,
                executorAffinity: "thread.main",
                threadContract: null,
                typeParameters: [],
                typeParameterConstraints: [],
                parameterModes: [],
                parameterTypes: [],
                returnType: "T",
                errorType: null,
              },
            }],
            variants: [],
            customDeinit: true,
            customConstructor: true,
            constructorVisibility: "public",
            constructorSignature: {
              asynchronous: false,
              executorAffinity: "thread.main",
              threadContract: null,
              typeParameters: [],
              typeParameterConstraints: [],
              parameterModes: ["in"],
              parameterTypes: ["T"],
              returnType: "Resource<T>",
              errorType: null,
            },
          },
          offset: 20,
          line: 2,
          column: 1,
        }, {
          name: "State",
          kind: "enum",
          exported: true,
          targetModule: null,
          importedName: "",
          typeSignature: {
            typeParameters: [],
            typeParameterConstraints: [],
            executorAffinity: null,
            implementedTraits: [],
            fields: [],
            methods: [],
            variants: [
              { name: "idle", payloadType: null },
              { name: "ready", payloadType: "Resource<i32>" },
            ],
            customDeinit: false,
            customConstructor: false,
            constructorVisibility: "public",
            constructorSignature: null,
          },
          offset: 40,
          line: 3,
          column: 1,
        }],
        callResolutions: [{
          offset: 60,
          line: 4,
          column: 10,
          targetModule: 0,
          targetSymbol: 0,
          kind: "function",
          targetName: "value",
          asynchronous: true,
          receiverMode: "",
          callableTypeParameterCount: 1,
          typeParameters: ["T"],
          typeArguments: ["i32"],
          parameterModes: ["in"],
          parameterTypes: ["i32"],
          returnType: "i32",
          errorType: "LookupError",
        }],
        bindingResolutions: [{
          offset: 70,
          line: 5,
          column: 7,
          name: "resource",
          mutableBinding: false,
          typeName: "Resource<i32>",
          typeIdentities: [{
            path: "0",
            targetModule: 0,
            targetSymbol: 1,
          }],
        }],
        expressionResolutions: [{
          offset: 80,
          line: 6,
          column: 3,
          typeName: "State",
          targetName: "",
          typeIdentities: [{
            path: "",
            targetModule: 0,
            targetSymbol: 2,
          }],
        }],
      },
      {
        path: "/main.zs",
        dependencies: [0],
        symbols: [{
          name: "renamed",
          kind: "imported",
          exported: false,
          targetModule: 0,
          importedName: "value",
          offset: 7,
          line: 1,
          column: 8,
        }],
      },
    ],
    dependencyOrder: [0, 1],
  });
  assert.equal(structuralTopology.entry, 1);
  assert.deepEqual(
    structuralTopology.modules.map((module) => ({
      path: module.path,
      dependencies: module.dependencies,
    })),
    [
      { path: "/dependency.zs", dependencies: [] },
      { path: "/main.zs", dependencies: [0] },
    ],
  );
  assert.deepEqual(structuralTopology.dependencyOrder, [0, 1]);
  assert.deepEqual(structuralTopology.modules[0].symbols[0].functionSignature, {
    asynchronous: true,
    executorAffinity: "thread.main",
    threadContract: null,
    typeParameters: ["T"],
    typeParameterConstraints: [{ parameter: "T", traitName: "Named" }],
    parameterModes: ["in"],
    parameterTypes: ["T"],
    returnType: "T",
    errorType: "LookupError",
  });
  assert.deepEqual(
    structuralTopology.modules[0].symbols[1].typeSignature,
    {
      nativeCName: "",
      nativeCUnderlyingType: "",
      typeParameters: ["T"],
      typeParameterConstraints: [{ parameter: "T", traitName: "Named" }],
      executorAffinity: "thread.main",
      implementedTraits: ["Measured"],
      fields: [{
        name: "value",
        typeName: "T",
        executorAffinity: null,
        visibility: "private",
        readonlyField: true,
        hasDefault: false,
        optionalField: false,
      }],
      methods: [{
        name: "read",
        staticMethod: false,
        visibility: "public",
        receiverMode: "in",
        signature: {
          asynchronous: false,
          executorAffinity: "thread.main",
          threadContract: null,
          typeParameters: [],
          typeParameterConstraints: [],
          parameterModes: [],
          parameterTypes: [],
          returnType: "T",
          errorType: null,
        },
      }],
      variants: [],
      customDeinit: true,
      customConstructor: true,
      constructorVisibility: "public",
      constructorSignature: {
        asynchronous: false,
        executorAffinity: "thread.main",
        threadContract: null,
        typeParameters: [],
        typeParameterConstraints: [],
        parameterModes: ["in"],
        parameterTypes: ["T"],
        returnType: "Resource<T>",
        errorType: null,
      },
    },
  );
  assert.deepEqual(structuralTopology.modules[0].symbols[2].typeSignature?.variants, [
    { name: "idle", payloadType: null },
    { name: "ready", payloadType: "Resource<i32>" },
  ]);
  assert.deepEqual(structuralTopology.modules[0].callResolutions, [{
    offset: 60,
    line: 4,
    column: 10,
    targetModule: 0,
    targetSymbol: 0,
    kind: "function",
    targetName: "value",
    asynchronous: true,
    receiverMode: "",
    callableTypeParameterCount: 1,
    typeParameters: ["T"],
    typeArguments: ["i32"],
    parameterModes: ["in"],
    parameterTypes: ["i32"],
    returnType: "i32",
    errorType: "LookupError",
  }]);
  assert.deepEqual(structuralTopology.modules[0].bindingResolutions, [{
    offset: 70,
    line: 5,
    column: 7,
    name: "resource",
    mutableBinding: false,
    typeName: "Resource<i32>",
    typeIdentities: [{ path: "0", targetModule: 0, targetSymbol: 1 }],
  }]);
  assert.deepEqual(structuralTopology.modules[0].expressionResolutions, [{
    offset: 80,
    line: 6,
    column: 3,
    typeName: "State",
    targetName: "",
    typeIdentities: [{ path: "", targetModule: 0, targetSymbol: 2 }],
  }]);
  assert.deepEqual(structuralTopology.modules[1].symbols[0], {
    name: "renamed",
    kind: "imported",
    exported: false,
    nativeCExport: false,
    targetModule: 0,
    importedName: "value",
    functionSignature: null,
    typeSignature: null,
    location: { offset: 7, line: 1, column: 8 },
  });
  assert.throws(() => decodeStage1ModuleGraphStream("order\n"), /did not contain an entry/);
  assert.throws(
    () => decodeStage1ModuleGraphStream("entry\t0000000000000001\nmodule\t2f612e7a73\norder\t0000000000000000\n"),
    /entry is outside the module batch/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tunknown\t76616c7565\t1\t0\t-\t76616c7565\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 module symbol kind/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t\t\t0000000000000000\t0000000000000000\n"
      + "order\t0000000000000000\n",
    ),
    /function signature appeared before its symbol/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tfunction\t76616c7565\t1\t0\t-\t76616c7565\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 function parameter mode/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tclass\t536563726574\t1\t0\t-\t536563726574\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0\t1\t\t\t\n"
      + "constructorSignature\t0000000000000000\t0000000000000000\t7075626c6963\t0\t536563726574\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 constructor parameter mode/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tenum\t5374617465\t1\t0\t-\t5374617465\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000001\t0\t0\t\t\t\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 type signature arity/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tstruct\t506f696e74\t1\t0\t-\t506f696e74\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0\t0\t\t\t\n"
      + "methodSignature\t0000000000000000\t0000000000000000\t72656164\t0\t7075626c6963\t626164\t0\t693332\t\t\t\t0000000000000000\t0000000000000000\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 method receiver mode/,
  );
}, 60_000);

test("rejects executor-affinity violations in the native resolver", () => {
  const cases = [
    {
      fixture: "self-host-reject-thread-affinity-field.zs",
      diagnostic: 'field "Application.published" requires thread.main executor context',
    },
    {
      fixture: "self-host-reject-thread-affinity-method.zs",
      diagnostic: 'method "Application.publishedValue" requires thread.main executor context',
    },
    {
      fixture: "self-host-reject-thread-affinity-function.zs",
      diagnostic: 'function "publishedValue" requires thread.main executor context',
    },
    {
      fixture: "self-host-reject-executor-handle-member.zs",
      diagnostic: 'method "Application.windowValue" requires thread.main executor context',
    },
  ] as const;

  for (const testCase of cases) {
    const input = resolve(projectRoot, "tests/fixtures", testCase.fixture);
    const result = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, `${testCase.fixture}\n${result.stderr}`);
    assert.ok(result.stderr.includes(testCase.diagnostic), result.stderr);
  }

  const transportable = resolve(
    projectRoot,
    "tests/fixtures/self-host-executor-handle-aggregate-valid.zs",
  );
  const transportableResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", transportable],
    { encoding: "utf8" },
  );
  assert.equal(transportableResult.status, 0, transportableResult.stderr);
});

test("matches trait executor-affinity conformance in both semantic frontends", () => {
  const invalid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-trait-executor.zs",
  );
  const expected = "method MainService.invoke does not match trait requirement AsyncService.invoke";
  const stage0 = spawnSync(process.execPath, [cli, "check", invalid], {
    encoding: "utf8",
  });
  assert.equal(stage0.status, 1, stage0.stderr);
  assert.ok(stage0.stderr.includes(expected), stage0.stderr);

  const native = spawnSync(process.execPath, [cli, "self-host-resolve", invalid], {
    encoding: "utf8",
  });
  assert.equal(native.status, 1, native.stderr);
  assert.ok(native.stderr.includes(expected), native.stderr);

  const broader = resolve(
    projectRoot,
    "tests/fixtures/self-host-trait-executor-broader-valid.zs",
  );
  const broaderStage0 = spawnSync(process.execPath, [cli, "check", broader], {
    encoding: "utf8",
  });
  assert.equal(broaderStage0.status, 0, broaderStage0.stderr);
  const broaderNative = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", broader],
    { encoding: "utf8" },
  );
  assert.equal(broaderNative.status, 0, broaderNative.stderr);
});

test("rejects class-field views from identities with hidden aliases natively", () => {
  for (const fixture of [
    "self-host-reject-shared-class-field-view.zs",
    "self-host-reject-escaped-class-field-view.zs",
    "self-host-reject-stored-class-field-view.zs",
    "self-host-reject-custom-constructor-class-field-view.zs",
  ]) {
    const input = resolve(projectRoot, "tests/fixtures", fixture);
    const result = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", input],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1, `${fixture}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /class-field projection requires locally contained ARC identity "document"/,
    );
  }
});

test("keeps readonly collection storage owned in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-native-readonly-ownership-");
  const input = resolve(directory, "main.zs");
  function rejected(source: string, message: RegExp): void {
    writeFileSync(input, source);
    for (const command of ["check", "self-host-resolve"]) {
      const result = spawnSync(process.execPath, [cli, command, input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 1, `${command}\n${source}\n${result.stderr}`);
      assert.match(result.stderr, message);
    }
  }
  try {
    for (const type of [
      "readonly Array<i32>", "readonly Array<String>",
      "readonly Map<String, i32>", "readonly Set<i32>",
      "Option<readonly Array<i32>>", "Result<readonly Array<i32>, i32>",
    ]) {
      const prelude = 'import { Map, Set } from "std/collections";\n'
        + `readonly struct Context { values: ${type}; }\n`
        + 'readonly class Application { context: Context; }\n';
      rejected(prelude
        + 'function inspect(in app: Application): void { const values = app.context.values; }\n',
      /cannot move an ownership-bearing field or element out of its owner/);
      rejected(prelude
        + `function consume(value: ${type}): void {}\n`
        + 'function inspect(in app: Application): void { consume(app.context.values); }\n',
      /cannot move an ownership-bearing field or element out of its owner/);
      rejected(prelude
        + 'function consume(value: Context): void {}\n'
        + 'function inspect(value: Context): void { consume(value); consume(value); }\n',
      /use of moved value "value"/);
    }
    rejected('type Arguments = readonly Array<String>;\n'
      + 'struct Holder<T> { value: T; }\n'
      + 'function inspect(in holder: Holder<Arguments>): void { const values = holder.value; }\n',
    /cannot move an ownership-bearing field or element out of its owner/);
    for (const [type, mutations] of [
      ["readonly Array<String>", ['push("changed")', "clear()", "freeze()"]],
      ["readonly Map<String, i32>", ['set("changed", 1)', 'remove("changed")', 'delete("changed")', "clear()", "freeze()"]],
      ["readonly Set<String>", ['add("changed")', 'remove("changed")', 'delete("changed")', "clear()", "freeze()"]],
    ] as const) {
      for (const mutation of mutations) {
        for (const snapshot of type === "readonly Array<String>" ? ["values", "copy values"] : ["values"]) {
          const source = 'import { Map, Set } from "std/collections";\n'
            + `type Frozen = ${type};\n`
            + `function inspect(in values: Frozen): void {\n`
            + (snapshot === "values" ? "" : `  const snapshot = ${snapshot};\n`)
            + `  ${snapshot === "values" ? "values" : "snapshot"}.${mutation};\n}\n`;
          rejected(source, /readonly.*mutat|cannot mutate|has no.*method/);
        }
      }
    }
    rejected('struct Resource { value: i32; deinit {} }\n'
      + 'function inspect(in values: readonly Array<Resource>): void { const snapshot = copy values; }\n',
    /cannot be explicitly copied|cannot.*copy|does not support.*copy/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("borrows readonly class fields through shared ARC identity in both semantic frontends", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-readonly-class-field-borrow.zs",
  );
  const stage0 = spawnSync(process.execPath, [cli, "check", input], {
    encoding: "utf8",
  });
  assert.equal(stage0.status, 0, stage0.stderr);
  const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
    encoding: "utf8",
  });
  assert.equal(native.status, 0, native.stderr);
});

test("tracks one canonical ARC identity through a transparent Once accessor natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-once-accessor-alias/main.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /overlapping inout and in uses of ARC aliases "primary" and "alias" in one call are not allowed/,
  );

  const valid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-once-accessor-alias/valid.zs",
  );
  const validResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", valid],
    { encoding: "utf8" },
  );
  assert.equal(validResult.status, 0, validResult.stderr);
});

test("retains inferred ARC class fields without redundant imports natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-transitive-class-field/main.zs",
  );
  const stage0 = spawnSync(process.execPath, [cli, "check", input], {
    encoding: "utf8",
  });
  assert.equal(stage0.status, 0, stage0.stderr);

  const native = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(native.status, 0, native.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z_Counter_retain\(config->counter\)/);

  const directory = mkdtempSync("/tmp/z-transitive-class-field-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracks ARC identities through direct fields and audited struct returns natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-aggregate-class-alias/main.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /overlapping inout and in uses of ARC aliases "application" and "context\.application" in one call are not allowed/,
  );

  for (const [fixture, pattern] of [
    ["projected.zs", /ARC aliases "application" and "observed"/],
    ["assigned.zs", /ARC aliases "application" and "context\.application"/],
    ["opaque.zs", /ARC aliases "application" and "context\.application"/],
    ["branch-disagreement.zs", /ARC aliases "application" and "context\.application"/],
    ["match-disagreement.zs", /ARC aliases "application" and "context\.application"/],
    ["match-shadowing.zs", /ARC aliases "application" and "context\.application"/],
    ["match-expression-opaque.zs", /ARC aliases "application" and "context\.application"/],
  ] as const) {
    const rejected = spawnSync(
      process.execPath,
      [
        cli,
        "self-host-resolve",
        resolve(
          projectRoot,
          "tests/fixtures/self-host-reject-aggregate-class-alias",
          fixture,
        ),
      ],
      { encoding: "utf8" },
    );
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, pattern);
  }

  const valid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-aggregate-class-alias/valid.zs",
  );
  const validResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", valid],
    { encoding: "utf8" },
  );
  assert.equal(validResult.status, 0, validResult.stderr);

  const transparentValid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-aggregate-class-alias/opaque-valid.zs",
  );
  const transparentValidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", transparentValid],
    { encoding: "utf8" },
  );
  assert.equal(transparentValidResult.status, 0, transparentValidResult.stderr);

  const branchValid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-aggregate-class-alias/branch-valid.zs",
  );
  const branchValidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", branchValid],
    { encoding: "utf8" },
  );
  assert.equal(branchValidResult.status, 0, branchValidResult.stderr);

  const matchValid = resolve(
    projectRoot,
    "tests/fixtures/self-host-reject-aggregate-class-alias/match-valid.zs",
  );
  const matchValidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", matchValid],
    { encoding: "utf8" },
  );
  assert.equal(matchValidResult.status, 0, matchValidResult.stderr);

  const moduleValid = resolve(
    projectRoot,
    "tests/fixtures/self-host-aggregate-class-return/valid.zs",
  );
  const moduleValidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", moduleValid],
    { encoding: "utf8" },
  );
  assert.equal(moduleValidResult.status, 0, moduleValidResult.stderr);

  const moduleMatchValid = resolve(
    projectRoot,
    "tests/fixtures/self-host-aggregate-class-return/match-valid.zs",
  );
  const moduleMatchValidResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", moduleMatchValid],
    { encoding: "utf8" },
  );
  assert.equal(moduleMatchValidResult.status, 0, moduleMatchValidResult.stderr);

  const moduleOverlap = resolve(
    projectRoot,
    "tests/fixtures/self-host-aggregate-class-return/overlap.zs",
  );
  const moduleOverlapResult = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", moduleOverlap],
    { encoding: "utf8" },
  );
  assert.equal(moduleOverlapResult.status, 1, moduleOverlapResult.stderr);
  assert.match(
    moduleOverlapResult.stderr,
    /ARC aliases "application" and "context\.application"/,
  );
}, 120_000);

test("keeps native semantic authority composable across a representative Z corpus", () => {
  const entries = [
    "compiler/frontend/parser-library.zs",
    "examples/applications/source-inspector/main.zs",
    "examples/applications/document-workspace/main.zs",
    "examples/language/control-flow/result.zs",
    "examples/language/ownership/arena.zs",
    "examples/language/ownership/owned-closures.zs",
    "examples/language/types/generic-constraints.zs",
    "examples/async/async-ownership.zs",
  ];
  const parityPatterns = [
    [
      /observes (\d+) function, (\d+) method, and (\d+) constructor stage-0 Z resolutions/,
      /uses (\d+) function, (\d+) method, and (\d+) constructor native-authoritative contracts/,
    ],
    [
      /observes (\d+) aggregate, (\d+) field, and (\d+) enum-variant stage-0 Z resolutions/,
      /uses (\d+) aggregate, (\d+) field, and (\d+) enum-variant native-authoritative contracts/,
    ],
    [
      /observes (\d+) explicit type-use stage-0 Z resolutions/,
      /uses (\d+) explicit type-use native-authoritative contracts/,
    ],
    [
      /observes (\d+) inferred local binding stage-0 Z resolutions/,
      /uses (\d+) inferred local binding native-authoritative contracts/,
    ],
    [
      /observes (\d+) expression stage-0 Z resolutions/,
      /uses (\d+) expression native-authoritative contracts/,
    ],
  ] as const;

  for (const entry of entries) {
    const input = resolve(projectRoot, entry);
    const result = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${entry}\n${result.stderr}`);
    assert.match(result.stdout, /exports [1-9]\d* expression type contracts/);
    for (const [observedPattern, authoritativePattern] of parityPatterns) {
      const observed = result.stdout.match(observedPattern)?.slice(1);
      const authoritative = result.stdout.match(authoritativePattern)?.slice(1);
      assert.ok(observed, `${entry} did not report observed semantic counts`);
      assert.deepEqual(authoritative, observed, `${entry} left an observed native semantic result on Stage 0`);
    }
  }
}, 300_000);

test("preserves bounded channel endpoint and ownership effects natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-channel-parity.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /exports [1-9]\d* expression type contracts/);

  const observedBindings = parity.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = parity.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = parity.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = parity.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.ok(observedBindings);
  assert.ok(observedExpressions);
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(authoritativeExpressions, observedExpressions);

  const directory = mkdtempSync("/tmp/z-native-channel-negative-");
  const negative = resolve(directory, "main.zs");
  writeFileSync(negative, [
    'import { Channel } from "std/channel";',
    "struct Message { body: String; }",
    "async function main(): i32 {",
    "  const { sender, receiver } = Channel<Message>.bounded(1);",
    '  const message = Message({ body: "owned" });',
    "  await sender.send(message);",
    "  return 0;",
    "}",
    "",
  ].join("\n"));
  const missingMove = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", negative],
    { encoding: "utf8" },
  );
  assert.equal(missingMove.status, 1);
  assert.match(
    missingMove.stderr,
    /sending an existing message owner requires an explicit move/,
  );
  rmSync(directory, { recursive: true, force: true });
}, 120_000);

test("emits synchronous channel storage while retaining the async waiter boundary", () => {
  const input = resolve(projectRoot, "tests/fixtures/self-host-channel-sync.zs");
  const executed = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(executed.status, 0, executed.stderr);

  const directory = mkdtempSync("/tmp/z-native-channel-emission-");
  try {
    const cases = [
      { name: "sync", path: input },
      {
        name: "yielding",
        source: 'import { SyncSender } from "std/channel";\n'
          + 'import { scheduler } from "std/async";\n'
          + "async function listen(ready: SyncSender<i32>): void { await scheduler.yield(); }\n"
          + "function main(): i32 { return 0; }\n",
      },
      {
        name: "aliased",
        source: 'import { SyncSender as ReadySender } from "std/channel";\n'
          + "function listen(ready: ReadySender<i32>): void {}\n"
          + "function main(): i32 { return 0; }\n",
      },
      {
        name: "nested",
        source: 'import { SyncSender } from "std/channel";\n'
          + "struct Ready { sender: Option<SyncSender<i32>>; }\n"
          + "function main(): i32 { return 0; }\n",
      },
      {
        name: "callable-alias",
        source: 'import { SyncSender } from "std/channel";\n'
          + "type Notify = (sender: SyncSender<i32>) => void;\n"
          + "function main(): i32 { return 0; }\n",
      },
    ];
    for (const entry of cases) {
      const source = entry.path ?? resolve(directory, `${entry.name}.zs`);
      if (entry.source) writeFileSync(source, entry.source);
      const checked = spawnSync(process.execPath, [cli, "check", source, "--native-frontend"], {
        encoding: "utf8",
      });
      assert.equal(checked.status, 0, `${entry.name}\n${checked.stderr}`);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", source], {
        encoding: "utf8",
      });
      assert.equal(emitted.status, 0, `${entry.name}\n${emitted.stderr}`);
      const executable = resolve(directory, entry.name);
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable], {
        encoding: "utf8", input: emitted.stdout, timeout: 30_000,
      });
      assert.equal(compiled.status, 0, `${entry.name}\n${compiled.stderr}`);
      const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000 });
      assert.equal(ran.status, 0, `${entry.name}\n${ran.stderr}`);
    }

    const asynchronous = spawnSync(process.execPath, [
      cli, "self-host-emit", resolve(projectRoot, "tests/fixtures/self-host-channel-parity.zs"),
    ], { encoding: "utf8", timeout: 60_000 });
    assert.equal(asynchronous.status, 1);
    assert.match(asynchronous.stderr, /error\[Z0700\]: native asynchronous channel/);
    assert.match(asynchronous.stderr, /requires waiter lowering/);
    assert.doesNotMatch(asynchronous.stderr, /internal compiler error/);

    // Neither a lookalike generic name nor an unused import reserves storage.
    for (const [name, prefix] of [
      ["Sender", ""],
      ["MySender", 'import { Channel } from "std/channel";\n'],
    ]) {
      const source = resolve(directory, `${name}.zs`);
      writeFileSync(source, prefix
        + `struct ${name}<T> { value: T; }\n`
        + `function main(): i32 { const value = ${name}<i32>({ value: 42 }); return value.value - 42; }\n`);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", source], {
        encoding: "utf8",
      });
      assert.equal(emitted.status, 0, emitted.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

test("preserves trait receiver capabilities in the native module graph", () => {
  const input = resolve(projectRoot, "examples/language/basics/classes.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /native frontend hybrid matches 1 modules, 0 local edges, and 6 symbols/,
  );
  assert.match(
    result.stdout,
    /uses 3 inferred local binding native-authoritative contracts/,
  );
});

test("does not consume contextual payload-free generic enum variants", () => {
  const cases = [
    "examples/language/types/option.zs",
    "examples/async/async-owned-enums.zs",
  ];
  for (const fileName of cases) {
    const input = resolve(projectRoot, fileName);
    const result = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${fileName}\n${result.stderr}`);
    const observedBindings = result.stdout.match(
      /observes (\d+) inferred local binding stage-0 Z resolutions/,
    )?.[1];
    const authoritativeBindings = result.stdout.match(
      /uses (\d+) inferred local binding native-authoritative contracts/,
    )?.[1];
    assert.ok(observedBindings, fileName);
    assert.equal(authoritativeBindings, observedBindings, fileName);
  }
});

test("parses contextual enum variant names with native frontend parity", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-contextual-enum-variant.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("compares native function values by capability and type, not parameter names", () => {
  const input = resolve(projectRoot, "examples/language/basics/function-values.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.ok(observedExpressions);
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("defers generic thread-any capture proof until concrete specialization", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-generic-thread-any-callable.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /__atomic_add_fetch\(&environment->_z_refcount/);

  const directory = mkdtempSync("/tmp/z-generic-thread-any-callable-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("preserves stored async callable ABI layout in native C emission", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-layout.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct Z_AsyncInvocation/);
  assert.match(
    emission.stdout,
    /Z_AsyncInvocation \(\*start\)\(void \*context, Z_AsyncExecutor \*executor, int32_t const \*\)/,
  );
  assert.match(emission.stdout, /Z_.*_start\(Z_.* value, Z_AsyncExecutor \*executor/);
  assert.doesNotMatch(emission.stdout, /int32_t \(\*call\)\(void \*context, int32_t const \*\)/);

  const directory = mkdtempSync("/tmp/z-async-callable-layout-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("executes one completed stored async closure through the native ABI", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /frame->task\.completed = true/);
  assert.match(emission.stdout, /\.release_context = z_stage1_callable_/);
  assert.match(emission.stdout, /invocation\.take_result\(invocation\.task, &result\)/);
  assert.match(emission.stdout, /invocation\.destroy\(invocation\.task\)/);
  assert.match(emission.stdout, /invocation\.release_context\(invocation\.callable_context\)/);

  const directory = mkdtempSync("/tmp/z-async-callable-execution-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("transfers an owned result out of a completed stored async closure", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-owned-result.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /bool live_result;/);
  assert.match(emission.stdout, /frame->live_result = false;/);
  assert.match(emission.stdout, /if \(frame->live_result\) Z_String_deinit\(&frame->result\);/);

  const directory = mkdtempSync("/tmp/z-async-callable-owned-result-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("polls and resumes a stored async closure across scheduler.yield", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-yield.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /void \(\*poll\)\(Z_AsyncTask \*task\)/);
  assert.match(emission.stdout, /frame->_z_resume_state = 1;/);
  assert.match(emission.stdout, /z_stage1_async_enqueue\(task->executor, task\)/);
  assert.match(emission.stdout, /Z_AsyncTask \*waiter;/);
  assert.match(emission.stdout, /invocation\.task->waiter = &awaiter\.task;/);
  assert.match(emission.stdout, /z_stage1_async_enqueue\(waiter->executor, waiter\)/);
  assert.match(emission.stdout, /while \(!awaiter\.task\.completed\)/);
  assert.match(emission.stdout, /z_stage1_async_drive_one\(&executor\)/);
  assert.match(emission.stdout, /typedef struct z_stage1_async_parent_main/);
  assert.match(emission.stdout, /frame->child\.task->waiter = task;/);
  assert.match(
    emission.stdout,
    /int32_t main\(void\) \{\n  Z_AsyncExecutor executor = \{\};\n  z_stage1_async_parent_main \*frame/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /int32_t main\(void\) \{[^}]*Z_AsyncAwaiter awaiter/s,
  );

  const directory = mkdtempSync("/tmp/z-async-callable-yield-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("preserves an ordinary local and callable argument across parent suspension", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-parent-local.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /int32_t stored;/);
  assert.match(emission.stdout, /frame->stored = 42;/);
  assert.match(
    emission.stdout,
    /_start\(frame->local, task->executor, baseline\);/,
  );
  assert.match(
    emission.stdout,
    /const int32_t baseline = frame->stored;/,
  );

  const directory = mkdtempSync("/tmp/z-async-callable-parent-local-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("owns, cancels, and destroys a cleanup-bearing parent local across suspension", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-parent-owned-local.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /Z_SuspendedOwner stored;/);
  assert.match(emission.stdout, /bool live_stored;/);
  assert.match(emission.stdout, /bool cancellation_requested;/);
  assert.match(emission.stdout, /bool cancelled;/);
  assert.match(emission.stdout, /frame->live_stored = true;/);
  assert.match(
    emission.stdout,
    /_start\(frame->local, task->executor, &frame->stored\);/,
  );
  assert.match(
    emission.stdout,
    /if \(frame->live_stored\) \{ Z_SuspendedOwner_deinit\(&frame->stored\); frame->live_stored = false; \}/,
  );
  assert.match(
    emission.stdout,
    /z_stage1_async_request_cancel\(frame->child\.task\);/,
  );
  assert.match(
    emission.stdout,
    /if \(task->cancellation_requested\) \{[\s\S]*task->cancelled = true;[\s\S]*task->completed = true;/,
  );

  const directory = mkdtempSync("/tmp/z-async-callable-parent-owned-local-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "released 42\n");

  const interrupted = resolve(directory, "interrupted");
  const interruptedSource = `${emission.stdout}
#undef main
int interrupted_main(void) {
  Z_AsyncExecutor executor = {0};
  z_stage1_async_parent_main *frame = z_stage1_async_parent_main_start(&executor);
  z_stage1_async_enqueue(&executor, &frame->task);
  if (!z_stage1_async_run_one(&executor)) abort();
  z_stage1_async_parent_main_destroy(frame);
  if (z_stage1_async_run_one(&executor)) abort();
  return 0;
}
`;
  const interruptedCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Dmain=z_program_main",
      "-Dinterrupted_main=main",
      "-",
      "-o",
      interrupted,
    ],
    { encoding: "utf8", input: interruptedSource },
  );
  assert.equal(interruptedCompilation.status, 0, interruptedCompilation.stderr);
  const interruptedExecution = spawnSync(interrupted, [], {
    encoding: "utf8",
  });
  assert.equal(interruptedExecution.status, 0, interruptedExecution.stderr);
  assert.equal(interruptedExecution.stdout, "released 42\n");

  const cancelled = resolve(directory, "cancelled");
  const cancelledSource = `${emission.stdout}
#undef main
int cancelled_main(void) {
  Z_AsyncExecutor executor = {0};
  z_stage1_async_parent_main *frame = z_stage1_async_parent_main_start(&executor);
  z_stage1_async_enqueue(&executor, &frame->task);
  if (!z_stage1_async_run_one(&executor)) abort();
  z_stage1_async_parent_main_request_cancel(frame);
  while (!frame->task.completed) {
    if (!z_stage1_async_run_one(&executor)) abort();
  }
  if (!frame->task.cancelled) abort();
  z_stage1_async_parent_main_destroy(frame);
  if (z_stage1_async_run_one(&executor)) abort();
  return 0;
}
`;
  const cancelledCompilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Dmain=z_program_main",
      "-Dcancelled_main=main",
      "-",
      "-o",
      cancelled,
    ],
    { encoding: "utf8", input: cancelledSource },
  );
  assert.equal(cancelledCompilation.status, 0, cancelledCompilation.stderr);
  const cancelledExecution = spawnSync(cancelled, [], { encoding: "utf8" });
  assert.equal(cancelledExecution.status, 0, cancelledExecution.stderr);
  assert.equal(cancelledExecution.stdout, "released 42\n");
  rmSync(directory, { recursive: true, force: true });
});

test("runs and consumes a stored callable task inside native async scope", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-task-cancel.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct z_stage1_async_parent_main/);
  assert.match(
    emission.stdout,
    /_start\(frame->local, task->executor, &frame->stored\);/,
  );
  assert.match(
    emission.stdout,
    /z_stage1_async_request_cancel\(frame->child\.task\);/,
  );
  assert.match(
    emission.stdout,
    /if \(task->cancellation_requested\) \{[\s\S]*frame->result =/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /if \(task->cancellation_requested \|\| frame->child\.task->cancelled\)/,
  );

  const directory = mkdtempSync("/tmp/z-async-callable-task-cancel-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "released 42\n");
  rmSync(directory, { recursive: true, force: true });
});

test("joins a stored callable task inside native async scope", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-callable-task-join.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /typedef struct z_stage1_async_parent_main/);
  assert.match(
    emission.stdout,
    /_start\(frame->local, task->executor, &frame->stored\);/,
  );
  assert.match(
    emission.stdout,
    /task->cancellation_requested \|\| frame->child\.task->cancelled/,
  );
  assert.doesNotMatch(
    emission.stdout,
    /if \(frame->child\.task == NULL\) abort\(\);\n    z_stage1_async_request_cancel\(frame->child\.task\);/,
  );

  const directory = mkdtempSync("/tmp/z-async-callable-task-join-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "released 41\n");
  rmSync(directory, { recursive: true, force: true });
});

hostToolchainTest("transfers owned captures through native TaskScope async frames", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-task-scope-owned-capture.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /struct Z_TaskScope/);
  assert.match(emission.stdout, /bool _z_stage1_live_message;/);
  assert.match(
    emission.stdout,
    /#define _z_stage1_live_message \(frame->environment->_z_stage1_live_message\)/,
  );
  assert.match(
    emission.stdout,
    /#define _z_stage1_live_message \(frame->live_argument0\)/,
  );
  assert.match(
    emission.stdout,
    /\(_z_stage1_live_message = false, message\)/,
  );
  assert.match(
    emission.stdout,
    /if \(environment->_z_stage1_live_message\) Z_String_deinit\(&environment->message\)/,
  );

  const directory = mkdtempSync("/tmp/z-task-scope-owned-capture-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "native owned delivery\n");
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

hostToolchainTest("retains TaskScope fields copied into owned local bindings", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-task-scope-field.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /Z_TaskScope \* updates = Z_TaskScope_retain\(runtime->updates\);/,
  );

  const directory = mkdtempSync("/tmp/z-task-scope-field-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("runs a stored delay-suspending async method through TaskScope", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-task-scope-delay-method.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /uint64_t wake_at_ms;/);
  assert.match(emission.stdout, /z_stage1_async_schedule_delay\(task, 1000\)/);
  assert.match(emission.stdout, /z_stage1_async_wait_for_timer/);
  assert.match(emission.stdout, /request_cancel = .*_cancel/);
  assert.match(
    emission.stdout,
    /Z_DeliveryService_retain\(completionService\)/,
  );

  const directory = mkdtempSync("/tmp/z-task-scope-delay-method-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(
    execution.stdout,
    "completed request 40\ncompleted request 40\nreleased request 41\n",
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("propagates cancellation through an executor-placed async method tail", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-method-main-placement.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /frame->child = .*_start_invocation\(task->executor, self\)/,
  );
  assert.match(
    emission.stdout,
    /if \(frame->child\.task != NULL\) z_stage1_async_request_cancel\(frame->child\.task\)/,
  );
  assert.match(emission.stdout, /z_stage1_async_schedule_delay\(task, 1000\)/);

  const directory = mkdtempSync("/tmp/z-async-method-main-placement-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "released delegated publish\n");
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("propagates cancellation through an executor-placed async function tail", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-function-main-placement.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /frame->child = Z_.*_start\(.*task->executor/,
  );
  assert.match(
    emission.stdout,
    /z_stage1_async_remove_timer\(task\)/,
  );
  assert.match(emission.stdout, /z_stage1_async_schedule_delay\(task, 1000\)/);

  const directory = mkdtempSync("/tmp/z-async-function-main-placement-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "released free publish\n");
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("releases owned locals of suspending blocks exactly once in native frames", () => {
  // Stage 0 does not run these frames yet ("needs lexical frame cleanup
  // states"), so the expected releases are written out: each local goes at
  // its block's end, on break/continue, on return/throw from the block, and
  // on cancellation while suspended inside it, newest first.
  const input = resolve(projectRoot, "tests/fixtures/native-frame-lexical-locals.zs");
  const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emission.status, 0, emission.stderr);
  const directory = mkdtempSync("/tmp/z-native-frame-lexical-locals-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(
      execution.stdout,
      [
        "released branch",
        "after branch",
        "branch 6",
        "released step 1",
        "released step 2",
        "released step 3",
        "loop 4",
        "released held 1",
        "early return 1",
        "released held 2",
        "early throw 2",
        "kept payload with arm extra",
        "released arm extra",
        "released payload",
        "arm 1",
        "released pending",
        "cancelled sleeper",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs a worker frame awaiting a function with a placed call", () => {
  // `dispatch` is an ordinary async function with a placed call and owned
  // locals in a match arm; awaited from a worker frame, its placed call hops
  // to main.
  const input = resolve(projectRoot, "tests/fixtures/native-worker-awaits-placed-function.zs");
  const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
  const directory = mkdtempSync("/tmp/z-native-worker-awaits-placed-function-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("joins and cancels hopped work without racing the executor that reports it", () => {
  // A worker freed a hop whose completion the main executor had reported but
  // the worker had not yet drained (abort at executor teardown), and a hop's
  // cancellation read the posted child's executor field while main wrote it.
  // Both showed up within a few sanitizer runs.
  const directory = mkdtempSync("/tmp/z-native-hop-races-");
  try {
    for (const fixture of ["native-main-task-hops.zs", "self-host-emit-thread-cancel-main-match.zs"]) {
      const input = resolve(projectRoot, "tests/fixtures", fixture);
      const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(emission.status, 0, emission.stderr);
      for (const sanitizer of ["address,undefined", ...(process.platform === "darwin" ? ["thread"] : [])]) {
        const executable = resolve(directory, "program");
        const compilation = spawnSync("clang", ["-x", "c", "-std=c11", "-O1", "-pthread",
          `-fsanitize=${sanitizer}`, "-fno-sanitize-recover=all",
          ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : []), "-", "-o", executable],
        { encoding: "utf8", input: emission.stdout });
        assert.equal(compilation.status, 0, compilation.stderr);
        for (let run = 0; run < 30; run += 1) {
          const execution = spawnSync(executable, [], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
          assert.equal(execution.status, 0, `${fixture} ${sanitizer} run ${run}: ${execution.stderr}`);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);

test("runs structured placed async function suspension through a hop", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-function-main-placement-structured.zs",
  );
  const stage0 = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(stage0.status, 42, stage0.stderr);
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  // `invoke` takes the general frame and awaits its placed call through a hop
  // (directly, since it runs on the main thread).
  assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
  const directory = mkdtempSync("/tmp/z-async-function-main-placement-structured-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread", "-", "-o", executable],
      { encoding: "utf8", input: emission.stdout },
    );
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], { encoding: "utf8" });
    assert.equal(execution.status, 42, execution.stderr);
    assert.equal(execution.stdout, stage0.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resumes synchronous work after an executor-placed async function local", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-function-main-placement-local.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /frame->child = Z_.*_start\(.*task->executor/);
  // The placed call is a hop from `invoke`'s general frame.
  assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
  assert.match(emission.stdout, /z_stage1_async_schedule_delay\(task, 1\)/);

  const directory = mkdtempSync("/tmp/z-async-function-main-placement-local-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(
    execution.status,
    0,
    `${execution.stderr}\nsignal: ${execution.signal}\nstdout: ${execution.stdout}`,
  );
  assert.equal(
    execution.stdout,
    "completed free local publish\nreleased free local publish\n" +
      "observed free local publish\nreleased result free local publish\n",
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("keeps an async local named state distinct from resume storage", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-local-state.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /uint32_t _z_resume_state;/);
  assert.match(emission.stdout, /Z_RunState \* _z_local_state;/);
  assert.doesNotMatch(emission.stdout, /uint32_t state;/);

  const directory = mkdtempSync("/tmp/z-async-local-state-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(
    execution.status,
    0,
    `${execution.stderr}\nsignal: ${execution.signal}\nstdout: ${execution.stdout}`,
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("propagates an owned error from an executor-placed async function local", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-function-main-placement-local-throws.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /\.tag == Z___z_Result_i32_PublishErrorTag_failure/,
  );
  // The placed call is a hop from the caller's general frame, which cancels
  // the hopped child with itself.
  assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
  assert.match(
    emission.stdout,
    /if \(frame->child\.task != NULL\) z_stage1_async_request_cancel\(frame->child\.task\)/,
  );

  const directory = mkdtempSync("/tmp/z-async-function-main-placement-local-throws-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(
    execution.status,
    0,
    `${execution.stderr}\nsignal: ${execution.signal}\nstdout: ${execution.stdout}`,
  );
  assert.equal(
    execution.stdout,
    "released request typed publish\nreleased error typed publish\n",
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("lowers Result aliases, explicit Option fields, and a throwing async main", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-async-result-alias-main-throws.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /switch \(_z_stage1_match_\d+\.tag\)/,
  );
  assert.match(
    emission.stdout,
    /\.body = \(Z___z_Option_String\)\{\.tag = Z___z_Option_StringTag_some/,
  );
  assert.match(
    emission.stdout,
    /static __attribute__\(\(unused\)\) Z___z_Result_i32_WorkError z_stage1_main_result\(void\)/,
  );
  assert.match(emission.stdout, /int main\(void\)/);

  const directory = mkdtempSync("/tmp/z-async-result-alias-main-throws-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(
    execution.status,
    0,
    `${execution.stderr}\nsignal: ${execution.signal}\nstdout: ${execution.stdout}`,
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("materializes a synchronous main-isolated error through taskification", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-sync-main-error-taskification.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  // `dispatch` is a general frame: the materialized Result lives in it, and
  // the placed call is a hop.
  assert.match(
    emission.stdout,
    /Z___z_Result_i32_OperationError _z_binding_called;/,
  );
  assert.match(emission.stdout, /frame->child = z_stage1_async_hop_start\(task->executor, /);
  assert.match(
    emission.stdout,
    /z_id = _z_stage1_try_\d+\.payload\.success/,
  );

  const directory = mkdtempSync("/tmp/z-sync-main-error-taskification-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    [
      "-x",
      "c",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-pthread",
      "-",
      "-o",
      executable,
    ],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(
    execution.status,
    0,
    `${execution.stderr}\nsignal: ${execution.signal}\nstdout: ${execution.stdout}`,
  );
  rmSync(directory, { recursive: true, force: true });
}, 60_000);

test("preserves thread-any callable contracts and emits atomic closure environments", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-any-callable.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /__atomic_add_fetch\(&environment->_z_refcount, 1, __ATOMIC_RELAXED\)/,
  );
  assert.match(
    emission.stdout,
    /__atomic_sub_fetch\(&environment->_z_refcount, 1, __ATOMIC_ACQ_REL\)/,
  );
  assert.match(emission.stdout, /_retain\(captured\)/);

  const directory = mkdtempSync("/tmp/z-thread-any-callable-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  const invalidCases = [
    {
      name: "missing-thread-import",
      source: "type Handler = () => i32 on thread.any;\n",
      expected: /on thread\.any.*require.*std\/thread/,
    },
    {
      name: "weaker-local-function",
      source:
        "import { thread } from \"std/thread\";\n"
        + "type Handler = () => i32 on thread.any;\n"
        + "function local(): i32 { return 42; }\n"
        + "function main(): i32 { const handler: Handler = local; return handler(); }\n",
      expected: /expected.*thread\.any|expected.*Handler|function.*thread/i,
    },
    {
      name: "mutable-capture",
      source:
        "import { Map } from \"std/collections\";\n"
        + "import { thread } from \"std/thread\";\n"
        + "type Handler = () => i32 on thread.any;\n"
        + "function main(): i32 {\n"
        + "  let values = Map<String, i32>();\n"
        + "  const handler: Handler = move () => i32(values.length);\n"
        + "  return handler();\n"
        + "}\n",
      expected: /capture "values".*not shareable across arbitrary threads/,
    },
  ] as const;
  for (const invalidCase of invalidCases) {
    const invalidInput = resolve(directory, `${invalidCase.name}.zs`);
    writeFileSync(invalidInput, invalidCase.source);
    const invalid = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", invalidInput],
      { encoding: "utf8" },
    );
    assert.equal(invalid.status, 1, invalidCase.name);
    assert.match(invalid.stderr, invalidCase.expected, invalidCase.name);
  }
  rmSync(directory, { recursive: true, force: true });
});

test("preserves thread.main callable placement through native resolution and emission", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-thread-main-callable.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /environment->_z_refcount \+= 1/);
  assert.match(emission.stdout, /environment->_z_refcount -= 1/);
  assert.doesNotMatch(emission.stdout, /__atomic_(?:add|sub)_fetch\(&environment->_z_refcount/);
  assert.match(
    emission.stdout,
    /Z_Controller \* const stored = Z_Controller_retain\(\(\(\(Z___z_Array_Controller_ConstData\)\(controllers\)\.data\)\[z_stage1_bounds_index\(0, \(controllers\)\.length\)\]\)\);/,
  );
  assert.match(emission.stdout, /Z_Controller_release\(items\[self->length\]\)/);

  const directory = mkdtempSync("/tmp/z-thread-main-callable-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  const invalidCases = [
    {
      name: "construct-off-main",
      source:
        "import { thread } from \"std/thread\";\n"
        + "type Handler = () => i32 on thread.main;\n"
        + "function build(): Handler { const value: Handler = move () => 42; return value; }\n"
        + "function main(): i32 on thread.main { return 0; }\n",
      expected: /function value construction.*requires thread\.main/,
    },
    {
      name: "reference-off-main",
      source:
        "import { thread } from \"std/thread\";\n"
        + "type Handler = () => i32 on thread.main;\n"
        + "function selected(): i32 on thread.main { return 42; }\n"
        + "function build(): Handler { return selected; }\n"
        + "function main(): i32 on thread.main { return 0; }\n",
      expected: /function value "selected".*requires thread\.main/,
    },
    {
      name: "invoke-off-main",
      source:
        "import { thread } from \"std/thread\";\n"
        + "type Handler = () => i32 on thread.main;\n"
        + "function invoke(in handler: Handler): i32 { return handler(); }\n"
        + "function main(): i32 on thread.main { return 0; }\n",
      expected: /function "handler".*requires thread\.main/,
    },
  ] as const;
  for (const invalidCase of invalidCases) {
    const invalidInput = resolve(directory, `${invalidCase.name}.zs`);
    writeFileSync(invalidInput, invalidCase.source);
    const invalid = spawnSync(
      process.execPath,
      [cli, "self-host-resolve", invalidInput],
      { encoding: "utf8" },
    );
    assert.equal(invalid.status, 1, invalidCase.name);
    assert.match(invalid.stderr, invalidCase.expected, `${invalidCase.name}\n${invalid.stderr}`);
  }
  rmSync(directory, { recursive: true, force: true });
});

test("preserves thread.main through re-exported callable aliases", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-imported-thread-main-alias/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const resolution = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(resolution.status, 0, resolution.stderr);
});

test("rebases nominal identities inside imported callable and value aliases", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-imported-function-value/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);
  assert.match(parity.stdout, /native frontend hybrid/);

  const resolution = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(resolution.status, 0, resolution.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /retainBorrowedHandler/);
});

test("preserves throwing closure and transparent callable-alias effects natively", () => {
  const cases = [
    "examples/language/basics/throwing-function-values.zs",
    "examples/async/thread-errors.zs",
    "examples/async/thread-native-errors.zs",
  ];
  for (const fileName of cases) {
    const input = resolve(projectRoot, fileName);
    const result = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${fileName}\n${result.stderr}`);
    const observedBindings = result.stdout.match(
      /observes (\d+) inferred local binding stage-0 Z resolutions/,
    )?.[1];
    const authoritativeBindings = result.stdout.match(
      /uses (\d+) inferred local binding native-authoritative contracts/,
    )?.[1];
    const observedExpressions = result.stdout.match(
      /observes (\d+) expression stage-0 Z resolutions/,
    )?.[1];
    const authoritativeExpressions = result.stdout.match(
      /uses (\d+) expression native-authoritative contracts/,
    )?.[1];
    assert.ok(observedBindings, fileName);
    assert.ok(observedExpressions, fileName);
    assert.equal(authoritativeBindings, observedBindings, fileName);
    assert.equal(authoritativeExpressions, observedExpressions, fileName);
  }
});

test("resolves aggregate members through exported transparent aliases natively", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-transparent-aggregate-alias/main.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /\.value = \{ \.i32_value = .*\.code/);
  assert.match(emission.stdout, /\.value = \{ \.string_value = .*\.message/);
});

test("preserves callable identities nested in Map values", () => {
  const input = resolve(
    projectRoot,
    "examples/applications/message-router/main.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.ok(observedBindings);
  assert.ok(observedExpressions);
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("invokes an imported callable alias retrieved from a Map", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-imported-callable-map/main.zs",
  );
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /_call\(selected,/);

  const directory = mkdtempSync("/tmp/z-imported-callable-map-");
  const executable = resolve(directory, "program");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("preserves weak-reference construction and upgrade effects natively", () => {
  const input = resolve(
    projectRoot,
    "examples/language/ownership/weak-references.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(observedBindings, "11");
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(observedExpressions, "85");
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("preserves recursive ownership through unimported aggregate field types", () => {
  const input = resolve(
    projectRoot,
    "examples/applications/project-index/main.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.ok(observedBindings);
  assert.equal(authoritativeBindings, observedBindings);
  assert.ok(observedExpressions);
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("defers dependent generic comparisons to concrete specialization", () => {
  const input = resolve(projectRoot, "examples/language/types/generics.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /exports 5 resolved call contracts/);
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(observedBindings, "4");
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(observedExpressions, "19");
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("defers unavailable foreign ABI semantics without inventing native diagnostics", () => {
  const cases = [
    "examples/interop/c/apple-groundwork.zs",
    "examples/interop/c/foreign-types.zs",
    "examples/interop/c/selective-declarations.zs",
    "examples/interop/objc/desktop-ownership/main.zs",
    "examples/interop/objc/protocol-adapter.zs",
    "examples/interop/objc/target-action.zs",
    "tests/fixtures/self-host-foreign-nullable-widening.zs",
  ];
  for (const fileName of cases) {
    const input = resolve(projectRoot, fileName);
    const result = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${fileName}\n${result.stderr}`);
    const observedBindings = result.stdout.match(
      /observes (\d+) inferred local binding stage-0 Z resolutions/,
    )?.[1];
    const authoritativeBindings = result.stdout.match(
      /uses (\d+) inferred local binding native-authoritative contracts/,
    )?.[1];
    const observedExpressions = result.stdout.match(
      /observes (\d+) expression stage-0 Z resolutions/,
    )?.[1];
    const authoritativeExpressions = result.stdout.match(
      /uses (\d+) expression native-authoritative contracts/,
    )?.[1];
    assert.ok(observedBindings, fileName);
    assert.ok(observedExpressions, fileName);
    assert.equal(authoritativeBindings, observedBindings, fileName);
    assert.equal(authoritativeExpressions, observedExpressions, fileName);
  }
}, 60_000);

test("defers move ownership for unresolved foreign types to stage-0 metadata", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-unresolved-foreign-move.zs",
  );
  const result = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", input],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("classifies unresolved foreign integer conversion evidence before native lowering", () => {
  const input = resolve(
    projectRoot,
    "examples/interop/c/foreign-enum-conversion.zs",
  );
  const stage0 = spawnSync(process.execPath, [cli, "check", input], {
    encoding: "utf8",
  });
  assert.equal(stage0.status, 0, stage0.stderr);

  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8",
  });
  assert.equal(native.status, 1, native.stdout);
  assert.ok(
    native.stderr.includes(
      `${input}:4:25: error[Z1000]: the native compiler cannot yet prove this numeric conversion operand's type`,
    ),
    native.stderr,
  );
  assert.match(
    native.stderr,
    /\^\^\^\^\^\^\^\^\^\^\^\^\^\^\^\^\^ the native compiler cannot yet prove this numeric conversion operand's type/,
  );
});

test("preserves nominal identities inside linked generic monomorphs", () => {
  const directory = mkdtempSync("/tmp/z-native-generic-identities-");
  const syntaxModule = resolve(directory, "syntax.zs");
  const semanticModule = resolve(directory, "semantic.zs");
  const modelModule = resolve(directory, "model.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(
    syntaxModule,
    "export struct Node { width: i32; }\n",
  );
  writeFileSync(
    semanticModule,
    "export struct Node { code: i32; }\n",
  );
  writeFileSync(
    modelModule,
    "export struct Slot<T> { value: T; }\n"
      + "export struct Envelope<T> { value: T; }\n",
  );
  writeFileSync(
    main,
    "import { Node as SyntaxNode } from \"./syntax.zs\";\n"
      + "import { Node as SemanticNode } from \"./semantic.zs\";\n"
      + "import { Envelope, Slot } from \"./model.zs\";\n"
      + "function main(): i32 {\n"
      + "  const syntaxNode = SyntaxNode({ width: 20 });\n"
      + "  const semanticNode = SemanticNode({ code: 22 });\n"
      + "  const syntaxSlot = Slot<SyntaxNode>({ value: syntaxNode });\n"
      + "  const semanticSlot = Slot<SemanticNode>({ value: semanticNode });\n"
      + "  const syntaxEnvelope = Envelope<Slot<SyntaxNode>>({ value: syntaxSlot });\n"
      + "  const semanticEnvelope = Envelope<Slot<SemanticNode>>({ value: semanticSlot });\n"
      + "  return syntaxEnvelope.value.value.width + semanticEnvelope.value.value.code;\n"
      + "}\n",
  );

  const result = spawnSync(
    process.execPath,
    [cli, "check", main, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const exportedBindings = result.stdout.match(
    /exports (\d+) inferred local binding contracts/,
  )?.[1];
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(exportedBindings, "6");
  assert.ok(observedBindings);
  assert.ok(observedExpressions);
  assert.equal(observedBindings, exportedBindings);
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("preserves direct and intrinsic async effects in native semantic evidence", () => {
  const cases = [
    ["examples/language/control-flow/async-generators.zs", "13", "7"],
    ["examples/async/async-errors.zs", "2", "2"],
  ] as const;
  for (const [
    fileName,
    expectedExportedBindings,
    expectedObservedBindings,
  ] of cases) {
    const input = resolve(projectRoot, fileName);
    const result = spawnSync(
      process.execPath,
      [cli, "check", input, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${fileName}\n${result.stderr}`);
    const exportedBindings = result.stdout.match(
      /exports (\d+) inferred local binding contracts/,
    )?.[1];
    const observedBindings = result.stdout.match(
      /observes (\d+) inferred local binding stage-0 Z resolutions/,
    )?.[1];
    const authoritativeBindings = result.stdout.match(
      /uses (\d+) inferred local binding native-authoritative contracts/,
    )?.[1];
    const observedExpressions = result.stdout.match(
      /observes (\d+) expression stage-0 Z resolutions/,
    )?.[1];
    const authoritativeExpressions = result.stdout.match(
      /uses (\d+) expression native-authoritative contracts/,
    )?.[1];
    assert.equal(exportedBindings, expectedExportedBindings, fileName);
    assert.equal(observedBindings, expectedObservedBindings, fileName);
    assert.equal(authoritativeBindings, observedBindings, fileName);
    assert.ok(observedExpressions, fileName);
    assert.equal(authoritativeExpressions, observedExpressions, fileName);
  }
});

test("preserves structured task creation and joins in native semantic evidence", () => {
  const input = resolve(projectRoot, "examples/async/async-tasks.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const exportedBindings = result.stdout.match(
    /exports (\d+) inferred local binding contracts/,
  )?.[1];
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(exportedBindings, "12");
  assert.equal(observedBindings, exportedBindings);
  assert.equal(authoritativeBindings, observedBindings);
  assert.ok(observedExpressions);
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("preserves executor placement and capture effects in native semantic evidence", () => {
  const input = resolve(projectRoot, "examples/async/executor-placement.zs");
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const exportedBindings = result.stdout.match(
    /exports (\d+) inferred local binding contracts/,
  )?.[1];
  const observedBindings = result.stdout.match(
    /observes (\d+) inferred local binding stage-0 Z resolutions/,
  )?.[1];
  const authoritativeBindings = result.stdout.match(
    /uses (\d+) inferred local binding native-authoritative contracts/,
  )?.[1];
  const observedExpressions = result.stdout.match(
    /observes (\d+) expression stage-0 Z resolutions/,
  )?.[1];
  const authoritativeExpressions = result.stdout.match(
    /uses (\d+) expression native-authoritative contracts/,
  )?.[1];
  assert.equal(exportedBindings, "6");
  assert.equal(observedBindings, exportedBindings);
  assert.equal(authoritativeBindings, observedBindings);
  assert.ok(observedExpressions);
  assert.equal(authoritativeExpressions, observedExpressions);
});

hostToolchainTest("keeps top-level test declarations in native frontend parity", () => {
  const directory = mkdtempSync("/tmp/z-native-test-syntax-");
  const input = resolve(directory, "calculator.test.zs");
  writeFileSync(input, `
    function add(left: i32, right: i32): i32 {
      return left + right;
    }

    test "add combines values" {
      const answer = add(20, 22);
    }
  `);
  const result = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /native frontend hybrid matches/);
  assert.match(result.stdout, /uses 1 function/);
}, 60_000);

hostToolchainTest("preserves first-tier struct spread capability evidence natively", () => {
  const directory = mkdtempSync("/tmp/z-native-struct-spread-");
  const valid = resolve(directory, "valid.zs");
  writeFileSync(valid, `
    struct Label {
      value: String;
      subtitle?: String;
    }

    struct Pair<T> {
      first: T;
      second: T;
    }

    function main(): i32 {
      const baseline = Pair<i32>({ first: 20, second: 22 });
      const plain = Pair<i32>({ ...baseline, first: 21 });
      const copied = Pair<i32>({ copy ...baseline, second: 23 });
      const label = Label({ value: "ready" });
      const moved = Label({ move ...label });
      return plain.first + copied.second + i32(moved.value.byteLength) - 49;
    }
  `);

  const parsed = spawnSync(
    process.execPath,
    [cli, "self-host-parse", valid],
    { encoding: "utf8" },
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /stage-1 parser matches/);

  const resolved = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", valid],
    { encoding: "utf8" },
  );
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.match(resolved.stdout, /stage-1 resolver exports \d+ expression type contracts/);
  const executableSource = resolve(directory, "executable.zs");
  writeFileSync(executableSource, `
    struct Label {
      value: String;
      subtitle?: String;
    }

    struct Pair {
      first: i32;
      second: i32;
    }

    function main(): i32 {
      const baseline = Pair({ first: 20, second: 22 });
      const plain = Pair({ ...baseline, first: 21 });
      const copied = Pair({ copy ...baseline, second: 23 });
      const copySource = Label({ value: "ready", subtitle: "owned" });
      const copiedLabel = Label({ copy ...copySource });
      const label = Label({ value: "ready" });
      const moved = Label({ move ...label });
      const copiedSubtitleLength = match (in copiedLabel.subtitle) {
        some(subtitle) => i32(subtitle.byteLength);
        none => 0;
      };
      return plain.first
        + copied.second
        + i32(copiedLabel.value.byteLength)
        + copiedSubtitleLength
        + i32(moved.value.byteLength)
        - 59;
    }
  `);
  const emitted = spawnSync(
    process.execPath,
    [cli, "self-host-emit", executableSource],
    { encoding: "utf8" },
  );
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /\.first = 21, \.second = baseline\.second/);
  assert.match(emitted.stdout, /\.first = baseline\.first, \.second = 23/);
  assert.match(emitted.stdout, /\.value = z_string_copy\(copySource\.value\)/);
  assert.match(
    emitted.stdout,
    /\.subtitle = z_stage1_copy___z_Option_String\(copySource\.subtitle\)/,
  );
  assert.match(emitted.stdout, /\.value = label\.value/);
  const executable = resolve(directory, "valid");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emitted.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  const useAfterMove = resolve(directory, "use-after-move.zs");
  writeFileSync(useAfterMove, `
    struct Label {
      value: String;
    }

    function main(): i32 {
      const source = Label({ value: "ready" });
      const moved = Label({ move ...source });
      const retained = i32(moved.value.byteLength);
      return retained + i32(source.value.byteLength);
    }
  `);
  const moved = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", useAfterMove],
    { encoding: "utf8" },
  );
  assert.equal(moved.status, 1, moved.stdout);
  assert.match(moved.stderr, /use of moved value "source"/);

  const specialization = resolve(directory, "specialization.zs");
  writeFileSync(specialization, `
    struct Pair<T> {
      first: T;
      second: T;
    }

    function main(): i32 {
      const source = Pair<i32>({ first: 20, second: 22 });
      const invalid = Pair<i64>({ ...source });
      return i32(invalid.first);
    }
  `);
  const specialized = spawnSync(
    process.execPath,
    [cli, "self-host-resolve", specialization],
    { encoding: "utf8" },
  );
  assert.equal(specialized.status, 1, specialized.stdout);
  assert.match(
    specialized.stderr,
    /requires the same nominal specialization, found Pair<i32>/,
  );

  const cleanupBoundary = resolve(directory, "cleanup-boundary.zs");
  writeFileSync(cleanupBoundary, `
    import console from "std/console";

    struct Resource {
      id: i32;

      deinit {
        console.log(\`released \${this.id}\`);
      }
    }

    struct Bundle {
      retained: Resource;
      replaced: Resource;
    }

    function main(): i32 {
      const source = Bundle({
        retained: Resource({ id: 1 }),
        replaced: Resource({ id: 2 }),
      });
      const spread = Bundle({
        move ...source,
        replaced: Resource({ id: 3 }),
      });
      console.log(\`\${spread.retained.id}\`);
      const allSource = Bundle({
        retained: Resource({ id: 4 }),
        replaced: Resource({ id: 5 }),
      });
      const replacedAll = Bundle({
        move ...allSource,
        retained: Resource({ id: 6 }),
        replaced: Resource({ id: 7 }),
      });
      console.log(\`\${replacedAll.retained.id}\`);
      return spread.replaced.id + replacedAll.replaced.id - 10;
    }
  `);
  const cleanupStage0 = spawnSync(
    process.execPath,
    [cli, "run", cleanupBoundary],
    { encoding: "utf8" },
  );
  assert.equal(cleanupStage0.status, 0, cleanupStage0.stderr);
  assert.equal(
    cleanupStage0.stdout,
    "released 2\n1\nreleased 5\nreleased 4\n6\nreleased 7\nreleased 6\nreleased 3\nreleased 1\n",
  );
  const cleanupEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", cleanupBoundary],
    { encoding: "utf8" },
  );
  assert.equal(cleanupEmission.status, 0, cleanupEmission.stderr);
  assert.match(
    cleanupEmission.stdout,
    /Z_Resource_deinit\(&\(source\.replaced\)\)/,
  );
  const cleanupExecutable = resolve(directory, "cleanup-boundary");
  const cleanupCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", cleanupExecutable],
    { encoding: "utf8", input: cleanupEmission.stdout },
  );
  assert.equal(cleanupCompilation.status, 0, cleanupCompilation.stderr);
  const cleanupExecution = spawnSync(cleanupExecutable, [], { encoding: "utf8" });
  assert.equal(cleanupExecution.status, 0, cleanupExecution.stderr);
  assert.equal(cleanupExecution.stdout, cleanupStage0.stdout);
}, 90_000);

test("requests cancellation through a borrowed stored TaskControl", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-borrowed-task-control-cancel.zs",
  );
  const parity = spawnSync(
    process.execPath,
    [cli, "check", input, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(parity.status, 0, parity.stderr);

  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /z_stage1_task_control_request_cancel\(\(Z_TaskControl \*\)/,
  );
  assert.match(emission.stdout, /Z_TaskControl \* const \*control/);
});

hostToolchainTest("compares borrowed String elements through native lowering", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-view-string-equality.zs",
  );
  const stage0 = spawnSync(process.execPath, [cli, "run", input], {
    encoding: "utf8",
  });
  assert.equal(stage0.status, 0, stage0.stderr);

  const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8",
  });
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /z_string_equal\(/);

  const directory = mkdtempSync("/tmp/z-view-string-equality-");
  const executable = resolve(directory, "view-string-equality");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
});

hostToolchainTest("owns template temporaries inside expression-bodied closures", () => {
  const input = resolve(
    projectRoot,
    "tests/fixtures/self-host-emit-expression-closure-template.zs",
  );
  const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8",
  });
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(
    emission.stdout,
    /z_stage1_callable_main_\d+_call[\s\S]*Z_String _z_stage1_borrow_/,
  );

  const directory = mkdtempSync("/tmp/z-expression-closure-template-");
  const executable = resolve(directory, "expression-closure-template");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: emission.stdout },
  );
  assert.equal(compilation.status, 0, compilation.stderr);
  const execution = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "worker message: ready\n");
});

hostToolchainTest("infers readonly collection lengths in templates and borrowed callbacks", () => {
  const input = resolve(projectRoot, "tests/fixtures/self-host-emit-readonly-collection-length.zs");
  const expected = "callback 2/1/2\nviews 2/1/2\ncopy 2; original 2\ndetached kept\ncustom ordinary field\n";
  const stage0 = spawnSync(process.execPath, [cli, "run", input], {
    encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  });
  assert.equal(stage0.status, 0, stage0.stderr);
  assert.equal(stage0.stdout, expected);
  const emission = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
  });
  assert.equal(emission.status, 0, emission.stderr || String(emission.error));
  const directory = mkdtempSync("/tmp/z-readonly-length-");
  try {
    const executable = resolve(directory, "readonly-length");
    const compilation = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable,
    ], { encoding: "utf8", input: emission.stdout, timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compilation.status, 0, compilation.stderr);
    const execution = spawnSync(executable, [], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
    });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
