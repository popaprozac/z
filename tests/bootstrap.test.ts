import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "bun:test";
import { analyzeSource, check, compileToC, compileToNative } from "../compiler/src/compiler.ts";
import { DiagnosticError, formatDiagnostic } from "../compiler/src/diagnostics.ts";
import { ApiNoteConflictError, mergeApiNotes } from "../compiler/src/foreign-api-notes.ts";
import { normalizeForeignContracts } from "../compiler/src/foreign-contracts.ts";
import type { ForeignFunctionDeclaration } from "../compiler/src/foreign-ir.ts";
import {
  completions,
  definition,
  diagnostics,
  hover,
  semanticTokens,
  semanticTokenTypes,
} from "../compiler/src/language-service.ts";

const projectRoot = resolve(dirnameFromImportMeta(), "..");
const cli = resolve(projectRoot, "compiler/src/cli.ts");

test("emits functions and direct imported C calls", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.puts("hello");
      return 0;
    }
  `;
  const generated = compileToC(source, "memory.z");
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /puts\("hello"\);/);
  assert.doesNotMatch(generated, /stdio\.puts/);
});

test("selectively imports C functions with optional local aliases", () => {
  const example = resolve(projectRoot, "examples/selective-import.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective C imports\nanswer=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /puts\("selective C imports"\);/);
  assert.match(generated, /printf\("answer=%d\\n", 42\);/);
  assert.doesNotMatch(generated, /\bprint\(/);

  const shadowed = `
    import { printf as value } from "stdio.h";
    function main(): i32 {
      const value = 7;
      return value;
    }
  `;
  const shadowedC = compileToC(shadowed, "selective-shadow.z");
  assert.match(shadowedC, /const int32_t value = 7;/);
  assert.match(shadowedC, /return value;/);
  assert.doesNotMatch(shadowedC, /return printf;/);
});

test("keeps unselected C functions out of scope", () => {
  const source = `
    import { puts } from "stdio.h";
    function main(): i32 {
      printf("not imported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "selective-scope.z"),
    /unknown function "printf"/,
  );

  const missing = source.replace("puts", "not_a_real_c_function").replace("printf", "not_a_real_c_function");
  assert.throws(
    () => compileToC(missing, "selective-missing.z"),
    /header "stdio\.h" has no declaration "not_a_real_c_function"/,
  );
});

test("loads explicit Z exports through selective and namespace module imports", () => {
  const example = resolve(projectRoot, "examples/modules/main.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "module point=Point { x: 21, y: 21 }, total=42\n");

  const analysis = analyzeSource(source, example);
  assert.equal(analysis.sourceModules.size, 3);
  assert.ok(analysis.program.functions.find((item) => item.name.endsWith("_add"))!.location.offset > source.length);
  const generated = compileToC(source, example);
  assert.match(generated, /__z_module_\d+_translate/);
  assert.match(generated, /__z_module_\d+_add/);
  assert.doesNotMatch(generated, /#include <\.\/geometry\.z>/);
  assert.doesNotMatch(generated, /#include <\.\/math\.z>/);
});

test("diagnoses missing Z exports, missing files, cycles, and module binding collisions", () => {
  const directory = mkdtempSync("/tmp/z-modules-");
  const main = resolve(directory, "main.z");
  const values = resolve(directory, "values.z");
  writeFileSync(values, "function hidden(): i32 { return 42; }\n");

  const missingExport = `import { hidden } from "./values.z"; function main(): i32 { return hidden(); }`;
  assert.throws(() => compileToC(missingExport, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /has no export "hidden"/);
    return true;
  });

  const missingFile = `import missing from "./missing.z"; function main(): i32 { return 0; }`;
  assert.throws(() => compileToC(missingFile, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /could not find Z module/);
    return true;
  });

  const left = resolve(directory, "left.z");
  const right = resolve(directory, "right.z");
  writeFileSync(left, `import right from "./right.z"; export function left(): i32 { return right.right(); }`);
  writeFileSync(right, `import left from "./left.z"; export function right(): i32 { return left.left(); }`);
  const cycleMain = `import left from "./left.z"; function main(): i32 { return left.left(); }`;
  assert.throws(() => compileToC(cycleMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0601");
    assert.match(error.message, /left\.z -> right\.z -> left\.z/);
    return true;
  });

  writeFileSync(values, "export function answer(): i32 { return 42; }\n");
  const collision = `
    import { answer } from "./values.z";
    function answer(): i32 { return 0; }
    function main(): i32 { return answer(); }
  `;
  assert.throws(() => compileToC(collision, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0603");
    assert.match(error.message, /duplicate module binding "answer"/);
    return true;
  });

  const broken = resolve(directory, "broken.z");
  writeFileSync(broken, `export function broken(): i32 { return missing; }`);
  const brokenMain = `import { broken } from "./broken.z"; function main(): i32 { return broken(); }`;
  assert.throws(() => compileToC(brokenMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.match(error.fileName, /broken\.z$/);
    assert.match(error.message, /broken\.z:1:40: error: unknown name "missing"/);
    return true;
  });
  const editorDiagnostic = diagnostics(brokenMain, main)[0];
  assert.match(editorDiagnostic.message, /broken\.z: unknown name "missing"/);
  assert.match(editorDiagnostic.relatedInformation?.[0].location.uri ?? "", /broken\.z$/);
});

test("preserves generic inference and local shadowing across Z modules", () => {
  const directory = mkdtempSync("/tmp/z-generic-modules-");
  const library = resolve(directory, "library.z");
  const main = resolve(directory, "main.z");
  writeFileSync(library, `
    export struct Pair<T> { first: T; second: T; }
    class HiddenCounter { value: i32; }
    struct HiddenResource { value: i32; deinit {} }
    function helper(): i32 { return 0; }
    export function first<T>(in pair: Pair<T>): T { return pair.first; }
    export function shadowed(): i32 { const helper = 42; return helper; }
  `);
  const source = `
    import library from "./library.z";
    import { first } from "./library.z";
    function main(): i32 {
      const pair = library.Pair({ first: 20, second: 22 });
      return library.first<i32>(pair) + first(pair) + library.shadowed() - 82;
    }
  `;
  const generated = compileToC(source, main);
  assert.match(generated, /__z_mono___z_module_\d+_Pair_i32/);
  const sourcePath = resolve(directory, "main.z");
  writeFileSync(sourcePath, source);
  const result = spawnSync(process.execPath, [cli, "run", sourcePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("provides completion, hover, definitions, and semantic tokens across Z modules", () => {
  const example = resolve(projectRoot, "examples/modules/main.z");
  const source = readFileSync(example, "utf8");
  const uri = `file://${example}`;

  const incompleteMember = source.replace("geometry.total", "geometry.to");
  const memberOffset = incompleteMember.indexOf("geometry.to") + "geometry.to".length;
  const memberItems = completions(incompleteMember, example, memberOffset);
  assert.equal(memberItems.find((item) => item.label === "total")?.kind, 3);
  const incompleteType = source.replace("geometry.Point", "geometry.P");
  const typeOffset = incompleteType.indexOf("geometry.P") + "geometry.P".length;
  assert.equal(completions(incompleteType, example, typeOffset).find((item) => item.label === "Point")?.kind, 22);

  const namespaceUse = source.indexOf("geometry.Point") + 1;
  assert.match(hover(source, example, namespaceUse)?.contents.value ?? "", /Z module/);
  const pointUse = source.indexOf("Point", source.indexOf("geometry.Point")) + 1;
  assert.match(hover(source, example, pointUse)?.contents.value ?? "", /struct Point/);
  const moveUse = source.indexOf("move(origin") + 1;
  const moveHover = hover(source, example, moveUse)?.contents.value ?? "";
  assert.match(moveHover, /function move\(point: Point, dx: i32, dy: i32\): Point/);
  assert.match(moveHover, /Alias of `translate` from `"\.\/geometry\.z"`\./);
  const moveDeclaration = source.indexOf("move", source.indexOf("translate as")) + 1;
  assert.match(hover(source, example, moveDeclaration)?.contents.value ?? "", /Alias of `translate`/);

  const totalUse = source.indexOf("total(moved") + 1;
  const totalDefinition = definition(source, uri, totalUse);
  assert.match(totalDefinition?.uri ?? "", /geometry\.z$/);
  assert.equal(totalDefinition?.range.start.line, 11);
  const moveDefinition = definition(source, uri, moveUse);
  assert.match(moveDefinition?.uri ?? "", /geometry\.z$/);
  assert.equal(moveDefinition?.range.start.line, 7);

  const symbolSource = source.replace("return 0;", "mov; return 0;");
  const symbolOffset = symbolSource.indexOf("mov;") + 3;
  const moveCompletion = completions(symbolSource, example, symbolOffset).find((item) => item.label === "move");
  assert.equal(moveCompletion?.kind, 3);
  assert.match(moveCompletion?.detail ?? "", /function move\(point: Point, dx: i32, dy: i32\): Point/);
  assert.match(moveCompletion?.detail ?? "", /alias of translate from "\.\/geometry\.z"/);

  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const namespacePosition = positionForOffset(source, source.indexOf("geometry.Point"));
  const pointPosition = positionForOffset(source, source.indexOf("Point", source.indexOf("geometry.Point")));
  assert.ok(tokens.some((token) => token.line === namespacePosition.line
    && token.character === namespacePosition.character
    && token.type === semanticTokenTypes.indexOf("namespace")));
  assert.ok(tokens.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));
});

test("suggests Z tokens while source and declaration syntax is incomplete", () => {
  const functionItems = completions("fun", "tokens.z", 3);
  assert.equal(functionItems.find((item) => item.label === "function")?.kind, 14);
  assert.equal(functionItems.find((item) => item.label === "function")?.detail, "Z keyword");

  const returnItems = completions("function main(): i32 { ret", "tokens.z", 26);
  assert.equal(returnItems.find((item) => item.label === "return")?.kind, 14);

  const declaration = `declare module "vendor.h" {\n  exp`;
  const declarationItems = completions(declaration, "vendor.h.zd", declaration.length);
  assert.equal(declarationItems.find((item) => item.label === "export")?.detail, "Z declaration keyword");
  assert.equal(declarationItems.some((item) => item.label === "match"), false);

  const capability = `declare module "vendor.h" {\n  export function use(ino`;
  const capabilityItems = completions(capability, "vendor.h.zd", capability.length);
  assert.equal(capabilityItems.find((item) => item.label === "inout")?.kind, 14);

  const inferredItems = completions("_", "vendor.h.zd", 1);
  assert.equal(inferredItems.find((item) => item.label === "_")?.detail, "infer type from the native declaration");

  const callbackContract = `declare module "vendor.h" {\n  export function apply(value: _, context: _, in operation: _): _ {\n    cal`;
  const callbackItems = completions(callbackContract, "vendor.h.zd", callbackContract.length);
  assert.equal(callbackItems.find((item) => item.label === "callback")?.detail, "Z declaration keyword");
  const contextItems = completions("cont", "vendor.h.zd", 4);
  assert.equal(contextItems.find((item) => item.label === "context")?.kind, 14);
});

test("analyzes export-only files as modules while executable commands still require main", () => {
  const moduleFile = resolve(projectRoot, "examples/modules/geometry.z");
  const source = readFileSync(moduleFile, "utf8");
  assert.doesNotThrow(() => check(source, moduleFile));
  assert.deepEqual(diagnostics(source, moduleFile), []);

  const pointOffset = source.indexOf("Point") + 1;
  assert.match(hover(source, moduleFile, pointOffset)?.contents.value ?? "", /struct Point/);
  assert.ok(semanticTokens(source, moduleFile).data.length > 0);

  const checkResult = spawnSync(process.execPath, [cli, "check", moduleFile], { encoding: "utf8" });
  assert.equal(checkResult.status, 0, checkResult.stderr);
  assert.match(checkResult.stdout, /geometry\.z: ok/);

  assert.throws(() => compileToNative(source, moduleFile), /program must declare `function main\(\): i32`/);
  const runResult = spawnSync(process.execPath, [cli, "run", moduleFile], { encoding: "utf8" });
  assert.notEqual(runResult.status, 0);
  assert.match(runResult.stderr, /program must declare `function main\(\): i32`/);
});

test("resolves native headers relative to the Z module that imports them", () => {
  const directory = mkdtempSync("/tmp/z-native-module-");
  const libraryDirectory = resolve(directory, "library");
  mkdirSync(libraryDirectory);
  writeFileSync(resolve(libraryDirectory, "native.h"), `static inline int z_module_answer(void) { return 42; }\n`);
  writeFileSync(resolve(libraryDirectory, "native.z"), `
    import native from "native.h";
    export function answer(): i32 { return native.z_module_answer(); }
  `);
  const main = resolve(directory, "main.z");
  const source = `
    import { answer } from "./library/native.z";
    function main(): i32 { return answer() - 42; }
  `;
  writeFileSync(main, source);
  const artifact = compileToNative(source, main);
  assert.match(artifact.source, /#include <native\.h>/);
  assert.ok(artifact.includeDirectories.some((item) => item.endsWith("/library")));
  const result = spawnSync(process.execPath, [cli, "run", main], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("selectively imports C types and constants with the same aliases used by functions", () => {
  const example = resolve(projectRoot, "examples/selective-declarations.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective point=23,19 score=42\n");

  const generated = compileToC(source, example);
  assert.match(generated, /static ZDirection direction\(void\)/);
  assert.match(generated, /return ZForward;/);
  assert.match(generated, /static ZPoint shift\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /return z_translate\(point, direction\(\), amount\);/);
  assert.match(generated, /const ZPoint point = \(ZPoint\)\{ \.x = 20, \.y = 19 \};/);
  assert.doesNotMatch(generated, /\b(Point|Direction|Count|forward|translate|score)\s*\(/);

  const translateUse = source.lastIndexOf("translate(") + 2;
  const translateDefinition = definition(source, `file://${example}`, translateUse);
  assert.match(translateDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(translateDefinition?.range.start.line, 31);
});

test("keeps unselected C types and constants out of scope", () => {
  const missingType = `
    import { z_score } from "tests/fixtures/geometry.h";
    function inspect(point: ZPoint): i32 { return z_score(point); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingType, resolve(projectRoot, "selective-type-scope.z")),
    /unknown type "ZPoint"/,
  );

  const missingConstant = `
    import { ZDirection } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const direction: ZDirection = ZForward;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(missingConstant, resolve(projectRoot, "selective-constant-scope.z")),
    /unknown name "ZForward"/,
  );
});

test("shares imported C type identity across namespace and selective imports", () => {
  const source = `
    import geometry from "tests/fixtures/geometry.h";
    import { ZPoint as Point, z_read } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point: Point = geometry.ZPoint({ x: 20, y: 22 });
      return z_read(point);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "selective-record.z"));
  assert.match(generated, /return z_read\(&\(point\)\);/);
});

test("imports C function signatures through Clang", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const written = stdio.puts("typed");
      return written;
    }
  `;
  const generated = compileToC(source, "typed-header.z");
  assert.match(generated, /const int32_t written = puts\("typed"\);/);
  assert.equal(analyzeSource(source, "typed-header.z").foreignModules.get("stdio")?.producer, "clang");
});

test("passes typed Z functions to call-only C callbacks with optional context adapters", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-main.z");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /z_apply_i32\(6, 7, multiply\)/);
  assert.match(generated, /z_apply_twice_i32\(40, __z_closure_call_[0-9]+\)/);
  assert.match(
    generated,
    /z_apply_context_i32\(40, \(void \*\)&\(addOffset\), __z_c_callback_Z_Function_[0-9a-f]+_context_1\)/,
  );
  assert.match(
    generated,
    /static __attribute__\(\(unused\)\) int32_t __z_c_callback_Z_Function_[0-9a-f]+_context_1\(int32_t argument1, void \*callback_context\)/,
  );
  assert.match(generated, /Z_Function_[0-9a-f]+_c_escape_box\(Z_Function_[0-9a-f]+ value\)/);
  assert.match(generated, /Z_Function_[0-9a-f]+_c_escape_box_release\(void \*context\)/);
  assert.match(
    generated,
    /z_register_context_callback\(__z_c_callback_Z_Function_[0-9a-f]+_context_1, Z_Function_[0-9a-f]+_c_escape_box\(escaped\), Z_Function_[0-9a-f]+_c_escape_box_release\)/,
  );

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "escape-drop=2\n");

  const callbackUse = source.indexOf("operation);") + 1;
  assert.match(hover(source, fixture, callbackUse)?.contents.value ?? "", /operation: \(left: i32, right: i32\) => i32/);
  const importedUse = source.indexOf("z_apply_i32") + 1;
  assert.match(
    hover(source, fixture, importedUse)?.contents.value ?? "",
    /callback: \(argument1: i32, argument2: i32\) => i32/,
  );
  const contextUse = source.indexOf("z_apply_context_i32") + 1;
  const contextDetail = hover(source, fixture, contextUse)?.contents.value ?? "";
  assert.match(contextDetail, /z_apply_context_i32\(value: i32, callback: \(argument1: i32\) => i32\): i32/);
  const escapingUse = source.indexOf("z_register_context_callback") + 1;
  assert.match(
    hover(source, fixture, escapingUse)?.contents.value ?? "",
    /z_register_context_callback\(callback: \(argument1: i32\) => i32\): void/,
  );
  const completionSource = source.replace("callbacks.z_apply_i32", "callbacks.z_app");
  const completionOffset = completionSource.indexOf("callbacks.z_app") + "callbacks.z_app".length;
  assert.match(
    completions(completionSource, fixture, completionOffset).find((item) => item.label === "z_apply_i32")?.detail ?? "",
    /callback: \(argument1: i32, argument2: i32\) => i32/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/callbacks.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const declarationFunction = declarationSource.indexOf("z_apply_i32") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declarationFunction)?.contents.value ?? "",
    /z_apply_i32\(left: i32, right: i32, callback: \(argument1: i32, argument2: i32\) => i32\): i32/,
  );
  const declarationCallback = declarationSource.indexOf("callback: _") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declarationCallback)?.contents.value ?? "",
    /in callback: \(argument1: i32, argument2: i32\) => i32/,
  );
  const declarationCallbackType = declarationSource.indexOf("callback: _") + "callback: ".length;
  assert.match(
    hover(declarationSource, declarationFile, declarationCallbackType)?.contents.value ?? "",
    /_: \(argument1: i32, argument2: i32\) => i32/,
  );
  const declarationCompletionSource = declarationSource.replace("in callback: _", "in cal");
  const declarationCompletionOffset = declarationCompletionSource.indexOf("in cal") + "in cal".length;
  assert.equal(
    completions(declarationCompletionSource, declarationFile, declarationCompletionOffset)
      .find((item) => item.label === "callback")?.insertText,
    "callback: _",
  );
  const callbackRelation = declarationSource.indexOf("callback callback") + "callback ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, callbackRelation)?.contents.value ?? "",
    /call-scoped callback using native context context/,
  );
  const contextRelation = declarationSource.indexOf("context context") + "context ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, contextRelation)?.contents.value ?? "",
    /context: void \*.*native context for callback callback/,
  );
  const callbackRelationSource = declarationSource.replace("callback callback {", "callback call {");
  const callbackRelationOffset = callbackRelationSource.indexOf("callback call") + "callback call".length;
  assert.equal(
    completions(callbackRelationSource, declarationFile, callbackRelationOffset)
      .find((item) => item.label === "callback")?.kind,
    6,
  );
  const contextRelationSource = declarationSource.replace("context context;", "context cont;");
  const contextRelationOffset = contextRelationSource.indexOf("context cont") + "context cont".length;
  assert.equal(
    completions(contextRelationSource, declarationFile, contextRelationOffset)
      .find((item) => item.label === "context")?.kind,
    6,
  );

  const wrongShape = source.replace(
    "function multiply(left: i32, right: i32): i32 {\n  return left * right;\n}",
    "function multiply(left: i32): i32 {\n  return left;\n}",
  );
  assert.throws(
    () => compileToC(wrongShape, fixture),
    /expected \(argument1: i32, argument2: i32\) => i32, found \(left: i32\) => i32/,
  );

  const capturedCallback = source.replace(
    "const add: (left: i32, right: i32) => i32 =\n    (left: i32, right: i32): i32 => left + right;",
    "const capturedOffset = 0;\n  const add: (left: i32, right: i32) => i32 =\n    move (left: i32, right: i32): i32 => left + right + capturedOffset;",
  );
  const capturedDiagnostic = diagnostics(capturedCallback, fixture).find((diagnostic) => diagnostic.code === "Z0213");
  assert.match(capturedDiagnostic?.message ?? "", /function value carries or may carry an environment/);

  const unclassified = source.replace(
    "const product = callbacks.z_apply_i32(6, 7, operation);",
    "callbacks.z_store_callback(operation); const product = callbacks.z_apply_i32(6, 7, operation);",
  );
  assert.throws(
    () => compileToC(unclassified, fixture),
    /z_store_callback.*unsupported type.*ZBinaryCallback/,
  );
});

test("passes contextual inline closures directly to imported C callbacks", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-inline.z");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /z_apply_i32\(6, 7, __z_closure_call_[0-9]+\)/);
  assert.match(generated, /z_apply_context_i32\(40, \(void \*\)&\(_z_argument_[0-9]+\), __z_c_callback_/);
  assert.match(generated, /z_register_context_callback\(__z_c_callback_[^,]+, Z_Function_[0-9a-f]+_c_escape_box\(_z_argument_[0-9]+\)/);

  const parameter = source.indexOf("(left, right)") + 2;
  assert.match(hover(source, fixture, parameter)?.contents.value ?? "", /left: i32/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "inline-escape-drop=2\n");
});

test("rejects invalid C callback and context API-note pairs", () => {
  const directory = mkdtempSync("/tmp/z-callback-context-notes-");
  const header = resolve(directory, "invalid-context.h");
  const sourceFile = resolve(directory, "main.z");
  writeFileSync(header, `
    #include <stdint.h>
    typedef int32_t (*InvalidContextCallback)(int32_t value, void *context);
    static inline int32_t invalid_context(
      int32_t value,
      int32_t *not_context,
      InvalidContextCallback callback
    ) {
      (void)not_context;
      (void)callback;
      return value;
    }
  `);
  writeFileSync(`${header}.zapi.json`, JSON.stringify({
    functions: {
      invalid_context: {
        parameters: {
          "2": {
            callback: {
              lifetime: "call",
              context: { parameter: 1, callbackParameter: 1 },
            },
          },
        },
      },
    },
  }));
  const source = `
    import invalid from "invalid-context.h";
    function identity(value: i32): i32 { return value; }
    function main(): i32 { return invalid.invalid_context(42, identity); }
  `;
  writeFileSync(sourceFile, source);
  assert.throws(
    () => compileToC(source, sourceFile),
    /do not describe a valid callback and void \* context pair/,
  );
});

test("rejects escaping C callbacks without complete release and threading contracts", () => {
  const directory = mkdtempSync("/tmp/z-escaping-callback-notes-");
  const header = resolve(directory, "escaping.h");
  const sourceFile = resolve(directory, "main.z");
  writeFileSync(header, `
    #include <stdint.h>
    typedef int32_t (*EscapingCallback)(int32_t value, void *context);
    typedef void (*EscapingRelease)(void *context);
    static inline void retain_callback(EscapingCallback callback, void *context, EscapingRelease release) {
      (void)callback;
      (void)context;
      (void)release;
    }
  `);
  writeFileSync(`${header}.zapi.json`, JSON.stringify({
    functions: {
      retain_callback: {
        parameters: {
          "0": {
            callback: {
              lifetime: "escape",
              context: { parameter: 1, callbackParameter: 1 },
            },
          },
        },
      },
    },
  }));
  const source = `
    import escaping from "escaping.h";
    function identity(value: i32): i32 { return value; }
    function main(): i32 { escaping.retain_callback(identity); return 0; }
  `;
  writeFileSync(sourceFile, source);
  const diagnostic = diagnostics(source, sourceFile).find((item) => item.code === "Z0214");
  assert.match(diagnostic?.message ?? "", /require caller-thread context and release contracts/);
});

test("rejects unknown functions from imported headers", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.not_a_real_function("nope");
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-name.z"),
    /header "stdio\.h" has no function "not_a_real_function"/,
  );
});

test("checks fixed C arguments and variadic boundaries", () => {
  const wrongType = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.puts(42);
    }
  `;
  assert.throws(
    () => compileToC(wrongType, "foreign-type.z"),
    /expected cstring, found i32/,
  );

  const missingFormat = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.printf();
    }
  `;
  assert.throws(
    () => compileToC(missingFormat, "foreign-variadic.z"),
    /C function "printf" expects at least 1 argument\(s\), found 0/,
  );
});

