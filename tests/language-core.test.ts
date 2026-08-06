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

test("checks floating-point widths and integer-only bitwise operators", () => {
  const mismatch = `
    function accept(value: f32): void {}
    function main(): i32 {
      const value: f64 = 1.25;
      accept(value);
      return 0;
    }
  `;
  assert.throws(() => compileToC(mismatch, "float-width.zs"), /expected f32, found f64/);

  const floatToInteger = `
    function main(): i32 {
      const value: i32 = 1.5;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(floatToInteger, "float-to-integer.zs"),
    /floating-point literal 1\.5 cannot initialize i32/,
  );

  const floatMask = `
    function main(): i32 {
      const mask = 1.0 | 2.0;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(floatMask, "float-mask.zs"),
    /operator "\|" requires matching integer operands/,
  );

  const variadicFloat = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.printf("%.1f", 1.5);
      return 0;
    }
  `;
  assert.match(compileToC(variadicFloat, "variadic-float.zs"), /printf\("%\.1f", 1\.5\)/);
});

test("accepts null only at explicitly nullable foreign boundaries", () => {
  const nullable = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      handles.z_test_optional(null);
      return 0;
    }
  `;
  assert.match(
    compileToC(nullable, resolve(projectRoot, "nullable-null.zs")),
    /z_test_optional\(NULL\);/,
  );

  const nonnull = nullable.replace("z_test_optional", "z_test_use");
  assert.throws(
    () => compileToC(nonnull, resolve(projectRoot, "nonnull-null.zs")),
    /C function "z_test_use" requires a non-null ZTestHandle \*/,
  );

  const inferred = `
    function main(): i32 {
      const absent = null;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferred, "inferred-null.zs"),
    /cannot infer a type from null; provide an explicitly nullable type/,
  );
});

test("checks imported C record fields and enum arguments in Z", () => {
  const missingField = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint({ x: 1 });
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(missingField, resolve(projectRoot, "foreign-record-fields.zs")),
    /missing field "y" when constructing "geometry\.ZPoint"/,
  );

  const wrongEnum = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint({ x: 1, y: 2 });
      const moved = geometry.z_translate(point, 1, 3);
      return moved.x;
    }
  `;
  assert.throws(
    () => compileToC(wrongEnum, resolve(projectRoot, "foreign-enum-argument.zs")),
    /expected geometry\.ZDirection, found i32/,
  );
});

test("borrows and explicitly mutates imported C records through safe pointer modes", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-pointers.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "before=10 after=11 point=5,6\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /z_offset\(&\(point\), 3, 4\);/);
  assert.match(generated, /z_read\(&\(point\)\)/);
  assert.match(generated, /z_reset\(&\(point\)\);/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/geometry.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const offsetFunction = declarationSource.indexOf("z_offset") + 2;
  assert.match(
    hover(declarationSource, declarationFile, offsetFunction)?.contents.value ?? "",
    /z_offset\(point: ZPoint \*, dx: i32, dy: i32\): void/,
  );
  const pointParameter = declarationSource.indexOf("point: _") + 2;
  assert.match(
    hover(declarationSource, declarationFile, pointParameter)?.contents.value ?? "",
    /inout point: ZPoint \*/,
  );
  const completionSource = declarationSource.replace("z_reset", "z_res");
  const completionOffset = completionSource.indexOf("z_res") + "z_res".length;
  assert.equal(
    completions(completionSource, declarationFile, completionOffset)
      .find((item) => item.label === "z_reset")?.kind,
    3,
  );
});

test("initializes imported C union storage through out and confines scalar member assertions", () => {
  const example = resolve(projectRoot, "examples/interop/c/native-union.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /ZNativeEvent event;/);
  assert.match(artifact.source, /z_native_poll\(&\(event\)\)/);
  assert.match(artifact.source, /const int32_t eventType = \(event\)\.type;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const directRead = `
    import native from "tests/fixtures/native-union.h";
    function main(): i32 {
      let event;
      native.z_native_poll(out event);
      return event.type;
    }
  `;
  assert.throws(
    () => compileToNative(directRead, resolve(projectRoot, "native-union-direct-read.zs")),
    /native union member "type" requires an unsafe boundary/,
  );

  const construction = `
    import native from "tests/fixtures/native-union.h";
    function main(): i32 {
      const event = native.ZNativeEvent({ type: 42 });
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(construction, resolve(projectRoot, "native-union-construction.zs")),
    /native union "native\.ZNativeEvent" cannot be constructed as a Z struct/,
  );

  const eventOffset = source.indexOf("event;") + 1;
  assert.match(hover(source, example, eventOffset)?.contents.value ?? "", /event: native\.ZNativeEvent/);
  const memberSource = source.replace("event.type", "event.ty");
  const memberOffset = memberSource.indexOf("event.ty") + "event.ty".length;
  assert.ok(completions(memberSource, example, memberOffset).some((item) => item.label === "type"));
});

test("projects scalar C pointers through in, inout, and out capabilities", () => {
  const example = resolve(projectRoot, "examples/interop/c/scalar-pointers.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /float x;/);
  assert.match(generated, /float y;/);
  assert.match(generated, /z_mouse_state\(&\(x\), &\(y\)\)/);
  assert.match(generated, /z_increment_float\(&\(x\)\)/);
  assert.match(generated, /z_read_float\(&\(x\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const declarationFile = resolve(projectRoot, "tests/fixtures/scalar-pointers.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const functionOffset = declarationSource.indexOf("z_mouse_state") + 2;
  assert.match(
    hover(declarationSource, declarationFile, functionOffset)?.contents.value ?? "",
    /z_mouse_state\(out x: f32, out y: f32\): u32/,
  );
  const outOffset = source.indexOf("out x") + 1;
  assert.match(hover(source, example, outOffset)?.contents.value ?? "", /out: f32/);
  const xOffset = source.indexOf("x;", source.indexOf("let x")) + 1;
  assert.match(hover(source, example, xOffset)?.contents.value ?? "", /x: f32/);
  const invalidDeclaration = declarationSource.replace("in value: _", "out value: _");
  assert.match(
    diagnostics(invalidDeclaration, declarationFile)[0]?.message ?? "",
    /out scalar parameter "value" requires a mutable native pointer/,
  );

  const missingOut = source.replace("out x", "inout x");
  assert.throws(
    () => compileToC(missingOut, example),
    /expects out x, found inout x/,
  );
  const uninitializedRead = source.replace(
    "const buttons = native.z_mouse_state(out x, out y);",
    "const observedBeforeInitialization = native.z_read_float(x);\n  const buttons = native.z_mouse_state(out x, out y);",
  );
  assert.throws(
    () => compileToC(uninitializedRead, example),
    /uninitialized value "x"|must be initialized/,
  );
});

test("requires exact pointer modes and mutable storage at imported record boundaries", () => {
  const uninitializedOutput = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point: geometry.ZPoint;
      geometry.z_reset(out point);
      return point.x;
    }
  `;
  const uninitializedOutputC = compileToC(
    uninitializedOutput,
    resolve(projectRoot, "foreign-record-uninitialized-out.zs"),
  );
  assert.match(uninitializedOutputC, /ZPoint point;/);
  assert.match(uninitializedOutputC, /z_reset\(&\(point\)\);/);

  const immutable = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint({ x: 1, y: 2 });
      geometry.z_reset(out point);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, resolve(projectRoot, "foreign-record-const.zs")),
    /out argument "point" requires a mutable let binding/,
  );

  const missingMode = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point = geometry.ZPoint({ x: 1, y: 2 });
      geometry.z_offset(point, 3, 4);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(missingMode, resolve(projectRoot, "foreign-record-mode.zs")),
    /requires inout <mutable binding> for parameter 1/,
  );

  const wrongMode = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      let point = geometry.ZPoint({ x: 1, y: 2 });
      geometry.z_reset(inout point);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(wrongMode, resolve(projectRoot, "foreign-record-wrong-mode.zs")),
    /expects out point, found inout point/,
  );

  const escapedModifier = `
    function use(value: i32): void {}
    function main(): i32 {
      let value = 1;
      use(out value);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(escapedModifier, "escaped-out.zs"),
    /out is not valid for an owned value parameter/,
  );
});

test("requires nullable C handles to be checked before borrowing", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-nullable.txt", "w");
      stdio.fputs("unsafe", file);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-nullability.zs"),
    /nullable FILE \* must be checked before passing it to "fputs"/,
  );
});

test("does not treat mutable C strings as safe cstrings", () => {
  const supportedSource = `
    import fixture from "tests/fixtures/foreign-types.h";
    function main(): i32 {
      return fixture.z_test_bool(true);
    }
  `;
  assert.match(
    compileToC(supportedSource, resolve(projectRoot, "foreign-boolean.zs")),
    /return z_test_bool\(true\);/,
  );

  const source = `
    import fixture from "tests/fixtures/foreign-types.h";
    function main(): i32 {
      return fixture.z_test_mutate("immutable");
    }
  `;
  assert.throws(
    () => compileToC(source, resolve(projectRoot, "mutable-cstring.zs")),
    /C function "z_test_mutate" uses unsupported type "char \*"/,
  );
});

test("reports headers Clang cannot import", () => {
  const source = `
    import missing from "z_header_that_does_not_exist.h";
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "missing-header.zs"),
    /could not import header "z_header_that_does_not_exist\.h"/,
  );
});

test("reports source locations for parser errors", () => {
  assert.throws(
    () => compileToC("function main(: i32 {}", "broken.zs"),
    /broken\.zs:1:15: error:/,
  );
});

test("rejects unknown names during semantic analysis", () => {
  const source = `
    function main(): i32 {
      return missing;
    }
  `;
  assert.throws(
    () => compileToC(source, "unknown.zs"),
    /unknown\.zs:3:14: error: unknown name "missing"/,
  );
});

