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
