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
}, 30_000);

test("parses declarations, function bodies, and type shapes in native Z", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-parser-input.zs");
  const lexer = resolve(projectRoot, "compiler/frontend/lexer.zs");
  const parser = resolve(projectRoot, "compiler/frontend/parser.zs");
  const result = spawnSync(process.execPath, [cli, "self-host-parse", fixture, lexer, parser, "--timings"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-host-parser-input\.zs: stage-1 parser matches 17 declarations, 4 imports, 7 function signatures, 7 function bodies, and 6 type shapes/);
  assert.match(result.stdout, /lexer\.zs: stage-1 parser matches 18 declarations, 1 imports, 13 function signatures, 13 function bodies, and 4 type shapes/);
  assert.match(result.stdout, /parser\.zs: stage-1 parser matches \d+ declarations, \d+ imports, \d+ function signatures, \d+ function bodies, and \d+ type shapes/);
  assert.match(result.stdout, /stage-1 parser timing \(3 files, cache (?:hit|miss; seed compile \+ self-emission \+ native build \+ fixed-point verification included)\)/);
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
  assert.equal(observedExpressions, "6");
  assert.equal(authoritativeExpressions, observedExpressions);

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
      + "  const absent = match (in omitted.payload) {\n"
      + "    some(value) => value.value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  const present = match (in lifted.payload) {\n"
      + "    some(value) => value.value;\n"
      + "    none => 0;\n"
      + "  };\n"
      + "  return absent + present - 42;\n"
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
    /\.payload = \(Z___z_Option_Resource\)\{\.tag = Z___z_Option_ResourceTag_some, \.payload\.some = resource\}/,
  );
  assert.doesNotMatch(emission.stdout, /Z_Resource_deinit\(&resource\);/);

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
      expected: /requires a named stable receiver/,
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
      expected: /cleanup-bearing view projection remains deferred/,
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
      expected: /supports stable Option<String>\?\.byteAt\(index\)/,
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
  assert.match(emission.stdout, /z_string_copy_bytes\(\(\*\(label\)\), 0, \(label\)->length\)/);
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
    /uses 3 expression native-authoritative contracts/,
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

test("emits and runs the first program directly from the native Z AST", () => {
  const input = resolve(projectRoot, "tests/fixtures/self-host-emit-input.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", input],
    { encoding: "utf8" },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /int32_t add\(int32_t a, int32_t b\);/);
  assert.match(emission.stdout, /const int32_t answer = add\(20, 22\);/);

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
    /Z_RequestOptions patient = \(Z_RequestOptions\)\{\.timeoutMilliseconds = 5000, \.retries = 3/,
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
    /int32_t readValue\(const Z_Wrapper \*wrapper\).*?_z_stage1_match_payload_\d+_\d+\.value/s,
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
    /case Z___z_Option_i32Tag_some:.*?return readValue\(_z_stage1_match_payload_\d+_\d+\);/s,
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
    /typedef struct Z_Point.*?int32_t add\(int32_t first, int32_t second\);.*?Z_Point makePoint\(int32_t x, int32_t y\);.*?int32_t sum\(Z_Point point\);.*?int32_t main\(void\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /typedef struct Z_Session \{.*?Z_Resource resource;.*?static __attribute__\(\(unused\)\) void Z_Session_deinit\(Z_Session \*self\) \{.*?Z_Resource_deinit\(&self->resource\);.*?int32_t resourceId\(Z_Session session\) \{.*?Z_Session_deinit\(&session\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /typedef struct Z_ResourceState \{.*?Z_Resource ready;.*?static __attribute__\(\(unused\)\) void Z_ResourceState_deinit\(Z_ResourceState \*self\) \{.*?Z_Resource_deinit\(&self->payload\.ready\);.*?int32_t stateId\(Z_ResourceState value\) \{.*?case Z_ResourceStateTag_ready:.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);/s,
  );
  assert.match(
    moduleEmission.stdout,
    /int32_t main\(void\) \{.*?Z_Point point = makePoint\(20, 20\);.*?Z_Point directPoint = \(Z_Point\)\{\.x = 1, \.y = 1\};.*?Z_Resource resource = makeResource\(0\);.*?Z_Session session = \(Z_Session\)\{\.resource = resource\};.*?Z_ResourceState current = makeState\(0\);.*?Z_ResourceState direct = \(Z_ResourceState\)\{\.tag = Z_ResourceStateTag_ready, \.payload\.ready = makeResource\(0\)\};.*?Z_ResourceState empty = \(Z_ResourceState\)\{\.tag = Z_ResourceStateTag_empty\};/s,
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
      /int32_t __z_module_\d+_helper\(int32_t value\)/g,
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
  assert.notEqual(exportedCollisionEmission.status, 0);
  assert.match(
    exportedCollisionEmission.stderr,
    /native module emission requires collision-safe function identity for duplicate/,
  );

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
    /size_t addSize\(size_t value\).*?z_stage1_checked_add_usize\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /uint8_t doubleByte\(uint8_t value\).*?z_stage1_checked_multiply_u8\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /size_t halveSize\(size_t value\).*?z_stage1_checked_divide_usize\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /uint8_t remainderByte\(uint8_t value\).*?z_stage1_checked_remainder_u8\(value, 5\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /int32_t halveSigned\(int32_t value\).*?z_stage1_checked_divide_i32\(value, 2\)/s,
  );
  assert.match(
    nativeIntegerEmission.stdout,
    /typedef struct Z___z_Array_i32 \{.*?void \*data;.*?size_t length;.*?size_t capacity;.*?static __attribute__\(\(unused\)\) void Z___z_Array_i32_deinit\(Z___z_Array_i32 \*self\).*?size_t discard\(Z___z_Array_i32 values\).*?Z___z_Array_i32_deinit\(&values\);/s,
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
      + "  output.appendBytes(\"llo!\", 0, 2);\n"
      + "  output.appendAscii(111);\n"
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
    /Z_String inspect\(Z_String value\)|size_t inspect\(Z_String value\)/,
  );
  assert.match(nativeStringEmission.stdout, /z_string_copy_bytes\(value, 1, 4\)/);
  assert.match(nativeStringEmission.stdout, /z_string_equal\(middle, Z_STRING_LITERAL\("ell"\)\)/);
  assert.match(nativeStringEmission.stdout, /z_string_byte_at\(value, 0\)/);
  assert.match(nativeStringEmission.stdout, /Z_String_deinit\(&middle\)/);
  assert.match(nativeStringEmission.stdout, /Z_String_deinit\(&value\)/);
  assert.match(
    nativeStringEmission.stdout,
    /size_t borrowedLength\(const Z_String \*value\).*?\(\(\*value\)\)\.length/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /void initialize\(size_t \*value\).*?\(\*value\) = 20;/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /void increment\(size_t \*value\).*?\(\*value\) = z_stage1_checked_add_usize\(\(\*value\), 2\);/s,
  );
  assert.match(
    nativeStringEmission.stdout,
    /borrowedLength\(&\(Z_STRING_LITERAL\("ok"\)\)\)/,
  );
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append\(&\(output\), Z_STRING_LITERAL\("he"\)\)/);
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append_bytes\(&\(output\), Z_STRING_LITERAL\("llo!"\), 0, 2\)/);
  assert.match(nativeStringEmission.stdout, /z_text_buffer_append_ascii\(&\(output\), 111\)/);
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
    /return \(Z_Reading\)\{\.tag = Z_ReadingTag_count, \.payload\.count = value\};/,
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
    /return \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_some, \.payload\.some = value\};/,
  );
  assert.match(
    optionEmission.stdout,
    /return \(Z___z_Option_i32\)\{\.tag = Z___z_Option_i32Tag_none\};/,
  );
  assert.match(
    optionEmission.stdout,
    /inspect\(Z___z_Option_i32 option\).*?switch \(_z_stage1_match_\d+\.tag\)/s,
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
    /discardResource\(void\).*?Z___z_Option_Resource held __attribute__\(\(unused\)\) = resource\(0\);.*?Z___z_Option_Resource_deinit\(&held\);/s,
  );
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
    /return \(Z___z_Result_i32_Problem\)\{\.tag = Z___z_Result_i32_ProblemTag_failure, \.payload\.failure = \(Z_Problem\)\{\.code = 7\}\};/,
  );
  assert.match(
    resultEmission.stdout,
    /return \(Z___z_Result_i32_Problem\)\{\.tag = Z___z_Result_i32_ProblemTag_success, \.payload\.success = 42\};/,
  );
  assert.match(
    resultEmission.stdout,
    /Z___z_Result_i32_Problem result = relay\(shouldFail\);.*?case Z___z_Result_i32_ProblemTag_success:.*?case Z___z_Result_i32_ProblemTag_failure:/s,
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
    /discardResult\(void\).*?Z___z_Result_Resource_Problem result __attribute__\(\(unused\)\) = loadResource\(false\);.*?Z___z_Result_Resource_Problem_deinit\(&result\);/s,
  );
  assert.match(
    resultEmission.stdout,
    /relay\(bool shouldFail\).*?_z_stage1_return_\d+ = load\(shouldFail\);\n  Z_Resource_deinit\(&audit\);\n  return _z_stage1_return_\d+;/s,
  );
  assert.match(
    resultEmission.stdout,
    /adjusted\(bool shouldFail\).*?_z_stage1_try_\d+ = load\(shouldFail\);.*?if \(_z_stage1_try_\d+\.tag == Z___z_Result_i32_ProblemTag_failure\).*?Z_Resource_deinit\(&audit\);\n    return _z_stage1_failure_\d+;.*?value = _z_stage1_try_\d+\.payload\.success;/s,
  );
  assert.match(
    resultEmission.stdout,
    /typedef struct Z___z_Result_void_Problem \{.*?union \{\n    Z_Problem failure;\n  \} payload;/s,
  );
  assert.match(
    resultEmission.stdout,
    /validate\(bool shouldFail\).*?return \(Z___z_Result_void_Problem\)\{\.tag = Z___z_Result_void_ProblemTag_failure, \.payload\.failure = .*?return \(Z___z_Result_void_Problem\)\{\.tag = Z___z_Result_void_ProblemTag_success\};/s,
  );
  assert.match(
    resultEmission.stdout,
    /relayVoid\(bool shouldFail\).*?_z_stage1_try_\d+ = validate\(shouldFail\);.*?if \(_z_stage1_try_\d+\.tag == Z___z_Result_void_ProblemTag_failure\).*?Z_Resource_deinit\(&audit\);\n    return _z_stage1_failure_\d+;.*?Z___z_Result_void_Problem _z_stage1_return_\d+ = .*?Z_Resource_deinit\(&audit\);/s,
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
    /inspect\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;\n  switch \(_z_stage1_match_\d+\.tag\).*?case Z_ResourceStateTag_ready: \{\n      Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;.*?_z_stage1_return_\d+ = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n      return/s,
  );
  const inspectStart = ownedEnumEmission.stdout.indexOf(
    "int32_t inspect(Z_ResourceState state) {",
  );
  const inspectDefinition = ownedEnumEmission.stdout.slice(
    inspectStart,
    ownedEnumEmission.stdout.indexOf(
      "int32_t inspectValue(Z_ResourceState state)",
      inspectStart,
    ),
  );
  assert.doesNotMatch(
    inspectDefinition,
    /Z_ResourceState_deinit\(&state\)/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectValue\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;.*?case Z_ResourceStateTag_ready: \{\n      Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;\n      int32_t _z_stage1_return_\d+ = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n      return/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectLocal\(Z_ResourceState state\) \{\n  int32_t value;\n  Z_ResourceState _z_stage1_match_\d+ = state;\n  switch \(_z_stage1_match_\d+\.tag\).*?value = _z_stage1_match_payload_\d+_\d+\.id;\n      Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);.*?return value;/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /selectResource\(Z_ResourceState state\).*?Z_ResourceState _z_stage1_match_\d+ = state;.*?case Z_ResourceStateTag_ready: \{\n      const Z_Resource __attribute__\(\(unused\)\) _z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\.ready;\n      return _z_stage1_match_payload_\d+_\d+;/s,
  );
  const ownedLocalStart = ownedEnumEmission.stdout.indexOf(
    "int32_t inspectOwnedLocal(void) {",
  );
  const ownedLocalDefinition = ownedEnumEmission.stdout.slice(
    ownedLocalStart,
    ownedEnumEmission.stdout.indexOf(
      "Z_ResourceState makeState(int32_t id)",
      ownedLocalStart,
    ),
  );
  assert.match(
    ownedLocalDefinition,
    /Z_Resource selected;[\s\S]*selected = _z_stage1_match_payload_\d+_\d+;[\s\S]*Z_Resource_deinit\(&selected\);/,
  );
  assert.doesNotMatch(
    ownedLocalDefinition,
    /Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\)/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectCall\(void\) \{\n  Z_ResourceState _z_stage1_match_\d+ = makeState\(42\);\n  switch \(_z_stage1_match_\d+\.tag\)/,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectReturnBlock\(Z_ResourceState state\).*?Z_Resource audit = .*?_z_stage1_return_\d+ = audit\.id;\n        Z_Resource_deinit\(&audit\);\n        Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n        return/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectLocalBlock\(Z_ResourceState state\) \{\n  int32_t value;.*?value = audit\.id;\n        Z_Resource_deinit\(&audit\);.*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);.*?return value;/s,
  );
  assert.match(
    ownedEnumEmission.stdout,
    /inspectIf\(Z_ResourceState state, bool inspectNow\) \{\n  bool _z_stage1_live_state = true;.*?_z_stage1_live_state = false;\n    Z_ResourceState _z_stage1_match_\d+ = state;\n    switch \(_z_stage1_match_\d+\.tag\).*?Z_Resource_deinit\(&_z_stage1_match_payload_\d+_\d+\);\n        if \(_z_stage1_live_state\) Z_ResourceState_deinit\(&state\);/s,
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
  assert.match(moveEmission.stdout, /int32_t relay\(Z_Resource resource\) \{\n  return inspect\(resource\);\n\}/);
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
    /moveLocal\(void\) \{\n  Z_Resource resource = .*?;\n  return inspect\(resource\);\n\}/s,
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
    /loopLocal\(int32_t limit\).*?Z_Resource_deinit\(&resource\);\n      continue;.*?Z_Resource_deinit\(&resource\);\n      break;.*?Z_Resource_deinit\(&resource\);\n  \}/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /replaceOwner\(int32_t next, bool replace\).*?_z_stage1_assignment_\d+ = \(Z_Resource\)\{\.id = z_stage1_checked_add_i32\(resource\.id, next\)\};\n    Z_Resource_deinit\(&resource\);\n    resource = _z_stage1_assignment_\d+;.*?Z_Resource_deinit\(&resource\);/s,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_Envelope_deinit\(Z_Envelope \*self\) \{\n  \(void\)self;\n  Z_Resource_deinit\(&self->resource\);\n\}/,
  );
  assert.match(
    cleanupFlowEmission.stdout,
    /static __attribute__\(\(unused\)\) void Z_AuditedEnvelope_deinit\(Z_AuditedEnvelope \*self\) \{\n  \(void\)self;\n  Z_Resource audit = \(Z_Resource\)\{\.id = self->resource\.id\};\n  record\(audit\.id\);\n  Z_Resource_deinit\(&audit\);\n  Z_Resource_deinit\(&self->resource\);\n\}/,
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
    /conditionalParameter\(Z_Resource resource, bool transfer\) \{\n  bool _z_stage1_live_resource = true;.*?\(_z_stage1_live_resource = false, resource\).*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);.*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/s,
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
    /inspect\(Z_Resource resource, int32_t limit\) \{\n  bool _z_stage1_live_resource = true;.*?\(_z_stage1_live_resource = false, resource\).*?if \(_z_stage1_live_resource\) Z_Resource_deinit\(&resource\);/s,
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
}, 20_000);

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
  const corpus: readonly {
    readonly entry: string;
    readonly arguments?: readonly string[];
  }[] = [
    { entry: "tests/fixtures/self-host-emit-input.zs" },
    { entry: "tests/fixtures/self-host-emit-control-flow.zs" },
    { entry: "tests/fixtures/self-host-emit-map.zs" },
    { entry: "tests/fixtures/self-host-emit-set.zs" },
    { entry: "tests/fixtures/self-host-emit-option.zs" },
    { entry: "tests/fixtures/self-host-emit-optional-field-direct.zs" },
    { entry: "tests/fixtures/self-host-emit-optional-chain.zs" },
    { entry: "tests/fixtures/self-host-emit-struct-spread.zs" },
    { entry: "tests/fixtures/self-host-emit-result.zs" },
    { entry: "examples/applications/source-inspector/lexer-smoke.zs" },
    {
      entry: "examples/applications/source-inspector/main.zs",
      arguments: [resolve(
        projectRoot,
        "examples/applications/source-inspector/lexer-smoke.zs",
      )],
    },
  ];
  const directory = mkdtempSync("/tmp/z-stage0-native-differential-");

  for (let index = 0; index < corpus.length; index += 1) {
    const testCase = corpus[index]!;
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
        "-Wall", "-Wextra", "-Werror", "-", "-o", stage0Executable,
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
        "-Wall", "-Wextra", "-Werror", "-", "-o", nativeExecutable,
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
      { encoding: "utf8" },
    );
    const nativeRun = spawnSync(
      nativeExecutable,
      programArguments,
      { encoding: "utf8" },
    );
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
  }
}, 60_000);

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
  const foreignAdapter = resolve(
    directory,
    process.platform === "win32"
      ? "z-foreign-adapter.exe"
      : "z-foreign-adapter",
  );
  assert.equal(existsSync(foreignAdapter), true);

  const checking = spawnSync(
    executable,
    ["check", resolve(projectRoot, "examples/language/modules/main.zs")],
    { encoding: "utf8" },
  );
  assert.equal(checking.status, 0, checking.stderr);
    assert.match(checking.stdout, /checked 4 Z modules/);

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
    ["test", resolve(projectRoot, "examples/language/modules/main.zs")],
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

  rmSync(directory, { recursive: true, force: true });
}, 60_000);

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
    namedTypes: new Map(),
    constants: new Map(),
    objectTypes: new Map(),
    interfaces: new Map(),
    protocols: new Map(),
    framework: null,
    objectiveC: false,
    cPlusPlus: false,
  };
  const encoded = encodeForeignFunctionDeclarationStream(declarations);
  assert.match(encoded, /^ZFDCL0000000000000003\nM/);
  assert.throws(
    () => encodeForeignFunctionDeclarationStream({
      ...declarations,
      namedTypes: new Map([["unsupported", {} as never]]),
    }),
    /supports function modules with typed constants and nominal enums/,
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
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
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

  const contractFixture = resolve(
    projectRoot,
    "tests/fixtures/self-host-foreign-contracts.zs",
  );
  const contractEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", contractFixture],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
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
  assert.equal(invalidForeignEnum.status, 3);

  const uncontractedForeignFunctionPath = resolve(
    directory,
    "uncontracted-foreign-function.zs",
  );
  writeFileSync(
    uncontractedForeignFunctionPath,
    [
      'import { z_foreign_measure as measure } from "foreign-functions-only.h";',
      "function main(): i32 {",
      '  measure(1, "label");',
      "  return 0;",
      "}",
      "",
    ].join("\n"),
  );
  const uncontractedForeignFunction = spawnSync(
    contractExecutable,
    [
      clangPath,
      contractPath,
      uncontractedForeignFunctionPath,
      emittedForeignPath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(uncontractedForeignFunction.status, 3);

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

  assert.throws(
    () => resolveForeignFunctionDeclarationStreams(
      [{
        ...foreignImport,
        header: "geometry.h",
      }],
      fixture,
      [resolve(projectRoot, "tests/fixtures")],
    ),
    /supports function modules with typed constants and nominal enums/,
  );

  const truncatedPath = resolve(directory, "truncated.zfdcl");
  writeFileSync(truncatedPath, encoded.slice(0, -2));
  const truncated = spawnSync(executable, [truncatedPath], { encoding: "utf8" });
  assert.equal(truncated.status, 3, truncated.stderr);
}, 15_000);

test("compiles a multi-module Z application through the standalone native driver", () => {
  const driverSource = resolve(projectRoot, "compiler/driver/main.zs");
  const driverEmission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", driverSource],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(driverEmission.status, 0, driverEmission.stderr);
  assert.match(driverEmission.stdout, /Z___z_Result_void_String loadModule\(/);
  assert.match(driverEmission.stdout, /Z___z_Result_String_String emitModulesC\(/);
  assert.match(driverEmission.stdout, /z_stage1_fs_lock\(/);
  assert.match(driverEmission.stdout, /z_stage1_fs_replace\(/);
  assert.match(driverEmission.stdout, /Z_FsLock_deinit\(&\(cacheLock\)\)/);
  assert.match(driverEmission.stdout, /z_stage1_fs_real_path\(/);
  assert.match(driverEmission.stdout, /Z_STRING_LITERAL\("-O2"\)/);
  assert.match(driverEmission.stdout, /Z_STRING_LITERAL\("-DNDEBUG"\)/);

  const directory = mkdtempSync("/tmp/z-self-host-native-compiler-");
  const driver = resolve(directory, "z-native");
  const driverCompilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-O0", "-Wall", "-Wextra", "-Werror", "-", "-o", driver],
    { encoding: "utf8", input: driverEmission.stdout },
  );
  assert.equal(driverCompilation.status, 0, driverCompilation.stderr);
  const foreignAdapterEnvironment = {
    ...process.env,
    PATH: `${resolve(projectRoot, "compiler/bin")}${delimiter}${process.env.PATH ?? ""}`,
  };
  const contentHashRun = spawnSync(
    driver,
    [
      "run",
      resolve(projectRoot, "tests/fixtures/self-host-content-hash.zs"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(contentHashRun.status, 0, contentHashRun.stderr);

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
    /decoded 5 foreign functions from clang/,
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
    /normalized 4 foreign function contracts for foreign-functions-only\.h/,
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
    /unsupported-native-contract\.zd:2:\d+: error: function result facts are not implemented/,
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
    /incomplete-native-status\.zd:2:\d+: error: a native status contract requires at least one success value/,
  );

  const recursiveDriver = resolve(directory, "z-native-generation-2");
  const recursiveCompilation = spawnSync(
    driver,
    ["build", driverSource, recursiveDriver],
    { encoding: "utf8" },
  );
  assert.equal(recursiveCompilation.status, 0, recursiveCompilation.stderr);
  assert.match(recursiveCompilation.stdout, /compiled 37 Z modules/);
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
    "sum=42 answer=42 even=true point=(21,22) status=1\n",
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

  const invalidNativeExport = resolve(
    directory,
    "invalid-native-export.zs",
  );
  writeFileSync(
    invalidNativeExport,
    [
      "export c function z_invalid(value: String): String {",
      "  return value;",
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
    /C export parameter "value" has unsupported boundary type "String"/,
  );

  const runtimeCollisionProject = resolve(directory, "runtime-collision");
  mkdirSync(runtimeCollisionProject);
  writeFileSync(
    resolve(runtimeCollisionProject, "library.zs"),
    "export c function runtime_collision_runtime_shutdown(): i32 { return 0; }\n",
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
    { encoding: "utf8" },
  );
  assert.equal(foreignImportCheck.status, 1);
  assert.match(
    foreignImportCheck.stderr,
    /:1:1: error: native foreign import "stdint\.h" requires an adjacent \.zd contract\n1 \| import native from "stdint\.h";\n  \| \^/,
  );

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
    ),
  );
  writeFileSync(
    foreignProjectHeader,
    '#include "foreign-dependency.h"\n'
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
    /:1:1: error: could not launch z-foreign-adapter for "foreign-functions-only\.h":/,
  );
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

  const headerOnlyProject = resolve(directory, "header-only-project");
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
  const recursiveChecking = spawnSync(
    recursiveDriver,
    ["check", applicationSource],
    { encoding: "utf8" },
  );
  assert.equal(recursiveChecking.status, 0, recursiveChecking.stderr);
  assert.match(recursiveChecking.stdout, /checked 2 Z modules/);

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

  const unsupportedConversionSource = resolve(
    directory,
    "native-floating-conversion.zs",
  );
  writeFileSync(
    unsupportedConversionSource,
    "function main(): i32 { const value = f64(1); return 0; }\n",
  );
  const unsupportedConversionCheck = spawnSync(
    driver,
    ["check", unsupportedConversionSource],
    { encoding: "utf8" },
  );
  assert.equal(unsupportedConversionCheck.status, 1);
  assert.match(
    unsupportedConversionCheck.stderr,
    /numeric conversion is not available in the integer-only conversion tier/,
  );

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
}, 90_000);

test("lowers the complete native frontend graph to C", () => {
  const frontend = resolve(projectRoot, "compiler/frontend/parser-library.zs");
  const emission = spawnSync(
    process.execPath,
    [cli, "self-host-emit", frontend],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(emission.status, 0, emission.stderr);
  assert.match(emission.stdout, /void appendCStringLiteral\(Z_String \*output, const Z_String \*value\);/);
  assert.match(
    emission.stdout,
    /Z___z_Result_String_String emitLoweredC\(const Z_LoweredProgram \*program, const Z_String \*embeddedRuntimeName, const Z_String \*runtimeInitializerName, bool runtimeInitializerRequiresMain\);/,
  );
  assert.match(
    emission.stdout,
    /Z___z_Result_Stage1ModuleGraphResult_String resolveModuleGraphPhase\(const Z_String \*entryPath, const Z_String \*batch\);/,
  );
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
}, 15_000);

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
  assert.match(ordinaryCheck.stdout, /native frontend hybrid exports 29 expression type contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ function, \d+ method, and \d+ constructor stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ aggregate, \d+ field, and \d+ enum-variant stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ explicit type-use stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ inferred local binding stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes 29 expression stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ function, \d+ method, and \d+ constructor native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ aggregate, \d+ field, and \d+ enum-variant native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ explicit type-use native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 3 inferred local binding native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 29 expression native-authoritative contracts/);
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
    "struct Resource {\n"
      + "  id: i32;\n"
      + "  function merge(inout this, other: Resource): void {}\n"
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

  const encoded = encodeStage1ModuleBatch([{ path: "/a.zs", source: "é" }]);
  assert.equal(encoded.byteLength, 32 + Buffer.byteLength("/a.zs") + Buffer.byteLength("é"));
  const callEvidenceGraph = decodeStage1ModuleGraphStream(
    "entry\t0000000000000000\n"
    + "module\t2f612e7a73\n"
    + "symbol\t0000000000000000\tfunction\t6964656e74697479\t1\t0\t-\t6964656e74697479\t0000000000000000\t0000000000000001\t0000000000000001\n"
    + "signature\t0000000000000000\t0000000000000000\t0\t54\t\t\t0000000000000001\t0000000000000001\t54\t76616c7565\t54\n"
    + "callResolution\t0000000000000000\t000000000000002a\t0000000000000002\t000000000000000a\t0000000000000000\t0000000000000000\t66756e6374696f6e\t6964656e74697479\t0\t\t693332\t\t0000000000000001\t0000000000000001\t54\t693332\t76616c7565\t693332\n"
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
            constructorSignature: {
              asynchronous: false,
              executorAffinity: "thread.main",
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
      constructorSignature: {
        asynchronous: false,
        executorAffinity: "thread.main",
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
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t\t0000000000000000\t0000000000000000\n"
      + "order\t0000000000000000\n",
    ),
    /function signature appeared before its symbol/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tfunction\t76616c7565\t1\t0\t-\t76616c7565\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
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
      + "constructorSignature\t0000000000000000\t0000000000000000\t0\t536563726574\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
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
      + "methodSignature\t0000000000000000\t0000000000000000\t72656164\t0\t7075626c6963\t626164\t0\t693332\t\t\t0000000000000000\t0000000000000000\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 method receiver mode/,
  );
}, 10_000);

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
}, 30_000);

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
  assert.equal(observedBindings, "10");
  assert.equal(authoritativeBindings, observedBindings);
  assert.equal(observedExpressions, "80");
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
  assert.equal(observedExpressions, "18");
  assert.equal(authoritativeExpressions, observedExpressions);
});

test("defers unavailable foreign ABI semantics without inventing native diagnostics", () => {
  const cases = [
    "examples/interop/c/apple-groundwork.zs",
    "examples/interop/c/foreign-types.zs",
    "examples/interop/c/selective-declarations.zs",
    "examples/interop/objc/desktop-ownership/main.zs",
    "examples/interop/objc/target-action.zs",
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
}, 30_000);

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
    }

    struct Pair {
      first: i32;
      second: i32;
    }

    function main(): i32 {
      const baseline = Pair({ first: 20, second: 22 });
      const plain = Pair({ ...baseline, first: 21 });
      const copied = Pair({ copy ...baseline, second: 23 });
      const copySource = Label({ value: "ready" });
      const copiedLabel = Label({ copy ...copySource });
      const label = Label({ value: "ready" });
      const moved = Label({ move ...label });
      return plain.first
        + copied.second
        + i32(copiedLabel.value.byteLength)
        + i32(moved.value.byteLength)
        - 54;
    }
  `);
  const emitted = spawnSync(
    process.execPath,
    [cli, "self-host-emit", executableSource],
    { encoding: "utf8" },
  );
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.match(emitted.stdout, /\.first = 21, \.second = baseline\.second/);
  assert.match(emitted.stdout, /\.second = 23, \.first = baseline\.first/);
  assert.match(emitted.stdout, /\.value = z_string_copy\(copySource\.value\)/);
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
    struct Bundle {
      retained: String;
      replaced: String;
    }

    function main(): i32 {
      const source = Bundle({ retained: "kept", replaced: "old" });
      const spread = Bundle({ move ...source, replaced: "new" });
      return i32(spread.retained.byteLength) - 4;
    }
  `);
  const boundary = spawnSync(
    process.execPath,
    [cli, "self-host-emit", cleanupBoundary],
    { encoding: "utf8" },
  );
  assert.equal(boundary.status, 1, boundary.stdout);
  assert.match(
    boundary.stderr,
    /cannot clean an overridden ownership-bearing field "replaced" yet/,
  );
}, 90_000);