test("reports unsupported C signatures at the Z call site", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.freopen("file", "r", "unsupported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-pointer.z"),
    /C function "freopen" uses unsupported type "FILE \*"/,
  );
});

test("narrows, borrows, consumes, and cleans up owned C handles", () => {
  const example = resolve(projectRoot, "examples/foreign-handle.z");
  const exampleSource = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrote handle\n");
  assert.equal(readFileSync("/tmp/z-lang-foreign-handle.txt", "utf8"), "owned by Z\n");

  const declarationOffset = exampleSource.indexOf("file =") + 1;
  const guardOffset = exampleSource.indexOf("file == null") + 1;
  const narrowedOffset = exampleSource.indexOf("file);", exampleSource.indexOf("fputs")) + 1;
  assert.match(hover(exampleSource, example, declarationOffset)?.contents.value ?? "", /file: FILE \* \| null/);
  assert.match(hover(exampleSource, example, guardOffset)?.contents.value ?? "", /file: FILE \* \| null/);
  assert.match(hover(exampleSource, example, narrowedOffset)?.contents.value ?? "", /file: FILE \*(?! \| null)/);

  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-double-close.txt", "w");
      if (file == null) { return 1; }
      stdio.fclose(file);
      return stdio.fclose(file);
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-consume.z"),
    /use of moved value "file"/,
  );
});

test("discovers owned-handle contracts from adjacent Z declaration files", () => {
  const source = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      const handle = handles.z_test_open();
      if (handle == null) { return 1; }
      return handles.z_test_use(handle);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "foreign-local-notes.z"));
  assert.match(generated, /ZTestHandle \* const handle = z_test_open\(\);/);
  assert.match(generated, /if \(_z_live_handle_0 && handle != NULL\) z_test_close\(handle\);/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/foreign-handles.h.zd");
  assert.deepEqual(diagnostics(readFileSync(declarationFile, "utf8"), declarationFile), []);
  const declarationCheck = spawnSync(process.execPath, [cli, "check", declarationFile], { encoding: "utf8" });
  assert.equal(declarationCheck.status, 0, declarationCheck.stderr);
  assert.match(declarationCheck.stdout, /foreign-handles\.h\.zd: ok/);

  const declarationSource = readFileSync(declarationFile, "utf8");
  const functionOffset = declarationSource.indexOf("z_test_open") + 2;
  assert.match(hover(declarationSource, declarationFile, functionOffset)?.contents.value ?? "", /z_test_open\(\): ZTestHandle \* \| null/);
  const returnTypeOffset = declarationSource.indexOf("_ | null");
  assert.match(hover(declarationSource, declarationFile, returnTypeOffset)?.contents.value ?? "", /_: ZTestHandle \* \| null; deinit z_test_close/);
  const closeOffset = declarationSource.indexOf("z_test_close", declarationSource.indexOf("deinit")) + 2;
  assert.match(hover(declarationSource, declarationFile, closeOffset)?.contents.value ?? "", /deinitializer for z_test_open result/);
  const handleParameterOffset = declarationSource.indexOf("handle: _") + 2;
  assert.match(hover(declarationSource, declarationFile, handleParameterOffset)?.contents.value ?? "", /move handle: ZTestHandle \*/);
  const handleTypeOffset = declarationSource.indexOf("handle: _") + "handle: ".length;
  assert.match(hover(declarationSource, declarationFile, handleTypeOffset)?.contents.value ?? "", /_: ZTestHandle \*/);

  const functionCompletionSource = declarationSource.replace("z_test_open", "z_test_op");
  const functionCompletionOffset = functionCompletionSource.indexOf("z_test_op") + "z_test_op".length;
  assert.equal(
    completions(functionCompletionSource, declarationFile, functionCompletionOffset).find((item) => item.label === "z_test_open")?.kind,
    3,
  );
  const parameterCompletionSource = declarationSource.replace("z_test_use(in handle: _)", "z_test_use(in han)");
  const parameterCompletionOffset = parameterCompletionSource.indexOf("han)") + 3;
  const parameterCompletion = completions(parameterCompletionSource, declarationFile, parameterCompletionOffset)
    .find((item) => item.label === "handle");
  assert.equal(parameterCompletion?.insertText, "handle: _");
  const deinitCompletionSource = declarationSource.replace("deinit z_test_close", "deinit z_test_cl");
  const deinitCompletionOffset = deinitCompletionSource.indexOf("z_test_cl") + "z_test_cl".length;
  assert.equal(
    completions(deinitCompletionSource, declarationFile, deinitCompletionOffset).find((item) => item.label === "z_test_close")?.kind,
    3,
  );

  const example = resolve(projectRoot, "examples/declared-handle.z");
  const exampleSource = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "declared handle=42\n");
  const exampleC = compileToC(exampleSource, example);
  assert.match(exampleC, /typedef ZDeclaredHandle \*Z_Option_/);
  assert.match(exampleC, /if \(_z_match_\d+ != NULL\)/);
  assert.match(exampleC, /z_declared_close\(value\);/);
  assert.doesNotMatch(exampleC, /struct Z_Option/);

  const optionBinding = exampleSource.indexOf("handle = Option") + 2;
  assert.match(hover(exampleSource, example, optionBinding)?.contents.value ?? "", /handle: Option<ZDeclaredHandle \*>/);
  const payloadBinding = exampleSource.indexOf("value)", exampleSource.indexOf("some(")) + 2;
  assert.match(hover(exampleSource, example, payloadBinding)?.contents.value ?? "", /value: ZDeclaredHandle \*/);

  const narrowedSource = exampleSource.replace(
    "const handle = Option.fromNullable(native.z_declared_open(value));",
    `const raw = native.z_declared_open(value);
  if (raw == null) return -1;
  const handle = Option.fromNullable(raw);`,
  );
  assert.throws(
    () => compileToC(narrowedSource, example),
    /Option\.fromNullable requires ZDeclaredHandle \* \| null, found owned ZDeclaredHandle \*/,
  );
});

test("diagnoses malformed and mismatched Z declaration contracts", () => {
  const malformed = `
    declare module "contract.h" {
      export function known(): invented;
    }
  `;
  const malformedDiagnostic = diagnostics(malformed, "/tmp/contract.h.zd")[0];
  assert.equal(malformedDiagnostic.code, "Z0801");
  assert.match(malformedDiagnostic.message, /requires `_` for a header-derived type/);

  const executableContract = `
    declare module "contract.h" {
      export function known(): _ {
        return 1;
      }
    }
  `;
  const executableDiagnostic = diagnostics(executableContract, "/tmp/contract.h.zd")[0];
  assert.equal(executableDiagnostic.code, "Z0801");
  assert.match(executableDiagnostic.message, /expected "deinit" or "callback" in foreign function contract/);

  const mismatchDirectory = mkdtempSync("/tmp/z-zd-module-");
  const mismatchHeader = resolve(mismatchDirectory, "contract.h");
  const mismatchSource = resolve(mismatchDirectory, "main.z");
  writeFileSync(mismatchHeader, "int known(void);\n");
  writeFileSync(`${mismatchHeader}.zd`, `
    declare module "other.h" {
      export function known(): _;
    }
  `);
  const imported = `import contract from "contract.h"; function main(): i32 { return contract.known(); }`;
  const mismatch = diagnostics(imported, mismatchSource)[0];
  assert.equal(mismatch.code, "Z0801");
  assert.match(mismatch.message, /does not match imported header "contract\.h"/);

  const parameterDirectory = mkdtempSync("/tmp/z-zd-parameter-");
  const parameterHeader = resolve(parameterDirectory, "contract.h");
  const parameterSource = resolve(parameterDirectory, "main.z");
  writeFileSync(parameterHeader, "int use(void *handle);\n");
  writeFileSync(`${parameterHeader}.zd`, `
    declare module "contract.h" {
      export function use(in missing: _): _;
    }
  `);
  const missingParameter = diagnostics(imported.replace("known", "use"), parameterSource)[0];
  assert.equal(missingParameter.code, "Z0801");
  assert.match(missingParameter.message, /does not match native parameter "handle"/);

  const callbackDirectory = mkdtempSync("/tmp/z-zd-callback-");
  const callbackHeader = resolve(callbackDirectory, "contract.h");
  const callbackSource = resolve(callbackDirectory, "main.z");
  writeFileSync(callbackHeader, `
    typedef int (*Operation)(int value, void *context);
    static inline int apply(int value, void *context, Operation operation) {
      return operation(value, context);
    }
  `);
  writeFileSync(`${callbackHeader}.zd`, `
    declare module "contract.h" {
      export function apply(value: _, context: _, in operation: _): _ {
        callback operation {
          context missing;
        }
      }
    }
  `);
  const callbackImport = `import contract from "contract.h"; function identity(value: i32): i32 { return value; } function main(): i32 { return contract.apply(42, identity); }`;
  const missingContext = diagnostics(callbackImport, callbackSource)[0];
  assert.equal(missingContext.code, "Z0801");
  assert.match(missingContext.message, /unknown context parameter "missing"/);
});

test("merges API-note sources without allowing safety contracts to conflict", () => {
  const merged = mergeApiNotes([
    {
      name: "base",
      notes: { functions: { open: { return: { ownership: "owned", release: "close" } } } },
    },
    {
      name: "overlay",
      notes: { functions: { open: { return: { nullable: false } } } },
    },
  ]);
  assert.deepEqual(merged.functions?.open.return, {
    ownership: "owned",
    release: "close",
    nullable: false,
  });
  assert.throws(
    () => mergeApiNotes([
      { name: "base", notes: { functions: { use: { parameters: { "0": { ownership: "borrowed" } } } } } },
      { name: "overlay", notes: { functions: { use: { parameters: { "0": { ownership: "consuming" } } } } } },
    ]),
    (error) => error instanceof ApiNoteConflictError
      && error.path === "functions.use.parameters.0.ownership"
      && error.firstSource === "base"
      && error.secondSource === "overlay",
  );
});

test("normalizes producer declarations without exposing Clang nodes to FIIR consumers", () => {
  const declaration: ForeignFunctionDeclaration = {
    name: "answer",
    namespacePath: [],
    qualifiedName: "answer",
    overloads: [{
      name: "answer",
      nativeName: "answer",
      returnType: { nativeName: "int" },
      parameters: [],
      variadic: false,
      nativeSignature: "int (void)",
      metadata: { source: null, availability: [] },
    }],
  };
  const normalized = normalizeForeignContracts(
    new Map([[declaration.name, declaration]]),
    new Map(),
    {},
    {
      mapType: (spelling) => ({
        kind: "z",
        name: spelling.nativeName === "void" ? "void" : "i32",
        cName: spelling.nativeName,
      }),
      mapCallbackContext: (cName) => ({ kind: "unsupported", cName }),
      mapCallbackRelease: (cName) => ({ kind: "unsupported", cName }),
    },
    "cached-producer.fiir",
    { offset: 0, line: 1, column: 1 },
  );
  assert.equal(normalized.functions.get("answer")?.overloads[0].returnType.kind, "z");
  assert.equal(normalized.functions.get("answer")?.overloads[0].cSignature, "int (void)");
});

