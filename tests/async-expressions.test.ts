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

test("type-checks main-thread executor placement and exposes thread.main to editors", () => {
  const example = resolve(projectRoot, "examples/async/executor-placement.zs");
  const source = readFileSync(example, "utf8");
  check(source, example);
  assert.deepEqual(diagnostics(source, example), []);

  const mainTarget = source.indexOf("thread.main") + "thread.".length + 1;
  assert.match(hover(source, example, mainTarget)?.contents.value ?? "", /thread\.main: Executor/);

  const placedTask = source.indexOf("placedTask =") + 1;
  assert.match(hover(source, example, placedTask)?.contents.value ?? "", /placedTask: Task<i32>/);
  const directCall = source.indexOf("loadStatus(21)") + 1;
  assert.match(hover(source, example, directCall)?.contents.value ?? "", /async function loadStatus\(value: i32\): i32/);

  const incomplete = source.replace("thread.main readStatus", "thread.ma readStatus");
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

  const removedBareForm = `
    import { thread } from "std/thread";
    function inspect(): i32 {
      return on thread.main: i32 { select 1; };
    }
    function main(): i32 { return inspect(); }
  `;
  const bareDiagnostic = diagnostics(removedBareForm, "removed-bare-executor.zs")[0];
  assert.match(bareDiagnostic.message, /expected an expression, found "on"/);

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
    assert.match(error.summary, /enclosing async function or a direct synchronous thread\.spawn closure/);
    assert.match(error.notes.join(" "), /does not inherit its caller's task scope/);
    assert.match(error.helps.join(" "), /keep `task on thread\.main \{ \.\.\. \}` directly in that closure/);
    assert.match(error.helps.join(" "), /thread\.spawn\(async \(\) => await helper\(\)\)/);
    return true;
  });

  const generated = compileToC(source, example);
  assert.match(generated, /z_async_start___z_executor_main_/);
  assert.match(generated, /z_async_start_loadStatus/);
  assert.doesNotMatch(generated, /__z_executor_main_.*loadStatus/);
  assert.match(generated, /z_async_run_one/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

});