test("checks Z function arguments", () => {
  const source = `
    function identity(value: i32): i32 {
      return value;
    }
    function main(): i32 {
      return identity("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "arguments.zs"),
    /arguments\.zs:6:23: error: expected i32, found String/,
  );
});

test("infers primitive local types for C emission", () => {
  const source = `
    function answer(): i32 {
      return 42;
    }
    function main(): i32 {
      const value = answer();
      return value;
    }
  `;
  const generated = compileToC(source, "inference.zs");
  assert.match(generated, /const int32_t value = answer\(\);/);
});

test("compiles boolean expressions and path-complete if statements", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/control-flow.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "disabled=0\nordinary=1\nspecial=2\n");

  const enabled = source.indexOf("enabled: boolean") + 1;
  assert.match(hover(source, example, enabled)?.contents.value ?? "", /enabled: boolean/);

  const incomplete = "function ready(value: boole";
  const typeItems = completions(incomplete, "boolean-completion.zs", incomplete.length);
  assert.equal(typeItems.some((item) => item.label === "boolean"), true);
  assert.equal(typeItems.some((item) => item.label === "bool"), false);

  const removedSpelling = `function ready(value: bool): boolean { return value; } function main(): i32 { return 0; }`;
  assert.throws(() => compileToC(removedSpelling, "removed-bool.zs"), /unknown type "bool"/);
});

test("supports single-statement if, else-if, else, and void guards", () => {
  const source = `
    function choose(value: i32): i32 {
      if (value > 0) return 1;
      else if (value < 0) return -1;
      else return 0;
    }
    function stopEarly(stop: boolean): void {
      if (stop) return;
    }
    function nested(first: boolean, second: boolean): i32 {
      if (first) if (second) return 1; else return 2;
      return 3;
    }
    function main(): i32 {
      stopEarly(true);
      return choose(0) + nested(false, false) - 3;
    }
  `;
  const generated = compileToC(source, "single-statement-if.zs");
  assert.match(generated, /if \(value > 0\) \{\n\s+return 1;/);
  assert.match(generated, /else if \(value < 0\)/);
  assert.match(generated, /if \(stop\) \{\n\s+return;/);
  assert.match(generated, /if \(first\) \{[\s\S]*if \(second\)/);
});

test("compiles ternaries and value-producing if expressions with select", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/conditional-expressions.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "exact=yes\nselected=42\nten=ten\nlarge=large\nsmall=small\n");
});

test("requires matching branch types in conditional expressions", () => {
  const source = `
    function main(): i32 {
      const value = if (true) {
        select 42;
      } else {
        select "wrong";
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(source, "if-expression-types.zs"),
    /if-expression-types\.zs:5:14: error: if branch produces String, but the other branch produces i32/,
  );
});

test("requires an else branch and explicit select in statement-bodied if expressions", () => {
  const missingElse = `
    function main(): i32 {
      const value = if (true) { select 42; };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingElse, "if-expression-else.zs"),
    /if-expression-else\.zs:3:45: error: expected `else` in a value-producing `if`, found ";"/,
  );

  const missingSelect = `
    function main(): i32 {
      const value = if (true) {
        const answer = 42;
      } else {
        select 0;
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingSelect, "if-expression-select.zs"),
    /if-expression-select\.zs:4:9: error: a value-producing block must produce a value with an expression or `select`/,
  );
});

test("runs non-escaping arrow closures with inferred borrow, mutation, and move captures", () => {
  const example = resolve(projectRoot, "examples/language/basics/closures.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "add=42\ntotal=20,42\nsnapshot=15 seed=100\ntarget=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /__z_closure_call_/);
  assert.match(generated, /const int32_t \*offset/);
  assert.match(generated, /int32_t \*total/);
});

test("forwards captures through nested closures without relay bindings", () => {
  const source = `
    function read(in operation: () => i32): i32 {
      return operation();
    }

    function run(in operation: () => void): void {
      operation();
    }

    function main(): i32 {
      const base = 40;
      let total = 40;
      const forwarded = read(() => read(() => base + 2));
      run(() => {
        run(() => {
          total = total + 2;
        });
      });
      const shadowed = read(() => {
        const base = 1;
        return read(() => base + 1);
      });
      return forwarded - 42 + total - 42 + shadowed - 2;
    }
  `;
  const generated = compileToC(source, "nested-closure-captures.zs");
  assert.ok((generated.match(/const int32_t \*base/g)?.length ?? 0) >= 2);
  assert.ok((generated.match(/int32_t \*total/g)?.length ?? 0) >= 2);
  const nestedBaseOffset = source.indexOf("base + 2") + 1;
  assert.match(
    hover(source, "nested-closure-captures.zs", nestedBaseOffset)?.contents.value ?? "",
    /base: i32/,
  );
  const nestedBasePosition = positionForOffset(source, nestedBaseOffset - 1);
  assert.ok(decodeSemanticTokens(
    semanticTokens(source, "nested-closure-captures.zs").data,
  ).some((token) => (
    token.line === nestedBasePosition.line
    && token.character === nestedBasePosition.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));

  const directory = mkdtempSync("/tmp/z-nested-closure-captures-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const immutable = source.replace("let total = 40;", "const total = 40;");
  const immutableDiagnostic = diagnostics(immutable, "nested-closure-immutable.zs")[0];
  assert.equal(immutableDiagnostic.code, "Z0210");
  assert.match(immutableDiagnostic.message, /closure cannot mutate immutable capture "total"/);
});

test("checks closure parameters, block return types, and immutable captures", () => {
  const blockInference = `
    function main(): i32 {
      const closure = (value: i32) => { return value; };
      return closure(42);
    }
  `;
  assert.throws(
    () => compileToC(blockInference, "closure-block-type.zs"),
    /closure-block-type\.zs:3:23: error: a block-bodied closure requires an explicit or contextual return type/,
  );

  const immutableCapture = `
    function main(): i32 {
      const value = 41;
      const increment = (): i32 => {
        value = value + 1;
        return value;
      };
      return increment();
    }
  `;
  assert.throws(
    () => compileToC(immutableCapture, "closure-const.zs"),
    /closure-const\.zs:5:9: error: closure cannot mutate immutable capture "value"/,
  );

  const wrongArgument = `
    function main(): i32 {
      const identity = (value: i32): i32 => value;
      return identity("wrong");
    }
  `;
  assert.throws(
    () => compileToC(wrongArgument, "closure-argument.zs"),
    /closure-argument\.zs:4:23: error: expected i32, found String/,
  );
});

test("contextually infers closure parameter and result types from function values", () => {
  const source = `
    function main(): i32 {
      const double: (value: i32) => i32 = (value) => value * 2;
      const sum: (left: i32, right: i32) => i32 = (left, right) => {
        return left + right;
      };
      let total = 40;
      const increment: (inout value: i32) => void = (inout value) => {
        value = value + 2;
      };
      increment(inout total);
      return double(10) + sum(total, 0);
    }
  `;
  const generated = compileToC(source, "contextual-closure.zs");
  assert.match(generated, /__z_closure_call_/);
  const parameter = source.indexOf("(value) =>") + 2;
  assert.match(hover(source, "contextual-closure.zs", parameter)?.contents.value ?? "", /value: i32/);

  const missingContext = `
    function main(): i32 {
      const identity = (value) => value;
      return identity(42);
    }
  `;
  const inferenceDiagnostic = diagnostics(missingContext, "closure-inference.zs")[0];
  assert.equal(inferenceDiagnostic.code, "Z0215");
  assert.match(inferenceDiagnostic.message, /cannot infer the type of closure parameter "value"/);

  const implicitCapability = source.replace("(inout value) =>", "(value) =>");
  assert.throws(
    () => compileToC(implicitCapability, "closure-capability.zs"),
    /closure parameter "value" requires the `inout` capability from its destination function type/,
  );
});

test("passes contextual inline closures through borrowed and owned function parameters", () => {
  const source = `
    struct Resource {
      value: i32;
      deinit {}
    }

    function apply(in operation: (value: i32) => i32, value: i32): i32 {
      return operation(value);
    }

    function consume(operation: (value: i32) => i32, value: i32): i32 {
      return operation(value);
    }

    function mutate(in operation: (inout value: i32) => void, inout value: i32): void {
      operation(inout value);
    }

    function invoke(in operation: () => void): void {
      operation();
    }

    function inspect(in operation: () => i32): i32 {
      return operation();
    }

    function main(): i32 {
      let target = 40;
      mutate((inout value) => { value = value + 2; }, inout target);
      const offset = 1;
      const borrowed = apply((value) => value + offset, 41);
      let capturedTarget = 40;
      invoke(() => { capturedTarget = capturedTarget + 2; });
      const resource = Resource({ value: 42 });
      const inspected = inspect(() => resource.value);
      const owned = consume(move (value) => value + offset, 41);
      if (target == 42 && borrowed == 42 && capturedTarget == 42 && inspected == resource.value && owned == 42) { return 0; }
      return 1;
    }
  `;
  const generated = compileToC(source, "inline-closures.zs");
  assert.match(generated, /Z_ClosureEnv_/);
  assert.match(generated, /calloc\(1, sizeof\(Z_ClosureEnv_/);
  assert.match(generated, /_z_borrowed_closure_environment_/);
  assert.match(generated, /_z_argument_/);

  const parameter = source.indexOf("(value) => value + offset") + 2;
  assert.match(hover(source, "inline-closures.zs", parameter)?.contents.value ?? "", /value: i32/);
  const completionSource = source.replace("value + offset, 41", "val + offset, 41");
  const completionOffset = completionSource.indexOf("val + offset, 41") + 3;
  assert.match(
    completions(completionSource, "inline-closures.zs", completionOffset).find((item) => item.label === "value")?.detail ?? "",
    /value: i32/,
  );

  const borrowedCapture = source.replace("move (value) => value + offset", "(value) => value + offset");
  const captureDiagnostic = diagnostics(borrowedCapture, "inline-borrowed-capture.zs")[0];
  assert.equal(captureDiagnostic.code, "Z0212");
  assert.match(captureDiagnostic.message, /borrowed capturing closure cannot become a function value/);

  const missingCapability = source.replace("(inout value) =>", "(value) =>");
  assert.throws(
    () => compileToC(missingCapability, "inline-capability.zs"),
    /closure parameter "value" requires the `inout` capability from its destination function type/,
  );

  const directory = mkdtempSync("/tmp/z-inline-closures-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("requires an explicit function type for cleanup-bearing move captures", () => {
  const source = `
    struct Resource {
      value: i32;
      deinit {}
    }
    function main(): i32 {
      const resource = Resource({ value: 42 });
      const consume = move (): i32 => resource.value;
      return consume();
    }
  `;
  assert.throws(
    () => compileToC(source, "closure-owned-move.zs"),
    /closure-owned-move\.zs:8:39: error: move-capturing cleanup-bearing Resource requires an explicitly typed owned closure/,
  );
});

test("returns, copies, shares, and deterministically destroys owned closure environments", () => {
  const example = resolve(projectRoot, "examples/language/ownership/owned-closures.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /typedef struct Z_ClosureEnv_[0-9]+/);
  assert.match(generated, /environment->refcount \+= 1/);
  assert.match(generated, /environment->refcount -= 1/);
  assert.match(generated, /Z_Resource_deinit\(&\(environment->resource\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=41,42\nresource=42\ndeferred=42\ndrop=42\n");

  const useAfterCapture = `
    struct Resource { value: i32; deinit {} }
    function main(): i32 {
      const resource = Resource({ value: 42 });
      const read: () => i32 = move (): i32 => resource.value;
      return resource.value;
    }
  `;
  assert.throws(
    () => compileToC(useAfterCapture, "owned-closure-move.zs"),
    /use of moved value "resource"/,
  );
});

test("exposes closure bindings and parameters to editor services", () => {
  const source = `
    function main(): i32 {
      const offset = 1;
      const add = (value: i32): i32 => value + offset;
      const answer = add(41);
      return answer;
    }
  `;
  const addUse = source.indexOf("add(41)") + 1;
  assert.match(hover(source, "closure-editor.zs", addUse)?.contents.value ?? "", /add: \(value: i32\) => i32/);
  const parameter = source.indexOf("value: i32") + 1;
  assert.match(hover(source, "closure-editor.zs", parameter)?.contents.value ?? "", /value: i32/);
  const items = completions(source.replace("add(41)", "ad"), "closure-editor.zs", source.indexOf("add(41)") + 2);
  assert.equal(items.find((item) => item.label === "add")?.detail, "const add: (value: i32) => i32");
});

test("stores and calls explicitly typed non-capturing function values", () => {
  const source = `
    function add(left: i32, right: i32): i32 { return left + right; }
    function subtract(left: i32, right: i32): i32 { return left - right; }

    function apply(operation: (first: i32, second: i32) => i32, left: i32, right: i32): i32 {
      return operation(left, right);
    }

    function choose(addition: boolean): (left: i32, right: i32) => i32 {
      if (addition) { return add; }
      return subtract;
    }

    struct Calculator {
      operation: (left: i32, right: i32) => i32;
    }

    function main(): i32 {
      const operation: (x: i32, y: i32) => i32 = add;
      const inferred = subtract;
      const double: (value: i32) => i32 = (value: i32): i32 => value * 2;
      const selected = choose(false);
      const calculator = Calculator({ operation: add });
      if (apply(operation, 20, 22) == 42 && inferred(50, 8) == 42 && double(21) == 42 && selected(50, 8) == 42 && calculator.operation(20, 22) == 42) {
        return 0;
      }
      return 1;
    }
  `;
  const generated = compileToC(source, "function-values.zs");
  assert.match(generated, /struct Z_Function_[0-9a-f]+ \{[\s\S]*int32_t \(\*call\)\(void \*context, int32_t (?:first|x|left), int32_t (?:second|y|right)\)/);
  assert.match(generated, /operation = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_function_adapter_add/);
  assert.match(generated, /inferred = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_function_adapter_subtract/);
  assert.match(generated, /z_double = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_closure_call_[0-9]+_adapter/);
  assert.match(generated, /= \(operation\)\.call\(\(operation\)\.context, left, right\);/);
  assert.match(generated, /\(\(calculator\)\.operation\)\.call\(\(\(calculator\)\.operation\)\.context, 20, 22\)/);

  const operationUse = source.indexOf("operation(left") + 1;
  assert.match(hover(source, "function-values.zs", operationUse)?.contents.value ?? "", /operation: \(first: i32, second: i32\) => i32/);
  const completionSource = source.replace("apply(operation, 20", "apply(oper, 20");
  const completionOffset = completionSource.indexOf("apply(oper, 20") + "apply(oper".length;
  assert.match(
    completions(completionSource, "function-values.zs", completionOffset).find((item) => item.label === "operation")?.detail ?? "",
    /\(first: i32, second: i32\) => i32/,
  );

  const directory = mkdtempSync("/tmp/z-function-values-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const captured = source.replace(
    "const double: (value: i32) => i32 = (value: i32): i32 => value * 2;",
    "const offset = 2; const double: (value: i32) => i32 = (value: i32): i32 => value + offset;",
  );
  const capturedDiagnostic = diagnostics(captured, "captured-function-value.zs")[0];
  assert.equal(capturedDiagnostic.code, "Z0212");
  assert.match(capturedDiagnostic.message, /borrowed capturing closure/);

  assert.throws(
    () => compileToC(source.replace("= add;", "= subtract;").replace("(x: i32, y: i32) => i32", "(x: i32) => i32"), "function-value-mismatch.zs"),
    /expected \(x: i32\) => i32, found \(left: i32, right: i32\) => i32/,
  );
});

test("stores, calls, and propagates throwing function values", () => {
  const source = `
    struct ParseError {
      code: i32;
    }

    type Parser = (value: i32) => i32 throws ParseError;

    function parse(value: i32): i32 throws ParseError {
      if (value < 0) { throw ParseError({ code: value }); }
      return value + 1;
    }

    function invoke(in operation: Parser, value: i32): i32 throws ParseError {
      return try operation(value);
    }

    function main(): i32 {
      const named: Parser = parse;
      const contextual: Parser = (value) => {
        if (value < 0) { throw ParseError({ code: value }); }
        return value + 1;
      };
      const explicit: Parser = (value): i32 throws ParseError => {
        if (value < 0) { throw ParseError({ code: value }); }
        return value + 1;
      };
      const first = attempt invoke(named, 40);
      const second = attempt contextual(41);
      const third = attempt explicit(-3);
      const firstValue = match (first) {
        success(value) => value;
        failure(error) => error.code;
      };
      const secondValue = match (second) {
        success(value) => value;
        failure(error) => error.code;
      };
      const thirdValue = match (third) {
        success(value) => value;
        failure(error) => -error.code;
      };
      return firstValue + secondValue + thirdValue - 86;
    }
  `;
  const generated = compileToC(source, "throwing-function-values.zs");
  assert.match(
    generated,
    /Z_Result_i32_ParseError \(\*call\)\(void \*context, int32_t value\)/,
  );
  assert.match(generated, /__z_function_adapter_parse/);
  assert.match(generated, /__z_closure_call_[0-9]+_adapter/);
  assert.match(generated, /\.call\([^;]+\.context, 41\)/);

  const namedUse = source.indexOf("named, 40") + 1;
  assert.match(
    hover(source, "throwing-function-values.zs", namedUse)?.contents.value ?? "",
    /named: Parser/,
  );
  const contextualParameter = source.indexOf("(value) =>") + 2;
  assert.match(
    hover(source, "throwing-function-values.zs", contextualParameter)?.contents.value ?? "",
    /value: i32/,
  );

  const directory = mkdtempSync("/tmp/z-throwing-function-values-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.throws(
    () => compileToC(source.replace("const first = attempt invoke(named, 40);", "const first = invoke(named, 40);"), "throwing-function-value-call.zs"),
    /throwing call requires `attempt` or `try`/,
  );
  const mismatchedEffect = `
    struct ParseError { code: i32; }
    struct OtherError { code: i32; }
    type Parser = (value: i32) => i32 throws ParseError;
    function main(): i32 {
      const parser: Parser = (value): i32 throws OtherError => value;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(mismatchedEffect, "throwing-function-value-effect.zs"),
    /expected \(value: i32\) => i32 throws ParseError, found \(value: i32\) => i32 throws OtherError/,
  );
});

test("names existing types through transparent aliases", () => {
  const example = resolve(projectRoot, "examples/language/types/type-aliases/main.zs");
  const operations = resolve(projectRoot, "examples/language/types/type-aliases/operations.zs");
  const source = readFileSync(example, "utf8");
  const operationSource = readFileSync(operations, "utf8");

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "aliased callback answer=42\n");

  const generated = compileToC(source, example);
  assert.match(generated, /__z_function_adapter___z_module_[0-9]+_add/);
  assert.doesNotMatch(generated, /\bOperation\b/);

  const aliasDeclaration = operationSource.indexOf("Operation");
  assert.match(
    hover(operationSource, operations, aliasDeclaration + 1)?.contents.value ?? "",
    /type Operation = \(left: i32, right: i32\) => i32/,
  );
  const aliasUse = source.indexOf("Operation");
  assert.match(
    hover(source, example, aliasUse + 1)?.contents.value ?? "",
    /type Operation = \(left: i32, right: i32\) => i32/,
  );
  const operationUse = source.indexOf("operation, 20");
  assert.match(hover(source, example, operationUse + 1)?.contents.value ?? "", /operation: Operation/);
  assert.equal(definition(source, `file://${example}`, aliasUse + 1)?.uri, `file://${operations}`);

  const aliasToken = decodeSemanticTokens(semanticTokens(operationSource, operations).data)
    .find((token) => token.character === aliasDeclaration);
  assert.equal(aliasToken?.type, semanticTokenTypes.indexOf("type"));
  assert.equal(aliasToken?.modifiers, 1);

  const completionSource = source.replace("const operation: Operation", "const operation: Oper");
  const completionOffset = completionSource.indexOf("const operation: Oper") + "const operation: Oper".length;
  assert.match(
    completions(completionSource, example, completionOffset).find((item) => item.label === "Operation")?.detail ?? "",
    /type Operation = \(left: i32, right: i32\) => i32/,
  );

  const aggregateAlias = `
    struct Point {
      x: i32;
      static function origin(): Point { return Point({ x: 0 }); }
    }
    type Coordinate = Point;
    function main(): i32 {
      const point = Coordinate({ x: 42 });
      return point.x + Coordinate.origin().x - 42;
    }
  `;
  assert.doesNotMatch(compileToC(aggregateAlias, "aggregate-alias.zs"), /\bCoordinate\b/);

  const capabilityAlias = `
    type Mutator = (inout value: i32) => void;
    function increment(inout value: i32): void { value = value + 1; }
    function apply(operation: Mutator, inout value: i32): void { operation(inout value); }
    function main(): i32 {
      let value = 41;
      apply(increment, inout value);
      return value - 42;
    }
  `;
  assert.match(compileToC(capabilityAlias, "capability-alias.zs"), /int32_t \*value/);

  const cycle = `
    type First = Second;
    type Second = Array<First>;
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(cycle, "alias-cycle.zs"),
    /circular type alias: First -> Second -> First/,
  );
  assert.throws(
    () => compileToC("type UnknownAlias = Missing; function main(): i32 { return 0; }", "alias-unknown.zs"),
    /unknown type "Missing"/,
  );

  const parser = spawnSync(process.execPath, [cli, "self-host-parse", operations, example], { encoding: "utf8" });
  assert.equal(parser.status, 0, parser.stderr);
  assert.match(parser.stdout, /operations\.zs: stage-1 parser matches 3 declarations/);
  const native = spawnSync(process.execPath, [cli, "check", example, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid matches 2 modules/);
});

test("renders structured ownership diagnostics in the CLI and language server", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/ownership-diagnostic.zs");
  const source = readFileSync(fixture, "utf8");
  let caught: unknown;
  try {
    compileToC(source, fixture);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DiagnosticError);
  assert.equal(caught.code, "Z0201");
  assert.equal(caught.labels.length, 1);
  assert.match(caught.labels[0].message, /ownership was transferred here/);
  assert.match(caught.helps.join("\n"), /borrow the value with an `in` parameter/);

  const rendered = formatDiagnostic(caught, source);
  assert.match(rendered, /error\[Z0201\]: use of moved value "first"/);
  assert.match(rendered, /ownership was transferred here/);
  assert.match(rendered, /note: ownership-bearing values have a single owner/);
  assert.match(rendered, /help: borrow the value with an `in` parameter/);

  const cliResult = spawnSync(process.execPath, [cli, "check", fixture], { encoding: "utf8" });
  assert.equal(cliResult.status, 1);
  assert.match(cliResult.stderr, /error\[Z0201\]/);
  assert.match(cliResult.stderr, /ownership was transferred here/);
  assert.match(cliResult.stderr, /help:/);

  const editor = diagnostics(source, fixture);
  assert.equal(editor[0].code, "Z0201");
  assert.match(editor[0].message, /help: borrow the value/);
  assert.equal(editor[0].relatedInformation?.length, 1);
  assert.match(editor[0].relatedInformation?.[0].message ?? "", /ownership was transferred here/);
});

test("guides closure borrows and explicit mutable call-site capabilities", () => {
  const capturedOwner = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): i32 { return resource.id; }
    function main(): i32 {
      const resource = Resource({ id: 42 });
      const inspect = (): i32 => resource.id;
      return consume(resource) + inspect();
    }
  `;
  let captureError: unknown;
  try {
    compileToC(capturedOwner, "captured-owner.zs");
  } catch (error) {
    captureError = error;
  }
  assert.ok(captureError instanceof DiagnosticError);
  assert.equal(captureError.code, "Z0203");
  assert.match(captureError.summary, /borrowed by a closure/);
  assert.match(captureError.labels[0].message, /closure borrow begins here/);
  assert.match(captureError.helps[0], /keep the owner available/);

  const missingInout = `
    function increment(inout value: i32): void { value = value + 1; }
    function main(): i32 {
      let value = 41;
      increment(value);
      return value;
    }
  `;
  const editor = diagnostics(missingInout, "missing-inout.zs");
  assert.equal(editor[0].code, "Z0301");
  assert.match(editor[0].message, /help: pass mutable storage explicitly as `inout value`/);
});

test("runs deterministic deinit across normal, return, throw, and try exits", () => {
  const example = resolve(projectRoot, "examples/language/ownership/deinit.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "scope\ndeinit=2\ndeinit=1\ndeinit=3\ndeinit=5\ndeinit=4\ndeinit=8\ndeinit=9\ndeinit=10\ndeinit=11\ndeinit=13\ndeinit=12\ndeinit=14\ndeinit=15\ndeinit=16\ndeinit=17\ndeinit=18\ndeinit=18\ndeinit=19\ndeinit=19\ndeinit=6\ndeinit=7\n",
  );
});

test("rejects using a cleanup-bearing value after it moves", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function main(): i32 {
      const first = Resource({ id: 1 });
      const second = first;
      return first.id + second.id;
    }
  `;
  assert.throws(
    () => compileToC(source, "owned-copy.zs"),
    /use of moved value "first"/,
  );
});

test("rejects values that may have moved on another branch", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function consume(resource: Resource): i32 { return resource.id; }
    function choose(flag: boolean): i32 {
      const resource = Resource({ id: 1 });
      if (flag) {
        consume(resource);
      }
      return resource.id;
    }
    function main(): i32 { return choose(false); }
  `;
  assert.throws(
    () => compileToC(source, "maybe-moved.zs"),
    /value "resource" may have been moved on another control-flow path/,
  );
});

test("merges ownership state across exhaustive match arms", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    enum Choice { move i32, keep i32, }
    function consume(resource: Resource): i32 { return resource.id; }
    function choose(choice: Choice, resource: Resource): i32 {
      match (choice) {
        move(value) => consume(resource);
        keep(value) => value;
      }
      return resource.id;
    }
    function main(): i32 {
      return choose(Choice.keep(1), Resource({ id: 2 }));
    }
  `;
  assert.throws(
    () => compileToC(source, "match-moved.zs"),
    /value "resource" may have been moved on another control-flow path/,
  );
});

test("rejects discarding cleanup-bearing return values", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function make(): Resource { return Resource({ id: 1 }); }
    function main(): i32 {
      make();
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "owned-discard.zs"),
    /an ownership-bearing value must be bound or transferred; it cannot be discarded/,
  );
});

test("keeps deinit synchronous and free of explicit control-flow exits", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit { return; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "deinit-return.zs"),
    /deinit cannot contain "return"/,
  );
});

test("requires boolean if conditions", () => {
  const source = `
    function main(): i32 {
      if (42) { return 1; } else { return 0; }
    }
  `;
  assert.throws(
    () => compileToC(source, "if-condition.zs"),
    /if-condition\.zs:3:11: error: expected boolean, found i32/,
  );

  const pointerTruthiness = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-no-truthiness.txt", "w");
      if (file) return 1;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(pointerTruthiness, "pointer-truthiness.zs"),
    /expected boolean/,
  );
});

test("requires every reachable if path to return", () => {
  const source = `
    function choose(flag: boolean): i32 {
      if (flag) { return 1; }
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "if-return.zs"),
    /function "choose" must end with a return value/,
  );
});

test("rejects statements after every branch exits", () => {
  const source = `
    function choose(flag: boolean): i32 {
      if (flag) { return 1; } else { return 2; }
      return 3;
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "unreachable.zs"),
    /unreachable\.zs:4:7: error: unreachable statement after guaranteed function exit/,
  );
});

test("runs while loops with cleanup-aware break and continue", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/loops.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=1\ndrop=2\ndrop=3\ndrop=4\ntotal=8\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /Z_Iteration_deinit\(&\(iteration\)\);\n\s+goto _z_loop_continue_0;/);
  assert.match(generated, /Z_Iteration_deinit\(&\(iteration\)\);\n\s+goto _z_loop_break_0;/);
  assert.match(generated, /_z_loop_continue_0: ;\n\s+}\n\s+_z_loop_break_0: ;/);
});

test("produces values from for and while expressions through select and else", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/loop-expressions.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready: 4\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /goto _z_loop_value_[0-9]+;/);
  assert.match(generated, /_z_loop_value_[0-9]+: ;/);
  const source = readFileSync(example, "utf8");
  const firstEvenUse = source.indexOf("firstEven", source.indexOf("match"));
  assert.match(hover(source, example, firstEvenUse + 1)?.contents.value ?? "", /firstEven: Option<i32>/);
  const native = spawnSync(process.execPath, [cli, "self-host-parse", example], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /stage-1 parser matches/);

  const cleanupDirectory = mkdtempSync("/tmp/z-loop-expression-cleanup-");
  const cleanupFile = resolve(cleanupDirectory, "main.zs");
  const cleanupSource = `
    import console from "std/console";
    struct Resource {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    function main(): i32 {
      const values = [1, 2, 3];
      const selected = for (const value of values) {
        const resource = Resource({ id: value });
        if (value == 2) {
          select resource.id;
        }
      } else {
        select 0;
      };
      return selected - 2;
    }
  `;
  writeFileSync(cleanupFile, cleanupSource);
  const cleanupResult = spawnSync(process.execPath, [cli, "run", cleanupFile], { encoding: "utf8" });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(cleanupResult.stdout, "drop=1\ndrop=2\n");
  const cleanupGenerated = compileToC(cleanupSource, cleanupFile);
  assert.match(cleanupGenerated, /Z_Resource_deinit\(&\(resource\)\);\n\s+goto _z_loop_value_/);

  const iteratorFile = resolve(cleanupDirectory, "iterator.zs");
  const iteratorSource = `
    import { Iterator } from "std/iteration";
    struct Countdown implements Iterator<i32> {
      current: i32;
      function next(inout this): Option<i32> {
        if (this.current == 0) return Option.none;
        const value = this.current;
        this.current = this.current - 1;
        return Option.some(value);
      }
    }
    function main(): i32 {
      let countdown = Countdown({ current: 3 });
      const selected = for (const value of inout countdown) {
        if (value == 2) select value;
      } else {
        select 0;
      };
      const remaining = match (countdown.next()) {
        some(value) => value;
        none => 0;
      };
      return selected + remaining - 3;
    }
  `;
  writeFileSync(iteratorFile, iteratorSource);
  const iteratorResult = spawnSync(process.execPath, [cli, "run", iteratorFile], { encoding: "utf8" });
  assert.equal(iteratorResult.status, 0, iteratorResult.stderr);

  const missingElse = `
    function main(): i32 {
      const values = [1];
      const found = for (const value of values) { select value; };
      return found;
    }
  `;
  assert.throws(
    () => compileToC(missingElse, "loop-expression-else.zs"),
    /expected `else` in a value-producing `for\.\.\.of`/,
  );

  const mismatched = `
    function main(): i32 {
      const values = [1];
      const found = for (const value of values) {
        select value;
      } else {
        select "missing";
      };
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(mismatched, "loop-expression-type.zs"),
    /for expression branch produces i32, but the other branch produces String/,
  );

  const valuelessBreak = `
    function main(): i32 {
      const values = [1];
      const found = for (const value of values) {
        break;
      } else {
        select 0;
      };
      return found;
    }
  `;
  assert.throws(
    () => compileToC(valuelessBreak, "loop-expression-break.zs"),
    /break cannot exit a value-producing loop without a value/,
  );
});

test("iterates fixed arrays, Array values, Slices, and borrowed owned elements", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/iteration.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sum=22 slice=18\nvisit=8\nvisit=9\ndrop=9\ndrop=8\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /for \(uintptr_t _z_for_index_/);
  assert.match(generated, /const Z_Resource \*resource = &\(/);
});

test("supports generic Iterator<T> traits and explicit inout iteration", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/custom-iterator.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "countdown: 3\ncountdown: 2\ncountdown: 1\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /Z_Countdown_next\(&\(countdown\)\)/);
  assert.match(generated, /while \(true\)/);
  assert.match(generated, /_z_iterator_1/);

  const ownedDirectory = mkdtempSync("/tmp/z-owned-iterator-");
  const ownedFile = resolve(ownedDirectory, "owned-iterator.zs");
  const ownedSource = `
    import console from "std/console";
    import { Iterator } from "std/iteration";
    struct Resource {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    struct Resources implements Iterator<Resource> {
      current: i32;
      function next(inout this): Option<Resource> {
        if (this.current == 0) return Option.none;
        const value = this.current;
        this.current = this.current - 1;
        return Option.some(Resource({ id: value }));
      }
    }
    function main(): i32 {
      let resources = Resources({ current: 2 });
      let total = 0;
      for (const resource of inout resources) {
        total = total + resource.id;
      }
      return total == 3 ? 0 : 1;
    }
  `;
  writeFileSync(ownedFile, ownedSource);
  const ownedResult = spawnSync(process.execPath, [cli, "run", ownedFile], { encoding: "utf8" });
  assert.equal(ownedResult.status, 0, ownedResult.stderr);
  assert.equal(ownedResult.stdout, "drop=2\ndrop=1\n");
  const ownedGenerated = compileToC(ownedSource, ownedFile);
  assert.match(ownedGenerated, /Z_Resource_deinit\(&\(resource\)\)/);
  assert.match(ownedGenerated, /\.tag = Z_Option_Resource_none/);

  const source = readFileSync(example, "utf8");
  const iteratorImport = source.indexOf("Iterator");
  assert.match(hover(source, example, iteratorImport + 1)?.contents.value ?? "", /trait Iterator<T>/);
  const inoutOffset = source.indexOf("inout countdown");
  assert.match(hover(source, example, inoutOffset + 1)?.contents.value ?? "", /Iterator\.next mutates traversal state/);
  const valueUse = source.indexOf("${value}") + 3;
  assert.match(hover(source, example, valueUse)?.contents.value ?? "", /value: i32/);
  const importSource = `import { Iter } from "std/iteration"; function main(): i32 { return 0; }`;
  const importOffset = importSource.indexOf("Iter") + 4;
  assert.equal(
    completions(importSource, "iterator-import-completion.zs", importOffset).find((item) => item.label === "Iterator")?.kind,
    8,
  );

  const implicitStored = `
    import { Iterator } from "std/iteration";
    struct Counter implements Iterator<i32> {
      value: i32;
      function next(inout this): Option<i32> { return Option.none; }
    }
    function main(): i32 {
      let counter = Counter({ value: 0 });
      for (const value of counter) {}
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(implicitStored, "iterator-explicit-inout.zs"),
    /stored iterator "counter" requires explicit inout iteration/,
  );

  const immutableStored = implicitStored.replace(
    "let counter =",
    "const counter =",
  ).replace(
    "of counter",
    "of inout counter",
  );
  assert.throws(
    () => compileToC(immutableStored, "iterator-let-storage.zs"),
    /iterator "counter" requires mutable let storage/,
  );

  const collectionCapability = `
    function main(): i32 {
      let values = Array<i32>();
      for (const value of inout values) {}
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(collectionCapability, "collection-inout-iteration.zs"),
    /for\.\.\.of inout requires an Iterator<T>/,
  );
});

test("materializes user-defined generic traits and generic trait constraints", () => {
  const source = `
    trait Source<T> {
      function next(inout this): Option<T>;
    }
    struct Counter implements Source<i32> {
      value: i32;
      function next(inout this): Option<i32> {
        if (this.value == 0) return Option.none;
        const value = this.value;
        this.value = this.value - 1;
        return Option.some(value);
      }
    }
    function inspect<T: Source<i32>>(inout source: T): i32 {
      return match (source.next()) {
        some(value) => value;
        none => 0;
      };
    }
    function main(): i32 {
      let counter = Counter({ value: 42 });
      return inspect(inout counter) == 42 ? 0 : 1;
    }
  `;
  const generated = compileToC(source, "generic-trait.zs");
  assert.match(generated, /__z_mono_inspect_Counter/);
  const analyzed = analyzeSource(source, "generic-trait.zs");
  assert.equal(analyzed.program.traits.length, 1);
  assert.equal(analyzed.typeDisplayNames.get(analyzed.program.traits[0].name), "Source<i32>");
  const traitOffset = source.indexOf("Source<T>");
  assert.match(hover(source, "generic-trait.zs", traitOffset + 1)?.contents.value ?? "", /trait Source<T>/);
});

test("keeps for-of iteration storage stable and owned elements borrowed", () => {
  const structuralMutation = `
    function main(): i32 {
      let values = Array<i32>();
      values.push(1);
      for (const value of values) {
        values.push(value);
      }
      return 0;
    }
  `;
  const mutationDiagnostics = diagnostics(structuralMutation, "iteration-mutation.zs");
  assert.equal(mutationDiagnostics[0].code, "Z0311");
  assert.match(mutationDiagnostics[0].message, /may reallocate storage/);
  assert.match(mutationDiagnostics[0].message, /finish the loop before pushing/);
  assert.equal(mutationDiagnostics[0].relatedInformation?.length, 1);

  const movedElement = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): i32 { return resource.id; }
    function main(): i32 {
      const resources = [Resource({ id: 42 })];
      for (const resource of resources) {
        return consume(resource);
      }
      return 0;
    }
  `;
  let moveError: unknown;
  try {
    compileToC(movedElement, "iteration-move.zs");
  } catch (error) {
    moveError = error;
  }
  assert.ok(moveError instanceof DiagnosticError);
  assert.equal(moveError.code, "Z0203");
  assert.match(moveError.summary, /cannot move borrowed iteration binding "resource"/);
  assert.match(moveError.helps[0], /use `copy` when an independent copy is supported/);

  const movedOuter = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): i32 { return resource.id; }
    function main(): i32 {
      const values = [1, 2];
      const resource = Resource({ id: 42 });
      for (const value of values) {
        if (value == 2) { consume(resource); }
      }
      return resource.id;
    }
  `;
  assert.throws(
    () => compileToC(movedOuter, "iteration-outer-move.zs"),
    /value "resource" may have been moved on another control-flow path/,
  );
});

test("exposes for-of bindings to hover, completion, and semantic tokens", () => {
  const source = `
    function main(): i32 {
      const values = [20, 22];
      let total = 0;
      for (const value of values) {
        total = total + value;
      }
      return total;
    }
  `;
  const use = source.indexOf("value;", source.indexOf("for")) + 1;
  assert.match(hover(source, "iteration-editor.zs", use)?.contents.value ?? "", /value: i32/);
  const completionSource = source.replace("total = total + value", "total = total + val");
  const completionOffset = completionSource.indexOf("val;", completionSource.indexOf("for")) + 3;
  assert.equal(completions(completionSource, "iteration-editor.zs", completionOffset).find((item) => item.label === "value")?.detail, "const value: i32");
  const tokens = decodeSemanticTokens(semanticTokens(source, "iteration-editor.zs").data);
  const bindingOffset = source.indexOf("value of");
  const bindingPosition = positionForOffset(source, bindingOffset);
  assert.ok(tokens.some((token) => token.line === bindingPosition.line && token.character === bindingPosition.character));
});

test("destructures value structs and borrowed collection entries", () => {
  const example = resolve(projectRoot, "examples/language/basics/destructuring.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 1 module/);

  const generated = compileToC(source, example);
  assert.match(generated, /Z_FileRecord _z_destructure_/);
  assert.match(generated, /z_copy_FileRecord\(original\)/);
  assert.match(generated, /_z_live_original_[0-9]+ = false/);
  assert.match(generated, /const Z_String \*key = &/);
  assert.match(generated, /int32_t value =/);

  const partialMove = `
    struct Record { kept: String; discarded: String; }
    function main(): i32 {
      const record = Record({ kept: "answer", discarded: "temporary" });
      const { kept } = move record;
      return kept.byteLength == 6 ? 0 : 1;
    }
  `;
  assert.deepEqual(diagnostics(partialMove, "destructure-partial-move.zs"), []);
  const partialGenerated = compileToC(partialMove, "destructure-partial-move.zs");
  assert.match(partialGenerated, /_z_destructure_[0-9]+\.kept = \(Z_String\)\{ 0 \}/);
  assert.match(partialGenerated, /Z_Record_deinit\(&\(_z_destructure_[0-9]+\)\)/);
  assert.match(partialGenerated, /free\(\(void \*\)\(self->discarded\)\.data\)/);

  const implicitOwned = `
    struct Record { path: String; revision: i32; }
    function main(): i32 {
      const record = Record({ path: "notes.zs", revision: 42 });
      const { path } = record;
      return path.byteLength == 8 ? 0 : 1;
    }
  `;
  const ownershipDiagnostic = diagnostics(implicitOwned, "destructure-owned.zs")[0];
  assert.equal(ownershipDiagnostic.code, "Z0220");
  assert.match(ownershipDiagnostic.message, /requires explicit copy or move/);
  assert.match(ownershipDiagnostic.message, /use `copy value` to keep the source/);

  const useAfterMove = source.replace(
    "if (copiedPath != movedPath) return 1;",
    "if (original.path != movedPath) return 1;",
  );
  const movedDiagnostic = diagnostics(useAfterMove, "destructure-moved.zs")[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "original"/);

  const customCleanup = `
    struct Resource { id: i32; deinit {} }
    struct Envelope { resource: Resource; label: String; }
    function main(): i32 {
      const envelope = Envelope({ resource: Resource({ id: 42 }), label: "answer" });
      const { resource } = move envelope;
      return resource.id - 42;
    }
  `;
  const cleanupDiagnostic = diagnostics(customCleanup, "destructure-custom-cleanup.zs")[0];
  assert.equal(cleanupDiagnostic.code, "Z0220");
  assert.match(cleanupDiagnostic.message, /custom or foreign cleanup storage/);

  const privateFields = `
    struct Secret {
      private value: i32;
      function reveal(): i32 {
        const { value } = this;
        return value;
      }
    }
    function main(): i32 {
      const secret = Secret({ value: 42 });
      return secret.reveal() - 42;
    }
  `;
  assert.deepEqual(diagnostics(privateFields, "destructure-private-inside.zs"), []);
  const externalPrivate = privateFields.replace(
    "return secret.reveal() - 42;",
    "const { value } = secret; return value - 42;",
  );
  assert.match(
    diagnostics(externalPrivate, "destructure-private-outside.zs")[0].message,
    /cannot destructure private field "value"/,
  );

  const borrowedFieldMove = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      for (const { key, value } of values) {
        const owned = move key;
        return owned.byteLength + value;
      }
      return 0;
    }
  `;
  const borrowedDiagnostic = diagnostics(borrowedFieldMove, "destructure-borrowed-loop.zs")[0];
  assert.equal(borrowedDiagnostic.code, "Z0203");
  assert.match(borrowedDiagnostic.message, /cannot move borrowed iteration binding "key"/);

  const pathUse = source.indexOf("copiedPath !=") + 2;
  assert.match(hover(source, example, pathUse)?.contents.value ?? "", /copiedPath: String/);
  const valueUse = source.indexOf("+ value") + 3;
  assert.match(hover(source, example, valueUse)?.contents.value ?? "", /value: i32/);
  const completionSource = source.replace("copiedPath != movedPath", "copiedP != movedPath");
  const completionOffset = completionSource.indexOf("copiedP !=") + "copiedP".length;
  assert.equal(
    completions(completionSource, example, completionOffset).find((item) => item.label === "copiedPath")?.detail,
    "const copiedPath: String",
  );

  const localPatternSource = source.replace(
    "{ path: copiedPath, revision: copiedRevision }",
    "{ pa }",
  );
  const localPatternOffset = localPatternSource.indexOf("{ pa }") + "{ pa".length;
  const pathCompletion = completions(localPatternSource, example, localPatternOffset)
    .find((item) => item.label === "path");
  assert.equal(pathCompletion?.detail, "path: String");
  assert.equal(pathCompletion?.insertText, "path");

  const loopPatternSource = source.replace("{ key, value }", "{ ke }");
  const loopPatternOffset = loopPatternSource.indexOf("{ ke }") + "{ ke".length;
  assert.equal(
    completions(loopPatternSource, example, loopPatternOffset).find((item) => item.label === "key")?.detail,
    "key: String",
  );
});

test("checks logical operand types", () => {
  const source = `
    function main(): i32 {
      const invalid = true && 1;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "logical-types.zs"),
    /operator "&&" requires boolean operands/,
  );
});

test("emits struct layouts, literals, fields, and borrowed methods", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
      function sum(): i32 {
        return this.x + this.y;
      }
    }
    function main(): i32 {
      const point = Point({ x: 20, y: 22 });
      return point.sum();
    }
  `;
  const generated = compileToC(source, "point.zs");
  assert.match(generated, /struct Z_Point \{/);
  assert.match(generated, /static int32_t Z_Point_sum\(const Z_Point \*self\)/);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \};/);
  assert.match(generated, /return Z_Point_sum\(&\(point\)\);/);
});

test("constructs structs from object values and classes through class-only new", () => {
  const example = resolve(projectRoot, "examples/language/basics/construction.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \}/);
  assert.match(generated, /Z_Session \* const session = Z_Session_new/);

  const structWithNew = source.replace("Point({ x: 20, y: 22 })", "new Point({ x: 20, y: 22 })");
  assert.throws(() => compileToC(structWithNew, "new-struct.zs"), /new requires a class type/);

  const classWithoutNew = source.replace("new Session({ id: point.x + point.y })", "Session({ id: point.x + point.y })");
  assert.throws(() => compileToC(classWithoutNew, "class-without-new.zs"), /class construction requires new Session/);

  const legacy = source.replace("Point({ x: 20, y: 22 })", "Point { x: 20, y: 22 }");
  assert.throws(() => compileToC(legacy, "legacy-construction.zs"));

  const qualifiedLegacy = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint { x: 20, y: 22 };
      return point.x + point.y - 42;
    }
  `;
  assert.throws(() => compileToC(qualifiedLegacy, "qualified-legacy-construction.zs"));
});

test("initializes private class state through safe user constructors", () => {
  const example = resolve(projectRoot, "examples/language/basics/constructors.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Z_Session \*Z_Session_new\(int32_t id, Z_String name\)/);
  assert.match(generated, /self->id = id;/);
  assert.match(generated, /self->name = \(_z_live_name_\d+ = false, name\);/);
  assert.match(generated, /Z_Result_CheckedSession_InvalidSession Z_CheckedSession_new/);
  assert.match(generated, /if \(_z_live_field_name_\d+ && \(self->name\)\.capacity > 0\)[\s\S]*free\(self\);[\s\S]*Z_Result_CheckedSession_InvalidSession_failure/);

  const privateRead = source.replace("return session.identifier() + failureCode - 35;", "return session.id;");
  assert.throws(() => compileToC(privateRead, "private-field.zs"), /field "id" is private to class "Session"/);

  const missingField = source.replace("    this.name = name;\n", "");
  assert.throws(() => compileToC(missingField, "constructor-missing-field.zs"), /does not initialize field "name"/);

  const earlyRead = source.replace("    this.id = id;", "    this.name = this.name;\n    this.id = id;");
  assert.throws(() => compileToC(earlyRead, "constructor-early-read.zs"), /field "name" is read before it is initialized/);

  const escapedThis = source.replace("    this.id = id;", "    const escaped = this;\n    this.id = id;");
  assert.throws(() => compileToC(escapedThis, "constructor-this-escape.zs"), /this cannot escape before field "id" is initialized/);

  const privateDeclaration = source.indexOf("id: i32");
  assert.match(hover(source, example, privateDeclaration + 1)?.contents.value ?? "", /private id: i32/);
  const privateUse = source.indexOf("this.id", source.indexOf("function identifier")) + "this.".length;
  assert.match(hover(source, example, privateUse + 1)?.contents.value ?? "", /private id: i32/);

  const outsideCompletionSource = source.replace(
    "  return session.identifier()",
    "  session.;\n  return session.identifier()",
  );
  const outsideOffset = outsideCompletionSource.indexOf("session.", outsideCompletionSource.indexOf("function main")) + "session.".length;
  const outsideItems = completions(outsideCompletionSource, example, outsideOffset);
  assert.equal(outsideItems.some((item) => item.label === "id"), false);
  assert.equal(outsideItems.some((item) => item.label === "name"), true);
  assert.equal(outsideItems.some((item) => item.label === "identifier"), true);

  const insideCompletionSource = source.replace("    return this.id;", "    this.;\n    return this.id;");
  const insideOffset = insideCompletionSource.indexOf("this.;") + "this.".length;
  assert.equal(completions(insideCompletionSource, example, insideOffset).some((item) => item.label === "id"), true);

  const branchInitialized = `
    class Choice {
      private value: i32;
      constructor(value: i32, positive: boolean) {
        if (positive) { this.value = value; }
        else { this.value = -value; }
      }
      function read(): i32 { return this.value; }
    }
    function main(): i32 { const choice = new Choice(42, true); return choice.read() - 42; }
  `;
  assert.doesNotThrow(() => compileToC(branchInitialized, "constructor-branches.zs"));
  const incompleteBranch = branchInitialized.replace("else { this.value = -value; }", "else {}");
  assert.throws(() => compileToC(incompleteBranch, "constructor-incomplete-branch.zs"), /does not initialize field "value"/);

  const genericConstructor = `
    class Envelope<T> {
      private value: T;
      constructor(value: T) { this.value = value; }
      function get(): T { return this.value; }
    }
    function main(): i32 { const envelope = new Envelope(42); return envelope.get() - 42; }
  `;
  assert.match(compileToC(genericConstructor, "generic-class-constructor.zs"), /Z___z_mono_Envelope_i32_new\(int32_t value\)/);

  const objectBypass = `
    class Secret { private value: i32; constructor(value: i32) { this.value = value; } }
    enum Wrapped { secret Secret }
    function main(): i32 { const wrapped = Wrapped.secret({ value: 42 }); return 0; }
  `;
  assert.throws(() => compileToC(objectBypass, "constructor-object-bypass.zs"), /has a constructor and cannot be initialized from an object value/);

  const privatePattern = `
    class Secret { private value: i32; constructor(value: i32) { this.value = value; } }
    enum Wrapped { secret Secret }
    function read(wrapped: Wrapped): i32 {
      return match (wrapped) { secret({ value }) => value; };
    }
    function main(): i32 { const secret = new Secret(42); return read(Wrapped.secret(secret)) - 42; }
  `;
  assert.throws(() => compileToC(privatePattern, "private-pattern.zs"), /field "value" is private to class "Secret"/);
});

test("runs visible type-scoped static methods on structs, classes, and generic instances", () => {
  const example = resolve(projectRoot, "examples/language/basics/static-methods.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "bounds=Bounds { min: 2, max: 9 }, session=0, checked=42\n");

  const generated = compileToC(source, example);
  assert.match(generated, /static Z_Bounds Z_Bounds_normalized\(int32_t left, int32_t right\)/);
  assert.match(generated, /static Z_Session \*\s*Z_Session_create\(int32_t id\)/);
  assert.match(generated, /Z_Session_normalizedId\(id\)/);
  assert.match(generated, /Z_Result_Session_InvalidSession Z_Session_checked\(int32_t id\)/);

  const generic = `
    struct Container<T> {
      value: T;
      static function wrap(value: T): Container<T> { return Container({ value }); }
    }
    function main(): i32 {
      const inferred = Container.wrap(42);
      const explicit = Container.wrap<i32>(42);
      return inferred.value + explicit.value - 84;
    }
  `;
  assert.match(compileToC(generic, "generic-static.zs"), /Z___z_mono_Container_i32_wrap\(int32_t value\)/);

  const directory = mkdtempSync("/tmp/z-static-module-");
  const factory = resolve(directory, "factory.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(factory, `
    export struct Factory {
      static function answer(): i32 { return 42; }
    }
  `);
  const imported = `
    import { Factory } from "./factory.zs";
    function main(): i32 { return Factory.answer() - 42; }
  `;
  writeFileSync(main, imported);
  assert.match(compileToC(imported, main), /__z_module_\d+_Factory_answer\(void\)/);
  const importedCompletion = imported.replace("return Factory.answer() - 42;", "Factory.; return 0;");
  const importedOffset = importedCompletion.indexOf("Factory.;") + "Factory.".length;
  assert.equal(completions(importedCompletion, main, importedOffset).some((item) => item.label === "answer"), true);
  const namespaced = `
    import factory from "./factory.zs";
    function main(): i32 { return factory.Factory.answer() - 42; }
  `;
  assert.match(compileToC(namespaced, main), /__z_module_\d+_Factory_answer\(void\)/);
  const namespaceCompletion = namespaced.replace("return factory.Factory.answer() - 42;", "factory.Factory.; return 0;");
  const namespaceOffset = namespaceCompletion.indexOf("factory.Factory.;") + "factory.Factory.".length;
  assert.equal(completions(namespaceCompletion, main, namespaceOffset).some((item) => item.label === "answer"), true);
});

test("keeps linked module identities out of source-facing diagnostics", () => {
  const directory = mkdtempSync("/tmp/z-module-diagnostic-names-");
  const library = resolve(directory, "application.zs");
  const main = resolve(directory, "main.zs");
  try {
    writeFileSync(library, `
      import { thread } from "std/thread";

      export class Application {
        readonly name: String;
        status: i32 on thread.main;
      }

      export struct Status {
        value: i32;
      }

      export function statuses(): Status[1] {
        return [Status({ value: 1 })];
      }
    `);
    const cases = [
      {
        imports: "Application",
        body: "function inspect(in app: Application): i32 { return app.status; }",
        expected: /field "Application\.status" requires thread\.main/,
      },
      {
        imports: "Application",
        body: "function inspect(in app: Application): i32 { return app.missing; }",
        expected: /struct "Application" has no member "missing"/,
      },
      {
        imports: "Application",
        body: "function make(): Application { return Application({ name: \"Z\", status: 1 }); }",
        expected: /class construction requires new Application\(\{ \.\.\. \}\)/,
      },
      {
        imports: "Status, statuses",
        body: "function inspect(): i32 { const values = statuses(); const [first, second] = values; return 0; }",
        expected: /Status\[1\]/,
      },
    ];
    for (const current of cases) {
      const source = `
        import { ${current.imports} } from "./application.zs";
        ${current.body}
        function main(): i32 { return 0; }
      `;
      writeFileSync(main, source);
      const diagnostic = diagnostics(source, main)[0];
      assert.match(diagnostic?.message ?? "", current.expected);
      assert.doesNotMatch(diagnostic?.message ?? "", /__z_module_/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("builds programs that declare an otherwise unused class", () => {
  const directory = mkdtempSync("/tmp/z-unused-class-");
  const file = resolve(directory, "main.zs");
  try {
    writeFileSync(file, `
      class Never {
        readonly value: i32;
      }

      function main(): i32 { return 0; }
    `);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps static and instance method capabilities distinct", () => {
  const base = `
    class Session {
      private id: i32;
      constructor(id: i32) { this.id = id; }
      private static function secret(): i32 { return 42; }
      private function hidden(): i32 { return this.id; }
      static function create(id: i32): Session { return new Session(id); }
      function identifier(): i32 { return this.id; }
    }
    function main(): i32 {
      const session = Session.create(1);
      return session.identifier();
    }
  `;
  assert.doesNotThrow(() => compileToC(base, "static-capabilities.zs"));
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "session.create(1).identifier()"), "static-through-instance.zs"),
    /static method "create" must be called as Session\.create\(\)/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "Session.identifier()"), "instance-through-type.zs"),
    /instance method "identifier" must be called through a Session value/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "Session.secret()"), "private-static.zs"),
    /static method "secret" is private to class "Session"/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "session.hidden()"), "private-instance.zs"),
    /method "hidden" is private to class "Session"/,
  );
  assert.throws(
    () => compileToC(base.replace("static function create(id: i32)", "static function create(inout this, id: i32)"), "static-this.zs"),
    /static methods cannot declare a `this` receiver/,
  );
  assert.throws(
    () => compileToC(base.replace("private id: i32;", "static id: i32;"), "static-field.zs"),
    /static fields are not implemented/,
  );
});

test("completes and explains static methods on their type namespace", () => {
  const source = `
    class Session {
      id: i32;
      static function create(id: i32): Session { return new Session({ id }); }
      private static function secret(): i32 { return 42; }
      function identifier(): i32 { return this.id; }
    }
    function main(): i32 {
      Session.;
      const session = Session.create(42);
      session.;
      return session.identifier();
    }
  `;
  const staticOffset = source.indexOf("Session.;") + "Session.".length;
  const staticItems = completions(source, "static-editor.zs", staticOffset);
  assert.equal(staticItems.some((item) => item.label === "create"), true);
  assert.equal(staticItems.some((item) => item.label === "secret"), false);
  assert.equal(staticItems.some((item) => item.label === "identifier"), false);

  const instanceSource = source.replace("      Session.;\n", "");
  const instanceOffset = instanceSource.indexOf("session.;") + "session.".length;
  const instanceItems = completions(instanceSource, "static-editor.zs", instanceOffset);
  assert.equal(instanceItems.some((item) => item.label === "identifier"), true);
  assert.equal(instanceItems.some((item) => item.label === "create"), false);

  const valid = source.replace("      Session.;\n", "").replace("      session.;\n", "");
  const createOffset = valid.indexOf("Session.create") + "Session.".length;
  assert.match(hover(valid, "static-editor.zs", createOffset + 1)?.contents.value ?? "", /public static function create\(id: i32\): Session/);
  const tokens = decodeSemanticTokens(semanticTokens(valid, "static-editor.zs").data);
  const declarationOffset = valid.indexOf("create(id");
  assert.match(hover(valid, "static-editor.zs", declarationOffset + 1)?.contents.value ?? "", /public static function create/);
  const declarationPrefix = valid.slice(0, declarationOffset);
  const declarationLine = declarationPrefix.split("\n").length - 1;
  const declarationCharacter = declarationOffset - (declarationPrefix.lastIndexOf("\n") + 1);
  assert.equal(tokens.some((token) => (
    token.line === declarationLine
    && token.character === declarationCharacter
    && semanticTokenTypes[token.type] === "method"
  )), true);

  const genericSource = `
    struct Container<T> {
      value: T;
      static function wrap(value: T): Container<T> { return Container({ value }); }
    }
    function main(): i32 { Container.; return 0; }
  `;
  const genericOffset = genericSource.indexOf("Container.;") + "Container.".length;
  const genericItems = completions(genericSource, "generic-static-editor.zs", genericOffset);
  assert.match(genericItems.find((item) => item.label === "wrap")?.detail ?? "", /wrap<T>\(value: T\).*Container<T>/);
});

test("requires every struct field exactly once", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
    }
    function main(): i32 {
      const point = Point({ x: 1 });
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(source, "missing-field.zs"),
    /missing-field\.zs:7:27: error: missing field "y" when constructing "Point"/,
  );
});

test("constructs value structs from independent field defaults", () => {
  const source = `
    struct RequestOptions {
      retries: i32 = 3;
      timeout: i32 = 1000;
      labels: Array<String> = Array<String>("network");
    }
    struct Envelope<T> {
      value: T;
      readonly attempts: i32 = 1;
    }
    function main(): i32 {
      let first = RequestOptions();
      first.labels.push("mutated");
      const second = RequestOptions({});
      const custom = RequestOptions({ retries: 5 });
      const envelope = Envelope<i32>({ value: 42 });
      if (first.labels.length != 2) return 1;
      if (second.labels.length != 1) return 2;
      if (custom.retries != 5) return 3;
      if (envelope.attempts != 1) return 4;
      return custom.timeout - 1000;
    }
  `;
  const directory = mkdtempSync("/tmp/z-struct-defaults-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const native = spawnSync(process.execPath, [cli, "check", fileName, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  const generated = compileToC(source, fileName);
  assert.match(generated, /Z_RequestOptions/);
  assert.match(generated, /\.retries = _z_aggregate_/);
  const retries = source.indexOf("retries:");
  assert.match(hover(source, fileName, retries + 1)?.contents.value ?? "", /retries: i32 = default/);
  const completionSource = source.replace("      const custom = RequestOptions({ retries: 5 });", "      const custom = RequestOptions({ tim });");
  const completionOffset = completionSource.indexOf("tim });") + 3;
  assert.match(
    completions(completionSource, fileName, completionOffset).find((item) => item.label === "timeout")?.detail ?? "",
    /defaulted/,
  );
  rmSync(directory, { recursive: true, force: true });
});

test("diagnoses invalid and missing struct defaults at their source", () => {
  const invalid = `
    struct Broken {
      count: i32 = "wrong";
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(invalid, "invalid-default.zs"),
    /invalid-default\.zs:3:20: error: expected i32, found String/,
  );

  const missing = `
    struct Request {
      id: i32;
      retries: i32 = 3;
    }
    function main(): i32 {
      const request = Request();
      return request.id;
    }
  `;
  assert.throws(
    () => compileToC(missing, "required-default.zs"),
    /missing field "id" when constructing "Request"/,
  );

  const classDefault = `
    class Session {
      id: i32 = 1;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(classDefault, "class-default.zs"),
    /class field defaults are deferred/,
  );
});

test("preserves struct defaults across source-module imports", () => {
  const directory = mkdtempSync("/tmp/z-module-struct-defaults-");
  const optionsFile = resolve(directory, "options.zs");
  const mainFile = resolve(directory, "main.zs");
  writeFileSync(optionsFile, `
    export struct Options {
      retries: i32 = 3;
      timeout: i32 = 1000;
    }
  `);
  writeFileSync(mainFile, `
    import { Options } from "./options.zs";
    function main(): i32 {
      const options = Options({ retries: 5 });
      return options.retries + options.timeout - 1005;
    }
  `);
  const result = spawnSync(process.execPath, [cli, "run", mainFile], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const native = spawnSync(process.execPath, [cli, "check", mainFile, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  rmSync(directory, { recursive: true, force: true });
});

test("checks struct method arguments", () => {
  const source = `
    struct Counter {
      value: i32;
      function add(amount: i32): i32 {
        return this.value + amount;
      }
    }
    function main(): i32 {
      const counter = Counter({ value: 1 });
      return counter.add("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "method-arguments.zs"),
    /method-arguments\.zs:10:26: error: expected i32, found String/,
  );
});

test("requires exhaustive enum matches", () => {
  const source = `
    enum Outcome {
      success i32,
      failure i32,
    }
    function main(): i32 {
      const outcome = Outcome.success(42);
      match (outcome) {
        success(value) => return value;
      }
    }
  `;
  assert.throws(
    () => compileToC(source, "exhaustive.zs"),
    /exhaustive\.zs:8:7: error: non-exhaustive match; missing Outcome\.failure/,
  );
});

test("compiles payload enums and exhaustive matches", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/match.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "matched=42\n");

  const emptyArms = `
    enum State { ready, empty, }
    function observe(state: State): void {
      match (state) {
        ready => {}
        empty => {}
      }
    }
    function main(): i32 {
      observe(State.ready);
      return 0;
    }
  `;
  assert.doesNotThrow(() => compileToC(emptyArms, "empty-match-arms.zs"));
});

test("composes enums through value aggregates and emits dependency-ordered C layouts", () => {
  const example = resolve(projectRoot, "examples/language/types/aggregate-enums.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "state=42 history=7\n");

  const generated = compileToC(source, example);
  assert.ok(generated.indexOf("struct Z_Mode {") < generated.indexOf("struct Z_State {"));
  assert.ok(generated.indexOf("struct Z_State {") < generated.indexOf("struct Z_Snapshot {"));
  assert.match(generated, /Z_Mode data\[2\]/);

  const currentUse = source.indexOf("snapshot.current") + "snapshot.".length + 1;
  assert.match(hover(source, example, currentUse)?.contents.value ?? "", /current: State/);

  const recursive = `
    enum Link { node Node, end, }
    struct Node { link: Link; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(recursive, "recursive-aggregate.zs"),
    /type "(?:Link|Node)" has a recursive value layout/,
  );
});

test("moves, matches, nests, and destroys cleanup-bearing enum payloads", () => {
  const example = resolve(projectRoot, "examples/language/ownership/owned-enums.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "released resource 40\ncaptured ResourceState.ready(Resource { id: 42 })\nreleased resource 42\nreleased resource 41\nreleased session 7\n",
  );

  const generated = compileToC(source, example);
  assert.match(generated, /switch \(\(state\)\.tag\)/);
  assert.match(generated, /case Z_ResourceState_ready:[\s\S]*Z_Resource_deinit/);
  assert.match(generated, /case Z_SessionOption_some:[\s\S]*Z_Session_release/);
  assert.match(generated, /Z_Container_deinit/);
  assert.match(generated, /Z_ClosureEnv_\d+_release[\s\S]*case Z_ResourceState_ready/);

  const moved = source.replace(
    "  const consumed = consume(state);",
    "  const consumed = consume(state);\n  console.log(resource.id);",
  );
  assert.throws(
    () => compileToC(moved, "owned-enum-move.zs"),
    /use of moved value "resource"/,
  );

  const borrowedTemporary = `
    enum Choice { some i32, none, }
    function main(): i32 {
      return match (in Choice.some(42)) {
        some(value) => value;
        none => -1;
      };
    }
  `;
  assert.throws(
    () => compileToC(borrowedTemporary, "borrowed-match-temporary.zs"),
    /match \(in \.\.\.\) requires stored enum storage/,
  );

  const borrowedMove = `
    struct Item { id: i32; deinit {} }
    enum Choice { some Item, none, }
    function take(in choice: Choice): Item {
      return match (choice) {
        some(item) => item;
        none => Item({ id: 0 });
      };
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedMove, "borrowed-match-move.zs"),
    /cannot move borrowed match binding "item"/,
  );

  const borrowedMutation = `
    enum Choice { some i32, none, }
    function reset(inout choice: Choice): i32 {
      match (in choice) {
        some(value) => {
          choice = Choice.none;
          return value;
        }
        none => return 0;
      }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedMutation, "borrowed-match-mutation.zs"),
    /cannot assign to immutable binding "choice"/,
  );
});

test("compiles expression matches with concise and selecting block arms", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/match-expression.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "code=41\ndirect=41\nselected=42\n");
});

test("constructs contextual enum payloads and destructures their named fields", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/enum-patterns.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /\.data = \{ \.ready = \(Z_Response\)\{ \.status = 200/);
  assert.match(generated, /const Z_ResponseState \*_z_match_\d+ = &\(\(\*state\)\)/);
  assert.match(generated, /Z_Response const \*_z_match_\d+_ready_payload/);
  assert.match(generated, /Z_Response_deinit\(&\(_z_match_\d+_ready_payload\)\)/);

  const statusBinding = source.indexOf("status }) =>") + 1;
  assert.match(hover(source, example, statusBinding)?.contents.value ?? "", /status: i32/);
  const aliasBinding = source.indexOf("code, body") + 1;
  assert.match(hover(source, example, aliasBinding)?.contents.value ?? "", /code: i32/);
  const bodyBinding = source.indexOf("body }) =>") + 1;
  assert.match(hover(source, example, bodyBinding)?.contents.value ?? "", /in body: String/);
});

test("materializes inferred and explicitly empty Option values with owned payloads", () => {
  const example = resolve(projectRoot, "examples/language/types/option.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Z_Option_User_some/);
  assert.match(generated, /case Z_Option_User_some:[\s\S]*Z_User_release/);

  const presentUse = source.indexOf("present) ==") + 1;
  assert.match(hover(source, example, presentUse)?.contents.value ?? "", /present: Option<User>/);
  const someVariant = source.indexOf("some(user)") + 1;
  assert.match(hover(source, example, someVariant)?.contents.value ?? "", /Option<User>\.some\(User\)/);
  const someConstructor = source.indexOf("some(user)", source.indexOf("Option.some")) + 1;
  assert.match(hover(source, example, someConstructor)?.contents.value ?? "", /some\(value: T\): Option<T>/);

  const optionTypePosition = positionForOffset(source, source.indexOf("Option<User>"));
  const someConstructorPosition = positionForOffset(source, source.indexOf("some(user)", source.indexOf("Option.some")));
  const optionTokens = decodeSemanticTokens(semanticTokens(source, example).data);
  assert.ok(optionTokens.some((token) => token.line === optionTypePosition.line
    && token.character === optionTypePosition.character
    && semanticTokenTypes[token.type] === "type"));
  assert.ok(optionTokens.some((token) => token.line === someConstructorPosition.line
    && token.character === someConstructorPosition.character
    && semanticTokenTypes[token.type] === "enumMember"));
  assert.match(hover(source, example, source.indexOf("Option<User>") + 1)?.contents.value ?? "", /Option<T>/);

  const optionCompletionSource = source.replace("Option.some(user)", "Opt");
  const optionCompletionOffset = optionCompletionSource.indexOf("Opt;") + 3;
  assert.equal(
    completions(optionCompletionSource, example, optionCompletionOffset).find((item) => item.label === "Option")?.detail,
    "compiler-provided enum Option<T>",
  );
  const variantCompletionSource = source.replace("Option.some(user)", "Option.s");
  const variantCompletionOffset = variantCompletionSource.indexOf("Option.s;") + "Option.s".length;
  assert.match(
    completions(variantCompletionSource, example, variantCompletionOffset).find((item) => item.label === "some")?.detail ?? "",
    /some\(value: T\): Option<T>/,
  );
});

test("highlights view capabilities and enum variants contextually", () => {
  const viewExample = resolve(projectRoot, "examples/language/ownership/local-views.zs");
  const viewSource = readFileSync(viewExample, "utf8");
  const viewOffset = viewSource.indexOf("view tree");
  const viewPosition = positionForOffset(viewSource, viewOffset);
  const viewTokens = decodeSemanticTokens(semanticTokens(viewSource, viewExample).data);
  assert.ok(viewTokens.some((token) => token.line === viewPosition.line
    && token.character === viewPosition.character
    && semanticTokenTypes[token.type] === "keyword"));

  const enumExample = resolve(projectRoot, "examples/language/control-flow/match.zs");
  const enumSource = readFileSync(enumExample, "utf8");
  const constructorOffset = enumSource.indexOf("success(", enumSource.indexOf("UserResult.success"));
  const constructorPosition = positionForOffset(enumSource, constructorOffset);
  const enumTokens = decodeSemanticTokens(semanticTokens(enumSource, enumExample).data);
  assert.ok(enumTokens.some((token) => token.line === constructorPosition.line
    && token.character === constructorPosition.character
    && semanticTokenTypes[token.type] === "enumMember"));

  const optionExample = resolve(projectRoot, "examples/language/types/option.zs");
  const optionSource = readFileSync(optionExample, "utf8");
  const noneOffset = optionSource.indexOf("none =>");
  const nonePosition = positionForOffset(optionSource, noneOffset);
  const optionTokens = decodeSemanticTokens(semanticTokens(optionSource, optionExample).data);
  assert.ok(optionTokens.some((token) => token.line === nonePosition.line
    && token.character === nonePosition.character
    && semanticTokenTypes[token.type] === "enumMember"));
});

test("materializes explicit Result type annotations independently of throwing-call discovery", () => {
  const source = `
    function inspect(result: Result<i32, String>): i32 {
      return match (result) {
        success(value) => value;
        failure(_) => 1;
      };
    }

    function inspectVoid(result: Result<void, String>): i32 {
      return match (result) {
        success => 0;
        failure(_) => 2;
      };
    }

    function value(): i32 throws String {
      return 42;
    }

    function ready(): void throws String {
      return;
    }

    function main(): i32 {
      const observed = inspect(attempt value());
      const completed = inspectVoid(attempt ready());
      return observed + completed - 42;
    }
  `;
  const fileName = "/tmp/explicit-result-annotation.zs";
  const generated = compileToC(source, fileName);
  assert.match(generated, /Z_Result_i32_String/);
  assert.match(generated, /Z_Result_void_String/);
  const directory = mkdtempSync("/tmp/z-explicit-result-");
  const sourcePath = resolve(directory, "main.zs");
  writeFileSync(sourcePath, source);
  const execution = spawnSync(process.execPath, [cli, "run", sourcePath], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  assert.throws(
    () => check("struct Result { value: i32; }", "/tmp/redeclared-result.zs"),
    /Result is a compiler-provided type and cannot be redeclared/,
  );
});

test("exposes match variants, payload bindings, and source Result names to editor services", () => {
  const source = `
    struct User { id: i32; }
    struct UserError { code: i32; }
    function find(): User throws UserError { return User({ id: 42 }); }
    function main(): i32 {
      const failed = attempt find();
      return match (failed) {
        success(user) => user.id;
        failure(error) => error.code;
      };
    }
  `;
  const failedUse = source.indexOf("failed)") + 1;
  assert.match(hover(source, "match-editor.zs", failedUse)?.contents.value ?? "", /failed: Result<User, UserError>/);
  const successVariant = source.indexOf("success(user)") + 1;
  assert.match(hover(source, "match-editor.zs", successVariant)?.contents.value ?? "", /Result<User, UserError>\.success\(User\)/);
  const userBinding = source.indexOf("user) =>") + 1;
  assert.match(hover(source, "match-editor.zs", userBinding)?.contents.value ?? "", /user: User/);
  const errorBinding = source.indexOf("error) =>") + 1;
  assert.match(hover(source, "match-editor.zs", errorBinding)?.contents.value ?? "", /error: UserError/);

  const tokens = decodeSemanticTokens(semanticTokens(source, "match-editor.zs").data);
  const successPosition = positionForOffset(source, source.indexOf("success(user)"));
  assert.ok(tokens.some((token) => token.line === successPosition.line
    && token.character === successPosition.character
    && semanticTokenTypes[token.type] === "enumMember"));
  const userPosition = positionForOffset(source, source.indexOf("user) =>"));
  assert.ok(tokens.some((token) => token.line === userPosition.line
    && token.character === userPosition.character
    && semanticTokenTypes[token.type] === "variable"
    && token.modifiers === 3));
});

test("requires select to target a value-producing block", () => {
  const source = `
    function main(): i32 {
      select 42;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "orphan-select.zs"),
    /orphan-select\.zs:3:7: error: select requires an enclosing value-producing block/,
  );
});

test("compiles and runs structs as native values", () => {
  const example = resolve(projectRoot, "examples/language/basics/structs.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "original=42 translated=45\n");
});

test("assigns mutable locals and nested value fields", () => {
  const example = resolve(projectRoot, "examples/language/basics/mutation.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "count=2 point=40,2 frame=40,2/640\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /count = z_checked_add_i32\(count, 1\);/);
  assert.match(generated, /\(point\)\.x = 40;/);
  assert.match(generated, /point = \(Z_Point\)\{ \.x = \(point\)\.x, \.y = count \};/);
  assert.match(generated, /\(\(frame\)\.origin\)\.y = 2;/);
});

test("runs explicit mutable receivers while immutable methods remain borrowable", () => {
  const example = resolve(projectRoot, "examples/language/basics/mutable-methods.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=3 snapshot=3 nested=15 temporary=7\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static void Z_Counter_add\(Z_Counter \*self, int32_t amount\)/);
  assert.match(generated, /static int32_t Z_Counter_current\(const Z_Counter \*self\)/);
  assert.match(generated, /static void Z_Panel_bump\(Z_Panel \*self, int32_t amount\)/);
  assert.match(generated, /Z_Counter_add\(&\(counter\), 2\);/);
  assert.match(generated, /Z_Counter_add\(&\(self->counter\), amount\);/);
});

test("requires addressable mutable storage for inout method receivers", () => {
  const immutable = `
    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void {
        this.value = this.value + amount;
      }
    }
    function main(): i32 {
      const counter = Counter({ value: 1 });
      counter.add(2);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, "immutable-receiver.zs"),
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  const temporary = immutable.replace(
    "const counter = Counter({ value: 1 });\n      counter.add(2);",
    "Counter({ value: 1 }).add(2);",
  );
  assert.throws(
    () => compileToC(temporary, "temporary-receiver.zs"),
    /mutable method "add" requires addressable let storage/,
  );

  const transitive = `
    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void {
        this.value = this.value + amount;
      }
    }
    struct Panel {
      counter: Counter;
      function invalid(): void {
        this.counter.add(1);
      }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(transitive, "transitive-receiver.zs"),
    /mutable method "add" cannot be called through immutable binding "this"/,
  );
});

test("keeps receiver capabilities in method signatures", () => {
  const topLevelReceiver = `
    function invalid(inout this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelReceiver, "top-level-receiver.zs"),
    /`inout this` is only valid on a struct method/,
  );

  const topLevelMoveReceiver = `
    function invalid(move this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelMoveReceiver, "top-level-move-receiver.zs"),
    /`move this` is only valid on a struct method/,
  );

  const movedReceiver = `
    struct Resource {
      value: i32;
      function merge(inout this, other: Resource): void {}
      deinit {}
    }
    function main(): i32 {
      let resource = Resource({ value: 1 });
      resource.merge(resource);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(movedReceiver, "moved-receiver.zs"),
    /overlapping inout and value uses of "resource" in one call are not allowed/,
  );
});

test("moves consuming receivers and cleans them up exactly once", () => {
  const example = resolve(projectRoot, "examples/language/ownership/consuming-methods.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=42\nresult=42 copy=7,7\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static Z_Resource Z_Resource_relay\(Z_Resource self\)/);
  assert.match(generated, /static int32_t Z_Resource_finish\(Z_Resource self, int32_t offset\)/);
  assert.match(generated, /self\.id = z_checked_add_i32\(self\.id, offset\);/);
  assert.match(generated, /Z_Resource_relay\(\(_z_live_first_\d+ = false, first\)\)/);
  assert.match(generated, /Z_Resource_finish\(\(_z_live_second_\d+ = false, second\), 2\)/);

  const useAfterConsume = `
    struct Resource {
      id: i32;
      function finish(move this): void {}
      deinit {}
    }
    function main(): i32 {
      const resource = Resource({ id: 1 });
      resource.finish();
      return resource.id;
    }
  `;
  assert.throws(
    () => compileToC(useAfterConsume, "use-after-consuming-method.zs"),
    /use of moved value "resource"/,
  );

  const borrowedConsume = `
    struct Resource {
      id: i32;
      function finish(move this): void {}
      function invalid(): void { this.finish(); }
      deinit {}
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedConsume, "consume-borrowed-receiver.zs"),
    /cannot move the borrowed method receiver `this`; declare `move this`/,
  );

  const overlappingConsume = `
    struct Resource {
      id: i32;
      function merge(move this, in other: Resource): void {}
      deinit {}
    }
    function main(): i32 {
      const resource = Resource({ id: 1 });
      resource.merge(resource);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(overlappingConsume, "overlapping-consuming-receiver.zs"),
    /overlapping move and in uses of "resource" in one call are not allowed/,
  );
});

test("borrows native parameters immutably and mutably", () => {
  const example = resolve(projectRoot, "examples/language/ownership/borrowed-parameters.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=16 literal=7 resource=42\ndrop=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static int32_t read\(const Z_Counter \*counter\)/);
  assert.match(generated, /static void add\(Z_Counter \*counter, int32_t amount\)/);
  assert.match(generated, /static int32_t inspect\(const Z_Resource \*resource\)/);
  assert.match(generated, /add\(counter, 2\);/);
  assert.match(generated, /add\(self, 1\);/);
  assert.match(generated, /read\(&\(counter\)\)/);
  assert.doesNotMatch(generated, /Z_Resource_deinit\(&\(\*resource\)\)/);
});

test("enforces native parameter capabilities at declaration and call sites", () => {
  const missingInout = `
    function increment(inout value: i32): void {
      value = value + 1;
    }
    function main(): i32 {
      let value = 1;
      increment(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingInout, "missing-native-inout.zs"),
    /"increment" requires inout <mutable binding> for parameter 1/,
  );

  const immutableInout = missingInout
    .replace("let value = 1", "const value = 1")
    .replace("increment(value)", "increment(inout value)");
  assert.throws(
    () => compileToC(immutableInout, "immutable-native-inout.zs"),
    /inout argument "value" requires a mutable let binding/,
  );

  const overlapping = `
    function invalid(inout first: i32, inout second: i32): void {}
    function main(): i32 {
      let value = 1;
      invalid(inout value, inout value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(overlapping, "overlapping-inout.zs"),
    /overlapping inout and inout uses of "value" in one call are not allowed/,
  );

  const mutateInput = `
    function invalid(in value: i32): void {
      value = 2;
    }
    function main(): i32 {
      const value = 1;
      invalid(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(mutateInput, "mutate-input.zs"),
    /cannot assign to immutable binding "value"/,
  );

  const legacyTypePosition = `
    function inspect(value: in i32): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(legacyTypePosition, "legacy-capability-order.zs"),
    /expected a type name, found "in"/,
  );
});

test("initializes native out parameters with flow-sensitive checking", () => {
  const example = resolve(projectRoot, "examples/interop/c/native-out.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "17/5=3 remainder=2\nselected=10\nstatus=7 value=42\ninit=40\ndrop=40\ninit=42\nresource=42\ndrop=42\n",
  );

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static void divide\(int32_t value, int32_t divisor, int32_t \*quotient, int32_t \*remainder\)/);
  assert.match(generated, /int32_t quotient;\n\s+int32_t remainder;/);
  assert.match(generated, /divide\(17, 5, &\(quotient\), &\(remainder\)\);/);
  assert.match(generated, /const int32_t _z_out_result_\d+ = initializeWithStatus\(&\(statusValue\)\);\n\s+const int32_t status = _z_out_result_\d+;/);
  assert.match(generated, /Z_Resource resource;\n\s+bool (_z_live_resource_\d+) = false;/);
  assert.match(generated, /if \(_z_live_resource_\d+\) Z_Resource_deinit\(&\(resource\)\);\n\s+_z_live_resource_\d+ = false;\n\s+makeResource\(40, &\(resource\)\);\n\s+_z_live_resource_\d+ = true;/);

  const readBeforeInitialization = `
    function main(): i32 {
      let value: i32;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(readBeforeInitialization, "read-uninitialized.zs"),
    /use of uninitialized value "value"/,
  );

  const maybeInitialized = `
    function main(): i32 {
      let value: i32;
      if (true) { value = 1; }
      return value;
    }
  `;
  assert.throws(
    () => compileToC(maybeInitialized, "maybe-uninitialized.zs"),
    /value "value" may be uninitialized on another control-flow path/,
  );

  const missingOutput = `
    function initialize(flag: boolean, out value: i32): void {
      if (flag) { value = 1; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingOutput, "missing-out-initialization.zs"),
    /out parameter "value" may be uninitialized on a successful return path/,
  );

  const missingModifier = `
    function initialize(out value: i32): void { value = 1; }
    function main(): i32 {
      let value: i32;
      initialize(value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(missingModifier, "missing-out-call-modifier.zs"),
    /"initialize" requires out <mutable binding> for parameter 1/,
  );

  const immutableOutput = `
    function initialize(out value: i32): void { value = 1; }
    function main(): i32 {
      const value = 0;
      initialize(out value);
      return value;
    }
  `;
  assert.throws(
    () => compileToC(immutableOutput, "immutable-out.zs"),
    /out argument "value" requires a mutable let binding/,
  );

  const uninitializedInout = `
    function update(inout value: i32): void { value = value + 1; }
    function main(): i32 {
      let value: i32;
      update(inout value);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(uninitializedInout, "uninitialized-inout.zs"),
    /inout argument "value" must be initialized before the call/,
  );

  const throwingOutput = `
    enum Failure { invalid, }
    function initialize(out value: i32): i32 throws Failure {
      value = 1;
      return value;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(throwingOutput, "throwing-out.zs"),
    /throwing functions with out parameters are not implemented yet/,
  );

  assert.throws(
    () => compileToC("function main(): i32 { let value; return 0; }", "untyped-uninitialized.zs"),
    /cannot infer type of uninitialized let "value"/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value: i32; return 0; }", "uninitialized-const.zs"),
    /const declarations require an initializer/,
  );
});

test("borrowed cleanup values cannot be consumed", () => {
  const source = `
    struct Resource {
      id: i32;
      deinit {}
    }
    function invalid(in resource: Resource): Resource {
      return resource;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "move-borrowed-parameter.zs"),
    /cannot move borrowed parameter "resource"/,
  );
});

test("keeps const values, parameters, and borrowed receivers immutable", () => {
  const immutableLocal = `
    function main(): i32 {
      const value = 1;
      value = 2;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(immutableLocal, "const-assignment.zs"),
    /cannot assign to immutable binding "value"/,
  );

  const immutableField = `
    struct Point { x: i32; }
    function main(): i32 {
      const point = Point({ x: 1 });
      point.x = 2;
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(immutableField, "const-field-assignment.zs"),
    /cannot mutate a field through immutable binding "point"/,
  );

  const immutableParameter = `
    function change(value: i32): i32 {
      value = 2;
      return value;
    }
    function main(): i32 { return change(1); }
  `;
  assert.throws(
    () => compileToC(immutableParameter, "parameter-assignment.zs"),
    /cannot assign to immutable binding "value"/,
  );

  const borrowedReceiver = `
    struct Counter {
      value: i32;
      function change(): i32 {
        this.value = 2;
        return this.value;
      }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedReceiver, "receiver-assignment.zs"),
    /cannot mutate a field through immutable binding "this"/,
  );
});

test("type-checks assignments and replaces cleanup-bearing values safely", () => {
  const wrongType = `
    function main(): i32 {
      let value = 1;
      value = true;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(wrongType, "assignment-type.zs"),
    /expected i32, found boolean/,
  );

  const example = resolve(projectRoot, "examples/language/ownership/replacement.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "make=2\ndrop=1\nlive=5\ndrop=10\nholder=20\ndrop=20\ndrop=5\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /_z_replacement_\d+ = make\(2\);\n\s+if \(_z_live_resource_\d+\) Z_Resource_deinit\(&\(resource\)\);/);
  assert.match(generated, /_z_replacement_\d+ = Z_Resource_bumped\(\(_z_live_resource_\d+ = false, resource\), 3\);/);
  assert.match(generated, /resource = _z_replacement_\d+;\n\s+_z_live_resource_\d+ = true;/);
  assert.match(generated, /Z_Resource_deinit\(&\(\(holder\)\.resource\)\);\n\s+\(holder\)\.resource = _z_replacement_\d+;/);
});

test("runs ARC classes with shared identity and one final deinit", () => {
  const example = resolve(projectRoot, "examples/language/basics/classes.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "first=42 second=42 third=42\ndrop=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z_Counter \{\n\s+size_t _z_refcount;/);
  assert.match(generated, /Z_Counter \* const second = Z_Counter_retain\(first\);/);
  assert.match(generated, /static int32_t inspect\(const Z_Counter \*counter\)/);
  assert.match(generated, /inspect\(third\)/);
  assert.match(generated, /static void Z_Counter_release\(Z_Counter \*value\)/);
  assert.match(generated, /if \(value->_z_refcount == 0\) \{[\s\S]*if \(weak != NULL\) weak->value = NULL;[\s\S]*Z_Counter_deinit\(value\);[\s\S]*free\(value\);/);
});

test("checks explicit trait conformance for structs and classes", () => {
  const validStruct = `
    trait Measured {
      function measure(): i32;
    }
    struct Size implements Measured {
      value: i32;
      function measure(): i32 { return this.value; }
    }
    function main(): i32 {
      const size = Size({ value: 42 });
      return size.measure();
    }
  `;
  assert.match(compileToC(validStruct, "trait-struct.zs"), /Z_Size_measure/);

  const missing = `
    trait Named { function name(): cstring; }
    class User implements Named { id: i32; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missing, "trait-missing.zs"),
    /class "User" does not implement Named\.name/,
  );

  const mismatch = `
    trait Adjustable { function add(inout this, amount: i32): void; }
    class Counter implements Adjustable {
      value: i32;
      function add(amount: i32): void {}
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(mismatch, "trait-mismatch.zs"),
    /does not match trait requirement Adjustable\.add/,
  );

  const unknown = `
    struct Value implements Missing { value: i32; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(unknown, "trait-unknown.zs"), /unknown trait "Missing"/);
});

test("keeps class binding immutability separate from instance mutation", () => {
  const source = `
    class Counter {
      value: i32;
      function add(inout this, amount: i32): void {
        this.value = this.value + amount;
      }
      function consume(move this): i32 { return this.value; }
    }
    function main(): i32 {
      const counter = new Counter({ value: 1 });
      counter.add(2);
      return counter.value;
    }
  `;
  assert.throws(
    () => compileToC(source, "class-move-this.zs"),
    /class methods cannot declare `move this`/,
  );
  const withoutConsume = source.replace("      function consume(move this): i32 { return this.value; }\n", "");
  assert.match(compileToC(withoutConsume, "class-const-mutation.zs"), /Z_Counter_add\(counter, 2\)/);

  const implicitMutation = withoutConsume.replace(
    "      function add(inout this, amount: i32): void {",
    "      function add(amount: i32): void {",
  );
  assert.throws(
    () => compileToC(implicitMutation, "class-implicit-mutation.zs"),
    /cannot mutate a field through immutable binding "this"/,
  );

  const immutableBorrow = withoutConsume.replace(
    "    function main(): i32 {",
    "    function update(in counter: Counter): void { counter.add(1); }\n    function main(): i32 {",
  );
  assert.throws(
    () => compileToC(immutableBorrow, "class-immutable-borrow.zs"),
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );
});

test("exposes Z classes and traits to editor services", () => {
  const source = `
    trait Counted { function value(): i32; }
    class Counter implements Counted {
      count: i32;
      function value(): i32 { return this.count; }
    }
    function main(): i32 {
      const counter = new Counter({ count: 1 });
      Cou;
      return counter.value();
    }
  `;
  const completionOffset = source.indexOf("Cou;") + 3;
  const items = completions(source, "class-editor.zs", completionOffset);
  assert.equal(items.find((item) => item.label === "Counter")?.kind, 7);
  assert.equal(items.find((item) => item.label === "Counted")?.kind, 8);

  const valid = source.replace("      Cou;\n", "");
  const classOffset = valid.indexOf("Counter");
  assert.match(hover(valid, "class-editor.zs", classOffset + 1)?.contents.value ?? "", /class Counter/);
  const traitUse = valid.indexOf("Counted", valid.indexOf("implements"));
  const target = definition(valid, "file:///class-editor.zs", traitUse + 1);
  assert.equal(target?.range.start.line, 1);
});

test("compiles and runs the first native program", () => {
  const example = resolve(projectRoot, "examples/language/basics/first.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z says 42\n");
});

test("zeroes weak class references and breaks owned closure cycles", () => {
  const example = resolve(projectRoot, "examples/language/ownership/weak-references.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "released session 42\nalive=42, expired=-1\nreleased controller 9\nweak closure after release=-1\nreleased session 7\n",
  );

  const generated = compileToC(source, example);
  assert.match(generated, /typedef struct Z_WeakControl/);
  assert.match(generated, /weak->value = NULL/);
  assert.match(generated, /Z_Controller_weak_upgrade/);
  assert.match(generated, /Z_ClosureEnv_\d+_release/);

  const incomplete = source.replace("observer.upgrade()", "observer.up");
  const completionOffset = incomplete.indexOf("observer.up") + "observer.up".length;
  const upgradeCompletion = completions(incomplete, example, completionOffset).find((item) => item.label === "upgrade");
  assert.match(upgradeCompletion?.detail ?? "", /Session throws WeakExpired/);

  const bare = `
    class CompletionSession { id: i32; }
    function main(): i32 {
      const session = new CompletionSession({ id: 1 });
      const observer = weak session;
      observer.;
      return 0;
    }
  `;
  const bareOffset = bare.indexOf("observer.") + "observer.".length;
  const bareCompletion = completions(bare, example, bareOffset).find((item) => item.label === "upgrade");
  assert.match(bareCompletion?.detail ?? "", /CompletionSession throws WeakExpired/);

  const observerUse = source.indexOf("observer.upgrade") + 1;
  assert.match(hover(source, example, observerUse)?.contents.value ?? "", /Weak<Session>/);
  const upgradeUse = source.indexOf("upgrade", source.indexOf("observer.upgrade")) + 1;
  assert.match(hover(source, example, upgradeUse)?.contents.value ?? "", /upgrade\(\): Session throws WeakExpired/);

  const invalidTarget = `function main(): i32 { const value = 42; const observer = weak value; return 0; }`;
  assert.throws(() => compileToC(invalidTarget, "weak-value.zs"), /weak requires a class reference, found i32/);

  const unhandled = source.replace("attempt observer.upgrade()", "observer.upgrade()");
  assert.throws(() => compileToC(unhandled, example), /throwing call requires `attempt` or `try`/);
});

test("editor grammar tracks keywords without reserving Result variants", () => {
  const grammarPath = resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
  const editorPackage = JSON.parse(readFileSync(resolve(projectRoot, "editors/vscode/package.json"), "utf8"));
  const keywordPattern = grammar.repository.keywords.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const constantPattern = grammar.repository.constants.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const operatorPattern = grammar.repository.operators.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const foreignDeclarationPatterns = grammar.repository.foreignDeclarations.patterns;
  const operatorScopes = grammar.repository.operators.patterns.map((pattern: { name: string }) => pattern.name).join(" ");
  const typePattern = grammar.repository.types.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const stringPatterns = JSON.stringify(grammar.repository.strings.patterns);
  const commentPatterns = JSON.stringify(grammar.repository.comments.patterns);
  const selectiveImportPatterns = grammar.repository.imports.patterns[0].patterns
    .map((pattern: { match: string }) => pattern.match)
    .join(" ");
  const matchPattern = grammar.repository.matchPatterns.patterns
    .map((pattern: { match: string }) => pattern.match)
    .join(" ");
  const matchScopes = grammar.repository.matchPatterns.patterns
    .map((pattern: { name: string }) => pattern.name)
    .join(" ");
  const memberCallPattern = new RegExp(grammar.repository.memberCalls.patterns[0].match);
  const qualifiedTypeAnnotation = grammar.repository.typeAnnotations.patterns[0];
  const exportPattern = grammar.repository.keywords.patterns
    .find((pattern: { match: string }) => pattern.match.includes("export"));
  const taskPattern = grammar.repository.keywords.patterns
    .find((pattern: { name: string }) => pattern.name === "keyword.control.concurrent.z");
  const usingPattern = grammar.repository.keywords.patterns
    .find((pattern: { name: string }) => pattern.name === "keyword.control.concurrent.capture.z");
  const ownershipPattern = grammar.repository.keywords.patterns
    .find((pattern: { name: string }) => pattern.name === "keyword.operator.ownership.z");
  const asyncProjection = foreignDeclarationPatterns
    .find((pattern: { name: string }) => pattern.name === "meta.declaration.async-callback-projection.foreign.z");
  const asyncProjectionPattern = new RegExp(asyncProjection?.begin ?? "$^");
  assert.equal(exportPattern?.name, "keyword.control.export.z");
  assert.match("task fetch()", new RegExp(taskPattern?.match ?? "$^"));
  assert.match("task on thread.main", new RegExp(taskPattern?.match ?? "$^"));
  assert.match("using (in value)", new RegExp(usingPattern?.match ?? "$^"));
  assert.doesNotMatch("const using = operation;", new RegExp(usingPattern?.match ?? "$^"));
  assert.match(".yield()", memberCallPattern);
  assert.doesNotMatch("const task = operation();", new RegExp(taskPattern?.match ?? "$^"));
  assert.match("copy value", new RegExp(ownershipPattern?.match ?? "$^"));
  assert.doesNotMatch("const copy = value;", new RegExp(ownershipPattern?.match ?? "$^"));
  assert.match("async completion(value, error) {", asyncProjectionPattern);
  assert.doesNotMatch("thread.spawn(async move (): i32 => {", asyncProjectionPattern);
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /on/);
  assert.match(keywordPattern, /yield/);
  assert.match(keywordPattern, /select/);
  assert.match(keywordPattern, /copy/);
  assert.match(keywordPattern, /move/);
  assert.match(keywordPattern, /task/);
  assert.match(keywordPattern, /using/);
  assert.doesNotMatch(keywordPattern, /await\|task\|on/);
  assert.match(keywordPattern, /view/);
  assert.match(keywordPattern, /weak/);
  assert.match(keywordPattern, /readonly/);
  assert.match(keywordPattern, /type/);
  assert.match(keywordPattern, /new/);
  assert.match(keywordPattern, /constructor/);
  assert.match(keywordPattern, /deinit/);
  assert.match(keywordPattern, /out\|inout/);
  assert.match(keywordPattern, /\bin\b/);
  assert.match(keywordPattern, /\bas\b/);
  assert.match(keywordPattern, /implements/);
  assert.match(keywordPattern, /export/);
  assert.match(keywordPattern, /declare/);
  assert.ok(editorPackage.contributes.languages[0].extensions.includes(".zs"));
  assert.ok(editorPackage.contributes.languages[0].extensions.includes(".zd"));
  assert.ok(!editorPackage.contributes.languages[0].extensions.includes(".z"));
  const foreignPattern = (name: string) => foreignDeclarationPatterns
    .find((pattern: { name: string }) => pattern.name === name);
  assert.equal(foreignPattern("meta.declaration.module.foreign.z").captures[2].name, "storage.type.module.z");
  assert.equal(foreignPattern("meta.declaration.type-lifecycle.foreign.z").captures[1].name, "storage.type.declaration.z");
  assert.equal(foreignPattern("meta.declaration.type-lifecycle.foreign.z").captures[2].name, "entity.name.type.z");
  assert.equal(foreignPattern("meta.declaration.type-capability.foreign.z").captures[1].name, "storage.modifier.capability.z");
  assert.equal(foreignPattern("meta.declaration.thread-contract.foreign.z").captures[1].name, "keyword.control.declaration.thread.z");
  assert.equal(foreignPattern("meta.declaration.thread-capability.foreign.z").captures[1].name, "storage.modifier.capability.thread.z");
  assert.equal(foreignPattern("meta.declaration.parameter.inferred.z").captures[2].name, "variable.parameter.z");
  assert.equal(foreignPattern("meta.declaration.parameter.typed-variadic.z").captures[4].name, "storage.type.primitive.z");
  assert.equal(foreignPattern("meta.declaration.parameter.literal-discriminant.z").captures[3].name, "constant.other.native.z");
  assert.equal(foreignPattern("meta.declaration.lifecycle.foreign.z").captures[2].name, "entity.name.function.destructor.z");
  assert.equal(foreignPattern("meta.declaration.fixed-parameter.foreign.z").captures[1].name, "keyword.control.declaration.fixed.z");
  assert.equal(foreignPattern("meta.declaration.fixed-parameter.foreign.z").captures[2].name, "constant.other.native.z");
  assert.equal(foreignPattern("meta.declaration.status-result.foreign.z").captures[2].name, "keyword.control.declaration.z");
  assert.equal(foreignPattern("meta.declaration.status-result.foreign.z").captures[3].name, "storage.type.inferred.z");
  assert.equal(foreignPattern("meta.declaration.status-success.foreign.z").captures[2].name, "constant.numeric.integer.status.z");
  assert.equal(foreignPattern("meta.declaration.status-success-symbol.foreign.z").captures[2].name, "constant.other.native.z");
  assert.equal(foreignPattern("meta.type.inferred.z").captures[1].name, "storage.type.inferred.z");
  assert.equal(foreignPattern("meta.declaration.callback.foreign.z").captures[1].name, "keyword.control.declaration.callback.z");
  const asyncProjectionGrammar = foreignPattern("meta.declaration.async-callback-projection.foreign.z");
  assert.equal(asyncProjectionGrammar.beginCaptures[1].name, "storage.modifier.async.z");
  assert.equal(asyncProjectionGrammar.beginCaptures[2].name, "entity.name.function.callback.z");
  assert.equal(asyncProjectionGrammar.patterns[1].captures[1].name, "keyword.control.flow.z");
  assert.equal(asyncProjectionGrammar.patterns[1].captures[2].name, "variable.parameter.callback.z");
  assert.equal(foreignPattern("meta.declaration.async-callback.foreign.z").captures[1].name, "storage.modifier.async.z");
  assert.equal(foreignPattern("meta.declaration.async-callback.foreign.z").captures[2].name, "entity.name.function.callback.z");
  assert.equal(foreignPattern("meta.declaration.callback-context.foreign.z").captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(foreignPattern("meta.declaration.callback-context.foreign.z").captures[2].name, "variable.parameter.context.z");
  const callbackThreadGrammar = foreignPattern("meta.declaration.callback-thread.foreign.z");
  assert.equal(callbackThreadGrammar.captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(callbackThreadGrammar.captures[2].name, "constant.language.callback-thread.z");
  assert.match(callbackThreadGrammar.match, /caller\\\|any|caller\|any/);
  const callbackCardinalityGrammar = foreignPattern("meta.declaration.callback-cardinality.foreign.z");
  assert.equal(callbackCardinalityGrammar.captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(callbackCardinalityGrammar.captures[2].name, "constant.language.callback-cardinality.z");
  assert.match(callbackCardinalityGrammar.match, /once\\\|repeatedly|once\|repeatedly/);
  const projectionGrammar = foreignPattern("meta.declaration.buffer-projection.foreign.z");
  assert.equal(projectionGrammar.beginCaptures[1].name, "keyword.control.declaration.projection.z");
  assert.equal(projectionGrammar.beginCaptures[2].name, "storage.modifier.capability.z");
  assert.equal(projectionGrammar.beginCaptures[3].name, "variable.parameter.projection.z");
  assert.equal(projectionGrammar.patterns[0].captures[1].name, "keyword.control.declaration.projection.z");
  assert.equal(projectionGrammar.patterns[0].captures[2].name, "variable.parameter.native.z");
  assert.match(selectiveImportPatterns, /\\bas\\b/);
  assert.doesNotMatch("move () =>", new RegExp(matchPattern));
  assert.match("some(value) =>", new RegExp(matchPattern));
  assert.match(keywordPattern, /while/);
  assert.match(keywordPattern, /for\|of/);
  assert.match(keywordPattern, /break/);
  assert.match(keywordPattern, /continue/);
  assert.match(grammar.repository.declarations.patterns.map((pattern: { match: string }) => pattern.match).join(" "), /trait\|class/);
  assert.match(grammar.repository.declarations.patterns.map((pattern: { match: string }) => pattern.match).join(" "), /\\b\(type\)/);
  assert.match(constantPattern, /true\|false/);
  assert.match(typePattern, /boolean/);
  assert.match(typePattern, /Result/);
  assert.match(typePattern, /Task/);
  assert.match(typePattern, /Weak/);
  assert.doesNotMatch("bool", new RegExp(typePattern));
  assert.match(constantPattern, /null/);
  assert.match(constantPattern, /this/);
  assert.match(operatorPattern, /&&/);
  assert.match(operatorPattern, /<</);
  assert.match(operatorPattern, /\^/);
  assert.match(operatorPattern, /%/);
  assert.match(operatorPattern, /=/);
  assert.match(operatorScopes, /keyword\.operator\.arrow\.z/);
  assert.match(matchPattern, /=>/);
  assert.match(matchScopes, /constant\.language\.enum-member\.z/);
  assert.equal(qualifiedTypeAnnotation.captures[1].name, "variable.other.property.z");
  assert.equal(qualifiedTypeAnnotation.captures[5].name, "entity.name.namespace.z");
  assert.equal(qualifiedTypeAnnotation.captures[6].name, "entity.name.type.z");
  assert.match(typePattern, /Slice/);
  assert.match(typePattern, /Array/);
  assert.match(typePattern, /Option/);
  assert.match(typePattern, /String/);
  assert.match(typePattern, /void/);
  assert.match(stringPatterns, /string\.quoted\.template\.z/);
  assert.match(stringPatterns, /string\.quoted\.single\.z/);
  assert.match(stringPatterns, /meta\.interpolation\.z/);
  assert.match(stringPatterns, /punctuation\.definition\.template-expression\.begin\.z/);
  assert.match(stringPatterns, /punctuation\.definition\.template-expression\.end\.z/);
  assert.match(commentPatterns, /comment\.block\.z/);
  assert.doesNotMatch(keywordPattern, /success|failure/);

  const extension = readFileSync(resolve(projectRoot, "editors/vscode/extension.js"), "utf8");
  assert.match(extension, /6: vscode\.CompletionItemKind\.Variable/);
  assert.match(extension, /20: vscode\.CompletionItemKind\.EnumMember/);
  assert.match(extension, /8: vscode\.CompletionItemKind\.Interface/);
  assert.match(extension, /semanticTokensProvider\?\.legend/);
  assert.match(extension, /new vscode\.SemanticTokensLegend\(legend\.tokenTypes, legend\.tokenModifiers\)/);
  assert.match(extension, /semanticTokensRegistration\?\.dispose\(\)/);
  assert.match(extension, /createFileSystemWatcher/);
  assert.match(extension, /restartLanguageServer/);
});