test("preserves native declaration locations for FIIR and editor definitions", () => {
  const example = resolve(projectRoot, "examples/foreign-types.z");
  const source = readFileSync(example, "utf8");
  const context = analyzeSource(source, example);
  const geometry = context.foreignModules.get("geometry")!;
  const translated = geometry.functions.get("z_translate")!;
  assert.match(translated.overloads[0].metadata.source?.fileName ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(translated.overloads[0].metadata.source?.line, 32);

  const functionUse = source.indexOf("z_translate") + 2;
  const functionDefinition = definition(source, `file://${example}`, functionUse);
  assert.match(functionDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(functionDefinition?.range.start.line, 31);

  const typeUse = source.indexOf("geometry.ZPoint") + "geometry.".length + 2;
  const typeDefinition = definition(source, `file://${example}`, typeUse);
  assert.match(typeDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
});

test("surfaces native availability in hover and rejects universally unavailable APIs", () => {
  const fileName = resolve(projectRoot, "examples/availability-metadata-test.z");
  const source = `
    import native from "../tests/fixtures/z-availability.h";
    function main(): i32 { return native.z_legacy(1); }
  `;
  const context = analyzeSource(source, fileName);
  const legacy = context.foreignModules.get("native")!.functions.get("z_legacy")!;
  assert.deepEqual(legacy.overloads[0].metadata.availability, [{
    platform: "macos",
    introduced: "10.12",
    deprecated: true,
    deprecatedVersion: "13.0",
    obsoleted: null,
    unavailable: false,
    message: "use z_current",
  }]);
  const legacyUse = source.indexOf("z_legacy") + 2;
  assert.match(hover(source, fileName, legacyUse)?.contents.value ?? "", /Availability: macos: introduced 10\.12, deprecated 13\.0/);
  const legacyDefinition = definition(source, `file://${fileName}`, legacyUse);
  assert.match(legacyDefinition?.uri ?? "", /tests\/fixtures\/z-availability\.h$/);
  assert.equal(legacyDefinition?.range.start.line, 5);

  const unavailable = source.replace("z_legacy", "z_never");
  const diagnostic = diagnostics(unavailable, fileName)[0];
  assert.equal(diagnostic.code, "Z0802");
  assert.match(diagnostic.message, /foreign declaration "z_never" is unavailable/);
  assert.match(diagnostic.message, /not supported anywhere/);
  assert.match(diagnostic.relatedInformation?.[0]?.location.uri ?? "", /tests\/fixtures\/z-availability\.h$/);
});

test("rejects malformed or unmatched API notes before FIIR reaches sema", () => {
  const directory = mkdtempSync("/tmp/z-fiir-notes-");
  const header = resolve(directory, "contract.h");
  const sourceFile = resolve(directory, "main.z");
  const source = `
    import contract from "contract.h";
    function main(): i32 { return contract.known(); }
  `;
  writeFileSync(header, "int known(void);\n");
  writeFileSync(sourceFile, source);

  writeFileSync(`${header}.zapi.json`, "{}");
  assert.match(compileToC(source, sourceFile), /return known\(\);/);

  writeFileSync(`${header}.zapi.json`, JSON.stringify({
    functions: { missing: { return: { nullable: false } } },
  }));
  const missing = diagnostics(source, sourceFile)[0];
  assert.equal(missing.code, "Z0801");
  assert.match(missing.message, /unknown foreign function "missing"/);

  writeFileSync(`${header}.zapi.json`, JSON.stringify({
    functions: { known: { return: { nullible: false } } },
  }));
  const malformed = diagnostics(source, sourceFile)[0];
  assert.equal(malformed.code, "Z0801");
  assert.match(malformed.message, /unknown field functions\.known\.return\.nullible/);
});

test("imports C typedefs, records, enums, constants, and qualified signatures", () => {
  const example = resolve(projectRoot, "examples/foreign-types.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "point=13,20 width=640 flags=7 id=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static ZPoint move\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /\(ZPoint\)\{ \.x = 10, \.y = 20 \}/);
  assert.match(generated, /z_translate\(point, ZForward, amount\)/);
});

test("checks contextual literals and preserves exact integer expression types", () => {
  const source = `
    function plus(value: u16): u16 {
      const result = value + 3;
      return result;
    }
    function maxWord(): u32 {
      return 4294967295;
    }
    function maxWide(): u64 {
      return 18446744073709551615;
    }
    function main(): i32 {
      plus(65535);
      return 0;
    }
  `;
  const generated = compileToC(source, "integer-widths.z");
  assert.match(generated, /static uint16_t plus\(uint16_t value\)/);
  assert.match(generated, /const uint16_t result = z_checked_add_u16\(value, 3\);/);
  assert.match(generated, /return 4294967295U;/);
  assert.match(generated, /return 18446744073709551615ULL;/);

  assert.throws(
    () => compileToC(source.replace("65535", "65536"), "integer-overflow.z"),
    /integer literal 65536 does not fit u16/,
  );

  const inferredWide = `
    function main(): i32 {
      const value = 4294967295;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferredWide, "integer-default.z"),
    /does not fit default i32; add an explicit integer type/,
  );
});

test("contextually types signed literals at their destination width", () => {
  const source = `
    struct Tiny { value: i8; }

    function echo(value: i8): i8 { return value; }
    function minimum(): i16 { return -32768; }

    function main(): i32 {
      const narrow: i8 = -128;
      const positive: i16 = +32767;
      const fraction: f32 = -1.5;
      let assigned: i16 = 0;
      assigned = -32768;
      const called = echo(-128);
      const tiny = Tiny({ value: -128 });
      if (narrow == called && tiny.value == narrow && assigned == minimum() && positive > 0 && fraction < 0.0) {
        return 0;
      }
      return 1;
    }
  `;
  const generated = compileToC(source, "signed-context.z");
  assert.match(generated, /const int8_t narrow = INT8_MIN;/);
  assert.match(generated, /const int16_t positive = 32767;/);
  assert.match(generated, /const float fraction = \(-1\.5F\);/);
  assert.match(generated, /assigned = INT16_MIN;/);
  assert.match(generated, /echo\(INT8_MIN\)/);
  assert.match(generated, /\.value = INT8_MIN/);

  const narrowLiteral = source.indexOf("128", source.indexOf("narrow:")) + 1;
  assert.match(hover(source, "signed-context.z", narrowLiteral)?.contents.value ?? "", /128: i8/);

  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: i8 = -129"), "signed-too-small.z"),
    /integer literal -129 does not fit i8/,
  );
  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: u8 = -1"), "unsigned-negative.z"),
    /integer literal -1 does not fit u8/,
  );

  const directory = mkdtempSync("/tmp/z-signed-context-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("checks integer arithmetic and provides explicit wrapping and saturation", () => {
  const example = resolve(projectRoot, "examples/integer-safety.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrapped=0,255,254, saturated=255,-128,255, division=3,2, negated=-3, shifts=12,6\n");

  const generated = compileToC(source, example);
  assert.match(generated, /z_wrapping_add_u8\(maximum, 1\)/);
  assert.match(generated, /z_wrapping_subtract_u8\(unsignedZero, 1\)/);
  assert.match(generated, /z_wrapping_multiply_u8\(maximum, 2\)/);
  assert.match(generated, /z_saturating_add_u8\(maximum, 1\)/);
  assert.match(generated, /z_saturating_subtract_i8\(minimum, 2\)/);
  assert.match(generated, /z_saturating_multiply_u8\(maximum, 2\)/);
  assert.match(generated, /z_checked_divide_i32\(17, 5\)/);
  assert.match(generated, /z_checked_remainder_i32\(17, 5\)/);
  assert.match(generated, /z_checked_negate_i32\(quotient\)/);
  assert.match(generated, /z_checked_shift_left_i32\(quotient, 2\)/);
  assert.match(generated, /z_checked_shift_right_i32\(shifted, 1\)/);

  const wrappingOffset = source.indexOf("wrappingAdd") + 1;
  assert.match(hover(source, example, wrappingOffset)?.contents.value ?? "", /wrappingAdd\(other: u8\): u8/);
  const completionSource = source.replace("maximum.wrappingAdd(1)", "maximum.wrap");
  const completionOffset = completionSource.indexOf("maximum.wrap") + "maximum.wrap".length;
  const wrappingCompletion = completions(completionSource, example, completionOffset)
    .find((item) => item.label === "wrappingAdd");
  assert.equal(wrappingCompletion?.kind, 2);
  assert.match(wrappingCompletion?.detail ?? "", /wraps modulo the integer width/);

  const constantCases = [
    ["function main(): i32 { return 2147483647 + 1; }", "constant-add-overflow.z", "Z0101", /overflows i32/],
    ["function main(): i32 { return 10 / 0; }", "constant-divide-zero.z", "Z0102", /division by zero/],
    ["function main(): i32 { return 1 << 32; }", "constant-shift-range.z", "Z0103", /outside the range for i32/],
  ] as const;
  for (const [invalidSource, fileName, code, summary] of constantCases) {
    let caught: unknown;
    try {
      compileToC(invalidSource, fileName);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DiagnosticError);
    assert.equal(caught.code, code);
    assert.match(caught.summary, summary);
    assert.equal(diagnostics(invalidSource, fileName)[0].code, code);
  }

  const directory = mkdtempSync("/tmp/z-integer-trap-");
  const trapSource = resolve(directory, "main.z");
  writeFileSync(trapSource, `
    function overflow(value: i32): i32 { return value + 1; }
    function main(): i32 { return overflow(2147483647); }
  `);
  const trapped = spawnSync(process.execPath, [cli, "run", trapSource], { encoding: "utf8" });
  assert.notEqual(trapped.status, 0);
});

test("runs floating-point values and typed bitwise option masks", () => {
  const example = resolve(projectRoot, "examples/apple-groundwork.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  const artifact = compileToNative(readFileSync(example, "utf8"), example);
  assert.equal(artifact.language, "c");
  assert.deepEqual(artifact.frameworks, []);
  assert.match(artifact.source, /static float twice\(float value\)/);
  assert.match(artifact.source, /static double negate\(double value\)/);
  assert.match(artifact.source, /const float width = 800\.0F;/);
  assert.match(artifact.source, /const ZCoordinate windowArea = z_area\(800\.0, 600\.0\);/);
  assert.match(artifact.source, /const uintptr_t styleMask = \(\(titled \| 2ULL\) \| 8ULL\);/);
  assert.match(artifact.source, /const uint32_t shifted = z_checked_shift_left_u32\(one, 3U\);/);
  assert.match(artifact.source, /const uint32_t inverted = \(~one\);/);
  assert.match(artifact.source, /const uintptr_t toggled = \(filtered \^ 1ULL\);/);
  assert.match(artifact.source, /const float scientific = 1\.5e2F;/);
});

test("preserves C++ namespaces and resolves overload sets", () => {
  const example = resolve(projectRoot, "examples/cpp-interop.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.deepEqual(artifact.frameworks, []);
  assert.match(artifact.source, /#include <cpp_math\.hpp>/);
  assert.match(artifact.source, /const zcpp::Point origin/);
  assert.match(artifact.source, /const alpha::Point alphaPoint/);
  assert.match(artifact.source, /const beta::Point betaPoint/);
  assert.match(artifact.source, /zcpp::translate\(origin, 1, \(-1\)\)/);
  assert.match(artifact.source, /zcpp::sum\(moved\)/);
  assert.match(artifact.source, /zcpp::scale\(6, 7\)/);
  assert.match(artifact.source, /zcpp::scale\(2\.5, 2\.0\)/);
  assert.match(artifact.source, /alpha::adjust\(\(alphaPoint\)\.value\)/);
  assert.match(artifact.source, /beta::adjust\(\(betaPoint\)\.value\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "cpp=42, integer=42, floating=5, adjusted=40, point=Point { x: 21, y: 21 }\n");

  const translateOffset = source.indexOf("translate") + 1;
  assert.match(hover(source, example, translateOffset)?.contents.value ?? "", /Point \(Point, int, int\)/);
  const completionSource = source.replace("cpp.zcpp.translate", "cpp.zcpp.tr");
  const completionOffset = completionSource.indexOf("cpp.zcpp.tr") + "cpp.zcpp.tr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "translate")?.kind, 3);
  const rootCompletionSource = source.replace("cpp.zcpp.translate", "cpp.z");
  const rootCompletionOffset = rootCompletionSource.indexOf("cpp.z") + "cpp.z".length;
  assert.equal(completions(rootCompletionSource, example, rootCompletionOffset).find((item) => item.label === "zcpp")?.kind, 9);
  const typeCompletionSource = source.replace("cpp.zcpp.Point", "cpp.zcpp.Po");
  const typeCompletionOffset = typeCompletionSource.indexOf("cpp.zcpp.Po") + "cpp.zcpp.Po".length;
  assert.equal(completions(typeCompletionSource, example, typeCompletionOffset).find((item) => item.label === "Point")?.kind, 22);
  const ambiguousTypeCompletionSource = source.replace("cpp.zcpp.Point", "cpp.Po");
  const ambiguousTypeCompletionOffset = ambiguousTypeCompletionSource.indexOf("cpp.Po") + "cpp.Po".length;
  assert.equal(completions(ambiguousTypeCompletionSource, example, ambiguousTypeCompletionOffset).find((item) => item.label === "Point"), undefined);
  const fieldOffset = source.indexOf("x: 20") + 1;
  assert.match(hover(source, example, fieldOffset)?.contents.value ?? "", /x: i32/);
  const pointOffset = source.indexOf("cpp.zcpp.Point") + "cpp.zcpp.".length + 1;
  assert.match(hover(source, example, pointOffset)?.contents.value ?? "", /Point: zcpp::Point/);
  const pointDefinition = definition(source, `file://${example}`, pointOffset);
  assert.match(pointDefinition?.uri ?? "", /examples\/cpp_math\.hpp$/);
  assert.equal(pointDefinition?.range.start.line, 4);
  const semantic = decodeSemanticTokens(semanticTokens(source, example).data);
  const pointPosition = positionForOffset(source, source.indexOf("cpp.zcpp.Point") + "cpp.zcpp.".length);
  assert.ok(semantic.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));

  const overloadHoverOffset = source.indexOf("cpp.zcpp.scale") + "cpp.zcpp.".length + 1;
  const overloadHover = hover(source, example, overloadHoverOffset)?.contents.value ?? "";
  assert.match(overloadHover, /scale\(value: i32, factor: i32\): i32/);
  assert.match(overloadHover, /scale\(value: f64, factor: f64\): f64/);
  const floatingScaleOffset = source.indexOf("cpp.zcpp.scale(2.5") + "cpp.zcpp.".length + 1;
  const floatingScaleDefinition = definition(source, `file://${example}`, floatingScaleOffset);
  assert.match(floatingScaleDefinition?.uri ?? "", /examples\/cpp_math\.hpp$/);
  assert.equal(floatingScaleDefinition?.range.start.line, 21);
  const genericOverload = source
    .replace("function main(): i32 {", "function identity<T>(value: T): T { return value; }\n\nfunction main(): i32 {")
    .replace("cpp.zcpp.scale(2.5, 2.0)", "identity(cpp.zcpp.scale(2.5, 2.0))");
  assert.match(compileToNative(genericOverload, example).source, /__z_mono_identity_f64\(zcpp::scale\(2\.5, 2\.0\)\)/);
  assert.throws(() => compileToNative(source.replace("cpp.sum(moved)", "cpp.choose(1)"), example), /call to foreign function "zcpp\.choose" is ambiguous/);
  assert.throws(() => compileToNative(source.replace("cpp.sum(moved)", "cpp.adjust(1)"), example), /has no function "adjust"/);
  assert.throws(() => compileToNative(source.replace("= cpp.zcpp.Point", "= cpp.Point"), example), /native type "Point" is ambiguous across C\+\+ namespaces/);
});

test("selectively imports and aliases C++ namespaces", () => {
  const example = resolve(projectRoot, "examples/cpp-selective-interop.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /const zcpp::Point origin/);
  assert.match(artifact.source, /zcpp::translate\(origin, 1, \(-1\)\)/);
  assert.match(artifact.source, /alpha::adjust\(\(leftPoint\)\.value\)/);
  assert.match(artifact.source, /beta::adjust\(\(rightPoint\)\.value\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective cpp=42, adjusted=40\n");

  const namespaceOffset = source.indexOf("math.Point") + 1;
  assert.match(hover(source, example, namespaceOffset)?.contents.value ?? "", /native namespace zcpp imported as math/);
  const pointOffset = source.indexOf("math.Point") + "math.".length + 1;
  assert.match(hover(source, example, pointOffset)?.contents.value ?? "", /Point: zcpp::Point/);
  assert.match(definition(source, `file://${example}`, pointOffset)?.uri ?? "", /examples\/cpp_math\.hpp$/);

  const completionSource = source.replace("math.translate", "math.tr");
  const completionOffset = completionSource.indexOf("math.tr") + "math.tr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "translate")?.kind, 3);
  const symbolSource = source.replace("const origin", "mat;\n  const origin");
  const symbolOffset = symbolSource.indexOf("mat;") + 3;
  assert.equal(completions(symbolSource, example, symbolOffset).find((item) => item.label === "math")?.kind, 9);

  const semantic = decodeSemanticTokens(semanticTokens(source, example).data);
  const namespacePosition = positionForOffset(source, source.indexOf("math.Point"));
  const pointPosition = positionForOffset(source, source.indexOf("math.Point") + "math.".length);
  assert.ok(semantic.some((token) => token.line === namespacePosition.line
    && token.character === namespacePosition.character
    && token.type === semanticTokenTypes.indexOf("namespace")));
  assert.ok(semantic.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));

  const annotated = source.replace("const origin =", "const origin: math.Point =");
  assert.match(compileToNative(annotated, example).source, /const zcpp::Point origin/);
});

test("imports AppKit classes and emits an ARC Objective-C NSWindow program", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/nswindow.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.equal(artifact.language, "objective-c");
  assert.deepEqual(artifact.frameworks, ["AppKit"]);
  assert.match(artifact.source, /@autoreleasepool/);
  assert.match(artifact.source, /NSApplication \* const app = \[NSApplication sharedApplication\];/);
  assert.match(artifact.source, /const NSWindowStyleMask style =/);
  assert.match(artifact.source, /NSWindow \* const window = \[\[NSWindow alloc\] initWithContentRect:frame styleMask:style backing:NSBackingStoreBuffered defer:false\];/);
  assert.match(artifact.source, /\[window setTitle:@"Hello from Z"\]/);
  assert.match(artifact.source, /\[window makeKeyAndOrderFront:NULL\]/);

  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  assert.throws(
    () => compileToNative(source.replace("window.center();", "window.center(1);"), example),
    /Objective-C instance "NSWindow" has no method "center" accepting 1 argument\(s\)/,
  );

  assert.throws(
    () => compileToNative(source.replace("styleMask: style", "mask: style"), example),
    /has no method "initWithContentRect" matching labels mask: backing: defer:/,
  );

  assert.throws(
    () => compileToNative(source.replace("backing: AppKit.NSBackingStoreBuffered", "AppKit.NSBackingStoreBuffered"), example),
    /a labeled Objective-C call must label every argument after the first/,
  );

  assert.throws(
    () => compileToNative(source.replace("window.title = \"Hello from Z\";", "window.title = 42;"), example),
    /Objective-C property expects NSString \*, found i32/,
  );

  assert.throws(
    () => compileToNative(source.replace("window.title = \"Hello from Z\";", "window.windowNumber = 42;"), example),
    /Objective-C property "windowNumber" is readonly/,
  );

  const methodSetter = compileToNative(
    source.replace("window.title = \"Hello from Z\";", "window.setTitle(\"Hello from Z\");"),
    example,
  );
  assert.match(methodSetter.source, /\[window setTitle:@"Hello from Z"\]/);

  const customGetter = compileToNative(
    source.replace("window.center();", "window.visible;\n  window.center();"),
    example,
  );
  assert.match(customGetter.source, /\[window isVisible\]/);
});

test("narrows nullable Objective-C references before member access", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "objc-nullability.z");
  const source = `
    import AppKit from "AppKit/AppKit.h";
    function main(): i32 {
      const app = AppKit.NSApplication.sharedApplication;
      const window = app.keyWindow;
      if (window != null) {
        window.center();
        return 1;
      }
      return 0;
    }
  `;
  const artifact = compileToNative(source, fileName);
  assert.deepEqual(diagnostics(source, fileName), []);
  assert.match(artifact.source, /NSWindow \* const window = \[app keyWindow\];/);
  assert.match(artifact.source, /if \(window != NULL\)/);
  assert.match(artifact.source, /\[window center\]/);

  const windowBinding = source.indexOf("window =") + 2;
  assert.match(hover(source, fileName, windowBinding)?.contents.value ?? "", /window: AppKit\.NSWindow \| null/);

  const unsafe = source.replace(
    `if (window != null) {\n        window.center();\n        return 1;\n      }`,
    `window.center();\n      return 1;`,
  );
  const diagnostic = diagnostics(unsafe, fileName)[0];
  assert.match(diagnostic?.message ?? "", /nullable Objective-C AppKit\.NSWindow must be checked before member access/);

  const earlyReturn = source.replace(
    `if (window != null) {\n        window.center();\n        return 1;\n      }\n      return 0;`,
    `if (window == null) {\n        return 0;\n      }\n      window.center();\n      return 1;`,
  );
  assert.deepEqual(diagnostics(earlyReturn, fileName), []);

  const unsafeAfterJoin = source.replace(
    `if (window != null) {\n        window.center();\n        return 1;\n      }\n      return 0;`,
    `if (window != null) {\n        window.center();\n      }\n      window.center();\n      return 0;`,
  );
  assert.match(
    diagnostics(unsafeAfterJoin, fileName)[0]?.message ?? "",
    /nullable Objective-C AppKit\.NSWindow must be checked before member access/,
  );

  const annotated = `
    import AppKit from "AppKit/AppKit.h";
    class WindowSlot {
      window: AppKit.NSWindow | null;
      constructor(window: AppKit.NSWindow | null) {
        this.window = window;
      }
    }
    function inspect(window: AppKit.NSWindow | null): i32 {
      if (window == null) return 0;
      window.center();
      return 1;
    }
    function noWindow(): AppKit.NSWindow | null {
      return null;
    }
    function main(): i32 {
      const slot = new WindowSlot(null);
      const window: AppKit.NSWindow | null = noWindow();
      return inspect(window) + inspect(slot.window);
    }
  `;
  const annotatedArtifact = compileToNative(annotated, fileName);
  assert.deepEqual(diagnostics(annotated, fileName), []);
  assert.match(annotatedArtifact.source, /static int32_t inspect\(NSWindow \*window\)/);
  assert.match(annotatedArtifact.source, /static NSWindow \* noWindow\(void\)/);
  assert.match(annotatedArtifact.source, /NSWindow \*\s*window;/);
  assert.match(annotatedArtifact.source, /Z_WindowSlot_new\(NULL\)/);
  assert.match(annotatedArtifact.source, /return NULL;/);
  const annotatedCompilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: annotatedArtifact.source, encoding: "utf8" });
  assert.equal(annotatedCompilation.status, 0, annotatedCompilation.stderr);
  const annotationBinding = annotated.indexOf("window: AppKit.NSWindow") + 2;
  assert.match(hover(annotated, fileName, annotationBinding)?.contents.value ?? "", /window: AppKit\.NSWindow \| null/);

  const wrongOptional = `
    function main(): i32 {
      const value: i32 | null = null;
      return 0;
    }
  `;
  const wrongDiagnostic = diagnostics(wrongOptional, "value-nullability.z")[0];
  assert.match(wrongDiagnostic?.message ?? "", /i32 \| null.*currently requires an imported Objective-C reference type/);

  const unsafeArgument = `
    import AppKit from "AppKit/AppKit.h";
    function requireWindow(window: AppKit.NSWindow): void {}
    function inspect(window: AppKit.NSWindow | null): void {
      requireWindow(window);
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(unsafeArgument, fileName),
    /expected AppKit\.NSWindow, found AppKit\.NSWindow \| null/,
  );
});

test("lifts nullable Objective-C references into Option values", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/objc-nullability.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /typedef NSWindow \*Z_Option_AppKit_2e_NSWindow;/);
  assert.match(artifact.source, /const Z_Option_AppKit_2e_NSWindow option = \[app keyWindow\];/);
  assert.match(artifact.source, /if \(_z_match_\d+ != nil\)/);
  assert.doesNotMatch(artifact.source, /Z_Option_AppKit_2e_NSWindow_(?:some|none)|\.data\.some/);

  const printable = source
    .replace('import AppKit from "AppKit/AppKit.h";', 'import AppKit from "AppKit/AppKit.h";\nimport console from "std/console";')
    .replace(
      "return direct + centerOption(option);",
      "console.log(option);\n  console.log(`${option}`);\n  return direct + centerOption(option);",
    );
  const printableArtifact = compileToNative(printable, example);
  assert.match(printableArtifact.source, /Option<AppKit\.NSWindow>\.none/);
  assert.match(printableArtifact.source, /Option<AppKit\.NSWindow>\.some\(/);
  const printableCompilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: printableArtifact.source, encoding: "utf8" });
  assert.equal(printableCompilation.status, 0, printableCompilation.stderr);

  const methodOffset = source.indexOf("fromNullable") + 1;
  assert.match(
    hover(source, example, methodOffset)?.contents.value ?? "",
    /fromNullable\(value: T \| null\): Option<T>/,
  );
  const methodPosition = positionForOffset(source, source.indexOf("fromNullable"));
  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  assert.ok(tokens.some((token) => token.line === methodPosition.line
    && token.character === methodPosition.character
    && semanticTokenTypes[token.type] === "method"));

  const completionSource = source.replace("Option.fromNullable", "Option.fromN");
  const completionOffset = completionSource.indexOf("Option.fromN") + "Option.fromN".length;
  assert.match(
    completions(completionSource, example, completionOffset).find((item) => item.label === "fromNullable")?.detail ?? "",
    /fromNullable\(value: T \| null\): Option<T>/,
  );

  const explicitNull = `
    import AppKit from "AppKit/AppKit.h";
    function main(): i32 {
      const option = Option<AppKit.NSWindow>.fromNullable(null);
      return match (option) {
        some(window) => 1;
        none => 0;
      };
    }
  `;
  const explicitNullArtifact = compileToNative(explicitNull, example);
  assert.match(explicitNullArtifact.source, /const Z_Option_AppKit_2e_NSWindow option = NULL;/);

  const nonnullable = `
    import AppKit from "AppKit/AppKit.h";
    function main(): i32 {
      const window: AppKit.NSWindow = AppKit.NSWindow.alloc();
      const option = Option<AppKit.NSWindow>.fromNullable(window);
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(nonnullable, example),
    /Option\.fromNullable requires AppKit\.NSWindow \| null, found AppKit\.NSWindow/,
  );
});

test("compiles a desktop ownership slice and preserves its current pressure walls", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/desktop-ownership/main.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /typedef struct Z_[A-Za-z0-9_]*Workspace Z_[A-Za-z0-9_]*Workspace/);
  assert.match(artifact.source, /Z_DynamicArray_[A-Za-z0-9_]*Document documents/);
  assert.match(artifact.source, /\[\[NSWindow alloc\] initWithContentRect/);
  assert.match(artifact.source, /NSWindow \*\s*window;/);
  assert.match(artifact.source, /calloc\(1, sizeof\(Z_WindowController\)\)/);
  assert.match(artifact.source, /self->window = nil;/);
  assert.match(artifact.source, /beginWithCompletionHandler:_z_objc_block_/);
  assert.match(artifact.source, /Z_[A-Za-z0-9_]*Workspace_open/);
  assert.match(artifact.source, /Workspace_eachDocument\(const Z_[A-Za-z0-9_]*Workspace \*self, const Z_Function_[A-Za-z0-9_]+ \*visit\)/);
  assert.match(artifact.source, /const Z_[A-Za-z0-9_]*Document \*document = &/);
  assert.deepEqual(diagnostics(source, example), []);

  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const windowFieldOffset = source.indexOf("window: AppKit.NSWindow") + "window: AppKit.".length + 1;
  assert.match(hover(source, example, windowFieldOffset)?.contents.value ?? "", /class NSWindow/);
});

test("compares scoped document borrows with independently owned snapshots", () => {
  const example = resolve(projectRoot, "examples/ownership-views.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(
    generated,
    /DocumentStore_withDocument\(const Z_[A-Za-z0-9_]*DocumentStore \*self, int32_t id, const Z_Function_[A-Za-z0-9_]+ \*visit\)/,
  );
  assert.match(generated, /const Z_[A-Za-z0-9_]*Document \*document = &/);
  assert.match(generated, /DocumentStore_documentSnapshot\(const Z_[A-Za-z0-9_]*DocumentStore \*self, int32_t id\)/);
  assert.match(generated, /const Z_[A-Za-z0-9_]*Document \*\s*Z_[A-Za-z0-9_]*DocumentStore_documentAt\(const Z_[A-Za-z0-9_]*DocumentStore \*self, uintptr_t index\)/);
  assert.match(generated, /return &\(\(\(self->documents\)\.data\[/);
  assert.match(generated, /Z_String _z_string_[0-9]+ = z_string_new\(\);/);
  assert.match(generated, /z_string_append_bytes\([^;]+document[^;]+title[^;]+length\);/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "scoped 2: Interop Notes\nview 2: Interop Notes\nsnapshot 2: Interop Notes\n");

  const liveMutation = source.replace(
    "console.log(`view ${projected.id}: ${projected.title}`);",
    "documents.open(Document({ id: 9, title: \"Invalidation\" }));\n  console.log(`view ${projected.id}: ${projected.title}`);",
  );
  const mutationDiagnostic = diagnostics(liveMutation, example)[0];
  assert.equal(mutationDiagnostic.code, "Z0205");
  assert.match(mutationDiagnostic.message, /cannot mutate .*documents.* while view .*projected.* is live/);

  const viewOffset = source.indexOf("projected =") + 1;
  assert.match(hover(source, example, viewOffset)?.contents.value ?? "", /view Document.*view of documents/);
});

test("keeps receiver-tied views read-only, local, and value-struct-owned", () => {
  const base = `
    struct Item { value: i32; }
    struct Store {
      items: Array<Item>;
      function at(index: usize): view Item { return this.items[index]; }
      function append(inout this, item: Item): void { this.items.push(item); }
    }
  `;

  const liveMutation = `${base}
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      store.append(Item({ value: 2 }));
      return item.value;
    }
  `;
  assert.equal(diagnostics(liveMutation, "view-live-mutation.z")[0].code, "Z0205");

  const mutationAfterBranch = `${base}
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      if (true) { const observed = 1; }
      store.append(Item({ value: 2 }));
      return item.value;
    }
  `;
  assert.equal(diagnostics(mutationAfterBranch, "view-live-after-branch.z")[0].code, "Z0205");

  const capture = `${base}
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      const read = () => item.value;
      return read();
    }
  `;
  const captureDiagnostic = diagnostics(capture, "view-capture.z")[0];
  assert.equal(captureDiagnostic.code, "Z0206");
  assert.match(captureDiagnostic.message, /cannot be captured/);

  const forwarded = `${base}
    function inspect(in item: Item): i32 { return item.value; }
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      return inspect(item);
    }
  `;
  const forwardDiagnostic = diagnostics(forwarded, "view-forward.z")[0];
  assert.equal(forwardDiagnostic.code, "Z0206");
  assert.match(forwardDiagnostic.message, /cannot be forwarded/);

  const classOwner = `
    struct Item { value: i32; }
    class Store {
      item: Item;
      function current(): view Item { return this.item; }
    }
    function main(): i32 { return 0; }
  `;
  const classDiagnostic = diagnostics(classOwner, "view-class-owner.z")[0];
  assert.equal(classDiagnostic.code, "Z0206");
  assert.match(classDiagnostic.message, /value-struct owner/);

  const wrongProjection = `
    struct Item { value: i32; }
    struct Store {
      item: Item;
      function current(): view Item {
        const local = Item({ value: 1 });
        return local;
      }
    }
    function main(): i32 { return 0; }
  `;
  const projectionDiagnostic = diagnostics(wrongProjection, "view-wrong-projection.z")[0];
  assert.equal(projectionDiagnostic.code, "Z0206");
  assert.match(projectionDiagnostic.message, /derived directly from this/);
});

test("retains owned Z closure environments across Objective-C blocks", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-blocks.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /@interface Z_ObjCClosureBox : NSObject/);
  assert.match(artifact.source, /\^void\(int32_t _z_block_argument_1\)/);
  assert.match(artifact.source, /initWithContext:.*retainFunction:.*releaseFunction:/);
  assert.doesNotMatch(artifact.source, /Z_EventState_retain\(\(\*state\)\)->value/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "event value=42\nreleased event state 42\n");

  const borrowed = source.replace("move (value)", "(value)");
  assert.match(
    diagnostics(borrowed, example)[0].message,
    /borrowed capturing closure cannot become a function value/,
  );
});

test("registers persistent Objective-C event callbacks with explicit token cleanup", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-notifications.z");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /addObserverForName:@"ZEvent" object:NULL queue:NULL usingBlock:_z_objc_block_/);
  assert.match(artifact.source, /postNotificationName:@"ZEvent" object:NULL/);
  assert.match(artifact.source, /removeObserver:token/);
  assert.match(artifact.source, /\^void\(NSNotification \* _z_block_argument_1\)/);
  assert.match(artifact.source, /Z_Weak observer;/);
  assert.doesNotMatch(artifact.source, /Z_EventState \* state;/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "event 1: ZEvent\nevent 2: ZEvent\nreleased event state 2\n");

  const notificationUse = source.indexOf("notification.name") + 1;
  assert.match(
    hover(source, fixture, notificationUse)?.contents.value ?? "",
    /notification: Foundation\.NSNotification/,
  );
  const tokenUse = source.indexOf("token);") + 1;
  assert.match(hover(source, fixture, tokenUse)?.contents.value ?? "", /token: id/);
  const completionSource = source.replace("notification.name", "notification.na");
  const completionOffset = completionSource.indexOf("notification.na") + "notification.na".length;
  assert.equal(
    completions(completionSource, fixture, completionOffset).some((item) => item.label === "name"),
    true,
  );

  const appKitExample = resolve(projectRoot, "examples/appkit-events.z");
  const appKitSource = readFileSync(appKitExample, "utf8");
  const appKitArtifact = compileToNative(appKitSource, appKitExample);
  assert.match(appKitArtifact.source, /_z_argument_[0-9]+ = NSWindowDidBecomeKeyNotification;/);
  assert.match(appKitArtifact.source, /_z_argument_[0-9]+ = NSWindowWillCloseNotification;/);
  assert.match(appKitArtifact.source, /addObserverForName:_z_argument_[0-9]+ object:_z_argument_[0-9]+ queue:NULL usingBlock:_z_objc_block_/);
  assert.match(appKitArtifact.source, /removeObserver:keyToken/);
  assert.match(appKitArtifact.source, /removeObserver:closeToken/);
  assert.match(appKitArtifact.source, /lengthOfBytesUsingEncoding:NSUTF8StringEncoding/);
  assert.match(appKitArtifact.source, /UTF8String/);
  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: appKitArtifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const constantOffset = appKitSource.indexOf("NSWindowDidBecomeKeyNotification") + 1;
  assert.match(
    hover(appKitSource, appKitExample, constantOffset)?.contents.value ?? "",
    /NSWindowDidBecomeKeyNotification: AppKit\.NSString/,
  );
  const copiedNameOffset = appKitSource.indexOf("name: String") + 1;
  assert.match(hover(appKitSource, appKitExample, copiedNameOffset)?.contents.value ?? "", /name: String/);
  const inferredNameOffset = appKitSource.lastIndexOf("const name =") + "const ".length + 1;
  assert.match(
    hover(appKitSource, appKitExample, inferredNameOffset)?.contents.value ?? "",
    /name: AppKit\.NSString/,
  );
  const namespaceCompletionSource = appKitSource.replace(
    "AppKit.NSWindowDidBecomeKeyNotification",
    "AppKit.NSWindowDid",
  );
  const namespaceCompletionOffset = namespaceCompletionSource.indexOf("AppKit.NSWindowDid") + "AppKit.NSWindowDid".length;
  assert.equal(
    completions(namespaceCompletionSource, appKitExample, namespaceCompletionOffset)
      .some((item) => item.label === "NSWindowDidBecomeKeyNotification"),
    true,
  );
});

