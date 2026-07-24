import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { test } from "bun:test";
import { analyzeSource, check, compileToC, compileToNative } from "../compiler/src/compiler.ts";
import { DiagnosticError, formatDiagnostic } from "../compiler/src/diagnostics.ts";
import { ApiNoteConflictError, mergeApiNotes } from "../compiler/src/foreign-api-notes.ts";
import { normalizeForeignContracts } from "../compiler/src/foreign-contracts.ts";
import type { ForeignFunctionDeclaration } from "../compiler/src/foreign-ir.ts";
import { buildStage0ModuleGraph } from "../compiler/src/native-semantic-parity.ts";
import { NativeFrontendDiagnosticError } from "../compiler/src/native-frontend-diagnostics.ts";
import {
  decodeStage1DeclarationStream,
  decodeStage1ModuleGraphStream,
  decodeStage1ProgramBatchStream,
  decodeStage1ProgramStream,
  decodeStage1TokenStream,
  encodeStage1ModuleBatch,
} from "../compiler/src/self-hosting.ts";
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
  const generated = compileToC(source, "memory.zs");
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /puts\("hello"\);/);
  assert.doesNotMatch(generated, /stdio\.puts/);
});

test("selectively imports C functions with optional local aliases", () => {
  const example = resolve(projectRoot, "examples/interop/c/selective-import.zs");
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
  const shadowedC = compileToC(shadowed, "selective-shadow.zs");
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
    () => compileToC(source, "selective-scope.zs"),
    /unknown function "printf"/,
  );

  const missing = source.replace("puts", "not_a_real_c_function").replace("printf", "not_a_real_c_function");
  assert.throws(
    () => compileToC(missing, "selective-missing.zs"),
    /header "stdio\.h" has no declaration "not_a_real_c_function"/,
  );
});

test("loads explicit Z exports through selective and namespace module imports", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "module point=Point { x: 21, y: 21 }, total=42\n");

  const analysis = analyzeSource(source, example);
  assert.equal(analysis.sourceModules.size, 3);
  assert.equal(analysis.nativeFrontendGraph, null);
  assert.equal(analysis.nativeSemanticIndex, null);
  assert.equal(analysis.nativeSemanticQueryCount, 0);
  assert.equal(analysis.nativeGenericCallEvidenceCount, 0);
  assert.equal(analysis.nativeBindingEvidenceCount, 0);
  assert.equal(analysis.nativeExpressionEvidenceCount, 0);
  assert.equal(analysis.nativeCallResolutionCount, 0);
  assert.equal(analysis.nativeMethodResolutionCount, 0);
  assert.equal(analysis.nativeConstructorResolutionCount, 0);
  assert.equal(analysis.nativeAggregateResolutionCount, 0);
  assert.equal(analysis.nativeFieldResolutionCount, 0);
  assert.equal(analysis.nativeEnumVariantResolutionCount, 0);
  assert.equal(analysis.nativeTypeResolutionCount, 0);
  assert.equal(analysis.nativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeFunctionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeMethodResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeConstructorResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeAggregateResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeFieldResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeEnumVariantResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeTypeResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeFrontendParityMilliseconds, null);
  assert.equal(analysis.sourceModuleBatch.entryFileName, example);
  assert.deepEqual(
    analysis.sourceModuleBatch.modules.map((module) => basename(module.fileName)),
    ["main.zs", "geometry.zs", "math.zs"],
  );
  assert.deepEqual(
    analysis.sourceModuleBatch.modules.map((module) => module.dependencies.size),
    [2, 1, 0],
  );
  assert.ok(analysis.program.functions.find((item) => item.name.endsWith("_add"))!.location.offset > source.length);
  const generated = compileToC(source, example);
  assert.match(generated, /__z_module_\d+_translate/);
  assert.match(generated, /__z_module_\d+_add/);
  assert.doesNotMatch(generated, /#include <\.\/geometry\.zs>/);
  assert.doesNotMatch(generated, /#include <\.\/math\.zs>/);
});

test("attaches native frontend evidence after authoritative stage-0 analysis", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
  const source = readFileSync(example, "utf8");
  let receivedModuleCount = 0;
  const analysis = analyzeSource(source, example, {
    nativeFrontendResolver: (sourceBatch) => {
      receivedModuleCount = sourceBatch.modules.length;
      return buildStage0ModuleGraph(sourceBatch);
    },
  });

  assert.equal(receivedModuleCount, 3);
  assert.equal(analysis.nativeFrontendGraph?.modules.length, 3);
  assert.equal(analysis.nativeFrontendGraph?.modules[analysis.nativeFrontendGraph.entry]?.path, example);
  const moved = analysis.nativeSemanticIndex?.resolveSymbol(example, "move");
  assert.equal(moved?.modulePath, analysis.sourceModuleBatch.modules[1].fileName);
  assert.equal(moved?.binding.importedName, "translate");
  assert.equal(moved?.declaration.functionSignature?.returnType, "Point");
  const total = analysis.nativeSemanticIndex?.resolveNamespaceMember(example, "geometry", "total");
  assert.equal(total?.declaration.functionSignature?.returnType, "i32");
  assert.ok(analysis.nativeSemanticQueryCount > (analysis.nativeFrontendGraph?.modules.length ?? 0));
  assert.equal(analysis.nativeGenericCallEvidenceCount, 0);
  assert.equal(analysis.nativeBindingEvidenceCount, 0);
  assert.equal(analysis.nativeExpressionEvidenceCount, 0);
  assert.ok(analysis.nativeCallResolutionCount > 0);
  assert.equal(analysis.nativeAuthoritativeFunctionResolutionCount, analysis.nativeCallResolutionCount);
  assert.equal(analysis.nativeAuthoritativeAggregateResolutionCount, analysis.nativeAggregateResolutionCount);
  assert.equal(analysis.nativeAuthoritativeFieldResolutionCount, analysis.nativeFieldResolutionCount);
  assert.equal(analysis.nativeAuthoritativeEnumVariantResolutionCount, analysis.nativeEnumVariantResolutionCount);
  assert.equal(analysis.nativeAuthoritativeTypeResolutionCount, analysis.nativeTypeResolutionCount);
  assert.equal(analysis.nativeAuthoritativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeExpressionResolutionCount, 0);
  assert.ok((analysis.nativeFrontendParityMilliseconds ?? -1) >= 0);

  const callableFile = resolve(projectRoot, "native-callable-shadow.zs");
  const callable = analyzeSource(`
    struct Counter {
      value: i32;

      function plus(amount: i32): i32 {
        return this.value + amount;
      }

      static function zero(): Counter {
        return Counter({ value: 0 });
      }
    }

    class Session {
      private id: i32;

      constructor(id: i32) {
        this.id = id;
      }

      function identifier(): i32 {
        return this.id;
      }
    }

    enum CounterState {
      active Counter,
      empty,
    }

    function stateValue(state: CounterState): i32 {
      return match (state) {
        active({ value }) => value;
        empty => 0;
      };
    }

    function main(): i32 {
      let counter: Counter = Counter.zero();
      counter.value = counter.value + 1;
      const session: Session = new Session(2);
      const active: CounterState = CounterState.active(Counter({ value: 1 }));
      const empty: CounterState = CounterState.empty;
      return counter.plus(39) + session.identifier();
    }
  `, callableFile, {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.equal(callable.nativeCallResolutionCount, 0);
  assert.equal(callable.nativeMethodResolutionCount, 3);
  assert.equal(callable.nativeConstructorResolutionCount, 1);
  assert.equal(callable.nativeAggregateResolutionCount, 2);
  assert.equal(callable.nativeFieldResolutionCount, 10);
  assert.equal(callable.nativeEnumVariantResolutionCount, 4);
  assert.equal(callable.nativeTypeResolutionCount, 4);
  assert.equal(callable.nativeAuthoritativeMethodResolutionCount, 3);
  assert.equal(callable.nativeAuthoritativeConstructorResolutionCount, 1);
  assert.equal(callable.nativeAuthoritativeAggregateResolutionCount, 2);
  assert.equal(callable.nativeAuthoritativeFieldResolutionCount, 10);
  assert.equal(callable.nativeAuthoritativeEnumVariantResolutionCount, 4);
  assert.equal(callable.nativeAuthoritativeTypeResolutionCount, 4);

  const generic = analyzeSource(`
    function identity<T>(value: T): T {
      return value;
    }

    class Envelope<T> {
      private value: T;

      constructor(value: T) {
        this.value = value;
      }

      function get(): T {
        return this.value;
      }
    }

    function main(): i32 {
      const envelope = new Envelope(42);
      return identity(envelope.get());
    }
  `, resolve(projectRoot, "native-generic-call-shadow.zs"), {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.equal(generic.nativeCallResolutionCount, 1);
  assert.equal(generic.nativeGenericCallEvidenceCount, 0);
  assert.equal(generic.nativeMethodResolutionCount, 1);
  assert.equal(generic.nativeConstructorResolutionCount, 1);
  assert.equal(generic.nativeAuthoritativeFunctionResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeMethodResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeConstructorResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeAggregateResolutionCount, generic.nativeAggregateResolutionCount);
  assert.equal(generic.nativeAuthoritativeFieldResolutionCount, generic.nativeFieldResolutionCount);
  assert.equal(generic.nativeAuthoritativeEnumVariantResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeTypeResolutionCount, generic.nativeTypeResolutionCount);

  const nestedTypes = analyzeSource(`
    struct Item {
      value: i32;
    }

    function main(): i32 {
      const transform: (item: Item) => Item = (item: Item): Item => item;
      const items: Item[1] = [Item({ value: 42 })];
      return transform(items[0]).value - 42;
    }
  `, resolve(projectRoot, "native-nested-type-resolution.zs"), {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.ok(nestedTypes.nativeTypeResolutionCount > 0);
  assert.equal(
    nestedTypes.nativeAuthoritativeTypeResolutionCount,
    nestedTypes.nativeTypeResolutionCount,
  );

  assert.throws(
    () => analyzeSource(source, example, {
      nativeFrontendResolver: (sourceBatch) => ({
        ...buildStage0ModuleGraph(sourceBatch),
        dependencyOrder: [],
      }),
    }),
    /native frontend module graph mismatch/,
  );

  let resolverCalled = false;
  assert.throws(
    () => analyzeSource("function main(): i32 { return missing; }", "invalid-native-shadow.zs", {
      nativeFrontendResolver: () => {
        resolverCalled = true;
        throw new Error("buffered native failure");
      },
    }),
    /unknown name "missing"/,
  );
  assert.equal(resolverCalled, true);
  const nativeDiagnosticFile = resolve(projectRoot, "native-owned-diagnostic.zs");
  assert.throws(
    () => analyzeSource("function main(): i32 { return 0; }", nativeDiagnosticFile, {
      nativeFrontendResolver: () => {
        throw new NativeFrontendDiagnosticError(
          "unknownName",
          nativeDiagnosticFile,
          1,
          1,
          "native-owned diagnostic",
        );
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.fileName, nativeDiagnosticFile);
      assert.equal(error.summary, "native-owned diagnostic");
      return true;
    },
  );
  const deferredNativeDiagnosticFile = resolve(projectRoot, "deferred-native-diagnostic.zs");
  assert.throws(
    () => analyzeSource("function main(): i32 { return missing; }", deferredNativeDiagnosticFile, {
      nativeFrontendResolver: () => {
        throw new NativeFrontendDiagnosticError(
          "parser",
          deferredNativeDiagnosticFile,
          1,
          1,
          "native parser diagnostic should defer",
        );
      },
    }),
    /unknown name "missing"/,
  );
  assert.throws(
    () => analyzeSource(source, example, {
      nativeFrontendResolver: () => {
        throw new Error("native frontend failed after stage 0 succeeded");
      },
    }),
    /native frontend failed after stage 0 succeeded/,
  );
});

test("diagnoses missing Z exports, missing files, cycles, and module binding collisions", () => {
  const directory = mkdtempSync("/tmp/z-modules-");
  const main = resolve(directory, "main.zs");
  const values = resolve(directory, "values.zs");
  writeFileSync(values, "function hidden(): i32 { return 42; }\n");

  const missingExport = `import { hidden } from "./values.zs"; function main(): i32 { return hidden(); }`;
  assert.throws(() => compileToC(missingExport, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /has no export "hidden"/);
    return true;
  });

  const missingFile = `import missing from "./missing.zs"; function main(): i32 { return 0; }`;
  assert.throws(() => compileToC(missingFile, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /could not find Z module/);
    return true;
  });

  const left = resolve(directory, "left.zs");
  const right = resolve(directory, "right.zs");
  writeFileSync(left, `import right from "./right.zs"; export function left(): i32 { return right.right(); }`);
  writeFileSync(right, `import left from "./left.zs"; export function right(): i32 { return left.left(); }`);
  const cycleMain = `import left from "./left.zs"; function main(): i32 { return left.left(); }`;
  assert.throws(() => compileToC(cycleMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0601");
    assert.match(error.message, /left\.zs -> right\.zs -> left\.zs/);
    return true;
  });

  writeFileSync(values, "export function answer(): i32 { return 42; }\n");
  const collision = `
    import { answer } from "./values.zs";
    function answer(): i32 { return 0; }
    function main(): i32 { return answer(); }
  `;
  assert.throws(() => compileToC(collision, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0603");
    assert.match(error.message, /duplicate module binding "answer"/);
    return true;
  });

  const broken = resolve(directory, "broken.zs");
  writeFileSync(broken, `export function broken(): i32 { return missing; }`);
  const brokenMain = `import { broken } from "./broken.zs"; function main(): i32 { return broken(); }`;
  assert.throws(() => compileToC(brokenMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.match(error.fileName, /broken\.zs$/);
    assert.match(error.message, /broken\.zs:1:40: error: unknown name "missing"/);
    return true;
  });
  const editorDiagnostic = diagnostics(brokenMain, main)[0];
  assert.match(editorDiagnostic.message, /broken\.zs: unknown name "missing"/);
  assert.match(editorDiagnostic.relatedInformation?.[0].location.uri ?? "", /broken\.zs$/);
});

test("preserves generic inference and local shadowing across Z modules", () => {
  const directory = mkdtempSync("/tmp/z-generic-modules-");
  const library = resolve(directory, "library.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(library, `
    export struct Pair<T> {
      first: T;
      second: T;
      function choose<U>(left: U, right: U): U {
        if (this.first > 0 && left == right) return left;
        return right;
      }
    }
    export struct Utility {
      static function preserve<T>(value: T): T { return value; }
    }
    class HiddenCounter { value: i32; }
    struct HiddenResource { value: i32; deinit {} }
    function helper(): i32 { return 0; }
    export function first<T>(in pair: Pair<T>): T { return pair.first; }
    export function shadowed(): i32 { const helper = 42; return helper; }
  `);
  const source = `
    import library from "./library.zs";
    import { first, Utility as Tools } from "./library.zs";
    function main(): i32 {
      const pair = library.Pair({ first: 20, second: 22 });
      const chosen = pair.choose(1, 2);
      const preserved = Tools.preserve<i32>(1);
      return library.first<i32>(pair) + first(pair) + library.shadowed() + chosen + preserved - 85;
    }
  `;
  const generated = compileToC(source, main);
  assert.match(generated, /__z_mono___z_module_\d+_Pair_i32/);
  assert.match(generated, /__z_mono_choose_i32/);
  assert.match(generated, /__z_mono_preserve_i32/);
  const sourcePath = resolve(directory, "main.zs");
  writeFileSync(sourcePath, source);
  const result = spawnSync(process.execPath, [cli, "run", sourcePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("provides completion, hover, definitions, and semantic tokens across Z modules", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
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
  assert.match(moveHover, /Alias of `translate` from `"\.\/geometry\.zs"`\./);
  const moveDeclaration = source.indexOf("move", source.indexOf("translate as")) + 1;
  assert.match(hover(source, example, moveDeclaration)?.contents.value ?? "", /Alias of `translate`/);

  const totalUse = source.indexOf("total(moved") + 1;
  const totalDefinition = definition(source, uri, totalUse);
  assert.match(totalDefinition?.uri ?? "", /geometry\.zs$/);
  assert.equal(totalDefinition?.range.start.line, 11);
  const moveDefinition = definition(source, uri, moveUse);
  assert.match(moveDefinition?.uri ?? "", /geometry\.zs$/);
  assert.equal(moveDefinition?.range.start.line, 7);

  const symbolSource = source.replace("return 0;", "mov; return 0;");
  const symbolOffset = symbolSource.indexOf("mov;") + 3;
  const moveCompletion = completions(symbolSource, example, symbolOffset).find((item) => item.label === "move");
  assert.equal(moveCompletion?.kind, 3);
  assert.match(moveCompletion?.detail ?? "", /function move\(point: Point, dx: i32, dy: i32\): Point/);
  assert.match(moveCompletion?.detail ?? "", /alias of translate from "\.\/geometry\.zs"/);

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
  const functionItems = completions("fun", "tokens.zs", 3);
  assert.equal(functionItems.find((item) => item.label === "function")?.kind, 14);
  assert.equal(functionItems.find((item) => item.label === "function")?.detail, "Z keyword");

  const returnItems = completions("function main(): i32 { ret", "tokens.zs", 26);
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
  const threadItems = completions("thr", "vendor.h.zd", 3);
  assert.equal(threadItems.find((item) => item.label === "thread")?.kind, 14);
  const callerItems = completions("call", "vendor.h.zd", 4);
  assert.equal(callerItems.find((item) => item.label === "caller")?.detail, "Z declaration keyword");
});

test("suggests selective imports and typed object fields", () => {
  const moduleFile = resolve(projectRoot, "examples/language/modules/main.zs");
  const localImport = `import { tr } from "./geometry.zs"; function main(): i32 { return 0; }`;
  const localImportOffset = localImport.indexOf("tr }") + 2;
  const translate = completions(localImport, moduleFile, localImportOffset)
    .find((item) => item.label === "translate");
  assert.equal(translate?.kind, 3);
  assert.match(translate?.detail ?? "", /translate\(point: Point, dx: i32, dy: i32\): Point/);

  const standardImport = `import { d } from "std/time"; function main(): i32 { return 0; }`;
  const standardImportOffset = standardImport.indexOf("d }") + 1;
  assert.match(
    completions(standardImport, moduleFile, standardImportOffset).find((item) => item.label === "delay")?.detail ?? "",
    /async delay\(milliseconds: u64\): void/,
  );

  const nativeFile = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-array.zs");
  const nativeImport = `import { zc } from "../../../tests/fixtures/move-only.hpp"; function main(): i32 { return 0; }`;
  const nativeImportOffset = nativeImport.indexOf("zc }") + 2;
  assert.equal(
    completions(nativeImport, nativeFile, nativeImportOffset).find((item) => item.label === "zcpp")?.kind,
    9,
  );

  const importedObject = `
    import geometry from "./geometry.zs";
    function main(): i32 {
      const point = geometry.Point({ x: 20, y });
      return point.x;
    }
  `;
  const importedFieldOffset = importedObject.indexOf("y }") + 1;
  const importedField = completions(importedObject, moduleFile, importedFieldOffset)
    .find((item) => item.label === "y");
  assert.equal(importedField?.detail, "y: i32");
  assert.equal(importedField?.insertText, "y: ");

  const objectPatterns = `
    struct User {
      id: i32;
      name: String;
    }
    enum SessionState {
      ready User,
      empty,
    }
    function inspect(in state: SessionState): i32 {
      const created = SessionState.ready({ id: 1, na });
      return match (in state) {
        ready({ id, na }) => id;
        empty => 0;
      };
    }
  `;
  const constructorOffset = objectPatterns.indexOf("na });") + 2;
  const constructorField = completions(objectPatterns, "object-patterns.zs", constructorOffset)
    .find((item) => item.label === "name");
  assert.equal(constructorField?.detail, "name: String");
  assert.equal(constructorField?.insertText, "name: ");
  const patternOffset = objectPatterns.lastIndexOf("na })") + 2;
  const patternItems = completions(objectPatterns, "object-patterns.zs", patternOffset);
  assert.equal(patternItems.some((item) => item.label === "id"), false);
  const patternField = patternItems.find((item) => item.label === "name");
  assert.equal(patternField?.detail, "name: String");
  assert.equal(patternField?.insertText, "name");
});

test("analyzes export-only files as modules while executable commands still require main", () => {
  const moduleFile = resolve(projectRoot, "examples/language/modules/geometry.zs");
  const source = readFileSync(moduleFile, "utf8");
  assert.doesNotThrow(() => check(source, moduleFile));
  assert.deepEqual(diagnostics(source, moduleFile), []);

  const pointOffset = source.indexOf("Point") + 1;
  assert.match(hover(source, moduleFile, pointOffset)?.contents.value ?? "", /struct Point/);
  assert.ok(semanticTokens(source, moduleFile).data.length > 0);

  const checkResult = spawnSync(process.execPath, [cli, "check", moduleFile], { encoding: "utf8" });
  assert.equal(checkResult.status, 0, checkResult.stderr);
  assert.match(checkResult.stdout, /geometry\.zs: ok/);

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
  writeFileSync(resolve(libraryDirectory, "native.zs"), `
    import native from "native.h";
    export function answer(): i32 { return native.z_module_answer(); }
  `);
  const main = resolve(directory, "main.zs");
  const source = `
    import { answer } from "./library/native.zs";
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
  const example = resolve(projectRoot, "examples/interop/c/selective-declarations.zs");
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

test("imports typed object-like integer macros without textual substitution", () => {
  const example = resolve(projectRoot, "tests/fixtures/macro-constants.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /z_checked_subtract_i32\(z_checked_add_i32\(Z_MACRO_ANSWER, Z_MACRO_NEGATIVE\), 35\)/);

  const module = analyzeSource(source, example).foreignModules.get("macros");
  assert.equal(module?.constants.get("Z_MACRO_ANSWER")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_NEGATIVE")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_UNSIGNED")?.typeName, "u32");
  assert.equal(module?.constants.get("Z_MACRO_WIDE")?.typeName, "u64");
  assert.equal(module?.constants.get("Z_MACRO_MASK")?.typeName, "u32");
  assert.equal(module?.constants.get("Z_MACRO_LARGE_DECIMAL")?.typeName, "i64");
  assert.equal(module?.constants.get("Z_MACRO_ANSWER")?.sourceKind, "macro");
  assert.equal(module?.constants.has("Z_MACRO_ALIAS"), false);
  assert.equal(module?.constants.has("Z_MACRO_EXPRESSION"), false);
  assert.equal(module?.constants.has("Z_MACRO_TEXT"), false);
  assert.equal(module?.constants.has("Z_MACRO_FUNCTION"), false);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const answerOffset = source.indexOf("Z_MACRO_ANSWER") + 2;
  assert.match(
    hover(source, example, answerOffset)?.contents.value ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );
  const answerDefinition = definition(source, `file://${example}`, answerOffset);
  assert.match(answerDefinition?.uri ?? "", /tests\/fixtures\/macro-constants\.h$/);
  assert.equal(answerDefinition?.range.start.line, 3);

  const completionSource = source.replace("macros.Z_MACRO_ANSWER", "macros.Z_MACRO_A");
  const completionOffset = completionSource.indexOf("macros.Z_MACRO_A") + "macros.Z_MACRO_A".length;
  assert.match(
    completions(completionSource, example, completionOffset)
      .find((item) => item.label === "Z_MACRO_ANSWER")?.detail ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );
  const importCompletionSource = `
    import { Z_MACRO_A } from "tests/fixtures/macro-constants.h";
    function main(): i32 { return 0; }
  `;
  const importCompletionOffset = importCompletionSource.indexOf("Z_MACRO_A") + "Z_MACRO_A".length;
  assert.match(
    completions(importCompletionSource, resolve(projectRoot, "macro-import-completion.zs"), importCompletionOffset)
      .find((item) => item.label === "Z_MACRO_ANSWER")?.detail ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );

  const selective = `
    import { Z_MACRO_ANSWER as answer } from "tests/fixtures/macro-constants.h";
    function main(): i32 { return answer - 42; }
  `;
  assert.match(
    compileToC(selective, resolve(projectRoot, "selective-macro.zs")),
    /return z_checked_subtract_i32\(Z_MACRO_ANSWER, 42\);/,
  );
});

test("keeps unselected C types and constants out of scope", () => {
  const missingType = `
    import { z_score } from "tests/fixtures/geometry.h";
    function inspect(point: ZPoint): i32 { return z_score(point); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingType, resolve(projectRoot, "selective-type-scope.zs")),
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
    () => compileToC(missingConstant, resolve(projectRoot, "selective-constant-scope.zs")),
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
  const generated = compileToC(source, resolve(projectRoot, "selective-record.zs"));
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
  const generated = compileToC(source, "typed-header.zs");
  assert.match(generated, /const int32_t written = puts\("typed"\);/);
  assert.equal(analyzeSource(source, "typed-header.zs").foreignModules.get("stdio")?.producer, "clang");
});

test("passes typed Z functions to call-only C callbacks with optional context adapters", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-main.zs");
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
  const escapingCallbackRelation = declarationSource.lastIndexOf("callback callback") + "callback ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, escapingCallbackRelation)?.contents.value ?? "",
    /move callback:.*escaping retained callback using native context context/,
  );
  const releaseRelation = declarationSource.lastIndexOf("deinit release") + "deinit ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, releaseRelation)?.contents.value ?? "",
    /release: void \(\s*\*\)\(void \*\).*exactly-once native release/,
  );
  const callerRelation = declarationSource.lastIndexOf("caller") + 2;
  assert.match(
    hover(declarationSource, declarationFile, callerRelation)?.contents.value ?? "",
    /only on the registering thread/,
  );
  const releaseCompletionSource = declarationSource.replace("deinit release;", "deinit rel;");
  const releaseCompletionOffset = releaseCompletionSource.indexOf("deinit rel") + "deinit rel".length;
  assert.equal(
    completions(releaseCompletionSource, declarationFile, releaseCompletionOffset)
      .find((item) => item.label === "release")?.kind,
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
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-inline.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /z_apply_i32\(6, 7, __z_closure_call_[0-9]+\)/);
  assert.match(generated, /z_apply_context_i32\(40, \(void \*\)&\(_z_argument_[0-9]+\), __z_c_callback_/);
  assert.match(generated, /z_register_context_callback\(__z_c_callback_[^,]+, Z_Function_[0-9a-f]+_c_escape_box\(_z_argument_[0-9]+\)/);
  assert.doesNotMatch(generated, /__atomic_(?:add|sub)_fetch\(&environment->refcount/);

  const parameter = source.indexOf("(left, right)") + 2;
  assert.match(hover(source, fixture, parameter)?.contents.value ?? "", /left: i32/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "inline-escape-drop=2\n");
});

test("rejects invalid C callback and context declaration pairs", () => {
  const directory = mkdtempSync("/tmp/z-callback-context-notes-");
  const header = resolve(directory, "invalid-context.h");
  const sourceFile = resolve(directory, "main.zs");
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
  writeFileSync(`${header}.zd`, `
    declare module "invalid-context.h" {
      export function invalid_context(value: _, not_context: _, in callback: _): _ {
        callback callback {
          context not_context;
        }
      }
    }
  `);
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
  const sourceFile = resolve(directory, "main.zs");
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
  writeFileSync(`${header}.zd`, `
    declare module "escaping.h" {
      export function retain_callback(move callback: _, context: _, release: _): _ {
        callback callback {
          context context;
        }
      }
    }
  `);
  const source = `
    import escaping from "escaping.h";
    function identity(value: i32): i32 { return value; }
    function main(): i32 { escaping.retain_callback(identity); return 0; }
  `;
  writeFileSync(sourceFile, source);
  const diagnostic = diagnostics(source, sourceFile).find((item) => item.code === "Z0214");
  assert.match(diagnostic?.message ?? "", /requires deinit and thread contracts/);
});

test("owns arbitrary-thread native callback environments atomically and checks captures", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-any-thread.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /__atomic_add_fetch\(&environment->refcount, 1, __ATOMIC_RELAXED\)/);
  assert.match(generated, /__atomic_sub_fetch\(&environment->refcount, 1, __ATOMIC_ACQ_REL\)/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/callbacks-any-thread.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const threadHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("any;") + 1,
  );
  assert.match(threadHover?.contents.value ?? "", /arbitrary threads/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const mutableCapture = `
    import callbacks from "callbacks-any-thread.h";
    function main(): i32 {
      let offset = 2;
      callbacks.z_start_any_thread_callback(
        40,
        move (value) => { offset = value; return offset; }
      );
      return callbacks.z_join_any_thread_callback();
    }
  `;
  const mutable = diagnostics(mutableCapture, fixture).find((item) => item.code === "Z0704");
  assert.match(mutable?.message ?? "", /mutable capture "offset" cannot enter an arbitrary-thread native callback/);

  const borrowedCapture = `
    import callbacks from "callbacks-any-thread.h";
    class CalculationInput { readonly offset: i32; }
    function install(in input: CalculationInput): void {
      callbacks.z_start_any_thread_callback(40, move (value) => value + input.offset);
    }
    function main(): i32 { return 0; }
  `;
  const borrowed = diagnostics(borrowedCapture, fixture).find((item) => item.code === "Z0704");
  assert.match(borrowed?.message ?? "", /borrowed capture "input" cannot enter an arbitrary-thread native callback/);

  const namedFunction = `
    import callbacks from "callbacks-any-thread.h";
    function increment(value: i32): i32 { return value + 1; }
    function main(): i32 {
      callbacks.z_start_any_thread_callback(41, increment);
      return callbacks.z_join_any_thread_callback() - 42;
    }
  `;
  assert.doesNotThrow(() => compileToC(namedFunction, fixture));

  const storedEnvironment = `
    import callbacks from "callbacks-any-thread.h";
    function main(): i32 {
      const offset = 2;
      const operation: (value: i32) => i32 = move (value) => value + offset;
      callbacks.z_start_any_thread_callback(40, operation);
      return callbacks.z_join_any_thread_callback() - 42;
    }
  `;
  const stored = diagnostics(storedEnvironment, fixture).find((item) => item.code === "Z0704");
  assert.match(stored?.message ?? "", /requires an inline closure or named function/);
});

test("rejects unknown functions from imported headers", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.not_a_real_function("nope");
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-name.zs"),
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
    () => compileToC(wrongType, "foreign-type.zs"),
    /expected cstring, found i32/,
  );

  const missingFormat = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.printf();
    }
  `;
  assert.throws(
    () => compileToC(missingFormat, "foreign-variadic.zs"),
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
    () => compileToC(source, "foreign-pointer.zs"),
    /C function "freopen" uses unsupported type "FILE \*"/,
  );
});

test("narrows, borrows, consumes, and cleans up owned C handles", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-handle.zs");
  const exampleSource = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrote handle\n");
  assert.equal(readFileSync("/tmp/z-lang-foreign-handle.txt", "utf8"), "owned by Z\n");

  const declarationOffset = exampleSource.indexOf("file =") + 1;
  const guardOffset = exampleSource.indexOf("file == null") + 1;
  const narrowedOffset = exampleSource.indexOf("file);", exampleSource.indexOf("fputs")) + 1;
  assert.match(hover(exampleSource, example, declarationOffset)?.contents.value ?? "", /file: stdio\.FILE \| null/);
  assert.match(hover(exampleSource, example, guardOffset)?.contents.value ?? "", /file: stdio\.FILE \| null/);
  assert.match(hover(exampleSource, example, narrowedOffset)?.contents.value ?? "", /file: stdio\.FILE(?! \| null)/);

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
    () => compileToC(source, "foreign-consume.zs"),
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
  const generated = compileToC(source, resolve(projectRoot, "foreign-local-notes.zs"));
  assert.match(generated, /ZTestHandle \* const handle = z_test_open\(\);/);
  assert.match(generated, /if \(_z_live_handle_0 && handle != NULL\) z_test_close\(handle\);/);

  const outputSource = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      let handle;
      const status = handles.z_test_create(out handle);
      if (status != 0) return 1;
      if (handle == null) return 1;
      return handles.z_test_created_use(handle);
    }
  `;
  const outputGenerated = compileToC(outputSource, resolve(projectRoot, "foreign-output-handle.zs"));
  assert.match(outputGenerated, /ZCreatedHandle \*handle = NULL;/);
  assert.match(outputGenerated, /z_test_create\(&\(handle\)\)/);
  assert.match(outputGenerated, /if \(_z_live_handle_\d+ && handle != NULL\) z_test_created_close\(handle\);/);
  const outputBindingOffset = outputSource.indexOf("handle;") + 2;
  assert.match(hover(outputSource, resolve(projectRoot, "foreign-output-handle.zs"), outputBindingOffset)?.contents.value ?? "", /handle: handles\.ZCreatedHandle \| null/);
  assert.match(
    diagnostics("function main(): i32 { let unresolved; return 0; }", "unresolved-out.zs")[0]?.message ?? "",
    /cannot infer type of uninitialized let "unresolved"/,
  );

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
  const closeDeclarationOffset = declarationSource.indexOf("z_test_close(move handle");
  const handleParameterOffset = declarationSource.indexOf("handle: _", closeDeclarationOffset) + 2;
  assert.match(hover(declarationSource, declarationFile, handleParameterOffset)?.contents.value ?? "", /move handle: ZTestHandle \*/);
  const handleTypeOffset = declarationSource.indexOf("handle: _", closeDeclarationOffset) + "handle: ".length;
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
  const threadOffset = declarationSource.indexOf("thread") + 2;
  assert.match(
    hover(declarationSource, declarationFile, threadOffset)?.contents.value ?? "",
    /native thread contract for the z_test_open result/,
  );
  const transferOffset = declarationSource.indexOf("transfer") + 2;
  assert.match(
    hover(declarationSource, declarationFile, transferOffset)?.contents.value ?? "",
    /ownership may move to another thread/,
  );
  const transferCompletionSource = declarationSource.replace("transfer;", "trans");
  const transferCompletionOffset = transferCompletionSource.indexOf("trans") + "trans".length;
  assert.equal(
    completions(transferCompletionSource, declarationFile, transferCompletionOffset)
      .find((item) => item.label === "transfer")?.insertText,
    "transfer;",
  );

  const example = resolve(projectRoot, "examples/interop/c/declared-handle.zs");
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
  assert.match(hover(exampleSource, example, optionBinding)?.contents.value ?? "", /handle: Option<native\.ZDeclaredHandle>/);
  const payloadBinding = exampleSource.indexOf("value)", exampleSource.indexOf("some(")) + 2;
  assert.match(hover(exampleSource, example, payloadBinding)?.contents.value ?? "", /value: native\.ZDeclaredHandle/);

  const narrowedSource = exampleSource.replace(
    "const handle = Option.fromNullable(native.z_declared_open(value));",
    `const raw = native.z_declared_open(value);
  if (raw == null) return -1;
  const handle = Option.fromNullable(raw);`,
  );
  assert.throws(
    () => compileToC(narrowedSource, example),
    /Option\.fromNullable requires native\.ZDeclaredHandle \| null, found owned native\.ZDeclaredHandle/,
  );

  const storedOwnerSource = `
    import handles from "tests/fixtures/foreign-handles.h";
    class HandleOwner {
      private handle: handles.ZTestHandle;

      constructor() throws i32 {
        const handle = handles.z_test_open();
        if (handle == null) throw 1;
        this.handle = move handle;
      }

      function read(): i32 {
        return handles.z_test_use(this.handle);
      }
    }

    function inspectMaybe(handle: handles.ZTestHandle | null): i32 {
      if (handle == null) return 0;
      return handles.z_test_use(handle);
    }

    function lift(handle: handles.ZTestHandle | null): Option<handles.ZTestHandle> {
      return Option.fromNullable(handle);
    }

    function main(): i32 {
      const opened = attempt new HandleOwner();
      return match (opened) {
        success(owner) => owner.read();
        failure(status) => status;
      };
    }
  `;
  const storedOwnerFile = resolve(projectRoot, "foreign-stored-handle.zs");
  const storedOwnerGenerated = compileToC(storedOwnerSource, storedOwnerFile);
  assert.match(storedOwnerGenerated, /ZTestHandle \* handle;/);
  assert.match(storedOwnerGenerated, /z_test_close\(self->handle\);/);
  const storedTypeOffset = storedOwnerSource.indexOf("handles.ZTestHandle") + "handles.".length + 2;
  assert.match(
    hover(storedOwnerSource, storedOwnerFile, storedTypeOffset)?.contents.value ?? "",
    /handles\.ZTestHandle/,
  );
  const partialStoredOwner = storedOwnerSource.replace("handles.ZTestHandle", "handles.ZTestH");
  const partialStoredOwnerOffset = partialStoredOwner.indexOf("handles.ZTestH") + "handles.ZTestH".length;
  const handleCompletion = completions(
    partialStoredOwner,
    storedOwnerFile,
    partialStoredOwnerOffset,
  ).find((item) => item.label === "ZTestHandle");
  assert.match(handleCompletion?.detail ?? "", /owned opaque native handle ZTestHandle \*; deinit z_test_close/);
});

test("projects native integer statuses into typed throws and preserves out cleanup", () => {
  const example = resolve(projectRoot, "tests/fixtures/status-api.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);

  assert.match(generated, /const int32_t _z_native_status_\d+ = z_status_open\(7, &\(handle\)\);/);
  assert.match(generated, /_z_live_handle_\d+ = true;/);
  assert.match(generated, /_z_native_status_\d+ == 0/);
  assert.match(generated, /_z_native_status_\d+ == 0 \|\| _z_native_status_\d+ == 2/);
  assert.match(generated, /Z_Result_void_i32_failure/);
  assert.match(generated, /z_status_close\(handle\);/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const declarationFile = resolve(projectRoot, "tests/fixtures/status-api.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);

  const functionOffset = declarationSource.indexOf("z_status_open") + 2;
  assert.match(
    hover(declarationSource, declarationFile, functionOffset)?.contents.value ?? "",
    /z_status_open\(status: i32, out handle: ZStatusHandle \* \| null\): void throws i32/,
  );
  const voidOffset = declarationSource.indexOf("void throws");
  assert.match(
    hover(declarationSource, declarationFile, voidOffset)?.contents.value ?? "",
    /void throws i32.*native integer status/,
  );
  const throwsOffset = declarationSource.indexOf("throws") + 2;
  assert.match(
    hover(declarationSource, declarationFile, throwsOffset)?.contents.value ?? "",
    /throws i32.*inferred from the native integer status/,
  );
  const successOffset = declarationSource.indexOf("success") + 2;
  assert.match(
    hover(declarationSource, declarationFile, successOffset)?.contents.value ?? "",
    /success 0.*successful void completion/,
  );
  const completionSource = declarationSource.replace("success 0;", "suc");
  const completionOffset = completionSource.indexOf("suc") + 3;
  assert.equal(
    completions(completionSource, declarationFile, completionOffset)
      .find((item) => item.label === "success")?.insertText,
    "success ",
  );
  const resultBindingOffset = source.indexOf("plainSuccess =") + 2;
  assert.match(
    hover(source, example, resultBindingOffset)?.contents.value ?? "",
    /plainSuccess: Result<void, i32>/,
  );

  assert.throws(
    () => compileToC(
      `import native from "tests/fixtures/status-api.h";
       function main(): i32 {
         native.z_status_plain(0);
         return 0;
       }`,
      resolve(projectRoot, "unhandled-native-status.zs"),
    ),
    /throwing native call requires `attempt` or `try`/,
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
  assert.match(executableDiagnostic.message, /expected "async", "deinit", "thread", "callback", or "success" in foreign function contract/);

  const threadWithoutOwner = `
    declare module "contract.h" {
      export function known(): _ {
        thread { transfer; deinit; }
      }
    }
  `;
  const ownerDiagnostic = diagnostics(threadWithoutOwner, "/tmp/contract.h.zd")[0];
  assert.equal(ownerDiagnostic.code, "Z0801");
  assert.match(ownerDiagnostic.message, /requires an owned return with deinit/);

  const conflictingThreadContract = `
    declare module "contract.hpp" {
      export type Value {
        move;
        deinit;
        thread { transfer; share; deinit; }
      }
    }
  `;
  const conflictingDiagnostic = diagnostics(conflictingThreadContract, "/tmp/contract.hpp.zd")[0];
  assert.equal(conflictingDiagnostic.code, "Z0801");
  assert.match(conflictingDiagnostic.message, /cannot declare both transfer and share/);

  const mismatchDirectory = mkdtempSync("/tmp/z-zd-module-");
  const mismatchHeader = resolve(mismatchDirectory, "contract.h");
  const mismatchSource = resolve(mismatchDirectory, "main.zs");
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
  const parameterSource = resolve(parameterDirectory, "main.zs");
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
  const callbackSource = resolve(callbackDirectory, "main.zs");
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

  writeFileSync(`${callbackHeader}.zd`, `
    declare module "contract.h" {
      export function apply(value: _, context: _, move operation: _): _ {
        callback operation {
          context context;
        }
      }
    }
  `);
  const incompleteEscape = diagnostics(callbackImport, callbackSource)[0];
  assert.equal(incompleteEscape.code, "Z0214");
  assert.match(incompleteEscape.message, /requires deinit and thread contracts/);
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
  const example = resolve(projectRoot, "examples/interop/c/foreign-types.zs");
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
  const fileName = resolve(projectRoot, "examples/interop/c/availability-metadata-test.zs");
  const source = `
    import native from "../../../tests/fixtures/z-availability.h";
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

test("checks native availability against an explicit deployment target", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-deployment-target-");
  const header = resolve(directory, "z-availability.h");
  const sourceFile = resolve(directory, "main.zs");
  const manifest = resolve(directory, "z.json");
  writeFileSync(header, readFileSync(resolve(projectRoot, "tests/fixtures/z-availability.h"), "utf8"));
  const sourceFor = (name: string) => `
    import native from "z-availability.h";
    function main(): i32 { return native.${name}(1); }
  `;
  const configure = (minimumVersion: string) => writeFileSync(manifest, JSON.stringify({
    target: { platform: "macos", minimumVersion },
  }));

  configure("12.0");
  writeFileSync(sourceFile, sourceFor("z_future"));
  const introduced = diagnostics(readFileSync(sourceFile, "utf8"), sourceFile)[0];
  assert.equal(introduced.code, "Z0802");
  assert.equal(introduced.severity, 1);
  assert.match(introduced.message, /requires macOS 15\.0, but the deployment target is macOS 12\.0/);
  assert.match(introduced.message, /raise target\.minimumVersion to "15\.0"/);
  assert.match(introduced.relatedInformation?.[0]?.location.uri ?? "", /z-availability\.h$/);

  configure("13.0");
  const deprecatedSource = sourceFor("z_legacy");
  writeFileSync(sourceFile, deprecatedSource);
  const deprecation = diagnostics(deprecatedSource, sourceFile)[0];
  assert.equal(deprecation.code, "Z0804");
  assert.equal(deprecation.severity, 2);
  assert.match(deprecation.message, /deprecated in macOS 13\.0/);
  assert.match(deprecation.message, /use z_current/);
  const artifact = compileToNative(deprecatedSource, sourceFile);
  assert.deepEqual(artifact.deploymentTarget, { platform: "macos", minimumVersion: "13.0" });
  assert.equal(artifact.warnings[0]?.code, "Z0804");

  const obsoleteSource = sourceFor("z_obsolete");
  writeFileSync(sourceFile, obsoleteSource);
  const obsolete = diagnostics(obsoleteSource, sourceFile)[0];
  assert.equal(obsolete.code, "Z0802");
  assert.match(obsolete.message, /was obsoleted in macOS 13\.0; the deployment target is 13\.0/);

  configure("15.0");
  const currentSource = sourceFor("z_current");
  writeFileSync(sourceFile, currentSource);
  assert.deepEqual(diagnostics(currentSource, sourceFile), []);

  writeFileSync(manifest, JSON.stringify({ target: { minimumVersion: "13.0" } }));
  assert.match(diagnostics(currentSource, sourceFile)[0]?.message ?? "", /target\.platform must be a platform name/);
  writeFileSync(manifest, JSON.stringify({ target: { platform: "macos", minimumVersion: "latest" } }));
  assert.match(diagnostics(currentSource, sourceFile)[0]?.message ?? "", /target\.minimumVersion must be a numeric version/);
});

test("threads deployment targets and warnings through CLI native execution", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/c/deployment-target/main.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning\[Z0804\]: foreign declaration "z_legacy" is deprecated in macOS 13\.0/);
  assert.match(result.stderr, /native-api\.h:8:19/);
});

test("adds explicit target native libraries without exposing raw linker flags", () => {
  const directory = mkdtempSync("/tmp/z-native-link-");
  const sourceFile = resolve(directory, "main.zs");
  const manifest = resolve(directory, "z.json");
  const source = "function main(): i32 { return 0; }";
  writeFileSync(sourceFile, source);
  writeFileSync(manifest, JSON.stringify({
    target: {
      entry: "main.zs",
      link: { libraries: ["sqlite3", "sqlite3"] },
    },
  }));

  const artifact = compileToNative(source, sourceFile);
  assert.deepEqual(artifact.nativeLinkerArguments, ["-lsqlite3"]);

  writeFileSync(manifest, JSON.stringify({
    target: { entry: "main.zs", link: { libraries: ["-Wl,unsafe"] } },
  }));
  assert.match(
    diagnostics(source, sourceFile)[0]?.message ?? "",
    /target\.link\.libraries must contain native library names/,
  );
});

test("rejects malformed or unmatched Z declarations before FIIR reaches sema", () => {
  const directory = mkdtempSync("/tmp/z-fiir-notes-");
  const header = resolve(directory, "contract.h");
  const sourceFile = resolve(directory, "main.zs");
  const source = `
    import contract from "contract.h";
    function main(): i32 { return contract.known(); }
  `;
  writeFileSync(header, "int known(void);\n");
  writeFileSync(sourceFile, source);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function known(): _;
    }
  `);
  assert.match(compileToC(source, sourceFile), /return known\(\);/);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function missing(): _;
    }
  `);
  const missing = diagnostics(source, sourceFile)[0];
  assert.equal(missing.code, "Z0801");
  assert.match(missing.message, /declaration names unknown foreign function "missing"/);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function known(): _ nullible;
    }
  `);
  const malformed = diagnostics(source, sourceFile)[0];
  assert.equal(malformed.code, "Z0801");
  assert.match(malformed.message, /expected ";" in Z declaration file, found "nullible"/);
});

test("imports C typedefs, records, enums, constants, and qualified signatures", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-types.zs");
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
  const generated = compileToC(source, "integer-widths.zs");
  assert.match(generated, /static uint16_t plus\(uint16_t value\)/);
  assert.match(generated, /const uint16_t result = z_checked_add_u16\(value, 3\);/);
  assert.match(generated, /return 4294967295U;/);
  assert.match(generated, /return 18446744073709551615ULL;/);

  assert.throws(
    () => compileToC(source.replace("65535", "65536"), "integer-overflow.zs"),
    /integer literal 65536 does not fit u16/,
  );

  const inferredWide = `
    function main(): i32 {
      const value = 4294967295;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferredWide, "integer-default.zs"),
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
  const generated = compileToC(source, "signed-context.zs");
  assert.match(generated, /const int8_t narrow = INT8_MIN;/);
  assert.match(generated, /const int16_t positive = 32767;/);
  assert.match(generated, /const float fraction = \(-1\.5F\);/);
  assert.match(generated, /assigned = INT16_MIN;/);
  assert.match(generated, /echo\(INT8_MIN\)/);
  assert.match(generated, /\.value = INT8_MIN/);

  const narrowLiteral = source.indexOf("128", source.indexOf("narrow:")) + 1;
  assert.match(hover(source, "signed-context.zs", narrowLiteral)?.contents.value ?? "", /128: i8/);

  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: i8 = -129"), "signed-too-small.zs"),
    /integer literal -129 does not fit i8/,
  );
  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: u8 = -1"), "unsigned-negative.zs"),
    /integer literal -1 does not fit u8/,
  );

  const directory = mkdtempSync("/tmp/z-signed-context-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("checks integer arithmetic and provides explicit wrapping and saturation", () => {
  const example = resolve(projectRoot, "examples/language/basics/integer-safety.zs");
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
    ["function main(): i32 { return 2147483647 + 1; }", "constant-add-overflow.zs", "Z0101", /overflows i32/],
    ["function main(): i32 { return 10 / 0; }", "constant-divide-zero.zs", "Z0102", /division by zero/],
    ["function main(): i32 { return 1 << 32; }", "constant-shift-range.zs", "Z0103", /outside the range for i32/],
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
  const trapSource = resolve(directory, "main.zs");
  writeFileSync(trapSource, `
    function overflow(value: i32): i32 { return value + 1; }
    function main(): i32 { return overflow(2147483647); }
  `);
  const trapped = spawnSync(process.execPath, [cli, "run", trapSource], { encoding: "utf8" });
  assert.notEqual(trapped.status, 0);
});

test("constructs integer values with explicit checked conversions", () => {
  const source = `
    function widen(value: u8): i32 {
      return i32(value);
    }

    function narrow(value: i32): u8 {
      return u8(value);
    }

    function nativeCount(value: usize): isize {
      return isize(value);
    }

    function main(): i32 {
      const small: u8 = 42;
      const count: usize = 44;
      if (widen(small) != 42) return 1;
      if (narrow(43) != 43) return 2;
      if (nativeCount(count) != 44) return 3;
      return 0;
    }
  `;
  const generated = compileToC(source, "integer-conversions.zs");
  assert.match(generated, /return \(\(int32_t\)\(value\)\);/);
  assert.match(generated, /z_checked_convert_i32_to_u8/);
  assert.match(generated, /z_checked_convert_usize_to_isize/);

  const conversionOffset = source.indexOf("isize(value)") + 1;
  const conversionHover = hover(source, "integer-conversions.zs", conversionOffset)?.contents.value ?? "";
  assert.match(conversionHover, /isize\(value: usize\): isize/);
  assert.match(conversionHover, /runtime range check/);

  assert.throws(
    () => compileToC("function main(): i32 { const value = u8(256); return i32(value); }", "constant-conversion.zs"),
    /integer literal 256 does not fit u8/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value: usize = 1; const native: isize = value; return 0; }", "implicit-conversion.zs"),
    /expected isize, found usize/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value = f64(1); return 0; }", "float-conversion.zs"),
    /not available in the integer-only conversion tier/,
  );

  const directory = mkdtempSync("/tmp/z-integer-conversion-");
  const successFile = resolve(directory, "success.zs");
  writeFileSync(successFile, source);
  const success = spawnSync(process.execPath, [cli, "run", successFile], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);

  const trapFile = resolve(directory, "trap.zs");
  writeFileSync(trapFile, `
    function narrow(value: i32): u8 { return u8(value); }
    function main(): i32 {
      const value = narrow(-1);
      return i32(value);
    }
  `);
  const trapped = spawnSync(process.execPath, [cli, "run", trapFile], { encoding: "utf8" });
  assert.notEqual(trapped.status, 0);

  const asyncFile = resolve(directory, "async.zs");
  writeFileSync(asyncFile, `
    async function convert(value: usize): isize {
      return isize(value);
    }
    async function main(): i32 {
      const converted = await convert(42);
      return i32(converted) - 42;
    }
  `);
  const asyncResult = spawnSync(process.execPath, [cli, "run", asyncFile], { encoding: "utf8" });
  assert.equal(asyncResult.status, 0, asyncResult.stderr);
});

test("runs floating-point values and typed bitwise option masks", () => {
  const example = resolve(projectRoot, "examples/interop/c/apple-groundwork.zs");
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
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-interop.zs");
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
  assert.match(pointDefinition?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);
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
  assert.match(floatingScaleDefinition?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);
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
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-selective-interop.zs");
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
  assert.match(definition(source, `file://${example}`, pointOffset)?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);

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

test("declares, copies, aggregates, and destroys foreign C++ values", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/foreign-values.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /struct Z_NativeOwner \{\s*zcpp::ManagedValue value;/);
  assert.match(artifact.source, /const Z_NativeOwner owner = .*\.value = first/);
  assert.match(artifact.source, /Z_NativeOwner copied = owner/);
  assert.match(artifact.source, /\(copied\)\.value\.add\(2\)/);
  assert.match(artifact.source, /\(copied\)\.value\.value\(\)/);

  const context = analyzeSource(source, example);
  const managed = context.foreignModules.get("native")?.namedTypes.get("zcpp.ManagedValue");
  assert.equal(managed?.kind, "value");
  if (managed?.kind === "value") {
    assert.deepEqual(managed.lifecycle, { copy: true, move: false, deinit: true });
  }
  const typeOffset = source.indexOf("ManagedValue") + 2;
  assert.match(hover(source, example, typeOffset)?.contents.value ?? "", /native value: copy, deinit; unavailable: move/);
  const publicFieldOffset = source.indexOf("copied.value") + "copied.".length + 1;
  assert.equal(
    hover(source, example, publicFieldOffset)?.contents.value,
    "```z\nvalue: native.zcpp.ManagedValue\n```",
  );
  const publicFieldCompletionSource = source.replace(
    "  copied.value.add(2);",
    "  copied.;\n  copied.value.add(2);",
  );
  const publicFieldCompletionOffset = publicFieldCompletionSource.indexOf("copied.;") + "copied.".length;
  assert.equal(
    completions(publicFieldCompletionSource, example, publicFieldCompletionOffset).find((item) => item.label === "value")?.detail,
    "native.zcpp.ManagedValue",
  );
  const nativeValue = context.foreignModules.get("native")?.namedTypes.get("zcpp.ManagedValue");
  assert.equal(nativeValue?.kind, "value");
  if (nativeValue?.kind === "value") {
    assert.equal(nativeValue.constructors.length, 1);
    assert.equal(nativeValue.constructors[0]?.parameters[0]?.name, "value");
    assert.equal(nativeValue.staticMethods.find((method) => method.name === "from")?.overloads.length, 1);
    assert.equal(nativeValue.staticMethods.find((method) => method.name === "sum")?.overloads.length, 2);
    assert.equal(nativeValue.methods.find((method) => method.name === "value")?.overloads[0]?.receiverAccess, "in");
    assert.equal(nativeValue.methods.find((method) => method.name === "add")?.overloads[0]?.receiverAccess, "inout");
    assert.equal(nativeValue.methods.find((method) => method.name === "plus")?.overloads.length, 2);
  }
  const methodOffset = source.lastIndexOf("value()") + 1;
  assert.match(hover(source, example, methodOffset)?.contents.value ?? "", /value\(\): i32.*C\+\+ const/);
  const methodCompletionSource = source.replace(
    "  return copied.value.value();",
    "  copied.value.;\n  return copied.value.value();",
  );
  const methodCompletionOffset = methodCompletionSource.indexOf("copied.value.;") + "copied.value.".length;
  const methodItems = completions(methodCompletionSource, example, methodCompletionOffset);
  assert.match(methodItems.find((item) => item.label === "add")?.detail ?? "", /C\+\+ mutable/);
  assert.match(methodItems.find((item) => item.label === "value")?.detail ?? "", /C\+\+ const/);
  assert.match(definition(source, `file://${example}`, methodOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const overloadedMethod = source.replace("copied.value.value()", "copied.value.plus(0)");
  assert.match(compileToNative(overloadedMethod, example).source, /\(copied\)\.value\.plus\(0\)/);
  assert.throws(
    () => compileToNative(source.replace("copied.value.value()", 'copied.value.plus("no")'), example),
    /no overload of native method "zcpp\.ManagedValue\.plus" accepts these arguments/,
  );

  const immutableMutation = source.replace("let copied = owner;", "const copied = owner;");
  assert.throws(
    () => compileToNative(immutableMutation, example),
    /mutable native method "add" requires addressable let storage/,
  );
  const immutableRead = immutableMutation
    .replace("  copied.value.add(2);\n", "")
    .replace("copied.value.value()", "copied.value.plus(2)");
  assert.match(compileToNative(immutableRead, example).source, /\(copied\)\.value\.plus\(2\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer=42, copies=2, drops=3, live=0\n");

  const declarationFile = resolve(projectRoot, "tests/fixtures/foreign-values.hpp.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const declaredType = declarationSource.indexOf("ManagedValue") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declaredType)?.contents.value ?? "",
    /type ManagedValue: zcpp::ManagedValue.*native value: copy, deinit; unavailable: move/,
  );
  const copyCapability = declarationSource.indexOf("copy") + 1;
  assert.match(hover(declarationSource, declarationFile, copyCapability)?.contents.value ?? "", /copy: native lifecycle capability/);
  const typeCompletionSource = declarationSource.replace("zcpp.ManagedValue {", "zcpp.Man");
  const typeCompletionOffset = typeCompletionSource.indexOf("zcpp.Man") + "zcpp.Man".length;
  assert.equal(
    completions(typeCompletionSource, declarationFile, typeCompletionOffset)
      .find((item) => item.label === "zcpp.ManagedValue")?.kind,
    22,
  );
  const lifecycleCompletionSource = declarationSource.replace("copy;", "cop");
  const lifecycleCompletionOffset = lifecycleCompletionSource.indexOf("cop") + "cop".length;
  assert.equal(
    completions(lifecycleCompletionSource, declarationFile, lifecycleCompletionOffset)
      .find((item) => item.label === "copy")?.insertText,
    "copy;",
  );

  const invalidDirectory = mkdtempSync("/tmp/z-foreign-value-lifecycle-");
  const invalidHeader = resolve(invalidDirectory, "foreign-values.hpp");
  const invalidSource = resolve(invalidDirectory, "main.zs");
  writeFileSync(invalidHeader, readFileSync(resolve(projectRoot, "tests/fixtures/foreign-values.hpp"), "utf8"));
  writeFileSync(`${invalidHeader}.zd`, `
    declare module "foreign-values.hpp" {
      export type zcpp.ManagedValue {
        move;
        deinit;
      }
    }
  `);
  const invalidProgram = `import native from "foreign-values.hpp"; function main(): i32 { return 0; }`;
  const invalidDiagnostic = diagnostics(invalidProgram, invalidSource)[0];
  assert.equal(invalidDiagnostic.code, "Z0801");
  assert.match(invalidDiagnostic.message, /declares move, but Clang cannot prove that capability/);

  const moveOnlyDirectory = mkdtempSync("/tmp/z-foreign-move-only-");
  const moveOnlyHeader = resolve(moveOnlyDirectory, "move-only.hpp");
  const moveOnlySource = resolve(moveOnlyDirectory, "main.zs");
  writeFileSync(moveOnlyHeader, `
    namespace zcpp {
      class MoveOnly {
      public:
        explicit MoveOnly(int value) : value_(value) {}
        MoveOnly(const MoveOnly &) = delete;
        MoveOnly &operator=(const MoveOnly &) = delete;
        MoveOnly(MoveOnly &&other) : value_(other.value_) { other.value_ = 0; }
        MoveOnly &operator=(MoveOnly &&other) { value_ = other.value_; other.value_ = 0; return *this; }
        ~MoveOnly() {}
      private:
        int value_;
      };
    }
  `);
  writeFileSync(`${moveOnlyHeader}.zd`, `
    declare module "move-only.hpp" {
      export type zcpp.MoveOnly {
        move;
        deinit;
      }
    }
  `);
  const moveOnlyProgram = `import native from "move-only.hpp"; function main(): i32 { return 0; }`;
  assert.deepEqual(diagnostics(moveOnlyProgram, moveOnlySource), []);
  assert.match(compileToNative(moveOnlyProgram, moveOnlySource).source, /#include <utility>/);
});

test("moves non-copyable C++ values through owned Z bindings and value structs", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-move-only.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /#include <utility>/);
  assert.match(generated, /zcpp::UniqueValue first = zcpp::UniqueValue\(40\);/);
  assert.match(generated, /relay\(std::move\(first\)\)/);
  assert.match(generated, /\.value = std::move\(second\)/);
  assert.match(generated, /Z_NativeOwner moved = std::move\(owner\);/);
  assert.doesNotMatch(generated, /const zcpp::UniqueValue first/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const movedUse = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      const first = native.zcpp.UniqueValue(42);
      const second = first;
      return first.value();
    }
  `;
  const movedDiagnostic = diagnostics(movedUse, example)[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "first"/);

  const classStorage = `
    import native from "../../../tests/fixtures/move-only.hpp";
    class Session {
      value: native.zcpp.UniqueValue;
    }
    function main(): i32 { return 0; }
  `;
  const classDiagnostic = diagnostics(classStorage, example)[0];
  assert.equal(classDiagnostic.code, "Z0240");
  assert.match(classDiagnostic.message, /ARC class fields cannot store move-only native values/);

  const uninitializedStorage = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let value: native.zcpp.UniqueValue;
      return 0;
    }
  `;
  const uninitializedDiagnostic = diagnostics(uninitializedStorage, example)[0];
  assert.equal(uninitializedDiagnostic.code, "Z0240");
  assert.match(uninitializedDiagnostic.message, /must be initialized when their storage is declared/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/move-only.hpp.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const typeOffset = declarationSource.indexOf("UniqueValue") + 2;
  assert.match(
    hover(declarationSource, declarationFile, typeOffset)?.contents.value ?? "",
    /native value: move, deinit; unavailable: copy/,
  );
});

test("stores move-only C++ values in Array and named enum payloads", () => {
  const arrayExample = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-array.zs");
  const arraySource = readFileSync(arrayExample, "utf8");
  const arrayGenerated = compileToNative(arraySource, arrayExample).source;
  assert.match(arrayGenerated, /#include <memory>/);
  assert.match(arrayGenerated, /#include <new>/);
  assert.match(arrayGenerated, /std::construct_at\(&storage\[index\], std::move\(self->data\[index\]\)\)/);
  assert.match(arrayGenerated, /std::destroy_at\(&self->data\[index - 1\]\)/);
  assert.match(arrayGenerated, /::operator delete\(self->data\)/);
  assert.match(arrayGenerated, /Z_LabeledValue_deinit\([^\n]+\);\n\s*std::destroy_at/);
  assert.doesNotMatch(arrayGenerated, /realloc\(self->data/);
  const arrayHoverOffset = arraySource.indexOf("values = makeValues") + 2;
  assert.match(
    hover(arraySource, arrayExample, arrayHoverOffset)?.contents.value ?? "",
    /values: Array<zcpp\.UniqueValue>/,
  );
  const arrayResult = spawnSync(process.execPath, [cli, "run", arrayExample], { encoding: "utf8" });
  assert.equal(arrayResult.status, 0, arrayResult.stderr);
  assert.match(arrayResult.stdout, /^array answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const enumExample = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-enum.zs");
  const enumSource = readFileSync(enumExample, "utf8");
  const enumGenerated = compileToNative(enumSource, enumExample).source;
  assert.match(enumGenerated, /Z_NativeState\(Z_NativeState &&other\)/);
  assert.match(enumGenerated, /operator=\(Z_NativeState &&other\)/);
  assert.match(enumGenerated, /std::construct_at\(&result\.data\.ready, std::move\(value\)\)/);
  assert.match(enumGenerated, /std::destroy_at\(&data\.ready\)/);
  assert.match(enumGenerated, /const Z_NativeState \*_z_match_/);
  assert.match(enumGenerated, /zcpp::UniqueValue const \*value = &\(_z_match_[0-9]+->data\.ready\)/);
  assert.match(enumGenerated, /zcpp::UniqueValue value = std::move\(_z_match_[0-9]+\.data\.ready\)/);
  assert.match(enumGenerated, /Z_LabeledValue_deinit\(&\(\(labeled\)\.data\.ready\)\);[\s\S]*labeled = std::move\(_z_replacement_[0-9]+\);/);
  const borrowedPayloadOffset = enumSource.indexOf("ready(value)") + "ready(".length + 1;
  assert.match(
    hover(enumSource, enumExample, borrowedPayloadOffset)?.contents.value ?? "",
    /value: zcpp\.UniqueValue/,
  );
  const enumResult = spawnSync(process.execPath, [cli, "run", enumExample], { encoding: "utf8" });
  assert.equal(enumResult.status, 0, enumResult.stderr);
  assert.match(enumResult.stdout, /^enum answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const movedElement = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Array<native.zcpp.UniqueValue>();
      values.push(native.zcpp.UniqueValue(42));
      const extracted = values[0];
      return extracted.value();
    }
  `;
  const elementDiagnostic = diagnostics(movedElement, arrayExample)[0];
  assert.match(elementDiagnostic.message, /cannot move an ownership-bearing field or element out of its owner/);

  const optionDirectory = mkdtempSync("/tmp/z-native-option-");
  const optionFile = resolve(optionDirectory, "main.zs");
  const compilerOption = `
    import native from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};

    function open(fail: boolean): native.zcpp.UniqueValue throws i32 {
      if (fail) throw 7;
      return native.zcpp.UniqueValue(42);
    }

    function relay(): native.zcpp.UniqueValue throws i32 {
      return try open(false);
    }

    function main(): i32 {
      const option: Option<native.zcpp.UniqueValue> = Option.some(native.zcpp.UniqueValue(42));
      const optionAnswer = match (option) {
        some(value) => value.finish(0);
        none => 0;
      };
      const empty: Option<native.zcpp.UniqueValue> = Option.none;
      const emptyAnswer = match (empty) {
        some(value) => value.finish(0);
        none => 0;
      };
      const result = attempt relay();
      const resultAnswer = match (result) {
        success(value) => value.finish(0);
        failure(error) => -error;
      };
      const failed = attempt open(true);
      const failureCode = match (failed) {
        success(value) => value.finish(0);
        failure(error) => error;
      };
      return optionAnswer - 42 + emptyAnswer + resultAnswer - 42 + failureCode - 7 + native.zcpp.unique_live();
    }
  `;
  writeFileSync(optionFile, compilerOption);
  const optionGenerated = compileToNative(compilerOption, optionFile).source;
  assert.match(optionGenerated, /Z_Option_[^:]+::make_some/);
  assert.match(optionGenerated, /Z_Option_[^:]+::make_none/);
  assert.match(optionGenerated, /Z_Result_[^:]+::make_success/);
  assert.match(optionGenerated, /Z_Result_[^:]+::make_failure/);
  assert.match(optionGenerated, /zcpp::UniqueValue value = std::move/);
  const optionResult = spawnSync(process.execPath, [cli, "run", optionFile], { encoding: "utf8" });
  assert.equal(optionResult.status, 0, optionResult.stderr);

  const mixedStructReplacement = `
    import native from "../../../tests/fixtures/move-only.hpp";
    struct LabeledValue {
      label: String;
      value: native.zcpp.UniqueValue;
    }
    function main(): i32 {
      let value = LabeledValue({ label: "first", value: native.zcpp.UniqueValue(1) });
      value = LabeledValue({ label: "second", value: native.zcpp.UniqueValue(2) });
      return 0;
    }
  `;
  const replacementDiagnostic = diagnostics(mixedStructReplacement, arrayExample)[0];
  assert.equal(replacementDiagnostic.code, "Z0240");
  assert.match(replacementDiagnostic.message, /replacement assignment for a value combining Z cleanup and move-only native storage/);
});

test("maps C++ references and receiver qualifiers onto existing Z capabilities", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-references.zs");
  const source = readFileSync(example, "utf8");
  const analysis = analyzeSource(source, example);
  const module = analysis.foreignModules.get("native")!;
  const inspectParameter = module.functions.get("zcpp.inspect_unique")?.overloads[0]?.parameters[0]?.type;
  const adjustParameter = module.functions.get("zcpp.adjust_unique")?.overloads[0]?.parameters[0]?.type;
  const consumeParameter = module.functions.get("zcpp.consume_unique")?.overloads[0]?.parameters[0]?.type;
  assert.equal(inspectParameter?.kind === "reference" ? inspectParameter.access : null, "in");
  assert.equal(adjustParameter?.kind === "reference" ? adjustParameter.access : null, "inout");
  assert.equal(consumeParameter?.kind === "reference" ? consumeParameter.access : null, "move");
  const nativeValue = module.namedTypes.get("zcpp.UniqueValue");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "value")?.overloads[0]?.receiverAccess
    : null, "in");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "add")?.overloads[0]?.receiverAccess
    : null, "inout");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "finish")?.overloads[0]?.receiverAccess
    : null, "move");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /inspect_unique\(functionValue\)/);
  assert.match(generated, /adjust_unique\(functionValue, 2\)/);
  assert.match(generated, /consume_unique\(std::move\(functionValue\)\)/);
  assert.match(generated, /methodValue\.value\(\)/);
  assert.match(generated, /methodValue\.add\(2\)/);
  assert.match(generated, /std::move\(methodValue\)\.finish\(0\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer=42, live=0\n");

  const inspectHover = hover(source, example, source.indexOf("inspect_unique") + 2)?.contents.value ?? "";
  assert.match(inspectHover, /inspect_unique\(in value: .*UniqueValue\): i32/);
  const adjustHover = hover(source, example, source.indexOf("adjust_unique") + 2)?.contents.value ?? "";
  assert.match(adjustHover, /adjust_unique\(inout value: .*UniqueValue, amount: i32\): void/);
  const consumeHover = hover(source, example, source.indexOf("consume_unique") + 2)?.contents.value ?? "";
  assert.match(consumeHover, /consume_unique\(value: .*UniqueValue\): i32.*UniqueValue &&/s);
  const finishHover = hover(source, example, source.lastIndexOf("finish(") + 2)?.contents.value ?? "";
  assert.match(finishHover, /finish\(move this, offset: i32\): i32.*C\+\+ consuming receiver/s);
  const completionSource = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let value = native.zcpp.UniqueValue(1);
      value.;
      return 0;
    }
  `;
  const completionOffset = completionSource.indexOf("value.;") + "value.".length;
  const finishCompletion = completions(completionSource, example, completionOffset)
    .find((item) => item.label === "finish");
  assert.match(finishCompletion?.detail ?? "", /move this.*C\+\+ consuming receiver/s);

  const missingInout = source.replace("adjust_unique(inout functionValue", "adjust_unique(functionValue");
  assert.match(
    diagnostics(missingInout, example)[0]?.message ?? "",
    /C\+\+ mutable reference parameter requires inout <mutable binding>/,
  );

  const immutableReceiver = source
    .replace("let methodValue", "const methodValue")
    .replace("methodValue.finish(0)", "native.zcpp.consume_unique(methodValue)");
  assert.match(
    diagnostics(immutableReceiver, example)[0]?.message ?? "",
    /mutable native method "add" requires addressable let storage/,
  );

  const useAfterFunctionMove = source.replace(
    "const consumed = native.zcpp.consume_unique(functionValue);",
    "const consumed = native.zcpp.consume_unique(functionValue);\n  const invalid = functionValue.value();",
  );
  assert.equal(diagnostics(useAfterFunctionMove, example)[0]?.code, "Z0201");

  const useAfterMethodMove = source.replace(
    "const finished = methodValue.finish(0);",
    "const finished = methodValue.finish(0);\n  const invalid = methodValue.value();",
  );
  assert.equal(diagnostics(useAfterMethodMove, example)[0]?.code, "Z0201");

  const ambiguousReceiver = source.replace("methodValue.finish(0)", "methodValue.qualified()");
  const ambiguousDiagnostic = diagnostics(ambiguousReceiver, example)[0];
  assert.equal(ambiguousDiagnostic?.code, "Z0803");
  assert.match(ambiguousDiagnostic?.message ?? "", /receiver-qualified overloads that require an explicit receiver capability choice/);

  const ambiguousArgument = source.replace(
    "native.zcpp.consume_unique(functionValue)",
    "native.zcpp.qualified_unique(functionValue)",
  );
  const argumentDiagnostic = diagnostics(ambiguousArgument, example)[0];
  assert.equal(argumentDiagnostic?.code, "Z0803");
  assert.match(argumentDiagnostic?.message ?? "", /requires an explicit argument capability choice/);
});

test("imports C++ constructors and static methods as direct type-level calls", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-callables.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /const zcpp::ManagedValue direct = zcpp::ManagedValue\(20\);/);
  assert.match(generated, /const zcpp::ManagedValue made = zcpp::ManagedValue::from\(22\);/);
  assert.match(generated, /zcpp::ManagedValue::sum\(direct\.value\(\), made\.value\(\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const constructorOffset = source.indexOf("ManagedValue(20)");
  assert.match(hover(source, example, constructorOffset)?.contents.value ?? "", /ManagedValue\(value: i32\).*C\+\+ constructor/);
  assert.match(definition(source, `file://${example}`, constructorOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const staticOffset = source.indexOf("from(22)");
  assert.match(hover(source, example, staticOffset)?.contents.value ?? "", /from\(value: i32\): native\.zcpp\.ManagedValue.*C\+\+ static/);
  assert.match(definition(source, `file://${example}`, staticOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const completionSource = source.replace("native.zcpp.ManagedValue.from(22)", "native.zcpp.ManagedValue.");
  const completionOffset = completionSource.indexOf("native.zcpp.ManagedValue.") + "native.zcpp.ManagedValue.".length;
  const items = completions(completionSource, example, completionOffset);
  assert.match(items.find((item) => item.label === "from")?.detail ?? "", /C\+\+ static/);
  assert.match(items.find((item) => item.label === "sum")?.detail ?? "", /sum\(left: i32, right: i32\)/);
  assert.equal(items.some((item) => item.label === "value"), false);

  const selective = source
    .replace('import native from "../../../tests/fixtures/foreign-values.hpp";', 'import { ManagedValue as Value } from "../../../tests/fixtures/foreign-values.hpp";')
    .replaceAll("native.zcpp.ManagedValue", "Value");
  const selectiveGenerated = compileToNative(selective, example).source;
  assert.match(selectiveGenerated, /zcpp::ManagedValue::from\(22\)/);
  const selectiveStaticOffset = selective.indexOf("from(22)");
  assert.match(hover(selective, example, selectiveStaticOffset)?.contents.value ?? "", /C\+\+ static/);
  const selectiveCompletionSource = selective.replace("Value.from(22)", "Value.");
  const selectiveCompletionOffset = selectiveCompletionSource.indexOf("Value.") + "Value.".length;
  assert.equal(
    completions(selectiveCompletionSource, example, selectiveCompletionOffset)
      .find((item) => item.label === "from")?.insertText,
    "from()",
  );

  assert.throws(
    () => compileToNative(source.replace("ManagedValue.sum(direct.value(), made.value())", 'ManagedValue.sum("left", "right")'), example),
    /no overload of native static method "zcpp\.ManagedValue\.sum" accepts these arguments/,
  );
  assert.throws(
    () => compileToNative(source.replace("ManagedValue.from(22)", "ManagedValue.missing(22)"), example),
    /native value type "native\.zcpp\.ManagedValue" has no static method "missing"/,
  );
  assert.throws(
    () => compileToNative(source.replace("ManagedValue.from(22)", "ManagedValue.value()"), example),
    /native instance method "value" must be called through a native\.zcpp\.ManagedValue value/,
  );
});

test("imports AppKit classes and emits an ARC Objective-C NSWindow program", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/nswindow.zs");
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
  const fileName = resolve(projectRoot, "objc-nullability.zs");
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

  const identityMap = `
    import { Map } from "std/collections";
    import AppKit from "AppKit/AppKit.h";
    function main(): i32 {
      let windows = Map<i32, AppKit.NSWindow>();
      const window = AppKit.NSWindow.alloc();
      windows.set(1, window);
      const found = windows.get(1);
      return match (in found) {
        some(stored) => 0;
        none => 1;
      };
    }
  `;
  const identityMapArtifact = compileToNative(identityMap, fileName);
  assert.deepEqual(diagnostics(identityMap, fileName), []);
  assert.doesNotMatch(identityMapArtifact.source, /Z_[A-Za-z0-9_]*AppKit\.NSWindow/);
  assert.match(identityMapArtifact.source, /typedef NSWindow \*Z_Option_AppKit_2e_NSWindow/);
  assert.match(identityMapArtifact.source, /Z_Option_AppKit_2e_NSWindow Z_Map_.*_get/);
  assert.match(identityMapArtifact.source, /static void Z_.*MapEntry.*_deinit[\s\S]*?self->value = nil/);
  const identityMapCompilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: identityMapArtifact.source, encoding: "utf8" });
  assert.equal(identityMapCompilation.status, 0, identityMapCompilation.stderr);

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
  const wrongDiagnostic = diagnostics(wrongOptional, "value-nullability.zs")[0];
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
  const example = resolve(projectRoot, "examples/interop/objc/objc-nullability.zs");
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
  const example = resolve(projectRoot, "examples/interop/objc/desktop-ownership/main.zs");
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

test("builds the interactive Z Notes AppKit and sqlite3 application", () => {
  if (process.platform !== "darwin") return;
  const application = resolve(projectRoot, "examples/applications/z-notes/main.zs");
  const source = readFileSync(application, "utf8");
  const artifact = compileToNative(source, application);
  assert.equal(artifact.language, "objective-c");
  assert.ok(artifact.frameworks.includes("AppKit"));
  assert.ok(artifact.frameworks.includes("Foundation"));
  assert.ok(artifact.nativeLinkerArguments.includes("-lsqlite3"));
  assert.match(artifact.source, /sqlite3_libversion\(\)/);
  assert.match(artifact.source, /const int32_t rowStatus = SQLITE_ROW;/);
  assert.match(artifact.source, /const int32_t doneStatus = SQLITE_DONE;/);
  assert.match(artifact.source, /sqlite3_open\(":memory:", &\(database\)\)/);
  assert.match(artifact.source, /Z_Result_void_i32/);
  assert.match(artifact.source, /_z_native_status_\d+ == 0/);
  assert.match(artifact.source, /if \(_z_live_database_\d+ && database != NULL\) sqlite3_close\(database\)/);
  assert.match(artifact.source, /sqlite3 \* database;/);
  assert.match(artifact.source, /NoteDatabase_deinit\([^)]+\) \{\n\s+\(void\)self;\n\s+sqlite3_close\(self->database\);/);
  assert.equal(artifact.source.match(/sqlite3_open\(/g)?.length, 2);
  assert.match(artifact.source, /sqlite3_prepare_v2\(self->database, .*SELECT id, title, body FROM notes ORDER BY id/);
  assert.match(artifact.source, /sqlite3_bind_int64\(statement, 1, .*note.*id/);
  assert.match(artifact.source, /sqlite3_bind_text\(statement, 2, [^\n]+title[^\n]+SQLITE_TRANSIENT\)/);
  assert.match(artifact.source, /sqlite3_bind_text\(statement, 3, [^\n]+body[^\n]+SQLITE_TRANSIENT\)/);
  assert.match(artifact.source, /z_string_from_cstring\(\(const char \*\)\(titleBytes\)\)/);
  assert.match(artifact.source, /if \(_z_live_queryStatement_\d+ && queryStatement != NULL\) sqlite3_finalize\(queryStatement\)/);
  assert.match(artifact.source, /\[\[NSWindow alloc\] initWithContentRect/);
  assert.match(artifact.source, /Z_Option_usize_some/);
  assert.match(artifact.source, /@interface ZObjCConnection : NSObject/);
  assert.match(artifact.source, /\[_z_control setTarget:self\]/);
  assert.match(artifact.source, /\[_z_control setAction:@selector\(z_invoke:\)\]/);
  assert.match(artifact.source, /ZObjCConnection \* const addNoteConnection = z_objc_connect\(/);
  assert.match(artifact.source, /\[content addSubview:statusLabel\]/);
  assert.match(artifact.source, /\[statusLabel setStringValue:z_nsstring_from_string/);
  assert.match(artifact.source, /\[\[NSTableView alloc\] initWithFrame/);
  assert.match(artifact.source, /\[\[NSScrollView alloc\] initWithFrame/);
  assert.match(artifact.source, /\[notesScroll setHasVerticalScroller:true\]/);
  assert.match(artifact.source, /\[notesScroll setDocumentView:notesView\]/);
  assert.match(artifact.source, /\[notesView addTableColumn:notesColumn\]/);
  assert.match(artifact.source, /\[notesView reloadData\]/);
  assert.match(artifact.source, /@interface ZObjCProtocolAdapter_[A-Za-z0-9_]+NotesTableController : NSObject <NSTableViewDataSource, NSTableViewDelegate>/);
  assert.match(artifact.source, /\[object setDataSource:_z_adapter_0\]/);
  assert.match(artifact.source, /\[object setDelegate:_z_adapter_0\]/);
  assert.match(artifact.source, /ZObjCBinding \* const tableBinding = z_objc_bind_/);
  assert.match(artifact.source, /z_checked_convert_usize_to_isize/);
  assert.match(artifact.source, /z_checked_convert_isize_to_usize/);
  assert.match(artifact.source, /tableViewSelectionDidChange:/);

  const compilation = spawnSync("xcrun", [
    "clang", "-x", "objective-c", "-fobjc-arc", "-fblocks",
    "-mmacosx-version-min=14.0",
    "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", application, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 4 modules, 5 local edges/);

  const smoke = resolve(projectRoot, "examples/applications/z-notes/smoke.zs");
  const result = spawnSync(process.execPath, [cli, "run", smoke], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^z-notes sqlite=[0-9.]+, notes=1, database=true\n$/);

  const persistenceSmoke = resolve(projectRoot, "examples/applications/z-notes/persistence-smoke.zs");
  const persistenceDatabase = resolve(projectRoot, ".z-cache/z-notes-smoke.sqlite3");
  rmSync(persistenceDatabase, { force: true });
  const persistenceResult = spawnSync(process.execPath, [cli, "run", persistenceSmoke], { encoding: "utf8" });
  assert.equal(persistenceResult.status, 0, persistenceResult.stderr);
  assert.equal(persistenceResult.stdout, "persisted note 3, before=2, after=3\n");
  rmSync(persistenceDatabase, { force: true });

  const selectionUse = source.indexOf("selectNote(0)") + 1;
  assert.match(hover(source, application, selectionUse)?.contents.value ?? "", /selectNote\(index: usize\): boolean/);
  const tableController = resolve(projectRoot, "examples/applications/z-notes/table-controller.zs");
  const tableControllerSource = readFileSync(tableController, "utf8");
  const rowCountUse = tableControllerSource.indexOf("tableRowCount()") + 1;
  assert.match(hover(tableControllerSource, tableController, rowCountUse)?.contents.value ?? "", /tableRowCount\(\): isize/);
  const selectionMethod = tableControllerSource.indexOf("selectionDidChange") + 1;
  assert.match(
    hover(tableControllerSource, tableController, selectionMethod)?.contents.value ?? "",
    /tableViewSelectionDidChange:/,
  );
  const model = resolve(projectRoot, "examples/applications/z-notes/model.zs");
  const modelSource = readFileSync(model, "utf8");
  const countConversion = modelSource.indexOf("isize(this.notes.length)") + 1;
  assert.match(
    hover(modelSource, model, countConversion)?.contents.value ?? "",
    /runtime range check/,
  );

  const persistence = resolve(projectRoot, "examples/applications/z-notes/persistence.zs");
  const persistenceSource = readFileSync(persistence, "utf8");
  const databaseTypeOffset = persistenceSource.indexOf(
    "sqlite.sqlite3",
    persistenceSource.indexOf("class NoteDatabase"),
  ) + "sqlite.".length + 2;
  assert.match(hover(persistenceSource, persistence, databaseTypeOffset)?.contents.value ?? "", /sqlite\.sqlite3/);
  const databaseFieldOffset = persistenceSource.indexOf("database:", persistenceSource.indexOf("class NoteDatabase")) + 2;
  assert.match(hover(persistenceSource, persistence, databaseFieldOffset)?.contents.value ?? "", /private database: sqlite\.sqlite3/);
  const titleBytesOffset = persistenceSource.indexOf("titleBytes =") + 2;
  assert.match(hover(persistenceSource, persistence, titleBytesOffset)?.contents.value ?? "", /titleBytes: view cstring \| null/);
  const rowStatusOffset = persistenceSource.indexOf("SQLITE_ROW") + 2;
  assert.match(
    hover(persistenceSource, persistence, rowStatusOffset)?.contents.value ?? "",
    /SQLITE_ROW: i32.*C object-like macro/,
  );
  assert.match(
    definition(persistenceSource, `file://${persistence}`, rowStatusOffset)?.uri ?? "",
    /sqlite3\.h$/,
  );

  const nullableCopy = persistenceSource.replace("      if (titleBytes == null) throw -1;\n", "");
  assert.match(
    diagnostics(nullableCopy, persistence)[0]?.message ?? "",
    /nullable native text must be checked before copying it into String/,
  );
  const nonNullTail = persistenceSource.replace(
    "      out schemaStatement,\n      null",
    "      out schemaStatement,\n      this.database",
  );
  assert.match(
    diagnostics(nonNullTail, persistence)[0]?.message ?? "",
    /restricts native parameter 5 to null/,
  );
  const prematureFinalize = persistenceSource.replace(
    "    const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);",
    "    sqlite.sqlite3_finalize(queryStatement);\n    const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);",
  );
  assert.match(
    diagnostics(prematureFinalize, persistence)[0]?.message ?? "",
    /cannot move "queryStatement" while view "titleBytes" is live/,
  );

  const declarationFile = resolve(projectRoot, "examples/applications/z-notes/sqlite3.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const partial = declarationSource.replace("deinit sqlite3_close", "deinit sqli");
  const partialOffset = partial.indexOf("deinit sqli") + "deinit sqli".length;
  assert.equal(
    completions(partial, declarationFile, partialOffset).find((item) => item.label === "sqlite3_close")?.kind,
    3,
  );
  const closeOffset = declarationSource.indexOf("sqlite3_close", declarationSource.indexOf("deinit")) + 2;
  assert.match(hover(declarationSource, declarationFile, closeOffset)?.contents.value ?? "", /deinitializer for out ppDb/);
  assert.match(definition(declarationSource, `file://${declarationFile}`, closeOffset)?.uri ?? "", /sqlite3\.h$/);
  const nullOnlyOffset = declarationSource.indexOf("pzTail: null") + "pzTail: ".length + 1;
  assert.match(hover(declarationSource, declarationFile, nullOnlyOffset)?.contents.value ?? "", /only the native null pointer is exposed/);
  const textViewOffset = declarationSource.indexOf("view cstring") + 2;
  assert.match(hover(declarationSource, declarationFile, textViewOffset)?.contents.value ?? "", /borrowed native text tied to the input owner/);
  const fixedKeywordOffset = declarationSource.indexOf("fixed SQLITE_TRANSIENT") + 1;
  assert.match(hover(declarationSource, declarationFile, fixedKeywordOffset)?.contents.value ?? "", /compiler supplies this header-defined value/);
  const fixedValueOffset = declarationSource.indexOf("SQLITE_TRANSIENT") + 2;
  assert.match(hover(declarationSource, declarationFile, fixedValueOffset)?.contents.value ?? "", /fixed SQLITE_TRANSIENT/);
  const bindTextOffset = declarationSource.indexOf("sqlite3_bind_text") + 2;
  const bindTextHover = hover(declarationSource, declarationFile, bindTextOffset)?.contents.value ?? "";
  assert.match(bindTextHover, /sqlite3_bind_text\(argument1: sqlite3_stmt \*, argument2: i32, argument3: cstring, argument4: i32\): void throws i32/);
  assert.doesNotMatch(bindTextHover, /argument5:/);
  const partialFixed = declarationSource.replace("fixed SQLITE_TRANSIENT", "fix");
  const partialFixedOffset = partialFixed.indexOf("fix", partialFixed.indexOf("xDel")) + 3;
  assert.equal(
    completions(partialFixed, declarationFile, partialFixedOffset).some((item) => item.label === "fixed"),
    true,
  );
  const exposedFixedArgument = persistenceSource.replace(
    "sqlite.sqlite3_bind_text(statement, 2, note.title, -1)",
    "sqlite.sqlite3_bind_text(statement, 2, note.title, -1, null)",
  );
  assert.match(
    diagnostics(exposedFixedArgument, persistence)[0]?.message ?? "",
    /expects 4 argument\(s\), found 5/,
  );

  const availabilityDirectory = mkdtempSync("/tmp/z-appkit-availability-");
  const availabilityFile = resolve(availabilityDirectory, "main.zs");
  const availabilitySource = `
    import AppKit from "AppKit/AppKit.h";
    function main(): i32 {
      const app = AppKit.NSApplication.sharedApplication;
      app.activate();
      return 0;
    }
  `;
  writeFileSync(availabilityFile, availabilitySource);
  writeFileSync(resolve(availabilityDirectory, "z.json"), JSON.stringify({
    target: { platform: "macos", minimumVersion: "13.0" },
  }));
  const availabilityDiagnostic = diagnostics(availabilitySource, availabilityFile)[0];
  assert.equal(availabilityDiagnostic?.code, "Z0802");
  assert.match(availabilityDiagnostic?.message ?? "", /requires macOS 14\.0, but the deployment target is macOS 13\.0/);
}, 20_000);

test("runs an application-shaped document workspace across ownership and interop features", () => {
  const example = resolve(projectRoot, "examples/applications/document-workspace/main.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /#include .*document-lease\.hpp/);
  assert.match(artifact.source, /std::construct_at\(&storage\[index\], std::move\(self->data\[index\]\)\)/);
  assert.match(artifact.source, /struct Z_[A-Za-z0-9_]*DocumentOpenResult/);
  assert.match(artifact.source, /Z_[A-Za-z0-9_]*WorkspaceError_deinit/);
  assert.match(artifact.source, /Z_[A-Za-z0-9_]*DocumentSession_documentId\(document\)/);
  assert.deepEqual(diagnostics(source, example), []);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^workspace registered=3, saved=3, found=42, save count=1, rejected=100, empty save=200, native moves=[1-9][0-9]*, live=0\n$/,
  );
});

test("runs the project index across borrowed lookups, owned snapshots, and collection modules", () => {
  const smoke = resolve(projectRoot, "examples/applications/project-index/smoke.zs");
  const source = readFileSync(smoke, "utf8");
  const generated = compileToC(source, smoke);
  assert.deepEqual(diagnostics(source, smoke), []);

  const mapRuntime = generated.indexOf("Z_Map_");
  const projectUpsert = generated.lastIndexOf("ProjectIndex_upsert(");
  assert.notEqual(mapRuntime, -1);
  assert.notEqual(projectUpsert, -1);
  assert.ok(mapRuntime < projectUpsert, "Map runtime helpers must precede imported ProjectIndex method bodies");
  assert.match(generated, /z_copy_[A-Za-z0-9_]*FileRecord/);
  assert.match(generated, /z_string_copy/);

  const smokeResult = spawnSync(process.execPath, [cli, "run", smoke], { encoding: "utf8" });
  assert.equal(smokeResult.status, 0, smokeResult.stderr);

  const benchmark = resolve(projectRoot, "examples/applications/project-index/benchmark.zs");
  const benchmarkResult = spawnSync(process.execPath, [cli, "run", benchmark], { encoding: "utf8" });
  assert.equal(benchmarkResult.status, 0, benchmarkResult.stderr);

  const application = resolve(projectRoot, "examples/applications/project-index/main.zs");
  const lexer = resolve(projectRoot, "compiler/frontend/lexer.zs");
  const parser = resolve(projectRoot, "compiler/frontend/parser.zs");
  const result = spawnSync(process.execPath, [cli, "run", application, "--", lexer, parser], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /recorded .*lexer\.zs at revision 1/);
  assert.match(result.stdout, /recorded .*parser\.zs at revision 1/);
  assert.match(result.stdout, /revision 1, files 2, dirty=true/);
});

test("compares scoped document borrows with independently owned snapshots", () => {
  const example = resolve(projectRoot, "examples/interop/objc/desktop-ownership/ownership-views.zs");
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
  assert.equal(result.stdout, "scoped 2: Interop Notes\nview 2: Interop Notes\noptional view 2: Interop Notes\nsnapshot 2: Interop Notes\n");

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

test("keeps ownership boundary alternatives explicit across async suspension", () => {
  const example = resolve(projectRoot, "examples/interop/objc/desktop-ownership/ownership-boundaries.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /const Z_[A-Za-z0-9_]*Document \* value_projected;/);
  assert.match(generated, /_z_async_inline_environment_/);
  assert.match(generated, /_z_async_inline_function_/);
  assert.match(generated, /z_string_copy/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "value view=1, class callback=2, delayed snapshot=2\n");

  const parameterView = `
    struct Item { value: i32; }
    struct Store { item: Item; }
    function current(in store: Store): view Item { return store.item; }
    function main(): i32 { return 0; }
  `;
  const parameterDiagnostic = diagnostics(parameterView, "parameter-view-return.zs")[0];
  assert.equal(parameterDiagnostic.code, "Z0206");
  assert.match(parameterDiagnostic.message, /view returns require a borrowed instance method receiver/);

  const viewAcrossAwait = `
    struct Item { value: i32; }
    struct Store {
      item: Item;
      function current(): view Item { return this.item; }
    }
    async function ready(): i32 { return 1; }
    async function inspect(): i32 {
      const store = Store({ item: Item({ value: 42 }) });
      const item = store.current();
      const copied = item.value;
      const waited = await ready();
      return copied + waited;
    }
    async function main(): i32 { return await inspect() - 43; }
  `;
  const viewGenerated = compileToC(viewAcrossAwait, "view-before-await.zs");
  assert.match(viewGenerated, /const Z_Item \* value_item;/);

  const viewDirectory = mkdtempSync("/tmp/z-view-before-await-");
  const viewFile = resolve(viewDirectory, "main.zs");
  writeFileSync(viewFile, viewAcrossAwait);
  const viewResult = spawnSync(process.execPath, [cli, "run", viewFile], { encoding: "utf8" });
  assert.equal(viewResult.status, 0, viewResult.stderr);

  const viewAfterAwait = viewAcrossAwait.replace(
    "return copied + waited;",
    "return item.value + copied + waited;",
  );
  const suspensionDiagnostic = diagnostics(viewAfterAwait, "view-after-await.zs")[0];
  assert.equal(suspensionDiagnostic.code, "Z0704");
  assert.match(suspensionDiagnostic.message, /cannot await while borrowed storage "item" is live/);

  const closureInsideAsync = `
    struct Item { value: i32; }
    function inspect(in operation: () => i32): i32 { return operation(); }
    function consume(operation: () => i32): i32 { return operation(); }
    function update(in operation: () => void): void { operation(); }
    async function ready(): i32 { return 1; }
    async function main(): i32 {
      let observed = 40;
      update(() => { observed = observed + 2; });
      const item = Item({ value: 42 });
      const before = inspect(() => item.value);
      const waited = await ready();
      return inspect(() => item.value) + before + observed + waited - 127;
    }
  `;
  const closureGenerated = compileToC(closureInsideAsync, "async-inline-closure.zs");
  assert.match(closureGenerated, /Z_ClosureEnv_/);
  assert.match(closureGenerated, /_z_async_inline_environment_/);
  assert.match(closureGenerated, /_z_async_inline_function_/);

  const closureDirectory = mkdtempSync("/tmp/z-async-inline-closure-");
  const closureFile = resolve(closureDirectory, "main.zs");
  writeFileSync(closureFile, closureInsideAsync);
  const closureResult = spawnSync(process.execPath, [cli, "run", closureFile], { encoding: "utf8" });
  assert.equal(closureResult.status, 0, closureResult.stderr);

  const ownedInsideAsync = closureInsideAsync.replace(
    "const before = inspect(() => item.value);",
    "const before = consume(move () => item.value);",
  );
  assert.throws(() => compileToC(ownedInsideAsync, "async-owned-inline-closure.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /owned or escaping inline closure is not executable/);
    return true;
  });
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
  assert.equal(diagnostics(liveMutation, "view-live-mutation.zs")[0].code, "Z0205");

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
  assert.equal(diagnostics(mutationAfterBranch, "view-live-after-branch.zs")[0].code, "Z0205");

  const capture = `${base}
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      const read = () => item.value;
      return read();
    }
  `;
  const captureDiagnostic = diagnostics(capture, "view-capture.zs")[0];
  assert.equal(captureDiagnostic.code, "Z0206");
  assert.match(captureDiagnostic.message, /proven nonescaping closure/);

  const inlineCapture = `${base}
    function inspect(in operation: () => i32): i32 { return operation(); }
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      const observed = inspect(() => item.value);
      store.append(Item({ value: 2 }));
      return observed - 1;
    }
  `;
  assert.equal(diagnostics(inlineCapture, "view-inline-capture.zs").length, 0);
  const inlineDirectory = mkdtempSync("/tmp/z-view-inline-capture-");
  const inlineFile = resolve(inlineDirectory, "main.zs");
  writeFileSync(inlineFile, inlineCapture);
  const inlineResult = spawnSync(process.execPath, [cli, "run", inlineFile], { encoding: "utf8" });
  assert.equal(inlineResult.status, 0, inlineResult.stderr);
  const capturedViewOffset = inlineCapture.indexOf("item.value") + 1;
  assert.match(
    hover(inlineCapture, "view-inline-capture.zs", capturedViewOffset)?.contents.value ?? "",
    /item: view Item/,
  );

  const escapingCapture = inlineCapture.replace(
    "function inspect(in operation: () => i32)",
    "function inspect(operation: () => i32)",
  );
  const escapingCaptureDiagnostic = diagnostics(escapingCapture, "view-escaping-capture.zs")[0];
  assert.equal(escapingCaptureDiagnostic.code, "Z0212");
  assert.match(escapingCaptureDiagnostic.message, /borrowed capturing closure cannot become a function value/);

  const forwarded = `${base}
    function inspect(in item: Item): i32 { return item.value; }
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ value: 1 }));
      const item = store.at(0);
      return inspect(item);
    }
  `;
  assert.equal(diagnostics(forwarded, "view-forward.zs").length, 0);
  assert.match(compileToC(forwarded, "view-forward.zs"), /return inspect\(item\);/);

  const ownedForward = forwarded.replace("function inspect(in item: Item)", "function inspect(item: Item)");
  const forwardDiagnostic = diagnostics(ownedForward, "view-owned-forward.zs")[0];
  assert.equal(forwardDiagnostic.code, "Z0206");
  assert.match(forwardDiagnostic.message, /only enter a synchronous in parameter/);

  const classOwner = `
    struct Item { value: i32; }
    class Store {
      item: Item;
      function current(): view Item { return this.item; }
    }
    function main(): i32 { return 0; }
  `;
  const classDiagnostic = diagnostics(classOwner, "view-class-owner.zs")[0];
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
  const projectionDiagnostic = diagnostics(wrongProjection, "view-wrong-projection.zs")[0];
  assert.equal(projectionDiagnostic.code, "Z0206");
  assert.match(projectionDiagnostic.message, /derived directly from this/);
});

test("allocates stable owner-tied views in Arena and cleans them newest-first", () => {
  const example = resolve(projectRoot, "examples/language/ownership/arena.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /typedef struct Z_Arena/);
  assert.match(generated, /z_arena_create_ParsedRecord/);
  assert.match(generated, /z_arena_register_cleanup\(arena, stored, z_arena_create_ParsedRecord_cleanup\)/);
  assert.match(generated, /z_arena_reset\(&\(scratch\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
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

  const liveReset = source.replace(
    "scratch.reset();",
    "scratch.reset();\n  const invalid = describe(body);",
  );
  const resetDiagnostic = diagnostics(liveReset, "arena-live-reset.zs")[0];
  assert.equal(resetDiagnostic.code, "Z0205");
  assert.match(resetDiagnostic.message, /cannot reset .*scratch.* while view .*body.* is live/);

  const immutable = source.replace(
    "let scratch = Arena({ initialCapacity: 65536 });",
    "const scratch = Arena({ initialCapacity: 65536 });",
  );
  const immutableDiagnostic = diagnostics(immutable, "arena-const.zs")[0];
  assert.equal(immutableDiagnostic.code, "Z0205");
  assert.match(immutableDiagnostic.message, /requires addressable let storage/);

  const createOffset = source.indexOf("create(ParsedRecord") + 1;
  assert.match(hover(source, example, createOffset)?.contents.value ?? "", /create<T>\(value: T\): view T/);
  const memberOffset = source.indexOf("scratch.create") + "scratch.".length;
  assert.ok(completions(source, example, memberOffset).some((item) => item.label === "create"));
  assert.ok(completions(source, example, memberOffset).some((item) => item.label === "reset"));

  const importSource = source.replace("{ Arena }", "{ Ar }");
  const importOffset = importSource.indexOf("{ Ar }") + 4;
  assert.ok(completions(importSource, example, importOffset).some((item) => item.label === "Arena"));
  const arenaOffset = source.indexOf("Arena({") + 1;
  assert.match(hover(source, example, arenaOffset)?.contents.value ?? "", /move-only .*region storage/);
  assert.match(generated, /z_arena_new\(\(uintptr_t\)\(65536ULL\)\)/);

  const optionCompletionSource = source.replace("initialCapacity", "init");
  const optionCompletionOffset = optionCompletionSource.indexOf("init:") + "init".length;
  assert.ok(
    completions(optionCompletionSource, example, optionCompletionOffset)
      .some((item) => item.label === "initialCapacity"),
  );

  const invalidOptions = source.replace("initialCapacity: 65536", "capacity: 65536");
  assert.match(diagnostics(invalidOptions, "arena-options.zs")[0].message, /require exactly initialCapacity/);

  const liveMove = `
    import { Arena } from "std/memory";
    struct Item { value: i32; }
    function discard(arena: Arena): void { return; }
    function main(): i32 {
      let arena = Arena();
      const item = arena.create(Item({ value: 42 }));
      discard(arena);
      return item.value;
    }
  `;
  const moveDiagnostic = diagnostics(liveMove, "arena-live-move.zs")[0];
  assert.equal(moveDiagnostic.code, "Z0205");
  assert.match(moveDiagnostic.message, /cannot move .*arena.* while view .*item.* is live/);

  const directClass = `
    import { Arena } from "std/memory";
    class Session { id: i32; }
    function main(): i32 {
      let arena = Arena();
      const session = arena.create(new Session({ id: 42 }));
      return 0;
    }
  `;
  assert.match(
    diagnostics(directClass, "arena-class-root.zs")[0].message,
    /does not directly root reference-identity objects/,
  );

  const asyncArena = `
    import { Arena } from "std/memory";
    struct Item { value: i32; }
    async function main(): i32 {
      let arena = Arena();
      const item = arena.create(Item({ value: 42 }));
      return item.value;
    }
  `;
  const asyncDiagnostic = diagnostics(asyncArena, "arena-async.zs")[0];
  assert.equal(asyncDiagnostic.code, "Z0704");
  assert.match(asyncDiagnostic.message, /cannot cross suspension/);

  const trivial = `
    import { Arena } from "std/memory";
    struct Point { x: i32; y: i32; }
    function inspect(in operation: () => i32): i32 { return operation(); }
    function main(): i32 {
      let arena = Arena();
      const point = arena.create(Point({ x: 20, y: 22 }));
      const observed = inspect(() => point.x + point.y);
      arena.reset();
      return observed - 42;
    }
  `;
  const trivialGenerated = compileToC(trivial, "arena-trivial.zs");
  assert.doesNotMatch(trivialGenerated, /z_arena_create_Point_cleanup/);
  assert.doesNotMatch(trivialGenerated, /z_arena_register_cleanup\(arena, stored/);
  const trivialDirectory = mkdtempSync("/tmp/z-arena-trivial-");
  const trivialFile = resolve(trivialDirectory, "main.zs");
  writeFileSync(trivialFile, trivial);
  const trivialResult = spawnSync(process.execPath, [cli, "run", trivialFile], { encoding: "utf8" });
  assert.equal(trivialResult.status, 0, trivialResult.stderr);

  const builtinViews = `
    import { Arena } from "std/memory";
    function main(): i32 {
      let arena = Arena();
      const word = arena.create("hello");
      const values = arena.create([20, 22]);
      let dynamic = Array<i32>();
      dynamic.push(40);
      dynamic.push(2);
      const stored = arena.create(dynamic);
      if (word.byteLength != 5) return 1;
      if (word.byteAt(1) != 101) return 2;
      if (stored.length != 2) return 3;
      return values[0] + values[1] + stored[0] + stored[1] - 84;
    }
  `;
  const builtinDirectory = mkdtempSync("/tmp/z-arena-builtins-");
  const builtinFile = resolve(builtinDirectory, "main.zs");
  writeFileSync(builtinFile, builtinViews);
  const builtinResult = spawnSync(process.execPath, [cli, "run", builtinFile], { encoding: "utf8" });
  assert.equal(builtinResult.status, 0, builtinResult.stderr);

  const arcDirectory = mkdtempSync("/tmp/z-arena-arc-");
  const arcFile = resolve(arcDirectory, "main.zs");
  writeFileSync(arcFile, `
    import console from "std/console";
    import { Arena } from "std/memory";
    class Session {
      id: i32;
      deinit { console.log(\`released session \${this.id}\`); }
    }
    struct SessionSlot { session: Session; }
    function main(): i32 {
      let arena = Arena();
      const slot = arena.create(SessionSlot({ session: new Session({ id: 7 }) }));
      console.log(\`session \${slot.session.id}\`);
      arena.reset();
      return 0;
    }
  `);
  const arcResult = spawnSync(process.execPath, [cli, "run", arcFile], { encoding: "utf8" });
  assert.equal(arcResult.status, 0, arcResult.stderr);
  assert.equal(arcResult.stdout, "session 7\nreleased session 7\n");

  const nativeExample = resolve(projectRoot, "examples/interop/cpp/cpp-arena.zs");
  const nativeSource = readFileSync(nativeExample, "utf8");
  const nativeGenerated = compileToC(nativeSource, nativeExample);
  assert.match(nativeGenerated, /std::construct_at\(stored, std::move\(value\)\)/);
  assert.match(nativeGenerated, /std::destroy_at\(stored\)/);
  const nativeResult = spawnSync(process.execPath, [cli, "run", nativeExample], { encoding: "utf8" });
  assert.equal(nativeResult.status, 0, nativeResult.stderr);
  assert.equal(nativeResult.stdout, "arena answer=42, live before=2, live after=0\n");

  const copyDirectory = mkdtempSync("/tmp/z-arena-copy-raii-");
  const copyFile = resolve(copyDirectory, "main.zs");
  const copyHeader = resolve(projectRoot, "tests/fixtures/foreign-values.hpp");
  writeFileSync(copyFile, `
    import console from "std/console";
    import { Arena } from "std/memory";
    import native from ${JSON.stringify(copyHeader)};
    function main(): i32 {
      let arena = Arena();
      const value = arena.create(native.zcpp.make_managed(42));
      const answer = value.value();
      const liveBeforeReset = native.zcpp.managed_live();
      arena.reset();
      const liveAfterReset = native.zcpp.managed_live();
      console.log(\`copy arena answer=\${answer}, live before=\${liveBeforeReset}, live after=\${liveAfterReset}\`);
      return answer - 42 + liveBeforeReset - 1 + liveAfterReset;
    }
  `);
  const copyGenerated = compileToC(readFileSync(copyFile, "utf8"), copyFile);
  assert.match(copyGenerated, /std::construct_at\(stored, value\)/);
  assert.match(copyGenerated, /std::destroy_at\(stored\)/);
  const copyResult = spawnSync(process.execPath, [cli, "run", copyFile], { encoding: "utf8" });
  assert.equal(copyResult.status, 0, copyResult.stderr);
  assert.equal(copyResult.stdout, "copy arena answer=42, live before=1, live after=0\n");
});

test("returns zero-overhead optional receiver-tied views through Option and match", () => {
  const source = `
    struct Item { id: i32; value: i32; }
    struct Store {
      items: Array<Item>;
      function append(inout this, item: Item): void { this.items.push(item); }
      function find(id: i32): Option<view Item> {
        let index: usize = 0;
        while (index < this.items.length) {
          if (this.items[index].id == id) return Option.some(this.items[index]);
          index = index + 1;
        }
        return Option.none;
      }
    }
    function main(): i32 {
      let store = Store({ items: Array<Item>() });
      store.append(Item({ id: 1, value: 20 }));
      store.append(Item({ id: 2, value: 22 }));
      const found = store.find(2);
      const observed = match (in found) {
        some(item) => item.value;
        none => -1;
      };
      store.append(Item({ id: 3, value: 24 }));
      return observed - 22;
    }
  `;
  assert.deepEqual(diagnostics(source, "optional-view.zs"), []);
  const generated = compileToC(source, "optional-view.zs");
  assert.match(generated, /typedef const Z_Item \*Z_Option___z_view_3a_Item;/);
  assert.match(generated, /Z_Option___z_view_3a_Item Z_Store_find\(const Z_Store \*self, int32_t id\)/);
  assert.match(generated, /return &\(\(\(self->items\)\.data\[/);
  assert.match(generated, /return NULL;/);
  assert.doesNotMatch(generated, /struct Z___z_Option___z_view/);

  const compilation = spawnSync("clang", ["-x", "c", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], {
    input: generated,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);

  const liveMutation = source.replace(
    "some(item) => item.value;",
    "some(item) => { store.append(Item({ id: 3, value: 24 })); select item.value; }",
  );
  const mutationDiagnostic = diagnostics(liveMutation, "optional-view-live-mutation.zs")[0];
  assert.equal(mutationDiagnostic.code, "Z0205");
  assert.match(mutationDiagnostic.message, /cannot mutate .*store.* while view .*item.* is live/);

  const mutationAfterUse = source.replace(
    "some(item) => item.value;",
    "some(item) => { const value = item.value; store.append(Item({ id: 3, value: 24 })); select value; }",
  );
  assert.deepEqual(diagnostics(mutationAfterUse, "optional-view-last-use.zs"), []);

  const consumingMatch = source.replace("match (in found)", "match (found)");
  const matchDiagnostic = diagnostics(consumingMatch, "optional-view-consuming-match.zs")[0];
  assert.equal(matchDiagnostic.code, "Z0206");
  assert.match(matchDiagnostic.message, /match \(in value\)/);

  const storedView = `
    struct Item { value: i32; }
    struct Invalid { found: Option<view Item>; }
    function main(): i32 { return 0; }
  `;
  const storageDiagnostic = diagnostics(storedView, "optional-view-storage.zs")[0];
  assert.equal(storageDiagnostic.code, "Z0206");
  assert.match(storageDiagnostic.message, /cannot be stored in fields/);

  const bindingOffset = source.indexOf("found =") + 1;
  assert.match(hover(source, "optional-view.zs", bindingOffset)?.contents.value ?? "", /found: Option<view Item>.*view of store/);
  const payloadOffset = source.indexOf("some(item)") + "some(".length + 1;
  assert.match(hover(source, "optional-view.zs", payloadOffset)?.contents.value ?? "", /item: view Item/);
});

test("retains owned Z closure environments across Objective-C blocks", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-blocks.zs");
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
}, 10_000);

test("bridges owned Z closures to Objective-C target/action through an explicit connection", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/target-action.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.equal(artifact.language, "objective-c");
  assert.ok(artifact.frameworks.includes("Foundation"));
  assert.ok(artifact.frameworks.includes("AppKit"));
  assert.match(artifact.source, /@interface ZObjCConnection : NSObject/);
  assert.match(artifact.source, /Z_ActionState_retain\(state\)/);
  assert.doesNotMatch(artifact.source, /Z_ActionState_retain\(state\)\)->value/);
  assert.match(artifact.source, /ZObjCConnection \* const connection = z_objc_connect\(/);
  assert.match(artifact.source, /\[_z_control setTarget:self\]/);
  assert.match(artifact.source, /\[_z_control setAction:@selector\(z_invoke:\)\]/);
  assert.match(artifact.source, /if \(\[_z_control target\] == self\)/);
  assert.match(artifact.source, /\[_z_control setTarget:nil\]/);
  assert.match(artifact.source, /Z_Function_[a-f0-9]+_release\(_z_operation\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "button action value=42\n");

  const borrowed = source.replace("objc.connect(button, move ()", "objc.connect(button, ()");
  assert.match(
    diagnostics(borrowed, example)[0]?.message ?? "",
    /borrowed capturing closure cannot become a function value/,
  );

  const connectionCompletionSource = source.replace("objc.connect", "objc.con");
  const connectionCompletionOffset = connectionCompletionSource.indexOf("objc.con") + "objc.con".length;
  assert.ok(completions(connectionCompletionSource, example, connectionCompletionOffset).some((item) => item.label === "connect"));
  const connectOffset = source.indexOf("objc.connect") + "objc.".length + 2;
  assert.match(hover(source, example, connectOffset)?.contents.value ?? "", /objc\.Connection/);
  const connectionOffset = source.indexOf("connection =") + 2;
  assert.match(hover(source, example, connectionOffset)?.contents.value ?? "", /connection: objc\.Connection/);

  const discarded = source.replace("const connection = ", "");
  assert.match(diagnostics(discarded, example)[0]?.message ?? "", /objc\.Connection must be bound/);

  const propertySource = source.replace("  app.finishLaunching();", "  const currentTarget = button.target;\n  app.finishLaunching();");
  const targetOffset = propertySource.indexOf("button.target") + "button.".length + 2;
  assert.match(hover(propertySource, example, targetOffset)?.contents.value ?? "", /weak target: /);
}, 10_000);

test("generates safe Objective-C protocol adapters with protocol-aware editor scaffolds", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/protocol-conformance.zs");
  const source = readFileSync(example, "utf8");
  const analysis = analyzeSource(source, example);
  const appKit = analysis.foreignModules.get("AppKit");
  assert.ok(appKit?.protocols.has("NSTableViewDataSource"));
  assert.ok(appKit?.protocols.has("NSTableViewDelegate"));

  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /@interface ZObjCProtocolAdapter_TableController : NSObject <NSTableViewDataSource, NSTableViewDelegate>/);
  assert.match(artifact.source, /- \(NSInteger\)numberOfRowsInTableView:\(NSTableView \*\)tableView/);
  assert.match(artifact.source, /Z_TableController_rowCount\(_z_owner, tableView\)/);
  assert.match(artifact.source, /@interface ZObjCBinding : NSObject/);
  assert.match(artifact.source, /\[object setDataSource:_z_adapter_0\]/);
  assert.match(artifact.source, /\[object setDelegate:_z_adapter_0\]/);
  assert.match(artifact.source, /Z_TableController_retain\(owner\)/);
  assert.match(artifact.source, /Z_TableController_release\(_z_owner\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Binding@0x[0-9a-f]+\n$/);

  const completionSource = `
    import AppKit from "AppKit/AppKit.h";
    class Controller implements AppKit.NSTableViewDataSource {
      number
    }
    function main(): i32 { return 0; }
  `;
  const completionOffset = completionSource.indexOf("number") + "number".length;
  const scaffold = completions(completionSource, example, completionOffset)
    .find((item) => item.label === "numberOfRowsInTableView");
  assert.match(scaffold?.detail ?? "", /optional numberOfRowsInTableView:/);
  assert.match(scaffold?.insertText ?? "", /in tableView: AppKit\.NSTableView/);
  assert.match(scaffold?.insertText ?? "", /as "numberOfRowsInTableView:"/);

  const methodOffset = source.indexOf("function rowCount") + "function ".length + 2;
  assert.match(hover(source, example, methodOffset)?.contents.value ?? "", /Objective-C optional protocol selector.*numberOfRowsInTableView:/s);
  const protocolOffset = source.indexOf("NSTableViewDataSource") + 2;
  assert.match(hover(source, example, protocolOffset)?.contents.value ?? "", /Objective-C protocol NSTableViewDataSource/);

  const wrongSelector = source.replace(
    'as "numberOfRowsInTableView:"',
    'as "notADataSourceSelector:"',
  );
  assert.match(diagnostics(wrongSelector, example)[0]?.message ?? "", /not declared by an implemented Objective-C protocol/);
}, 15_000);

test("registers persistent Objective-C event callbacks with explicit token cleanup", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-notifications.zs");
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

  const appKitExample = resolve(projectRoot, "examples/interop/objc/appkit-events.zs");
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
  const example = resolve(projectRoot, "tests/fixtures/objc-strings.zs");
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
  const zSource = resolve(directory, "swift-interop.zs");
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
  const example = resolve(projectRoot, "examples/interop/swift/swift-interop/main.zs");
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
  const generatedLibrary = artifact.nativeLibraries[0];
  const libraryMtime = statSync(generatedLibrary).mtimeMs;
  utimesSync(generatedHeader, new Date(0), new Date(0));
  compileToNative(source, example);
  assert.equal(statSync(generatedLibrary).mtimeMs, libraryMtime);
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "swift=42, value=42\n");
  assert.equal(statSync(generatedHeader).mtimeMs, 0);
  const addOffset = source.indexOf("add(1)") + 1;
  assert.match(hover(source, example, addOffset)?.contents.value ?? "", /add\(amount: i32\): i32/);

  const invalidDirectory = mkdtempSync("/tmp/z-invalid-project-");
  const invalidSource = resolve(invalidDirectory, "main.zs");
  writeFileSync(invalidSource, "function main(): i32 { return 0; }");
  writeFileSync(resolve(invalidDirectory, "z.json"), JSON.stringify({
    target: { entry: "main.zs", swift: { module: "not-valid!", sources: ["Counter.swift"] } },
  }));
  assert.throws(
    () => compileToNative(readFileSync(invalidSource, "utf8"), invalidSource),
    /target\.swift\.module must be a valid module name/,
  );
});

test("projects an exactly-once Swift callback into an awaitable Z task", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/swift/swift-task-scope/main.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /\[ZSwiftBackgroundWorker calculate:frame->value_value completion:\^void\(int32_t callback_value_0\)/);
  assert.match(
    artifact.source,
    /\[ZSwiftBackgroundWorker calculateChecked:frame->value_value shouldFail:frame->value_shouldFail completion:\^void\(int32_t callback_value_0, NSError \* callback_value_1\)/,
  );
  assert.match(artifact.source, /if \(callback_value_1 != nil\)/);
  assert.match(artifact.source, /frame->error = callback_value_1/);
  assert.match(artifact.source, /z_async_begin_external_completion\(task\)/);
  assert.match(artifact.source, /z_async_report_external_completion\(&frame->task\)/);
  assert.match(artifact.source, /active_external_callbacks/);
  assert.doesNotMatch(artifact.source, /\[ZSwiftBackgroundWorker waitForCompletion\]/);

  const context = analyzeSource(source, example);
  const calculate = context.foreignModules.get("Swift")
    ?.interfaces.get("ZSwiftBackgroundWorker")
    ?.methods.find((method) => !method.instance && method.selector === "calculate:completion:");
  assert.equal(calculate?.parameters[1]?.type.kind, "block");
  if (calculate?.parameters[1]?.type.kind === "block") {
    assert.equal(calculate.parameters[1].type.escaping, true);
    assert.equal(calculate.parameters[1].type.thread, "any");
  }
  assert.equal(calculate?.asyncCallbackParameter, 1);
  assert.equal(calculate?.asyncResultParameter, 0);
  assert.equal(calculate?.asyncErrorParameter, null);

  const calculateChecked = context.foreignModules.get("Swift")
    ?.interfaces.get("ZSwiftBackgroundWorker")
    ?.methods.find((method) => !method.instance && method.selector === "calculateChecked:shouldFail:completion:");
  assert.equal(calculateChecked?.asyncCallbackParameter, 2);
  assert.equal(calculateChecked?.asyncResultParameter, 0);
  assert.equal(calculateChecked?.asyncErrorParameter, 1);

  const naked = source.replace(
    "const value = await Swift.ZSwiftBackgroundWorker.calculate(40);",
    "const value = Swift.ZSwiftBackgroundWorker.calculate(40);",
  );
  const nakedDiagnostic = diagnostics(naked, example)[0];
  assert.equal(nakedDiagnostic.code, "Z0702");
  assert.match(nakedDiagnostic.message, /requires `await` or `task`/);

  const uncheckedThrow = `
    import Swift from "ZSwiftTaskScope-Swift.h";
    async function main(): i32 {
      return await Swift.ZSwiftBackgroundWorker.calculateChecked(40, shouldFail: false);
    }
  `;
  const uncheckedThrowDiagnostic = diagnostics(uncheckedThrow, example)[0];
  assert.equal(uncheckedThrowDiagnostic.code, "Z0701");
  assert.match(uncheckedThrowDiagnostic.message, /requires `attempt` or `try`/);

  const propagatedThrow = `
    import Swift from "ZSwiftTaskScope-Swift.h";
    async function checked(): i32 throws Swift.NSError {
      return try await Swift.ZSwiftBackgroundWorker.calculateChecked(40, shouldFail: false);
    }
  `;
  assert.deepEqual(diagnostics(propagatedThrow, example), []);

  const rawSource = `
    import Swift from "ZSwiftTaskScope-Swift.h";
    function main(): i32 {
      Swift.ZSwiftBackgroundWorker.calculate(
        40,
        completion: move (value) => { return; }
      );
      Swift.ZSwiftBackgroundWorker.waitForCompletion();
      return 0;
    }
  `;
  assert.deepEqual(diagnostics(rawSource, example), []);

  const invalidDirectory = mkdtempSync("/tmp/z-swift-block-contract-");
  const generatedHeader = resolve(artifact.includeDirectories[0], "ZSwiftTaskScope-Swift.h");
  writeFileSync(
    resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h"),
    readFileSync(generatedHeader, "utf8"),
  );
  writeFileSync(resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h.zd"), `
    declare module "ZSwiftTaskScope-Swift.h" {
      export function ZSwiftBackgroundWorker.calculate(
        value: _,
        in completion: _
      ): _ {
        callback completion {
          thread any;
        }
      }
    }
  `);
  const invalidFile = resolve(invalidDirectory, "main.zs");
  const invalidSource = `
    import Swift from "ZSwiftTaskScope-Swift.h";
    function main(): i32 { return 0; }
  `;
  const invalidContract = diagnostics(invalidSource, invalidFile)[0];
  assert.equal(invalidContract.code, "Z0801");
  assert.match(invalidContract.message, /escaping Objective-C block "completion" requires move/);

  writeFileSync(resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h.zd"), `
    declare module "ZSwiftTaskScope-Swift.h" {
      export function ZSwiftBackgroundWorker.calculateChecked(
        value: _,
        shouldFail: _,
        move completion: _
      ): _ {
        callback completion {
          thread any;
        }
        async completion(value) {
          throw value;
        }
      }
    }
  `);
  const bindingCountContract = diagnostics(invalidSource, invalidFile)[0];
  assert.equal(bindingCountContract.code, "Z0801");
  assert.match(bindingCountContract.message, /declares 1 binding.*native block receives 2/);

  writeFileSync(resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h.zd"), `
    declare module "ZSwiftTaskScope-Swift.h" {
      export function ZSwiftBackgroundWorker.calculateChecked(
        value: _,
        shouldFail: _,
        move completion: _
      ): _ {
        callback completion {
          thread any;
        }
        async completion(value, error) {
          return error;
          throw value;
        }
      }
    }
  `);
  const scalarErrorContract = diagnostics(invalidSource, invalidFile)[0];
  assert.equal(scalarErrorContract.code, "Z0801");
  assert.match(scalarErrorContract.message, /requires a nullable Objective-C error reference/);

  const declarationFile = resolve(
    projectRoot,
    "examples/interop/swift/swift-task-scope/ZSwiftTaskScope-Swift.h.zd",
  );
  const declarationSource = readFileSync(declarationFile, "utf8");
  const methodHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("ZSwiftBackgroundWorker.calculate") + 2,
  )?.contents.value ?? "";
  assert.match(methodHover, /async calculate\(value: i32\): i32/);
  assert.match(methodHover, /calculate\(value: i32, completion: \(argument1: i32\) => void\): void/);
  assert.match(
    definition(
      declarationSource,
      `file://${declarationFile}`,
      declarationSource.indexOf("ZSwiftBackgroundWorker.calculate") + "ZSwiftBackgroundWorker.".length + 2,
    )?.uri ?? "",
    /ZSwiftTaskScope-Swift\.h$/,
  );
  const callbackHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("callback completion") + "callback ".length + 2,
  )?.contents.value ?? "";
  assert.match(callbackHover, /move completion: \(argument1: i32\) => void/);
  assert.match(callbackHover, /owned by the Objective-C block under ARC/);
  const threadHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("any;") + 1,
  )?.contents.value ?? "";
  assert.match(threadHover, /arbitrary threads/);

  const callbackCompletionSource = declarationSource.replace("callback completion {", "callback comp");
  const callbackCompletionOffset = callbackCompletionSource.indexOf("callback comp") + "callback comp".length;
  assert.equal(
    completions(callbackCompletionSource, declarationFile, callbackCompletionOffset)
      .find((item) => item.label === "completion")?.kind,
    6,
  );
  const asyncHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("async completion") + 1,
  )?.contents.value ?? "";
  assert.match(asyncHover, /exactly-once terminal callback synthesized as an awaitable overload/);
  const asyncCompletionSource = declarationSource.replace("async completion;", "async comp");
  const asyncCompletionOffset = asyncCompletionSource.indexOf("async comp") + "async comp".length;
  assert.equal(
    completions(asyncCompletionSource, declarationFile, asyncCompletionOffset)
      .find((item) => item.label === "completion")?.kind,
    6,
  );

  const sourceHover = hover(
    source,
    example,
    source.indexOf("calculate(40)") + 2,
  )?.contents.value ?? "";
  assert.match(sourceHover, /async calculate\(value: i32\): i32/);
  const checkedSourceHover = hover(
    source,
    example,
    source.indexOf("calculateChecked") + 2,
  )?.contents.value ?? "";
  assert.match(checkedSourceHover, /async calculateChecked\(value: i32, shouldFail: boolean\): i32 throws Swift\.NSError/);
  const shouldFailOffset = source.indexOf("shouldFail: false") + 2;
  assert.match(
    hover(source, example, shouldFailOffset)?.contents.value ?? "",
    /shouldFail: boolean.*Objective-C selector calculateChecked:shouldFail:completion:/,
  );

  const sourceTokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const shouldFailPosition = positionForOffset(source, source.indexOf("shouldFail: false"));
  assert.ok(sourceTokens.some((token) => (
    token.line === shouldFailPosition.line
    && token.character === shouldFailPosition.character
    && token.type === semanticTokenTypes.indexOf("property")
  )));
  const labelDeclarationOffset = source.indexOf("label =");
  const labelUseOffset = source.indexOf("label.sizeToFit");
  assert.match(hover(source, example, labelUseOffset + 2)?.contents.value ?? "", /label: AppKit\.NSTextField/);
  for (const [offset, modifiers] of [[labelDeclarationOffset, 3], [labelUseOffset, 2]] as const) {
    const position = positionForOffset(source, offset);
    const token = sourceTokens.find((candidate) => (
      candidate.line === position.line
      && candidate.character === position.character
      && candidate.type === semanticTokenTypes.indexOf("variable")
    ));
    assert.equal(token?.modifiers, modifiers);
  }

  const checkedDeclarationHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("async completion(value") + "async completion(".length + 2,
  )?.contents.value ?? "";
  assert.match(checkedDeclarationHover, /async completion\(value, error\): i32 throws NSError/);

  const partialThrowBinding = declarationSource.replace("throw error;", "throw er");
  const partialThrowOffset = partialThrowBinding.indexOf("throw er") + "throw er".length;
  assert.equal(
    completions(partialThrowBinding, declarationFile, partialThrowOffset)
      .find((item) => item.label === "error")?.kind,
    6,
  );

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "7\n42\n");
}, 60_000);

test("imports and owns a Swift value through its generated C++ compatibility header", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/swift/swift-value-interop/main.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /#include <ZSwiftOwned-Swift\.hpp>/);
  assert.match(artifact.source, /struct Z_CounterOwner \{\s*ZSwiftOwned::OwnedCounter counter;/);
  assert.match(artifact.source, /const ZSwiftOwned::OwnedCounter first = ZSwiftOwned::OwnedCounter::init\(40\)/);
  assert.match(artifact.source, /const ZSwiftOwned::OwnedCounter copied = first/);
  assert.match(artifact.source, /const Z_CounterOwner owner = .*\.counter = copied/);
  assert.match(artifact.source, /const Z_CounterOwner ownerCopy = owner/);
  assert.match(artifact.source, /ZSwiftOwned::roundTrip\(\(ownerCopy\)\.counter\)/);
  assert.match(artifact.source, /changed\.setValue\(42\)/);
  assert.match(artifact.source, /first\.getValue\(\)/);
  assert.match(artifact.source, /\(owner\)\.counter\.getValue\(\)/);
  assert.match(artifact.source, /changed\.getValue\(\)/);
  assert.match(artifact.source, /static .*Z_String z_string_from_swift\(const swift::String& value\)/);
  assert.match(artifact.source, /const std::string bytes = static_cast<std::string>\(value\)/);
  assert.match(artifact.source, /bytes\.data\(\), \(uintptr_t\)bytes\.size\(\)/);
  assert.match(artifact.source, /z_string_from_swift\(ZSwiftOwned::describeOwnedCounter\(changed\)\)/);
  assert.match(artifact.source, /z_string_from_swift\(ZSwiftOwned::embeddedNullString\(\)\)/);
  assert.deepEqual(artifact.nativeLinkerArguments.slice(-1), ["-lswiftCore"]);
  assert.deepEqual(diagnostics(source, example), []);
  const context = analyzeSource(source, example);
  const counter = context.foreignModules.get("Swift")?.namedTypes.get("OwnedCounter");
  assert.equal(counter?.kind, "value");
  if (counter?.kind === "value") {
    assert.deepEqual(counter.lifecycle, { copy: true, move: false, deinit: true });
    assert.equal(counter.staticMethods.find((method) => method.name === "init")?.overloads.length, 1);
    assert.equal(counter.methods.find((method) => method.name === "getValue")?.overloads[0]?.receiverAccess, "in");
    assert.equal(counter.methods.find((method) => method.name === "setValue")?.overloads[0]?.receiverAccess, "inout");
  }
  assert.equal(
    context.foreignModules.get("Swift")?.functions.get("describeOwnedCounter")?.overloads[0]?.returnType.kind,
    "swiftString",
  );
  assert.equal(
    context.foreignModules.get("Swift")?.functions.get("countUtf8")?.overloads[0]?.parameters[0]?.type.kind,
    "unsupported",
  );
  const firstOffset = source.indexOf("first =") + 1;
  assert.match(hover(source, example, firstOffset)?.contents.value ?? "", /first: Swift\.OwnedCounter/);
  const initOffset = source.indexOf("init(40)") + 1;
  assert.match(hover(source, example, initOffset)?.contents.value ?? "", /init\(value: i32\): Swift\.OwnedCounter.*C\+\+ static/s);
  const getOffset = source.indexOf("getValue()") + 1;
  assert.match(hover(source, example, getOffset)?.contents.value ?? "", /getValue\(\): i32.*C\+\+ const borrow/s);
  const setOffset = source.indexOf("setValue(42)") + 1;
  assert.match(hover(source, example, setOffset)?.contents.value ?? "", /setValue\(inout this, value: i32\): void.*C\+\+ mutable borrow/s);
  const describeOffset = source.indexOf("describeOwnedCounter") + 1;
  assert.match(hover(source, example, describeOffset)?.contents.value ?? "", /describeOwnedCounter\(in counter: Swift\.OwnedCounter\): String.*swift::String/s);
  const descriptionOffset = source.indexOf("description: String") + 1;
  assert.match(hover(source, example, descriptionOffset)?.contents.value ?? "", /description: String/);

  const completionSource = source.replace("  changed.setValue(42);", "  changed.;\n  changed.setValue(42);");
  const completionOffset = completionSource.indexOf("changed.;") + "changed.".length;
  const methodItems = completions(completionSource, example, completionOffset);
  assert.match(methodItems.find((item) => item.label === "getValue")?.detail ?? "", /C\+\+ const borrow/);
  assert.match(methodItems.find((item) => item.label === "setValue")?.detail ?? "", /inout this.*C\+\+ mutable borrow/);

  const generatedHeader = resolve(artifact.includeDirectories[0], "ZSwiftOwned-Swift.hpp");
  assert.equal(existsSync(generatedHeader), true);
  for (const offset of [initOffset, getOffset, setOffset, describeOffset]) {
    assert.match(definition(source, `file://${example}`, offset)?.uri ?? "", /ZSwiftOwned-Swift\.hpp$/);
  }
  const inferredString = source.replace("const description: String", "const description");
  const inferredDiagnostic = diagnostics(inferredString, example).find((item) => item.message.includes("native Swift String"));
  assert.match(inferredDiagnostic?.message ?? "", /must initialize an explicit Z String/);
  const unsupportedInput = source.replace(
    "  return changedValue - 42;",
    "  return Swift.countUtf8(description) - 20;",
  );
  assert.match(diagnostics(unsupportedInput, example)[0]?.message ?? "", /unsupported type "const swift::String &"/);
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "created 40\nfirst=40, copied=40, changed=42\nSwift value=42\nembedded=a\0b\nreleased 40\n");
});

test("constructs Swift associated-value enum cases through generated C++ factories", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/swift/swift-enum-interop/main.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /#include <ZSwiftState-Swift\.hpp>/);
  assert.match(artifact.source, /const ZSwiftState::LoadState ready = ZSwiftState::LoadState::ready\(42\)/);
  assert.match(artifact.source, /const ZSwiftState::LoadState idle = ZSwiftState::LoadState::idle\(\)/);
  assert.match(artifact.source, /const ZSwiftState::LoadState copied = ready/);
  assert.match(artifact.source, /ready\.value\(\)/);
  assert.deepEqual(diagnostics(source, example), []);

  const context = analyzeSource(source, example);
  const loadState = context.foreignModules.get("Swift")?.namedTypes.get("LoadState");
  assert.equal(loadState?.kind, "value");
  if (loadState?.kind === "value") {
    assert.deepEqual(loadState.lifecycle, { copy: true, move: false, deinit: true });
    assert.equal(loadState.staticMethods.find((method) => method.name === "ready")?.overloads.length, 1);
    assert.equal(loadState.staticMethods.find((method) => method.name === "idle")?.overloads.length, 1);
    assert.equal(loadState.methods.find((method) => method.name === "value")?.overloads[0]?.receiverAccess, "in");
  }

  const readyOffset = source.indexOf("ready(42)") + 1;
  assert.match(
    hover(source, example, readyOffset)?.contents.value ?? "",
    /ready\(val: i32\): Swift\.LoadState.*C\+\+ static/s,
  );
  const completionSource = source.replace("Swift.LoadState.ready(42)", "Swift.LoadState.re");
  const completionOffset = completionSource.indexOf("Swift.LoadState.re") + "Swift.LoadState.re".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "ready")?.kind, 2);
  assert.match(definition(source, `file://${example}`, readyOffset)?.uri ?? "", /ZSwiftState-Swift\.hpp$/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "ready=42, idle=-1, copy=42\n");
});

test("records hard Swift surfaces currently withheld by the generated C++ interface", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-swift-boundary-");
  const source = resolve(projectRoot, "tests/fixtures/swift-toolchain-boundaries.swift");
  const header = resolve(directory, "ZSwiftBoundaries-Swift.hpp");
  const library = resolve(directory, "libZSwiftBoundaries.dylib");
  const swiftCompile = spawnSync("xcrun", [
    "swiftc",
    "-emit-library",
    "-emit-module",
    "-module-name", "ZSwiftBoundaries",
    "-cxx-interoperability-mode=default",
    "-emit-objc-header-path", header,
    source,
    "-o", library,
  ], { encoding: "utf8" });
  assert.equal(swiftCompile.status, 0, swiftCompile.stderr);
  const generated = readFileSync(header, "utf8");
  assert.match(generated, /noncopyable struct 'UniqueCounter' can not yet be represented in C\+\+/);
  assert.match(generated, /Unavailable in C\+\+: Swift global function 'makeUniqueCounter\(_:\)'/);
  assert.match(generated, /Unavailable in C\+\+: Swift global function 'doubleLater\(_:\)'/);
});

test("keeps labeled arguments reserved for Objective-C selectors", () => {
  const source = `
    function identity(value: i32): i32 { return value; }
    function main(): i32 { return identity(value: 1); }
  `;
  assert.throws(
    () => compileToC(source, "labeled-native-call.zs"),
    /labeled arguments are currently supported only for Objective-C method calls/,
  );
});

test("provides compiler-backed AppKit completion, labels, hover, diagnostics, and definitions", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/nswindow.zs");
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
  assert.match(hover(source, example, titleOffset)?.contents.value ?? "", /copy title: NSString/);

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
  assert.match(result.stdout, /"triggerCharacters":\["\.",",","\{","_","a","b"/);
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

test("formats typed values through the imported console namespace and interpolation", () => {
  const example = resolve(projectRoot, "examples/language/basics/console.zs");
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
  const fileName = resolve(directory, "main.zs");
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
  const missingDiagnostic = diagnostics(missing, "missing-console.zs")[0];
  assert.equal(missingDiagnostic.code, "Z0403");
  assert.match(missingDiagnostic.message, /import console from "std\/console"/);

  const focused = `
    import logging from "std/console";
    function main(): i32 { logging.log(42); return 0; }
  `;
  assert.deepEqual(diagnostics(focused, "focused-console.zs"), []);
  const focusedGenerated = compileToC(focused, "focused-console.zs");
  assert.match(focusedGenerated, /fprintf\(stdout, "%lld", \(long long\)/);
  assert.doesNotMatch(focusedGenerated, /#include <std\/console>/);

  const facade = `
    import { console as logging } from "std";
    function main(): i32 { logging.write(42); return 0; }
  `;
  assert.deepEqual(diagnostics(facade, "facade-console.zs"), []);
  assert.doesNotMatch(compileToC(facade, "facade-console.zs"), /#include <std>/);

  const unknownModule = `import future from "std/future"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(unknownModule, "unknown-std.zs")[0].code, "Z0501");
  const unknownExport = `import { future } from "std"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "unknown-std-export.zs")[0].message, /std has no export "future"/);
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
  const generated = compileToC(source, "sleep.zs");
  assert.match(generated, /#if defined\(_WIN32\)[\s\S]*#include <windows\.h>[\s\S]*#include <time\.h>/);
  assert.match(generated, /static void z_sleep_ms\(uint64_t milliseconds\)/);
  assert.match(generated, /nanosleep\(&remaining, &remaining\)/);
  assert.match(generated, /Sleep\(\(DWORD\)milliseconds\)/);
  assert.match(generated, /z_sleep_ms\(1ULL\);/);
  assert.match(generated, /delay = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_standard_function_adapter_sleep/);
  assert.match(generated, /\(delay\)\.call\(\(delay\)\.context, 1ULL\)/);
  assert.doesNotMatch(generated, /#include <std\/time>/);

  const directory = mkdtempSync("/tmp/z-sleep-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const pauseUse = source.indexOf("pause(1)") + 1;
  assert.match(hover(source, "sleep-editor.zs", pauseUse)?.contents.value ?? "", /pause\(milliseconds: u64\): void/);
  assert.match(hover(source, "sleep-editor.zs", pauseUse)?.contents.value ?? "", /alias of sleep/);
  const completionSource = source.replace("pause(1)", "pau");
  const completionOffset = completionSource.indexOf("pau", completionSource.indexOf("main")) + 3;
  assert.match(
    completions(completionSource, "sleep-editor.zs", completionOffset).find((item) => item.label === "pause")?.detail ?? "",
    /blocks the current thread/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, "sleep-editor.zs").data);
  const pausePosition = positionForOffset(source, pauseUse - 1);
  assert.ok(tokens.some((token) => (
    token.line === pausePosition.line
    && token.character === pausePosition.character
    && token.type === semanticTokenTypes.indexOf("function")
  )));

  const defaultImport = `import time from "std/time"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(defaultImport, "sleep-default.zs")[0].code, "Z0501");
  const unknownExport = `import { timer } from "std/time"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "sleep-export.zs")[0].message, /std\/time has no export "timer"/);
  const wrongType = `import { sleep } from "std/time"; function main(): i32 { sleep(-1); return 0; }`;
  assert.match(diagnostics(wrongType, "sleep-type.zs")[0].message, /integer literal -1 does not fit u64/);
});

test("reads files, exposes program arguments, and runs child processes through standard modules", () => {
  const directory = mkdtempSync("/tmp/z-system-std-");
  const fileName = resolve(directory, "main.zs");
  const copyPath = resolve(directory, "copy.zs");
  const source = `
    import console from "std/console";
    import fs from "std/fs";
    import process from "std/process";

    function runTool(): i32 throws String {
      const source = try fs.readText(${JSON.stringify(fileName)});
      try fs.writeText(${JSON.stringify(copyPath)}, source);
      if (!fs.exists(${JSON.stringify(copyPath)})) return 90;
      const arguments = process.args();
      const childArguments = ["-e", "process.exit(0)"];
      const exitCode = try process.run(${JSON.stringify(process.execPath)}, childArguments);
      const missing = attempt process.run("/z/definitely/missing/executable", childArguments);
      const missingWasTypedFailure = match (missing) {
        success(code) => code < 0;
        failure(message) => !fs.exists(message);
      };
      if (!missingWasTypedFailure) return 89;
      console.log(\`args=\${arguments.length}, child=\${exitCode}\`);
      return exitCode;
    }

    function main(): i32 {
      const result = attempt runTool();
      return match (result) {
        success(code) => code;
        failure(message) => {
          console.error(message);
          select 91;
        }
      };
    }
  `;
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName, "--", "alpha", "beta"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "args=2, child=0\n");
  assert.equal(readFileSync(copyPath, "utf8"), source);

  const generated = compileToC(source, fileName);
  assert.match(generated, /static Z_Result_String_String z_fs_read_text/);
  assert.match(generated, /static Z_DynamicArray_.* z_process_args\(void\)/);
  assert.match(generated, /execvp\(argv\[0\], argv\)/);
  assert.match(generated, /int32_t main\(int argc, char \*\*argv\)/);
  assert.doesNotMatch(generated, /#include <std\/(?:fs|process)>/);

  const readOffset = source.indexOf("readText") + 2;
  assert.match(hover(source, fileName, readOffset)?.contents.value ?? "", /readText\(in path: String\): String throws String/);
  const completionSource = source.replace("fs.readText", "fs.re");
  const completionOffset = completionSource.indexOf("fs.re") + "fs.re".length;
  assert.match(
    completions(completionSource, fileName, completionOffset).find((item) => item.label === "readText")?.detail ?? "",
    /throws String/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const readPosition = positionForOffset(source, source.indexOf("readText"));
  assert.ok(tokens.some((token) => (
    token.line === readPosition.line
    && token.character === readPosition.character
    && token.type === semanticTokenTypes.indexOf("method")
  )));

  const unchecked = `import fs from "std/fs"; function main(): i32 { fs.readText("missing"); return 0; }`;
  assert.match(diagnostics(unchecked, "unchecked-fs.zs")[0].message, /requires `attempt` or `try`/);
  const selective = `import { readText } from "std/fs"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(selective, "selective-fs.zs")[0].message, /default module import/);

  const mixedFile = resolve(directory, "mixed.zs");
  const nativeHeader = resolve(projectRoot, "tests/fixtures/foreign-values.hpp");
  writeFileSync(mixedFile, `
    import fs from "std/fs";
    import native from ${JSON.stringify(nativeHeader)};
    function main(): i32 {
      const value = native.zcpp.ManagedValue(42);
      if (!fs.exists(${JSON.stringify(mixedFile)})) return 1;
      return value.value() - 42;
    }
  `);
  const mixed = spawnSync(process.execPath, [cli, "run", mixedFile], { encoding: "utf8" });
  assert.equal(mixed.status, 0, mixed.stderr);

  const invalidUtf8Path = resolve(directory, "invalid-utf8.txt");
  writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
  const invalidUtf8File = resolve(directory, "invalid-utf8.zs");
  writeFileSync(invalidUtf8File, `
    import fs from "std/fs";
    function main(): i32 {
      const result = attempt fs.readText(${JSON.stringify(invalidUtf8Path)});
      return match (result) {
        success(contents) => 1;
        failure(message) => fs.exists(message) ? 2 : 0;
      };
    }
  `);
  const invalidUtf8 = spawnSync(process.execPath, [cli, "run", invalidUtf8File], { encoding: "utf8" });
  assert.equal(invalidUtf8.status, 0, invalidUtf8.stderr);
});

test("tokenizes real Z source with checked UTF-8 operations and TextBuffer", () => {
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
}, 10_000);

test("parses declarations, function bodies, and type shapes in native Z", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/self-host-parser-input.zs");
  const lexer = resolve(projectRoot, "compiler/frontend/lexer.zs");
  const parser = resolve(projectRoot, "compiler/frontend/parser.zs");
  const result = spawnSync(process.execPath, [cli, "self-host-parse", fixture, lexer, parser, "--timings"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-host-parser-input\.zs: stage-1 parser matches 16 declarations, 3 imports, 7 function signatures, 7 function bodies, and 6 type shapes/);
  assert.match(result.stdout, /lexer\.zs: stage-1 parser matches 17 declarations, 1 imports, 13 function signatures, 13 function bodies, and 3 type shapes/);
  assert.match(result.stdout, /parser\.zs: stage-1 parser matches \d+ declarations, \d+ imports, \d+ function signatures, \d+ function bodies, and \d+ type shapes/);
  assert.match(result.stdout, /stage-1 parser timing \(3 files, cache (?:hit|miss; stage-0 compile \+ native build included)\)/);
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

test("resolves a canonical module graph directly from native Z ASTs", () => {
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
  assert.match(integrated.stdout, /stage-1 resolver matches 3 modules, 3 local edges, and 10 symbols \(math\.zs -> geometry\.zs -> main\.zs\)/);
  assert.match(integrated.stdout, /stage-1 resolver compiler index matches \d+ binding\/signature queries/);
  assert.match(integrated.stdout, /host discovery \(file I\/O \+ stage-0 import parse\): \d+\.\d{2} ms/);
  assert.match(integrated.stdout, /native in-process \(FFI \+ lex \+ parse \+ resolve \+ symbols \+ signatures \+ names \+ types \+ expressions \+ encode\): \d+\.\d{2} ms/);
  assert.match(integrated.stdout, /compiler parity \+ semantic queries \(reused AST\): \d+\.\d{2} ms/);

  const ordinaryCheck = spawnSync(
    process.execPath,
    [cli, "check", main, "--native-frontend", "--timings"],
    { encoding: "utf8" },
  );
  assert.equal(ordinaryCheck.status, 0, ordinaryCheck.stderr);
  assert.match(
    ordinaryCheck.stdout,
    /main\.zs: native frontend hybrid matches 3 modules, 3 local edges, and 10 symbols/,
  );
  assert.match(ordinaryCheck.stdout, /native frontend hybrid compiler index matches \d+ binding\/signature queries/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid exports 2 inferred local binding contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid exports 7 root expression type contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ function, \d+ method, and \d+ constructor stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ aggregate, \d+ field, and \d+ enum-variant stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ explicit type-use stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes \d+ inferred local binding stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid observes 7 root expression stage-0 Z resolutions/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ function, \d+ method, and \d+ constructor native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ aggregate, \d+ field, and \d+ enum-variant native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses \d+ explicit type-use native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 2 inferred local binding native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid uses 7 root expression native-authoritative contracts/);
  assert.match(ordinaryCheck.stdout, /native frontend hybrid timing \(3 modules, cache hit\)/);
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
  assert.match(inferredBindingEvidence.stdout, /exports 3 inferred local binding contracts/);
  assert.match(inferredBindingEvidence.stdout, /observes 3 inferred local binding stage-0 Z resolutions/);
  assert.match(inferredBindingEvidence.stdout, /uses 3 inferred local binding native-authoritative contracts/);
  assert.match(inferredBindingEvidence.stdout, /exports 8 root expression type contracts/);
  assert.match(inferredBindingEvidence.stdout, /observes 6 root expression stage-0 Z resolutions/);
  assert.match(inferredBindingEvidence.stdout, /uses 6 root expression native-authoritative contracts/);

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
  assert.match(wrappedBindingEvidence.stdout, /exports 1 inferred local binding contract/);
  assert.match(wrappedBindingEvidence.stdout, /observes 1 inferred local binding stage-0 Z resolutions/);
  assert.match(wrappedBindingEvidence.stdout, /uses 1 inferred local binding native-authoritative contracts/);
  assert.match(wrappedBindingEvidence.stdout, /exports 4 root expression type contracts/);
  assert.match(wrappedBindingEvidence.stdout, /observes 3 root expression stage-0 Z resolutions/);
  assert.match(wrappedBindingEvidence.stdout, /uses 3 root expression native-authoritative contracts/);

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
  assert.match(genericEvidence.stdout, /native frontend hybrid exports 12 concrete generic call contracts/);
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
  assert.match(genericErrorEvidence.stdout, /native frontend hybrid exports 1 concrete generic call contract/);
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
    + "symbol\t0000000000000000\tfunction\t6964656e74697479\t1\t-\t6964656e74697479\t0000000000000000\t0000000000000001\t0000000000000001\n"
    + "signature\t0000000000000000\t0000000000000000\t0\t54\t\t0000000000000001\t0000000000000001\t54\t76616c7565\t54\n"
    + "callResolution\t0000000000000000\t000000000000002a\t0000000000000002\t000000000000000a\t0000000000000000\t0000000000000000\t66756e6374696f6e\t6964656e74697479\t0\t\t693332\t\t0000000000000001\t0000000000000001\t54\t693332\t76616c7565\t693332\n"
    + "bindingResolution\t0000000000000000\t000000000000001e\t0000000000000002\t0000000000000007\t76616c7565\t0\t693332\t0000000000000000\n"
    + "expressionResolution\t0000000000000000\t000000000000002a\t0000000000000002\t000000000000000a\t693332\t0000000000000000\n"
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
    typeIdentities: [],
  }]);
  assert.throws(() => decodeStage1ModuleGraphStream("order\n"), /did not contain an entry/);
  assert.throws(
    () => decodeStage1ModuleGraphStream("entry\t0000000000000001\nmodule\t2f612e7a73\norder\t0000000000000000\n"),
    /entry is outside the module batch/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tunknown\t76616c7565\t1\t-\t76616c7565\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 module symbol kind/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t0000000000000000\t0000000000000000\n"
      + "order\t0000000000000000\n",
    ),
    /function signature appeared before its symbol/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tfunction\t76616c7565\t1\t-\t76616c7565\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "signature\t0000000000000000\t0000000000000000\t0\t693332\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 function parameter mode/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tclass\t536563726574\t1\t-\t536563726574\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0\t1\n"
      + "constructorSignature\t0000000000000000\t0000000000000000\t0\t536563726574\t\t0000000000000000\t0000000000000001\t626164\t693332\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 constructor parameter mode/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tenum\t5374617465\t1\t-\t5374617465\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000001\t0\t0\n"
      + "order\t0000000000000000\n",
    ),
    /malformed stage-1 type signature arity/,
  );
  assert.throws(
    () => decodeStage1ModuleGraphStream(
      "entry\t0000000000000000\n"
      + "module\t2f612e7a73\n"
      + "symbol\t0000000000000000\tstruct\t506f696e74\t1\t-\t506f696e74\t0000000000000000\t0000000000000001\t0000000000000001\n"
      + "typeSignature\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0000000000000000\t0\t0\n"
      + "methodSignature\t0000000000000000\t0000000000000000\t72656164\t0\t7075626c6963\t626164\t0\t693332\t\t0000000000000000\t0000000000000000\n"
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
      /observes (\d+) root expression stage-0 Z resolutions/,
      /uses (\d+) root expression native-authoritative contracts/,
    ],
  ] as const;

  for (const entry of entries) {
    const input = resolve(projectRoot, entry);
    const result = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${entry}\n${result.stderr}`);
    assert.match(result.stdout, /exports [1-9]\d* root expression type contracts/);
    for (const [observedPattern, authoritativePattern] of parityPatterns) {
      const observed = result.stdout.match(observedPattern)?.slice(1);
      const authoritative = result.stdout.match(authoritativePattern)?.slice(1);
      assert.ok(observed, `${entry} did not report observed semantic counts`);
      assert.deepEqual(authoritative, observed, `${entry} left an observed native semantic result on Stage 0`);
    }
  }
}, 30_000);

test("builds owned UTF-8 String values through explicit std/text TextBuffer", () => {
  const directory = mkdtempSync("/tmp/z-text-buffer-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import console from "std/console";
    import { TextBuffer } from "std/text";

    function main(): i32 {
      let output = TextBuffer();
      output.append("alpha");
      output.appendAscii(10);
      output.appendBytes("éZ", 0, 2);
      output.append(\`=\${40 + 2}\`);
      const text = output.finish();
      console.log(text);
      return 0;
    }
  `;
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "alpha\né=42\n");

  const generated = compileToC(source, fileName);
  assert.match(generated, /Z_String output = z_string_new\(\);/);
  assert.match(generated, /z_text_buffer_append\(&\(output\)/);
  assert.match(generated, /z_text_buffer_append_ascii\(&\(output\), 10/);
  assert.match(generated, /z_text_buffer_append_bytes\(&\(output\)/);
  assert.match(generated, /Z_String text = \(_z_live_output_\d+ = false, output\);/);

  const aliased = source
    .replace("{ TextBuffer }", "{ TextBuffer as Buffer }")
    .replace("TextBuffer()", "Buffer()");
  assert.doesNotThrow(() => compileToC(aliased, "aliased-text-buffer.zs"));

  const missingImport = `function main(): i32 { let text = TextBuffer(); return 0; }`;
  assert.match(diagnostics(missingImport, "missing-text-import.zs")[0].message, /unknown function "TextBuffer"/);

  const immutable = `
    import { TextBuffer } from "std/text";
    function main(): i32 { const text = TextBuffer(); text.append("no"); return 0; }
  `;
  const immutableDiagnostic = diagnostics(immutable, "immutable-text-buffer.zs")[0];
  assert.match(immutableDiagnostic.message, /requires addressable let storage/);
  let immutableCompilerDiagnostic: unknown;
  try {
    compileToC(immutable, "immutable-text-buffer.zs");
  } catch (error) {
    immutableCompilerDiagnostic = error;
  }
  assert.ok(immutableCompilerDiagnostic instanceof DiagnosticError);
  assert.match(immutableCompilerDiagnostic.helps.join(" "), /bind the TextBuffer with `let`/);

  const consumed = `
    import { TextBuffer } from "std/text";
    function main(): i32 {
      let text = TextBuffer();
      const finished = text.finish();
      text.append("too late");
      return finished.byteLength;
    }
  `;
  assert.match(diagnostics(consumed, "consumed-text-buffer.zs")[0].message, /moved value "text"/);

  const printable = `
    import console from "std/console";
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); console.log(text); return 0; }
  `;
  const printableDiagnostic = diagnostics(printable, "printable-text-buffer.zs")[0];
  assert.match(printableDiagnostic.message, /mutable construction storage, not printable text/);
  let printableCompilerDiagnostic: unknown;
  try {
    compileToC(printable, "printable-text-buffer.zs");
  } catch (error) {
    printableCompilerDiagnostic = error;
  }
  assert.ok(printableCompilerDiagnostic instanceof DiagnosticError);
  assert.match(printableCompilerDiagnostic.helps.join(" "), /finish\(\)/);

  const invalidBoundaryFile = resolve(directory, "invalid-boundary.zs");
  writeFileSync(invalidBoundaryFile, `
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); text.appendBytes("é", 1, 2); return 0; }
  `);
  const invalidBoundary = spawnSync(process.execPath, [cli, "run", invalidBoundaryFile], { encoding: "utf8" });
  assert.notEqual(invalidBoundary.status, 0);

  const invalidAsciiFile = resolve(directory, "invalid-ascii.zs");
  writeFileSync(invalidAsciiFile, `
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); text.appendAscii(128); return 0; }
  `);
  const invalidAscii = spawnSync(process.execPath, [cli, "run", invalidAsciiFile], { encoding: "utf8" });
  assert.notEqual(invalidAscii.status, 0);

  const importSource = `import { TextB } from "std/text"; function main(): i32 { return 0; }`;
  const importOffset = importSource.indexOf("TextB") + "TextB".length;
  assert.equal(completions(importSource, fileName, importOffset).find((item) => item.label === "TextBuffer")?.kind, 22);
  const symbolSource = source.replace("let output = TextBuffer();", "let output = TextB;");
  const symbolOffset = symbolSource.indexOf("TextB;") + "TextB".length;
  assert.equal(completions(symbolSource, fileName, symbolOffset).find((item) => item.label === "TextBuffer")?.kind, 22);
  const memberSource = source.replace("output.append(\"alpha\")", "output.app");
  const memberOffset = memberSource.indexOf("output.app") + "output.app".length;
  const memberItems = completions(memberSource, fileName, memberOffset);
  const appendCompletion = memberItems.find((item) => item.label === "append");
  assert.ok(appendCompletion, JSON.stringify(memberItems));
  assert.match(appendCompletion?.detail ?? "", /append\(in text: String\): void/);
  const finishOffset = source.indexOf("finish") + 2;
  assert.match(hover(source, fileName, finishOffset)?.contents.value ?? "", /consumes the TextBuffer/);
  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const importedType = positionForOffset(source, source.indexOf("TextBuffer"));
  assert.ok(tokens.some((token) => (
    token.line === importedType.line
    && token.character === importedType.character
    && token.type === semanticTokenTypes.indexOf("type")
  )));
});

test("stores, returns, moves, and formats owned String values", () => {
  const example = resolve(projectRoot, "examples/language/basics/strings.zs");
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

  const byteSource = `
    import console from "std/console";
    function main(): i32 {
      const word = "éZ";
      console.log(\`\${word.byteLength}|\${word.byteAt(0)}|\${word.isEmpty}\`);
      const first = word.copyBytes(0, 2);
      console.log(first);
      const empty = "";
      console.log(empty.isEmpty);
      return 0;
    }
  `;
  const byteFile = resolve(mkdtempSync("/tmp/z-string-bytes-"), "main.zs");
  writeFileSync(byteFile, byteSource);
  const byteResult = spawnSync(process.execPath, [cli, "run", byteFile], { encoding: "utf8" });
  assert.equal(byteResult.status, 0, byteResult.stderr);
  assert.equal(byteResult.stdout, "3|195|false\né\ntrue\n");
  const byteGenerated = compileToC(byteSource, byteFile);
  assert.match(byteGenerated, /z_string_byte_at\(word, 0ULL\)/);
  assert.match(byteGenerated, /z_string_copy_bytes\(word, 0ULL, 2ULL\)/);
  assert.match(byteGenerated, /z_string_is_utf8_boundary/);

  const byteLengthOffset = byteSource.indexOf("byteLength") + 2;
  assert.match(hover(byteSource, byteFile, byteLengthOffset)?.contents.value ?? "", /byteLength: usize/);
  const byteAtOffset = byteSource.indexOf("byteAt") + 2;
  assert.match(hover(byteSource, byteFile, byteAtOffset)?.contents.value ?? "", /byteAt\(index: usize\): u8/);
  const byteCompletionSource = byteSource.replace("word.byteLength", "word.by");
  const byteCompletionOffset = byteCompletionSource.indexOf("word.by") + "word.by".length;
  const byteLabels = completions(byteCompletionSource, byteFile, byteCompletionOffset).map((item) => item.label);
  assert.ok(byteLabels.includes("byteLength"));
  assert.ok(byteLabels.includes("byteAt"));
  const byteTokens = decodeSemanticTokens(semanticTokens(byteSource, byteFile).data);
  const byteLengthPosition = positionForOffset(byteSource, byteSource.indexOf("byteLength"));
  const byteAtPosition = positionForOffset(byteSource, byteSource.indexOf("byteAt"));
  assert.ok(byteTokens.some((token) => (
    token.line === byteLengthPosition.line
    && token.character === byteLengthPosition.character
    && token.type === semanticTokenTypes.indexOf("property")
  )));
  assert.ok(byteTokens.some((token) => (
    token.line === byteAtPosition.line
    && token.character === byteAtPosition.character
    && token.type === semanticTokenTypes.indexOf("method")
  )));

  const invalidByteCall = `function main(): i32 { const text = "hello"; return text.byteAt("0"); }`;
  assert.match(diagnostics(invalidByteCall, "invalid-string-byte.zs")[0].message, /expected usize, found String/);
  const reservedLength = `function main(): i32 { const text = "hello"; return text.length; }`;
  assert.match(diagnostics(reservedLength, "reserved-string-length.zs")[0].message, /String has no property "length"/);

  const invalidBoundaryFile = resolve(mkdtempSync("/tmp/z-string-boundary-"), "main.zs");
  writeFileSync(invalidBoundaryFile, `
    function main(): i32 {
      const text = "é";
      const invalid = text.copyBytes(1, 2);
      return 0;
    }
  `);
  const invalidBoundary = spawnSync(process.execPath, [cli, "run", invalidBoundaryFile], { encoding: "utf8" });
  assert.notEqual(invalidBoundary.status, 0);

  const escapingBorrow = `
    function main(): i32 {
      const owned = \`value=42\`;
      const escaped: cstring = owned;
      return 0;
    }
  `;
  assert.match(diagnostics(escapingBorrow, "escaping-cstring.zs")[0].message, /expected cstring, found String/);

  const singleQuotedImport = `
    import stdio from 'stdio.h';
    function main(): i32 { return stdio.puts('single import'); }
  `;
  assert.deepEqual(diagnostics(singleQuotedImport, "single-quoted-import.zs"), []);
  assert.match(compileToC(singleQuotedImport, "single-quoted-import.zs"), /return puts\("single import"\);/);

  const directArgument = `
    function consume(value: String): void {}
    function main(): i32 { consume(\`value=\${42}\`); return 0; }
  `;
  assert.deepEqual(diagnostics(directArgument, "string-argument.zs"), []);
  assert.doesNotThrow(() => compileToC(directArgument, "string-argument.zs"));

  const throwingArgument = `
    enum ParseError { invalid, }
    function parse(in value: String): i32 throws ParseError { return 42; }
    function forward(): i32 throws ParseError { return try parse(\`value=\${42}\`); }
    function main(): i32 { return 0; }
  `;
  assert.deepEqual(diagnostics(throwingArgument, "throwing-string-argument.zs"), []);
  const throwingGenerated = compileToC(throwingArgument, "throwing-string-argument.zs");
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
  const movedStringDiagnostic = diagnostics(movedString, "moved-string.zs");
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
  const cppFile = resolve(projectRoot, "examples/interop/cpp/string-cpp-probe.zs");
  const cppArtifact = compileToNative(cppSource, cppFile);
  assert.equal(cppArtifact.language, "c++");
  const cppCompilation = spawnSync("clang++", [
    "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "examples/interop/cpp"),
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
  const cleanupDiagnostic = diagnostics(cleanupTemporary, "console-temporary.zs");
  assert.equal(cleanupDiagnostic[0].code, "Z0402");
  assert.match(cleanupDiagnostic[0].message, /bind the value to a const or let before logging it/);

  const unknownMethod = `
    import console from "std/console";
    function main(): i32 { console.table(42); return 0; }
  `;
  const methodDiagnostic = diagnostics(unknownMethod, "console-method.zs");
  assert.equal(methodDiagnostic[0].code, "Z0401");
  assert.match(methodDiagnostic[0].message, /use console\.log, console\.write, console\.error, or console\.debug/);
});

test("compares owned String values by their UTF-8 bytes", () => {
  const directory = mkdtempSync("/tmp/z-string-equality-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    function main(): i32 {
      const source: cstring = "same";
      const copied = String.from(source);
      const built = \`sa\${"me"}\`;
      if (copied != built) return 1;
      if (copied == "different") return 2;
      if ("" != "") return 3;
      return 0;
    }
  `;
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const generated = compileToC(source, fileName);
  assert.match(generated, /static .*bool z_string_equal\(Z_String left, Z_String right\)/);
  assert.match(generated, /!z_string_equal\(copied, built\)/);

  const asyncFile = resolve(directory, "async.zs");
  const asyncSource = `
    async function equal(): boolean {
      const left = "same";
      const right = "same";
      return left == right;
    }
    async function main(): i32 {
      const same = await equal();
      return same ? 0 : 1;
    }
  `;
  writeFileSync(asyncFile, asyncSource);
  const asyncResult = spawnSync(process.execPath, [cli, "run", asyncFile], { encoding: "utf8" });
  assert.equal(asyncResult.status, 0, asyncResult.stderr);
});

test("compares payload-free Z enums by tag", () => {
  const source = `
    enum Direction { north, south, }
    enum Payload { value i32, }
    function main(): i32 {
      const direction = Direction.north;
      return direction == Direction.north && direction != Direction.south ? 0 : 1;
    }
  `;
  const directory = mkdtempSync("/tmp/z-enum-equality-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(compileToC(source, fileName), /direction\)\.tag == .*\.tag/);

  const payloadComparison = source.replace(
    "return direction == Direction.north && direction != Direction.south ? 0 : 1;",
    "return Payload.value(1) == Payload.value(1) ? 0 : 1;",
  );
  assert.match(
    diagnostics(payloadComparison, "payload-enum-equality.zs")[0]?.message ?? "",
    /payload-free enum/,
  );
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
  assert.match(hover(source, "console-editor.zs", consoleOffset)?.contents.value ?? "", /standard console imported as console/);
  const logOffset = source.indexOf("log") + 1;
  assert.match(hover(source, "console-editor.zs", logOffset)?.contents.value ?? "", /stdout with newline/);
  const items = completions(source.replace("console.log", "console.lo"), "console-editor.zs", source.indexOf("console.log") + "console.lo".length);
  assert.equal(items.find((item) => item.label === "log")?.kind, 2);
  const answerUse = source.lastIndexOf("answer") + 1;
  assert.match(hover(source, "console-editor.zs", answerUse)?.contents.value ?? "", /answer: i32/);

  const aliasSource = source
    .replace("import console from", "import logging from")
    .replaceAll("console.log", "logging.log");
  const aliasUse = aliasSource.indexOf("logging.log") + 1;
  assert.match(hover(aliasSource, "console-alias-editor.zs", aliasUse)?.contents.value ?? "", /standard console imported as logging/);
  const incompleteAlias = aliasSource.replace("logging.log", "logging.lo");
  const incompleteAliasOffset = incompleteAlias.indexOf("logging.lo") + "logging.lo".length;
  assert.equal(completions(incompleteAlias, "console-alias-editor.zs", incompleteAliasOffset).find((item) => item.label === "log")?.kind, 2);
  const symbolSource = `
    import logging from "std/console";
    function main(): i32 { logg; return 0; }
  `;
  const symbolOffset = symbolSource.indexOf("logg;") + 4;
  assert.equal(completions(symbolSource, "console-alias-editor.zs", symbolOffset).find((item) => item.label === "logging")?.kind, 9);
});

test("keeps loop control inside an enclosing loop", () => {
  const outsideBreak = `
    function main(): i32 {
      break;
      return 0;
    }
  `;
  assert.throws(() => compileToC(outsideBreak, "break-outside.zs"), /break requires an enclosing loop/);

  const outsideContinue = outsideBreak.replace("break", "continue");
  assert.throws(() => compileToC(outsideContinue, "continue-outside.zs"), /continue requires an enclosing loop/);

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
    () => compileToC(unreachable, "loop-unreachable.zs"),
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
  assert.throws(() => compileToC(source, "while-condition.zs"), /expected boolean, found i32/);
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
    () => compileToC(repeatedMove, "loop-repeated-move.zs"),
    /resource.*may have been moved|may have been moved.*resource/,
  );

  const maybeMovedAfterBreak = repeatedMove
    .replace("index = index + 1;", "break;")
    .replace("      return 0;", "      consume(resource);\n      return 0;");
  assert.throws(
    () => compileToC(maybeMovedAfterBreak, "loop-break-move.zs"),
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
  assert.match(compileToC(restored, "loop-restored-owner.zs"), /while \(index < 2\)/);
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
  const generated = compileToC(source, "loop-match-control.zs");
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
  const items = completions(source, "loop-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "inside")?.detail, "const inside: i32");
});

test("runs fixed arrays with checked indexing and reverse element cleanup", () => {
  const example = resolve(projectRoot, "examples/language/collections/arrays.zs");
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
    () => compileToC(immutable, "array-immutable.zs"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const wrongLength = `
    function main(): i32 {
      const values: i32[3] = [1, 2];
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongLength, "array-length.zs"), /expected i32\[3\], found i32\[2\]/);

  const wrongIndex = `
    function main(): i32 {
      const values = [1, 2];
      return values[1.5];
    }
  `;
  assert.throws(() => compileToC(wrongIndex, "array-index.zs"), /array index must be an integer, found f64/);

  const staticBounds = wrongIndex.replace("1.5", "2");
  assert.throws(
    () => compileToC(staticBounds, "array-static-bounds.zs"),
    /array index 2 is out of bounds for length 2/,
  );

  const empty = `function main(): i32 { const values = []; return 0; }`;
  assert.throws(() => compileToC(empty, "array-empty.zs"), /cannot infer an empty fixed array/);
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
  const generated = compileToC(source, "nested-arrays.zs");
  assert.match(generated, /data\[2\]/);
  assert.match(generated, /struct Z_Matrix/);
  assert.match(generated, /z_bounds_index/);

  const recursive = `
    struct Node { children: Node[1]; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(recursive, "recursive-array-layout.zs"), /recursive value layout/);
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
    () => compileToC(source, "array-element-move.zs"),
    /cannot move an ownership-bearing field or element out of its owner/,
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
  const items = completions(source, "array-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const valuesDeclaration = valid.indexOf("values =");
  assert.match(hover(valid, "array-editor.zs", valuesDeclaration + 1)?.contents.value ?? "", /values: i32\[3\]/);
});

test("borrows fixed arrays as read-only and mutable Slice parameters", () => {
  const example = resolve(projectRoot, "examples/language/collections/slices.zs");
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
    () => compileToC(returned, "slice-return.zs"),
    /returning Slice values requires an explicit lifetime contract/,
  );

  const stored = `
    struct Holder { values: Slice<i32>; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(stored, "slice-field.zs"), /Slice values cannot be stored in struct or class fields/);

  const local = `
    function inspect(values: Slice<i32>): i32 {
      const saved = values;
      return saved.length;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(local, "slice-local.zs"), /Slice values cannot be stored in local bindings yet/);
});

test("checks Slice capabilities, element types, and overlapping borrows", () => {
  const readOnlyMutation = `
    function mutate(values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(readOnlyMutation, "slice-readonly.zs"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const redundantIn = `
    function inspect(in values: Slice<i32>): i32 { return values.length; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(redundantIn, "slice-in.zs"), /Slice parameters are already borrowed; omit `in`/);

  const immutableMutation = `
    function fill(inout values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 {
      const values = [1, 2];
      fill(inout values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutableMutation, "slice-const.zs"), /requires a mutable let binding/);

  const wrongElement = `
    function sum(values: Slice<u32>): u32 { return values[0]; }
    function main(): i32 {
      const values = [1, 2];
      sum(values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "slice-element.zs"), /expected Slice<u32>, found i32\[2\]/);

  const overlap = `
    function mix(inout target: Slice<i32>, source: Slice<i32>): void {}
    function main(): i32 {
      let values = [1, 2];
      mix(inout values, values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(overlap, "slice-overlap.zs"), /overlapping inout and in uses of "values"/);
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
  assert.equal(completions(source, "slice-editor.zs", offset).find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const declaration = valid.indexOf("values:");
  assert.match(hover(valid, "slice-editor.zs", declaration + 1)?.contents.value ?? "", /values: Slice<i32>/);
});

test("monomorphizes generic structs and functions", () => {
  const example = resolve(projectRoot, "examples/language/types/generics.zs");
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
      const flag = identity<boolean>(true);
      if (flag) { return number; }
      return 0;
    }
  `;
  const generated = compileToC(distinct, "generic-distinct.zs");
  assert.match(generated, /__z_mono_identity_i32/);
  assert.match(generated, /__z_mono_identity_boolean/);

  const moved = `
    struct Resource { id: i32; deinit {} }
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const resource = Resource({ id: 1 });
      const other = identity(resource);
      return resource.id + other.id;
    }
  `;
  assert.throws(() => compileToC(moved, "generic-move.zs"), /use of moved value "resource"/);
});

test("infers generic calls while preserving explicit instantiation", () => {
  const wrongArity = `
    struct Pair<T, U> { first: T; second: U; }
    function main(): i32 { const pair = Pair<i32>({ first: 1, second: 2 }); return 0; }
  `;
  assert.throws(() => compileToC(wrongArity, "generic-arity.zs"), /Pair expects 2 type argument\(s\), received 1/);

  const implicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(42); }
  `;
  assert.match(compileToC(implicit, "generic-inferred.zs"), /__z_mono_identity_i32\(42\)/);

  const explicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity<i32>(42); }
  `;
  assert.match(compileToC(explicit, "generic-explicit.zs"), /__z_mono_identity_i32\(42\)/);

  const contextualReturn = `
    function make<T>(): T { return 1; }
    function main(): i32 { return make(); }
  `;
  assert.match(compileToC(contextualReturn, "generic-contextual-return.zs"), /__z_mono_make_i32/);

  const contextualBinding = `
    function make<T>(): T { return 1; }
    function main(): i32 { const value: i64 = make(); return 0; }
  `;
  assert.match(compileToC(contextualBinding, "generic-contextual-binding.zs"), /__z_mono_make_i64/);

  const ambiguous = `
    function make<T>(): T { return 1; }
    function main(): i32 { const value = make(); return 0; }
  `;
  assert.throws(() => compileToC(ambiguous, "generic-ambiguous.zs"), /cannot infer type parameter "T" for "make"/);

  const conflicting = `
    function choose<T>(left: T, right: T): T { return left; }
    function main(): i32 { return choose(1, true); }
  `;
  assert.throws(() => compileToC(conflicting, "generic-conflict.zs"), /expected i32, found boolean/);

  const duplicate = `
    struct Invalid<T, T> { value: T; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(duplicate, "generic-duplicate.zs"), /duplicate type parameter "T"/);
});

test("infers generic results from annotations, assignments, and returns", () => {
  const source = `
    trait Measured { function measure(): i32; }
    struct Reading implements Measured { function measure(): i32 { return 42; } }
    function absent<T>(): Option<T> { return Option<T>.none; }
    function preserve<T>(value: T): T { return value; }
    function choose<T>(left: T, right: T): T { return left; }
    function constrained<T: Measured>(): Option<T> { return Option<T>.none; }
    struct Factory {
      static function preserve<T>(value: T): T { return value; }
      function preserveInstance<T>(value: T): T { return value; }
    }
    struct Bundle<T> { value: T; }
    struct Wrapper<T> {
      value: T;
      static function wrap(value: T): Wrapper<T> { return Wrapper({ value }); }
    }
    class Envelope<T> {
      value: T;
      constructor(value: T) { this.value = value; }
    }
    struct Utility {
      static function absent<T>(): Option<T> { return Option<T>.none; }
    }
    function returned(): Option<i32> { return absent(); }
    function main(): i32 {
      const local: Option<i64> = absent();
      let assigned: Option<i32> = Option<i32>.none;
      assigned = absent();
      const method: Option<i16> = Utility.absent();
      const checked: Option<Reading> = constrained();
      const nested: Option<i32> = preserve(absent());
      const conditional: Option<i32> = true ? absent() : absent();
      const sequential = choose(Option<i32>.none, absent());
      const branch: Option<i32> = if (true) { select absent(); } else { select absent(); };
      const matched: Option<i32> = match (Option<boolean>.none) {
        some(value) => absent();
        none => absent();
      };
      const factory = Factory({});
      const staticNested: Option<i32> = Factory.preserve(absent());
      const instanceNested: Option<i32> = factory.preserveInstance(absent());
      const inferredEnvelope: Envelope<Option<i32>> = new Envelope(absent());
      const explicitEnvelope = new Envelope<Option<i32>>(absent());
      const inferredBundle: Bundle<Option<i32>> = Bundle({ value: absent() });
      const explicitBundle = Bundle<Option<i32>>({ value: absent() });
      const inferredWrapper: Wrapper<Option<i32>> = Wrapper.wrap(absent());
      const explicitWrapper = Wrapper.wrap<Option<i32>>(absent());
      return 0;
    }
  `;
  const generated = compileToC(source, "generic-result-context.zs");
  assert.match(generated, /__z_mono_absent_i64/);
  assert.match(generated, /__z_mono_absent_i32/);
  assert.match(generated, /Z_Utility___z_mono_absent_i16/);
  assert.match(generated, /__z_mono_constrained_Reading/);

  const directory = mkdtempSync("/tmp/z-native-generic-result-context-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  const hybrid = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], { encoding: "utf8" });
  assert.equal(hybrid.status, 0, hybrid.stderr);
  assert.match(hybrid.stdout, /native frontend hybrid exports 29 concrete generic call contracts/);
  assert.match(hybrid.stdout, /native frontend hybrid uses 22 function, 5 method, and 2 constructor native-authoritative contracts/);

  const invalid = source.replace("Option<Reading> = constrained()", "Option<i32> = constrained()");
  writeFileSync(input, invalid);
  const nativeConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8" });
  assert.equal(nativeConstraint.status, 1);
  assert.match(nativeConstraint.stderr, /i32 does not satisfy Measured for T in "constrained"/);
});

test("specializes separately generic instance and static methods", () => {
  const source = `
    struct Utility {
      static function preserve<T>(value: T): T { return value; }
    }
    struct Record {
      value: i32;
      function choose<T>(left: T, right: T): T {
        if (this.value > 0 && left == right) return left;
        return right;
      }
    }
    struct Holder<T> {
      value: T;
      function replace<U>(candidate: U): U {
        if (this.value > 0) return candidate;
        return candidate;
      }
    }
    function main(): i32 {
      const record = Record({ value: 1 });
      const holder = Holder({ value: 20 });
      const inferred = record.choose(20, 22);
      const explicit = record.choose<i32>(20, 22);
      return Utility.preserve(inferred) + Utility.preserve<i32>(explicit) + holder.replace(2) - 42;
    }
  `;
  const generated = compileToC(source, "generic-methods.zs");
  assert.match(generated, /Z_Utility___z_mono_preserve_i32/);
  assert.match(generated, /Z_Record___z_mono_choose_i32/);
  assert.match(generated, /Z___z_mono_Holder_i32___z_mono_replace_i32/);
  assert.doesNotMatch(generated, /\bfunction preserve<T>|\bfunction choose<T>|\bfunction replace<U>/);
  assert.deepEqual(diagnostics(source, "generic-methods.zs"), []);
  const chooseOffset = source.indexOf("record.choose") + "record.".length + 1;
  assert.match(hover(source, "generic-methods.zs", chooseOffset)?.contents.value ?? "", /function choose<T>\(left: T, right: T\): T/);
  const completionSource = source.replace("record.choose(20, 22)", "record.ch");
  const completionOffset = completionSource.indexOf("record.ch") + "record.ch".length;
  const chooseCompletions = completions(completionSource, "generic-methods.zs", completionOffset)
    .filter((item) => item.label === "choose");
  assert.equal(chooseCompletions.length, 1);
  const chooseCompletion = chooseCompletions[0];
  assert.match(chooseCompletion.detail ?? "", /function choose<T>\(left: T, right: T\): T/);

  const conflict = source.replace("record.choose(20, 22)", "record.choose(20, true)");
  assert.throws(
    () => compileToC(conflict, "generic-method-conflict.zs"),
    /conflicting inferred types for T.*i32 and boolean/,
  );

  const ambiguous = `
    struct Utility { static function make<T>(): T { return 1; } }
    function main(): i32 { const value = Utility.make(); return 0; }
  `;
  assert.throws(
    () => compileToC(ambiguous, "generic-method-ambiguous.zs"),
    /cannot infer type parameter "T" for "Utility\.make"/,
  );

  const wrongArity = source.replace("record.choose<i32>(20, 22)", "record.choose<i32, boolean>(20, 22)");
  assert.throws(
    () => compileToC(wrongArity, "generic-method-arity.zs"),
    /Record\.choose expects 1 type argument\(s\), received 2/,
  );

  const twoLevelStatic = `
    struct Owner<T> {
      static function preserve<U>(candidate: U): U { return candidate; }
    }
    function main(): i32 { return Owner.preserve(42); }
  `;
  assert.throws(
    () => compileToC(twoLevelStatic, "generic-static-two-level.zs"),
    /static method "Owner\.preserve" has independent owner and method type parameters/,
  );
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
  const generated = compileToC(source, "aggregate-inference.zs");
  assert.match(generated, /Z___z_mono_Pair_i32/);
  assert.match(generated, /Z___z_mono_Envelope_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Holder_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Container_i32_wrap\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Shelf_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Marker_i32_create\(void\)/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("pair =") + 1)?.contents.value ?? "", /pair: Pair<i32>/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("envelope =") + 1)?.contents.value ?? "", /envelope: Envelope<i32>/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("wrapped =") + 1)?.contents.value ?? "", /wrapped: Container<i32>/);

  const contextualWidth = `
    struct Pair<T> { first: T; second: T; }
    function wide(): i64 {
      const pair: Pair<i64> = Pair({ first: 20, second: 22 });
      return pair.first + pair.second;
    }
    function main(): i32 { return 0; }
  `;
  assert.match(compileToC(contextualWidth, "aggregate-expected-type.zs"), /struct Z___z_mono_Pair_i64 \{[\s\S]*int64_t first/);

  const conflict = `
    struct Pair<T> { first: T; second: T; }
    function main(): i32 { const pair = Pair({ first: 1, second: true }); return 0; }
  `;
  assert.throws(() => compileToC(conflict, "aggregate-inference-conflict.zs"), /conflicting inferred types for T.*i32 and boolean/);

  const ambiguous = `
    struct Marker<T> { tag: i32; static function create(): Marker<T> { return Marker<T>({ tag: 0 }); } }
    function main(): i32 { const marker = Marker.create(); return marker.tag; }
  `;
  assert.throws(() => compileToC(ambiguous, "static-inference-ambiguous.zs"), /cannot infer type parameter "T" for "Marker\.create"/);

  const wrongStaticArity = source.replace("Container.wrap<i32>(42)", "Container.wrap<i32, boolean>(42)");
  assert.throws(() => compileToC(wrongStaticArity, "static-inference-arity.zs"), /expects 1 type argument\(s\), received 2/);

  const oldStaticShape = source.replace("Container.wrap<i32>(42)", "Container<i32>.wrap(42)");
  assert.throws(() => compileToC(oldStaticShape, "static-owner-specialization.zs"), /static generic arguments follow the method name/);
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
  const generated = compileToC(source, "generic-nested-inference.zs");
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
  const generated = compileToC(source, "generic-slice-inference.zs");
  assert.match(generated, /__z_mono_firstItem_i32/);
  assert.match(generated, /\.length = 2/);
});

test("infers generic arguments from imported C results", () => {
  const source = `
    import stdio from "stdio.h";
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(stdio.getchar()); }
  `;
  const generated = compileToC(source, "generic-c-inference.zs");
  assert.match(generated, /__z_mono_identity_i32\(getchar\(\)\)/);
});

test("checks nominal trait constraints on inferred and explicit generic instances", () => {
  const example = resolve(projectRoot, "examples/language/types/generic-constraints.zs");
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
    () => compileToC(structuralOnly, "generic-constraint-nominal.zs"),
    /Reading does not satisfy Measured for T in "read"/,
  );

  const primitive = `
    trait Measured { function measure(): i32; }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { return read<i32>(42); }
  `;
  assert.throws(
    () => compileToC(primitive, "generic-constraint-primitive.zs"),
    /i32 does not satisfy Measured for T in "read"/,
  );

  const unknown = `
    function read<T: Missing>(value: T): T { return value; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(unknown, "generic-constraint-unknown.zs"), /unknown trait constraint "Missing"/);

  const outsideSurface = `
    trait Measured { function measure(): i32; }
    function reveal<T: Measured>(value: T): i32 { return value.secret(); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(outsideSurface, "generic-constraint-surface.zs"),
    /member "secret" is not provided by the trait constraints on T/,
  );

  const directory = mkdtempSync("/tmp/z-native-generic-constraints-");
  const model = resolve(directory, "model.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(model, `
    export trait Measured { function measure(): i32; }
    export trait Named { function name(): cstring; }
    export struct Reading implements Measured, Named {
      function measure(): i32 { return 42; }
      function name(): cstring { return "reading"; }
    }
    export struct Plain { function measure(): i32 { return 42; } }
    export struct Holder<T: Measured> { value: T; }
    export struct Utility {
      static function inspect<T: Measured>(value: T): i32 { return value.measure(); }
    }
    export function read<T: Measured>(value: T): i32 { return value.measure(); }
    export function readBoth<T: Measured & Named>(value: T): i32 {
      const label = value.name();
      return value.measure();
    }
  `);
  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.readBoth(model.Reading({})); }
  `);
  const nativeValid = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeValid.status, 0, nativeValid.stderr);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.read(model.Plain({})); }
  `);
  const nativeStructuralOnly = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeStructuralOnly.status, 1);
  assert.match(nativeStructuralOnly.stderr, /Plain does not satisfy model\.Measured for T in "read"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.read<i32>(42); }
  `);
  const nativePrimitive = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativePrimitive.status, 1);
  assert.match(nativePrimitive.stderr, /i32 does not satisfy model\.Measured for T in "read"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.Utility.inspect(model.Plain({})); }
  `);
  const nativeMethodConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeMethodConstraint.status, 1);
  assert.match(nativeMethodConstraint.stderr, /Plain does not satisfy model\.Measured for T in "Utility\.inspect"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 {
      const holder = model.Holder({ value: model.Plain({}) });
      return 0;
    }
  `);
  const nativeAggregateConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeAggregateConstraint.status, 1);
  assert.match(nativeAggregateConstraint.stderr, /Plain does not satisfy model\.Measured for T in "Holder"/);

  const invalidBody = resolve(directory, "invalid-body.zs");
  writeFileSync(invalidBody, `
    trait Measured { function measure(): i32; }
    function reveal<T: Measured>(value: T): i32 { return value.secret(); }
    function main(): i32 { return 0; }
  `);
  const nativeOutsideSurface = spawnSync(process.execPath, [cli, "self-host-resolve", invalidBody], { encoding: "utf8" });
  assert.equal(nativeOutsideSurface.status, 1);
  assert.match(
    nativeOutsideSurface.stderr,
    /member "secret" is not provided by the trait constraints on T/,
  );

  const typeUse = resolve(directory, "type-use.zs");
  writeFileSync(typeUse, `
    import { Measured, Holder, Reading } from "./model.zs";
    function retain<T: Measured>(value: Holder<T>): i32 { return 1; }
    function inspect(value: Option<Holder<Reading>>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeValidTypeUse = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeValidTypeUse.status, 0, nativeValidTypeUse.stderr);

  writeFileSync(typeUse, `
    import { Holder, Plain } from "./model.zs";
    function inspect(value: Option<Holder<Plain>>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidTypeUse = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidTypeUse.status, 1);
  assert.match(
    nativeInvalidTypeUse.stderr,
    /Plain does not satisfy Measured for T in "Holder"/,
  );

  writeFileSync(typeUse, `
    import { Holder } from "./model.zs";
    function inspect(value: Holder<i32, i32>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidTypeArity = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidTypeArity.status, 1);
  assert.match(nativeInvalidTypeArity.stderr, /Holder expects 1 type argument\(s\), received 2/);

  writeFileSync(typeUse, `
    import { Holder } from "./model.zs";
    function inspect(value: Holder): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeMissingTypeArgument = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeMissingTypeArgument.status, 1);
  assert.match(nativeMissingTypeArgument.stderr, /Holder expects 1 type argument\(s\), received 0/);

  writeFileSync(typeUse, `
    import { Holder, Plain } from "./model.zs";
    function inspect(callback: (value: Holder<Plain>) => i32): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidFunctionType = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidFunctionType.status, 1);
  assert.match(
    nativeInvalidFunctionType.stderr,
    /Plain does not satisfy Measured for T in "Holder"/,
  );

  writeFileSync(typeUse, `
    function inspect(value: Option<i32, i32>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeIntrinsicTypeArity = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeIntrinsicTypeArity.status, 1);
  assert.match(nativeIntrinsicTypeArity.stderr, /Option expects 1 type argument\(s\), received 2/);
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
  assert.match(compileToC(valid, "generic-multiple-constraints.zs"), /__z_mono_Holder_Reading/);

  const invalidAggregate = `
    trait Measured { function measure(): i32; }
    struct Plain {}
    struct Holder<T: Measured> { value: T; }
    function main(): i32 { const holder = Holder<Plain>({ value: Plain({}) }); return 0; }
  `;
  assert.throws(
    () => compileToC(invalidAggregate, "generic-aggregate-constraint.zs"),
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
    hover(source.replace(" rea;", ""), "generic-constraint-editor.zs", declaration + 1)?.contents.value ?? "",
    /function read<T: Measured>\(value: T\): i32/,
  );
  const offset = source.indexOf("rea;") + 3;
  assert.equal(
    completions(source, "generic-constraint-editor.zs", offset).find((item) => item.label === "read")?.detail,
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
  const items = completions(source, "generic-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "identity")?.detail, "function identity<T>");
  assert.equal(items.some((item) => item.label.startsWith("__z_mono_")), false);
  const declaration = source.indexOf("identity<T>");
  assert.match(hover(source.replace(" ide;", ""), "generic-editor.zs", declaration + 1)?.contents.value ?? "", /function identity<T>/);
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
  assert.match(hover(source, "generic-hover.zs", firstField + 1)?.contents.value ?? "", /first: T/);
  assert.match(hover(source, "generic-hover.zs", secondField + 1)?.contents.value ?? "", /second: T/);
  assert.match(hover(source, "generic-hover.zs", firstInitializer + 1)?.contents.value ?? "", /first: i32/);
  assert.match(hover(source, "generic-hover.zs", secondInitializer + 1)?.contents.value ?? "", /second: i32/);
  const pairHover = hover(source, "generic-hover.zs", pairBinding + 1)?.contents.value ?? "";
  assert.match(pairHover, /pair: Pair<i32>/);
  assert.doesNotMatch(pairHover, /__z_mono_/);
  const beforeFirst = source.slice(0, firstField).split("\n");
  const firstToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.zs").data).find((token) => (
    token.line === beforeFirst.length - 1 && token.character === beforeFirst.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[firstToken?.type ?? -1], "property");
  const beforeInitializer = source.slice(0, firstInitializer).split("\n");
  const initializerToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.zs").data).find((token) => (
    token.line === beforeInitializer.length - 1 && token.character === beforeInitializer.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[initializerToken?.type ?? -1], "property");
});

test("grows owned Array values with checked indexing and generic inout mutation", () => {
  const example = resolve(projectRoot, "examples/language/collections/dynamic-arrays.zs");
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
  const generated = compileToC(source, "dynamic-array-slice.zs");
  assert.match(generated, /\.data = \(values\)\.data, \.length = \(values\)\.length/);
  assert.match(generated, /__z_mono_first_i32/);
});

test("specializes generic Array mutation helpers for every element type", () => {
  const source = `
    function append<T>(inout values: Array<T>, value: T): void { values.push(value); }
    function main(): i32 {
      let numbers = Array<i32>();
      let flags = Array<boolean>();
      append(inout numbers, 42);
      append(inout flags, true);
      if (flags[0]) { return numbers[0]; }
      return 0;
    }
  `;
  const generated = compileToC(source, "dynamic-array-specializations.zs");
  assert.match(generated, /DynamicArray_.*i32.*_push/);
  assert.match(generated, /DynamicArray_.*boolean.*_push/);
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
  const generated = compileToC(source, "nested-dynamic-arrays.zs");
  assert.match(generated, /Z_DynamicArray_.*Z_DynamicArray_/);
  assert.match(generated, /free\(\(\(outer\)\.data\[/);
});

test("moves Array storage and destroys initialized owned elements in reverse order", () => {
  const example = resolve(projectRoot, "examples/language/collections/dynamic-array-cleanup.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=2\ndrop=1\n");
  assert.throws(
    () => compileToC(source.replace("  return 0;", "  return first.id;"), "dynamic-array-move.zs"),
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
  assert.throws(() => compileToC(movedArray, "dynamic-array-owner-move.zs"), /use of moved value "first"/);
});

test("checks Array mutation, element types, and partial moves", () => {
  const empty = `
    function main(): i32 { const values = Array<i32>(); return 0; }
  `;
  const emptyGenerated = compileToC(empty, "dynamic-array-empty.zs");
  assert.doesNotMatch(emptyGenerated, /DynamicArray_.*_push\(/);

  const immutable = `
    function main(): i32 {
      const values = Array<i32>();
      values.push(1);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutable, "dynamic-array-const.zs"), /Array.push requires addressable let storage/);

  const wrongElement = `
    function main(): i32 {
      let values = Array<i32>();
      values.push(true);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "dynamic-array-element.zs"), /expected i32, found boolean/);

  const partialMove = `
    struct Item { id: i32; deinit {} }
    function main(): i32 {
      let values = Array<Item>();
      values.push(Item({ id: 1 }));
      const item = values[0];
      return item.id;
    }
  `;
  assert.throws(() => compileToC(partialMove, "dynamic-array-partial-move.zs"), /cannot move an ownership-bearing field or element out of its owner/);
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
  const items = completions(source, "dynamic-array-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");
  assert.equal(items.find((item) => item.label === "capacity")?.detail, "usize");
  assert.match(items.find((item) => item.label === "push")?.detail ?? "", /push\(value: i32\): void/);

  const valid = source.replace("      values.;", "      values.push(1);");
  const declaration = valid.indexOf("values =");
  assert.match(hover(valid, "dynamic-array-editor.zs", declaration + 1)?.contents.value ?? "", /values: Array<i32>/);
  const push = valid.indexOf("push(1)");
  assert.match(hover(valid, "dynamic-array-editor.zs", push + 1)?.contents.value ?? "", /push\(value: i32\): void/);
});

test("owns Map keys and values with optional views and deterministic removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/map.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Map.*_get\(const .*\*self, Z_String key\)/);
  assert.match(generated, /return &self->entries\.data\[stored - 1\]\.value/);
  assert.match(generated, /Map.*_rehash/);
  assert.match(generated, /self->buckets\.data\[slot\] = self->entries\.length/);
  assert.match(generated, /Map.*_remove/);
  assert.match(generated, /Map.*_delete/);
  assert.match(generated, /MapEntry.*_deinit/);
  assert.match(generated, /< \(users\)\.entries\.length/);
  assert.match(generated, /const Z_User \*value = &/);

  const directory = mkdtempSync("/tmp/z-map-cleanup-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    import { Map } from "std/collections";
    import console from "std/console";
    struct Resource {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    function main(): i32 {
      let resources = Map<i32, Resource>();
      resources.set(1, Resource({ id: 1 }));
      resources.set(1, Resource({ id: 2 }));
      if (!resources.has(1) || resources.length != 1) return 1;
      resources.clear();
      if (resources.length != 0) return 1;
      resources.set(2, Resource({ id: 3 }));
      if (!resources.delete(2)) return 1;
      if (resources.delete(2)) return 1;
      return 0;
    }
  `);
  const cleanup = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(cleanup.stdout, "drop=1\ndrop=2\ndrop=3\n");

  writeFileSync(input, `
    import { Map } from "std/collections";
    enum Key { first, second }
    function main(): i32 {
      let flags = Map<Key, boolean>();
      flags.set(Key.first, true);
      if (flags.has(Key.first) && !flags.has(Key.second)) return 0;
      return 1;
    }
  `);
  const enumKey = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(enumKey.status, 0, enumKey.stderr);

  const borrowed = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      values.set("other", 1);
      return match (in found) { some(value) => value; none => 0; };
    }
  `;
  const borrowDiagnostic = diagnostics(borrowed, "map-view-mutation.zs")[0];
  assert.equal(borrowDiagnostic.code, "Z0205");
  assert.match(borrowDiagnostic.message, /cannot set "values" while view/);

  const iterationMutation = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      for (const entry of values) {
        values.delete(entry.key);
      }
      return 0;
    }
  `;
  const iterationMutationDiagnostic = diagnostics(iterationMutation, "map-iteration-mutation.zs")[0];
  assert.equal(iterationMutationDiagnostic.code, "Z0311");
  assert.match(iterationMutationDiagnostic.message, /cannot structurally mutate Map "values" while for\.\.\.of is borrowing it/);

  const iterationMove = iterationMutation.replace(
    "values.delete(entry.key);",
    "const taken = move entry;",
  );
  const iterationMoveDiagnostic = diagnostics(iterationMove, "map-iteration-move.zs")[0];
  assert.equal(iterationMoveDiagnostic.code, "Z0203");
  assert.match(iterationMoveDiagnostic.message, /cannot move borrowed iteration binding "entry"/);

  const copyableView = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      const answer = match (in found) {
        some(value) => value;
        none => 0;
      };
      return answer - 42;
    }
  `;
  assert.deepEqual(diagnostics(copyableView, "map-copyable-view.zs"), []);
  const copyableGenerated = compileToC(copyableView, "map-copyable-view.zs");
  assert.match(copyableGenerated, /\*\(value\)/);
  writeFileSync(input, copyableView);
  const copyableResult = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(copyableResult.status, 0, copyableResult.stderr);

  const selectedView = copyableView.replace(
    "some(value) => value;",
    "some(value) => { select value; }",
  );
  assert.deepEqual(diagnostics(selectedView, "map-selected-view.zs"), []);

  const conditionalView = copyableView.replace(
    "some(value) => value;",
    "some(value) => (if (true) { select value; } else { select 0; });",
  );
  assert.deepEqual(diagnostics(conditionalView, "map-conditional-view.zs"), []);

  const directReturnView = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      return match (in found) {
        some(value) => value;
        none => 0;
      };
    }
  `;
  assert.deepEqual(diagnostics(directReturnView, "map-direct-return-view.zs"), []);

  const ownedView = `
    import { Map } from "std/collections";
    struct Resource {
      id: i32;
      deinit {}
    }
    function take(in resources: Map<i32, Resource>): Resource {
      const found = resources.get(1);
      return match (in found) {
        some(value) => value;
        none => Resource({ id: 0 });
      };
    }
    function main(): i32 { return 0; }
  `;
  assert.match(
    diagnostics(ownedView, "map-owned-view.zs")[0].message,
    /expected Resource, found view Resource/,
  );

  const immutable = `
    import { Map } from "std/collections";
    function main(): i32 {
      const values = Map<i32, i32>();
      values.set(1, 2);
      return 0;
    }
  `;
  assert.match(diagnostics(immutable, "map-const.zs")[0].message, /Map\.set requires addressable let storage/);

  const movedKey = `
    import { Map } from "std/collections";
    function key(): String { return \`owned key\`; }
    function main(): i32 {
      let values = Map<String, i32>();
      const name = key();
      values.set(name, 42);
      return name.byteLength;
    }
  `;
  assert.match(diagnostics(movedKey, "map-moved-key.zs")[0].message, /use of moved value "name"/);

  const unsupportedKey = `
    import { Map } from "std/collections";
    function main(): i32 { const values = Map<f64, i32>(); return 0; }
  `;
  assert.match(diagnostics(unsupportedKey, "map-float-key.zs")[0].message, /key type "f64" is not hashable/);

  writeFileSync(input, `
    import { Map } from "std/collections";
    import console from "std/console";
    class Session {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    function main(): i32 {
      let values = Map<i32, Session>();
      const first = new Session({ id: 1 });
      values.set(1, first);
      const found = values.get(1);
      const observed = match (in found) {
        some(session) => session.id;
        none => 0;
      };
      if (observed != 1 || first.id != 1) return 1;
      values.set(1, new Session({ id: 2 }));
      const removed = values.remove(1);
      const removedID = match (in removed) {
        some(session) => session.id;
        none => 0;
      };
      if (removedID != 2 || values.length != 0) return 1;
      return 0;
    }
  `);
  const identity = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(identity.status, 0, identity.stderr);
  assert.equal(identity.stdout, "drop=2\ndrop=1\n");

  const missingImport = `function main(): i32 { const values = Map<i32, i32>(); return 0; }`;
  assert.match(diagnostics(missingImport, "map-import.zs")[0].message, /Map requires an explicit standard-library import/);
});

test("hashes readonly nominal keys through the standard Hashable contract", () => {
  const example = resolve(projectRoot, "examples/language/collections/custom-hash.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(generated, /typedef struct \{\n  uint64_t state;\n\} Z_Hasher/);
  assert.match(generated, /Z_ProjectKey_equals\(&left, &right\)/);
  assert.match(generated, /Z_ProjectKey_hash\(&value, &hasher\)/);
  assert.match(generated, /z_hasher_add_string/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const moduleDirectory = mkdtempSync("/tmp/z-hashable-module-");
  writeFileSync(resolve(moduleDirectory, "key.zs"), `
    import { Hashable, Hasher } from "std/hash";
    export readonly struct ProjectKey implements Hashable {
      id: i32;
      function equals(in other: ProjectKey): boolean { return this.id == other.id; }
      function hash(inout hasher: Hasher): void { hasher.add(this.id); }
    }
  `);
  const moduleMain = resolve(moduleDirectory, "main.zs");
  writeFileSync(moduleMain, `
    import { Map } from "std/collections";
    import { ProjectKey } from "./key.zs";
    function main(): i32 {
      let values = Map<ProjectKey, i32>();
      values.set(ProjectKey({ id: 7 }), 42);
      const found = values.get(ProjectKey({ id: 7 }));
      return match (in found) { some(value) => value - 42; none => 1; };
    }
  `);
  const moduleResult = spawnSync(process.execPath, [cli, "run", moduleMain], { encoding: "utf8" });
  assert.equal(moduleResult.status, 0, moduleResult.stderr);

  const mutable = source.replace("readonly struct ProjectKey", "struct ProjectKey");
  const mutableDiagnostic = diagnostics(mutable, "mutable-hash-key.zs")[0];
  assert.equal(mutableDiagnostic.code, "Z0401");
  assert.match(mutableDiagnostic.message, /must be readonly to preserve its stored hash/);

  const missingMethod = source.replace(
    "  function hash(inout hasher: Hasher): void {\n    hasher.add(this.workspace);\n    hasher.add(this.path);\n  }\n",
    "",
  );
  assert.match(diagnostics(missingMethod, "incomplete-hashable.zs")[0].message, /does not implement Hashable\.hash/);

  const invalidFeed = source.replace("hasher.add(this.path);", "hasher.add(1.5);");
  assert.match(diagnostics(invalidFeed, "invalid-hash-feed.zs")[0].message, /Hasher\.add cannot hash "f64"/);

  const partialImport = source.replace("Hashable, Hasher", "Hash, Hasher");
  const importOffset = partialImport.indexOf("Hash, Hasher") + "Hash".length;
  assert.equal(completions(partialImport, example, importOffset).find((item) => item.label === "Hashable")?.kind, 8);

  const addOffset = source.indexOf("hasher.add(this.workspace)") + "hasher.".length;
  assert.match(completions(source, example, addOffset).find((item) => item.label === "add")?.detail ?? "", /one hash component/);
  assert.match(hover(source, example, source.indexOf("add(this.workspace)") + 1)?.contents.value ?? "", /feeds a supported scalar/);
});

test("supports explicit copy and move ownership expressions", () => {
  const source = `
    struct Document {
      title: String;
    }

    struct Library {
      document: Document;

      function current(): view Document {
        return this.document;
      }
    }

    function main(): i32 {
      const library = Library({ document: Document({ title: "draft" }) });
      const snapshot = copy library.current();
      const transferred = move library;
      if (snapshot.title.byteLength == 5 && transferred.document.title.byteLength == 5) return 0;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(source, "explicit-copy-move.zs"), []);
  const generated = compileToC(source, "explicit-copy-move.zs");
  assert.match(generated, /Z_Document snapshot = z_copy_Document\(/);
  assert.match(generated, /z_string_copy\(source\.title\)/);
  assert.match(generated, /_z_live_library_[0-9]+ = false/);
  const copyHover = hover(source, "explicit-copy-move.zs", source.indexOf("copy library"))?.contents.value ?? "";
  assert.match(copyHover, /copy view Document -> Document/);
  assert.match(copyHover, /compiler-synthesized from copyable fields and payloads/);
  assert.match(copyHover, /materializes an owned Document from borrowed storage/);
  assert.match(copyHover, /allocates for owned strings or growable buffers/);
  const moveHover = hover(source, "explicit-copy-move.zs", source.indexOf("move library"))?.contents.value ?? "";
  assert.match(moveHover, /move Library -> Library/);
  assert.match(moveHover, /named source becomes unavailable/);
  assert.match(moveHover, /owned fields are not cloned/);
  const directory = mkdtempSync("/tmp/z-explicit-copy-move-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const copyKeepsSource = `
    function main(): i32 {
      const value = 21;
      const snapshot = copy value;
      return value + snapshot - 42;
    }
  `;
  assert.deepEqual(diagnostics(copyKeepsSource, "explicit-trivial-copy.zs"), []);

  const contextualKeywords = `
    function copy(value: i32): i32 { return value + 1; }
    function move(value: i32): i32 { return value + 1; }
    function main(): i32 {
      const value = move(copy(40));
      const text = "ready";
      const copy = copy text;
      const move = move copy;
      if (move.byteLength == 5) return value - 42;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(contextualKeywords, "contextual-copy-move.zs"), []);
  const contextualOwnershipTokens = decodeSemanticTokens(
    semanticTokens(contextualKeywords, "contextual-copy-move.zs").data,
  );
  const copyBindingOffset = contextualKeywords.indexOf("const copy") + "const ".length;
  const copyOperatorOffset = contextualKeywords.indexOf("= copy") + 2;
  const copyBindingPosition = positionForOffset(contextualKeywords, copyBindingOffset);
  const copyOperatorPosition = positionForOffset(contextualKeywords, copyOperatorOffset);
  assert.ok(contextualOwnershipTokens.some((token) => (
    token.line === copyBindingPosition.line
    && token.character === copyBindingPosition.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));
  assert.ok(!contextualOwnershipTokens.some((token) => (
    token.line === copyOperatorPosition.line
    && token.character === copyOperatorPosition.character
  )));
  const moveUseOffset = contextualKeywords.indexOf("move.byteLength");
  assert.match(
    hover(contextualKeywords, "contextual-copy-move.zs", moveUseOffset)?.contents.value ?? "",
    /move: String/,
  );

  const recursiveCopies = `
    enum Label { present String, missing }
    function main(): i32 {
      let names = Array<String>();
      names.push("first");
      const copiedNames = copy names;
      names.push("second");

      const label = Label.present("draft");
      const copiedLabel = copy label;
      const firstLength: usize = match (in label) {
        present(value) => value.byteLength;
        missing => names.length;
      };
      const secondLength: usize = match (in copiedLabel) {
        present(value) => value.byteLength;
        missing => copiedNames.length;
      };
      if (names.length == 2 && copiedNames.length == 1 && firstLength == secondLength) return 0;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(recursiveCopies, "explicit-recursive-copy.zs"), []);
  const recursiveInput = resolve(directory, "recursive.zs");
  writeFileSync(recursiveInput, recursiveCopies);
  const recursiveResult = spawnSync(process.execPath, [cli, "run", recursiveInput], { encoding: "utf8" });
  assert.equal(recursiveResult.status, 0, recursiveResult.stderr);

  const useAfterMove = source.replace(
    "if (snapshot.title.byteLength == 5 && transferred.document.title.byteLength == 5) return 0;",
    "if (library.document.title.byteLength == 5) return 0;",
  );
  const movedDiagnostic = diagnostics(useAfterMove, "explicit-use-after-move.zs")[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "library"/);

  const meaninglessMove = diagnostics(`
    function main(): i32 {
      const value = 42;
      const transferred = move value;
      return transferred;
    }
  `, "explicit-scalar-move.zs")[0];
  assert.equal(meaninglessMove.code, "Z0218");
  assert.match(meaninglessMove.message, /has no unique ownership to move/);

  const uncopyable = diagnostics(`
    struct Resource {
      id: i32;
      deinit {}
    }
    function main(): i32 {
      const resource = Resource({ id: 42 });
      const duplicate = copy resource;
      return duplicate.id;
    }
  `, "explicit-uncopyable.zs")[0];
  assert.equal(uncopyable.code, "Z0217");
  assert.match(uncopyable.message, /cannot be explicitly copied/);
});

test("exposes Map imports, members, and source-level types to editor services", () => {
  const source = `
    import { Map as Dictionary } from "std/collections";
    function main(): i32 {
      let users = Dictionary<String, i32>();
      users.;
      return 0;
    }
  `;
  const importItems = completions(
    source.replace("Map as Dictionary", "Ma"),
    "map-editor.zs",
    source.indexOf("Map as Dictionary") + 2,
  );
  assert.equal(importItems.find((item) => item.label === "Map")?.kind, 22);

  const offset = source.indexOf("users.;") + "users.".length;
  const items = completions(source, "map-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "length: usize");
  assert.match(items.find((item) => item.label === "get")?.detail ?? "", /Option<view i32>/);
  assert.match(items.find((item) => item.label === "remove")?.detail ?? "", /Option<i32>/);
  assert.match(items.find((item) => item.label === "delete")?.detail ?? "", /boolean.*destroys/);

  const valid = source.replace("      users.;", "      users.set(\"answer\", 42);");
  const binding = valid.indexOf("users =");
  assert.match(hover(valid, "map-editor.zs", binding + 1)?.contents.value ?? "", /users: Map<String, i32>/);
  const method = valid.indexOf("set(\"answer") + 1;
  assert.match(hover(valid, "map-editor.zs", method)?.contents.value ?? "", /set\(key: String, value: i32\): void/);

  const identitySource = `
    import { Map } from "std/collections";
    class Session { id: i32; }
    function main(): i32 {
      let sessions = Map<i32, Session>();
      sessions.;
      return 0;
    }
  `;
  const identityOffset = identitySource.indexOf("sessions.;") + "sessions.".length;
  const identityItems = completions(identitySource, "map-identity-editor.zs", identityOffset);
  assert.match(identityItems.find((item) => item.label === "get")?.detail ?? "", /Option<Session>/);
  assert.doesNotMatch(identityItems.find((item) => item.label === "get")?.detail ?? "", /view Session/);

  const iteration = `
    import { Map } from "std/collections";
    function main(): i32 {
      let users = Map<String, i32>();
      for (const entry of users) {
        entry.;
      }
      return 0;
    }
  `;
  const entryOffset = iteration.indexOf("entry.;") + "entry.".length;
  const entryItems = completions(iteration, "map-iteration-editor.zs", entryOffset);
  assert.equal(entryItems.find((item) => item.label === "key")?.detail, "String");
  assert.equal(entryItems.find((item) => item.label === "value")?.detail, "i32");
  const validIteration = iteration.replace("entry.;", "const observed = entry.value;");
  const entryBinding = validIteration.indexOf("entry of");
  assert.match(hover(validIteration, "map-iteration-editor.zs", entryBinding + 1)?.contents.value ?? "", /entry: Map\.Entry<String, i32>/);
});

test("moves native C++ values through Map storage and owned removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/map-native-values.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToNative(source, example).source;
  assert.match(generated, /std::construct_at\(&self->entries\.data\[index\]\.value, std::move\(value\)\)/);
  assert.match(generated, /::make_some\(std::move\(self->entries\.data\[index\]\.value\)\)/);
  assert.match(generated, /std::destroy_at\(&self->entries\.data\[last\]\)/);
  assert.match(generated, /return &self->entries\.data\[stored - 1\]\.value/);

  const getOffset = source.indexOf("get(\"primary") + 1;
  assert.match(hover(source, example, getOffset)?.contents.value ?? "", /Option<view native\.zcpp\.UniqueValue>/);

  const moved = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Map<String, native.zcpp.UniqueValue>();
      const resource = native.zcpp.UniqueValue(42);
      values.set("answer", resource);
      return resource.value();
    }
  `;
  assert.equal(diagnostics(moved, example)[0]?.code, "Z0201");

  const borrowed = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Map<String, native.zcpp.UniqueValue>();
      values.set("answer", native.zcpp.UniqueValue(42));
      const found = values.get("answer");
      values.delete("answer");
      return match (in found) { some(resource) => resource.value(); none => 0; };
    }
  `;
  assert.equal(diagnostics(borrowed, example)[0]?.code, "Z0205");

  const copyOnly = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/foreign-values.hpp";
    function main(): i32 {
      const values = Map<i32, native.zcpp.ManagedValue>();
      return 0;
    }
  `;
  assert.match(diagnostics(copyOnly, example)[0]?.message ?? "", /must provide move construction/);
});

test("owns unique Set values with insertion status and deterministic removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/set.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Set.*_add\(.*\*self, Z_String value\)/);
  assert.match(generated, /if \(\(value\)\.capacity > 0\) free/);
  assert.match(generated, /Set.*_remove/);
  assert.match(generated, /Set.*_delete/);
  assert.match(generated, /Set.*_rehash/);
  assert.match(generated, /self->values\.data\[last\] = \(Z_String\)\{ 0 \}/);
  assert.match(generated, /< \(openDocuments\)\.values\.length/);
  assert.match(generated, /const Z_String \*path = &/);

  const directory = mkdtempSync("/tmp/z-set-runtime-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    import { Set } from "std/collections";
    enum Permission { read, write }
    function main(): i32 {
      let permissions = Set<Permission>();
      if (!permissions.add(Permission.read)) return 1;
      if (permissions.add(Permission.read)) return 2;
      if (!permissions.has(Permission.read) || permissions.has(Permission.write)) return 3;
      const removed = permissions.remove(Permission.read);
      return match (removed) { some(value) => value == Permission.read ? 0 : 4; none => 5; };
    }
  `);
  const enumElement = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(enumElement.status, 0, enumElement.stderr);

  const immutable = `
    import { Set } from "std/collections";
    function main(): i32 {
      const values = Set<i32>();
      values.add(1);
      return 0;
    }
  `;
  assert.match(diagnostics(immutable, "set-const.zs")[0].message, /Set\.add requires addressable let storage/);

  const movedValue = `
    import { Set } from "std/collections";
    function name(): String { return \`owned value\`; }
    function main(): i32 {
      let values = Set<String>();
      const item = name();
      values.add(item);
      return item.byteLength;
    }
  `;
  assert.match(diagnostics(movedValue, "set-moved-value.zs")[0].message, /use of moved value "item"/);

  const iterationMutation = `
    import { Set } from "std/collections";
    function main(): i32 {
      let values = Set<String>();
      values.add("ready");
      for (const value of values) {
        values.add(copy value);
      }
      return 0;
    }
  `;
  const iterationMutationDiagnostic = diagnostics(iterationMutation, "set-iteration-mutation.zs")[0];
  assert.equal(iterationMutationDiagnostic.code, "Z0311");
  assert.match(iterationMutationDiagnostic.message, /cannot structurally mutate Set "values" while for\.\.\.of is borrowing it/);

  const unsupportedElement = `
    import { Set } from "std/collections";
    function main(): i32 { const values = Set<f64>(); return 0; }
  `;
  assert.match(diagnostics(unsupportedElement, "set-float-element.zs")[0].message, /element type "f64" is not hashable/);

  const missingImport = `function main(): i32 { const values = Set<i32>(); return 0; }`;
  assert.match(diagnostics(missingImport, "set-import.zs")[0].message, /Set requires an explicit standard-library import/);
});

test("exposes Set imports, members, and source-level types to editor services", () => {
  const source = `
    import { Set as UniqueValues } from "std/collections";
    function main(): i32 {
      let values = UniqueValues<String>();
      values.;
      return 0;
    }
  `;
  const importItems = completions(
    source.replace("Set as UniqueValues", "Se"),
    "set-editor.zs",
    source.indexOf("Set as UniqueValues") + 2,
  );
  assert.equal(importItems.find((item) => item.label === "Set")?.kind, 22);

  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "set-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "length: usize");
  assert.match(items.find((item) => item.label === "add")?.detail ?? "", /add\(value: String\): boolean/);
  assert.match(items.find((item) => item.label === "remove")?.detail ?? "", /Option<String>/);
  assert.match(items.find((item) => item.label === "delete")?.detail ?? "", /boolean.*destroys/);

  const valid = source.replace("      values.;", "      values.add(\"ready\");");
  const binding = valid.indexOf("values =");
  assert.match(hover(valid, "set-editor.zs", binding + 1)?.contents.value ?? "", /values: Set<String>/);
  const method = valid.indexOf("add(\"ready") + 1;
  assert.match(hover(valid, "set-editor.zs", method)?.contents.value ?? "", /add\(value: String\): boolean/);

  const iteration = `
    import { Set } from "std/collections";
    function main(): i32 {
      let values = Set<String>();
      for (const value of values) {
        value.;
      }
      return 0;
    }
  `;
  const valueOffset = iteration.indexOf("value.;") + "value.".length;
  const valueItems = completions(iteration, "set-iteration-editor.zs", valueOffset);
  assert.equal(valueItems.find((item) => item.label === "byteLength")?.detail, "usize  // UTF-8 storage bytes");
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

test("runs cold synchronous generators with deterministic suspended-frame cleanup", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/generators.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "generator created\ngenerator started\nnote 1\nnote 2\nnote 3\n");

  const generated = compileToC(source, example);
  assert.match(generated, /Z_GeneratorFrame_noteIdentifiers/);
  assert.match(generated, /switch \(frame->state\)/);
  assert.match(generated, /case 1: goto _z_generator_resume_1;/);
  assert.match(generated, /_z_generator_resume_1: ;/);
  assert.match(generated, /_Generator_.*_next\(&\(identifiers\)\)/);
  assert.doesNotMatch(generated, /_z_iterator_0 = identifiers/);

  const cleanupDirectory = mkdtempSync("/tmp/z-generator-cleanup-");
  const cleanupFile = resolve(cleanupDirectory, "cleanup.zs");
  const cleanupSource = `
    import console from "std/console";
    import { Generator } from "std/iteration";
    struct CursorLease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    function values(): Generator<i32> {
      const lease = CursorLease({ id: 42 });
      yield 20;
      yield 22;
    }
    function unstarted(lease: CursorLease): Generator<i32> {
      yield lease.id;
    }
    function main(): i32 {
      {
        const abandoned = unstarted(CursorLease({ id: 7 }));
      }
      const sequence = values();
      const first = sequence.next();
      for (const value of sequence) {
        console.log(value);
        break;
      }
      return match (first) {
        some(value) => value - 20;
        none => 1;
      };
    }
  `;
  writeFileSync(cleanupFile, cleanupSource);
  const cleanupResult = spawnSync(process.execPath, [cli, "run", cleanupFile], { encoding: "utf8" });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(cleanupResult.stdout, "released 7\n22\nreleased 42\n");

  const exhaustionFile = resolve(cleanupDirectory, "exhaustion.zs");
  const exhaustionSource = cleanupSource.replace("        break;\n", "");
  writeFileSync(exhaustionFile, exhaustionSource);
  const exhaustionResult = spawnSync(process.execPath, [cli, "run", exhaustionFile], { encoding: "utf8" });
  assert.equal(exhaustionResult.status, 0, exhaustionResult.stderr);
  assert.equal(exhaustionResult.stdout, "released 7\n22\nreleased 42\n");

  const persistentControlFlowFile = resolve(cleanupDirectory, "persistent-control-flow.zs");
  writeFileSync(persistentControlFlowFile, `
    import console from "std/console";
    import { Generator } from "std/iteration";
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    enum Choice {
      item Lease,
      empty,
    }
    class Session {
      id: i32;
    }
    function repeated(choice: Choice): Generator<i32> {
      match (choice) {
        item(lease) => {
          yield lease.id;
          yield lease.id;
        }
        empty => {}
      }
    }
    function indexed(values: Array<i32>): Generator<i32> {
      for (const value of values) {
        yield value;
        yield value + 1;
      }
    }
    function optional(value: Option<Session>): Generator<i32> {
      match (in value) {
        some(session) => {
          yield session.id;
          yield session.id;
        }
        none => {}
      }
    }
    function main(): i32 {
      const matched = repeated(Choice.item(Lease({ id: 20 })));
      const first = matched.next();
      const second = matched.next();
      let values = Array<i32>();
      values.push(21);
      const looped = indexed(move values);
      const third = looped.next();
      const fourth = looped.next();
      const optionalValues = optional(Option.some(new Session({ id: 21 })));
      const fifth = optionalValues.next();
      const sixth = optionalValues.next();
      const firstValue = match (first) { some(value) => value; none => 0; };
      const secondValue = match (second) { some(value) => value; none => 0; };
      const thirdValue = match (third) { some(value) => value; none => 0; };
      const fourthValue = match (fourth) { some(value) => value; none => 0; };
      const fifthValue = match (fifth) { some(value) => value; none => 0; };
      const sixthValue = match (sixth) { some(value) => value; none => 0; };
      return firstValue + secondValue + thirdValue + fourthValue + fifthValue + sixthValue - 125;
    }
  `);
  const persistentControlFlow = spawnSync(
    process.execPath,
    [cli, "run", persistentControlFlowFile],
    { encoding: "utf8" },
  );
  assert.equal(persistentControlFlow.status, 0, persistentControlFlow.stderr);
  assert.equal(persistentControlFlow.stdout, "released 20\n");
  const persistentGenerated = compileToC(
    readFileSync(persistentControlFlowFile, "utf8"),
    persistentControlFlowFile,
  );
  assert.match(persistentGenerated, /uintptr_t _z_for_index_/);
  assert.match(persistentGenerated, /_z_match_binding_.*_live/);

  const native = spawnSync(process.execPath, [cli, "check", example, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid/);

  const generatorOffset = source.indexOf("Generator<i32>");
  assert.match(hover(source, example, generatorOffset + 1)?.contents.value ?? "", /Generator<Yield, Return\?, Error\?>.*cold, move-only/s);
  const yieldOffset = source.indexOf("yield identifier");
  assert.match(hover(source, example, yieldOffset + 1)?.contents.value ?? "", /suspends the current Generator/);
  const identifiersOffset = source.indexOf("identifiers =");
  assert.match(hover(source, example, identifiersOffset + 1)?.contents.value ?? "", /identifiers: Generator<i32>/);

  const importSource = `import { Gen } from "std/iteration"; function main(): i32 { return 0; }`;
  const importOffset = importSource.indexOf("Gen") + 3;
  assert.equal(
    completions(importSource, "generator-import-completion.zs", importOffset).find((item) => item.label === "Generator")?.kind,
    22,
  );
  const memberSource = cleanupSource.replace("sequence.next()", "sequence.ne");
  const memberOffset = memberSource.indexOf("sequence.ne") + "sequence.ne".length;
  assert.equal(
    completions(memberSource, cleanupFile, memberOffset).find((item) => item.label === "next")?.detail,
    "next(): Option<i32>  // advances the suspended frame",
  );
  const nextOffset = cleanupSource.indexOf("next()");
  assert.match(hover(cleanupSource, cleanupFile, nextOffset + 1)?.contents.value ?? "", /next\(\): Option<i32>/);

  const forwarding = compileToC(`
    import { Generator } from "std/iteration";
    function values(): Generator<i32> { yield 42; }
    function forwarded(): Generator<i32> { return values(); }
    function main(): i32 {
      for (const value of forwarded()) { return value - 42; }
      return 1;
    }
  `, "generator-forwarding.zs");
  assert.match(forwarding, /Z_GeneratorFrame_values/);
  assert.doesNotMatch(forwarding, /Z_GeneratorFrame_forwarded/);

  const genericIteratorFile = resolve(cleanupDirectory, "generic-iterator.zs");
  writeFileSync(genericIteratorFile, `
    import { Generator, Iterator } from "std/iteration";
    function values(): Generator<i32> { yield 42; }
    function first<I: Iterator<i32>>(inout iterator: I): i32 {
      return match (iterator.next()) {
        some(value) => value;
        none => 0;
      };
    }
    function main(): i32 {
      let sequence = values();
      return first(inout sequence) - 42;
    }
  `);
  const genericIteratorResult = spawnSync(process.execPath, [cli, "run", genericIteratorFile], { encoding: "utf8" });
  assert.equal(genericIteratorResult.status, 0, genericIteratorResult.stderr);

  assert.throws(
    () => compileToC(`function main(): i32 { yield 42; return 0; }`, "yield-outside-generator.zs"),
    /yield requires a function returning Generator<T>/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function values(): Generator<i32> { yield 1; return 42; }
      function main(): i32 { return 0; }
    `, "generator-return-value.zs"),
    /a generator finishes with `return;` and cannot return a value/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function values(in source: i32): Generator<i32> { yield source; }
      function main(): i32 { return 0; }
    `, "generator-borrowed-input.zs"),
    /a cold generator cannot retain borrowed parameter storage/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function inner(): Generator<i32> { yield 42; }
      function outer(): Generator<i32> {
        for (const value of inner()) { yield value; }
      }
      function main(): i32 { return 0; }
    `, "generator-custom-iterator-suspension.zs"),
    /yield inside custom Iterator for\.\.\.of is deferred/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      enum Choice { value i32, empty, }
      function values(choice: Choice): Generator<i32> {
        const selected = match (choice) {
          value(number) => { yield number; select number; }
          empty => 0;
        };
        yield selected;
      }
      function main(): i32 { return 0; }
    `, "generator-match-expression-suspension.zs"),
    /yield inside a value-producing match expression is deferred/,
  );
});

test("runs cold async generators through reusable awaited advancement tasks", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/async-generators.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "async generator 20 22 complete=42\n");

  const generated = compileToC(source, example);
  assert.match(generated, /Z_AsyncGenerator_/);
  assert.match(generated, /z_async_generator_make_values/);
  assert.match(generated, /z_async_generator_next_values/);
  assert.match(generated, /frame->generator_active = false;/);
  assert.match(generated, /frame->generator_finished = true;/);

  const asyncGeneratorOffset = source.indexOf("AsyncGenerator<i32");
  assert.match(
    hover(source, example, asyncGeneratorOffset + 1)?.contents.value ?? "",
    /AsyncGenerator<Yield, Return\?, Error\?>.*cold, move-only asynchronous sequence/s,
  );
  const sequenceOffset = source.indexOf("sequence =");
  assert.match(
    hover(source, example, sequenceOffset + 1)?.contents.value ?? "",
    /sequence: AsyncGenerator<i32, i32>/,
  );
  const nextOffset = source.indexOf("next()");
  assert.match(
    hover(source, example, nextOffset + 1)?.contents.value ?? "",
    /async next\(\): Task<GeneratorStep<i32, i32>>/,
  );
  const memberSource = source.replace("sequence.next()", "sequence.ne");
  const memberOffset = memberSource.indexOf("sequence.ne") + "sequence.ne".length;
  assert.match(
    completions(memberSource, example, memberOffset).find((item) => item.label === "next")?.detail ?? "",
    /async next\(\): Task<GeneratorStep<i32, i32>>/,
  );
  const native = spawnSync(process.execPath, [cli, "check", example, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid/);

  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      function values(): AsyncGenerator<i32> { yield 42; }
      function main(): i32 { return 0; }
    `, "async-generator-marker.zs"),
    /AsyncGenerator<T> requires an async function/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      async function values(): Generator<i32> { yield 42; }
      function main(): i32 { return 0; }
    `, "async-generator-shape.zs"),
    /an async generator must return AsyncGenerator<T>, not Generator<T>/,
  );

  const throwingDirectory = mkdtempSync("/tmp/z-async-generator-throwing-");
  const throwingFile = resolve(throwingDirectory, "main.zs");
  writeFileSync(throwingFile, `
    import { AsyncGenerator } from "std/iteration";
    import { delay } from "std/time";
    struct ReadError { code: i32; }
    async function values(): AsyncGenerator<i32, void, ReadError> throws ReadError {
      yield 20;
      await delay(1);
      throw ReadError({ code: 7 });
    }
    async function consume(): i32 throws ReadError {
      const sequence = values();
      const first = try await sequence.next();
      const second = try await sequence.next();
      return 1;
    }
    async function main(): i32 {
      return match (attempt await consume()) {
        success(value) => 1;
        failure(error) => error.code - 7;
      };
    }
  `);
  const throwingResult = spawnSync(process.execPath, [cli, "run", throwingFile], { encoding: "utf8" });
  assert.equal(throwingResult.status, 0, throwingResult.stderr);

  const cleanupFile = resolve(throwingDirectory, "cleanup.zs");
  writeFileSync(cleanupFile, `
    import console from "std/console";
    import { AsyncGenerator } from "std/iteration";
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    async function values(): AsyncGenerator<i32> {
      const lease = Lease({ id: 42 });
      yield lease.id;
      yield lease.id;
    }
    async function main(): i32 {
      const sequence = values();
      const first = await sequence.next();
      return match (first) {
        some(value) => value - 42;
        none => 1;
      };
    }
  `);
  const cleanupResult = spawnSync(process.execPath, [cli, "run", cleanupFile], { encoding: "utf8" });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(cleanupResult.stdout, "released 42\n");

  const streamExample = resolve(projectRoot, "examples/language/control-flow/async-event-stream.zs");
  const streamResult = spawnSync(process.execPath, [cli, "run", streamExample], { encoding: "utf8" });
  assert.equal(streamResult.status, 0, streamResult.stderr);
  assert.equal(streamResult.stdout, "streamed 20, 22; summary=3\n");
  const streamNative = spawnSync(
    process.execPath,
    [cli, "check", streamExample, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(streamNative.status, 0, streamNative.stderr);

  const forAwaitExample = resolve(projectRoot, "examples/language/control-flow/async-for-await.zs");
  const forAwaitSource = readFileSync(forAwaitExample, "utf8");
  const forAwaitResult = spawnSync(process.execPath, [cli, "run", forAwaitExample], { encoding: "utf8" });
  assert.equal(forAwaitResult.status, 0, forAwaitResult.stderr);
  assert.equal(forAwaitResult.stdout, "for await total=62, resumed=0\n");
  const forAwaitGenerated = compileToC(forAwaitSource, forAwaitExample);
  assert.match(forAwaitGenerated, /\.next\(.*\.context, frame->task\.executor\)/s);
  assert.match(forAwaitGenerated, /\.take_result\(.*\.context,/s);
  const readingUse = forAwaitSource.indexOf("reading == 0");
  assert.match(hover(forAwaitSource, forAwaitExample, readingUse + 1)?.contents.value ?? "", /reading: i32/);
  const forAwaitTokens = decodeSemanticTokens(semanticTokens(forAwaitSource, forAwaitExample).data);
  const bindingOffset = forAwaitSource.indexOf("reading of");
  const bindingPosition = positionForOffset(forAwaitSource, bindingOffset);
  assert.ok(forAwaitTokens.some((token) => (
    token.line === bindingPosition.line
    && token.character === bindingPosition.character
  )));
  const forAwaitNative = spawnSync(
    process.execPath,
    [cli, "check", forAwaitExample, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(forAwaitNative.status, 0, forAwaitNative.stderr);

  const throwingForAwaitExample = resolve(
    projectRoot,
    "examples/language/control-flow/async-for-await-errors.zs",
  );
  const throwingForAwaitSource = readFileSync(throwingForAwaitExample, "utf8");
  const throwingForAwaitResult = spawnSync(
    process.execPath,
    [cli, "run", throwingForAwaitExample],
    { encoding: "utf8" },
  );
  assert.equal(throwingForAwaitResult.status, 0, throwingForAwaitResult.stderr);
  assert.equal(
    throwingForAwaitResult.stdout,
    "received 20\nreceived 22\nreceived 20\n",
  );
  const throwingForAwaitNative = spawnSync(
    process.execPath,
    [cli, "check", throwingForAwaitExample, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(throwingForAwaitNative.status, 0, throwingForAwaitNative.stderr);
  const throwingReadingUse = throwingForAwaitSource.indexOf("reading}`");
  assert.match(
    hover(throwingForAwaitSource, throwingForAwaitExample, throwingReadingUse + 1)?.contents.value ?? "",
    /reading: i32/,
  );
  const incompleteThrowingLoop = throwingForAwaitSource.replace("try for await", "try for aw");
  const incompleteAwaitOffset = incompleteThrowingLoop.indexOf("try for aw") + "try for aw".length;
  assert.equal(
    completions(incompleteThrowingLoop, throwingForAwaitExample, incompleteAwaitOffset)
      .find((item) => item.label === "await")?.detail,
    "Z keyword",
  );

  const forAwaitCleanupFile = resolve(throwingDirectory, "for-await-cleanup.zs");
  writeFileSync(forAwaitCleanupFile, `
    import console from "std/console";
    import { AsyncGenerator } from "std/iteration";
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    async function leases(): AsyncGenerator<Lease> {
      yield Lease({ id: 42 });
      yield Lease({ id: 99 });
    }
    async function main(): i32 {
      for await (const lease of leases()) {
        if (lease.id == 42) break;
      }
      return 0;
    }
  `);
  const forAwaitCleanupResult = spawnSync(
    process.execPath,
    [cli, "run", forAwaitCleanupFile],
    { encoding: "utf8" },
  );
  assert.equal(forAwaitCleanupResult.status, 0, forAwaitCleanupResult.stderr);
  assert.equal(forAwaitCleanupResult.stdout, "released 42\n");

  const throwingForAwaitCleanupFile = resolve(throwingDirectory, "try-for-await-cleanup.zs");
  writeFileSync(throwingForAwaitCleanupFile, `
    import console from "std/console";
    import { AsyncGenerator } from "std/iteration";
    struct ReadError { code: i32; }
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    async function leases(): AsyncGenerator<Lease, void, ReadError> throws ReadError {
      const suspended = Lease({ id: 99 });
      yield Lease({ id: 42 });
      throw ReadError({ code: suspended.id });
    }
    async function consume(): i32 throws ReadError {
      try for await (const lease of leases()) {
        console.log(\`observed \${lease.id}\`);
      }
      return 1;
    }
    async function main(): i32 {
      return match (attempt await consume()) {
        success(value) => value;
        failure(error) => error.code - 99;
      };
    }
  `);
  const throwingForAwaitCleanupResult = spawnSync(
    process.execPath,
    [cli, "run", throwingForAwaitCleanupFile],
    { encoding: "utf8" },
  );
  assert.equal(throwingForAwaitCleanupResult.status, 0, throwingForAwaitCleanupResult.stderr);
  assert.equal(
    throwingForAwaitCleanupResult.stdout,
    "observed 42\nreleased 42\nreleased 99\n",
  );

  const forAwaitDestructuringExample = resolve(
    projectRoot,
    "examples/language/control-flow/async-for-await-destructuring.zs",
  );
  const forAwaitDestructuringSource = readFileSync(forAwaitDestructuringExample, "utf8");
  const forAwaitDestructuringResult = spawnSync(
    process.execPath,
    [cli, "run", forAwaitDestructuringExample],
    { encoding: "utf8" },
  );
  assert.equal(forAwaitDestructuringResult.status, 0, forAwaitDestructuringResult.stderr);
  assert.equal(
    forAwaitDestructuringResult.stdout,
    "event 1 = 20\n"
      + "released label 1\n"
      + "released label 101\n"
      + "event 2 = 22\n"
      + "released label 2\n"
      + "released label 102\n",
  );
  const selectedTopicUse = forAwaitDestructuringSource.indexOf("selectedTopic.id");
  assert.match(
    hover(
      forAwaitDestructuringSource,
      forAwaitDestructuringExample,
      selectedTopicUse + 1,
    )?.contents.value ?? "",
    /selectedTopic: Label/,
  );
  const forAwaitDestructuringNative = spawnSync(
    process.execPath,
    [cli, "check", forAwaitDestructuringExample, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(forAwaitDestructuringNative.status, 0, forAwaitDestructuringNative.stderr);

  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      struct Resource {
        id: i32;
        deinit {}
      }
      async function resources(): AsyncGenerator<Resource> {
        yield Resource({ id: 42 });
      }
      async function main(): i32 {
        for await (const { id } of resources()) {}
        return 0;
      }
    `, "for-await-deinit-destructure.zs"),
    /cannot destructure yielded Resource because it defines deinit/,
  );

  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      async function values(): AsyncGenerator<i32> { yield 42; }
      function main(): i32 {
        for await (const value of values()) {}
        return 0;
      }
    `, "for-await-sync-parent.zs"),
    /for await requires an enclosing async function/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      async function values(): AsyncGenerator<i32, i32> {
        yield 42;
        return 1;
      }
      async function main(): i32 {
        for await (const value of values()) {}
        return 0;
      }
    `, "for-await-terminal.zs"),
    /for await\.\.\.of cannot discard the terminal i32 value/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      struct ReadError { code: i32; }
      async function values(): AsyncGenerator<i32, void, ReadError> throws ReadError {
        yield 42;
      }
      async function main(): i32 {
        for await (const value of values()) {}
        return 0;
      }
    `, "for-await-throwing.zs"),
    /for await\.\.\.of cannot implicitly propagate ReadError/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      async function values(): AsyncGenerator<i32> { yield 42; }
      async function main(): i32 {
        try for await (const value of values()) {}
        return 0;
      }
    `, "try-for-await-nonthrowing.zs"),
    /try for await requires a throwing async generator/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      struct ReadError { code: i32; }
      async function values(): AsyncGenerator<i32, void, ReadError> throws ReadError {
        yield 42;
      }
      async function main(): i32 {
        try for await (const value of values()) {}
        return 0;
      }
    `, "try-for-await-parent.zs"),
    /try for await requires an enclosing throwing function/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      struct ReadError { code: i32; }
      struct StoreError { code: i32; }
      async function values(): AsyncGenerator<i32, void, ReadError> throws ReadError {
        yield 42;
      }
      async function consume(): i32 throws StoreError {
        try for await (const value of values()) {}
        return 0;
      }
      async function main(): i32 { return 0; }
    `, "try-for-await-error-mismatch.zs"),
    /cannot propagate ReadError from a function throwing StoreError/,
  );
  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      async function values(): AsyncGenerator<i32> { yield 42; }
      async function main(): i32 {
        for (const value of values()) {}
        return 0;
      }
    `, "async-generator-sync-loop.zs"),
    /AsyncGenerator<T> requires asynchronous iteration/,
  );
  assert.throws(
    () => compileToC(`
      async function main(): i32 {
        const values = [20, 22];
        for await (const value of values) {}
        return 0;
      }
    `, "for-await-collection.zs"),
    /for await requires AsyncGenerator<T>/,
  );

  const controlFlowFile = resolve(throwingDirectory, "control-flow.zs");
  writeFileSync(controlFlowFile, `
    import { AsyncGenerator } from "std/iteration";
    import { Map, Set } from "std/collections";
    function makeCounts(): Map<i32, i32> {
      let counts = Map<i32, i32>();
      counts.set(20, 21);
      return counts;
    }
    function makeValues(): Set<i32> {
      let values = Set<i32>();
      values.add(19);
      return values;
    }
    async function selected(
      counts: Map<i32, i32>,
      values: Set<i32>
    ): AsyncGenerator<i32> {
      let current = 0;
      while (current < 5) {
        current = current + 1;
        if (current == 2) continue;
        if (current == 4) break;
        yield current;
      }
      for (const { value } of counts) {
        yield value;
      }
      for (const value of values) {
        yield value;
      }
    }
    async function main(): i32 {
      const values = selected(makeCounts(), makeValues());
      const first = await values.next();
      const second = await values.next();
      const third = await values.next();
      const fourth = await values.next();
      const a = match (first) { some(value) => value; none => 0; };
      const b = match (second) { some(value) => value; none => 0; };
      const c = match (third) { some(value) => value; none => 0; };
      const d = match (fourth) { some(value) => value; none => 0; };
      return a + b + c + d - 44;
    }
  `);
  const controlFlowResult = spawnSync(process.execPath, [cli, "run", controlFlowFile], { encoding: "utf8" });
  assert.equal(controlFlowResult.status, 0, controlFlowResult.stderr);

  const cancellationFile = resolve(throwingDirectory, "cancellation.zs");
  writeFileSync(cancellationFile, `
    import console from "std/console";
    import { AsyncGenerator } from "std/iteration";
    import { delay } from "std/time";
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    async function values(): AsyncGenerator<i32> {
      const lease = Lease({ id: 42 });
      await delay(1000);
      yield lease.id;
    }
    async function consume(): i32 {
      const values = values();
      const next = await values.next();
      return 1;
    }
    async function main(): i32 {
      const task = task consume();
      await delay(1);
      await task.cancel();
      return 0;
    }
  `);
  const cancellationResult = spawnSync(process.execPath, [cli, "run", cancellationFile], { encoding: "utf8" });
  assert.equal(cancellationResult.status, 0, cancellationResult.stderr);
  assert.equal(cancellationResult.stdout, "released 42\n");

  assert.throws(
    () => compileToC(`
      import { AsyncGenerator } from "std/iteration";
      async function values(): AsyncGenerator<i32> { yield 42; }
      async function main(): i32 {
        const values = values();
        const task = task values.next();
        return 0;
      }
    `, "async-generator-overlap.zs"),
    /starting AsyncGenerator.next as a task is deferred until concurrent advancement is statically excluded/,
  );
}, 10_000);

test("returns explicit terminal values from typed generators", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/generator-return.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "value 1\nvalue 2\nvalue 3\ncomplete count=3 total=6\n");
  const native = spawnSync(process.execPath, [cli, "check", example, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid/);

  const generated = compileToC(source, example);
  assert.match(generated, /GeneratorStep/);
  assert.match(generated, /\.data\.yielded/);
  assert.match(generated, /\.data\.complete/);

  const stepOffset = source.indexOf("step =");
  assert.match(
    hover(source, example, stepOffset + 1)?.contents.value ?? "",
    /step: GeneratorStep<i32, ScanSummary>/,
  );
  const nextOffset = source.indexOf("next()");
  assert.match(
    hover(source, example, nextOffset + 1)?.contents.value ?? "",
    /next\(\): GeneratorStep<i32, ScanSummary>/,
  );

  const cleanupDirectory = mkdtempSync("/tmp/z-generator-return-");
  const cleanupFile = resolve(cleanupDirectory, "cleanup.zs");
  writeFileSync(cleanupFile, `
    import console from "std/console";
    import { Generator } from "std/iteration";
    struct Completion {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    function values(): Generator<i32, Completion> {
      const result = Completion({ id: 42 });
      yield 1;
      return result;
    }
    function main(): i32 {
      const sequence = values();
      const first = sequence.next();
      match (first) {
        yielded(value) => {}
        complete(result) => return 1;
      }
      const terminal = sequence.next();
      return match (terminal) {
        yielded(value) => 1;
        complete(result) => result.id - 42;
      };
    }
  `);
  const cleanupResult = spawnSync(process.execPath, [cli, "run", cleanupFile], { encoding: "utf8" });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(cleanupResult.stdout, "released 42\n");

  const terminalFile = resolve(cleanupDirectory, "terminal.zs");
  writeFileSync(terminalFile, `
    import { Generator } from "std/iteration";
    struct ReadError { code: i32; }
    function values(): Generator<i32, i32> throws ReadError {
      yield 20;
      return 22;
    }
    function consume(values: Generator<i32, i32, ReadError>): i32 throws ReadError {
      const yielded = try values.next();
      const first = match (yielded) {
        yielded(value) => value;
        complete(value) => 0;
      };
      const completed = try values.next();
      return match (completed) {
        yielded(value) => 1;
        complete(value) => first + value;
      };
    }
    function main(): i32 {
      return match (attempt consume(values())) {
        success(value) => value - 42;
        failure(error) => error.code;
      };
    }
  `);
  const terminalResult = spawnSync(process.execPath, [cli, "run", terminalFile], { encoding: "utf8" });
  assert.equal(terminalResult.status, 0, terminalResult.stderr);

  const genericFile = resolve(cleanupDirectory, "generic.zs");
  writeFileSync(genericFile, `
    import { Generator } from "std/iteration";
    struct ReadError { code: i32; }
    function values<T>(value: T): Generator<T> throws ReadError {
      yield value;
    }
    function main(): i32 {
      const sequence = values(42);
      return match (attempt sequence.next()) {
        success(result) => {
          const observed = match (result) {
            some(value) => value - 42;
            none => 1;
          };
          select observed;
        }
        failure(error) => error.code;
      };
    }
  `);
  const genericResult = spawnSync(process.execPath, [cli, "run", genericFile], { encoding: "utf8" });
  assert.equal(genericResult.status, 0, genericResult.stderr);

  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function values(): Generator<i32, i32> { yield 1; return 2; }
      function main(): i32 {
        const sequence = values();
        for (const value of sequence) {}
        return 0;
      }
    `, "generator-return-for.zs"),
    /for\.\.\.of cannot discard the terminal i32 value/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function values(flag: boolean): Generator<i32, i32> {
        yield 1;
        if (flag) return 2;
      }
      function main(): i32 { return 0; }
    `, "generator-return-path.zs"),
    /function "values" must end with a return value/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      function values(): Generator<i32, i32> { yield 1; return; }
      function main(): i32 { return 0; }
    `, "generator-return-missing.zs"),
    /must return a terminal value/,
  );
});

test("advances throwing generators explicitly without making cold construction throw", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/generator-throws.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "completed 42\nfailed 7\n");
  const native = spawnSync(process.execPath, [cli, "check", example, "--native-frontend"], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid/);

  const generated = compileToC(source, example);
  assert.match(generated, /Z_GeneratorFrame_readValues_advance/);
  assert.match(generated, /\.data\.failure/);
  assert.match(generated, /\.data\.success/);

  const valuesOffset = source.indexOf("values: Generator");
  assert.match(
    hover(source, example, valuesOffset + 1)?.contents.value ?? "",
    /values: Generator<i32, void, ReadError>/,
  );
  const nextOffset = source.indexOf("next()");
  assert.match(
    hover(source, example, nextOffset + 1)?.contents.value ?? "",
    /next\(\): Result<Option<i32>, ReadError>/,
  );

  const cleanupDirectory = mkdtempSync("/tmp/z-generator-throw-");
  const cleanupFile = resolve(cleanupDirectory, "cleanup.zs");
  writeFileSync(cleanupFile, `
    import console from "std/console";
    import { Generator } from "std/iteration";
    struct ReadError { code: i32; }
    struct Lease {
      id: i32;
      deinit { console.log(\`released \${this.id}\`); }
    }
    function fail(): i32 throws ReadError {
      throw ReadError({ code: 7 });
    }
    function values(): Generator<i32> throws ReadError {
      const lease = Lease({ id: 42 });
      yield 1;
      const value = try fail();
      yield value;
    }
    function consume(values: Generator<i32, void, ReadError>): i32 throws ReadError {
      const first = try values.next();
      const second = try values.next();
      return 1;
    }
    function main(): i32 {
      return match (attempt consume(values())) {
        success(value) => 1;
        failure(error) => error.code - 7;
      };
    }
  `);
  const cleanupResult = spawnSync(process.execPath, [cli, "run", cleanupFile], { encoding: "utf8" });
  assert.equal(cleanupResult.status, 0, cleanupResult.stderr);
  assert.equal(cleanupResult.stdout, "released 42\n");

  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      struct ReadError { code: i32; }
      function values(): Generator<i32> throws ReadError { yield 1; throw ReadError({ code: 1 }); }
      function run(): i32 {
        const sequence = values();
        const next = sequence.next();
        return 0;
      }
      function main(): i32 { return run(); }
    `, "generator-throw-unhandled.zs"),
    /advancing a throwing generator requires `attempt` or `try`/,
  );
  assert.throws(
    () => compileToC(`
      import { Generator } from "std/iteration";
      struct ReadError { code: i32; }
      function values(): Generator<i32> throws ReadError { yield 1; }
      function main(): i32 {
        const sequence = values();
        for (const value of sequence) {}
        return 0;
      }
    `, "generator-throw-for.zs"),
    /for\.\.\.of cannot implicitly propagate ReadError/,
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
    () => compileToC(source, "match-types.zs"),
    /match-types\.zs:7:9: error: match arm produces String, but previous arms produce i32/,
  );
});

test("requires explicit handling for throwing calls", () => {
  const source = `
    struct Problem { code: i32; }
    function fallible(): i32 throws Problem { return 42; }
    function main(): i32 { return fallible(); }
  `;
  assert.throws(
    () => compileToC(source, "explicit-errors.zs"),
    /throwing call requires `attempt` or `try`/,
  );
});

test("rejects throw outside a throwing function", () => {
  const source = `
    struct Problem { code: i32; }
    function main(): i32 { throw Problem({ code: 1 }); }
  `;
  assert.throws(
    () => compileToC(source, "invalid-throw.zs"),
    /function "main" does not declare an error type/,
  );
});

test("compiles typed Result success and failure paths", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/result.zs");
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
    () => compileToC(source, "try-context.zs"),
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
    () => compileToC(source, "try-errors.zs"),
    /cannot propagate FirstError from a function throwing SecondError/,
  );
});

test("propagates typed failures through try", () => {
  const example = resolve(projectRoot, "examples/language/control-flow/try.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "id=42\nforwarded=9\nerror=7\n");
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
  const qualifiedTypeAnnotation = grammar.repository.typeAnnotations.patterns[0];
  const exportPattern = grammar.repository.keywords.patterns
    .find((pattern: { match: string }) => pattern.match.includes("export"));
  const taskPattern = grammar.repository.keywords.patterns
    .find((pattern: { name: string }) => pattern.name === "keyword.control.concurrent.z");
  const ownershipPattern = grammar.repository.keywords.patterns
    .find((pattern: { name: string }) => pattern.name === "keyword.operator.ownership.z");
  assert.equal(exportPattern?.name, "keyword.control.export.z");
  assert.match("task fetch()", new RegExp(taskPattern?.match ?? "$^"));
  assert.match("task on thread.main", new RegExp(taskPattern?.match ?? "$^"));
  assert.doesNotMatch("const task = operation();", new RegExp(taskPattern?.match ?? "$^"));
  assert.match("copy value", new RegExp(ownershipPattern?.match ?? "$^"));
  assert.doesNotMatch("const copy = value;", new RegExp(ownershipPattern?.match ?? "$^"));
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /on/);
  assert.match(keywordPattern, /yield/);
  assert.match(keywordPattern, /select/);
  assert.match(keywordPattern, /copy/);
  assert.match(keywordPattern, /move/);
  assert.match(keywordPattern, /task/);
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
  assert.equal(foreignDeclarationPatterns[0].captures[2].name, "storage.type.module.z");
  assert.equal(foreignDeclarationPatterns[1].captures[1].name, "storage.type.declaration.z");
  assert.equal(foreignDeclarationPatterns[1].captures[2].name, "entity.name.type.z");
  assert.equal(foreignDeclarationPatterns[2].captures[1].name, "storage.modifier.capability.z");
  assert.equal(foreignDeclarationPatterns[3].captures[1].name, "keyword.control.declaration.thread.z");
  assert.equal(foreignDeclarationPatterns[4].captures[1].name, "storage.modifier.capability.thread.z");
  assert.equal(foreignDeclarationPatterns[5].captures[2].name, "variable.parameter.z");
  assert.equal(foreignDeclarationPatterns[6].captures[2].name, "entity.name.function.destructor.z");
  assert.equal(foreignDeclarationPatterns[7].captures[1].name, "keyword.control.declaration.fixed.z");
  assert.equal(foreignDeclarationPatterns[7].captures[2].name, "constant.other.native.z");
  assert.equal(foreignDeclarationPatterns[8].captures[2].name, "keyword.control.declaration.z");
  assert.equal(foreignDeclarationPatterns[8].captures[3].name, "storage.type.inferred.z");
  assert.equal(foreignDeclarationPatterns[9].captures[1].name, "keyword.control.declaration.status.z");
  assert.equal(foreignDeclarationPatterns[9].captures[2].name, "constant.numeric.integer.status.z");
  assert.equal(foreignDeclarationPatterns[10].captures[1].name, "storage.type.inferred.z");
  assert.equal(foreignDeclarationPatterns[11].captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(foreignDeclarationPatterns[12].beginCaptures[1].name, "storage.modifier.async.z");
  assert.equal(foreignDeclarationPatterns[12].beginCaptures[2].name, "entity.name.function.callback.z");
  assert.equal(foreignDeclarationPatterns[12].patterns[1].captures[1].name, "keyword.control.flow.z");
  assert.equal(foreignDeclarationPatterns[12].patterns[1].captures[2].name, "variable.parameter.callback.z");
  assert.equal(foreignDeclarationPatterns[13].captures[1].name, "storage.modifier.async.z");
  assert.equal(foreignDeclarationPatterns[13].captures[2].name, "entity.name.function.callback.z");
  assert.equal(foreignDeclarationPatterns[14].captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(foreignDeclarationPatterns[14].captures[2].name, "variable.parameter.context.z");
  assert.equal(foreignDeclarationPatterns[15].captures[1].name, "keyword.control.declaration.callback.z");
  assert.equal(foreignDeclarationPatterns[15].captures[2].name, "constant.language.callback-thread.z");
  assert.match(foreignDeclarationPatterns[15].match, /caller\\\|any|caller\|any/);
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
  assert.match(extension, /createFileSystemWatcher/);
  assert.match(extension, /restartLanguageServer/);
});

test("type-checks main-thread executor placement and exposes thread.main to editors", () => {
  const example = resolve(projectRoot, "examples/async/executor-placement.zs");
  const source = readFileSync(example, "utf8");
  check(source, example);
  assert.deepEqual(diagnostics(source, example), []);

  const mainTarget = source.indexOf("thread.main") + "thread.".length + 1;
  assert.match(hover(source, example, mainTarget)?.contents.value ?? "", /thread\.main: Executor/);

  const immediate = source.indexOf("immediate =") + 1;
  assert.match(hover(source, example, immediate)?.contents.value ?? "", /immediate: i32/);
  const placedTask = source.indexOf("placedTask =") + 1;
  assert.match(hover(source, example, placedTask)?.contents.value ?? "", /placedTask: Task<i32>/);

  const incomplete = source.replace("thread.main: i32", "thread.ma: i32");
  const completionOffset = incomplete.indexOf("thread.ma") + "thread.ma".length;
  const mainCompletion = completions(incomplete, example, completionOffset).find((item) => item.label === "main");
  assert.equal(mainCompletion?.kind, 10);
  assert.match(mainCompletion?.detail ?? "", /main-thread execution target/);

  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const targetPosition = positionForOffset(source, source.indexOf("main", source.indexOf("thread.main")));
  assert.ok(tokens.some((token) => (
    token.line === targetPosition.line
    && token.character === targetPosition.character
    && token.type === semanticTokenTypes.indexOf("property")
  )));

  const unproven = `
    import { thread } from "std/thread";
    function inspect(): i32 {
      return on thread.main: i32 { select 1; };
    }
    function main(): i32 { return inspect(); }
  `;
  const proofDiagnostic = diagnostics(unproven, "executor-proof.zs")[0];
  assert.equal(proofDiagnostic.code, "Z0711");
  assert.match(proofDiagnostic.message, /requires proven main-executor context/);

  const synchronousHelper = `
    import { thread } from "std/thread";
    function publishStatus(): void {
      task on thread.main {}
    }
    async function main(): i32 {
      const worker = thread.spawn((): void => publishStatus());
      await worker;
      return 0;
    }
  `;
  assert.throws(() => check(synchronousHelper, "executor-helper.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0711");
    assert.match(error.summary, /enclosing async function or the direct thread\.spawn closure/);
    assert.match(error.notes.join(" "), /does not inherit its caller's task scope/);
    assert.match(error.helps.join(" "), /keep `task on thread\.main \{ \.\.\. \}` directly in that closure/);
    assert.match(error.helps.join(" "), /async thread\.spawn closures are not implemented yet/);
    return true;
  });

  const generated = compileToC(source, example);
  assert.match(generated, /z_async_start___z_executor_main_/);
  assert.match(generated, /z_async_run_one/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const directory = mkdtempSync("/tmp/z-sync-main-placement-");
  const syncMain = resolve(directory, "main.zs");
  writeFileSync(syncMain, `
    import { thread } from "std/thread";
    function main(): i32 {
      const answer = on thread.main: i32 { select 42; };
      return answer - 42;
    }
  `);
  const syncResult = spawnSync(process.execPath, [cli, "run", syncMain], { encoding: "utf8" });
  assert.equal(syncResult.status, 0, syncResult.stderr);
});

test("places structured work onto main from a native worker without blocking main", () => {
  const example = resolve(projectRoot, "examples/async/thread-main-placement.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /z_async_enqueue_from_thread/);
  assert.match(artifact.source, /native_body_completed/);
  assert.match(artifact.source, /native_thread_finished/);
  assert.match(artifact.source, /CFRunLoopSourceSignal/);
  if (process.platform === "darwin") assert.ok(artifact.frameworks.includes("CoreFoundation"));

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "main task awaits worker without blocking the main executor\n"
      + "main placement received 42\n"
      + "worker and its structured main child completed\n",
  );

  if (process.platform === "darwin") {
    const runLoopExample = resolve(projectRoot, "examples/async/darwin-main-run-loop.zs");
    const runLoopResult = spawnSync(process.execPath, [cli, "run", runLoopExample], { encoding: "utf8" });
    assert.equal(runLoopResult.status, 0, runLoopResult.stderr);
    assert.equal(runLoopResult.stdout, "placed child is running on the Darwin main run loop\n");
  }
});

test("retains Z ARC identities captured by main-executor placement", () => {
  const directory = mkdtempSync("/tmp/z-main-class-capture-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import { thread } from "std/thread";
    class Session { id: i32; }
    async function main(): i32 {
      const session = new Session({ id: 42 });
      const observed = await on thread.main: i32 {
        select session.id;
      };
      return observed - 42;
    }
  `;
  writeFileSync(fileName, source);

  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /z_async_start___z_executor_main_\d+\([^\n]+Z_Session_retain\(frame->value_session\)\)/);
  assert.match(artifact.source, /Z_Session_release\(frame->value_session\)/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("publishes owned worker results through retained Objective-C identity on main", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/async/appkit-main-result.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.ok(artifact.frameworks.includes("AppKit"));
  assert.ok(artifact.frameworks.includes("CoreFoundation"));
  assert.match(artifact.source, /NSApplication \* value_app;/);
  assert.match(artifact.source, /frame->value_app = nil;/);
  assert.match(artifact.source, /z_string_copy_bytes\(frame->value_status, 0, \(frame->value_status\)\.length\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "background work completed\n");
}, 10_000);

test("runs async match expressions with checked arithmetic and editor details", () => {
  const example = resolve(projectRoot, "examples/async/async-phase-0.zs");
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
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    function combine(left: i32, right: i32): i32 { return left + right; }
    async function value(id: i32): i32 {
      console.log(id);
      return id;
    }
    async function combineAsync(left: i32, right: i32): i32 { return left + right; }
    async function positive(value: i32): boolean { return value > 0; }
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

test("diagnoses embedded awaits whose short-circuit lowering has not landed", () => {
  const shortCircuit = `
    async function flag(): boolean { return true; }
    async function main(): i32 {
      if (false && await flag()) { return 1; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(shortCircuit, "async-short-circuit.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /short-circuit logic/);
    return true;
  });

});

test("runs awaits only in the selected async match arm", () => {
  const directory = mkdtempSync("/tmp/z-async-selected-arm-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    enum State { ready, empty, }
    async function value(): i32 {
      console.log("selected");
      return 42;
    }
    async function main(): i32 {
      const state = State.ready;
      return match (state) {
        ready => await value();
        empty => {
          console.log("not selected");
          select 0;
        }
      };
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /z_async_start_value/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 42, result.stderr);
  assert.equal(result.stdout, "selected\n");
});

test("executes async failure matches with scalar and object payload bindings", () => {
  const directory = mkdtempSync("/tmp/z-async-match-");
  const scalarFile = resolve(directory, "scalar.zs");
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

  const objectFile = resolve(directory, "object.zs");
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

test("consumes owned async match expressions without requiring suspension", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-match-expression-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    class Session { id: i32; }
    async function main(): i32 {
      const option = Option.some(new Session({ id: 42 }));
      return match (option) {
        some(session) => session.id - 42;
        none => 0;
      };
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /Z_Option_Session value___z_async_match_subject_/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("consumes owned async statement matches across suspension", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-statement-match-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import { delay } from "std/time";

    class Session { id: i32; }

    async function main(): i32 {
      const option = Option.some(new Session({ id: 42 }));
      let observed = 0;
      match (option) {
        some(session) => {
          await delay(1);
          observed = session.id;
        }
        none => {
          observed = -1;
        }
      }
      return observed - 42;
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /Z_Option_Session value___z_async_match_subject_/);
  assert.match(generated, /frame->live___z_async_match_subject_\d+ = true;/);
  assert.match(generated, /frame->value_session = .*data\.some\);/);
  assert.match(generated, /Z_Session_release\(frame->value_session\)/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("selects from consuming owned async match arms after suspension", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-value-match-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import { delay } from "std/time";

    class Session { id: i32; }

    async function main(): i32 {
      const option = Option.some(new Session({ id: 42 }));
      const observed = match (option) {
        some(session) => {
          await delay(1);
          select session.id;
        }
        none => 0;
      };
      return observed - 42;
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /Z_Option_Session value___z_async_match_subject_/);
  assert.match(generated, /z_async_schedule_delay/);
  assert.match(generated, /frame->value_observed = .*value_session.*id/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("runs custom deinit exactly once after transferring an async match payload", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-match-deinit-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { delay } from "std/time";

    struct Resource {
      id: i32;
      deinit { console.log(\`released resource \${this.id}\`); }
    }

    enum ResourceState {
      ready Resource,
      empty,
    }

    async function main(): i32 {
      const state = ResourceState.ready(Resource({ id: 42 }));
      return match (state) {
        ready(resource) => {
          await delay(1);
          select resource.id - 42;
        }
        empty => 0;
      };
    }
  `);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released resource 42\n");
});

test("returns ARC, String, and owned value results from selected async match arms", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-match-results-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { delay } from "std/time";

    class Session {
      id: i32;
      deinit { console.log(\`released selected session \${this.id}\`); }
    }

    struct Resource {
      id: i32;
      deinit { console.log(\`released selected resource \${this.id}\`); }
    }

    enum SessionChoice { available Session, unavailable, }
    enum Source { remote, local, }

    async function chooseSession(): Session {
      const choice = SessionChoice.available(new Session({ id: 20 }));
      return match (choice) {
        available(session) => session;
        unavailable => new Session({ id: 0 });
      };
    }

    async function loadResource(): Resource {
      await delay(1);
      return Resource({ id: 22 });
    }

    async function chooseResource(): Resource {
      return match (Source.remote) {
        remote => await loadResource();
        local => Resource({ id: 0 });
      };
    }

    async function chooseLabel(): String {
      const label: String = match (Source.remote) {
        remote => "selected";
        local => "fallback";
      };
      return label;
    }

    async function main(): i32 {
      const session = await chooseSession();
      const resource = await chooseResource();
      const label = await chooseLabel();
      console.log(label);
      return session.id + resource.id - 42;
    }
  `);

  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);
  assert.match(generated, /frame->result = Z_Session_retain\(frame->value_session\)/);
  assert.match(generated, /frame->live_result = true;/);
  assert.match(generated, /frame->suspend_\d+_live = false/);
  const sessionOffset = source.indexOf("session = await");
  assert.match(hover(source, fileName, sessionOffset + 1)?.contents.value ?? "", /session: Session/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "selected\nreleased selected resource 22\nreleased selected session 20\n",
  );
});

test("returns a directly awaited move-only native value from an async match arm", () => {
  const directory = mkdtempSync("/tmp/z-async-native-match-result-");
  const fileName = resolve(directory, "main.zs");
  const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
  writeFileSync(fileName, `
    import { delay } from "std/time";
    import { zcpp } from ${JSON.stringify(header)};

    enum Source { remote, local, }

    async function load(): zcpp.UniqueValue {
      await delay(1);
      return zcpp.UniqueValue(42);
    }

    async function choose(): zcpp.UniqueValue {
      return match (Source.remote) {
        remote => await load();
        local => zcpp.UniqueValue(0);
      };
    }

    async function main(): i32 {
      const selected = await choose();
      return selected.finish(0) - 42 + zcpp.unique_live();
    }
  `);

  const source = readFileSync(fileName, "utf8");
  const generated = compileToNative(source, fileName).source;
  assert.match(generated, /new \(frame->result\) zcpp::UniqueValue\(z_async_take/);
  assert.match(generated, /frame->suspend_\d+_live = false/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("cleans owned async match results after later error and cancellation", () => {
  const directory = mkdtempSync("/tmp/z-async-match-result-exits-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { delay } from "std/time";

    struct Resource {
      id: i32;
      deinit { console.log(\`released selected result \${this.id}\`); }
    }

    enum Source { ready, empty, }

    async function failAfterSelection(): i32 throws i32 {
      const resource: Resource = match (Source.ready) {
        ready => Resource({ id: 7 });
        empty => Resource({ id: 0 });
      };
      throw resource.id;
    }

    async function holdAfterSelection(): i32 {
      const resource: Resource = match (Source.ready) {
        ready => Resource({ id: 9 });
        empty => Resource({ id: 0 });
      };
      await delay(1000);
      return resource.id;
    }

    async function main(): i32 {
      const observed = attempt await failAfterSelection();
      const code = match (observed) {
        success(value) => value;
        failure(error) => error;
      };
      const task = task holdAfterSelection();
      await delay(5);
      await task.cancel();
      return code - 7;
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /frame->live_resource = true;/);
  assert.match(generated, /if \(frame->live_resource\)/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released selected result 7\nreleased selected result 9\n");
});

test("cleans selected owned match payloads on async error and cancellation", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-match-exits-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { delay } from "std/time";

    class Session {
      id: i32;
      deinit { console.log(\`released match session \${this.id}\`); }
    }

    async function fail(): i32 throws i32 {
      await delay(1);
      throw 7;
    }

    async function propagate(): i32 throws i32 {
      const option = Option.some(new Session({ id: 7 }));
      return match (option) {
        some(session) => {
          select try await fail();
        }
        none => 0;
      };
    }

    async function hold(): i32 {
      const option = Option.some(new Session({ id: 9 }));
      return match (option) {
        some(session) => {
          await delay(1000);
          select session.id;
        }
        none => 0;
      };
    }

    async function main(): i32 {
      const observed = attempt await propagate();
      const code = match (observed) {
        success(value) => value;
        failure(error) => error;
      };
      const task = task hold();
      await delay(5);
      await task.cancel();
      return code - 7;
    }
  `);

  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);
  assert.match(generated, /frame->cancel_children = true;/);
  assert.match(generated, /if \(frame->live_session\)/);
  const sessionUse = source.indexOf("session.id");
  assert.match(hover(source, fileName, sessionUse + 1)?.contents.value ?? "", /session: Session/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released match session 7\nreleased match session 9\n");
});

test("keeps consuming async object patterns live through nested loop control", () => {
  const directory = mkdtempSync("/tmp/z-async-owned-match-loop-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { delay } from "std/time";

    class Session {
      id: i32;
      deinit { console.log(\`released loop session \${this.id}\`); }
    }

    struct Delivery {
      session: Session;
      adjustment: i32;
    }

    enum DeliveryState {
      ready Delivery,
      empty,
    }

    async function main(): i32 {
      let observed = 0;
      while (true) {
        match (DeliveryState.ready(Delivery({
          session: new Session({ id: 40 }),
          adjustment: 2,
        }))) {
          ready({ session, adjustment }) => {
            while (true) {
              await delay(1);
              break;
            }
            observed = session.id + adjustment;
            break;
          }
          empty => break;
        }
      }
      return observed - 42;
    }
  `);

  const generated = compileToC(readFileSync(fileName, "utf8"), fileName);
  assert.match(generated, /Z_Session \* value_session/);
  assert.match(generated, /Z_Session_release/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released loop session 40\n");
});

test("runs scalar async functions as stackless Phase 1 task frames", () => {
  const example = resolve(projectRoot, "examples/async/async-sequential.zs");
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
  const example = resolve(projectRoot, "examples/async/async-errors.zs");
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
  const failing = resolve(directory, "main.zs");
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
  const example = resolve(projectRoot, "examples/async/async-aggregates.zs");
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
  const example = resolve(projectRoot, "examples/async/async-ownership.zs");
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
  const failing = resolve(directory, "main.zs");
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

test("constructs and destroys move-only C++ values across async suspension", () => {
  const example = resolve(projectRoot, "examples/async/async-native-ownership.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /#include <memory>/);
  assert.match(generated, /#include <new>/);
  assert.match(generated, /alignas\(zcpp::UniqueValue\) unsigned char result\[sizeof\(zcpp::UniqueValue\)\]/);
  assert.match(generated, /alignas\(zcpp::UniqueValue\) unsigned char value_resource\[sizeof\(zcpp::UniqueValue\)\]/);
  assert.match(generated, /new \(frame->value_resource\) zcpp::UniqueValue\(zcpp::UniqueValue\(42\)\)/);
  assert.match(generated, /T result\(std::move\(\*value\)\);\n  std::destroy_at\(value\);\n  \*live = false;/);
  assert.match(generated, /new \(frame->result\) zcpp::UniqueValue\(z_async_take\(&\(\(\*std::launder\(reinterpret_cast<zcpp::UniqueValue \*>\(frame->value_resource\)/);
  assert.match(generated, /::make_success\(z_async_take\(&\(\(\*std::launder\(reinterpret_cast<zcpp::UniqueValue \*>\(frame->child_\d+->result\)/);
  assert.match(generated, /std::launder\(reinterpret_cast<zcpp::UniqueValue \*>\(frame->value_resource\)\)/);
  assert.match(generated, /std::destroy_at\(&\(\(\*std::launder\(reinterpret_cast<zcpp::UniqueValue \*>\(frame->value_resource\)\)\)\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer=42, failure=7, live=0\n");

  const resourceOffset = source.indexOf("resource =") + 2;
  assert.match(hover(source, example, resourceOffset)?.contents.value ?? "", /resource: .*zcpp\.UniqueValue/);
  const methodSource = source.replace("resource.value()", "resource.va");
  const methodOffset = methodSource.indexOf("resource.va") + "resource.va".length;
  assert.match(
    completions(methodSource, example, methodOffset).find((item) => item.label === "value")?.detail ?? "",
    /value\(\): i32/,
  );

  const directory = mkdtempSync("/tmp/z-async-native-cancel-");
  const cancellation = resolve(directory, "main.zs");
  const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
  writeFileSync(cancellation, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    async function failOwned(): i32 throws i32 {
      const resource = native.zcpp.UniqueValue(7);
      await delay(1);
      throw resource.value();
    }

    async function makeOwned(): native.zcpp.UniqueValue {
      return native.zcpp.UniqueValue(11);
    }

    async function linger(): void {
      const resource = native.zcpp.UniqueValue(9);
      const completed = task makeOwned();
      await delay(1000);
      const returned = await completed;
      return;
    }

    async function coordinate(): i32 throws i32 {
      const failure = task failOwned();
      task linger();
      return try await failure;
    }

    async function main(): i32 {
      const observed = attempt await coordinate();
      return native.zcpp.unique_live();
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const consuming = resolve(directory, "consume.zs");
  writeFileSync(consuming, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    async function finishAfterDelay(): i32 {
      const resource = native.zcpp.UniqueValue(40);
      await delay(1);
      return resource.finish(2);
    }

    async function main(): i32 {
      const answer = await finishAfterDelay();
      return answer - 42 + native.zcpp.unique_live();
    }
  `);
  const consumingGenerated = compileToNative(readFileSync(consuming, "utf8"), consuming).source;
  assert.match(consumingGenerated, /z_async_take\(&\(\(\*std::launder\(reinterpret_cast<zcpp::UniqueValue/);
  const consumed = spawnSync(process.execPath, [cli, "run", consuming], { encoding: "utf8" });
  assert.equal(consumed.status, 0, consumed.stderr);

  const parameterExample = resolve(projectRoot, "examples/async/async-native-parameters.zs");
  const parameterSource = readFileSync(parameterExample, "utf8");
  const parameterGenerated = compileToNative(parameterSource, parameterExample).source;
  assert.match(
    parameterGenerated,
    /z_async_start_inspectNative\(Z_AsyncExecutor \*executor, zcpp::UniqueValue &&value_resource\)/,
  );
  assert.match(
    parameterGenerated,
    /new \(frame->value_resource\) zcpp::UniqueValue\(std::move\(value_resource\)\)/,
  );
  assert.match(
    parameterGenerated,
    /z_async_start_saveDocument\(Z_AsyncExecutor \*executor, Z_DocumentLease &&value_document\)/,
  );
  assert.match(
    parameterGenerated,
    /new \(frame->value_document\) Z_DocumentLease\(std::move\(value_document\)\)/,
  );
  assert.match(parameterGenerated, /z_async_start_inspectNative\(frame->task.executor, z_async_take/);
  const parameterResult = spawnSync(process.execPath, [cli, "run", parameterExample], { encoding: "utf8" });
  assert.equal(parameterResult.status, 0, parameterResult.stderr);
  assert.equal(parameterResult.stdout, "native=42, document=42, live=0\n");
  const ownedParameterOffset = parameterSource.indexOf("resource: zcpp.UniqueValue") + 2;
  assert.match(
    hover(parameterSource, parameterExample, ownedParameterOffset)?.contents.value ?? "",
    /resource: zcpp\.UniqueValue/,
  );

  const parameterUseAfterMove = `
    import native from ${JSON.stringify(header)};
    async function consume(resource: native.zcpp.UniqueValue): void { return; }
    async function main(): i32 {
      const resource = native.zcpp.UniqueValue(42);
      const task = task consume(resource);
      return resource.value();
    }
  `;
  const parameterMoveDiagnostic = diagnostics(parameterUseAfterMove, resolve(directory, "parameter-move.zs"))[0];
  assert.equal(parameterMoveDiagnostic.code, "Z0201");
  assert.match(parameterMoveDiagnostic.message, /use of moved value "resource"/);

  const parameterCancellation = resolve(directory, "parameter-cancellation.zs");
  writeFileSync(parameterCancellation, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    async function hold(resource: native.zcpp.UniqueValue): void {
      await delay(1000);
      return;
    }

    async function cancelBeforeChildPoll(): i32 throws i32 {
      task hold(native.zcpp.UniqueValue(9));
      throw 7;
    }

    async function main(): i32 {
      const observed = attempt await cancelBeforeChildPoll();
      return native.zcpp.unique_live();
    }
  `);
  const parameterCancelled = spawnSync(process.execPath, [cli, "run", parameterCancellation], { encoding: "utf8" });
  assert.equal(parameterCancelled.status, 0, parameterCancelled.stderr);

  const fallible = resolve(directory, "fallible.zs");
  writeFileSync(fallible, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    async function open(fail: boolean): native.zcpp.UniqueValue throws i32 {
      await delay(1);
      if (fail) throw 7;
      return native.zcpp.UniqueValue(42);
    }

    async function openWithTry(): i32 throws i32 {
      const resource = try await open(false);
      return resource.finish(0);
    }

    async function main(): i32 {
      const propagated = attempt await openWithTry();
      const propagatedAnswer = match (propagated) {
        success(value) => value;
        failure(error) => -error;
      };
      const directAnswer = match (attempt await open(false)) {
        success(resource) => resource.finish(0);
        failure(error) => -error;
      };
      const failed = attempt await open(true);
      const failureCode = match (failed) {
        success(resource) => resource.finish(0);
        failure(error) => error;
      };
      return propagatedAnswer - 42 + directAnswer - 42 + failureCode - 7 + native.zcpp.unique_live();
    }
  `);
  const fallibleGenerated = compileToNative(readFileSync(fallible, "utf8"), fallible).source;
  assert.match(fallibleGenerated, /::make_success\(z_async_take/);
  assert.match(fallibleGenerated, /::make_failure\(frame->child_\d+->error\)/);
  assert.match(fallibleGenerated, /alignas\(Z_Result_[^)]+\) unsigned char suspend_\d+/);
  assert.match(fallibleGenerated, /std::destroy_at\(&\(\(\*std::launder\(reinterpret_cast<Z_Result_/);
  const fallibleResult = spawnSync(process.execPath, [cli, "run", fallible], { encoding: "utf8" });
  assert.equal(fallibleResult.status, 0, fallibleResult.stderr);

  const aggregateExample = resolve(projectRoot, "examples/async/async-native-aggregate.zs");
  const aggregateSource = readFileSync(aggregateExample, "utf8");
  const aggregateGenerated = compileToNative(aggregateSource, aggregateExample).source;
  assert.match(aggregateGenerated, /alignas\(Z_DocumentLease\) unsigned char result\[sizeof\(Z_DocumentLease\)\]/);
  assert.match(aggregateGenerated, /alignas\(Z_DocumentLease\) unsigned char value_document\[sizeof\(Z_DocumentLease\)\]/);
  assert.match(aggregateGenerated, /z_async_take\(&\(\(\*std::launder\(reinterpret_cast<Z_DocumentLease \*>/);
  assert.match(aggregateGenerated, /Z_DocumentLease_deinit[\s\S]*std::destroy_at\(&\(\(\*std::launder\(reinterpret_cast<Z_DocumentLease \*>/);
  const aggregateResult = spawnSync(process.execPath, [cli, "run", aggregateExample], { encoding: "utf8" });
  assert.equal(aggregateResult.status, 0, aggregateResult.stderr);
  assert.equal(
    aggregateResult.stdout,
    "released document 42\nreleased document 7\nanswer=42, failure=7, live=0\n",
  );
  const documentOffset = aggregateSource.indexOf("document.close()") + 2;
  assert.match(
    hover(aggregateSource, aggregateExample, documentOffset)?.contents.value ?? "",
    /document: DocumentLease/,
  );

  const aggregateCancellation = resolve(directory, "aggregate-cancellation.zs");
  writeFileSync(aggregateCancellation, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    struct Job { resource: native.zcpp.UniqueValue; }

    async function makeJob(): Job {
      return Job({ resource: native.zcpp.UniqueValue(9) });
    }

    async function linger(): void {
      const completed = task makeJob();
      await delay(1000);
      const returned = await completed;
      return;
    }

    async function fail(): i32 throws i32 {
      await delay(1);
      throw 7;
    }

    async function coordinate(): i32 throws i32 {
      task linger();
      return try await fail();
    }

    async function main(): i32 {
      const observed = attempt await coordinate();
      return native.zcpp.unique_live();
    }
  `);
  const aggregateCancelled = spawnSync(process.execPath, [cli, "run", aggregateCancellation], { encoding: "utf8" });
  assert.equal(aggregateCancelled.status, 0, aggregateCancelled.stderr);

  const enumAggregate = resolve(directory, "native-enum.zs");
  writeFileSync(enumAggregate, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    enum LeaseState {
      open native.zcpp.UniqueValue,
      closed,
    }

    async function loadState(): LeaseState {
      const state = LeaseState.open(native.zcpp.UniqueValue(42));
      await delay(1);
      return state;
    }

    async function main(): i32 {
      const state = await loadState();
      const answer = match (state) {
        open(resource) => resource.finish(0);
        closed => 0;
      };
      return answer - 42 + native.zcpp.unique_live();
    }
  `);
  const enumResult = spawnSync(process.execPath, [cli, "run", enumAggregate], { encoding: "utf8" });
  assert.equal(enumResult.status, 0, enumResult.stderr);
}, 15000);

test("destroys active Option and Result payloads in async task frames", () => {
  const example = resolve(projectRoot, "examples/async/async-owned-enums.zs");
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
  const generated = compileToC(source, "fallible-void.zs");
  assert.match(generated, /Z_Result_void_NetworkError_success/);
  assert.doesNotMatch(generated, /data\.success/);
  const compilation = spawnSync("clang", ["-x", "c", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], {
    input: generated,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);
});

test("allows root-scoped task and diagnoses unacknowledged async calls and async borrows", () => {
  const prelude = `
    async function fetch(value: i32): i32 { return value; }
  `;
  const naked = `${prelude} async function use(): i32 { return fetch(42); }`;
  assert.throws(() => check(naked, "async-naked.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0702");
    assert.match(error.message, /requires `await` or `task`/);
    return true;
  });

  const rootScoped = `${prelude} async function use(): i32 { const task = task fetch(42); return await task; }`;
  check(rootScoped, "async-root-scope.zs");

  const contextualTask = `
    async function task(value: i32): i32 { return value; }
    async function use(): i32 {
      const task = task task(42);
      return await task;
    }
  `;
  check(contextualTask, "contextual-task.zs");
  const contextualTaskTokens = decodeSemanticTokens(semanticTokens(contextualTask, "contextual-task.zs").data);
  const taskBindingPosition = positionForOffset(
    contextualTask,
    contextualTask.indexOf("const task") + "const ".length,
  );
  const taskOperatorOffset = contextualTask.indexOf("= task") + 2;
  const taskOperatorPosition = positionForOffset(contextualTask, taskOperatorOffset);
  assert.ok(contextualTaskTokens.some((token) => (
    token.line === taskBindingPosition.line
    && token.character === taskBindingPosition.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));
  assert.ok(!contextualTaskTokens.some((token) => (
    token.line === taskOperatorPosition.line
    && token.character === taskOperatorPosition.character
  )));
  assert.match(
    hover(contextualTask, "contextual-task.zs", taskOperatorOffset)?.contents.value ?? "",
    /hot structured child/,
  );

  const immediatelyJoined = `${prelude} async function use(): i32 { return await task fetch(42); }`;
  assert.throws(() => check(immediatelyJoined, "async-await-task.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0701");
    assert.match(error.message, /`await task` is redundant/);
    return true;
  });

  const synchronousSpawn = `${prelude} function use(): i32 { const task = task fetch(42); return 42; }`;
  assert.throws(() => check(synchronousSpawn, "async-sync-task.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0703");
    assert.match(error.message, /task requires an enclosing async function/);
    return true;
  });

  const borrowed = `async function inspect(in value: i32): i32 { return value; }`;
  check(borrowed, "async-borrow.zs");

  const synchronousAwait = `function value(): i32 { return 42; } async function use(): i32 { return await value(); }`;
  assert.throws(() => check(synchronousAwait, "async-sync-await.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0701");
    assert.match(error.message, /await requires an async call or Task value/);
    return true;
  });

  const synchronousScope = `function use(): i32 { async scope {} return 42; }`;
  assert.throws(() => check(synchronousScope, "async-sync-scope.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0703");
    assert.match(error.message, /async scope requires an enclosing async function/);
    return true;
  });
});

test("borrows immutable values across direct await and scoped task", () => {
  const example = resolve(projectRoot, "examples/async/async-borrowing.zs");
  const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /const Z_DocumentLease \* value_document;/);
  assert.match(
    generated,
    /z_async_start_inspectDocument\(Z_AsyncExecutor \*executor, const Z_DocumentLease \* value_document\)/,
  );
  assert.match(
    generated,
    /z_async_start_inspectNative\(Z_AsyncExecutor \*executor, const zcpp::UniqueValue \* value_resource\)/,
  );
  assert.match(generated, /frame->value_document = value_document;/);
  assert.match(
    generated,
    /z_async_destroy_inspectDocument\(Z_AsyncFrame_inspectDocument \*frame\) \{\n  if \(frame == NULL\) return;\n\}/,
  );

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "observed document 42\nobserved document 42\nnative=41, direct=42, closed=42, live=0\n",
  );

  const parameterOffset = source.indexOf("document: DocumentLease") + 2;
  assert.match(
    hover(source, example, parameterOffset)?.contents.value ?? "",
    /document: DocumentLease/,
  );

  const outsideScope = `
    struct Resource { id: i32; }
    async function inspect(in resource: Resource): i32 { return resource.id; }
    async function main(): i32 {
      const resource = Resource({ id: 42 });
      const task = task inspect(resource);
      return await task;
    }
  `;
  const outsideScopeDiagnostic = diagnostics(outsideScope, "async-borrow-outside-scope.zs")[0];
  assert.equal(outsideScopeDiagnostic.code, "Z0704");
  assert.match(outsideScopeDiagnostic.message, /requires an explicit async scope/);

  const mutation = `
    struct Resource { id: i32; }
    async function inspect(in resource: Resource): i32 { return resource.id; }
    async function main(): i32 {
      let resource = Resource({ id: 42 });
      async scope {
        task inspect(resource);
        resource.id = 43;
      }
      return resource.id;
    }
  `;
  const mutationDiagnostic = diagnostics(mutation, "async-borrow-mutation.zs")[0];
  assert.equal(mutationDiagnostic.code, "Z0704");
  assert.match(mutationDiagnostic.message, /cannot mutate "resource" while a child task borrows it/);

  const moved = `
    import native from ${JSON.stringify(header)};
    async function inspect(in resource: native.zcpp.UniqueValue): i32 { return resource.value(); }
    async function main(): i32 {
      const resource = native.zcpp.UniqueValue(42);
      async scope {
        task inspect(resource);
        return resource.finish(0);
      }
      return 0;
    }
  `;
  const moveDiagnostic = diagnostics(moved, "async-borrow-move.zs")[0];
  assert.equal(moveDiagnostic.code, "Z0704");
  assert.match(moveDiagnostic.message, /cannot move "resource" while a child task borrows it/);

  const ownedClass = `
    class Session { id: i32; }
    async function inspect(in session: Session): i32 { return session.id; }
  `;
  const classDiagnostic = diagnostics(ownedClass, "async-borrow-class.zs")[0];
  assert.equal(classDiagnostic.code, "Z0704");
  assert.match(classDiagnostic.message, /should use the ordinary owned parameter form/);

  const directory = mkdtempSync("/tmp/z-async-borrow-cancel-");
  const cancellation = resolve(directory, "main.zs");
  writeFileSync(cancellation, `
    import { delay } from "std/time";
    import native from ${JSON.stringify(header)};

    async function observe(in resource: native.zcpp.UniqueValue): void {
      await delay(1000);
      return;
    }

    async function failWithBorrow(): i32 throws i32 {
      const resource = native.zcpp.UniqueValue(9);
      async scope {
        task observe(resource);
        throw 7;
      }
    }

    async function main(): i32 {
      const observed = attempt await failWithBorrow();
      return native.zcpp.unique_live();
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const native = resolve(directory, "native.zs");
  writeFileSync(native, `
    import { delay } from "std/time";
    import { zcpp } from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};

    async function adjustLater(inout resource: zcpp.UniqueValue): void {
      await delay(1);
      resource.add(2);
    }

    async function main(): i32 {
      let resource = zcpp.UniqueValue(40);
      async scope {
        const task = task adjustLater(inout resource);
        await task;
      }
      const result = resource.finish(0);
      return result - 42 + zcpp.unique_live();
    }
  `);
  const nativeResult = spawnSync(process.execPath, [cli, "run", native], { encoding: "utf8" });
  assert.equal(nativeResult.status, 0, nativeResult.stderr);
});

test("mutates caller storage through a direct-awaited async inout parameter", () => {
  const example = resolve(projectRoot, "examples/async/async-inout.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /Z_Counter \* value_counter;/);
  assert.match(generated, /zcpp::UniqueValue \* value_resource;/);
  assert.match(
    generated,
    /z_async_start_addAfter\(Z_AsyncExecutor \*executor, Z_Counter \* value_counter, int32_t value_amount\)/,
  );
  assert.match(generated, /z_async_start_addAfter\(frame->task\.executor, &\(frame->value_counter\), 2\)/);
  assert.match(generated, /Z_Counter_add\(&\(\(\*frame->value_counter\)\), frame->value_amount\)/);
  assert.match(generated, /\(\*frame->value_resource\)\.add\(frame->value_amount\)/);
  assert.doesNotMatch(generated, /live_counter/);
  assert.doesNotMatch(generated, /live_resource/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "counter=42, native=42, finished=42, live=0\n");

  const callBindingOffset = source.indexOf("nativeResource, 2") + 2;
  assert.match(
    hover(source, example, callBindingOffset)?.contents.value ?? "",
    /nativeResource: zcpp\.UniqueValue/,
  );

  const spawned = `
    struct Counter { value: i32; }
    async function add(inout counter: Counter): void { return; }
    async function main(): i32 {
      let counter = Counter({ value: 41 });
      task add(inout counter);
      return 0;
    }
  `;
  const spawnedDiagnostic = diagnostics(spawned, "async-task-inout.zs")[0];
  assert.equal(spawnedDiagnostic.code, "Z0704");
  assert.match(spawnedDiagnostic.message, /requires an explicit async scope/);

  const immutable = `
    struct Counter { value: i32; }
    async function add(inout counter: Counter): void { return; }
    async function main(): i32 {
      const counter = Counter({ value: 41 });
      await add(inout counter);
      return counter.value;
    }
  `;
  const immutableDiagnostic = diagnostics(immutable, "async-const-inout.zs")[0];
  assert.equal(immutableDiagnostic.code, "Z0301");
  assert.match(immutableDiagnostic.message, /requires a mutable let binding/);

  const arcRebinding = `
    class Session { id: i32; }
    async function replace(inout session: Session): void { return; }
  `;
  const arcDiagnostic = diagnostics(arcRebinding, "async-class-inout.zs")[0];
  assert.equal(arcDiagnostic.code, "Z0704");
  assert.match(arcDiagnostic.message, /cannot rebind caller storage yet/);

  const directory = mkdtempSync("/tmp/z-async-inout-cancel-");
  const cancellation = resolve(directory, "main.zs");
  writeFileSync(cancellation, `
    import { delay } from "std/time";
    import { zcpp } from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};

    async function adjustEventually(inout resource: zcpp.UniqueValue): void {
      await delay(1000);
      resource.add(1);
    }

    async function holdBorrow(): i32 {
      let resource = zcpp.UniqueValue(41);
      await adjustEventually(inout resource);
      return resource.finish(0);
    }

    async function failSoon(): i32 throws i32 {
      await delay(1);
      throw 7;
    }

    async function coordinate(): i32 throws i32 {
      task holdBorrow();
      return try await failSoon();
    }

    async function main(): i32 {
      const observed = attempt await coordinate();
      return zcpp.unique_live();
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const failure = resolve(directory, "failure.zs");
  writeFileSync(failure, `
    import { delay } from "std/time";

    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void { this.value = this.value + amount; }
    }

    async function mutateThenFail(inout counter: Counter): void throws i32 {
      counter.add(1);
      await delay(1);
      throw 7;
    }

    async function main(): i32 {
      let counter = Counter({ value: 41 });
      const observed = attempt await mutateThenFail(inout counter);
      const error = match (observed) {
        success => 0;
        failure(error) => error;
      };
      return counter.value - 42 + error - 7;
    }
  `);
  const failed = spawnSync(process.execPath, [cli, "run", failure], { encoding: "utf8" });
  assert.equal(failed.status, 0, failed.stderr);
});

test("mutably borrows caller storage through scoped task and releases it on join", () => {
  const example = resolve(projectRoot, "examples/async/async-scoped-inout.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /Z_ImportProgress \* value_progress;/);
  assert.match(
    generated,
    /z_async_start_importBatchAfter\(Z_AsyncExecutor \*executor, Z_ImportProgress \* value_progress, int32_t value_count\)/,
  );
  assert.match(
    generated,
    /z_async_start_importBatchAfter\(frame->task\.executor, &\(frame->value_progress\), 1\)/,
  );
  assert.match(generated, /if \(!z_async_wait\(&frame->task, &frame->child_0->task\)\) return;/);
  assert.match(generated, /Z_ImportProgress_advance\(&\(frame->value_progress\), 1\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "import batch started\nimported=42\n");

  const beforeJoin = `
    struct Counter { value: i32; }
    async function add(inout counter: Counter): void { counter.value = counter.value + 1; }
    async function main(): i32 {
      let counter = Counter({ value: 41 });
      async scope {
        const task = task add(inout counter);
        const observed = counter.value;
        await task;
      }
      return 0;
    }
  `;
  const readDiagnostic = diagnostics(beforeJoin, "async-scoped-inout-read.zs")[0];
  assert.equal(readDiagnostic.code, "Z0704");
  assert.match(readDiagnostic.message, /cannot read "counter" while a child task mutably borrows it/);

  const overlapping = beforeJoin.replace(
    "const observed = counter.value;",
    "const second = task add(inout counter);",
  );
  const overlapDiagnostic = diagnostics(overlapping, "async-scoped-inout-overlap.zs")[0];
  assert.equal(overlapDiagnostic.code, "Z0704");
  assert.match(overlapDiagnostic.message, /cannot borrow "counter" as inout while an active inout loan exists/);
  assert.match(overlapDiagnostic.message, /call- and task-lifetime access use the same exclusivity rules/);

  const callOverlap = `
    struct Counter { value: i32; }
    function combine(in observed: Counter, inout updated: Counter): void {}
    function main(): i32 {
      let counter = Counter({ value: 42 });
      combine(counter, inout counter);
      return 0;
    }
  `;
  const callOverlapDiagnostic = diagnostics(callOverlap, "call-loan-overlap.zs")[0];
  assert.match(callOverlapDiagnostic.message, /overlapping in and inout uses of "counter"/);

  const taskOverlap = `
    struct Counter { value: i32; }
    async function observe(in counter: Counter): void { return; }
    async function update(inout counter: Counter): void { return; }
    async function main(): i32 {
      let counter = Counter({ value: 42 });
      async scope {
        task observe(counter);
        task update(inout counter);
      }
      return 0;
    }
  `;
  const taskOverlapDiagnostic = diagnostics(taskOverlap, "task-loan-overlap.zs")[0];
  assert.match(taskOverlapDiagnostic.message, /cannot borrow "counter" as inout while an active in loan exists/);

  const conditionalJoin = beforeJoin.replace(
    "const observed = counter.value;\n        await task;",
    "if (false) { await task; }\n        const observed = counter.value;",
  );
  const conditionalDiagnostic = diagnostics(conditionalJoin, "async-scoped-inout-conditional-join.zs")[0];
  assert.equal(conditionalDiagnostic.code, "Z0704");
  assert.match(conditionalDiagnostic.message, /cannot read "counter" while a child task mutably borrows it/);

  const joinedOnEveryPath = `
    struct Counter { value: i32; }
    async function add(inout counter: Counter): void { counter.value = counter.value + 1; }
    async function main(): i32 {
      let counter = Counter({ value: 41 });
      const joinNormally = true;
      async scope {
        const task = task add(inout counter);
        if (joinNormally) {
          await task;
        } else {
          await task.cancel();
        }
        counter.value = counter.value + 1;
      }
      return counter.value - 43;
    }
  `;
  check(joinedOnEveryPath, "async-scoped-inout-all-paths-join.zs");
  const conditionalDirectory = mkdtempSync("/tmp/z-async-scoped-inout-conditional-");
  const conditionalProgram = resolve(conditionalDirectory, "main.zs");
  writeFileSync(conditionalProgram, joinedOnEveryPath);
  const conditionalResult = spawnSync(process.execPath, [cli, "run", conditionalProgram], { encoding: "utf8" });
  assert.equal(conditionalResult.status, 0, conditionalResult.stderr);

  const exitingPath = `
    struct Counter { value: i32; }
    async function add(inout counter: Counter): void { counter.value = counter.value + 1; }
    async function updateOrExit(exitEarly: boolean, inout counter: Counter): i32 {
      async scope {
        const task = task add(inout counter);
        if (exitEarly) {
          return 0;
        } else {
          await task;
        }
        counter.value = counter.value + 1;
      }
      return counter.value;
    }
    async function main(): i32 {
      let counter = Counter({ value: 41 });
      const observed = await updateOrExit(false, inout counter);
      return observed - 43;
    }
  `;
  check(exitingPath, "async-scoped-inout-exiting-path.zs");
  const exitingProgram = resolve(conditionalDirectory, "exiting.zs");
  writeFileSync(exitingProgram, exitingPath);
  const exitingResult = spawnSync(process.execPath, [cli, "run", exitingProgram], { encoding: "utf8" });
  assert.equal(exitingResult.status, 0, exitingResult.stderr);

  const sharedAfterOneJoin = `
    struct Resource { value: i32; }
    async function inspect(in resource: Resource): i32 { return resource.value; }
    async function main(): i32 {
      let resource = Resource({ value: 42 });
      async scope {
        const first = task inspect(resource);
        const second = task inspect(resource);
        await first;
        resource.value = 43;
        await second;
      }
      return 0;
    }
  `;
  const sharedDiagnostic = diagnostics(sharedAfterOneJoin, "async-shared-partial-join.zs")[0];
  assert.equal(sharedDiagnostic.code, "Z0704");
  assert.match(sharedDiagnostic.message, /cannot mutate "resource" while a child task borrows it/);
  const sharedAfterBothJoin = sharedAfterOneJoin.replace(
    "resource.value = 43;\n        await second;",
    "await second;\n        resource.value = 43;",
  );
  check(sharedAfterBothJoin, "async-shared-complete-join.zs");

  const directory = mkdtempSync("/tmp/z-async-scoped-inout-cancel-");
  const cancellation = resolve(directory, "main.zs");
  writeFileSync(cancellation, `
    import { delay } from "std/time";

    struct Counter {
      value: i32;
      function add(inout this, amount: i32): void { this.value = this.value + amount; }
    }

    async function addLater(inout counter: Counter): void {
      await delay(1000);
      counter.add(1);
    }

    async function main(): i32 {
      let counter = Counter({ value: 40 });
      async scope {
        const task = task addLater(inout counter);
        await delay(1);
        await task.cancel();
        counter.add(2);
      }
      return counter.value - 42;
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);
});

test("borrows fixed-array storage as Slice across async suspension", () => {
  const example = resolve(projectRoot, "examples/async/async-slices.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /Z_Slice_\S+ value_readings;/);
  assert.match(
    generated,
    /z_async_start_totalAfterDelay\(Z_AsyncExecutor \*executor, Z_Slice_\S+ value_readings\)/,
  );
  assert.match(
    generated,
    /z_async_start_calibrateAfterDelay\(Z_AsyncExecutor \*executor, Z_Slice_\S+ value_readings, int32_t value_adjustment\)/,
  );
  assert.match(generated, /\.data = \(frame->value_readings\)\.data, \.length = 3/);
  assert.match(generated, /z_async_bounds_index/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "calibration started\noriginal=40, calibrated=46\n");

  const outsideScope = `
    async function inspect(values: Slice<i32>): i32 { return values[0]; }
    async function main(): i32 {
      const values = [42];
      const task = task inspect(values);
      return await task;
    }
  `;
  const scopeDiagnostic = diagnostics(outsideScope, "async-slice-scope.zs")[0];
  assert.equal(scopeDiagnostic.code, "Z0704");
  assert.match(scopeDiagnostic.message, /child-task Slice borrow of "values" requires an explicit async scope/);

  const mutateBeforeJoin = `
    async function inspect(values: Slice<i32>): i32 { return values[0]; }
    async function main(): i32 {
      let values = [41];
      async scope {
        const task = task inspect(values);
        values[0] = 42;
        await task;
      }
      return 0;
    }
  `;
  const mutationDiagnostic = diagnostics(mutateBeforeJoin, "async-slice-mutate-before-join.zs")[0];
  assert.equal(mutationDiagnostic.code, "Z0704");
  assert.match(mutationDiagnostic.message, /cannot mutate "values" while a child task borrows it/);

  const mutateAfterJoin = mutateBeforeJoin.replace(
    "values[0] = 42;\n        await task;",
    "await task;\n        values[0] = 42;",
  );
  check(mutateAfterJoin, "async-slice-mutate-after-join.zs");

  const overlapping = `
    async function inspect(values: Slice<i32>): i32 { return values[0]; }
    async function update(inout values: Slice<i32>): void { values[0] = 42; }
    async function main(): i32 {
      let values = [41];
      async scope {
        const reader = task inspect(values);
        const writer = task update(inout values);
        await reader;
        await writer;
      }
      return 0;
    }
  `;
  const overlapDiagnostic = diagnostics(overlapping, "async-slice-overlap.zs")[0];
  assert.equal(overlapDiagnostic.code, "Z0704");
  assert.match(overlapDiagnostic.message, /cannot borrow "values" as inout while an active in loan exists/);
});

test("borrows growable and cleanup-bearing collection storage across async suspension", () => {
  const example = resolve(projectRoot, "examples/async/async-collection-slices.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;

  assert.match(generated, /Z_DynamicArray_\S+ value_readings;/);
  assert.match(generated, /Z_DynamicArray_\S+ value_registered;/);
  assert.match(generated, /Z_DynamicArray_\S+_push\(&\(frame->value_readings\), 10\)/);
  assert.match(generated, /\.data = \(frame->value_registered\)\.data, \.length = \(\(frame->value_registered\)\.length\)/);
  assert.match(generated, /for \(uintptr_t _z_async_cleanup_\S+ = \(frame->value_registered\)\.length;/);
  assert.match(generated, /for \(uintptr_t _z_async_cleanup_\S+ = 2;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "total=40, registered=7, fallback=11\n"
      + "released sensor 13\n"
      + "released sensor 11\n"
      + "released sensor 10\n"
      + "released sensor 9\n"
      + "released sensor 7\n",
  );

  const liveGrow = `
    async function inspect(values: Slice<i32>): i32 { return values[0]; }
    async function main(): i32 {
      let values = Array<i32>();
      values.push(41);
      async scope {
        const task = task inspect(values);
        values.push(42);
        await task;
      }
      return 0;
    }
  `;
  const growDiagnostic = diagnostics(liveGrow, "async-grow-live-slice.zs")[0];
  assert.equal(growDiagnostic.code, "Z0704");
  assert.match(growDiagnostic.message, /cannot mutate "values" while a child task borrows it/);

  const afterJoin = liveGrow.replace(
    "values.push(42);\n        await task;",
    "await task;\n        values.push(42);",
  );
  check(afterJoin, "async-grow-after-join.zs");
});

test("destroys move-only native collection elements on async completion and cancellation", () => {
  const directory = mkdtempSync("/tmp/z-async-native-collections-");
  const sourceFile = resolve(directory, "main.zs");
  const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
  writeFileSync(sourceFile, `
    import native from ${JSON.stringify(header)};
    import { delay } from "std/time";

    async function inspect(values: Slice<native.zcpp.UniqueValue>): i32 {
      await delay(1);
      return values[0].value();
    }

    async function exerciseDynamic(): i32 {
      let values = Array<native.zcpp.UniqueValue>();
      values.push(native.zcpp.UniqueValue(40));
      values.push(native.zcpp.UniqueValue(2));
      return await inspect(values);
    }

    async function exerciseFixed(): i32 {
      const values = [native.zcpp.UniqueValue(20), native.zcpp.UniqueValue(22)];
      return await inspect(values);
    }

    async function holdDynamic(): void {
      let values = Array<native.zcpp.UniqueValue>();
      values.push(native.zcpp.UniqueValue(30));
      values.push(native.zcpp.UniqueValue(31));
      await delay(1000);
    }

    async function holdFixed(): void {
      const values = [native.zcpp.UniqueValue(32), native.zcpp.UniqueValue(33)];
      await delay(1000);
    }

    async function main(): i32 {
      const dynamicValue = await exerciseDynamic();
      const afterDynamic = native.zcpp.unique_live();
      const fixedValue = await exerciseFixed();
      const afterFixed = native.zcpp.unique_live();
      async scope {
        const dynamicTask = task holdDynamic();
        await delay(1);
        await dynamicTask.cancel();
      }
      const afterDynamicCancel = native.zcpp.unique_live();
      async scope {
        const fixedTask = task holdFixed();
        await delay(1);
        await fixedTask.cancel();
      }
      const afterFixedCancel = native.zcpp.unique_live();
      return dynamicValue - 40 + afterDynamic + fixedValue - 20 + afterFixed
        + afterDynamicCancel + afterFixedCancel;
    }
  `);

  const source = readFileSync(sourceFile, "utf8");
  const generated = compileToNative(source, sourceFile).source;
  assert.match(generated, /::operator delete\(\(frame->value_values\)\.data\)/);
  assert.match(generated, /std::destroy_at\(&\(\(frame->value_values\)\.data\[/);
  assert.match(generated, /std::destroy_at\(&\(\(\*std::launder\(reinterpret_cast<Z_Array_/);

  const result = spawnSync(process.execPath, [cli, "run", sourceFile], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("initializes cleanup-free caller storage through a direct-awaited async out parameter", () => {
  const example = resolve(projectRoot, "examples/async/async-out.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /Z_SensorReading \* value_reading;/);
  assert.match(
    generated,
    /z_async_start_readSensorAfter\(Z_AsyncExecutor \*executor, int32_t value_sensorId, Z_SensorReading \* value_reading\)/,
  );
  assert.match(generated, /\(\*frame->value_reading\) = \(Z_SensorReading\)/);
  assert.match(
    generated,
    /z_async_start_readSensorAfter\(frame->task\.executor, 20, &\(frame->value_reading\)\)/,
  );

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sensor=20, celsius=22\n");

  const spawned = `
    async function fill(out value: i32): void { value = 42; }
    async function main(): i32 {
      let value: i32;
      async scope { task fill(out value); }
      return value;
    }
  `;
  const spawnedDiagnostic = diagnostics(spawned, "async-task-out.zs")[0];
  assert.equal(spawnedDiagnostic.code, "Z0704");
  assert.match(spawnedDiagnostic.message, /child-task output borrow of "value" is not supported/);

  const incomplete = `
    async function fill(out value: i32): void { return; }
  `;
  const incompleteDiagnostic = diagnostics(incomplete, "async-incomplete-out.zs")[0];
  assert.equal(incompleteDiagnostic.code, "Z0305");
  assert.match(incompleteDiagnostic.message, /out parameter "value" is not initialized/);

  const ownedOutput = `
    struct Resource {
      value: i32;
      deinit {}
    }
    async function fill(out resource: Resource): void {
      resource = Resource({ value: 42 });
    }
  `;
  const ownedDiagnostic = diagnostics(ownedOutput, "async-owned-out.zs")[0];
  assert.equal(ownedDiagnostic.code, "Z0704");
  assert.match(ownedDiagnostic.message, /cannot initialize ownership-bearing storage yet/);
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
  check(source, "async-methods.zs");

  const borrowedStruct = source.replace("send(move this)", "send()");
  assert.throws(() => check(borrowedStruct, "async-borrowed-method.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /async struct method must take ownership with `move this`/);
    return true;
  });
});

test("runs retained class, consuming struct, and static async methods", () => {
  const example = resolve(projectRoot, "examples/async/async-methods.zs");
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

test("schedules hot child functions and methods on the FIFO executor", () => {
  const example = resolve(projectRoot, "examples/async/async-tasks.zs");
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
    "released child job 22\nreleased child job 23\nreleased task worker 24\n",
  );

  const unacknowledgedFailure = `
    async function fail(): i32 throws i32 { throw 7; }
    async function main(): i32 {
      task fail();
      return 0;
    }
  `;
  assert.throws(() => compileToC(unacknowledgedFailure, "async-unjoined-error.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /throwing child task must be joined explicitly/);
    return true;
  });

  const directory = mkdtempSync("/tmp/z-async-task-error-");
  const failing = resolve(directory, "main.zs");
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
      task finish(resource);
      const failureTask = task fail();
      return try await failureTask;
    }
  `);
  const failed = spawnSync(process.execPath, [cli, "run", failing], { encoding: "utf8" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, "released sibling 9\n");
});

test("joins nested async scopes at their lexical boundaries", () => {
  const example = resolve(projectRoot, "examples/async/async-scopes.zs");
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
        const task = task finish();
        try await task;
      }
      return 0;
    }
  `;
  const acknowledgedC = compileToC(acknowledged, "async-scoped-error.zs");
  assert.match(acknowledgedC, /frame->value_task = NULL/);

  const localValue = `
    async function main(): i32 {
      async scope { const value = 42; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(localValue, "async-scope-local.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /scope-local value bindings are not executable yet/);
    return true;
  });
});

test("routes arbitrary-thread callbacks through named TaskScope ownership", () => {
  const example = resolve(projectRoot, "examples/async/task-scope-native-callback.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /z_task_scope_spawn/);
  assert.match(generated, /z_task_scope_join/);
  assert.match(generated, /z_async_enqueue_from_thread/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "main-executor callback value=40\n");

  const completionSource = 'import { TaskScope } from "std/async"; function inspect(taskScope: TaskScope): void { taskScope.sc; }';
  const completionOffset = completionSource.indexOf("taskScope.sc") + "taskScope.sc".length;
  assert.ok(completions(completionSource, example, completionOffset).some((item) => item.label === "schedule"));

  const namedOffset = source.indexOf("updates {");
  assert.match(hover(source, example, namedOffset)?.contents.value ?? "", /TaskScope/);
  const scheduleOffset = source.indexOf(".schedule(") + 2;
  assert.match(
    hover(source, example, scheduleOffset)?.contents.value ?? "",
    /schedule\(thread\.main, operation: \(\) => void\): boolean/,
  );
  const scopeTokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const scopeDeclaration = positionForOffset(source, source.indexOf("updates {"));
  const scopeUse = positionForOffset(source, source.indexOf("beginCalculation(updates)") + "beginCalculation(".length);
  assert.ok(scopeTokens.some((token) => (
    token.line === scopeDeclaration.line
    && token.character === scopeDeclaration.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));
  assert.ok(scopeTokens.some((token) => (
    token.line === scopeUse.line
    && token.character === scopeUse.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));

  const directory = mkdtempSync("/tmp/z-task-scope-return-");
  const earlyReturn = resolve(directory, "main.zs");
  writeFileSync(earlyReturn, `
    import console from "std/console";
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    function schedule(taskScope: TaskScope): void {
      taskScope.schedule(thread.main, move (): void => { console.log("joined before return"); });
    }
    async function main(): i32 {
      async scope jobs {
        schedule(jobs);
        return 0;
      }
    }
  `);
  const earlyResult = spawnSync(process.execPath, [cli, "run", earlyReturn], { encoding: "utf8" });
  assert.equal(earlyResult.status, 0, earlyResult.stderr);
  assert.equal(earlyResult.stdout, "joined before return\n");

  const explicitReturn = resolve(directory, "explicit.zs");
  writeFileSync(explicitReturn, `
    import console from "std/console";
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    function schedule(taskScope: TaskScope): void {
      taskScope.schedule(thread.main, move (): void => { console.log("explicit scope joined"); });
    }
    async function main(): i32 {
      const taskScope = new TaskScope();
      schedule(taskScope);
      return 0;
    }
  `);
  const explicitResult = spawnSync(process.execPath, [cli, "run", explicitReturn], { encoding: "utf8" });
  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(explicitResult.stdout, "explicit scope joined\n");

  const throwingScope = `
    import { TaskScope } from "std/async";
    async function fail(): void throws i32 {
      const taskScope = new TaskScope();
      throw 7;
    }
    async function main(): i32 {
      const result = attempt await fail();
      return 0;
    }
  `;
  assert.match(
    compileToC(throwingScope, "task-scope-throw.zs"),
    /z_task_scope_join\(frame->value_taskScope, &frame->task, true\)/,
  );
});

test("cancels live siblings and descendants when an async failure propagates", () => {
  const example = resolve(projectRoot, "examples/async/async-cancellation.zs");
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
  const handled = resolve(directory, "main.zs");
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

test("requests and joins caller-driven task cancellation", () => {
  const example = resolve(projectRoot, "examples/async/async-caller-cancellation.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /z_async_cancel\(&frame->child_\d+->task\);/);
  assert.match(generated, /if \(!z_async_wait\(&frame->task, &frame->child_\d+->task\)\) return;/);
  assert.match(generated, /z_async_destroy_download\(frame->child_\d+\);/);
  assert.match(generated, /frame->value_task = NULL;/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "started download 42",
      "cancelling download",
      "released download 42",
      "cancellation joined, live=0",
      "",
    ].join("\n"),
  );

  const directory = mkdtempSync("/tmp/z-async-caller-cancel-");
  const completed = resolve(directory, "completed.zs");
  writeFileSync(completed, `
    import { delay } from "std/time";
    import { zcpp } from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};

    async function makeResource(): zcpp.UniqueValue {
      return zcpp.UniqueValue(42);
    }

    async function main(): i32 {
      const task = task makeResource();
      await delay(1);
      await task.cancel();
      return zcpp.unique_live();
    }
  `);
  const completedResult = spawnSync(process.execPath, [cli, "run", completed], { encoding: "utf8" });
  assert.equal(completedResult.status, 0, completedResult.stderr);

  const completedError = resolve(directory, "completed-error.zs");
  writeFileSync(completedError, `
    import { delay } from "std/time";

    async function fail(): i32 throws i32 {
      throw 7;
    }

    async function main(): i32 {
      const task = task fail();
      await delay(1);
      await task.cancel();
      return 0;
    }
  `);
  const completedErrorResult = spawnSync(
    process.execPath,
    [cli, "run", completedError],
    { encoding: "utf8" },
  );
  assert.equal(completedErrorResult.status, 0, completedErrorResult.stderr);

  const naked = `
    async function work(): i32 { return 42; }
    async function main(): i32 {
      const task = task work();
      task.cancel();
      return 0;
    }
  `;
  const nakedDiagnostic = diagnostics(naked, "async-naked-cancel.zs")[0];
  assert.equal(nakedDiagnostic.code, "Z0702");
  assert.match(nakedDiagnostic.message, /Task\.cancel requires direct await/);

  const spawned = naked.replace("task.cancel();", "task task.cancel();");
  const spawnedDiagnostic = diagnostics(spawned, "async-task-cancel.zs")[0];
  assert.equal(spawnedDiagnostic.code, "Z0703");
  assert.match(spawnedDiagnostic.message, /Task\.cancel cannot be started as another task/);

  const reused = naked.replace("task.cancel();", "await task.cancel(); await task;");
  const reusedDiagnostic = diagnostics(reused, "async-reused-task.zs")[0];
  assert.equal(reusedDiagnostic.code, "Z0201");
  assert.match(reusedDiagnostic.message, /use of moved value "task"/);

  const incomplete = source.replace("task.cancel()", "task.ca");
  const completionOffset = incomplete.indexOf("task.ca") + "task.ca".length;
  const cancelCompletion = completions(incomplete, example, completionOffset)
    .find((item) => item.label === "cancel");
  assert.match(cancelCompletion?.detail ?? "", /consumes the Task/);

  const cancelOffset = source.indexOf("cancel", source.indexOf("task.cancel")) + 1;
  assert.match(hover(source, example, cancelOffset)?.contents.value ?? "", /async cancel\(\): void/);
});

test("suspends async tasks on scheduler-aware std/time delay", () => {
  const example = resolve(projectRoot, "examples/async/async-delay.zs");
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
  assert.throws(() => check(naked, "naked-delay.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0702");
    assert.match(error.message, /requires `await` or `task`/);
    return true;
  });

  const spawned = `
    import { delay } from "std/time";
    async function main(): i32 { task delay(1); return 0; }
  `;
  assert.throws(() => compileToC(spawned, "task-delay.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /starting the delay intrinsic as a task is not executable yet/);
    return true;
  });

  const directory = mkdtempSync("/tmp/z-async-delay-cancel-");
  const cancelled = resolve(directory, "main.zs");
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
      const failure = task fail();
      task linger(TimerResource({ id: 9 }));
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
    import stdio from "stdio.h";
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
      const label: cstring = "async cstring";
      stdio.puts(label);
      console.log(sum(20, 22), point.total(), Point.unit(), true, point, state);
      console.error("debug", false);
      return 0;
    }
  `;
  const generated = compileToC(source, "async-sync-calls.zs");
  assert.match(generated, /show\(&\(frame->value_point\)\)/);
  assert.match(generated, /sum\(20, 22\)/);
  assert.match(generated, /Z_Point_total\(&\(frame->value_point\)\)/);
  assert.match(generated, /Z_Point_unit\(\)/);
  assert.match(generated, /fputs\("Point \{ ", stdout\)/);
  assert.match(generated, /const char \* value_label;/);
  assert.match(generated, /frame->value_label = "async cstring";/);
  assert.match(generated, /puts\(frame->value_label\)/);

  const directory = mkdtempSync("/tmp/z-async-sync-calls-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "helper Point { x: 20, y: 22 }\nanswer async cstring\n42 42 1 true Point { x: 20, y: 22 } State.ready(7)\n",
  );
  assert.equal(result.stderr, "debug false\n");
});

test("runs cleanup-free owned work on an explicit native thread", () => {
  const example = resolve(projectRoot, "examples/async/thread-spawn.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /pthread_create|CreateThread/);
  assert.match(artifact.source, /z_async_start_native_thread/);
  assert.match(artifact.source, /z_async_join_native_thread/);
  assert.match(artifact.source, /z_async_start___z_thread_job_/);
  assert.doesNotMatch(artifact.source, /static int32_t __z_closure_call_/);
  if (process.platform !== "win32") assert.ok(artifact.nativeLinkerArguments.includes("-pthread"));

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "main task continued after thread.spawn\nFIFO executor progressed while native worker ran\nthread answer=42\n",
  );
  assert.match(artifact.source, /pthread_cond_timedwait/);
  assert.match(artifact.source, /SleepConditionVariableCS/);
  assert.match(artifact.source, /z_async_report_native_completion/);
  assert.match(artifact.source, /z_async_drain_native_completions/);
  const nativeCancel = artifact.source.match(
    /static __attribute__\(\(unused\)\) void z_async_cancel\(Z_AsyncTask \*task\) \{[\s\S]*?\n\}/,
  )?.[0] ?? "";
  assert.match(nativeCancel, /__atomic_store_n\(&task->cancellation_requested/);
  assert.doesNotMatch(nativeCancel, /z_async_join_native_thread/);

  const directory = mkdtempSync("/tmp/z-thread-implicit-join-");
  const implicitJoin = resolve(directory, "main.zs");
  writeFileSync(implicitJoin, `
    import console from "std/console";
    import { thread } from "std/thread";
    function finish(): void { console.log("native child joined"); }
    async function main(): i32 {
      const task = thread.spawn(() => finish());
      return 0;
    }
  `);
  const implicitResult = spawnSync(process.execPath, [cli, "run", implicitJoin], { encoding: "utf8" });
  assert.equal(implicitResult.status, 0, implicitResult.stderr);
  assert.equal(implicitResult.stdout, "native child joined\n");

  const spawnUse = source.indexOf("thread.spawn") + "thread.".length + 1;
  assert.match(
    hover(source, example, spawnUse)?.contents.value ?? "",
    /spawn<T>\(operation: \(\) => T\): Task<T>/,
  );
  const completionSource = source.replace("thread.spawn", "thread.sp");
  const completionOffset = completionSource.indexOf("thread.sp") + "thread.sp".length;
  assert.match(
    completions(completionSource, example, completionOffset).find((item) => item.label === "spawn")?.detail ?? "",
    /starts one native thread/,
  );
  const importSource = `import { th } from "std/thread";`;
  const importOffset = importSource.indexOf("th") + 2;
  assert.equal(completions(importSource, example, importOffset).some((item) => item.label === "thread"), true);

  const missingMove = `
    import { thread } from "std/thread";
    async function main(): i32 {
      const input = 41;
      const task = thread.spawn(() => input + 1);
      return await task;
    }
  `;
  assert.throws(() => check(missingMove, "thread-missing-move.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /requires `move`/);
    return true;
  });

  const borrowedCapture = `
    import { thread } from "std/thread";
    async function calculate(in input: i32): i32 {
      const task = thread.spawn(move () => input + 1);
      return await task;
    }
  `;
  assert.throws(() => check(borrowedCapture, "thread-borrow.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /borrowed capture "input" cannot cross/);
    return true;
  });

  const referenceCapture = `
    import { thread } from "std/thread";
    class Session { id: i32; }
    async function main(): i32 {
      const session = new Session({ id: 42 });
      const task = thread.spawn(move () => session.id);
      return await task;
    }
  `;
  assert.throws(() => check(referenceCapture, "thread-reference.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /type "Session" cannot cross/);
    return true;
  });

  const synchronous = `
    import { thread } from "std/thread";
    function main(): i32 {
      const task = thread.spawn(() => 42);
      return 0;
    }
  `;
  assert.throws(() => check(synchronous, "thread-synchronous.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0703");
    assert.match(error.message, /requires an enclosing async function/);
    return true;
  });
});

test("preserves typed errors from thread.spawn as Task<T, E>", () => {
  const example = resolve(projectRoot, "examples/async/thread-errors.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /struct Z_AsyncFrame___z_thread_job_/);
  assert.match(artifact.source, /bool failed;\n\s+Z_WorkError error;/);
  assert.match(artifact.source, /bool live_error;/);
  assert.match(artifact.source, /Z_Result_i32_WorkError _z_thread_try_\d+ = calculate\(/);
  assert.match(artifact.source, /frame->error = _z_thread_try_\d+\.data\.failure/);
  assert.match(artifact.source, /frame->live_error = true/);
  assert.match(artifact.source, /child_\d+->live_error = false/);
  assert.match(artifact.source, /if \(frame->live_error\)/);
  assert.match(artifact.source, /frame->failed = true/);
  assert.match(artifact.source, /z_async_start_native_thread/);

  const failedTaskOffset = source.indexOf("failedTask =") + 1;
  assert.match(hover(source, example, failedTaskOffset)?.contents.value ?? "", /failedTask: Task<i32, WorkError>/);
  const spawnOffset = source.indexOf("thread.spawn") + "thread.".length + 1;
  assert.match(
    hover(source, example, spawnOffset)?.contents.value ?? "",
    /spawn<T, E>\(operation: \(\) => T throws E\): Task<T, E>/,
  );

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "worker failure=7, propagated=7, success=35\n");

  const unhandled = source.replace("attempt await failedTask", "await failedTask");
  const unhandledDiagnostic = diagnostics(unhandled, example)[0];
  assert.equal(unhandledDiagnostic.code, "Z0701");
  assert.match(unhandledDiagnostic.message, /awaiting a throwing task requires `attempt` or `try`/);

  const unshareableError = `
    import { thread } from "std/thread";
    class OwnedError { code: i32; }
    async function main(): i32 throws OwnedError {
      const task = thread.spawn((): i32 throws OwnedError => {
        throw new OwnedError({ code: 7 });
      });
      return try await task;
    }
  `;
  const unshareableErrorDiagnostic = diagnostics(unshareableError, "thread-owned-error.zs")[0];
  assert.equal(unshareableErrorDiagnostic.code, "Z0704");
  assert.match(unshareableErrorDiagnostic.message, /error type "OwnedError" cannot cross/);
  assert.match(unshareableErrorDiagnostic.message, /mutable field "code"/);

  const arcError = `
    import { thread } from "std/thread";
    class OwnedError { readonly code: i32; }
    async function observe(): i32 {
      const task = thread.spawn((): i32 throws OwnedError => {
        throw new OwnedError({ code: 7 });
      });
      const observed = attempt await task;
      return match (in observed) {
        success(value) => value;
        failure(error) => error.code - 7;
      };
    }
    async function main(): i32 { return await observe(); }
  `;
  const arcErrorFile = resolve(mkdtempSync("/tmp/z-thread-arc-error-"), "main.zs");
  writeFileSync(arcErrorFile, arcError);
  const arcErrorResult = spawnSync(process.execPath, [cli, "run", arcErrorFile], { encoding: "utf8" });
  assert.equal(arcErrorResult.status, 0, arcErrorResult.stderr);

  const localClosure = `
    struct WorkError { code: i32; }
    function main(): i32 {
      const operation = (): i32 throws WorkError => {
        throw WorkError({ code: 42 });
      };
      const observed = attempt operation();
      return match (observed) {
        success(value) => value;
        failure(error) => error.code - 42;
      };
    }
  `;
  const directory = mkdtempSync("/tmp/z-thread-error-");
  const localClosureFile = resolve(directory, "local.zs");
  writeFileSync(localClosureFile, localClosure);
  const localClosureResult = spawnSync(process.execPath, [cli, "run", localClosureFile], { encoding: "utf8" });
  assert.equal(localClosureResult.status, 0, localClosureResult.stderr);

  const nativeTryDirectory = mkdtempSync("/tmp/z-thread-native-try-");
  writeFileSync(
    resolve(nativeTryDirectory, "move-only.hpp"),
    readFileSync(resolve(projectRoot, "tests/fixtures/move-only.hpp"), "utf8"),
  );
  writeFileSync(
    resolve(nativeTryDirectory, "move-only.hpp.zd"),
    readFileSync(resolve(projectRoot, "tests/fixtures/move-only.hpp.zd"), "utf8"),
  );
  const nativeTryFile = resolve(nativeTryDirectory, "main.zs");
  writeFileSync(nativeTryFile, `
    import { thread } from "std/thread";
    import native from "move-only.hpp";
    struct WorkError { code: i32; }
    function makeValue(value: i32): native.zcpp.UniqueValue throws WorkError {
      return native.zcpp.UniqueValue(value);
    }
    async function main(): i32 throws WorkError {
      const task = thread.spawn((): native.zcpp.UniqueValue throws WorkError => {
        const value = try makeValue(42);
        return value;
      });
      const value = try await task;
      return value.value() - 42;
    }
  `);
  const nativeTryGenerated = compileToNative(readFileSync(nativeTryFile, "utf8"), nativeTryFile).source;
  assert.match(nativeTryGenerated, /new \(frame->value_value\) zcpp::UniqueValue\(std::move\(_z_thread_try_\d+\.data\.success\)\)/);
  const nativeTryResult = spawnSync(process.execPath, [cli, "run", nativeTryFile], { encoding: "utf8" });
  assert.equal(nativeTryResult.status, 0, nativeTryResult.stderr);

  const embeddedTry = `
    import { thread } from "std/thread";
    struct WorkError { code: i32; }
    function calculate(): i32 throws WorkError { return 41; }
    async function main(): i32 throws WorkError {
      const task = thread.spawn((): i32 throws WorkError => {
        return (try calculate()) + 1;
      });
      return try await task;
    }
  `;
  const embeddedTryDiagnostic = diagnostics(embeddedTry, "thread-embedded-try.zs")[0];
  assert.match(embeddedTryDiagnostic.message, /try must be the direct value of a binding/);

  const missingReturnType = `
    import { thread } from "std/thread";
    struct WorkError { code: i32; }
    async function main(): i32 {
      const task = thread.spawn(() throws WorkError => { throw WorkError({ code: 1 }); });
      return 0;
    }
  `;
  assert.throws(() => check(missingReturnType, "thread-error-return.zs"), /throwing closure requires an explicit return type/);

  const nativeFailureExample = resolve(projectRoot, "examples/async/thread-native-errors.zs");
  const nativeFailureSource = readFileSync(nativeFailureExample, "utf8");
  const nativeFailureGenerated = compileToNative(nativeFailureSource, nativeFailureExample).source;
  assert.match(nativeFailureGenerated, /alignas\(Z_WorkerError\) unsigned char error\[sizeof\(Z_WorkerError\)\]/);
  assert.match(nativeFailureGenerated, /bool live_error;/);
  assert.match(nativeFailureGenerated, /z_async_take\(&\(\(\*std::launder\(reinterpret_cast<Z_WorkerError \*>\([^\n]+->error\)\)\)\), &\([^\n]+->live_error\)\)/);
  const nativeFailureWorker = [...nativeFailureGenerated.matchAll(
    /static void z_async_poll___z_thread_job_\d+\(Z_AsyncTask \*task\) \{[\s\S]*?\n\}/g,
  )].map((match) => match[0]).find((candidate) => candidate.includes("std::destroy_at")) ?? "";
  assert.match(nativeFailureWorker, /frame->failed = true/);
  assert.ok(nativeFailureWorker.indexOf("std::destroy_at") >= 0);
  assert.ok(nativeFailureWorker.indexOf("std::destroy_at") < nativeFailureWorker.indexOf("z_async_complete_task"));

  const nativeFailureResult = spawnSync(process.execPath, [cli, "run", nativeFailureExample], { encoding: "utf8" });
  assert.equal(nativeFailureResult.status, 0, nativeFailureResult.stderr);
});

test("copies plain thread captures and moves uniquely owned Array storage", () => {
  const example = resolve(projectRoot, "examples/async/thread-transfer.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /int32_t value_parentCounter/);
  assert.doesNotMatch(generated, /int32_t \*value_parentCounter/);
  assert.match(generated, /Z_DynamicArray_\S+ value_readings/);
  assert.match(generated, /frame->live_readings = false/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "parent copy remains=20\nthread copy=42, moved owner=42\n",
  );

  const useAfterMove = `
    import { thread } from "std/thread";
    async function main(): i32 {
      let readings = Array<i32>();
      readings.push(42);
      const task = thread.spawn(move () => readings.length);
      const invalid = readings.length;
      return await task;
    }
  `;
  assert.throws(() => check(useAfterMove, "thread-array-move.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0201");
    assert.match(error.message, /use of moved value "readings"/);
    return true;
  });
  const editorMoveDiagnostic = diagnostics(useAfterMove, "thread-array-move.zs")[0];
  assert.equal(editorMoveDiagnostic.code, "Z0201");
  assert.match(editorMoveDiagnostic.message, /use of moved value "readings"/);

  const returnedOwner = `
    import { thread } from "std/thread";
    async function main(): i32 {
      const task = thread.spawn(() => Array<i32>());
      let values = await task;
      values.push(42);
      return values[0] - 42;
    }
  `;
  const directory = mkdtempSync("/tmp/z-thread-owned-result-");
  const returnedOwnerFile = resolve(directory, "main.zs");
  writeFileSync(returnedOwnerFile, returnedOwner);
  const returnedOwnerResult = spawnSync(process.execPath, [cli, "run", returnedOwnerFile], { encoding: "utf8" });
  assert.equal(returnedOwnerResult.status, 0, returnedOwnerResult.stderr);

  const aggregateOwner = `
    import { thread } from "std/thread";
    struct Batch { readings: Array<i32>; }
    async function main(): i32 {
      let readings = Array<i32>();
      readings.push(42);
      const batch = Batch({ readings });
      const task = thread.spawn(move () => batch.readings[0]);
      return await task - 42;
    }
  `;
  const aggregateOwnerFile = resolve(directory, "aggregate.zs");
  writeFileSync(aggregateOwnerFile, aggregateOwner);
  const aggregateOwnerResult = spawnSync(process.execPath, [cli, "run", aggregateOwnerFile], { encoding: "utf8" });
  assert.equal(aggregateOwnerResult.status, 0, aggregateOwnerResult.stderr);

  const customCleanup = `
    import { thread } from "std/thread";
    struct ThreadAffine {
      id: i32;
      deinit {}
    }
    async function main(): i32 {
      const resource = ThreadAffine({ id: 42 });
      const task = thread.spawn(move () => resource.id);
      return await task;
    }
  `;
  assert.throws(() => check(customCleanup, "thread-custom-cleanup.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0704");
    assert.match(error.message, /type "ThreadAffine" cannot cross/);
    return true;
  });
});

test("moves explicitly contracted native owners across thread boundaries", () => {
  const example = resolve(projectRoot, "examples/async/thread-native.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /alignas\(zcpp::UniqueValue\).*value_measurement/);
  assert.match(generated, /z_async_take\([^\n]+value_measurement/);
  assert.match(generated, /\.value\(\)/);
  const nativeWorkerPoll = generated.slice(generated.lastIndexOf("static void z_async_poll___z_thread_job_"));
  assert.ok(nativeWorkerPoll.indexOf("std::destroy_at") >= 0);
  assert.ok(nativeWorkerPoll.indexOf("std::destroy_at") < nativeWorkerPoll.indexOf("z_async_complete_task"));

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "native thread answer=42\n");

  const useAfterMove = source.replace(
    "// measurement is unavailable here: its unique native owner moved to the thread.",
    "const invalid = measurement.value();",
  );
  const movedDiagnostic = diagnostics(useAfterMove, example)[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "measurement"/);

  const cHandleSource = `
    import { thread } from "std/thread";
    import handles from "tests/fixtures/foreign-handles.h";
    async function main(): i32 {
      const handle = handles.z_test_open();
      if (handle == null) return 1;
      const task = thread.spawn(move () => handles.z_test_use(handle));
      return await task;
    }
  `;
  const cHandleGenerated = compileToC(cHandleSource, resolve(projectRoot, "thread-native-handle.zs"));
  assert.match(cHandleGenerated, /ZTestHandle \*\s+value_handle/);
  assert.match(cHandleGenerated, /z_test_close\(frame->value_handle\)/);
  const handleWorkerPoll = cHandleGenerated.slice(cHandleGenerated.lastIndexOf("static void z_async_poll___z_thread_job_"));
  assert.ok(handleWorkerPoll.indexOf("z_test_close(frame->value_handle)") >= 0);
  assert.ok(handleWorkerPoll.indexOf("z_test_close(frame->value_handle)") < handleWorkerPoll.indexOf("z_async_complete_task"));

  const uncontractedDirectory = mkdtempSync("/tmp/z-thread-native-uncontracted-");
  const uncontractedHeader = resolve(uncontractedDirectory, "native.hpp");
  const uncontractedFile = resolve(uncontractedDirectory, "main.zs");
  writeFileSync(uncontractedHeader, readFileSync(resolve(projectRoot, "tests/fixtures/move-only.hpp"), "utf8"));
  writeFileSync(`${uncontractedHeader}.zd`, `
    declare module "native.hpp" {
      export type zcpp.UniqueValue { move; deinit; }
    }
  `);
  const uncontractedSource = `
    import { thread } from "std/thread";
    import native from "native.hpp";
    async function main(): i32 {
      const value = native.zcpp.UniqueValue(42);
      const task = thread.spawn(move () => value.value());
      return await task;
    }
  `;
  const transferDiagnostic = diagnostics(uncontractedSource, uncontractedFile)[0];
  assert.equal(transferDiagnostic.code, "Z0704");
  assert.match(transferDiagnostic.message, /has no thread transfer contract/);
  assert.match(transferDiagnostic.message, /thread \{ transfer; deinit; \}/);

  writeFileSync(`${uncontractedHeader}.zd`, `
    declare module "native.hpp" {
      export type zcpp.UniqueValue {
        move;
        deinit;
        thread { transfer; }
      }
    }
  `);
  const destructionDiagnostic = diagnostics(uncontractedSource, uncontractedFile)[0];
  assert.equal(destructionDiagnostic.code, "Z0704");
  assert.match(destructionDiagnostic.message, /cannot be destroyed on the receiving thread/);

  writeFileSync(`${uncontractedHeader}.zd`, `
    declare module "native.hpp" {
      export type zcpp.UniqueValue {
        move;
        deinit;
        thread { share; deinit; }
      }
    }
  `);
  const sharingDiagnostic = diagnostics(uncontractedSource, uncontractedFile)[0];
  assert.equal(sharingDiagnostic.code, "Z0704");
  assert.match(sharingDiagnostic.message, /native thread sharing, which is reserved but not executable yet/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/move-only.hpp.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const typeOffset = declarationSource.indexOf("UniqueValue") + 2;
  assert.match(hover(declarationSource, declarationFile, typeOffset)?.contents.value ?? "", /thread: transfer, deinit/);
});

test("shares deeply readonly ARC classes through atomic thread captures", () => {
  const example = resolve(projectRoot, "examples/async/thread-shared-class.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /__atomic_add_fetch\(&value->_z_refcount, 1, __ATOMIC_RELAXED\)/);
  assert.match(generated, /__atomic_sub_fetch\(&value->_z_refcount, 1, __ATOMIC_ACQ_REL\)/);
  assert.match(generated, /Z_CalculationInput_retain\(frame->value_input\)/);

  const labelOffset = source.indexOf("label: String") + 1;
  assert.match(hover(source, example, labelOffset)?.contents.value ?? "", /readonly label: String/);
  const labelPosition = positionForOffset(source, source.indexOf("label: String"));
  const labelToken = decodeSemanticTokens(semanticTokens(source, example).data).find((token) => (
    token.line === labelPosition.line && token.character === labelPosition.character
  ));
  assert.equal(labelToken?.modifiers, 3);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "calculation parent input=20\nthread answer=42\n");

  const readonlyMutation = `
    class Configuration { readonly retries: i32; }
    function main(): i32 {
      const configuration = new Configuration({ retries: 3 });
      configuration.retries = 4;
      return 0;
    }
  `;
  const readonlyDiagnostic = diagnostics(readonlyMutation, "readonly-field.zs")[0];
  assert.equal(readonlyDiagnostic.code, "Z0214");
  assert.match(readonlyDiagnostic.message, /cannot assign to readonly field "retries"/);

  const constructorInitialization = `
    class Configuration {
      private readonly retries: i32;
      constructor(retries: i32) { this.retries = retries; }
      function count(): i32 { return this.retries; }
    }
    function main(): i32 {
      const configuration = new Configuration(3);
      return configuration.count() - 3;
    }
  `;
  assert.match(compileToC(constructorInitialization, "readonly-constructor.zs"), /self->retries = retries/);

  const mutableClass = `
    import { thread } from "std/thread";
    class Session { id: i32; }
    async function main(): i32 {
      const session = new Session({ id: 42 });
      const task = thread.spawn(move () => session.id);
      return await task;
    }
  `;
  const mutableDiagnostic = diagnostics(mutableClass, "thread-mutable-class.zs")[0];
  assert.equal(mutableDiagnostic.code, "Z0704");
  assert.match(mutableDiagnostic.message, /cannot cross a native thread boundary/);
  assert.match(mutableDiagnostic.message, /mutable field "id"/);

  const mutableStorage = `
    import { thread } from "std/thread";
    class Values { readonly items: Array<i32>; }
    async function main(): i32 {
      const values = new Values({ items: Array<i32>() });
      const task = thread.spawn(move () => values.items.length);
      return await task;
    }
  `;
  const storageDiagnostic = diagnostics(mutableStorage, "thread-readonly-array.zs")[0];
  assert.equal(storageDiagnostic.code, "Z0704");
  assert.match(storageDiagnostic.message, /mutable Array<i32> storage/);

  const weakShared = `
    import { thread } from "std/thread";
    class Configuration { readonly retries: i32; }
    async function main(): i32 {
      const configuration = new Configuration({ retries: 3 });
      const observer = weak configuration;
      const task = thread.spawn(move () => configuration.retries);
      return await task;
    }
  `;
  const weakDiagnostic = diagnostics(weakShared, "thread-shared-weak.zs")[0];
  assert.equal(weakDiagnostic.code, "Z0704");
  assert.match(weakDiagnostic.message, /cannot cross.*while Weak<Configuration> is used/);
});

test("applies readonly aggregate shorthand to every stored field", () => {
  const source = `
    export readonly struct Snapshot<T> {
      value: T;
      readonly revision: i32;
    }

    readonly class Configuration {
      retries: i32;
      constructor(retries: i32) { this.retries = retries; }
      function count(): i32 { return this.retries; }
    }

    function main(): i32 {
      const snapshot = Snapshot<i32>({ value: 39, revision: 3 });
      const configuration = new Configuration(3);
      return snapshot.value + configuration.count();
    }
  `;
  const generated = compileToC(source, "readonly-aggregate.zs");
  assert.match(generated, /self->retries = retries/);

  const snapshotFieldOffset = source.indexOf("value: T");
  assert.match(hover(source, "readonly-aggregate.zs", snapshotFieldOffset)?.contents.value ?? "", /readonly value: T/);
  const snapshotFieldPosition = positionForOffset(source, snapshotFieldOffset);
  const snapshotFieldToken = decodeSemanticTokens(semanticTokens(source, "readonly-aggregate.zs").data).find((token) => (
    token.line === snapshotFieldPosition.line && token.character === snapshotFieldPosition.character
  ));
  assert.equal(snapshotFieldToken?.modifiers, 3);

  const structMutation = diagnostics(source.replace(
    "return snapshot.value + configuration.count();",
    "snapshot.value = 40; return snapshot.value + configuration.count();",
  ), "readonly-struct-mutation.zs")[0];
  assert.equal(structMutation.code, "Z0214");
  assert.match(structMutation.message, /cannot assign to readonly field "value"/);

  const classMutation = diagnostics(source.replace(
    "return snapshot.value + configuration.count();",
    "configuration.retries = 4; return snapshot.value + configuration.count();",
  ), "readonly-class-mutation.zs")[0];
  assert.equal(classMutation.code, "Z0214");
  assert.match(classMutation.message, /cannot assign to readonly field "retries"/);

  const invalidModifier = diagnostics("readonly enum State { ready }", "readonly-enum.zs")[0];
  assert.match(invalidModifier.message, /`readonly` can only modify a struct or class declaration/);

  const directory = mkdtempSync("/tmp/z-readonly-aggregate-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const nativeCheck = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], { encoding: "utf8" });
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 1 module/);
});

test("moves owned String and TextBuffer storage through native thread frames", () => {
  const example = resolve(projectRoot, "examples/async/thread-text.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /Z_String value_source;/);
  assert.match(generated, /Z_String value_output;/);
  assert.match(generated, /if \(\(frame->value_source\)\.capacity > 0\) free/);
  assert.match(generated, /z_text_buffer_append_ascii/);
  assert.match(generated, /frame->live_output = false/);
  assert.match(generated, /fwrite\(/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "source bytes=6\nworker=42\n");

  const movedString = `
    import { thread } from "std/thread";
    function make(): String { return \`owned=42\`; }
    async function main(): i32 {
      const text = make();
      const task = thread.spawn(move () => text.byteLength);
      const invalid = text.byteLength;
      return await task;
    }
  `;
  const movedDiagnostic = diagnostics(movedString, "thread-string-move.zs")[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "text"/);

  const arrayOfStrings = `
    import { thread } from "std/thread";
    function make(): String { return \`owned=42\`; }
    async function main(): i32 {
      let values = Array<String>();
      values.push(make());
      const task = thread.spawn(move () => values[0].isEmpty ? 1 : 0);
      return await task;
    }
  `;
  const directory = mkdtempSync("/tmp/z-thread-text-");
  const arrayFile = resolve(directory, "array.zs");
  writeFileSync(arrayFile, arrayOfStrings);
  const arrayResult = spawnSync(process.execPath, [cli, "run", arrayFile], { encoding: "utf8" });
  assert.equal(arrayResult.status, 0, arrayResult.stderr);
});
