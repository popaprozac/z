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

test("preserves keyword-named fields through async frames and generator destructuring", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/field-hygiene-async.zs");
  for (const args of [["run", fixture], ["check", fixture, "--native-frontend"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8", timeout: 60000,
    });
    assert.equal(result.status, 0, result.stderr);
  }
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