test("copies owned Z strings across NSString boundaries without losing embedded nulls", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-strings.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /z_nsstring_from_string/);
  assert.match(artifact.source, /z_string_from_nsstring/);
  assert.match(artifact.source, /initWithBytes:bytes length:\(NSUInteger\)value\.length/);
  assert.match(artifact.source, /lengthOfBytesUsingEncoding:NSUTF8StringEncoding/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "round trip=answer=42\nembedded=a\0b\n");
});

test("imports and executes Swift through its generated Objective-C compatibility header", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-swift-interop-");
  const header = resolve(directory, "ZSwiftFixture-Swift.h");
  const library = resolve(directory, "libZSwiftFixture.dylib");
  const swiftSource = resolve(projectRoot, "tests/fixtures/swift-fixture.swift");
  const swiftBuild = spawnSync("xcrun", [
    "swiftc",
    "-emit-library",
    "-emit-module",
    "-module-name", "ZSwiftFixture",
    "-emit-objc-header-path", header,
    swiftSource,
    "-o", library,
  ], { encoding: "utf8" });
  assert.equal(swiftBuild.status, 0, swiftBuild.stderr);

  const source = `
    import console from "std/console";
    import Swift from "ZSwiftFixture-Swift.h";
    function main(): i32 {
      const counter = Swift.ZSwiftCounter.alloc().initWithValue(40);
      counter.value = 41;
      console.log(\`swift=\${counter.add(1)}, value=\${counter.value}\`);
      return 0;
    }
  `;
  const zSource = resolve(directory, "swift-interop.z");
  writeFileSync(zSource, source);
  const artifact = compileToNative(source, zSource);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /#include <ZSwiftFixture-Swift\.h>/);
  assert.match(artifact.source, /\[\[ZSwiftCounter alloc\] initWithValue:40\]/);
  assert.match(artifact.source, /\[counter setValue:41\]/);
  assert.match(artifact.source, /\[counter add:1\]/);

  const objectiveCSource = resolve(directory, "swift-interop.m");
  const object = resolve(directory, "swift-interop.o");
  const executable = resolve(directory, "swift-interop");
  writeFileSync(objectiveCSource, artifact.source);
  const nativeCompile = spawnSync("xcrun", [
    "clang",
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-I", directory,
    "-c", objectiveCSource,
    "-o", object,
  ], { encoding: "utf8" });
  assert.equal(nativeCompile.status, 0, nativeCompile.stderr);
  const nativeLink = spawnSync("xcrun", [
    "clang",
    object,
    library,
    "-framework", "Foundation",
    "-o", executable,
  ], { encoding: "utf8" });
  assert.equal(nativeLink.status, 0, nativeLink.stderr);
  const result = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "swift=42, value=42\n");

  const addOffset = source.indexOf("add(1)") + 1;
  assert.match(hover(source, zSource, addOffset)?.contents.value ?? "", /add\(amount: i32\): i32/);
  const addDefinition = definition(source, `file://${zSource}`, addOffset);
  assert.match(addDefinition?.uri ?? "", /ZSwiftFixture-Swift\.h$/);
  const completionSource = source.replace("counter.add", "counter.ad");
  const completionOffset = completionSource.indexOf("counter.ad") + "counter.ad".length;
  assert.equal(completions(completionSource, zSource, completionOffset).find((item) => item.label === "add")?.kind, 2);
  const propertyOffset = source.lastIndexOf("value") + 1;
  assert.match(hover(source, zSource, propertyOffset)?.contents.value ?? "", /value: i32/);
});

test("builds a declared Swift target for ordinary CLI and editor workflows", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/swift-interop/main.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "objective-c");
  assert.deepEqual(artifact.frameworks, ["Foundation"]);
  assert.equal(artifact.includeDirectories.length, 1);
  assert.match(artifact.includeDirectories[0], /\.z-cache\/swift\/ZSwiftExample$/);
  assert.equal(artifact.nativeLibraries.length, 1);
  assert.match(artifact.nativeLibraries[0], /libZSwiftExample\.dylib$/);
  assert.deepEqual(diagnostics(source, example), []);

  const generatedHeader = resolve(artifact.includeDirectories[0], "ZSwiftExample-Swift.h");
  const headerMtime = statSync(generatedHeader).mtimeMs;
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "swift=42, value=42\n");
  assert.equal(statSync(generatedHeader).mtimeMs, headerMtime);
  const addOffset = source.indexOf("add(1)") + 1;
  assert.match(hover(source, example, addOffset)?.contents.value ?? "", /add\(amount: i32\): i32/);

  const invalidDirectory = mkdtempSync("/tmp/z-invalid-project-");
  const invalidSource = resolve(invalidDirectory, "main.z");
  writeFileSync(invalidSource, "function main(): i32 { return 0; }");
  writeFileSync(resolve(invalidDirectory, "z.json"), JSON.stringify({
    target: { entry: "main.z", swift: { module: "not-valid!", sources: ["Counter.swift"] } },
  }));
  assert.throws(
    () => compileToNative(readFileSync(invalidSource, "utf8"), invalidSource),
    /target\.swift\.module must be a valid module name/,
  );
});

test("imports and owns a Swift value through its generated C++ compatibility header", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/swift-value-interop/main.z");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /#include <ZSwiftOwned-Swift\.hpp>/);
  assert.match(artifact.source, /const ZSwiftOwned::OwnedCounter first = ZSwiftOwned::makeOwnedCounter\(40\)/);
  assert.match(artifact.source, /const ZSwiftOwned::OwnedCounter copied = first/);
  assert.match(artifact.source, /ZSwiftOwned::roundTrip\(copied\)/);
  assert.deepEqual(diagnostics(source, example), []);
  const firstOffset = source.indexOf("first =") + 1;
  assert.match(hover(source, example, firstOffset)?.contents.value ?? "", /first: Swift\.OwnedCounter/);
  const makeOffset = source.indexOf("makeOwnedCounter") + 1;
  assert.match(hover(source, example, makeOffset)?.contents.value ?? "", /makeOwnedCounter\(value: i32\): Swift\.OwnedCounter/);

  const generatedHeader = resolve(artifact.includeDirectories[0], "ZSwiftOwned-Swift.hpp");
  assert.equal(existsSync(generatedHeader), true);
  const makeDefinition = definition(source, `file://${example}`, makeOffset);
  assert.match(makeDefinition?.uri ?? "", /ZSwiftOwned-Swift\.hpp$/);
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "created 40\nfirst=40, copied=40, changed=42\nreleased 40\n");
});

test("keeps labeled arguments reserved for Objective-C selectors", () => {
  const source = `
    function identity(value: i32): i32 { return value; }
    function main(): i32 { return identity(value: 1); }
  `;
  assert.throws(
    () => compileToC(source, "labeled-native-call.z"),
    /labeled arguments are currently supported only for Objective-C method calls/,
  );
});

test("provides compiler-backed AppKit completion, labels, hover, diagnostics, and definitions", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/nswindow.z");
  const source = readFileSync(example, "utf8");

  const memberSource = source.replace("window.center();", "window.");
  const memberOffset = memberSource.indexOf("window.\n") + "window.".length;
  const members = completions(memberSource, example, memberOffset);
  assert.ok(members.some((item) => item.label === "title" && item.kind === 10));
  assert.ok(members.some((item) => item.label === "center" && item.insertText === "center()"));
  assert.ok(members.some((item) => (
    item.label === "makeKeyAndOrderFront"
    && item.insertText === "makeKeyAndOrderFront(${1:sender})"
  )));
  assert.equal(members.filter((item) => item.label === "title").length, 1);

  const partialMemberSource = source.replace("window.center();", "window.ce");
  const partialMemberOffset = partialMemberSource.indexOf("window.ce\n") + "window.ce".length;
  const partialWindowMembers = completions(partialMemberSource, example, partialMemberOffset);
  assert.ok(partialWindowMembers.some((item) => item.label === "center"));
  assert.ok(partialWindowMembers.every((item) => item.label.toLowerCase().startsWith("ce")));

  const localSource = source.replace("window.center();", "win");
  const localOffset = localSource.indexOf("win\n") + "win".length;
  const locals = completions(localSource, example, localOffset);
  assert.ok(locals.some((item) => item.label === "window" && /const window: AppKit\.NSWindow/.test(item.detail ?? "")));

  const namespaceSource = source.replace("AppKit.NSApplication.sharedApplication", "AppKit.");
  const namespaceOffset = namespaceSource.indexOf("AppKit.;") + "AppKit.".length;
  const namespaceMembers = completions(namespaceSource, example, namespaceOffset);
  assert.ok(namespaceMembers.some((item) => item.label === "NSWindow"));
  assert.ok(namespaceMembers.some((item) => item.label === "NSMakeRect"));
  assert.ok(namespaceMembers.length <= 2500);

  const partialNamespace = source.replace("AppKit.NSApplication.sharedApplication", "AppKit.NSW");
  const partialOffset = partialNamespace.indexOf("AppKit.NSW;") + "AppKit.NSW".length;
  const partialMembers = completions(partialNamespace, example, partialOffset);
  assert.ok(partialMembers.some((item) => item.label === "NSWindow"));
  assert.ok(partialMembers.every((item) => item.label.toLowerCase().startsWith("nsw")));

  const labelOffset = source.indexOf("styleMask:");
  const labels = completions(source, example, labelOffset);
  assert.ok(labels.some((item) => item.label === "styleMask:" && item.detail === "AppKit.NSWindowStyleMask"));

  const titleOffset = source.indexOf("title") + 2;
  assert.match(hover(source, example, titleOffset)?.contents.value ?? "", /title: NSString/);

  const chainedMethod = source.indexOf("initWithContentRect") + 4;
  const chainedHover = hover(source, example, chainedMethod)?.contents.value ?? "";
  assert.match(chainedHover, /initWithContentRect\(contentRect: AppKit\.NSRect, styleMask: AppKit\.NSWindowStyleMask/);
  assert.match(chainedHover, /initWithContentRect:styleMask:backing:defer:/);

  const frameBinding = source.indexOf("frame =") + 2;
  assert.match(hover(source, example, frameBinding)?.contents.value ?? "", /frame: AppKit\.NSRect/);

  const appKitNamespace = source.indexOf("AppKit") + 2;
  assert.match(hover(source, example, appKitNamespace)?.contents.value ?? "", /import AppKit from "AppKit\/AppKit\.h"/);

  const semantic = decodeSemanticTokens(semanticTokens(source, example).data);
  assert.ok(semantic.some((token) => token.line === 11 && token.character === 8
    && semanticTokenTypes[token.type] === "variable" && token.modifiers === 3));
  assert.ok(semantic.some((token) => token.line === 18 && token.character === 2
    && semanticTokenTypes[token.type] === "variable" && token.modifiers === 2));
  assert.ok(semantic.some((token) => token.line === 0 && token.character === 7
    && semanticTokenTypes[token.type] === "namespace"));

  const invalid = source.replace("window.center();", "window.center(1);");
  assert.match(diagnostics(invalid, example)[0]?.message ?? "", /has no method "center" accepting 1 argument/);

  const styleUse = source.indexOf("styleMask: style") + "styleMask: ".length;
  const styleDefinition = definition(source, `file://${example}`, styleUse);
  assert.equal(styleDefinition?.range.start.line, 7);

  const centerUse = source.indexOf("window.center") + "window.".length + 2;
  const centerDefinition = definition(source, `file://${example}`, centerUse);
  assert.match(centerDefinition?.uri ?? "", /AppKit\.framework\/Headers\/NSWindow\.h$/);
});

test("speaks the LSP initialize and shutdown protocol over stdio", () => {
  const lsp = resolve(projectRoot, "compiler/src/lsp.ts");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {} } },
    { jsonrpc: "2.0", id: 2, method: "shutdown", params: null },
    { jsonrpc: "2.0", method: "exit", params: null },
  ];
  const input = messages.map((message) => {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  }).join("");
  const result = spawnSync(process.execPath, [lsp], { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"name":"z-language-server"/);
  assert.match(result.stdout, /"completionProvider"/);
  assert.match(result.stdout, /"semanticTokensProvider"/);
  assert.match(result.stdout, /"triggerCharacters":\["\.",",","_","a","b"/);
});

test("checks floating-point widths and integer-only bitwise operators", () => {
  const mismatch = `
    function accept(value: f32): void {}
    function main(): i32 {
      const value: f64 = 1.25;
      accept(value);
      return 0;
    }
  `;
  assert.throws(() => compileToC(mismatch, "float-width.z"), /expected f32, found f64/);

  const floatToInteger = `
    function main(): i32 {
      const value: i32 = 1.5;
      return value;
    }
  `;
  assert.throws(
    () => compileToC(floatToInteger, "float-to-integer.z"),
    /floating-point literal 1\.5 cannot initialize i32/,
  );

  const floatMask = `
    function main(): i32 {
      const mask = 1.0 | 2.0;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(floatMask, "float-mask.z"),
    /operator "\|" requires matching integer operands/,
  );

  const variadicFloat = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.printf("%.1f", 1.5);
      return 0;
    }
  `;
  assert.match(compileToC(variadicFloat, "variadic-float.z"), /printf\("%\.1f", 1\.5\)/);
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
    compileToC(nullable, resolve(projectRoot, "nullable-null.z")),
    /z_test_optional\(NULL\);/,
  );

  const nonnull = nullable.replace("z_test_optional", "z_test_use");
  assert.throws(
    () => compileToC(nonnull, resolve(projectRoot, "nonnull-null.z")),
    /C function "z_test_use" requires a non-null ZTestHandle \*/,
  );

  const inferred = `
    function main(): i32 {
      const absent = null;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferred, "inferred-null.z"),
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
    () => compileToC(missingField, resolve(projectRoot, "foreign-record-fields.z")),
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
    () => compileToC(wrongEnum, resolve(projectRoot, "foreign-enum-argument.z")),
    /expected geometry\.ZDirection, found i32/,
  );
});

test("borrows and explicitly mutates imported C records through safe pointer modes", () => {
  const example = resolve(projectRoot, "examples/foreign-pointers.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "before=10 after=11 point=5,6\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /z_offset\(&\(point\), 3, 4\);/);
  assert.match(generated, /z_read\(&\(point\)\)/);
  assert.match(generated, /z_reset\(&\(point\)\);/);
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
    resolve(projectRoot, "foreign-record-uninitialized-out.z"),
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
    () => compileToC(immutable, resolve(projectRoot, "foreign-record-const.z")),
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
    () => compileToC(missingMode, resolve(projectRoot, "foreign-record-mode.z")),
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
    () => compileToC(wrongMode, resolve(projectRoot, "foreign-record-wrong-mode.z")),
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
    () => compileToC(escapedModifier, "escaped-out.z"),
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
    () => compileToC(source, "foreign-nullability.z"),
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
    compileToC(supportedSource, resolve(projectRoot, "foreign-bool.z")),
    /return z_test_bool\(true\);/,
  );

  const source = `
    import fixture from "tests/fixtures/foreign-types.h";
    function main(): i32 {
      return fixture.z_test_mutate("immutable");
    }
  `;
  assert.throws(
    () => compileToC(source, resolve(projectRoot, "mutable-cstring.z")),
    /C function "z_test_mutate" uses unsupported type "char \*"/,
  );
});

test("reports headers Clang cannot import", () => {
  const source = `
    import missing from "z_header_that_does_not_exist.h";
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "missing-header.z"),
    /could not import header "z_header_that_does_not_exist\.h"/,
  );
});

test("reports source locations for parser errors", () => {
  assert.throws(
    () => compileToC("function main(: i32 {}", "broken.z"),
    /broken\.z:1:15: error:/,
  );
});

