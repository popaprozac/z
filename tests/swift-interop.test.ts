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
  swiftModuleCacheArguments,
  test,
  utimesSync,
  writeFileSync,
} from "./support/bootstrap.ts";
import { prepareProject } from "../compiler/src/project.ts";
import type {
  ForeignFunctionDeclaration,
  ForeignModuleDeclarations,
  ImportDeclaration,
} from "./support/bootstrap.ts";

hostToolchainTest("imports and executes Swift through its generated Objective-C compatibility header", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-swift-interop-");
  const header = resolve(directory, "ZSwiftFixture-Swift.h");
  const library = resolve(directory, "libZSwiftFixture.dylib");
  const swiftSource = resolve(projectRoot, "tests/fixtures/swift-fixture.swift");
  const swiftBuild = spawnSync("xcrun", [
    "swiftc",
    ...swiftModuleCacheArguments(),
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
}, 30_000);

hostToolchainTest("builds a declared Swift target for ordinary CLI and editor workflows", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/swift/swift-interop/main.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  const project = prepareProject(example);
  assert.equal(project.targetKind, "executable");
  assert.equal(project.targetName, "swift-interop");
  assert.equal(project.entryPath, example);
  assert.equal(artifact.language, "objective-c");
  assert.equal(artifact.targetKind, "executable");
  assert.equal(artifact.targetName, "swift-interop");
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
    target: {
      name: "invalid-swift",
      entry: "main.zs",
      swift: { module: "not-valid!", sources: ["Counter.swift"] },
    },
  }));
  assert.throws(
    () => compileToNative(readFileSync(invalidSource, "utf8"), invalidSource),
    /target\.swift\.module must be a valid module name/,
  );
}, 30_000);

hostToolchainTest("projects Swift callbacks into tasks and preserves MainActor isolation", () => {
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
  assert.match(artifact.source, /\[ZSwiftMainActorWorker calculate:frame->value_value completion:\^void\(int32_t callback_value_0\)/);
  assert.match(artifact.source, /if \(callback_value_1 != nil\)/);
  assert.match(artifact.source, /frame->error = callback_value_1/);
  assert.match(artifact.source, /z_async_begin_external_completion\(task\)/);
  assert.match(
    artifact.source,
    /if \(__atomic_exchange_n\(&callback_invoked, true, __ATOMIC_ACQ_REL\)\) abort\(\);/,
  );
  assert.match(artifact.source, /z_async_report_external_completion\(&frame->task\)/);
  assert.match(artifact.source, /active_external_callbacks/);
  assert.doesNotMatch(artifact.source, /\[ZSwiftBackgroundWorker waitForCompletion\]/);

  const context = analyzeSource(source, example);
  assert.equal(
    context.projectBuild.foreignApiNotes["ZSwiftTaskScope-Swift.h"]
      ?.types?.ZSwiftMainActorWorker?.executorAffinity,
    "main",
  );
  const calculate = context.foreignModules.get("Swift")
    ?.interfaces.get("ZSwiftBackgroundWorker")
    ?.methods.find((method) => !method.instance && method.selector === "calculate:completion:");
  assert.equal(calculate?.parameters[1]?.type.kind, "block");
  if (calculate?.parameters[1]?.type.kind === "block") {
    assert.equal(calculate.parameters[1].type.escaping, true);
    assert.equal(calculate.parameters[1].type.thread, "any");
    assert.equal(calculate.parameters[1].type.cardinality, "once");
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

  const mainActor = context.foreignModules.get("Swift")
    ?.interfaces.get("ZSwiftMainActorWorker");
  const mainActorCalculate = mainActor
    ?.methods.find((method) => !method.instance && method.selector === "calculate:completion:");
  assert.equal(mainActor?.metadata.executorAffinity, "main");
  assert.equal(mainActorCalculate?.metadata.executorAffinity, "main");
  assert.equal(mainActorCalculate?.asyncCallbackParameter, 1);
  assert.equal(mainActorCalculate?.asyncResultParameter, 0);

  const offMain = `
    import Swift from "ZSwiftTaskScope-Swift.h";
    async function calculate(): i32 {
      return await Swift.ZSwiftMainActorWorker.calculate(40);
    }
  `;
  const offMainDiagnostic = diagnostics(offMain, example)[0];
  assert.equal(offMainDiagnostic.code, "Z0711");
  assert.match(offMainDiagnostic.message, /ZSwiftMainActorWorker.*requires thread\.main executor context/);

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
          invoked once;
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

  const repeatedAsyncContract = readFileSync(
    resolve(projectRoot, "examples/interop/swift/swift-task-scope/ZSwiftTaskScope-Swift.h.zd"),
    "utf8",
  ).replace("invoked once;", "invoked repeatedly;");
  writeFileSync(resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h.zd"), repeatedAsyncContract);
  const repeatedAsyncDiagnostic = diagnostics(invalidSource, invalidFile)[0];
  assert.equal(repeatedAsyncDiagnostic.code, "Z0801");
  assert.match(repeatedAsyncDiagnostic.message, /async callback "completion" requires `invoked once;`/);

  writeFileSync(resolve(invalidDirectory, "ZSwiftTaskScope-Swift.h.zd"), `
    declare module "ZSwiftTaskScope-Swift.h" {
      export function ZSwiftBackgroundWorker.calculateChecked(
        value: _,
        shouldFail: _,
        move completion: _
      ): _ {
        callback completion {
          thread any;
          invoked once;
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
          invoked once;
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
  const mainActorDeclarationHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("ZSwiftMainActorWorker.calculate") + "ZSwiftMainActorWorker.".length + 2,
  )?.contents.value ?? "";
  assert.match(mainActorDeclarationHover, /async calculate\(value: i32\): i32 on thread\.main/);
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
  const mainActorSourceHover = hover(
    source,
    example,
    source.indexOf("ZSwiftMainActorWorker.calculate") + "ZSwiftMainActorWorker.".length + 2,
  )?.contents.value ?? "";
  assert.match(mainActorSourceHover, /async calculate\(value: i32\): i32 on thread\.main/);
  const mainActorTypeHover = hover(
    source,
    example,
    source.indexOf("ZSwiftMainActorWorker") + 2,
  )?.contents.value ?? "";
  assert.match(mainActorTypeHover, /Objective-C class ZSwiftMainActorWorker on thread\.main/);
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

hostToolchainTest("imports and owns a Swift value through its generated C++ compatibility header", () => {
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
}, 60_000);

hostToolchainTest("constructs Swift associated-value enum cases through generated C++ factories", () => {
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
}, 60_000);

hostToolchainTest("records hard Swift surfaces currently withheld by the generated C++ interface", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-swift-boundary-");
  const source = resolve(projectRoot, "tests/fixtures/swift-toolchain-boundaries.swift");
  const header = resolve(directory, "ZSwiftBoundaries-Swift.hpp");
  const library = resolve(directory, "libZSwiftBoundaries.dylib");
  const swiftCompile = spawnSync("xcrun", [
    "swiftc",
    ...swiftModuleCacheArguments(),
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
}, 30_000);
