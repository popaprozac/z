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

test("moves and destroys cleanup-bearing errors through async task frames", () => {
  const example = resolve(projectRoot, "examples/async/async-owned-errors.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /Z_RequestError error;/);
  assert.match(generated, /bool live_error;/);
  assert.match(generated, /frame->live_error = true/);
  assert.match(generated, /child_\d+->live_error = false/);
  assert.match(generated, /Z_RequestError_deinit\(&\(frame->error\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "released request error 1\nreleased request error 2\nreleased request error 3\n",
  );

  const directory = mkdtempSync("/tmp/z-async-owned-error-kinds-");
  const arcError = resolve(directory, "arc.zs");
  writeFileSync(arcError, `
    import console from "std/console";

    class ServiceError {
      readonly code: i32;
      deinit { console.log(\`released service error \${this.code}\`); }
    }

    async function fail(): i32 throws ServiceError {
      throw new ServiceError({ code: 7 });
    }

    async function main(): i32 {
      const observed = attempt await fail();
      return match (observed) {
        success(value) => value;
        failure(error) => error.code - 7;
      };
    }
  `);
  const arcResult = spawnSync(process.execPath, [cli, "run", arcError], { encoding: "utf8" });
  assert.equal(arcResult.status, 0, arcResult.stderr);
  assert.equal(arcResult.stdout, "released service error 7\n");

  const nativeError = resolve(directory, "native.zs");
  const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
  writeFileSync(nativeError, `
    import native from ${JSON.stringify(header)};

    struct NativeError {
      evidence: native.zcpp.UniqueValue;
    }

    async function fail(): i32 throws NativeError {
      throw NativeError({ evidence: native.zcpp.UniqueValue(9) });
    }

    async function main(): i32 {
      const observed = attempt await fail();
      const code = match (observed) {
        success(value) => value;
        failure(error) => error.evidence.value();
      };
      return code - 9 + native.zcpp.unique_live();
    }
  `);
  const nativeGenerated = compileToNative(readFileSync(nativeError, "utf8"), nativeError).source;
  assert.match(nativeGenerated, /alignas\(Z_NativeError\) unsigned char error\[sizeof\(Z_NativeError\)\]/);
  assert.match(nativeGenerated, /z_async_take\([^\n]+live_error/);
  const nativeResult = spawnSync(process.execPath, [cli, "run", nativeError], { encoding: "utf8" });
  assert.equal(nativeResult.status, 0, nativeResult.stderr);
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
  const cancellationGenerated = compileToNative(
    readFileSync(cancellation, "utf8"),
    cancellation,
  ).source;
  assert.match(cancellationGenerated, /\.data = \{ \.failure = frame->child_\d+->error \}/);
  assert.match(cancellationGenerated, /\.data = \{ \.success = frame->child_\d+->result \}/);
  assert.doesNotMatch(
    cancellationGenerated,
    /\{\s*\.tag\s*=\s*[^,]+,\s*\.data\.[A-Za-z_][A-Za-z0-9_]*\s*=/,
  );
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
  assert.ok(contextualTaskTokens.some((token) => (
    token.line === taskOperatorPosition.line
    && token.character === taskOperatorPosition.character
    && token.type === semanticTokenTypes.indexOf("keyword")
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

test("requires loop-created child tasks to join before the back-edge", () => {
  const unsafeFanOut = `
    import { delay } from "std/time";
    struct Counter { value: i32; }
    async function bump(inout counter: Counter): void {
      const seen = counter.value;
      await delay(1);
      counter.value = seen + 1;
    }
    async function main(): i32 {
      let counter = Counter({ value: 0 });
      let index = 0;
      async scope {
        while (index < 4) {
          task bump(inout counter);
          index = index + 1;
        }
      }
      return counter.value;
    }
  `;
  const diagnostic = diagnostics(unsafeFanOut, "loop-carried-task.zs")[0];
  assert.equal(diagnostic.code, "Z0700");
  assert.match(diagnostic.message, /child task cannot cross a loop back-edge/);
  assert.match(diagnostic.message, /one child slot per syntactic task site/);

  const directory = mkdtempSync("/tmp/z-loop-scoped-task-");
  const fileName = resolve(directory, "main.zs");
  const perIterationJoin = unsafeFanOut
    .replace(
      "task bump(inout counter);",
      "async scope {\n            task bump(inout counter);\n          }",
    )
    .replace("return counter.value;", "return counter.value - 4;");
  writeFileSync(fileName, perIterationJoin);
  check(perIterationJoin, fileName);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const directAwait = unsafeFanOut
    .replace("task bump(inout counter);", "await bump(inout counter);")
    .replace("return counter.value;", "return counter.value - 4;");
  check(directAwait, "loop-direct-await.zs");

  const placedTask = `
    import { thread } from "std/thread";
    async function work(): void {}
    async function main(): i32 {
      let index = 0;
      while (index < 2) {
        task on thread.main work();
        index = index + 1;
      }
      return 0;
    }
  `;
  const placedDiagnostic = diagnostics(placedTask, "loop-placed-task.zs")[0];
  assert.equal(placedDiagnostic.code, "Z0700");
  assert.match(placedDiagnostic.message, /child task cannot cross a loop back-edge/);

  const nativeThread = `
    import { thread } from "std/thread";
    async function main(): i32 {
      let index = 0;
      while (index < 2) {
        thread.spawn((): i32 => 42);
        index = index + 1;
      }
      return 0;
    }
  `;
  const threadDiagnostic = diagnostics(nativeThread, "loop-native-thread.zs")[0];
  assert.equal(threadDiagnostic.code, "Z0700");
  assert.match(threadDiagnostic.message, /native thread cannot cross a loop back-edge/);
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
  const localValueC = compileToC(localValue, "async-scope-local.zs");
  assert.match(localValueC, /frame->value_value = 42/);
});

test("cleans ownership-bearing async scope locals after child tasks join", () => {
  const example = resolve(projectRoot, "examples/async/async-scope-locals.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);

  const join = generated.indexOf("z_async_wait(&frame->task");
  const cleanup = generated.lastIndexOf("Z_Report_deinit(&(frame->value_report))");
  assert.ok(join >= 0, "expected the scoped child join");
  assert.ok(cleanup > join, "expected the scope-local cleanup after the scoped child join");
  assert.match(generated, /frame->live_report = false/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "observed report 42\nreleased report 42\nscope closed\n",
  );

  const directory = mkdtempSync("/tmp/z-async-scope-locals-");
  const exits = resolve(directory, "exits.zs");
  writeFileSync(exits, `
    import console from "std/console";
    import { delay } from "std/time";

    struct Resource {
      id: i32;
      deinit { console.log(\`released local \${this.id}\`); }
    }

    async function observe(in resource: Resource): void {
      await delay(1);
      return;
    }

    async function returnFromScope(): i32 {
      async scope {
        const resource = Resource({ id: 1 });
        task observe(resource);
        return resource.id;
      }
    }

    async function throwFromScope(): i32 throws i32 {
      async scope {
        const resource = Resource({ id: 2 });
        task observe(resource);
        throw 2;
      }
    }

    async function breakFromScope(): i32 {
      while (true) {
        async scope {
          const resource = Resource({ id: 3 });
          task observe(resource);
          break;
        }
      }
      return 3;
    }

    async function continueFromScope(): i32 {
      let iteration = 0;
      while (iteration < 2) {
        async scope {
          const resource = Resource({ id: 10 + iteration });
          task observe(resource);
          iteration = iteration + 1;
          continue;
        }
      }
      return iteration;
    }

    async function main(): i32 {
      const returned = await returnFromScope();
      const failed = attempt await throwFromScope();
      const failure = match (failed) {
        success(value) => value;
        failure(error) => error;
      };
      const broken = await breakFromScope();
      const continued = await continueFromScope();
      return returned + failure + broken + continued - 8;
    }
  `);
  const exited = spawnSync(process.execPath, [cli, "run", exits], { encoding: "utf8" });
  assert.equal(exited.status, 0, exited.stderr);
  assert.equal(
    exited.stdout,
    "released local 1\nreleased local 2\nreleased local 3\nreleased local 10\nreleased local 11\n",
  );

  const cancellation = resolve(directory, "cancellation.zs");
  writeFileSync(cancellation, `
    import console from "std/console";
    import { delay } from "std/time";

    struct Resource {
      id: i32;
      deinit { console.log(\`released cancelled local \${this.id}\`); }
    }

    async function waitWith(in resource: Resource): void {
      await delay(1000);
      return;
    }

    async function cancellable(): void {
      async scope {
        const resource = Resource({ id: 4 });
        task waitWith(resource);
        await delay(1000);
      }
    }

    async function main(): i32 {
      const work = task cancellable();
      await delay(1);
      await work.cancel();
      return 0;
    }
  `);
  const cancelled = spawnSync(process.execPath, [cli, "run", cancellation], { encoding: "utf8" });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(cancelled.stdout, "released cancelled local 4\n");
});

test("routes arbitrary-thread callbacks through named TaskScope ownership", () => {
  const example = resolve(projectRoot, "examples/async/task-scope-native-callback.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /z_task_scope_spawn/);
  assert.match(generated, /z_task_scope_spawn_async/);
  assert.match(generated, /z_task_scope_schedule_async_/);
  assert.match(generated, /z_task_scope_join/);
  assert.match(generated, /z_async_enqueue_from_thread/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "main-executor callback value=40\njoined async callback value=41\n",
  );

  const completionSource = 'import { TaskScope } from "std/async"; function inspect(taskScope: TaskScope): void { taskScope.sc; }';
  const completionOffset = completionSource.indexOf("taskScope.sc") + "taskScope.sc".length;
  assert.ok(completions(completionSource, example, completionOffset).some((item) => item.label === "schedule"));
  const controlSource = `
    import { TaskControl } from "std/async";
    function inspect(control: TaskControl): void {
      control.re;
    }
  `;
  const controlCompletionOffset = controlSource.indexOf("control.re") + "control.re".length;
  assert.ok(completions(controlSource, example, controlCompletionOffset).some((item) => item.label === "requestCancel"));
  const controlHoverSource = controlSource.replace("control.re", "control.requestCancel()");
  const requestCancelOffset = controlHoverSource.indexOf("requestCancel");
  assert.match(
    hover(controlHoverSource, example, requestCancelOffset)?.contents.value ?? "",
    /scope still joins|TaskScope retains join ownership/,
  );

  const namedOffset = source.indexOf("updates {");
  assert.match(hover(source, example, namedOffset)?.contents.value ?? "", /TaskScope/);
  const scheduleOffset = source.indexOf(".schedule(") + 2;
  assert.match(
    hover(source, example, scheduleOffset)?.contents.value ?? "",
    /schedule\(thread\.main, operation: async \(\) => void\): TaskControl/,
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
      const control = taskScope.schedule(thread.main, move (): void => { console.log("joined before return"); });
      if (!control.accepted) console.error("scope closed");
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
      const control = taskScope.schedule(thread.main, move (): void => { console.log("explicit scope joined"); });
      if (!control.accepted) console.error("scope closed");
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

  const directAsyncSchedule = resolve(directory, "direct-async.zs");
  writeFileSync(directAsyncSchedule, `
    import console from "std/console";
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    import { delay } from "std/time";
    async function main(): i32 {
      const taskScope = new TaskScope();
      const message: String = "direct async schedule";
      const control = taskScope.schedule(
        thread.main,
        async move (): void => {
          await delay(1);
          console.log(message);
        }
      );
      await taskScope.close();
      return control.accepted ? 0 : 1;
    }
  `);
  const directAsyncResult = spawnSync(
    process.execPath,
    [cli, "run", directAsyncSchedule],
    { encoding: "utf8" },
  );
  assert.equal(directAsyncResult.status, 0, directAsyncResult.stderr);
  assert.equal(directAsyncResult.stdout, "direct async schedule\n");

  const isolatedSchedule = resolve(directory, "main-isolated-schedule.zs");
  writeFileSync(isolatedSchedule, `
    import console from "std/console";
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    import { delay } from "std/time";
    class Presenter on thread.main {
      offset: i32;
      function publish(value: i32): void {
        console.log(value + this.offset);
      }
      deinit {
        console.log("released scheduled presenter");
      }
    }
    async function main(): i32 on thread.main {
      const taskScope = new TaskScope();
      const presenter = new Presenter({ offset: 2 });
      const control = taskScope.schedule(
        thread.main,
        async move (): void => {
          const worker = thread.spawn(async move (): void => {
            await delay(1);
            await on thread.main using (in presenter) {
              presenter.publish(40);
            }
          });
          await worker;
        }
      );
      await taskScope.close();
      return control.accepted ? 0 : 1;
    }
  `);
  const isolatedScheduleResult = spawnSync(
    process.execPath,
    [cli, "run", isolatedSchedule],
    { encoding: "utf8" },
  );
  assert.equal(isolatedScheduleResult.status, 0, isolatedScheduleResult.stderr);
  assert.equal(isolatedScheduleResult.stdout, "42\nreleased scheduled presenter\n");

  const individualCancellation = resolve(directory, "individual-cancellation.zs");
  writeFileSync(individualCancellation, `
    import console from "std/console";
    import { TaskControl, TaskScope } from "std/async";
    import { thread } from "std/thread";
    class CancellationPanel {
      active: Option<TaskControl>;
      function track(inout this, control: TaskControl): void {
        this.active = Option.some(control);
      }
      function cancelCurrent(inout this): boolean {
        let requested = false;
        match (in this.active) {
          some(control) => { requested = control.requestCancel(); }
          none => {}
        }
        if (requested) this.active = Option.none;
        return requested;
      }
    }
    async function main(): i32 {
      const taskScope = new TaskScope();
      const panel = new CancellationPanel({ active: Option<TaskControl>.none });
      const control: TaskControl = taskScope.schedule(
        thread.main,
        async move (): void => {
          console.error("individually cancelled work should not run");
        }
      );
      panel.track(control);
      const requested = panel.cancelCurrent();
      const requestedAgain = control.requestCancel();
      const observed = control.isCancellationRequested;
      await taskScope.close();
      const rejected = taskScope.schedule(thread.main, async move (): void => {
        console.error("closed scope should reject work");
      });
      if (!control.accepted || !requested || requestedAgain || !observed || rejected.accepted) return 1;
      console.log("individual cancellation joined by scope");
      return 0;
    }
  `);
  const individualCancellationResult = spawnSync(
    process.execPath,
    [cli, "run", individualCancellation],
    { encoding: "utf8" },
  );
  assert.equal(individualCancellationResult.status, 0, individualCancellationResult.stderr);
  assert.equal(individualCancellationResult.stdout, "individual cancellation joined by scope\n");

  const unprovenIsolatedSchedule = `
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    class Presenter on thread.main { offset: i32; }
    function schedule(taskScope: TaskScope, presenter: Presenter): void {
      taskScope.schedule(
        thread.main,
        move (): void => {
          const escaped = presenter;
        }
      );
    }
  `;
  const unprovenDiagnostic = diagnostics(
    unprovenIsolatedSchedule,
    "unproven-main-isolated-schedule.zs",
  )[0];
  assert.equal(unprovenDiagnostic.code, "Z0704");
  assert.match(unprovenDiagnostic.message, /cannot cross to the scope executor/);

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

  const unhandledScheduledError = `
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    function schedule(taskScope: TaskScope): void {
      taskScope.schedule(thread.main, async move (): void throws i32 => { throw 7; });
    }
    async function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(unhandledScheduledError, "task-scope-unhandled-error.zs"),
    /TaskScope\.schedule async operations cannot throw/,
  );

  const borrowedScheduledCapture = `
    import console from "std/console";
    import { TaskScope } from "std/async";
    import { thread } from "std/thread";
    function schedule(taskScope: TaskScope): void {
      const value = 42;
      taskScope.schedule(thread.main, async (): void => { console.log(value); });
    }
    async function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(borrowedScheduledCapture, "task-scope-borrowed-capture.zs"),
    /TaskScope\.schedule requires `move` for a capturing closure/,
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

test("cooperatively yields the current task on its existing executor", () => {
  const example = resolve(projectRoot, "examples/async/scheduler-yield.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.doesNotMatch(generated, /z_async_schedule_delay/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "first: start",
      "second: start",
      "second: finish",
      "first: finish",
      "",
    ].join("\n"),
  );

  const schedulerOffset = source.indexOf("scheduler.yield") + 1;
  assert.match(
    hover(source, example, schedulerOffset)?.contents.value ?? "",
    /standard scheduler module imported as scheduler/,
  );
  const yieldOffset = source.indexOf("yield", source.indexOf("scheduler.yield")) + 1;
  assert.match(
    hover(source, example, yieldOffset)?.contents.value ?? "",
    /cooperatively requeues the current task on its existing executor/,
  );

  const incomplete = source.replace("scheduler.yield()", "scheduler.yi");
  const completionOffset = incomplete.indexOf("scheduler.yi") + "scheduler.yi".length;
  const yieldCompletion = completions(incomplete, example, completionOffset)
    .find((item) => item.label === "yield");
  assert.match(yieldCompletion?.detail ?? "", /cooperatively requeues/);

  const yieldPosition = positionForOffset(source, yieldOffset - 1);
  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  assert.ok(tokens.some((token) => (
    token.line === yieldPosition.line
    && token.character === yieldPosition.character
    && token.type === semanticTokenTypes.indexOf("method")
  )));

  const naked = `
    import { scheduler } from "std/async";
    function main(): i32 {
      scheduler.yield();
      return 0;
    }
  `;
  const nakedDiagnostic = diagnostics(naked, "naked-scheduler-yield.zs")[0];
  assert.equal(nakedDiagnostic.code, "Z0702");
  assert.match(nakedDiagnostic.message, /requires `await` or `task`/);

  const child = `
    import { scheduler } from "std/async";
    async function main(): i32 {
      task scheduler.yield();
      return 0;
    }
  `;
  assert.throws(() => compileToC(child, "task-scheduler-yield.zs"), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0700");
    assert.match(error.message, /cannot start a child task/);
    return true;
  });

  const worker = `
    import { scheduler } from "std/async";
    import { thread } from "std/thread";
    async function main(): i32 {
      const calculation = thread.spawn(async move (): i32 => {
        await scheduler.yield();
        return 42;
      });
      return await calculation - 42;
    }
  `;
  const workerDirectory = mkdtempSync("/tmp/z-scheduler-yield-worker-");
  const workerPath = resolve(workerDirectory, "main.zs");
  writeFileSync(workerPath, worker);
  const workerResult = spawnSync(process.execPath, [cli, "run", workerPath], { encoding: "utf8" });
  assert.equal(workerResult.status, 0, workerResult.stderr);

  const cancellation = `
    import console from "std/console";
    import { scheduler } from "std/async";
    struct Work {
      id: i32;
      deinit { console.log(\`released work \${this.id}\`); }
    }
    async function spin(work: Work): void {
      while (true) {
        await scheduler.yield();
      }
    }
    async function main(): i32 {
      const work = task spin(Work({ id: 42 }));
      await scheduler.yield();
      await work.cancel();
      return 0;
    }
  `;
  const cancellationDirectory = mkdtempSync("/tmp/z-scheduler-yield-cancel-");
  const cancellationPath = resolve(cancellationDirectory, "main.zs");
  writeFileSync(cancellationPath, cancellation);
  const cancellationResult = spawnSync(process.execPath, [cli, "run", cancellationPath], { encoding: "utf8" });
  assert.equal(cancellationResult.status, 0, cancellationResult.stderr);
  assert.equal(cancellationResult.stdout, "released work 42\n");
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

test("suspends and resumes async closures on one dedicated native thread", () => {
  const example = resolve(projectRoot, "examples/async/thread-affine-worker.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.match(artifact.source, /z_async_start_native_thread\(&frame->child_\d+->task, true\)/);
  assert.match(artifact.source, /z_async_executor_init\(task->native_executor, false\)/);
  assert.match(artifact.source, /frame->task\.completion_executor/);
  assert.match(artifact.source, /z_async_enqueue_from_thread\(waiter->executor, waiter\)/);
  assert.match(artifact.source, /z_async_cancel_from_thread\(frame->task\.completion_executor/);
  assert.match(artifact.source, /z_async_schedule_delay\(&frame->task, 1\)/);
  assert.match(artifact.source, /while \(!task->native_body_completed\)/);

  const workerOffset = source.indexOf("worker =") + 1;
  assert.match(
    hover(source, example, workerOffset)?.contents.value ?? "",
    /worker: Task<i32, WorkError>/,
  );
  const spawnOffset = source.indexOf("thread.spawn") + "thread.".length + 1;
  assert.match(
    hover(source, example, spawnOffset)?.contents.value ?? "",
    /accepts synchronous or async one-shot closures/,
  );
  const failureFlagOffset = source.indexOf("shouldFail =") + 1;
  assert.match(
    hover(source, example, failureFlagOffset)?.contents.value ?? "",
    /shouldFail: boolean/,
  );
  const workerTokens = decodeSemanticTokens(semanticTokens(source, example).data);
  for (const [text, offset, modifiers] of [
    ["shouldFail", source.indexOf("shouldFail ="), 3],
    ["shouldFail", source.indexOf("buildStatus(20, shouldFail)") + "buildStatus(20, ".length, 2],
    ["statusTask", source.indexOf("statusTask ="), 3],
    ["statusTask", source.indexOf("await statusTask") + "await ".length, 2],
    ["mainValue", source.indexOf("mainValue ="), 3],
    ["mainValue", source.indexOf("status + mainValue") + "status + ".length, 2],
  ] as const) {
    const position = positionForOffset(source, offset);
    const token = workerTokens.find((candidate) => (
      candidate.line === position.line
      && candidate.character === position.character
      && candidate.type === semanticTokenTypes.indexOf("variable")
    ));
    assert.equal(token?.modifiers, modifiers, `${text} should retain variable highlighting inside thread.spawn`);
  }

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "thread-affine answer=42\n");

  const directory = mkdtempSync("/tmp/z-thread-affine-");
  const failureFile = resolve(directory, "failure.zs");
  writeFileSync(failureFile, `
    import { delay } from "std/time";
    import { thread } from "std/thread";
    struct WorkError { code: i32; }
    async function fail(): i32 throws WorkError on thread.main {
      await delay(1);
      throw WorkError({ code: 42 });
    }
    async function main(): i32 {
      const worker = thread.spawn(async (): i32 throws WorkError => {
        return try await on thread.main: i32 throws WorkError {
          select try await fail();
        };
      });
      const observed = attempt await worker;
      return match (in observed) {
        success(value) => value;
        failure(error) => error.code - 42;
      };
    }
  `);
  const failureResult = spawnSync(process.execPath, [cli, "run", failureFile], { encoding: "utf8" });
  assert.equal(failureResult.status, 0, failureResult.stderr);

  const cancellationFile = resolve(directory, "cancellation.zs");
  writeFileSync(cancellationFile, `
    import { delay } from "std/time";
    import { thread } from "std/thread";
    async function main(): i32 {
      const worker = thread.spawn(async (): i32 => {
        return await on thread.main: i32 {
          await delay(1000);
          select 42;
        };
      });
      await delay(1);
      await worker.cancel();
      return 0;
    }
  `);
  const cancellationResult = spawnSync(
    process.execPath,
    [cli, "run", cancellationFile],
    { encoding: "utf8" },
  );
  assert.equal(cancellationResult.status, 0, cancellationResult.stderr);

  const detachedAsyncClosure = `
    async function main(): i32 {
      const operation = async (): i32 => 42;
      return 0;
    }
  `;
  const detachedDiagnostic = diagnostics(detachedAsyncClosure, "detached-async-closure.zs")[0];
  assert.equal(detachedDiagnostic.code, "Z0703");
  assert.match(detachedDiagnostic.message, /only through thread\.spawn/);
});

test("carries main-isolated ARC identity opaquely through a native worker", () => {
  const source = `
    import console from "std/console";
    import { delay } from "std/time";
    import { thread } from "std/thread";

    class Presenter on thread.main {
      offset: i32;

      function publish(value: i32): i32 {
        return value + this.offset;
      }

      deinit {
        console.log("released presenter");
      }
    }

    async function main(): i32 on thread.main {
      const presenter = new Presenter({ offset: 2 });
      const worker = thread.spawn(async move (): i32 => {
        await delay(1);
        return await on thread.main using (in presenter) {
          select presenter.publish(40);
        };
      });
      const answer = await worker;
      return answer - 42;
    }
  `;
  const artifact = compileToNative(source, "executor-bound-class.zs");
  assert.match(artifact.source, /z_async_release_Presenter_on_executor/);
  assert.match(artifact.source, /z_async_release_from_thread\(frame->task\.completion_executor, frame->value_presenter/);
  assert.match(
    artifact.source,
    /z_async_start___z_executor_main_\d+\(frame->task\.completion_executor, frame->value_presenter\)/,
  );
  assert.doesNotMatch(
    artifact.source,
    /z_async_start___z_executor_main_\d+\(frame->task\.completion_executor, Z_Presenter_retain/,
  );
  const workerUseOffset = source.indexOf("presenter.publish") + 1;
  assert.match(
    hover(source, "executor-bound-class.zs", workerUseOffset)?.contents.value ?? "",
    /executor-isolated to thread\.main/,
  );

  const directory = mkdtempSync("/tmp/z-executor-bound-class-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released presenter\n");

  const directAccess = source.replace(
    "return await on thread.main using (in presenter) {\n          select presenter.publish(40);\n        };",
    "return presenter.publish(40);",
  );
  const directDiagnostic = diagnostics(directAccess, "executor-bound-direct.zs")[0];
  assert.equal(directDiagnostic.code, "Z0704");
  assert.match(directDiagnostic.message, /main-isolated capture "presenter" is only opaque/);
  assert.match(directDiagnostic.message, /await on thread\.main/);

  const escapedAlias = source.replace(
    "await delay(1);",
    "await delay(1);\n        const escaped = presenter;",
  ).replace(
    "using (in presenter) {\n          select presenter.publish(40);",
    "using (in escaped) {\n          select escaped.publish(40);",
  );
  const aliasDiagnostic = diagnostics(escapedAlias, "executor-bound-alias.zs")[0];
  assert.equal(aliasDiagnostic.code, "Z0704");
  assert.match(aliasDiagnostic.message, /main-isolated capture "presenter" is only opaque/);
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