test("rejects unknown names during semantic analysis", () => {
  const source = `
    function main(): i32 {
      return missing;
    }
  `;
  assert.throws(
    () => compileToC(source, "unknown.z"),
    /unknown\.z:3:14: error: unknown name "missing"/,
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
    () => compileToC(source, "arguments.z"),
    /arguments\.z:6:23: error: expected i32, found String/,
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
  const generated = compileToC(source, "inference.z");
  assert.match(generated, /const int32_t value = answer\(\);/);
});

test("compiles boolean expressions and path-complete if statements", () => {
  const example = resolve(projectRoot, "examples/control-flow.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "disabled=0\nordinary=1\nspecial=2\n");
});

test("supports single-statement if, else-if, else, and void guards", () => {
  const source = `
    function choose(value: i32): i32 {
      if (value > 0) return 1;
      else if (value < 0) return -1;
      else return 0;
    }
    function stopEarly(stop: bool): void {
      if (stop) return;
    }
    function nested(first: bool, second: bool): i32 {
      if (first) if (second) return 1; else return 2;
      return 3;
    }
    function main(): i32 {
      stopEarly(true);
      return choose(0) + nested(false, false) - 3;
    }
  `;
  const generated = compileToC(source, "single-statement-if.z");
  assert.match(generated, /if \(value > 0\) \{\n\s+return 1;/);
  assert.match(generated, /else if \(value < 0\)/);
  assert.match(generated, /if \(stop\) \{\n\s+return;/);
  assert.match(generated, /if \(first\) \{[\s\S]*if \(second\)/);
});

test("compiles ternaries and value-producing if expressions with select", () => {
  const example = resolve(projectRoot, "examples/conditional-expressions.z");
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
    () => compileToC(source, "if-expression-types.z"),
    /if-expression-types\.z:5:14: error: if branch produces String, but the other branch produces i32/,
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
    () => compileToC(missingElse, "if-expression-else.z"),
    /if-expression-else\.z:3:45: error: expected `else` in a value-producing `if`, found ";"/,
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
    () => compileToC(missingSelect, "if-expression-select.z"),
    /if-expression-select\.z:4:9: error: a value-producing block must produce a value with an expression or `select`/,
  );
});

test("runs non-escaping arrow closures with inferred borrow, mutation, and move captures", () => {
  const example = resolve(projectRoot, "examples/closures.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "add=42\ntotal=20,42\nsnapshot=15 seed=100\ntarget=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /__z_closure_call_/);
  assert.match(generated, /const int32_t \*offset/);
  assert.match(generated, /int32_t \*total/);
});

test("checks closure parameters, block return types, and immutable captures", () => {
  const blockInference = `
    function main(): i32 {
      const closure = (value: i32) => { return value; };
      return closure(42);
    }
  `;
  assert.throws(
    () => compileToC(blockInference, "closure-block-type.z"),
    /closure-block-type\.z:3:23: error: a block-bodied closure requires an explicit or contextual return type/,
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
    () => compileToC(immutableCapture, "closure-const.z"),
    /closure-const\.z:5:9: error: closure cannot mutate immutable capture "value"/,
  );

  const wrongArgument = `
    function main(): i32 {
      const identity = (value: i32): i32 => value;
      return identity("wrong");
    }
  `;
  assert.throws(
    () => compileToC(wrongArgument, "closure-argument.z"),
    /closure-argument\.z:4:23: error: expected i32, found String/,
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
  const generated = compileToC(source, "contextual-closure.z");
  assert.match(generated, /__z_closure_call_/);
  const parameter = source.indexOf("(value) =>") + 2;
  assert.match(hover(source, "contextual-closure.z", parameter)?.contents.value ?? "", /value: i32/);

  const missingContext = `
    function main(): i32 {
      const identity = (value) => value;
      return identity(42);
    }
  `;
  const inferenceDiagnostic = diagnostics(missingContext, "closure-inference.z")[0];
  assert.equal(inferenceDiagnostic.code, "Z0215");
  assert.match(inferenceDiagnostic.message, /cannot infer the type of closure parameter "value"/);

  const implicitCapability = source.replace("(inout value) =>", "(value) =>");
  assert.throws(
    () => compileToC(implicitCapability, "closure-capability.z"),
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
  const generated = compileToC(source, "inline-closures.z");
  assert.match(generated, /Z_ClosureEnv_/);
  assert.match(generated, /calloc\(1, sizeof\(Z_ClosureEnv_/);
  assert.match(generated, /_z_borrowed_closure_environment_/);
  assert.match(generated, /_z_argument_/);

  const parameter = source.indexOf("(value) => value + offset") + 2;
  assert.match(hover(source, "inline-closures.z", parameter)?.contents.value ?? "", /value: i32/);
  const completionSource = source.replace("value + offset, 41", "val + offset, 41");
  const completionOffset = completionSource.indexOf("val + offset, 41") + 3;
  assert.match(
    completions(completionSource, "inline-closures.z", completionOffset).find((item) => item.label === "value")?.detail ?? "",
    /value: i32/,
  );

  const borrowedCapture = source.replace("move (value) => value + offset", "(value) => value + offset");
  const captureDiagnostic = diagnostics(borrowedCapture, "inline-borrowed-capture.z")[0];
  assert.equal(captureDiagnostic.code, "Z0212");
  assert.match(captureDiagnostic.message, /borrowed capturing closure cannot become a function value/);

  const missingCapability = source.replace("(inout value) =>", "(value) =>");
  assert.throws(
    () => compileToC(missingCapability, "inline-capability.z"),
    /closure parameter "value" requires the `inout` capability from its destination function type/,
  );

  const directory = mkdtempSync("/tmp/z-inline-closures-");
  const fileName = resolve(directory, "main.z");
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
    () => compileToC(source, "closure-owned-move.z"),
    /closure-owned-move\.z:8:39: error: move-capturing cleanup-bearing Resource requires an explicitly typed owned closure/,
  );
});

test("returns, copies, shares, and deterministically destroys owned closure environments", () => {
  const example = resolve(projectRoot, "examples/owned-closures.z");
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
    () => compileToC(useAfterCapture, "owned-closure-move.z"),
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
  assert.match(hover(source, "closure-editor.z", addUse)?.contents.value ?? "", /add: \(value: i32\) => i32/);
  const parameter = source.indexOf("value: i32") + 1;
  assert.match(hover(source, "closure-editor.z", parameter)?.contents.value ?? "", /value: i32/);
  const items = completions(source.replace("add(41)", "ad"), "closure-editor.z", source.indexOf("add(41)") + 2);
  assert.equal(items.find((item) => item.label === "add")?.detail, "const add: (value: i32) => i32");
});

test("stores and calls explicitly typed non-capturing function values", () => {
  const source = `
    function add(left: i32, right: i32): i32 { return left + right; }
    function subtract(left: i32, right: i32): i32 { return left - right; }

    function apply(operation: (first: i32, second: i32) => i32, left: i32, right: i32): i32 {
      return operation(left, right);
    }

    function choose(addition: bool): (left: i32, right: i32) => i32 {
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
  const generated = compileToC(source, "function-values.z");
  assert.match(generated, /struct Z_Function_[0-9a-f]+ \{[\s\S]*int32_t \(\*call\)\(void \*context, int32_t (?:first|x|left), int32_t (?:second|y|right)\)/);
  assert.match(generated, /operation = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_function_adapter_add/);
  assert.match(generated, /inferred = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_function_adapter_subtract/);
  assert.match(generated, /z_double = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_closure_call_[0-9]+_adapter/);
  assert.match(generated, /= \(operation\)\.call\(\(operation\)\.context, left, right\);/);
  assert.match(generated, /\(\(calculator\)\.operation\)\.call\(\(\(calculator\)\.operation\)\.context, 20, 22\)/);

  const operationUse = source.indexOf("operation(left") + 1;
  assert.match(hover(source, "function-values.z", operationUse)?.contents.value ?? "", /operation: \(first: i32, second: i32\) => i32/);
  const completionSource = source.replace("apply(operation, 20", "apply(oper, 20");
  const completionOffset = completionSource.indexOf("apply(oper, 20") + "apply(oper".length;
  assert.match(
    completions(completionSource, "function-values.z", completionOffset).find((item) => item.label === "operation")?.detail ?? "",
    /\(first: i32, second: i32\) => i32/,
  );

  const directory = mkdtempSync("/tmp/z-function-values-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const captured = source.replace(
    "const double: (value: i32) => i32 = (value: i32): i32 => value * 2;",
    "const offset = 2; const double: (value: i32) => i32 = (value: i32): i32 => value + offset;",
  );
  const capturedDiagnostic = diagnostics(captured, "captured-function-value.z")[0];
  assert.equal(capturedDiagnostic.code, "Z0212");
  assert.match(capturedDiagnostic.message, /borrowed capturing closure/);

  assert.throws(
    () => compileToC(source.replace("= add;", "= subtract;").replace("(x: i32, y: i32) => i32", "(x: i32) => i32"), "function-value-mismatch.z"),
    /expected \(x: i32\) => i32, found \(left: i32, right: i32\) => i32/,
  );
});

test("renders structured ownership diagnostics in the CLI and language server", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/ownership-diagnostic.z");
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
  assert.match(rendered, /note: cleanup-bearing values have a single owner/);
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
    compileToC(capturedOwner, "captured-owner.z");
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
  const editor = diagnostics(missingInout, "missing-inout.z");
  assert.equal(editor[0].code, "Z0301");
  assert.match(editor[0].message, /help: pass mutable storage explicitly as `inout value`/);
});

test("runs deterministic deinit across normal, return, throw, and try exits", () => {
  const example = resolve(projectRoot, "examples/deinit.z");
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
    () => compileToC(source, "owned-copy.z"),
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
    function choose(flag: bool): i32 {
      const resource = Resource({ id: 1 });
      if (flag) {
        consume(resource);
      }
      return resource.id;
    }
    function main(): i32 { return choose(false); }
  `;
  assert.throws(
    () => compileToC(source, "maybe-moved.z"),
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
    () => compileToC(source, "match-moved.z"),
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
    () => compileToC(source, "owned-discard.z"),
    /a cleanup-bearing value must be bound or transferred; it cannot be discarded/,
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
    () => compileToC(source, "deinit-return.z"),
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
    () => compileToC(source, "if-condition.z"),
    /if-condition\.z:3:11: error: expected bool, found i32/,
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
    () => compileToC(pointerTruthiness, "pointer-truthiness.z"),
    /expected bool/,
  );
});

test("requires every reachable if path to return", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; }
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "if-return.z"),
    /function "choose" must end with a return value/,
  );
});

test("rejects statements after every branch exits", () => {
  const source = `
    function choose(flag: bool): i32 {
      if (flag) { return 1; } else { return 2; }
      return 3;
    }
    function main(): i32 { return choose(true); }
  `;
  assert.throws(
    () => compileToC(source, "unreachable.z"),
    /unreachable\.z:4:7: error: unreachable statement after guaranteed function exit/,
  );
});

test("runs while loops with cleanup-aware break and continue", () => {
  const example = resolve(projectRoot, "examples/loops.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=1\ndrop=2\ndrop=3\ndrop=4\ntotal=8\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /Z_Iteration_deinit\(&\(iteration\)\);\n\s+goto _z_loop_continue_0;/);
  assert.match(generated, /Z_Iteration_deinit\(&\(iteration\)\);\n\s+goto _z_loop_break_0;/);
  assert.match(generated, /_z_loop_continue_0: ;\n\s+}\n\s+_z_loop_break_0: ;/);
});

test("iterates fixed arrays, Array values, Slices, and borrowed owned elements", () => {
  const example = resolve(projectRoot, "examples/iteration.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sum=22 slice=18\nvisit=8\nvisit=9\ndrop=9\ndrop=8\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /for \(uintptr_t _z_for_index_/);
  assert.match(generated, /const Z_Resource \*resource = &\(/);
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
  const mutationDiagnostics = diagnostics(structuralMutation, "iteration-mutation.z");
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
    compileToC(movedElement, "iteration-move.z");
  } catch (error) {
    moveError = error;
  }
  assert.ok(moveError instanceof DiagnosticError);
  assert.equal(moveError.code, "Z0203");
  assert.match(moveError.summary, /cannot move borrowed iteration binding "resource"/);
  assert.match(moveError.helps[0], /borrow the element with an `in` parameter/);

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
    () => compileToC(movedOuter, "iteration-outer-move.z"),
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
  assert.match(hover(source, "iteration-editor.z", use)?.contents.value ?? "", /value: i32/);
  const completionSource = source.replace("total = total + value", "total = total + val");
  const completionOffset = completionSource.indexOf("val;", completionSource.indexOf("for")) + 3;
  assert.equal(completions(completionSource, "iteration-editor.z", completionOffset).find((item) => item.label === "value")?.detail, "const value: i32");
  const tokens = decodeSemanticTokens(semanticTokens(source, "iteration-editor.z").data);
  const bindingOffset = source.indexOf("value of");
  const bindingPosition = positionForOffset(source, bindingOffset);
  assert.ok(tokens.some((token) => token.line === bindingPosition.line && token.character === bindingPosition.character));
});

test("formats typed values through the imported console namespace and interpolation", () => {
  const example = resolve(projectRoot, "examples/console.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^42 with text in between, struct: Point \{ x: 20, y: 22 \}; literal \{braces\}, escaped \$\{answer\}\narray \[1, 2, 3\] enum Status\.ready\(7\) class Counter@0x[0-9a-f]+\npartial true done\nsequence 1 then 2\n$/,
  );
  assert.equal(result.stderr, "problem Point { x: 20, y: 22 }\ndebug 42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /fputs\(" with text in between, struct: ", stdout\)/);
  assert.match(generated, /fprintf\(stdout, "%lld", \(long long\)/);
  assert.match(generated, /fflush\(stdout\)/);
  assert.match(generated, /fflush\(stderr\)/);
  assert.match(generated, /switch \(\(_z_console_\d+\)\.tag\)/);
  assert.doesNotMatch(generated, /console\.log/);
});

test("streams native console output before z run exits", async () => {
  const directory = mkdtempSync("/tmp/z-streaming-console-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, `
    import console from "std/console";
    import { sleep } from "std/time";
    function main(): i32 {
      console.log("live");
      sleep(300);
      console.log("done");
      return 0;
    }
  `);

  const child = spawn(process.execPath, [cli, "run", fileName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let sawLive = false;
  const streamedWhileRunning = new Promise<boolean>((resolveStream, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!sawLive && stdout.includes("live\n")) {
        sawLive = true;
        resolveStream(child.exitCode === null);
      }
    });
    child.once("close", () => {
      if (!sawLive) resolveStream(false);
    });
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const completion = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });

  assert.equal(await streamedWhileRunning, true);
  assert.equal(await completion, 0, stderr);
  assert.equal(stdout, "live\ndone\n");
});

test("resolves explicit standard console imports without routing them through Clang", () => {
  const missing = `function main(): i32 { console.log(42); return 0; }`;
  const missingDiagnostic = diagnostics(missing, "missing-console.z")[0];
  assert.equal(missingDiagnostic.code, "Z0403");
  assert.match(missingDiagnostic.message, /import console from "std\/console"/);

  const focused = `
    import logging from "std/console";
    function main(): i32 { logging.log(42); return 0; }
  `;
  assert.deepEqual(diagnostics(focused, "focused-console.z"), []);
  const focusedGenerated = compileToC(focused, "focused-console.z");
  assert.match(focusedGenerated, /fprintf\(stdout, "%lld", \(long long\)/);
  assert.doesNotMatch(focusedGenerated, /#include <std\/console>/);

  const facade = `
    import { console as logging } from "std";
    function main(): i32 { logging.write(42); return 0; }
  `;
  assert.deepEqual(diagnostics(facade, "facade-console.z"), []);
  assert.doesNotMatch(compileToC(facade, "facade-console.z"), /#include <std>/);

  const unknownModule = `import future from "std/future"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(unknownModule, "unknown-std.z")[0].code, "Z0501");
  const unknownExport = `import { future } from "std"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "unknown-std-export.z")[0].message, /std has no export "future"/);
});

test("sleeps the current thread through the portable std/time module", () => {
  const source = `
    import { sleep as pause } from "std/time";
    function main(): i32 {
      pause(1);
      const delay: (milliseconds: u64) => void = pause;
      delay(1);
      return 0;
    }
  `;
  const generated = compileToC(source, "sleep.z");
  assert.match(generated, /#if defined\(_WIN32\)[\s\S]*#include <windows\.h>[\s\S]*#include <time\.h>/);
  assert.match(generated, /static void z_sleep_ms\(uint64_t milliseconds\)/);
  assert.match(generated, /nanosleep\(&remaining, &remaining\)/);
  assert.match(generated, /Sleep\(\(DWORD\)milliseconds\)/);
  assert.match(generated, /z_sleep_ms\(1ULL\);/);
  assert.match(generated, /delay = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_standard_function_adapter_sleep/);
  assert.match(generated, /\(delay\)\.call\(\(delay\)\.context, 1ULL\)/);
  assert.doesNotMatch(generated, /#include <std\/time>/);

  const directory = mkdtempSync("/tmp/z-sleep-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const pauseUse = source.indexOf("pause(1)") + 1;
  assert.match(hover(source, "sleep-editor.z", pauseUse)?.contents.value ?? "", /pause\(milliseconds: u64\): void/);
  assert.match(hover(source, "sleep-editor.z", pauseUse)?.contents.value ?? "", /alias of sleep/);
  const completionSource = source.replace("pause(1)", "pau");
  const completionOffset = completionSource.indexOf("pau", completionSource.indexOf("main")) + 3;
  assert.match(
    completions(completionSource, "sleep-editor.z", completionOffset).find((item) => item.label === "pause")?.detail ?? "",
    /blocks the current thread/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, "sleep-editor.z").data);
  const pausePosition = positionForOffset(source, pauseUse - 1);
  assert.ok(tokens.some((token) => (
    token.line === pausePosition.line
    && token.character === pausePosition.character
    && token.type === semanticTokenTypes.indexOf("function")
  )));

  const defaultImport = `import time from "std/time"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(defaultImport, "sleep-default.z")[0].code, "Z0501");
  const unknownExport = `import { timer } from "std/time"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "sleep-export.z")[0].message, /std\/time has no export "timer"/);
  const wrongType = `import { sleep } from "std/time"; function main(): i32 { sleep(-1); return 0; }`;
  assert.match(diagnostics(wrongType, "sleep-type.z")[0].message, /integer literal -1 does not fit u64/);
});

test("stores, returns, moves, and formats owned String values", () => {
  const example = resolve(projectRoot, "examples/strings.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Message { text: [point=Point { x: 20, y: 22 }, total=42] }\n12left=1|right=2\n[first, second]\nyes=42\nborrowed=42\n42\ndouble|single|literal\nliteral\ndouble\nffi=42\nmade=42\n",
  );

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /typedef struct \{\n  const char \*data;\n  uintptr_t length;/);
  assert.match(generated, /Z_String _z_string_\d+ = z_string_new\(\);/);
  assert.match(generated, /Z_String _z_argument_\d+;/);
  assert.match(generated, /Z_String _z_aggregate_\d+;/);
  assert.match(generated, /const int32_t _z_call_result_\d+ = inspect/);
  assert.match(generated, /if \(\(_z_argument_\d+\)\.capacity > 0\) free\(\(void \*\)\(_z_argument_\d+\)\.data\);/);
  assert.match(generated, /Z_String doubleQuoted = \(Z_String\)\{ \.data = "double", \.length = sizeof\("double"\) - 1, \.capacity = 0 \}/);
  assert.match(generated, /puts\(\(\(doubleQuoted\)\.data != NULL/);
  assert.match(generated, /const char \* const boundary = "literal";/);
  assert.match(generated, /Z_String copied = z_string_from_cstring\(boundary\);/);
  assert.match(generated, /z_string_append_signed/);
  assert.match(generated, /if \(\(self->text\)\.capacity > 0\) free\(\(void \*\)\(self->text\)\.data\);/);

  const source = readFileSync(example, "utf8");
  const chosenOffset = source.indexOf("chosen: String") + 1;
  assert.match(hover(source, example, chosenOffset)?.contents.value ?? "", /chosen: String/);
  const doubleOffset = source.indexOf("doubleQuoted") + 1;
  assert.match(hover(source, example, doubleOffset)?.contents.value ?? "", /doubleQuoted: String/);
  const boundaryOffset = source.indexOf("boundary: cstring") + 1;
  assert.match(hover(source, example, boundaryOffset)?.contents.value ?? "", /boundary: cstring/);
  const fromOffset = source.indexOf("from(boundary)") + 1;
  assert.match(hover(source, example, fromOffset)?.contents.value ?? "", /from\(value: cstring\): String/);
  const completionSource = source.replace("String.from(boundary)", "String.fr");
  const completionOffset = completionSource.indexOf("String.fr") + "String.fr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "from")?.kind, 2);

  const escapingBorrow = `
    function main(): i32 {
      const owned = \`value=42\`;
      const escaped: cstring = owned;
      return 0;
    }
  `;
  assert.match(diagnostics(escapingBorrow, "escaping-cstring.z")[0].message, /expected cstring, found String/);

  const singleQuotedImport = `
    import stdio from 'stdio.h';
    function main(): i32 { return stdio.puts('single import'); }
  `;
  assert.deepEqual(diagnostics(singleQuotedImport, "single-quoted-import.z"), []);
  assert.match(compileToC(singleQuotedImport, "single-quoted-import.z"), /return puts\("single import"\);/);

  const directArgument = `
    function consume(value: String): void {}
    function main(): i32 { consume(\`value=\${42}\`); return 0; }
  `;
  assert.deepEqual(diagnostics(directArgument, "string-argument.z"), []);
  assert.doesNotThrow(() => compileToC(directArgument, "string-argument.z"));

  const throwingArgument = `
    enum ParseError { invalid, }
    function parse(in value: String): i32 throws ParseError { return 42; }
    function forward(): i32 throws ParseError { return try parse(\`value=\${42}\`); }
    function main(): i32 { return 0; }
  `;
  assert.deepEqual(diagnostics(throwingArgument, "throwing-string-argument.z"), []);
  const throwingGenerated = compileToC(throwingArgument, "throwing-string-argument.z");
  assert.match(throwingGenerated, /const Z_Result_i32_ParseError _z_call_result_\d+ = parse/);

  const movedString = `
    import console from "std/console";
    function main(): i32 {
      const first = \`value=42\`;
      const second = first;
      console.log(first);
      return 0;
    }
  `;
  const movedStringDiagnostic = diagnostics(movedString, "moved-string.z");
  assert.equal(movedStringDiagnostic[0].code, "Z0201");
  assert.match(movedStringDiagnostic[0].message, /use of moved value "first"/);

  const cppSource = `
    import console from "std/console";
    import cpp from "cpp_math.hpp";
    function main(): i32 {
      const point = cpp.zcpp.Point({ x: 20, y: 22 });
      const answer = cpp.sum(point);
      const text = \`cpp=\${answer}\`;
      console.log(text);
      return 0;
    }
  `;
  const cppFile = resolve(projectRoot, "examples/string-cpp-probe.z");
  const cppArtifact = compileToNative(cppSource, cppFile);
  assert.equal(cppArtifact.language, "c++");
  const cppCompilation = spawnSync("clang++", [
    "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "examples"),
    "-x", "c++", "-fsyntax-only", "-",
  ], { input: cppArtifact.source, encoding: "utf8" });
  assert.equal(cppCompilation.status, 0, cppCompilation.stderr);

  const cleanupTemporary = `
    import console from "std/console";
    struct Resource { value: i32; deinit {} }
    function make(): Resource { return Resource({ value: 42 }); }
    function main(): i32 {
      console.log(make());
      return 0;
    }
  `;
  const cleanupDiagnostic = diagnostics(cleanupTemporary, "console-temporary.z");
  assert.equal(cleanupDiagnostic[0].code, "Z0402");
  assert.match(cleanupDiagnostic[0].message, /bind the value to a const or let before logging it/);

  const unknownMethod = `
    import console from "std/console";
    function main(): i32 { console.table(42); return 0; }
  `;
  const methodDiagnostic = diagnostics(unknownMethod, "console-method.z");
  assert.equal(methodDiagnostic[0].code, "Z0401");
  assert.match(methodDiagnostic[0].message, /use console\.log, console\.write, console\.error, or console\.debug/);
});

test("exposes console methods and interpolated expressions to editor services", () => {
  const source = `
    import console from "std/console";
    function main(): i32 {
      const answer = 42;
      console.log(\`answer=\${answer}\`);
      return 0;
    }
  `;
  const consoleOffset = source.indexOf("console") + 1;
  assert.match(hover(source, "console-editor.z", consoleOffset)?.contents.value ?? "", /standard console imported as console/);
  const logOffset = source.indexOf("log") + 1;
  assert.match(hover(source, "console-editor.z", logOffset)?.contents.value ?? "", /stdout with newline/);
  const items = completions(source.replace("console.log", "console.lo"), "console-editor.z", source.indexOf("console.log") + "console.lo".length);
  assert.equal(items.find((item) => item.label === "log")?.kind, 2);
  const answerUse = source.lastIndexOf("answer") + 1;
  assert.match(hover(source, "console-editor.z", answerUse)?.contents.value ?? "", /answer: i32/);

  const aliasSource = source
    .replace("import console from", "import logging from")
    .replaceAll("console.log", "logging.log");
  const aliasUse = aliasSource.indexOf("logging.log") + 1;
  assert.match(hover(aliasSource, "console-alias-editor.z", aliasUse)?.contents.value ?? "", /standard console imported as logging/);
  const incompleteAlias = aliasSource.replace("logging.log", "logging.lo");
  const incompleteAliasOffset = incompleteAlias.indexOf("logging.lo") + "logging.lo".length;
  assert.equal(completions(incompleteAlias, "console-alias-editor.z", incompleteAliasOffset).find((item) => item.label === "log")?.kind, 2);
  const symbolSource = `
    import logging from "std/console";
    function main(): i32 { logg; return 0; }
  `;
  const symbolOffset = symbolSource.indexOf("logg;") + 4;
  assert.equal(completions(symbolSource, "console-alias-editor.z", symbolOffset).find((item) => item.label === "logging")?.kind, 9);
});

test("keeps loop control inside an enclosing loop", () => {
  const outsideBreak = `
    function main(): i32 {
      break;
      return 0;
    }
  `;
  assert.throws(() => compileToC(outsideBreak, "break-outside.z"), /break requires an enclosing loop/);

  const outsideContinue = outsideBreak.replace("break", "continue");
  assert.throws(() => compileToC(outsideContinue, "continue-outside.z"), /continue requires an enclosing loop/);

  const unreachable = `
    function main(): i32 {
      while (true) {
        break;
        return 1;
      }
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(unreachable, "loop-unreachable.z"),
    /unreachable statement after guaranteed loop control transfer/,
  );
});

test("requires boolean while conditions", () => {
  const source = `
    function main(): i32 {
      while (42) { break; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(source, "while-condition.z"), /expected bool, found i32/);
});

test("reaches a fixed ownership state across loop iterations", () => {
  const repeatedMove = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): void {}
    function main(): i32 {
      let index = 0;
      const resource = Resource({ id: 1 });
      while (index < 2) {
        consume(resource);
        index = index + 1;
      }
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(repeatedMove, "loop-repeated-move.z"),
    /resource.*may have been moved|may have been moved.*resource/,
  );

  const maybeMovedAfterBreak = repeatedMove
    .replace("index = index + 1;", "break;")
    .replace("      return 0;", "      consume(resource);\n      return 0;");
  assert.throws(
    () => compileToC(maybeMovedAfterBreak, "loop-break-move.z"),
    /resource.*may have been moved|may have been moved.*resource/,
  );

  const restored = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): void {}
    function main(): i32 {
      let index = 0;
      let resource = Resource({ id: 1 });
      while (index < 2) {
        consume(resource);
        resource = Resource({ id: index + 2 });
        index = index + 1;
      }
      consume(resource);
      return 0;
    }
  `;
  assert.match(compileToC(restored, "loop-restored-owner.z"), /while \(index < 2\)/);
});

test("lowers loop control through match without targeting the generated switch", () => {
  const source = `
    enum Action { skip, stop, }
    function main(): i32 {
      let running = true;
      while (running) {
        match (Action.stop) {
          skip => { continue; }
          stop => { break; }
        }
      }
      return 0;
    }
  `;
  const generated = compileToC(source, "loop-match-control.z");
  assert.match(generated, /case Z_Action_skip:[\s\S]*goto _z_loop_continue_0;/);
  assert.match(generated, /case Z_Action_stop:[\s\S]*goto _z_loop_break_0;/);
});

test("keeps loop-local bindings visible to editor services", () => {
  const source = `
    function main(): i32 {
      let index = 0;
      while (index < 1) {
        const inside = index;
        ins;
      }
      return 0;
    }
  `;
  const offset = source.indexOf("ins;") + 3;
  const items = completions(source, "loop-editor.z", offset);
  assert.equal(items.find((item) => item.label === "inside")?.detail, "const inside: i32");
});

test("runs fixed arrays with checked indexing and reverse element cleanup", () => {
  const example = resolve(projectRoot, "examples/arrays.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "length=4 sum=112\nmiddle=2\ndrop=3\ndrop=2\ndrop=1\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /if \(index >= length\) abort\(\);/);
  assert.match(generated, /data\[z_bounds_index\(\(uintptr_t\)\(2\), 4\)\]\) = 42/);
  assert.match(generated, /for \(uintptr_t _z_cleanup_index_\d+ = 3;[\s\S]*Z_Item_deinit/);
});

test("checks fixed array types, indices, and mutability", () => {
  const immutable = `
    function main(): i32 {
      const values = [1, 2, 3];
      values[0] = 4;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, "array-immutable.z"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const wrongLength = `
    function main(): i32 {
      const values: i32[3] = [1, 2];
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongLength, "array-length.z"), /expected i32\[3\], found i32\[2\]/);

  const wrongIndex = `
    function main(): i32 {
      const values = [1, 2];
      return values[1.5];
    }
  `;
  assert.throws(() => compileToC(wrongIndex, "array-index.z"), /array index must be an integer, found f64/);

  const staticBounds = wrongIndex.replace("1.5", "2");
  assert.throws(
    () => compileToC(staticBounds, "array-static-bounds.z"),
    /array index 2 is out of bounds for length 2/,
  );

  const empty = `function main(): i32 { const values = []; return 0; }`;
  assert.throws(() => compileToC(empty, "array-empty.z"), /cannot infer an empty fixed array/);
});

test("supports nested fixed arrays and arrays inside value structs", () => {
  const source = `
    struct Matrix { rows: i32[2][2]; }
    function main(): i32 {
      let matrix = Matrix({ rows: [[1, 2], [3, 4]] });
      matrix.rows[1][0] = 20;
      return matrix.rows[1][0] + matrix.rows[0][1];
    }
  `;
  const generated = compileToC(source, "nested-arrays.z");
  assert.match(generated, /data\[2\]/);
  assert.match(generated, /struct Z_Matrix/);
  assert.match(generated, /z_bounds_index/);

  const recursive = `
    struct Node { children: Node[1]; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(recursive, "recursive-array-layout.z"), /recursive value layout/);
});

test("does not move cleanup-bearing elements out of fixed arrays", () => {
  const source = `
    struct Item { value: i32; deinit {} }
    function consume(item: Item): void {}
    function main(): i32 {
      let items = [Item({ value: 1 }), Item({ value: 2 })];
      consume(items[0]);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "array-element-move.z"),
    /cannot move a cleanup-bearing field or element out of its owner/,
  );
});

test("exposes fixed array length and readable types to editor services", () => {
  const source = `
    function main(): i32 {
      const values = [1, 2, 3];
      values.;
      return 0;
    }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "array-editor.z", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const valuesDeclaration = valid.indexOf("values =");
  assert.match(hover(valid, "array-editor.z", valuesDeclaration + 1)?.contents.value ?? "", /values: i32\[3\]/);
});

test("borrows fixed arrays as read-only and mutable Slice parameters", () => {
  const example = resolve(projectRoot, "examples/slices.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "before=10 after=28\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z_Slice_[\s\S]*int32_t \*data;\n\s+uintptr_t length;/);
  assert.match(generated, /static int32_t sum\(Z_Slice_\S+ values\)/);
  assert.match(generated, /sum\(\(Z_Slice_\S+\)\{ \.data = \(values\)\.data, \.length = 4 \}\)/);
});

test("keeps Slice values non-escaping until lifetime contracts exist", () => {
  const returned = `
    function expose(values: Slice<i32>): Slice<i32> { return values; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(returned, "slice-return.z"),
    /returning Slice values requires an explicit lifetime contract/,
  );

  const stored = `
    struct Holder { values: Slice<i32>; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(stored, "slice-field.z"), /Slice values cannot be stored in struct or class fields/);

  const local = `
    function inspect(values: Slice<i32>): i32 {
      const saved = values;
      return saved.length;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(local, "slice-local.z"), /Slice values cannot be stored in local bindings yet/);
});

test("checks Slice capabilities, element types, and overlapping borrows", () => {
  const readOnlyMutation = `
    function mutate(values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(readOnlyMutation, "slice-readonly.z"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const redundantIn = `
    function inspect(in values: Slice<i32>): i32 { return values.length; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(redundantIn, "slice-in.z"), /Slice parameters are already borrowed; omit `in`/);

  const immutableMutation = `
    function fill(inout values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 {
      const values = [1, 2];
      fill(inout values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutableMutation, "slice-const.z"), /requires a mutable let binding/);

  const wrongElement = `
    function sum(values: Slice<u32>): u32 { return values[0]; }
    function main(): i32 {
      const values = [1, 2];
      sum(values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "slice-element.z"), /expected Slice<u32>, found i32\[2\]/);

  const overlap = `
    function mix(inout target: Slice<i32>, source: Slice<i32>): void {}
    function main(): i32 {
      let values = [1, 2];
      mix(inout values, values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(overlap, "slice-overlap.z"), /overlapping inout and in uses of "values"/);
});

test("exposes Slice length and generic spelling to editor services", () => {
  const source = `
    function inspect(values: Slice<i32>): i32 {
      values.;
      return 0;
    }
    function main(): i32 { return 0; }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  assert.equal(completions(source, "slice-editor.z", offset).find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const declaration = valid.indexOf("values:");
  assert.match(hover(valid, "slice-editor.z", declaration + 1)?.contents.value ?? "", /values: Slice<i32>/);
});

test("monomorphizes generic structs and functions", () => {
  const example = resolve(projectRoot, "examples/generics.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "generic=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z___z_mono_Pair_i32/);
  assert.match(generated, /__z_mono_first_i32/);
  assert.doesNotMatch(generated, /\bT\b/);
});

test("creates distinct generic instances and preserves ownership semantics", () => {
  const distinct = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const number = identity<i32>(42);
      const flag = identity<bool>(true);
      if (flag) { return number; }
      return 0;
    }
  `;
  const generated = compileToC(distinct, "generic-distinct.z");
  assert.match(generated, /__z_mono_identity_i32/);
  assert.match(generated, /__z_mono_identity_bool/);

  const moved = `
    struct Resource { id: i32; deinit {} }
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const resource = Resource({ id: 1 });
      const other = identity(resource);
      return resource.id + other.id;
    }
  `;
  assert.throws(() => compileToC(moved, "generic-move.z"), /use of moved value "resource"/);
});

test("infers generic calls while preserving explicit instantiation", () => {
  const wrongArity = `
    struct Pair<T, U> { first: T; second: U; }
    function main(): i32 { const pair = Pair<i32>({ first: 1, second: 2 }); return 0; }
  `;
  assert.throws(() => compileToC(wrongArity, "generic-arity.z"), /Pair expects 2 type argument\(s\), received 1/);

  const implicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(42); }
  `;
  assert.match(compileToC(implicit, "generic-inferred.z"), /__z_mono_identity_i32\(42\)/);

  const explicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity<i32>(42); }
  `;
  assert.match(compileToC(explicit, "generic-explicit.z"), /__z_mono_identity_i32\(42\)/);

  const ambiguous = `
    function make<T>(): T { return 1; }
    function main(): i32 { return make(); }
  `;
  assert.throws(() => compileToC(ambiguous, "generic-ambiguous.z"), /cannot infer type parameter "T" for "make"/);

  const conflicting = `
    function choose<T>(left: T, right: T): T { return left; }
    function main(): i32 { return choose(1, true); }
  `;
  assert.throws(() => compileToC(conflicting, "generic-conflict.z"), /conflicting inferred types for T.*i32 and bool/);

  const duplicate = `
    struct Invalid<T, T> { value: T; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(duplicate, "generic-duplicate.z"), /duplicate type parameter "T"/);
});

test("infers generic aggregate construction, class construction, and static factories", () => {
  const source = `
    struct Pair<T> {
      first: T;
      second: T;
    }
    class Envelope<T> {
      private value: T;
      constructor(value: T) { this.value = value; }
      function get(): T { return this.value; }
    }
    class Holder<T> { value: T; }
    struct Container<T> {
      value: T;
      static function wrap(value: T): Container<T> {
        return Container({ value });
      }
    }
    class Shelf<T> {
      private content: Container<T>;
      constructor(value: T) { this.content = Container.wrap(value); }
      function get(): T { return this.content.value; }
    }
    struct Marker<T> {
      tag: i32;
      static function create(): Marker<T> { return Marker<T>({ tag: 0 }); }
    }
    function makeMarker(): Marker<i32> { return Marker.create(); }
    function main(): i32 {
      const pair = Pair({ first: 20, second: 22 });
      const envelope = new Envelope(42);
      const holder = new Holder({ value: 42 });
      const wrapped = Container.wrap(42);
      const explicit = Container.wrap<i32>(42);
      const shelf = new Shelf(42);
      const marker: Marker<i32> = Marker.create();
      return pair.first + pair.second + envelope.get() + holder.value
        + wrapped.value + explicit.value + shelf.get() + marker.tag + makeMarker().tag - 252;
    }
  `;
  const generated = compileToC(source, "aggregate-inference.z");
  assert.match(generated, /Z___z_mono_Pair_i32/);
  assert.match(generated, /Z___z_mono_Envelope_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Holder_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Container_i32_wrap\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Shelf_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Marker_i32_create\(void\)/);
  assert.match(hover(source, "aggregate-inference.z", source.indexOf("pair =") + 1)?.contents.value ?? "", /pair: Pair<i32>/);
  assert.match(hover(source, "aggregate-inference.z", source.indexOf("envelope =") + 1)?.contents.value ?? "", /envelope: Envelope<i32>/);
  assert.match(hover(source, "aggregate-inference.z", source.indexOf("wrapped =") + 1)?.contents.value ?? "", /wrapped: Container<i32>/);

  const contextualWidth = `
    struct Pair<T> { first: T; second: T; }
    function wide(): i64 {
      const pair: Pair<i64> = Pair({ first: 20, second: 22 });
      return pair.first + pair.second;
    }
    function main(): i32 { return 0; }
  `;
  assert.match(compileToC(contextualWidth, "aggregate-expected-type.z"), /struct Z___z_mono_Pair_i64 \{[\s\S]*int64_t first/);

  const conflict = `
    struct Pair<T> { first: T; second: T; }
    function main(): i32 { const pair = Pair({ first: 1, second: true }); return 0; }
  `;
  assert.throws(() => compileToC(conflict, "aggregate-inference-conflict.z"), /conflicting inferred types for T.*i32 and bool/);

  const ambiguous = `
    struct Marker<T> { tag: i32; static function create(): Marker<T> { return Marker<T>({ tag: 0 }); } }
    function main(): i32 { const marker = Marker.create(); return marker.tag; }
  `;
  assert.throws(() => compileToC(ambiguous, "static-inference-ambiguous.z"), /cannot infer type parameter "T" for "Marker\.create"/);

  const wrongStaticArity = source.replace("Container.wrap<i32>(42)", "Container.wrap<i32, bool>(42)");
  assert.throws(() => compileToC(wrongStaticArity, "static-inference-arity.z"), /expects 1 type argument\(s\), received 2/);

  const oldStaticShape = source.replace("Container.wrap<i32>(42)", "Container<i32>.wrap(42)");
  assert.throws(() => compileToC(oldStaticShape, "static-owner-specialization.z"), /static generic arguments follow the method name/);
});

test("infers nested generic calls and calls within generic functions", () => {
  const source = `
    struct Envelope<T> { value: T; }
    function identity<T>(value: T): T { return value; }
    function unwrap<T>(envelope: Envelope<T>): T { return identity(envelope.value); }
    function main(): i32 {
      const envelope = Envelope({ value: 42 });
      return identity(unwrap(envelope));
    }
  `;
  const generated = compileToC(source, "generic-nested-inference.z");
  assert.match(generated, /__z_mono_unwrap_i32/);
  assert.match(generated, /__z_mono_identity_i32/);
});

test("infers generic Slice element types from fixed arrays", () => {
  const source = `
    function firstItem<T>(values: Slice<T>): T { return values[0]; }
    function main(): i32 {
      const values = [42, 43];
      return firstItem(values);
    }
  `;
  const generated = compileToC(source, "generic-slice-inference.z");
  assert.match(generated, /__z_mono_firstItem_i32/);
  assert.match(generated, /\.length = 2/);
});

test("infers generic arguments from imported C results", () => {
  const source = `
    import stdio from "stdio.h";
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(stdio.getchar()); }
  `;
  const generated = compileToC(source, "generic-c-inference.z");
  assert.match(generated, /__z_mono_identity_i32\(getchar\(\)\)/);
});

test("checks nominal trait constraints on inferred and explicit generic instances", () => {
  const example = resolve(projectRoot, "examples/generic-constraints.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "measured=42\n");

  const structuralOnly = `
    trait Measured { function measure(): i32; }
    struct Reading { function measure(): i32 { return 42; } }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { return read(Reading({})); }
  `;
  assert.throws(
    () => compileToC(structuralOnly, "generic-constraint-nominal.z"),
    /Reading does not satisfy Measured for T in "read"/,
  );

  const primitive = `
    trait Measured { function measure(): i32; }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { return read<i32>(42); }
  `;
  assert.throws(
    () => compileToC(primitive, "generic-constraint-primitive.z"),
    /i32 does not satisfy Measured for T in "read"/,
  );

  const unknown = `
    function read<T: Missing>(value: T): T { return value; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(unknown, "generic-constraint-unknown.z"), /unknown trait constraint "Missing"/);

  const outsideSurface = `
    trait Measured { function measure(): i32; }
    function reveal<T: Measured>(value: T): i32 { return value.secret(); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(outsideSurface, "generic-constraint-surface.z"),
    /member "secret" is not provided by the trait constraints on T/,
  );
});

test("supports multiple trait constraints and constrained generic aggregates", () => {
  const valid = `
    trait Measured { function measure(): i32; }
    trait Named { function name(): cstring; }
    struct Reading implements Measured, Named {
      function measure(): i32 { return 42; }
      function name(): cstring { return "reading"; }
    }
    struct Holder<T: Measured & Named> { value: T; }
    function read<T: Measured & Named>(value: T): i32 {
      return identity(value.measure());
    }
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const holder = Holder<Reading>({ value: Reading({}) });
      return read(holder.value);
    }
  `;
  assert.match(compileToC(valid, "generic-multiple-constraints.z"), /__z_mono_Holder_Reading/);

  const invalidAggregate = `
    trait Measured { function measure(): i32; }
    struct Plain {}
    struct Holder<T: Measured> { value: T; }
    function main(): i32 { const holder = Holder<Plain>({ value: Plain({}) }); return 0; }
  `;
  assert.throws(
    () => compileToC(invalidAggregate, "generic-aggregate-constraint.z"),
    /Plain does not satisfy Measured for T in "Holder"/,
  );
});

test("shows generic trait constraints in editor signatures", () => {
  const source = `
    trait Measured { function measure(): i32; }
    struct Reading implements Measured { function measure(): i32 { return 42; } }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { rea; return 0; }
  `;
  const declaration = source.indexOf("read<T:");
  assert.match(
    hover(source.replace(" rea;", ""), "generic-constraint-editor.z", declaration + 1)?.contents.value ?? "",
    /function read<T: Measured>\(value: T\): i32/,
  );
  const offset = source.indexOf("rea;") + 3;
  assert.equal(
    completions(source, "generic-constraint-editor.z", offset).find((item) => item.label === "read")?.detail,
    "function read<T: Measured>",
  );
});

test("exposes generic templates without leaking monomorphized names to editor completion", () => {
  const source = `
    struct Envelope<T> { value: T; }
    function identity<T>(value: T): T { return value; }
    function main(): i32 { const value = identity<i32>(1); ide; return value; }
  `;
  const offset = source.indexOf("ide;") + 3;
  const items = completions(source, "generic-editor.z", offset);
  assert.equal(items.find((item) => item.label === "identity")?.detail, "function identity<T>");
  assert.equal(items.some((item) => item.label.startsWith("__z_mono_")), false);
  const declaration = source.indexOf("identity<T>");
  assert.match(hover(source.replace(" ide;", ""), "generic-editor.z", declaration + 1)?.contents.value ?? "", /function identity<T>/);
});

test("shows source generic fields and concrete generic binding types on hover", () => {
  const source = `
    struct Pair<T> {
      first: T;
      second: T;
    }
    function first<T>(pair: Pair<T>): T { return pair.first; }
    function main(): i32 {
      const pair = Pair({ first: 20, second: 22 });
      return pair.second;
    }
  `;
  const firstField = source.indexOf("first: T");
  const secondField = source.indexOf("second: T");
  const firstInitializer = source.indexOf("first: 20");
  const secondInitializer = source.indexOf("second: 22");
  const pairBinding = source.indexOf("pair =");
  assert.match(hover(source, "generic-hover.z", firstField + 1)?.contents.value ?? "", /first: T/);
  assert.match(hover(source, "generic-hover.z", secondField + 1)?.contents.value ?? "", /second: T/);
  assert.match(hover(source, "generic-hover.z", firstInitializer + 1)?.contents.value ?? "", /first: i32/);
  assert.match(hover(source, "generic-hover.z", secondInitializer + 1)?.contents.value ?? "", /second: i32/);
  const pairHover = hover(source, "generic-hover.z", pairBinding + 1)?.contents.value ?? "";
  assert.match(pairHover, /pair: Pair<i32>/);
  assert.doesNotMatch(pairHover, /__z_mono_/);
  const beforeFirst = source.slice(0, firstField).split("\n");
  const firstToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.z").data).find((token) => (
    token.line === beforeFirst.length - 1 && token.character === beforeFirst.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[firstToken?.type ?? -1], "property");
  const beforeInitializer = source.slice(0, firstInitializer).split("\n");
  const initializerToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.z").data).find((token) => (
    token.line === beforeInitializer.length - 1 && token.character === beforeInitializer.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[initializerToken?.type ?? -1], "property");
});

test("grows owned Array values with checked indexing and generic inout mutation", () => {
  const example = resolve(projectRoot, "examples/dynamic-arrays.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "length=3 capacity=4 middle=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z_DynamicArray_/);
  assert.match(generated, /realloc\(self->data, next \* sizeof\(int32_t\)\)/);
  assert.match(generated, /z_bounds_index/);
  assert.match(generated, /free\(\(values\)\.data\)/);
});

test("borrows growable Array storage as read-only and mutable Slice values", () => {
  const source = `
    function first<T>(values: Slice<T>): T { return values[0]; }
    function replace(inout values: Slice<i32>, value: i32): void { values[0] = value; }
    function main(): i32 {
      let values = Array<i32>();
      values.push(1);
      replace(inout values, 42);
      return first(values);
    }
  `;
  const generated = compileToC(source, "dynamic-array-slice.z");
  assert.match(generated, /\.data = \(values\)\.data, \.length = \(values\)\.length/);
  assert.match(generated, /__z_mono_first_i32/);
});

test("specializes generic Array mutation helpers for every element type", () => {
  const source = `
    function append<T>(inout values: Array<T>, value: T): void { values.push(value); }
    function main(): i32 {
      let numbers = Array<i32>();
      let flags = Array<bool>();
      append(inout numbers, 42);
      append(inout flags, true);
      if (flags[0]) { return numbers[0]; }
      return 0;
    }
  `;
  const generated = compileToC(source, "dynamic-array-specializations.z");
  assert.match(generated, /DynamicArray_.*i32.*_push/);
  assert.match(generated, /DynamicArray_.*bool.*_push/);
  const compilation = spawnSync("clang", ["-x", "c", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], {
    input: generated,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);
});

test("parses adjacent generic closers for nested Array types", () => {
  const source = `
    function main(): i32 {
      let inner = Array<i32>();
      inner.push(42);
      let outer = Array<Array<i32>>();
      outer.push(inner);
      return outer[0][0];
    }
  `;
  const generated = compileToC(source, "nested-dynamic-arrays.z");
  assert.match(generated, /Z_DynamicArray_.*Z_DynamicArray_/);
  assert.match(generated, /free\(\(\(outer\)\.data\[/);
});

test("moves Array storage and destroys initialized owned elements in reverse order", () => {
  const example = resolve(projectRoot, "examples/dynamic-array-cleanup.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=2\ndrop=1\n");
  assert.throws(
    () => compileToC(source.replace("  return 0;", "  return first.id;"), "dynamic-array-move.z"),
    /use of moved value "first"/,
  );

  const movedArray = `
    function main(): i32 {
      let first = Array<i32>();
      first.push(1);
      const second = first;
      return first.length + second.length;
    }
  `;
  assert.throws(() => compileToC(movedArray, "dynamic-array-owner-move.z"), /use of moved value "first"/);
});

test("checks Array mutation, element types, and partial moves", () => {
  const empty = `
    function main(): i32 { const values = Array<i32>(); return 0; }
  `;
  const emptyGenerated = compileToC(empty, "dynamic-array-empty.z");
  assert.doesNotMatch(emptyGenerated, /DynamicArray_.*_push\(/);

  const immutable = `
    function main(): i32 {
      const values = Array<i32>();
      values.push(1);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutable, "dynamic-array-const.z"), /Array.push requires addressable let storage/);

  const wrongElement = `
    function main(): i32 {
      let values = Array<i32>();
      values.push(true);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "dynamic-array-element.z"), /expected i32, found bool/);

  const partialMove = `
    struct Item { id: i32; deinit {} }
    function main(): i32 {
      let values = Array<Item>();
      values.push(Item({ id: 1 }));
      const item = values[0];
      return item.id;
    }
  `;
  assert.throws(() => compileToC(partialMove, "dynamic-array-partial-move.z"), /cannot move a cleanup-bearing field or element out of its owner/);
});

test("exposes Array members and source-level types to editor services", () => {
  const source = `
    function main(): i32 {
      let values = Array<i32>();
      values.;
      return 0;
    }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "dynamic-array-editor.z", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");
  assert.equal(items.find((item) => item.label === "capacity")?.detail, "usize");
  assert.match(items.find((item) => item.label === "push")?.detail ?? "", /push\(value: i32\): void/);

  const valid = source.replace("      values.;", "      values.push(1);");
  const declaration = valid.indexOf("values =");
  assert.match(hover(valid, "dynamic-array-editor.z", declaration + 1)?.contents.value ?? "", /values: Array<i32>/);
  const push = valid.indexOf("push(1)");
  assert.match(hover(valid, "dynamic-array-editor.z", push + 1)?.contents.value ?? "", /push\(value: i32\): void/);
});

test("checks logical operand types", () => {
  const source = `
    function main(): i32 {
      const invalid = true && 1;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "logical-types.z"),
    /operator "&&" requires bool operands/,
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
  const generated = compileToC(source, "point.z");
  assert.match(generated, /struct Z_Point \{/);
  assert.match(generated, /static int32_t Z_Point_sum\(const Z_Point \*self\)/);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \};/);
  assert.match(generated, /return Z_Point_sum\(&\(point\)\);/);
});

test("constructs structs from object values and classes through class-only new", () => {
  const example = resolve(projectRoot, "examples/construction.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \}/);
  assert.match(generated, /Z_Session \* const session = Z_Session_new/);

  const structWithNew = source.replace("Point({ x: 20, y: 22 })", "new Point({ x: 20, y: 22 })");
  assert.throws(() => compileToC(structWithNew, "new-struct.z"), /new requires a class type/);

  const classWithoutNew = source.replace("new Session({ id: point.x + point.y })", "Session({ id: point.x + point.y })");
  assert.throws(() => compileToC(classWithoutNew, "class-without-new.z"), /class construction requires new Session/);

  const legacy = source.replace("Point({ x: 20, y: 22 })", "Point { x: 20, y: 22 }");
  assert.throws(() => compileToC(legacy, "legacy-construction.z"));

  const qualifiedLegacy = `
    import geometry from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point = geometry.ZPoint { x: 20, y: 22 };
      return point.x + point.y - 42;
    }
  `;
  assert.throws(() => compileToC(qualifiedLegacy, "qualified-legacy-construction.z"));
});

test("initializes private class state through safe user constructors", () => {
  const example = resolve(projectRoot, "examples/constructors.z");
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
  assert.throws(() => compileToC(privateRead, "private-field.z"), /field "id" is private to class "Session"/);

  const missingField = source.replace("    this.name = name;\n", "");
  assert.throws(() => compileToC(missingField, "constructor-missing-field.z"), /does not initialize field "name"/);

  const earlyRead = source.replace("    this.id = id;", "    this.name = this.name;\n    this.id = id;");
  assert.throws(() => compileToC(earlyRead, "constructor-early-read.z"), /field "name" is read before it is initialized/);

  const escapedThis = source.replace("    this.id = id;", "    const escaped = this;\n    this.id = id;");
  assert.throws(() => compileToC(escapedThis, "constructor-this-escape.z"), /this cannot escape before field "id" is initialized/);

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
      constructor(value: i32, positive: bool) {
        if (positive) { this.value = value; }
        else { this.value = -value; }
      }
      function read(): i32 { return this.value; }
    }
    function main(): i32 { const choice = new Choice(42, true); return choice.read() - 42; }
  `;
  assert.doesNotThrow(() => compileToC(branchInitialized, "constructor-branches.z"));
  const incompleteBranch = branchInitialized.replace("else { this.value = -value; }", "else {}");
  assert.throws(() => compileToC(incompleteBranch, "constructor-incomplete-branch.z"), /does not initialize field "value"/);

  const genericConstructor = `
    class Envelope<T> {
      private value: T;
      constructor(value: T) { this.value = value; }
      function get(): T { return this.value; }
    }
    function main(): i32 { const envelope = new Envelope(42); return envelope.get() - 42; }
  `;
  assert.match(compileToC(genericConstructor, "generic-class-constructor.z"), /Z___z_mono_Envelope_i32_new\(int32_t value\)/);

  const objectBypass = `
    class Secret { private value: i32; constructor(value: i32) { this.value = value; } }
    enum Wrapped { secret Secret }
    function main(): i32 { const wrapped = Wrapped.secret({ value: 42 }); return 0; }
  `;
  assert.throws(() => compileToC(objectBypass, "constructor-object-bypass.z"), /has a constructor and cannot be initialized from an object value/);

  const privatePattern = `
    class Secret { private value: i32; constructor(value: i32) { this.value = value; } }
    enum Wrapped { secret Secret }
    function read(wrapped: Wrapped): i32 {
      return match (wrapped) { secret({ value }) => value; };
    }
    function main(): i32 { const secret = new Secret(42); return read(Wrapped.secret(secret)) - 42; }
  `;
  assert.throws(() => compileToC(privatePattern, "private-pattern.z"), /field "value" is private to class "Secret"/);
});

test("runs visible type-scoped static methods on structs, classes, and generic instances", () => {
  const example = resolve(projectRoot, "examples/static-methods.z");
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
  assert.match(compileToC(generic, "generic-static.z"), /Z___z_mono_Container_i32_wrap\(int32_t value\)/);

  const directory = mkdtempSync("/tmp/z-static-module-");
  const factory = resolve(directory, "factory.z");
  const main = resolve(directory, "main.z");
  writeFileSync(factory, `
    export struct Factory {
      static function answer(): i32 { return 42; }
    }
  `);
  const imported = `
    import { Factory } from "./factory.z";
    function main(): i32 { return Factory.answer() - 42; }
  `;
  writeFileSync(main, imported);
  assert.match(compileToC(imported, main), /__z_module_\d+_Factory_answer\(void\)/);
  const importedCompletion = imported.replace("return Factory.answer() - 42;", "Factory.; return 0;");
  const importedOffset = importedCompletion.indexOf("Factory.;") + "Factory.".length;
  assert.equal(completions(importedCompletion, main, importedOffset).some((item) => item.label === "answer"), true);
  const namespaced = `
    import factory from "./factory.z";
    function main(): i32 { return factory.Factory.answer() - 42; }
  `;
  assert.match(compileToC(namespaced, main), /__z_module_\d+_Factory_answer\(void\)/);
  const namespaceCompletion = namespaced.replace("return factory.Factory.answer() - 42;", "factory.Factory.; return 0;");
  const namespaceOffset = namespaceCompletion.indexOf("factory.Factory.;") + "factory.Factory.".length;
  assert.equal(completions(namespaceCompletion, main, namespaceOffset).some((item) => item.label === "answer"), true);
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
  assert.doesNotThrow(() => compileToC(base, "static-capabilities.z"));
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "session.create(1).identifier()"), "static-through-instance.z"),
    /static method "create" must be called as Session\.create\(\)/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "Session.identifier()"), "instance-through-type.z"),
    /instance method "identifier" must be called through a Session value/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "Session.secret()"), "private-static.z"),
    /static method "secret" is private to class "Session"/,
  );
  assert.throws(
    () => compileToC(base.replace("session.identifier()", "session.hidden()"), "private-instance.z"),
    /method "hidden" is private to class "Session"/,
  );
  assert.throws(
    () => compileToC(base.replace("static function create(id: i32)", "static function create(inout this, id: i32)"), "static-this.z"),
    /static methods cannot declare a `this` receiver/,
  );
  assert.throws(
    () => compileToC(base.replace("private id: i32;", "static id: i32;"), "static-field.z"),
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
  const staticItems = completions(source, "static-editor.z", staticOffset);
  assert.equal(staticItems.some((item) => item.label === "create"), true);
  assert.equal(staticItems.some((item) => item.label === "secret"), false);
  assert.equal(staticItems.some((item) => item.label === "identifier"), false);

  const instanceSource = source.replace("      Session.;\n", "");
  const instanceOffset = instanceSource.indexOf("session.;") + "session.".length;
  const instanceItems = completions(instanceSource, "static-editor.z", instanceOffset);
  assert.equal(instanceItems.some((item) => item.label === "identifier"), true);
  assert.equal(instanceItems.some((item) => item.label === "create"), false);

  const valid = source.replace("      Session.;\n", "").replace("      session.;\n", "");
  const createOffset = valid.indexOf("Session.create") + "Session.".length;
  assert.match(hover(valid, "static-editor.z", createOffset + 1)?.contents.value ?? "", /public static function create\(id: i32\): Session/);
  const tokens = decodeSemanticTokens(semanticTokens(valid, "static-editor.z").data);
  const declarationOffset = valid.indexOf("create(id");
  assert.match(hover(valid, "static-editor.z", declarationOffset + 1)?.contents.value ?? "", /public static function create/);
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
  const genericItems = completions(genericSource, "generic-static-editor.z", genericOffset);
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
    () => compileToC(source, "missing-field.z"),
    /missing-field\.z:7:27: error: missing field "y" when constructing "Point"/,
  );
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
    () => compileToC(source, "method-arguments.z"),
    /method-arguments\.z:10:26: error: expected i32, found String/,
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
    () => compileToC(source, "exhaustive.z"),
    /exhaustive\.z:8:7: error: non-exhaustive match; missing Outcome\.failure/,
  );
});

