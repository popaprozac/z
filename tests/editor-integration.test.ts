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
      createRegistry,
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
      return Builder({ registry: createRegistry() });
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
