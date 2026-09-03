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

test("invalidates shared editor analysis when source or an imported module changes", () => {
  const directory = mkdtempSync("/tmp/z-editor-analysis-cache-");
  const dependencyFile = resolve(directory, "dependency.zs");
  const entryFile = resolve(directory, "main.zs");
  const entry = `
    import { value } from "./dependency.zs";
    function main(): i32 { return value(); }
  `;
  try {
    writeFileSync(dependencyFile, `export function value(): i32 { return 1; }`);
    writeFileSync(entryFile, entry);
    assert.deepEqual(diagnostics(entry, entryFile), []);
    // Hover and semantic tokens reuse the successful graph built above.
    assert.match(hover(entry, entryFile, entry.indexOf("value()") + 2)?.contents.value ?? "", /value/);
    assert.ok(semanticTokens(entry, entryFile).data.length > 0);

    writeFileSync(dependencyFile, `export function value(): String { return "changed"; }`);
    const future = new Date(Date.now() + 2_000);
    utimesSync(dependencyFile, future, future);
    assert.match(diagnostics(entry, entryFile)[0]?.message ?? "", /expected i32, found String/);
    // A newly broken dependency must not blank editor information from this
    // unchanged document while the diagnostic is being fixed.
    assert.match(hover(entry, entryFile, entry.indexOf("value()") + 2)?.contents.value ?? "", /value\(\): i32/);
    assert.ok(semanticTokens(entry, entryFile).data.length > 0);

    writeFileSync(dependencyFile, `export function value(): i32 { return 2; }`);
    const repairedDependency = new Date(Date.now() + 4_000);
    utimesSync(dependencyFile, repairedDependency, repairedDependency);
    assert.deepEqual(diagnostics(entry, entryFile), []);

    const repaired = entry.replace("function main(): i32", "function inspect(): i32");
    assert.deepEqual(diagnostics(repaired, entryFile), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps syntax classifications and local hover available after a semantic error", () => {
  const source = `
    trait Named {}

    function broken(): i32 {
      return "wrong";
    }

    function healthy<T: Named>(name: String, service: T): String {
      const snapshot = copy name;
      return snapshot;
    }
  `;
  const fileName = resolve(projectRoot, "error-recovery-editor.zs");
  assert.match(diagnostics(source, fileName)[0]?.message ?? "", /expected i32, found String/);

  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const tokenAt = (text: string, offset: number, type: (typeof semanticTokenTypes)[number]) => {
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => (
      token.line === position.line
      && token.character === position.character
      && token.length === text.length
      && semanticTokenTypes[token.type] === type
    )), `expected ${JSON.stringify(text)} at ${position.line + 1}:${position.character + 1} to remain ${type}`);
  };

  const healthyOffset = source.indexOf("healthy");
  const typeParameterOffset = source.indexOf("T: Named");
  const stringOffset = source.indexOf("name: String") + "name: ".length;
  const nameOffset = source.indexOf("name: String");
  const serviceTypeOffset = source.indexOf("service: T") + "service: ".length;
  const copyOffset = source.indexOf("copy name");
  const copiedNameOffset = copyOffset + "copy ".length;

  tokenAt("healthy", healthyOffset, "function");
  tokenAt("T", typeParameterOffset, "typeParameter");
  tokenAt("String", stringOffset, "type");
  tokenAt("name", nameOffset, "parameter");
  tokenAt("T", serviceTypeOffset, "typeParameter");
  tokenAt("copy", copyOffset, "keyword");
  tokenAt("name", copiedNameOffset, "parameter");

  assert.match(hover(source, fileName, healthyOffset + 2)?.contents.value ?? "", /function healthy<T: Named>/);
  assert.match(hover(source, fileName, stringOffset + 2)?.contents.value ?? "", /owned UTF-8 value/);
  assert.match(hover(source, fileName, nameOffset + 2)?.contents.value ?? "", /name: String/);
  assert.match(hover(source, fileName, serviceTypeOffset)?.contents.value ?? "", /T: Named/);
});