test("compiles payload enums and exhaustive matches", () => {
  const example = resolve(projectRoot, "examples/match.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "matched=42\n");
});

test("composes enums through value aggregates and emits dependency-ordered C layouts", () => {
  const example = resolve(projectRoot, "examples/aggregate-enums.z");
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
    () => compileToC(recursive, "recursive-aggregate.z"),
    /type "(?:Link|Node)" has a recursive value layout/,
  );
});

test("moves, matches, nests, and destroys cleanup-bearing enum payloads", () => {
  const example = resolve(projectRoot, "examples/owned-enums.z");
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
    () => compileToC(moved, "owned-enum-move.z"),
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
    () => compileToC(borrowedTemporary, "borrowed-match-temporary.z"),
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
    () => compileToC(borrowedMove, "borrowed-match-move.z"),
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
    () => compileToC(borrowedMutation, "borrowed-match-mutation.z"),
    /cannot assign to immutable binding "choice"/,
  );
});

test("compiles expression matches with concise and selecting block arms", () => {
  const example = resolve(projectRoot, "examples/match-expression.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "code=41\ndirect=41\nselected=42\n");
});

test("constructs contextual enum payloads and destructures their named fields", () => {
  const example = resolve(projectRoot, "examples/enum-patterns.z");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /\.data\.ready = \(Z_Response\)\{ \.status = 200/);
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
  const example = resolve(projectRoot, "examples/option.z");
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
  assert.match(hover(source, "match-editor.z", failedUse)?.contents.value ?? "", /failed: Result<User, UserError>/);
  const successVariant = source.indexOf("success(user)") + 1;
  assert.match(hover(source, "match-editor.z", successVariant)?.contents.value ?? "", /Result<User, UserError>\.success\(User\)/);
  const userBinding = source.indexOf("user) =>") + 1;
  assert.match(hover(source, "match-editor.z", userBinding)?.contents.value ?? "", /user: User/);
  const errorBinding = source.indexOf("error) =>") + 1;
  assert.match(hover(source, "match-editor.z", errorBinding)?.contents.value ?? "", /error: UserError/);

  const tokens = decodeSemanticTokens(semanticTokens(source, "match-editor.z").data);
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
    () => compileToC(source, "orphan-select.z"),
    /orphan-select\.z:3:7: error: select requires an enclosing value-producing block/,
  );
});