test("places direct async calls without nested tasks and preserves parameter capabilities", () => {
  const directory = mkdtempSync("/tmp/z-direct-executor-calls-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import { thread } from "std/thread";

    struct WorkError {
      code: i32;
    }

    struct Counter {
      value: i32;
    }

    class Reader {
      base: i32;

      async function read(value: i32): i32 {
        return this.base + value;
      }
    }

    async function update(inout counter: Counter, amount: i32): i32 throws WorkError {
      counter.value = counter.value + amount;
      return counter.value;
    }

    async function load(value: i32): i32 throws WorkError {
      return value;
    }

    async function main(): i32 throws WorkError {
      let counter = Counter({ value: 20 });
      const reader = new Reader({ base: 1 });
      const methodValue = await on thread.main reader.read(19);
      const first = try await on thread.main update(inout counter, 1);
      const loading = task on thread.main load(counter.value);
      const second = try await loading;
      return methodValue + first + second + counter.value - 83;
    }
  `;
  writeFileSync(fileName, source);
  check(source, fileName);

  const loading = source.indexOf("loading =") + 1;
  assert.match(hover(source, fileName, loading)?.contents.value ?? "", /loading: Task<i32, WorkError>/);
  const generated = compileToC(source, fileName);
  assert.match(generated, /z_async_start_update/);
  assert.match(generated, /z_async_start_load/);
  assert.match(generated, /z_async_start_Reader_read/);
  assert.doesNotMatch(generated, /__z_executor_main_.*(?:update|load)/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("lowers direct placed void calls without inventing a frame result", () => {
  const directory = mkdtempSync("/tmp/z-direct-executor-void-");
  const fileName = resolve(directory, "main.zs");
  try {
    const source = `
      import { thread } from "std/thread";

      function publish(value: i32): void on thread.main {
        if (value == 0) return;
      }

      async function main(): i32 on thread.main {
        const worker = thread.spawn(async (): i32 => {
          await on thread.main publish(42);
          return 42;
        });
        const value = await worker;
        return value - 42;
      }
    `;
    writeFileSync(fileName, source);
    const generated = compileToC(source, fileName);
    assert.match(generated, /publish\(42\);/);
    assert.doesNotMatch(generated, /->result\s*=\s*publish\(42\)/);
    const result = spawnSync(process.execPath, [cli, "run", fileName], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("captures executor-placement blocks through explicit using capabilities", () => {
  const directory = mkdtempSync("/tmp/z-placement-using-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import { thread } from "std/thread";
    struct Counter { value: i32; }
    async function main(): i32 {
      let counter = Counter({ value: 20 });
      const title = "notes";
      let values = Array<i32>();
      values.push(20);

      const first = await on thread.main using (in title, inout counter): i32 {
        if (title == "notes") counter.value = counter.value + 4;
        select counter.value;
      };
      const second = await on thread.main using (move values): i32 {
        select values[0];
      };
      async scope {
        const update = task on thread.main using (inout counter) {
          counter.value = counter.value + 1;
        };
        await update;
        counter.value = counter.value + 1;
      }
      return first + second + counter.value - 70;
    }
  `;
  writeFileSync(fileName, source);
  const usingOffset = source.indexOf("using (in title") + 1;
  assert.match(
    hover(source, fileName, usingOffset)?.contents.value ?? "",
    /explicit lexical capture contract/,
  );
  const inoutOffset = source.indexOf("inout counter") + 1;
  assert.match(
    hover(source, fileName, inoutOffset)?.contents.value ?? "",
    /exclusive mutable loan/,
  );
  const captureNameOffset = source.indexOf("counter", inoutOffset) + 1;
  assert.match(
    hover(source, fileName, captureNameOffset)?.contents.value ?? "",
    /counter: Counter/,
  );
  const completionSource = source.replace("in title, inout counter", "in title, inout cou");
  const completionOffset = completionSource.indexOf("cou): i32 {") + "cou".length;
  const captureCompletions = completions(completionSource, fileName, completionOffset);
  assert.match(captureCompletions.find((item) => item.label === "in")?.detail ?? "", /read-only executor capture/);
  assert.match(captureCompletions.find((item) => item.label === "inout")?.detail ?? "", /exclusive mutable/);
  assert.match(captureCompletions.find((item) => item.label === "move")?.detail ?? "", /transfer unique ownership/);
  assert.ok(captureCompletions.some((item) => item.label === "counter"));

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const movedUse = source.replace(
    "return first + second + counter.value - 70;",
    "return first + second + counter.value + values[0] - 70;",
  );
  const movedDiagnostic = diagnostics(movedUse, fileName)[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "values"/);

  const implicitOwner = source.replace(
    "using (move values): i32",
    ": i32",
  );
  const implicitDiagnostic = diagnostics(implicitOwner, fileName)[0];
  assert.equal(implicitDiagnostic.code, "Z0704");
  assert.match(implicitDiagnostic.message, /capture "values" requires an explicit capability/);

  const readOnlyMutation = source.replace("inout counter): i32", "in counter): i32");
  const readOnlyDiagnostic = diagnostics(readOnlyMutation, fileName)[0];
  assert.equal(readOnlyDiagnostic.code, "Z0704");
  assert.match(readOnlyDiagnostic.message, /read-only executor capture "counter" cannot be mutated/);

  const overlappingUse = source.replace(
    "await update;\n        counter.value",
    "const observed = counter.value;\n        await update;\n        counter.value",
  );
  const overlapDiagnostic = diagnostics(overlappingUse, fileName)[0];
  assert.equal(overlapDiagnostic.code, "Z0704");
  assert.match(overlapDiagnostic.message, /while a child task mutably borrows it/);

  const outCapture = source.replace("move values", "out values");
  const outDiagnostic = diagnostics(outCapture, fileName)[0];
  assert.equal(outDiagnostic.code, "Z0704");
  assert.match(outDiagnostic.message, /`out` executor captures are not supported yet/);

  const duplicateCapture = source.replace("in title, inout counter", "in title, inout counter, in counter");
  const duplicateDiagnostic = diagnostics(duplicateCapture, fileName)[0];
  assert.equal(duplicateDiagnostic.code, "Z0704");
  assert.match(duplicateDiagnostic.message, /duplicate executor capture "counter"/);

  const directUsing = source.replace(
    "await on thread.main using (in title, inout counter): i32 {",
    "await on thread.main using (in title) title.byteLength;",
  );
  const directDiagnostic = diagnostics(directUsing, fileName)[0];
  assert.equal(directDiagnostic.code, "Z0710");
  assert.match(directDiagnostic.message, /belongs to a multi-statement executor-placement block/);
});

test("diagnoses throwing synchronous direct placement before async lowering", () => {
  const source = `
    import { thread } from "std/thread";
    struct WorkError { code: i32; }
    function inspect(value: i32): i32 throws WorkError { return value; }
    async function main(): i32 throws WorkError {
      return try await on thread.main inspect(42);
    }
  `;
  const diagnostic = diagnostics(source, "direct-placed-sync-throw.zs")[0];
  assert.equal(diagnostic.code, "Z0713");
  assert.match(diagnostic.message, /throwing synchronous call cannot be placed directly/);
  assert.match(
    diagnostic.data?.helps.join(" ") ?? "",
    /wrap the synchronous operation in an async function/,
  );
});

test("enforces declaration-header executor affinity and surfaces inherited isolation", () => {
  const source = `
    import { thread } from "std/thread";

    class Controller on thread.main {
      readonly value: i32;

      function read(): i32 {
        return this.value;
      }
    }

    struct WindowModel {
      controller: Controller;
    }

    function readModel(in model: WindowModel): i32 on thread.main {
      return model.controller.read();
    }

    function main(): i32 {
      const controller = new Controller({ value: 42 });
      const model = WindowModel({ controller });
      return readModel(model) - 42;
    }
  `;
  const analysis = analyzeSource(source, "executor-affinity.zs");
  const controllerAffinity = analysis.semanticInfo.aggregateExecutorAffinities.get("Controller");
  assert.deepEqual(controllerAffinity, {
    executor: "main",
    declared: true,
    originType: "Controller",
    fieldPath: [],
  });
  const modelAffinity = analysis.semanticInfo.aggregateExecutorAffinities.get("WindowModel");
  assert.deepEqual(modelAffinity, {
    executor: "main",
    declared: false,
    originType: "Controller",
    fieldPath: ["controller"],
  });

  const controllerOffset = source.indexOf("Controller on") + 1;
  assert.match(hover(source, "executor-affinity.zs", controllerOffset)?.contents.value ?? "", /class Controller on thread\.main/);
  const modelTypeOffset = source.indexOf("WindowModel {") + 1;
  const modelTypeHover = hover(source, "executor-affinity.zs", modelTypeOffset)?.contents.value ?? "";
  assert.match(modelTypeHover, /struct WindowModel on thread\.main/);
  assert.match(modelTypeHover, /inherited from Controller through controller/);
  const functionOffset = source.indexOf("readModel") + 1;
  assert.match(hover(source, "executor-affinity.zs", functionOffset)?.contents.value ?? "", /function readModel.*on thread\.main/);
  const bindingOffset = source.indexOf("model =") + 1;
  assert.match(hover(source, "executor-affinity.zs", bindingOffset)?.contents.value ?? "", /executor-isolated to thread\.main/);

  const offMain = source.replace(
    "function readModel(in model: WindowModel): i32 on thread.main",
    "function readModel(in model: WindowModel): i32",
  );
  const diagnostic = diagnostics(offMain, "executor-affinity-off-main.zs")[0];
  assert.equal(diagnostic.code, "Z0711");
  assert.match(diagnostic.message, /requires thread\.main executor context/);

  const generated = compileToC(source, "executor-affinity.zs");
  assert.match(generated, /Z_Controller_read/);

  const missingCapability = source.replace('import { thread } from "std/thread";', "");
  const capabilityDiagnostic = diagnostics(missingCapability, "executor-affinity-missing-import.zs")[0];
  assert.equal(capabilityDiagnostic.code, "Z0710");
  assert.match(capabilityDiagnostic.message, /requires the thread\.main executor capability/);
});

test("treats executor affinity contravariantly in trait method requirements", () => {
  const broaderImplementation = `
    import { thread } from "std/thread";

    trait MainReadable {
      function read(): i32 on thread.main;
    }

    class Snapshot implements MainReadable {
      readonly value: i32;
      function read(): i32 { return this.value; }
    }

    function main(): i32 {
      const snapshot = new Snapshot({ value: 42 });
      return snapshot.read() - 42;
    }
  `;
  check(broaderImplementation, "executor-trait-broader-implementation.zs");

  const strongerImplementation = `
    import { thread } from "std/thread";

    trait Readable {
      function read(): i32;
    }

    class MainSnapshot implements Readable {
      readonly value: i32;
      function read(): i32 on thread.main { return this.value; }
    }

    function main(): i32 { return 0; }
  `;
  const diagnostic = diagnostics(
    strongerImplementation,
    "executor-trait-stronger-implementation.zs",
  )[0];
  assert.match(
    diagnostic?.message ?? "",
    /does not match trait requirement Readable\.read/,
  );
});

test("preserves executor affinity across Z module boundaries", () => {
  const directory = mkdtempSync("/tmp/z-executor-affinity-modules-");
  try {
    const ui = resolve(directory, "ui.zs");
    const entry = resolve(directory, "main.zs");
    writeFileSync(ui, `
      import { thread } from "std/thread";

      export class Controller on thread.main {
        readonly value: i32;
        function read(): i32 { return this.value; }
      }

      export struct WindowModel {
        controller: Controller;
      }

      export function readModel(in model: WindowModel): i32 on thread.main {
        return model.controller.read();
      }
    `);
    writeFileSync(entry, `
      import { Controller, WindowModel, readModel } from "./ui.zs";

      function main(): i32 {
        const controller = new Controller({ value: 42 });
        const model = WindowModel({ controller });
        return readModel(model) - 42;
      }
    `);
    const source = readFileSync(entry, "utf8");
    check(source, entry);
    const imported = source.indexOf("readModel(model)") + 1;
    assert.match(hover(source, entry, imported)?.contents.value ?? "", /on thread\.main/);
    const importedModel = source.indexOf("WindowModel") + 1;
    const importedModelHover = hover(source, entry, importedModel)?.contents.value ?? "";
    assert.match(importedModelHover, /struct WindowModel on thread\.main/);
    assert.match(importedModelHover, /inherited from Controller through controller/);

    const offMain = source.replace(
      "function main(): i32",
      "function inspect(): i32",
    ).replace(
      "return readModel(model) - 42;",
      "return readModel(model);",
    ) + "\nfunction main(): i32 { return 0; }\n";
    const diagnostic = diagnostics(offMain, entry)[0];
    assert.equal(diagnostic.code, "Z0711");
    assert.match(diagnostic.message, /requires thread\.main executor context/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

hostToolchainTest("imports native executor affinity from Clang metadata and Z declarations", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "tests/fixtures/executor-affinity-test.zs");
  const source = `
    import native from "executor-affinity.h";

    struct WindowState {
      object: native.ZDeclaredMainObject;
    }

    function main(): i32 {
      const annotated = native.ZAnnotatedMainObject.shared();
      const declared = native.ZDeclaredMainObject.shared();
      const methodOnly = native.ZMethodMainObject.shared();
      const annotatedMethod = native.ZAnnotatedMethodObject.shared();
      const state = WindowState({ object: declared });
      annotated.value();
      state.object.value();
      methodOnly.refresh();
      annotatedMethod.refresh();
      native.z_annotated_main_only(0);
      native.z_main_only(0);
      return 0;
    }
  `;
  const analysis = analyzeSource(source, fileName);
  assert.deepEqual(analysis.semanticInfo.aggregateExecutorAffinities.get("WindowState"), {
    executor: "main",
    declared: false,
    originType: "native.ZDeclaredMainObject",
    fieldPath: ["object"],
  });

  const annotated = analysis.foreignModules.get("native")?.interfaces.get("ZAnnotatedMainObject");
  assert.equal(annotated?.metadata.executorAffinity, "main");
  const declared = analysis.foreignModules.get("native")?.interfaces.get("ZDeclaredMainObject");
  assert.equal(declared?.metadata.executorAffinity, "main");
  const method = analysis.foreignModules.get("native")?.interfaces.get("ZMethodMainObject")
    ?.methods.find((candidate) => candidate.selector === "refresh");
  assert.equal(method?.metadata.executorAffinity, "main");
  const annotatedMethod = analysis.foreignModules.get("native")?.interfaces.get("ZAnnotatedMethodObject")
    ?.methods.find((candidate) => candidate.selector === "refresh");
  assert.equal(annotatedMethod?.metadata.executorAffinity, "main");
  const fn = analysis.foreignModules.get("native")?.functions.get("z_main_only")?.overloads[0];
  assert.equal(fn?.metadata.executorAffinity, "main");
  const annotatedFn = analysis.foreignModules.get("native")?.functions.get("z_annotated_main_only")?.overloads[0];
  assert.equal(annotatedFn?.metadata.executorAffinity, "main");

  const annotatedClassOffset = source.indexOf("ZAnnotatedMainObject") + 1;
  assert.match(
    hover(source, fileName, annotatedClassOffset)?.contents.value ?? "",
    /Objective-C class ZAnnotatedMainObject on thread\.main/,
  );
  const declaredBindingOffset = source.indexOf("declared =") + 1;
  assert.match(
    hover(source, fileName, declaredBindingOffset)?.contents.value ?? "",
    /executor-isolated to thread\.main/,
  );
  const refreshOffset = source.indexOf("refresh()") + 1;
  assert.match(hover(source, fileName, refreshOffset)?.contents.value ?? "", /on thread\.main/);
  const nativeFunctionOffset = source.indexOf("z_main_only") + 1;
  assert.match(hover(source, fileName, nativeFunctionOffset)?.contents.value ?? "", /on thread\.main/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/executor-affinity.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const declaredTypeOffset = declarationSource.indexOf("ZDeclaredMainObject") + 1;
  assert.match(
    hover(declarationSource, declarationFile, declaredTypeOffset)?.contents.value ?? "",
    /Objective-C class ZDeclaredMainObject on thread\.main/,
  );
  const incompleteDeclaration = declarationSource.replace("thread.main;", "thread.ma;");
  const declarationCompletionOffset = incompleteDeclaration.indexOf("thread.ma") + "thread.ma".length;
  assert.ok(completions(
    incompleteDeclaration,
    declarationFile,
    declarationCompletionOffset,
  ).some((item) => item.label === "main"));

  const offMainCases = [
    {
      body: "return native.ZAnnotatedMainObject.shared().value();",
      subject: /Objective-C class "ZAnnotatedMainObject"/,
    },
    {
      body: "return native.ZDeclaredMainObject.shared().value();",
      subject: /Objective-C class "ZDeclaredMainObject"/,
    },
    {
      body: "const object = native.ZMethodMainObject.shared(); return object.refresh();",
      subject: /Objective-C method "ZMethodMainObject"."refresh"/,
    },
    {
      body: "const object = native.ZAnnotatedMethodObject.shared(); return object.refresh();",
      subject: /Objective-C method "ZAnnotatedMethodObject"."refresh"/,
    },
    {
      body: "return native.z_annotated_main_only(42);",
      subject: /foreign function "z_annotated_main_only"/,
    },
    {
      body: "return native.z_main_only(42);",
      subject: /foreign function "z_main_only"/,
    },
  ];
  for (const [index, testCase] of offMainCases.entries()) {
    const invalid = `
      import native from "executor-affinity.h";
      function background(): i32 { ${testCase.body} }
      function main(): i32 { return 0; }
    `;
    const diagnostic = diagnostics(invalid, resolve(projectRoot, `tests/fixtures/executor-affinity-invalid-${index}.zs`))[0];
    assert.equal(diagnostic.code, "Z0711", `${index}: ${diagnostic.message}`);
    assert.match(diagnostic.message, testCase.subject);
  }
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

test("borrows Z ARC identities captured by main-executor placement", () => {
  const directory = mkdtempSync("/tmp/z-main-class-capture-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import { thread } from "std/thread";
    class Session { id: i32; }
    async function main(): i32 {
      const session = new Session({ id: 42 });
      const observed = await on thread.main using (in session): i32 {
        select session.id;
      };
      return observed - 42;
    }
  `;
  writeFileSync(fileName, source);

  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /z_async_start___z_executor_main_\d+\([^\n]+frame->value_session\)/);
  assert.doesNotMatch(artifact.source, /z_async_start___z_executor_main_\d+\([^\n]+Z_Session_retain\(frame->value_session\)\)/);
  assert.match(artifact.source, /Z_Session_release\(frame->value_session\)/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

hostToolchainTest("publishes owned worker results through borrowed Objective-C identity on main", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/async/appkit-main-result.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.ok(artifact.frameworks.includes("AppKit"));
  assert.ok(artifact.frameworks.includes("CoreFoundation"));
  assert.match(artifact.source, /z_async_start___z_executor_main_\d+\(Z_AsyncExecutor \*executor, NSApplication \* value_app, const Z_String \* value_status\)/);
  assert.match(artifact.source, /frame->value_app = nil;/);
  assert.doesNotMatch(artifact.source, /z_string_copy_bytes\(frame->value_status, 0, \(frame->value_status\)\.length\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "background work completed\n");
}, 10_000);

test("runs async match expressions with checked arithmetic and editor details", () => {
  const example = resolve(projectRoot, "examples/async/async-overview.zs");
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

test("suspends only in selected logical, ternary, and value-if branches", () => {
  const example = resolve(projectRoot, "examples/async/async-branch-expressions.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /z_async_start_flag/);
  assert.match(generated, /z_async_start_number/);
  assert.match(generated, /frame->state = \(false\) \?/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "flag 2\nflag 4\nflag 5\nnumber 51\nflag 6\nnumber 60\nflag 7\nflag 8\nflag 9\nnumber 70\nflag 12\n",
  );

  const embedded = `
    function consume(value: boolean): i32 { return value ? 0 : 1; }
    async function flag(): boolean { return true; }
    async function main(): i32 {
      return consume(false && await flag());
    }
  `;
  assert.throws(() => compileToC(embedded, "async-embedded-branch.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /short-circuit logic/);
    return true;
  });
});

test("transfers owned results and typed failures through selected async branches", () => {
  const directory = mkdtempSync("/tmp/z-async-branch-ownership-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";

    struct Payload {
      id: i32;
      deinit { console.log(\`released payload \${this.id}\`); }
    }

    async function make(id: i32): Payload {
      console.log(\`made payload \${id}\`);
      return Payload({ id });
    }

    async function fail(code: i32): Payload throws i32 {
      console.log(\`failed payload \${code}\`);
      throw code;
    }

    async function chooseOwned(first: boolean): Payload {
      return first ? await make(1) : await make(2);
    }

    async function chooseFailure(shouldFail: boolean): Payload throws i32 {
      return shouldFail ? try await fail(7) : await make(3);
    }

    async function main(): i32 throws i32 {
      const chosen = await chooseOwned(false);
      const successful = try await chooseFailure(false);
      const failed = attempt await chooseFailure(true);
      const code = match (failed) {
        success(payload) => payload.id;
        failure(error) => error;
      };
      return chosen.id + successful.id + code - 12;
    }
  `);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "made payload 2\nmade payload 3\nfailed payload 7\nreleased payload 3\nreleased payload 2\n",
  );

  const cancellation = resolve(directory, "cancellation.zs");
  writeFileSync(cancellation, `
    import console from "std/console";
    import { delay } from "std/time";

    struct Payload {
      id: i32;
      deinit { console.log(\`released cancelled payload \${this.id}\`); }
    }

    async function delayed(id: i32): Payload {
      const payload = Payload({ id });
      console.log(\`started payload \${id}\`);
      await delay(1000);
      return payload;
    }

    async function choose(): Payload {
      return true ? await delayed(4) : await delayed(5);
    }

    async function main(): i32 {
      const work = task choose();
      await delay(1);
      await work.cancel();
      return 0;
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(
    cancelled.stdout,
    "started payload 4\nreleased cancelled payload 4\n",
  );
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