test("highlights and explains wildcard match arms", () => {
  const source = `
    enum Value { number i32, empty, }
    function inspect(value: Value): i32 {
      return match (value) {
        number(number) => number;
        _ => 0;
      };
    }
  `;
  const fileName = resolve(projectRoot, "wildcard-editor.zs");
  const offset = source.indexOf("_ =>") + 1;
  assert.match(
    hover(source, fileName, offset)?.contents.value ?? "",
    /wildcard match arm; matches every remaining case/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const wildcardLine = source.slice(0, source.indexOf("_ =>")).split("\n").length - 1;
  assert.ok(tokens.some((token) => (
    token.line === wildcardLine
    && semanticTokenTypes[token.type] === "keyword"
  )));
});

test("keeps service-style callable registries clean across diagnostics, hover, completion, and tokens", () => {
  const directory = mkdtempSync("/tmp/z-service-editor-");
  const contractFile = resolve(directory, "service-contract.zs");
  const servicesFile = resolve(directory, "services.zs");
  const contract = `
    import { Map } from "std/collections";
    import { thread } from "std/thread";

    export struct Invocation { method: String; }
    export enum Outcome {
      success String,
      failure String,
    }
    export type Handler =
      (in invocation: Invocation) => Outcome on thread.any;
    export struct Registry { handlers: Map<String, Handler>; }
    export function createRegistry(): Registry {
      return Registry({ handlers: Map<String, Handler>() });
    }
  `;
  const services = `
    import {
      Handler,
      Invocation,
      Outcome,
      Registry,
      createRegistry as makeRegistry,
    } from "./service-contract.zs";
    import { Map } from "std/collections";
    import { thread } from "std/thread";

    function invokeAny(in invocation: Invocation): Outcome on thread.any {
      return Outcome.success(copy invocation.method);
    }

    export function createHandler(): Handler {
      return move (in invocation: Invocation): Outcome => invokeAny(in invocation);
    }

    export struct Builder {
      registry: Registry;

      function freeze(move this): Services {
        return new Services({ handlers: this.registry.handlers.freeze() });
      }
    }

    export readonly class Services {
      readonly handlers: readonly Map<String, Handler>;

      function invoke(in invocation: Invocation): Outcome {
        const found = this.handlers.get(invocation.method);
        return match (in found) {
          some(handler) => handler(in invocation);
          none => Outcome.failure("UNKNOWN_METHOD");
        };
      }
    }

    export function createBuilder(): Builder {
      return Builder({ registry: makeRegistry() });
    }
  `;
  try {
    writeFileSync(contractFile, contract);
    writeFileSync(servicesFile, services);

    assert.deepEqual(diagnostics(contract, contractFile), []);
    assert.deepEqual(diagnostics(services, servicesFile), []);

    const successOffset = contract.indexOf("success String") + 2;
    assert.match(
      hover(contract, contractFile, successOffset)?.contents.value ?? "",
      /Outcome\.success\(String\)/,
    );
    const handlerFieldOffset = services.indexOf("handlers: this.registry") + 2;
    const handlerFieldHover = hover(services, servicesFile, handlerFieldOffset)?.contents.value ?? "";
    assert.match(handlerFieldHover, /readonly Map<String, Handler>/);
    assert.doesNotMatch(handlerFieldHover, /__z_/);

    const someOffset = services.indexOf("some(handler)") + 2;
    const someHover = hover(services, servicesFile, someOffset)?.contents.value ?? "";
    assert.match(someHover, /Option<.*Invocation.*Outcome.*thread\.any>\.some/s);
    assert.doesNotMatch(someHover, /__z_/);

    const freezeOffset = services.indexOf("freeze(move this)") + 2;
    assert.match(
      hover(services, servicesFile, freezeOffset)?.contents.value ?? "",
      /freeze\(move this\): Services/,
    );
    const moveOffset = services.indexOf("move this");
    assert.match(
      hover(services, servicesFile, moveOffset + 2)?.contents.value ?? "",
      /consumes this value-struct receiver/,
    );

    const completionSource = services.replace(
      "const found = this.handlers.get(invocation.method);",
      "this.handlers.;\n        const found = this.handlers.get(invocation.method);",
    );
    const completionOffset = completionSource.indexOf("this.handlers.") + "this.handlers.".length;
    const getCompletion = completions(completionSource, servicesFile, completionOffset)
      .find((item) => item.label === "get");
    assert.match(getCompletion?.detail ?? "", /Invocation.*Outcome.*thread\.any/s);
    assert.doesNotMatch(getCompletion?.detail ?? "", /__z_/);

    const contractTokens = decodeSemanticTokens(semanticTokens(contract, contractFile).data);
    const successPosition = positionForOffset(contract, contract.indexOf("success String"));
    assert.ok(contractTokens.some((token) => (
      token.line === successPosition.line
      && token.character === successPosition.character
      && semanticTokenTypes[token.type] === "enumMember"
      && token.modifiers === 1
    )));

    const importedHandler = services.indexOf("Handler,") + 2;
    assert.match(definition(services, `file://${servicesFile}`, importedHandler)?.uri ?? "", /service-contract\.zs$/);
    const importedCreateRegistry = services.indexOf("createRegistry as");
    const aliasedMakeRegistry = services.indexOf("makeRegistry,");
    const calledMakeRegistry = services.lastIndexOf("makeRegistry()");
    const serviceTokens = decodeSemanticTokens(semanticTokens(services, servicesFile).data);
    for (const offset of [importedCreateRegistry, aliasedMakeRegistry, calledMakeRegistry]) {
      const position = positionForOffset(services, offset);
      assert.ok(serviceTokens.some((token) => (
        token.line === position.line
        && token.character === position.character
        && semanticTokenTypes[token.type] === "function"
      )));
    }
    assert.match(hover(services, servicesFile, importedCreateRegistry + 2)?.contents.value ?? "", /function createRegistry/);
    assert.match(hover(services, servicesFile, calledMakeRegistry + 2)?.contents.value ?? "", /Alias of `createRegistry`/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps generic service methods fully classified in source and hover signatures", () => {
  const directory = mkdtempSync("/tmp/z-generic-service-editor-");
  const fileName = resolve(directory, "services.zs");
  const source = `
    import { thread } from "std/thread";
    import { Mutex } from "std/sync";

    internal type AsyncHandler =
      async (in invocation: String) => String on thread.any;

    trait Service {}
    trait ServiceLifecycle {}

    struct State {
      active: boolean = false;
    }

    class Holder<T> {
      readonly state: Mutex<State>;

      function isActive(): boolean {
        return this.state.withLock(
          (in state): boolean => state.active
        );
      }
    }

    internal struct Routes {
      function register<T: Service>(
        inout this,
        name: String,
        service: T
      ): void {}
    }

    export struct ApplicationServicesBuilder {
      internal routes: Routes;

      internal function registerGeneratedWithLifecycle<
        T: Service & ServiceLifecycle
      >(
        inout this,
        name: String,
        service: T
      ): void on thread.main {
        this.routes.register(move name, service);
      }
    }
  `;
  try {
    writeFileSync(resolve(directory, "z.json"), JSON.stringify({
      package: { name: "generic-service-editor", version: "0.1.0" },
      library: { entry: "services.zs" },
    }));
    writeFileSync(fileName, source);
    assert.deepEqual(diagnostics(source, fileName), []);

    const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
    const tokenAt = (text: string, offset: number, type: (typeof semanticTokenTypes)[number]) => {
      const position = positionForOffset(source, offset);
      assert.ok(tokens.some((token) => (
        token.line === position.line
        && token.character === position.character
        && token.length === text.length
        && semanticTokenTypes[token.type] === type
      )), `expected ${JSON.stringify(text)} at ${position.line + 1}:${position.character + 1} to be ${type}`);
    };

    const methodOffset = source.indexOf("registerGeneratedWithLifecycle");
    const invocationOffset = source.indexOf("invocation: String");
    const constraintOffset = source.indexOf("ServiceLifecycle");
    const typeParameterOffset = source.indexOf("T: Service & ServiceLifecycle");
    const stringOffset = source.indexOf("name: String", methodOffset) + "name: ".length;
    const nameOffset = source.indexOf("name: String", methodOffset);
    const serviceOffset = source.indexOf("service: T", methodOffset);
    const threadOffset = source.indexOf("thread.main", methodOffset);
    const mainOffset = threadOffset + "thread.".length;
    const thisOffset = source.indexOf("this.routes", methodOffset);
    const routesOffset = thisOffset + "this.".length;
    const moveOffset = source.indexOf("move name", methodOffset);
    const movedNameOffset = moveOffset + "move ".length;

    tokenAt("registerGeneratedWithLifecycle", methodOffset, "method");
    tokenAt("invocation", invocationOffset, "parameter");
    tokenAt("T", typeParameterOffset, "typeParameter");
    tokenAt("ServiceLifecycle", constraintOffset, "interface");
    tokenAt("String", stringOffset, "type");
    tokenAt("name", nameOffset, "parameter");
    tokenAt("service", serviceOffset, "parameter");
    tokenAt("thread", threadOffset, "namespace");
    tokenAt("main", mainOffset, "property");
    tokenAt("this", thisOffset, "keyword");
    tokenAt("routes", routesOffset, "property");
    tokenAt("move", moveOffset, "keyword");
    tokenAt("name", movedNameOffset, "parameter");

    const methodHover = hover(source, fileName, methodOffset + 2)?.contents.value ?? "";
    assert.match(methodHover, /```z\ninternal function registerGeneratedWithLifecycle<T: Service & ServiceLifecycle>/);
    assert.match(methodHover, /name: String, service: T\): void on thread\.main/);
    assert.match(hover(source, fileName, invocationOffset + 2)?.contents.value ?? "", /in invocation: String/);
    assert.match(hover(source, fileName, stringOffset + 2)?.contents.value ?? "", /owned UTF-8 value/);
    assert.match(hover(source, fileName, nameOffset + 2)?.contents.value ?? "", /name: String/);
    assert.match(hover(source, fileName, moveOffset + 2)?.contents.value ?? "", /move String -> String/);
    assert.match(hover(source, fileName, typeParameterOffset)?.contents.value ?? "", /T: Service & ServiceLifecycle/);
    const activeOffset = source.indexOf("state.active") + "state.".length;
    assert.match(hover(source, fileName, activeOffset + 2)?.contents.value ?? "", /active: boolean/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps test matcher hover after earlier selective imports", () => {
  const source = `
    import { sleep } from "std/time";
    import { expect } from "std/test";

    test "matcher hover" {
      sleep(0);
      expect(42).toEqual(42);
    }
  `;
  const fileName = resolve(projectRoot, "test-matcher-editor.zs");
  assert.deepEqual(diagnostics(source, fileName), []);
  const offset = source.indexOf("toEqual");
  assert.match(
    hover(source, fileName, offset + 2)?.contents.value ?? "",
    /toEqual\(expected: T\): void/,
  );
});

test("keeps hover through indexed and multiline member chains", () => {
  const source = `
    struct Profile {
      workerIds: Array<String>;
    }

    function copyWorkerId(in profile: Profile, workerIndex: usize): String {
      return profile.workerIds[
        workerIndex
      ].copyBytes(
        0,
        profile.workerIds[workerIndex].byteLength
      );
    }
  `;
  const fileName = resolve(projectRoot, "indexed-chain-editor.zs");
  assert.deepEqual(diagnostics(source, fileName), []);

  const copyOffset = source.indexOf("copyBytes");
  assert.match(
    hover(source, fileName, copyOffset + 2)?.contents.value ?? "",
    /copyBytes\(start: usize, end: usize\): String/,
  );
  const lengthOffset = source.indexOf("byteLength");
  assert.match(
    hover(source, fileName, lengthOffset + 2)?.contents.value ?? "",
    /byteLength: usize/,
  );

});

test("keeps authored generic hover through transitive modules and trait constraints", () => {
  const directory = mkdtempSync("/tmp/z-authored-generic-hover-");
  const contractFile = resolve(directory, "contract.zs");
  const routesFile = resolve(directory, "routes.zs");
  const entryFile = resolve(directory, "main.zs");
  const contract = `
    export struct Registry {
      function add(inout this, value: String): void {}
    }

    export trait Engine {
      function result(): i32;
    }
  `;
  const routes = `
    import { Registry } from "./contract.zs";

    export struct Routes {
      registry: Registry;
    }
  `;
  const entry = `
    import { Engine } from "./contract.zs";
    import { Routes } from "./routes.zs";

    struct Builder<T> {
      routes: Routes;

      function register(inout this, value: String): void {
        this.routes.registry.add(move value);
      }
    }

    function observe<E: Engine>(in engine: E): i32 {
      return engine.result();
    }
  `;
  try {
    writeFileSync(resolve(directory, "z.json"), JSON.stringify({
      package: { name: "authored-generic-hover", version: "0.1.0" },
      library: { entry: "main.zs" },
    }));
    writeFileSync(contractFile, contract);
    writeFileSync(routesFile, routes);
    writeFileSync(entryFile, entry);
    assert.deepEqual(diagnostics(entry, entryFile), []);

    const addOffset = entry.indexOf("add(move");
    assert.match(
      hover(entry, entryFile, addOffset + 1)?.contents.value ?? "",
      /add\(inout this, value: String\): void/,
    );
    const resultOffset = entry.indexOf("result()");
    assert.match(
      hover(entry, entryFile, resultOffset + 1)?.contents.value ?? "",
      /result\(\): i32/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("treats canonical C record typedef aliases as one editor-visible argument type", () => {
  const directory = mkdtempSync("/tmp/z-editor-record-alias-");
  const header = resolve(directory, "native.h");
  const file = resolve(directory, "main.zs");
  const source = `
    import native from "./native.h";

    function main(): i32 {
      const point = native.make_point();
      return native.read_alias(point);
    }
  `;
  try {
    writeFileSync(header, `
      typedef struct ZEditorPoint { int value; } ZEditorPoint;
      typedef ZEditorPoint ZEditorPointAlias;
      static inline ZEditorPoint make_point(void) { return (ZEditorPoint){ 42 }; }
      static inline int read_alias(ZEditorPointAlias point) { return point.value - 42; }
    `);
    writeFileSync(file, source);
    assert.deepEqual(diagnostics(source, file), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