test("reserves yield for generators", () => {
  const source = `
    function main(): i32 {
      yield 42;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "future-generator.z"),
    /future-generator\.z:3:7: error: yield is reserved for generators, which are not implemented yet/,
  );
});

test("requires expression match arms to agree on a value type", () => {
  const source = `
    enum Choice { first i32, second i32, }
    function main(): i32 {
      const choice = Choice.first(42);
      const value = match (choice) {
        first(number) => number;
        second(number) => "wrong";
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(source, "match-types.z"),
    /match-types\.z:7:9: error: match arm produces String, but previous arms produce i32/,
  );
});

test("requires explicit handling for throwing calls", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "explicit-errors.z"),
    /throwing call requires `attempt` or `try`/,
  );
});

test("rejects throw outside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function main(): i32 { throw Problem({ code: 1 }); }
  `;
  assert.throws(
    () => compileToC(source, "invalid-throw.z"),
    /function "main" does not declare an error type/,
  );
});

test("compiles typed Result success and failure paths", () => {
  const example = resolve(projectRoot, "examples/result.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "found=42\nerror=7\n");
});

test("requires try inside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return try fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "try-context.z"),
    /try requires an enclosing throwing function/,
  );
});

test("requires compatible propagated error types", () => {
  const source = `
    struct FirstError { code: i32; }
    struct SecondError { code: i32; }
    function first(): i32 throws FirstError { return 1; }
    function second(): i32 throws SecondError {
      const value = try first();
      return value;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(source, "try-errors.z"),
    /cannot propagate FirstError from a function throwing SecondError/,
  );
});

test("propagates typed failures through try", () => {
  const example = resolve(projectRoot, "examples/try.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "id=42\nforwarded=9\nerror=7\n");
});

test("compiles and runs structs as native values", () => {
  const example = resolve(projectRoot, "examples/structs.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "original=42 translated=45\n");
});

test("assigns mutable locals and nested value fields", () => {
  const example = resolve(projectRoot, "examples/mutation.z");
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
  const example = resolve(projectRoot, "examples/mutable-methods.z");
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
    () => compileToC(immutable, "immutable-receiver.z"),
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  const temporary = immutable.replace(
    "const counter = Counter({ value: 1 });\n      counter.add(2);",
    "Counter({ value: 1 }).add(2);",
  );
  assert.throws(
    () => compileToC(temporary, "temporary-receiver.z"),
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
    () => compileToC(transitive, "transitive-receiver.z"),
    /mutable method "add" cannot be called through immutable binding "this"/,
  );
});

test("keeps receiver capabilities in method signatures", () => {
  const topLevelReceiver = `
    function invalid(inout this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelReceiver, "top-level-receiver.z"),
    /`inout this` is only valid on a struct method/,
  );

  const topLevelMoveReceiver = `
    function invalid(move this): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(topLevelMoveReceiver, "top-level-move-receiver.z"),
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
    () => compileToC(movedReceiver, "moved-receiver.z"),
    /overlapping inout and value uses of "resource" in one call are not allowed/,
  );
});

test("moves consuming receivers and cleans them up exactly once", () => {
  const example = resolve(projectRoot, "examples/consuming-methods.z");
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
    () => compileToC(useAfterConsume, "use-after-consuming-method.z"),
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
    () => compileToC(borrowedConsume, "consume-borrowed-receiver.z"),
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
    () => compileToC(overlappingConsume, "overlapping-consuming-receiver.z"),
    /overlapping move and in uses of "resource" in one call are not allowed/,
  );
});

test("borrows native parameters immutably and mutably", () => {
  const example = resolve(projectRoot, "examples/borrowed-parameters.z");
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
    () => compileToC(missingInout, "missing-native-inout.z"),
    /"increment" requires inout <mutable binding> for parameter 1/,
  );

  const immutableInout = missingInout
    .replace("let value = 1", "const value = 1")
    .replace("increment(value)", "increment(inout value)");
  assert.throws(
    () => compileToC(immutableInout, "immutable-native-inout.z"),
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
    () => compileToC(overlapping, "overlapping-inout.z"),
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
    () => compileToC(mutateInput, "mutate-input.z"),
    /cannot assign to immutable binding "value"/,
  );

  const legacyTypePosition = `
    function inspect(value: in i32): void {}
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(legacyTypePosition, "legacy-capability-order.z"),
    /expected a type name, found "in"/,
  );
});

test("initializes native out parameters with flow-sensitive checking", () => {
  const example = resolve(projectRoot, "examples/native-out.z");
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
    () => compileToC(readBeforeInitialization, "read-uninitialized.z"),
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
    () => compileToC(maybeInitialized, "maybe-uninitialized.z"),
    /value "value" may be uninitialized on another control-flow path/,
  );

  const missingOutput = `
    function initialize(flag: bool, out value: i32): void {
      if (flag) { value = 1; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingOutput, "missing-out-initialization.z"),
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
    () => compileToC(missingModifier, "missing-out-call-modifier.z"),
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
    () => compileToC(immutableOutput, "immutable-out.z"),
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
    () => compileToC(uninitializedInout, "uninitialized-inout.z"),
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
    () => compileToC(throwingOutput, "throwing-out.z"),
    /throwing functions with out parameters are not implemented yet/,
  );

  assert.throws(
    () => compileToC("function main(): i32 { let value; return 0; }", "untyped-uninitialized.z"),
    /an uninitialized let declaration requires a type annotation/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value: i32; return 0; }", "uninitialized-const.z"),
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
    () => compileToC(source, "move-borrowed-parameter.z"),
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
    () => compileToC(immutableLocal, "const-assignment.z"),
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
    () => compileToC(immutableField, "const-field-assignment.z"),
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
    () => compileToC(immutableParameter, "parameter-assignment.z"),
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
    () => compileToC(borrowedReceiver, "receiver-assignment.z"),
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
    () => compileToC(wrongType, "assignment-type.z"),
    /expected i32, found bool/,
  );

  const example = resolve(projectRoot, "examples/replacement.z");
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
  const example = resolve(projectRoot, "examples/classes.z");
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
  assert.match(compileToC(validStruct, "trait-struct.z"), /Z_Size_measure/);

  const missing = `
    trait Named { function name(): cstring; }
    class User implements Named { id: i32; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missing, "trait-missing.z"),
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
    () => compileToC(mismatch, "trait-mismatch.z"),
    /does not match trait requirement Adjustable\.add/,
  );

  const unknown = `
    struct Value implements Missing { value: i32; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(unknown, "trait-unknown.z"), /unknown trait "Missing"/);
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
    () => compileToC(source, "class-move-this.z"),
    /class methods cannot declare `move this`/,
  );
  const withoutConsume = source.replace("      function consume(move this): i32 { return this.value; }\n", "");
  assert.match(compileToC(withoutConsume, "class-const-mutation.z"), /Z_Counter_add\(counter, 2\)/);

  const implicitMutation = withoutConsume.replace(
    "      function add(inout this, amount: i32): void {",
    "      function add(amount: i32): void {",
  );
  assert.throws(
    () => compileToC(implicitMutation, "class-implicit-mutation.z"),
    /cannot mutate a field through immutable binding "this"/,
  );

  const immutableBorrow = withoutConsume.replace(
    "    function main(): i32 {",
    "    function update(in counter: Counter): void { counter.add(1); }\n    function main(): i32 {",
  );
  assert.throws(
    () => compileToC(immutableBorrow, "class-immutable-borrow.z"),
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
  const items = completions(source, "class-editor.z", completionOffset);
  assert.equal(items.find((item) => item.label === "Counter")?.kind, 7);
  assert.equal(items.find((item) => item.label === "Counted")?.kind, 8);

  const valid = source.replace("      Cou;\n", "");
  const classOffset = valid.indexOf("Counter");
  assert.match(hover(valid, "class-editor.z", classOffset + 1)?.contents.value ?? "", /class Counter/);
  const traitUse = valid.indexOf("Counted", valid.indexOf("implements"));
  const target = definition(valid, "file:///class-editor.z", traitUse + 1);
  assert.equal(target?.range.start.line, 1);
});

test("compiles and runs the first native program", () => {
  const example = resolve(projectRoot, "examples/first.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z says 42\n");
});

function decodeSemanticTokens(data: readonly number[]): Array<{
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: number;
  readonly modifiers: number;
}> {
  const decoded = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    decoded.push({
      line,
      character,
      length: data[index + 2],
      type: data[index + 3],
      modifiers: data[index + 4],
    });
  }
  return decoded;
}

function positionForOffset(source: string, offset: number): { readonly line: number; readonly character: number } {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}

test("zeroes weak class references and breaks owned closure cycles", () => {
  const example = resolve(projectRoot, "examples/weak-references.z");
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
  assert.throws(() => compileToC(invalidTarget, "weak-value.z"), /weak requires a class reference, found i32/);

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
  const selectiveImportPatterns = grammar.repository.imports.patterns[0].patterns
    .map((pattern: { match: string }) => pattern.match)
    .join(" ");
  const matchPattern = grammar.repository.matchPatterns.patterns
    .map((pattern: { match: string }) => pattern.match)
    .join(" ");
  const matchScopes = grammar.repository.matchPatterns.patterns
    .map((pattern: { name: string }) => pattern.name)
    .join(" ");
  const exportPattern = grammar.repository.keywords.patterns
    .find((pattern: { match: string }) => pattern.match.includes("export"));
  assert.equal(exportPattern?.name, "keyword.control.export.z");
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /yield/);
  assert.match(keywordPattern, /select/);
  assert.match(keywordPattern, /move/);
  assert.match(keywordPattern, /view/);
  assert.match(keywordPattern, /weak/);
  assert.match(keywordPattern, /new/);
  assert.match(keywordPattern, /constructor/);
  assert.match(keywordPattern, /deinit/);
  assert.match(keywordPattern, /out\|inout/);
  assert.match(keywordPattern, /\bin\b/);
  assert.match(keywordPattern, /\bas\b/);
  assert.match(keywordPattern, /implements/);
  assert.match(keywordPattern, /export/);
  assert.match(keywordPattern, /declare/);
  assert.ok(editorPackage.contributes.languages[0].extensions.includes(".zd"));
  assert.equal(foreignDeclarationPatterns[0].captures[2].name, "storage.type.module.z");
  assert.equal(foreignDeclarationPatterns[1].captures[2].name, "variable.parameter.z");
  assert.equal(foreignDeclarationPatterns[2].captures[2].name, "entity.name.function.destructor.z");
  assert.equal(foreignDeclarationPatterns[3].captures[1].name, "storage.type.inferred.z");
  assert.equal(foreignDeclarationPatterns[4].captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(foreignDeclarationPatterns[4].captures[3].name, "keyword.control.declaration.callback.z");
  assert.match(selectiveImportPatterns, /\\bas\\b/);
  assert.match(keywordPattern, /while/);
  assert.match(keywordPattern, /for\|of/);
  assert.match(keywordPattern, /break/);
  assert.match(keywordPattern, /continue/);
  assert.match(grammar.repository.declarations.patterns.map((pattern: { match: string }) => pattern.match).join(" "), /trait\|class/);
  assert.match(constantPattern, /true\|false/);
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
  assert.doesNotMatch(keywordPattern, /success|failure/);

  const extension = readFileSync(resolve(projectRoot, "editors/vscode/extension.js"), "utf8");
  assert.match(extension, /6: vscode\.CompletionItemKind\.Variable/);
  assert.match(extension, /20: vscode\.CompletionItemKind\.EnumMember/);
  assert.match(extension, /8: vscode\.CompletionItemKind\.Interface/);
  assert.match(extension, /createFileSystemWatcher/);
  assert.match(extension, /restartLanguageServer/);
});

test("runs async match expressions with checked arithmetic and editor details", () => {
  const example = resolve(projectRoot, "examples/async-phase-0.z");
  const source = readFileSync(example, "utf8");
  check(source, example);

  const fetchUse = source.indexOf("fetchValue(20)");
  assert.match(
    hover(source, example, fetchUse + 1)?.contents.value ?? "",
    /async function fetchValue\(id: i32\): i32 throws NetworkError/,
  );

  const taskUse = source.indexOf("secondTask;");
  assert.match(
    hover(source, example, taskUse + 1)?.contents.value ?? "",
    /secondTask: Task<i32, NetworkError>/,
  );

  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  for (const offset of [
    source.indexOf("baseline ="),
    source.indexOf("secondTask ="),
    source.indexOf("second ="),
  ]) {
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => token.type === semanticTokenTypes.indexOf("variable")
      && token.line === position.line
      && token.character === position.character));
  }
  for (const offset of [source.indexOf("success(value)"), source.indexOf("failure(error)")]) {
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => token.type === semanticTokenTypes.indexOf("enumMember")
      && token.line === position.line
      && token.character === position.character));
  }

  const generated = compileToC(source, example);
  assert.match(generated, /Z_Result_i32_NetworkError suspend_\d+;/);
  assert.match(generated, /bool suspend_\d+;/);
  assert.match(generated, /const Z_Result_i32_NetworkError _z_async_match_/);
  assert.match(generated, /case Z_Result_i32_NetworkError_success:/);
  assert.match(generated, /z_checked_negate_i32/);
  assert.match(generated, /z_checked_add_i32/);
  assert.match(generated, /z_async_start_isExpected/);
  assert.match(generated, /frame->state = \(frame->suspend_\d+\) \? \d+ : \d+;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "warmed 1\nwarmed 2\nwarm batch complete\n");
});

test("normalizes embedded awaits left-to-right and resumes awaited branches", () => {
  const directory = mkdtempSync("/tmp/z-async-expressions-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, `
    import console from "std/console";
    function combine(left: i32, right: i32): i32 { return left + right; }
    async function value(id: i32): i32 {
      console.log(id);
      return id;
    }
    async function combineAsync(left: i32, right: i32): i32 { return left + right; }
    async function positive(value: i32): bool { return value > 0; }
    async function main(): i32 {
      const answer = combine(await value(20), await value(22));
      const nested = await combineAsync(await value(1), await value(2));
      const deep = combine(await combineAsync(await value(3), await value(4)), 0);
      if (await positive(answer + nested + deep)) {
        console.log("positive");
      } else {
        return 1;
      }
      if (await positive(-1)) {
        return 1;
      } else {
        console.log("not positive");
      }
      return answer + nested + deep - 52;
    }
  `);
  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  const firstStart = generated.indexOf("z_async_start_value(frame->task.executor, 20)");
  const secondStart = generated.indexOf("z_async_start_value(frame->task.executor, 22)");
  assert.ok(firstStart >= 0 && secondStart > firstStart);
  assert.match(generated, /combine\(frame->suspend_\d+, frame->suspend_\d+\)/);
  assert.match(generated, /z_async_start_combineAsync\(frame->task.executor, frame->suspend_\d+, frame->suspend_\d+\)/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "20\n22\n1\n2\n3\n4\npositive\nnot positive\n");
});

test("diagnoses embedded awaits whose lazy branch lowering has not landed", () => {
  const shortCircuit = `
    async function flag(): bool { return true; }
    async function main(): i32 {
      if (false && await flag()) { return 1; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(shortCircuit, "async-short-circuit.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /short-circuit logic/);
    return true;
  });

  const selectedArm = `
    enum State { ready, empty, }
    async function value(): i32 { return 42; }
    async function main(): i32 {
      const state = State.ready;
      return match (state) {
        ready => await value();
        empty => 0;
      };
    }
  `;
  assert.throws(() => compileToC(selectedArm, "async-selected-arm.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /selected-arm suspension/);
    return true;
  });
});

test("executes async failure matches with scalar and object payload bindings", () => {
  const directory = mkdtempSync("/tmp/z-async-match-");
  const scalarFile = resolve(directory, "scalar.z");
  writeFileSync(scalarFile, `
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 {
      return match (attempt await fail()) {
        success(value) => value;
        failure(value) => value - 7;
      };
    }
  `);
  const scalar = spawnSync(process.execPath, [cli, "run", scalarFile], { encoding: "utf8" });
  assert.equal(scalar.status, 0, scalar.stderr);

  const objectFile = resolve(directory, "object.z");
  writeFileSync(objectFile, `
    struct NetworkError { code: i32; }
    async function fail(): i32 throws NetworkError {
      throw NetworkError({ code: 7 });
    }
    async function main(): i32 {
      const result = attempt await fail();
      const code = match (result) {
        success(value) => value;
        failure({ code }) => code;
      };
      return code - 7;
    }
  `);
  const object = spawnSync(process.execPath, [cli, "run", objectFile], { encoding: "utf8" });
  assert.equal(object.status, 0, object.stderr);
});

test("keeps async match ownership and suspending-arm boundaries explicit", () => {
  const owned = `
    class Session { id: i32; }
    async function main(): i32 {
      const option = Option.some(new Session({ id: 42 }));
      return match (option) {
        some(session) => session.id;
        none => 0;
      };
    }
  `;
  assert.throws(() => compileToC(owned, "async-owned-match.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /ownership-bearing enum/);
    return true;
  });

  const blockArm = `
    enum State { ready i32, empty, }
    async function main(): i32 {
      const state = State.ready(42);
      return match (state) {
        ready(value) => { select value; }
        empty => 0;
      };
    }
  `;
  assert.throws(() => compileToC(blockArm, "async-block-match.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /single synchronous expressions/);
    return true;
  });
});

test("runs scalar async functions as stackless Phase 1 task frames", () => {
  const example = resolve(projectRoot, "examples/async-sequential.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /struct Z_AsyncFrame_fetchValue/);
  assert.match(generated, /static void z_async_poll_main/);
  assert.match(generated, /z_async_run\(&root->task\)/);
  assert.match(generated, /switch \(frame->state\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("runs typed scalar async errors through try and attempt await", () => {
  const example = resolve(projectRoot, "examples/async-errors.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /bool failed;/);
  assert.match(generated, /frame->error = 7;/);
  assert.match(generated, /Z_Result_i32_i32_failure/);
  assert.match(generated, /Z_AsyncFrame_finish/);
  assert.match(generated, /if \(frame->child_2->failed\)/);
  assert.match(generated, /if \(root->failed\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const directory = mkdtempSync("/tmp/z-async-error-");
  const failing = resolve(directory, "main.z");
  writeFileSync(failing, `
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 throws i32 {
      return try await fail();
    }
  `);
  const failed = spawnSync(process.execPath, [cli, "run", failing], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
});

test("carries plain struct values and errors through async task frames", () => {
  const example = resolve(projectRoot, "examples/async-aggregates.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /Z_User result;/);
  assert.match(generated, /Z_NetworkError error;/);
  assert.match(generated, /frame->error = \(Z_NetworkError\)\{ \.code = 7 \};/);
  assert.match(generated, /Z_Result_User_NetworkError_failure/);
  assert.match(generated, /frame->result = \(Z_User\)\{ \.id = frame->value_id \};/);
  assert.match(generated, /z_async_start_copyUser\(Z_AsyncExecutor \*executor, Z_User value_user\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

});

test("moves owned structs and retains ARC classes across async task frames", () => {
  const example = resolve(projectRoot, "examples/async-ownership.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /bool live_result;/);
  assert.match(generated, /bool live_resource;/);
  assert.match(generated, /frame->live_resource = false/);
  assert.match(generated, /Z_Resource_deinit\(&\(frame->value_resource\)\)/);
  assert.match(generated, /Z_Session_retain\(frame->value_session\)/);
  assert.match(generated, /Z_Session_release\(frame->value_second\)/);
  assert.match(generated, /z_async_destroy_main\(root\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released resource 40\nreleased session 42\n");

  const directory = mkdtempSync("/tmp/z-async-owned-error-");
  const failing = resolve(directory, "main.z");
  writeFileSync(failing, `
    import console from "std/console";
    class Session {
      id: i32;
      deinit { console.log(\`released failed session \${this.id}\`); }
    }
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 throws i32 {
      const session = new Session({ id: 9 });
      return try await fail();
    }
  `);
  const failed = spawnSync(process.execPath, [cli, "run", failing], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, "released failed session 9\n");
});

test("destroys active Option and Result payloads in async task frames", () => {
  const example = resolve(projectRoot, "examples/async-owned-enums.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /Z_Option_Session result;/);
  assert.match(generated, /Z_Result_Session_i32 value_outcome;/);
  assert.match(generated, /case Z_Option_Session_some:/);
  assert.match(generated, /case Z_Result_Session_i32_success:/);
  assert.match(generated, /case Z_Result_Resource_i32_success:/);
  assert.match(generated, /case Z_Result___z_Option_Session_i32_success:/);
  assert.match(generated, /Z_Resource_deinit/);
  assert.match(generated, /frame->live_optional = false/);
  assert.match(generated, /frame->child_\d+->live_result = false;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "released enum session 44\nreleased enum resource 43\nreleased enum session 42\nreleased enum session 41\n",
  );
});

test("represents fallible void success without an enum payload", () => {
  const source = `
    struct NetworkError { code: i32; }
    function warm(): void throws NetworkError { return; }
    function main(): i32 {
      const result = attempt warm();
      return match (result) {
        success => 0;
        failure(error) => error.code;
      };
    }
  `;
  const generated = compileToC(source, "fallible-void.z");
  assert.match(generated, /Z_Result_void_NetworkError_success/);
  assert.doesNotMatch(generated, /data\.success/);
  const compilation = spawnSync("clang", ["-x", "c", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], {
    input: generated,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);
});

test("allows root-scoped spawn and diagnoses unacknowledged async calls and async borrows", () => {
  const prelude = `
    async function fetch(value: i32): i32 { return value; }
  `;
  const naked = `${prelude} async function use(): i32 { return fetch(42); }`;
  assert.throws(() => check(naked, "async-naked.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0702");
    assert.match(error.message, /requires `await` or `spawn`/);
    return true;
  });

  const rootScoped = `${prelude} async function use(): i32 { const task = spawn fetch(42); return await task; }`;
  check(rootScoped, "async-root-scope.z");

  const immediatelyJoined = `${prelude} async function use(): i32 { return await spawn fetch(42); }`;
  assert.throws(() => check(immediatelyJoined, "async-await-spawn.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0701");
    assert.match(error.message, /`await spawn` is redundant/);
    return true;
  });

  const synchronousSpawn = `${prelude} function use(): i32 { const task = spawn fetch(42); return 42; }`;
  assert.throws(() => check(synchronousSpawn, "async-sync-spawn.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0703");
    assert.match(error.message, /spawn requires an enclosing async function/);
    return true;
  });

  const borrowed = `async function inspect(in value: i32): i32 { return value; }`;
  assert.throws(() => check(borrowed, "async-borrow.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /cannot borrow storage/);
    return true;
  });

  const synchronousAwait = `function value(): i32 { return 42; } async function use(): i32 { return await value(); }`;
  assert.throws(() => check(synchronousAwait, "async-sync-await.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0701");
    assert.match(error.message, /await requires an async call or Task value/);
    return true;
  });

  const synchronousScope = `function use(): i32 { async scope {} return 42; }`;
  assert.throws(() => check(synchronousScope, "async-sync-scope.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0703");
    assert.match(error.message, /async scope requires an enclosing async function/);
    return true;
  });
});

test("checks retained class receivers and consuming struct receivers in async methods", () => {
  const source = `
    class Client {
      id: i32;
      async function load(): i32 { return this.id; }
    }
    struct Request {
      id: i32;
      async function send(move this): i32 { return this.id; }
    }
    async function use(client: Client, request: Request): i32 {
      const left = await client.load();
      const right = await request.send();
      return left + right;
    }
  `;
  check(source, "async-methods.z");

  const borrowedStruct = source.replace("send(move this)", "send()");
  assert.throws(() => check(borrowedStruct, "async-borrowed-method.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /async struct method must take ownership with `move this`/);
    return true;
  });
});

test("runs retained class, consuming struct, and static async methods", () => {
  const example = resolve(projectRoot, "examples/async-methods.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /struct Z_AsyncFrame_Client_load/);
  assert.match(generated, /struct Z_AsyncFrame_Request_send/);
  assert.match(generated, /struct Z_AsyncFrame_Client_share/);
  assert.match(generated, /struct Z_AsyncFrame_Request_relay/);
  assert.match(generated, /z_async_start_Client_load\(frame->task.executor, Z_Client_retain\(frame->value_this\)\)/);
  assert.match(generated, /z_async_start_Request_send\(frame->task.executor, \(frame->live_this = false, frame->value_this\)\)/);
  assert.match(generated, /struct Z_AsyncFrame_Client_echo/);
  assert.match(generated, /struct Z_AsyncFrame_Request_echo/);
  assert.match(generated, /z_async_start_Client_load\(Z_AsyncExecutor \*executor, Z_Client \* value_this\)/);
  assert.match(generated, /Z_Client_retain\(frame->value_client\)/);
  assert.match(generated, /Z_Result_i32_i32 value_failed;/);
  assert.match(generated, /frame->live_request = false/);
  assert.doesNotMatch(generated, /static .*Z_Client_load\(/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released async request 7\nreleased async client 5\n");
});

test("schedules hot spawned functions and methods on the FIFO executor", () => {
  const example = resolve(projectRoot, "examples/async-spawn.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /struct Z_AsyncExecutor/);
  assert.match(generated, /z_async_enqueue\(frame->task.executor, &frame->child_\d+->task\)/);
  assert.match(generated, /z_async_wait\(&frame->task, &frame->child_\d+->task\)/);
  assert.match(generated, /frame->value_firstTask = &frame->child_\d+->task/);
  assert.match(generated, /Z_Result_i32_i32 value_failure;/);
  assert.match(generated, /Z_Worker_retain\(frame->value_worker\)/);
  assert.match(generated, /frame->live_job = false/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "released spawned job 22\nreleased spawned job 23\nreleased spawn worker 24\n",
  );

  const unacknowledgedFailure = `
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 {
      spawn fail();
      return 0;
    }
  `;
  assert.throws(() => compileToC(unacknowledgedFailure, "async-unjoined-error.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /throwing spawned task must be joined explicitly/);
    return true;
  });

  const directory = mkdtempSync("/tmp/z-async-spawn-error-");
  const failing = resolve(directory, "main.z");
  writeFileSync(failing, `
    import console from "std/console";
    struct Resource {
      id: i32;
      deinit { console.log(\`released sibling \${this.id}\`); }
    }
    async function finish(resource: Resource): void { return; }
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 throws i32 {
      const resource = Resource({ id: 9 });
      spawn finish(resource);
      const failureTask = spawn fail();
      return try await failureTask;
    }
  `);
  const failed = spawnSync(process.execPath, [cli, "run", failing], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, "released sibling 9\n");
});

test("joins nested async scopes at their lexical boundaries", () => {
  const example = resolve(projectRoot, "examples/async-scopes.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /z_async_wait\(&frame->task, &frame->child_\d+->task\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "released scoped job 20",
      "released scoped job 21",
      "released scoped job 10",
      "released scoped job 11",
      "released scoped job 30",
      "",
    ].join("\n"),
  );

  const acknowledged = `
    async function finish(): void throws i32 { return; }
    async function main(): i32 throws i32 {
      async scope {
        const task = spawn finish();
        try await task;
      }
      return 0;
    }
  `;
  const acknowledgedC = compileToC(acknowledged, "async-scoped-error.z");
  assert.match(acknowledgedC, /frame->value_task = NULL/);

  const localValue = `
    async function main(): i32 {
      async scope { const value = 42; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(localValue, "async-scope-local.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /scope-local value bindings are not executable yet/);
    return true;
  });
});

test("cancels live siblings and descendants when an async failure propagates", () => {
  const example = resolve(projectRoot, "examples/async-cancellation.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /bool cancellation_requested;/);
  assert.match(generated, /bool cancel_children;/);
  assert.match(generated, /z_async_cancel\(&frame->child_\d+->task\)/);
  assert.match(generated, /frame->cancel_children = true;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    result.stdout,
    "released cancellation work 2\nreleased cancellation work 1\n",
  );
  assert.doesNotMatch(result.stdout, /work 3/);

  const directory = mkdtempSync("/tmp/z-async-handled-failure-");
  const handled = resolve(directory, "main.z");
  writeFileSync(
    handled,
    source.replace(
      "return try await failure;",
      "const observed = attempt await failure; return 0;",
    ),
  );
  const handledResult = spawnSync(process.execPath, [cli, "run", handled], { encoding: "utf8" });
  assert.equal(handledResult.status, 0, handledResult.stderr);
  assert.equal(
    handledResult.stdout,
    [
      "released cancellation work 2",
      "released cancellation work 3",
      "released cancellation work 1",
      "",
    ].join("\n"),
  );
});

test("suspends async tasks on scheduler-aware std/time delay", () => {
  const example = resolve(projectRoot, "examples/async-delay.z");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /clock_gettime\(CLOCK_MONOTONIC, &now\)/);
  assert.match(generated, /Z_AsyncTask \*timers;/);
  assert.match(generated, /z_async_schedule_delay\(&frame->task, frame->value_milliseconds\)/);
  assert.match(generated, /z_async_wait_for_timer\(executor\)/);
  assert.match(generated, /z_async_remove_timer\(task\)/);
  assert.match(generated, /announceDelay\(frame->value_milliseconds\)/);
  assert.match(generated, /fputs\("finished delayed job ", stdout\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "waiting 5ms",
      "waiting 1ms",
      "finished delayed job 2",
      "finished delayed job 1",
      "released delayed job 1",
      "released delayed job 2",
      "",
    ].join("\n"),
  );

  const delayUse = source.indexOf("delay(milliseconds)") + 1;
  assert.match(
    hover(source, example, delayUse)?.contents.value ?? "",
    /async delay\(milliseconds: u64\): void/,
  );
  const completionOffset = source.indexOf("delay(milliseconds)") + 3;
  assert.match(
    completions(source, example, completionOffset).find((item) => item.label === "delay")?.detail ?? "",
    /suspends the current task/,
  );

  const naked = `import { delay } from "std/time"; function main(): i32 { delay(1); return 0; }`;
  assert.throws(() => check(naked, "naked-delay.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0702");
    assert.match(error.message, /requires `await` or `spawn`/);
    return true;
  });

  const spawned = `
    import { delay } from "std/time";
    async function main(): i32 { spawn delay(1); return 0; }
  `;
  assert.throws(() => compileToC(spawned, "spawn-delay.z"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /spawning the delay intrinsic is not executable yet/);
    return true;
  });

  const directory = mkdtempSync("/tmp/z-async-delay-cancel-");
  const cancelled = resolve(directory, "main.z");
  writeFileSync(cancelled, `
    import console from "std/console";
    import { delay } from "std/time";
    struct TimerResource {
      id: i32;
      deinit { console.log(\`released timer \${this.id}\`); }
    }
    async function linger(resource: TimerResource): void { await delay(1000); return; }
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 throws i32 {
      const failure = spawn fail();
      spawn linger(TimerResource({ id: 9 }));
      return try await failure;
    }
  `);
  const cancelledResult = spawnSync(process.execPath, [cli, "run", cancelled], { encoding: "utf8" });
  assert.equal(cancelledResult.status, 1, cancelledResult.stderr);
  assert.equal(cancelledResult.stdout, "released timer 9\n");
});

test("runs synchronous calls and typed console output inside async frames", () => {
  const source = `
    import console from "std/console";
    struct Point {
      x: i32;
      y: i32;
      function total(): i32 { return this.x + this.y; }
      static function unit(): i32 { return 1; }
    }
    enum State { ready i32, empty, }
    function sum(left: i32, right: i32): i32 { return left + right; }
    function show(in point: Point): void { console.log(\`helper \${point}\`); }
    async function main(): i32 {
      const point = Point({ x: 20, y: 22 });
      const state = State.ready(7);
      show(point);
      console.write("answer ");
      console.log(sum(20, 22), point.total(), Point.unit(), true, point, state);
      console.error("debug", false);
      return 0;
    }
  `;
  const generated = compileToC(source, "async-sync-calls.z");
  assert.match(generated, /show\(&\(frame->value_point\)\)/);
  assert.match(generated, /sum\(20, 22\)/);
  assert.match(generated, /Z_Point_total\(&\(frame->value_point\)\)/);
  assert.match(generated, /Z_Point_unit\(\)/);
  assert.match(generated, /fputs\("Point \{ ", stdout\)/);

  const directory = mkdtempSync("/tmp/z-async-sync-calls-");
  const fileName = resolve(directory, "main.z");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "helper Point { x: 20, y: 22 }\nanswer 42 42 1 true Point { x: 20, y: 22 } State.ready(7)\n",
  );
  assert.equal(result.stderr, "debug false\n");
});
