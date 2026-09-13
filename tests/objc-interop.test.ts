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

hostToolchainTest("imports AppKit classes and emits an ARC Objective-C NSWindow program", () => {
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

  const activateOffset = source.indexOf("app.activate") + "app.".length + 2;
  const activateHover = hover(source, example, activateOffset)?.contents.value ?? "";
  assert.equal((activateHover.match(/activate\(\): void/g) ?? []).length, 1);
  assert.match(activateHover, /activate\(\): void on thread\.main/);
  assert.match(activateHover, /\*\*Objective-C selector:\*\* `activate`/);
  assert.match(activateHover, /\*\*Availability\*\*[\s\S]*macOS: 14\.0\+/);
  assert.doesNotMatch(activateHover, /iOS|watchOS|tvOS/);
}, 20_000);

hostToolchainTest("keeps Objective-C object parameters in native declaration parity", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-contract-functions.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.match(
    artifact.source,
    /z_objc_contract_observe\(object, true\)/,
  );
  assert.match(
    artifact.source,
    /return z_objc_contract_length\(value\)/,
  );

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
}, 30_000);

hostToolchainTest("borrows Objective-C object method parameters through checked declaration contracts", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-borrow-method.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.match(
    artifact.source,
    /\[ZObjCBorrowMethodFixture echo:z_nsstring_from_string\(\(\*value\)\)\]/,
  );
  assert.match(artifact.source, /\(text\)\.length/);

  const execution = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
}, 30_000);

hostToolchainTest("gives every Objective-C C export an autorelease pool", () => {
  if (process.platform !== "darwin") return;
  const source = `
    import Foundation from "Foundation/Foundation.h";

    export c function applicationReady(): boolean {
      return true;
    }

    function main(): i32 { return 0; }
  `;
  const artifact = compileToNative(source, "/tmp/z-objc-export-pool.zs");
  assert.equal(artifact.language, "objective-c");
  assert.match(
    artifact.source,
    /Z_API bool applicationReady\(void\) \{\n  @autoreleasepool \{[\s\S]*?__z_c_impl_\d+_applicationReady\(\)/,
  );
  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);
});

hostToolchainTest("passes projected Objective-C in borrows as references, including nested fields and deinit", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "tests/fixtures/objc-projected-borrow.zs");
  const source = readFileSync(fileName, "utf8");
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /nativeLength\(self->text\)/);
  assert.doesNotMatch(artifact.source, /nativeLength\(&/);
  assert.match(artifact.source, /increment\(&\(/);
  assert.match(artifact.source, /readCount\(&\(/);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "released 4\nreleased 4\n");
  const nativeCheck = spawnSync(process.execPath, [cli, "check", fileName, "--native-frontend"], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
}, 180_000);

hostToolchainTest("prefers an Objective-C class over a legacy protocol with the same name", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "tests/fixtures/objc-class-protocol-collision.zs");
  const source = readFileSync(fileName, "utf8");
  const artifact = compileToNative(source, fileName);

  assert.match(artifact.source, /static NSMenuItem \* createMenuItem\(void\)/);
  assert.match(artifact.source, /NSMenuItem \* const item = createMenuItem\(\);/);
  assert.match(artifact.source, /\[item setTitle:z_nsstring_from_string\(\(definition\)\.title\)\]/);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", fileName, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
}, 60_000);

hostToolchainTest("keeps contextual native option literals in fixed-point parity", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(
    projectRoot,
    "tests/fixtures/objc-contextual-option-literal.zs",
  );
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);
  assert.match(artifact.source, /modifierFlags:0/);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", fixture, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
});

hostToolchainTest("merges Objective-C category methods into their interface surface", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "objc-category-method.zs");
  const source = `
    import AppKit from "AppKit/AppKit.h";
    import { thread } from "std/thread";

    function postWakeEvent(
      app: AppKit.NSApplication,
      event: AppKit.NSEvent
    ): void on thread.main {
      app.postEvent(event, atStart: true);
    }

    function main(): i32 {
      return 0;
    }
  `;
  const artifact = compileToNative(source, fileName);

  assert.deepEqual(diagnostics(source, fileName), []);
  assert.match(artifact.source, /\[app postEvent:event atStart:true\]/);

  const methodOffset = source.indexOf("postEvent") + 2;
  assert.match(
    hover(source, fileName, methodOffset)?.contents.value ?? "",
    /postEvent\(event: (?:AppKit\.)?NSEvent, atStart: boolean\): void on thread\.main/,
  );

  const completionSource = source.replace("app.postEvent", "app.postE");
  const completionOffset = completionSource.indexOf("app.postE") + "app.postE".length;
  assert.equal(
    completions(completionSource, fileName, completionOffset)
      .some((item) => item.label === "postEvent"),
    true,
  );
});

hostToolchainTest("grows and clears ARC-owned Objective-C connection arrays", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "tests/fixtures/objc-connection-array.zs");
  const artifact = compileToNative(readFileSync(fileName, "utf8"), fileName);
  assert.match(artifact.source, /ZObjCConnection \* __strong \*data/);
  assert.match(artifact.source, /self->data\[index\] = nil/);
  const directory = mkdtempSync("/tmp/z-objc-array-");
  try {
    const binary = resolve(directory, "probe");
    for (const optimization of ["-O0", "-O2"]) {
      const build = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks",
        "-Wall", "-Wextra", "-Werror", optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
        "-framework", "AppKit", "-", "-o", binary], { input: artifact.source, encoding: "utf8", timeout: 30000, killSignal: "SIGKILL" });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "clearing\n" + "released callback\n".repeat(9) + "cleared\nleaving\nreleased callback\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

hostToolchainTest("preserves property nullability obscured by availability macros", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "tests/fixtures/objc-property-nullability.zs");
  const source = `import native from "./objc-property-nullability.h";
    function inspect(value: native.ZPropertyRoot): i32 {
      const optional = value.optional;
      if (optional == null) return 0;
      const required = value.required;
      const unspecified = required.unspecified;
      if (unspecified == null) return 1;
      return 2;
    }
    function main(): i32 { return 0; }`;
  const analysis = analyzeSource(source, fileName);
  const native = analysis.foreignModules.get("native")!;
  const root = native.interfaces.get("ZPropertyRoot")!;
  for (const [name, nullable] of [["optional", true], ["required", false], ["unspecified", true]] as const) {
    const property = root.properties.find((item) => item.name === name)!;
    assert.equal(property.type.kind, "object");
    assert.equal((property.type as { nullable: boolean }).nullable, nullable);
    const getter = root.methods.find((item) => item.selector === name)!;
    assert.equal((getter.returnType as { nullable: boolean }).nullable, nullable);
    if (name !== "unspecified") {
      const protocol = native.protocols.get("ZPropertyProtocol")!;
      assert.equal((protocol.methods.find((item) => item.selector === name)!.returnType as { nullable: boolean }).nullable, nullable);
    }
  }
  assert.match(hover(source, fileName, source.indexOf("optional =") + 2)?.contents.value ?? "", /ZPropertyRoot \| null/);
  assert.throws(() => compileToNative(source.replace("if (optional == null) return 0;", "optional.required;"), fileName), /nullable Objective-C/);
  const appKit = `import AppKit from "AppKit/AppKit.h";
    import { thread } from "std/thread";
    function inspect(item: AppKit.NSStatusItem): i32 on thread.main {
      const button = item.button;
      if (button == null) return 0;
      button.toolTip = "Tray";
      return 1;
    }
    function main(): i32 { return 0; }`;
  assert.deepEqual(diagnostics(appKit, fileName), []);
  assert.match(hover(appKit, fileName, appKit.indexOf("button =") + 2)?.contents.value ?? "", /NSStatusBarButton \| null/);
});

hostToolchainTest("narrows nullable Objective-C references before member access", () => {
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
    import { thread } from "std/thread";
    class WindowSlot {
      window: AppKit.NSWindow | null;
      constructor(window: AppKit.NSWindow | null) {
        this.window = window;
      }
    }
    function inspect(window: AppKit.NSWindow | null): i32 on thread.main {
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

hostToolchainTest("narrows dynamic Objective-C objects with instanceof", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-instanceof.zs");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);

  assert.deepEqual(diagnostics(source, fixture), []);
  assert.match(artifact.source, /id const body = \[owner body\];/);
  assert.match(
    artifact.source,
    /\[body isKindOfClass:\[NSString class\]\]/,
  );
  assert.match(artifact.source, /z_string_from_nsstring\(body\)/);

  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-I", resolve(projectRoot, "tests/fixtures"),
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const narrowedUse = source.indexOf("body;", source.indexOf("const text")) + 1;
  assert.match(
    hover(source, fixture, narrowedUse)?.contents.value ?? "",
    /body: Foundation\.NSString/,
  );
  const operatorOffset = source.indexOf("instanceof") + 2;
  assert.match(
    hover(source, fixture, operatorOffset)?.contents.value ?? "",
    /runtime Objective-C class check/,
  );

  const invalidLeft = source.replace(
    "body instanceof Foundation.NSString",
    "42 instanceof Foundation.NSString",
  );
  assert.match(
    diagnostics(invalidLeft, fixture)[0]?.message ?? "",
    /instanceof expects an Objective-C object on the left, found i32/,
  );

  const invalidRight = source.replace(
    "body instanceof Foundation.NSString",
    "body instanceof 42",
  );
  assert.match(
    diagnostics(invalidRight, fixture)[0]?.message ?? "",
    /instanceof expects an imported Objective-C class on the right/,
  );
});

hostToolchainTest("lifts nullable Objective-C references into Option values", () => {
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
}, 10_000);

hostToolchainTest("compiles a desktop ownership slice and preserves its current pressure walls", () => {
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

hostToolchainTest("builds the interactive Z Notes AppKit and sqlite3 application", () => {
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
  assert.match(artifact.source, /ZObjCBinding \* const tableBinding = bindNotesTable\(/);
  assert.match(artifact.source, /ZObjCBinding \* const _z_return_\d+ = z_objc_bind_/);
  assert.match(artifact.source, /z_checked_convert_usize_to_isize/);
  assert.match(artifact.source, /z_checked_convert_isize_to_usize/);
  assert.match(artifact.source, /tableViewSelectionDidChange:/);
  assert.match(artifact.source, /z_async_start_native_thread\(&frame->child_\d+->task, true\)/);
  assert.match(artifact.source, /z_async_executor_init\(task->native_executor, false\)/);
  assert.match(artifact.source, /loadNotesFromPath\(\(frame->live_backgroundPath = false/);
  assert.match(artifact.source, /z_task_scope_schedule_async_/);
  assert.match(artifact.source, /z_task_scope_spawn_async/);
  assert.match(artifact.source, /saveNoteToPath\(/);
  assert.match(artifact.source, /z_task_scope_join\(frame->value_updates, &frame->task, false\)/);
  assert.match(artifact.source, /z_async_start___z_executor_main_/);
  assert.match(artifact.source, /frame->result = runApplication\(/);
  assert.match(artifact.source, /z_async_release_SaveStatusPresenter_on_executor/);
  assert.match(
    artifact.source,
    /z_async_release_from_thread\(frame->task\.completion_executor, frame->value_saveStatus, z_async_release_SaveStatusPresenter_on_executor\)/,
  );
  assert.match(
    artifact.source,
    /z_async_start___z_executor_main_\d+\(frame->task\.completion_executor, frame->value_saveStatus, frame->value_noteId\)/,
  );
  assert.match(artifact.source, /Z_SaveStatusPresenter_persisted\(frame->value_saveStatus/);

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

  const backgroundSmoke = resolve(projectRoot, "examples/applications/z-notes/background-load-smoke.zs");
  const backgroundDatabase = resolve(projectRoot, ".z-cache/z-notes-background-smoke.sqlite3");
  rmSync(backgroundDatabase, { force: true });
  const backgroundResult = spawnSync(
    process.execPath,
    [cli, "run", backgroundSmoke],
    { encoding: "utf8" },
  );
  assert.equal(backgroundResult.status, 0, backgroundResult.stderr);
  assert.equal(backgroundResult.stdout, "background notes=2\n");
  rmSync(backgroundDatabase, { force: true });

  const selectionUse = source.indexOf("selectNote(0)") + 1;
  assert.match(
    hover(source, application, selectionUse)?.contents.value ?? "",
    /public function selectNote\(inout this, index: usize\): boolean/,
  );
  const bindingTypeOffset = source.indexOf("objc.Binding") + "objc.".length + 1;
  assert.match(
    hover(source, application, bindingTypeOffset)?.contents.value ?? "",
    /objc\.Binding/,
  );
  const incompleteBinding = source.replace("objc.Binding", "objc.Bi");
  const incompleteBindingOffset = incompleteBinding.indexOf("objc.Bi") + "objc.Bi".length;
  assert.equal(
    completions(incompleteBinding, application, incompleteBindingOffset)
      .find((item) => item.label === "Binding")?.kind,
    7,
  );
  const presenterUseOffset = source.indexOf("saveStatus.persisted") + 1;
  assert.match(
    hover(source, application, presenterUseOffset)?.contents.value ?? "",
    /executor-isolated to thread\.main/,
  );
  const applicationTokens = decodeSemanticTokens(semanticTokens(source, application).data);
  const bindingTypePosition = positionForOffset(source, source.indexOf("Binding", source.indexOf("objc.Binding")));
  assert.ok(applicationTokens.some((token) => (
    token.line === bindingTypePosition.line
    && token.character === bindingTypePosition.character
    && token.type === semanticTokenTypes.indexOf("class")
  )));
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
    /runtime representability check/,
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
  const prematureStep = persistenceSource.replace(
    "      const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);",
    "      sqlite.sqlite3_step(in queryStatement);\n      const bodyBytes = sqlite.sqlite3_column_text(queryStatement, 2);",
  );
  assert.match(
    diagnostics(prematureStep, persistence)[0]?.message ?? "",
    /cannot call "sqlite3_step" because it can invalidate views derived from "queryStatement" while view "titleBytes" is live/,
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
  const invalidatesOffset = declarationSource.indexOf("invalidates pStmt") + 2;
  assert.match(
    hover(declarationSource, declarationFile, invalidatesOffset)?.contents.value ?? "",
    /invalidates pStmt.*may invalidate every outstanding view/,
  );
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
    target: {
      name: "availability",
      entry: "main.zs",
      platform: "macos",
      minimumVersion: "13.0",
    },
  }));
  const availabilityDiagnostic = diagnostics(availabilitySource, availabilityFile)[0];
  assert.equal(availabilityDiagnostic?.code, "Z0802");
  assert.match(availabilityDiagnostic?.message ?? "", /requires macOS 14\.0, but the deployment target is macOS 13\.0/);
}, 120_000);

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
    /^workspace registered=3, saved=3, found=42, endpoints=40\.\.42, save count=1, rejected=100, empty save=200, native moves=[1-9][0-9]*, live=0\n$/,
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
    /DocumentStore_withDocument\(const Z_[A-Za-z0-9_]*DocumentStore \*self, int32_t z_id, const Z_Function_[A-Za-z0-9_]+ \*visit\)/,
  );
  assert.match(generated, /const Z_[A-Za-z0-9_]*Document \*document = &/);
  assert.match(generated, /DocumentStore_documentSnapshot\(const Z_[A-Za-z0-9_]*DocumentStore \*self, int32_t z_id\)/);
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
  const ownedGenerated = compileToC(ownedInsideAsync, "async-owned-inline-closure.zs");
  assert.match(ownedGenerated, /Z_ClosureEnv_/);

  const ownedFile = resolve(closureDirectory, "owned.zs");
  writeFileSync(ownedFile, ownedInsideAsync);
  const ownedResult = spawnSync(process.execPath, [cli, "run", ownedFile], { encoding: "utf8" });
  assert.equal(ownedResult.status, 0, ownedResult.stderr);
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

  const storedProvenance = `
    import { Arena } from "std/memory";
    struct Coordinate { value: i32; }
    struct Span { first: view Coordinate; last: view Coordinate; }
    function total(in span: Span): i32 {
      const first = span.first;
      const last = span.last;
      return first.value + last.value;
    }
    function main(): i32 {
      let arena = Arena();
      const first = arena.create(Coordinate({ value: 20 }));
      const last = arena.create(Coordinate({ value: 22 }));
      const pending = Span({ first, last });
      const stored = arena.create(pending);
      const answer = total(stored);
      arena.reset();
      return answer - 42;
    }
  `;
  const storedDirectory = mkdtempSync("/tmp/z-arena-stored-provenance-");
  const storedFile = resolve(storedDirectory, "main.zs");
  writeFileSync(storedFile, storedProvenance);
  const storedGenerated = compileToC(storedProvenance, storedFile);
  assert.match(storedGenerated, /const Z_Coordinate \* first;/);
  assert.match(storedGenerated, /z_arena_create_Span/);
  const storedResult = spawnSync(process.execPath, [cli, "run", storedFile], { encoding: "utf8" });
  assert.equal(storedResult.status, 0, storedResult.stderr);

  const storedEnumProvenance = `
    import { Arena } from "std/memory";
    struct Coordinate { value: i32; }
    struct Span { first: view Coordinate; last: view Coordinate; }
    enum StoredSpan { primary Span, alternate Span, }
    struct Node { span: StoredSpan; }
    function total(in span: Span): i32 {
      const first = span.first;
      const last = span.last;
      return first.value + last.value;
    }
    function inspect(in span: StoredSpan): i32 {
      return match (in span) {
        primary(value) => total(in value);
        alternate(value) => total(in value);
      };
    }
    function main(): i32 {
      let arena = Arena();
      const first = arena.create(Coordinate({ value: 20 }));
      const last = arena.create(Coordinate({ value: 22 }));
      const pendingSpan = StoredSpan.primary(Span({ first, last }));
      const pending = Node({ span: pendingSpan });
      const stored = arena.create(pending);
      const span = stored.span;
      const answer = inspect(in span);
      const directFirst = arena.create(Coordinate({ value: 19 }));
      const directLast = arena.create(Coordinate({ value: 23 }));
      const directPending = StoredSpan.alternate(Span({
        first: directFirst,
        last: directLast,
      }));
      const directStored = arena.create(directPending);
      const directAnswer = inspect(in directStored);
      arena.reset();
      return answer + directAnswer - 84;
    }
  `;
  const storedEnumDirectory = mkdtempSync("/tmp/z-arena-stored-enum-");
  const storedEnumFile = resolve(storedEnumDirectory, "main.zs");
  writeFileSync(storedEnumFile, storedEnumProvenance);
  const storedEnumResult = spawnSync(
    process.execPath,
    [cli, "run", storedEnumFile],
    { encoding: "utf8" },
  );
  assert.equal(storedEnumResult.status, 0, storedEnumResult.stderr);

  const wrongEnumRegion = storedEnumProvenance.replace(
    "const stored = arena.create(pending);",
    "let other = Arena();\n      const stored = other.create(pending);",
  );
  const wrongEnumRegionDiagnostic = diagnostics(
    wrongEnumRegion,
    "arena-stored-enum-wrong-region.zs",
  )[0];
  assert.equal(wrongEnumRegionDiagnostic.code, "Z0206");
  assert.match(wrongEnumRegionDiagnostic.message, /only in the Arena that owns every embedded view/);

  const copiedEnum = storedEnumProvenance.replace(
    "const pending = Node({ span: pendingSpan });",
    "const copied = pendingSpan;\n      const pending = Node({ span: pendingSpan });",
  );
  const copiedEnumDiagnostic = diagnostics(copiedEnum, "arena-stored-enum-copy.zs")[0];
  assert.equal(copiedEnumDiagnostic.code, "Z0206");
  assert.match(copiedEnumDiagnostic.message, /must be bound directly from its producing expression/);

  const mixedEnumOwners = storedEnumProvenance.replace(
    "const last = arena.create(Coordinate({ value: 22 }));",
    "let other = Arena();\n      const last = other.create(Coordinate({ value: 22 }));",
  );
  const mixedEnumOwnersDiagnostic = diagnostics(
    mixedEnumOwners,
    "arena-stored-enum-mixed-owners.zs",
  )[0];
  assert.equal(mixedEnumOwnersDiagnostic.code, "Z0206");
  assert.match(mixedEnumOwnersDiagnostic.message, /must borrow from exactly one owner/);

  const directViewEnum = `
    struct Coordinate { value: i32; }
    enum StoredCoordinate {
      primary view Coordinate,
      alternate view Coordinate,
    }
    function main(): i32 { return 0; }
  `;
  const directViewEnumDiagnostic = diagnostics(directViewEnum, "arena-stored-enum-direct-view.zs")[0];
  assert.equal(directViewEnumDiagnostic.code, "Z0206");
  assert.match(directViewEnumDiagnostic.message, /payload must be a named value struct/);

  const ownerlessEnumVariant = `
    import { Arena } from "std/memory";
    struct Coordinate { value: i32; }
    struct Span { first: view Coordinate; last: view Coordinate; }
    enum MaybeSpan { some Span, none, }
    enum Choice { present, absent, }
    struct Node { span: MaybeSpan; }
    function inspect(in value: MaybeSpan): i32 {
      return match (in value) {
        some(span) => {
          const first = span.first;
          const last = span.last;
          select first.value + last.value;
        }
        none => 0;
      };
    }
    function main(): i32 {
      let arena = Arena();
      let other = Arena();
      const absentPending = Node({ span: MaybeSpan.none });
      const absent = other.create(absentPending);
      const absentValue = absent.span;
      const first = arena.create(Coordinate({ value: 20 }));
      const last = arena.create(Coordinate({ value: 22 }));
      const presentPending = MaybeSpan.some(Span({ first, last }));
      const present = arena.create(presentPending);
      const joinedPending = if (first.value == 20) {
        select MaybeSpan.some(Span({ first, last }));
      } else {
        select MaybeSpan.none;
      };
      const joined = arena.create(joinedPending);
      const choice = Choice.present;
      const matchedPending = match (choice) {
        present => MaybeSpan.some(Span({ first, last }));
        absent => MaybeSpan.none;
      };
      const matched = arena.create(matchedPending);
      const result = inspect(in absentValue)
        + inspect(in present)
        + inspect(in joined)
        + inspect(in matched);
      other.reset();
      arena.reset();
      return result - 126;
    }
  `;
  const ownerlessEnumDirectory = mkdtempSync("/tmp/z-arena-stored-enum-ownerless-");
  const ownerlessEnumFile = resolve(ownerlessEnumDirectory, "main.zs");
  writeFileSync(ownerlessEnumFile, ownerlessEnumVariant);
  const ownerlessEnumResult = spawnSync(
    process.execPath,
    [cli, "run", ownerlessEnumFile],
    { encoding: "utf8" },
  );
  assert.equal(ownerlessEnumResult.status, 0, ownerlessEnumResult.stderr);

  const recursiveOptionView = `
    import { Arena } from "std/memory";
    struct Node { value: i32; next: Option<view Node>; }
    function main(): i32 {
      let arena = Arena();
      const tail = arena.create(Node({
        value: 22,
        next: Option<view Node>.none,
      }));
      const head = arena.create(Node({
        value: 20,
        next: Option<view Node>.some(tail),
      }));
      const next = head.next;
      const answer = match (in next) {
        some(node) => node.value;
        none => 0;
      };
      arena.reset();
      return answer - 22;
    }
  `;
  const recursiveOptionDirectory = mkdtempSync("/tmp/z-arena-recursive-option-view-");
  const recursiveOptionFile = resolve(recursiveOptionDirectory, "main.zs");
  writeFileSync(recursiveOptionFile, recursiveOptionView);
  const recursiveOptionGenerated = compileToC(
    recursiveOptionView,
    recursiveOptionFile,
  );
  assert.match(
    recursiveOptionGenerated,
    /typedef const Z_Node \*Z_Option___z_view_3a_Node;/,
  );
  assert.doesNotMatch(recursiveOptionGenerated, /Z_Option_view_Node_Tag/);
  const recursiveOptionResult = spawnSync(
    process.execPath,
    [cli, "run", recursiveOptionFile],
    { encoding: "utf8" },
  );
  assert.equal(recursiveOptionResult.status, 0, recursiveOptionResult.stderr);

  const wrongRecursiveArena = recursiveOptionView.replace(
    "const head = arena.create(Node({",
    "let other = Arena();\n      const head = other.create(Node({",
  );
  const wrongRecursiveDiagnostic = diagnostics(
    wrongRecursiveArena,
    "arena-recursive-option-wrong-region.zs",
  )[0];
  assert.equal(wrongRecursiveDiagnostic.code, "Z0206");
  assert.match(
    wrongRecursiveDiagnostic.message,
    /only in the Arena that owns every embedded view/,
  );

  const unprovenRecursiveView = `
    struct Node { value: i32; next: Option<view Node>; }
    function main(): i32 {
      const local = Node({
        value: 22,
        next: Option<view Node>.none,
      });
      const pending = Node({
        value: 20,
        next: Option<view Node>.some(local),
      });
      return pending.value;
    }
  `;
  const unprovenRecursiveDiagnostic = diagnostics(
    unprovenRecursiveView,
    "arena-recursive-option-unproven.zs",
  )[0];
  assert.equal(unprovenRecursiveDiagnostic.code, "Z0206");
  assert.match(
    unprovenRecursiveDiagnostic.message,
    /view can enter Option only from proven borrowed storage/,
  );

  const copiedOwnerlessVariant = ownerlessEnumVariant.replace(
    "const absent = other.create(absentPending);",
    "const copiedAbsent = absentPending;\n      const absent = other.create(absentPending);",
  );
  const copiedOwnerlessDiagnostic = diagnostics(
    copiedOwnerlessVariant,
    "arena-stored-enum-ownerless-copy.zs",
  )[0];
  assert.equal(copiedOwnerlessDiagnostic.code, "Z0206");
  assert.match(copiedOwnerlessDiagnostic.message, /must be bound directly from its producing expression/);

  const mixedOwnerJoin = `
    import { Arena } from "std/memory";
    struct Coordinate { value: i32; }
    struct Span { first: view Coordinate; last: view Coordinate; }
    enum MaybeSpan { some Span, none, }
    function main(): i32 {
      let firstArena = Arena();
      let secondArena = Arena();
      const firstA = firstArena.create(Coordinate({ value: 20 }));
      const lastA = firstArena.create(Coordinate({ value: 22 }));
      const firstB = secondArena.create(Coordinate({ value: 20 }));
      const lastB = secondArena.create(Coordinate({ value: 22 }));
      const mixed = if (true) {
        select MaybeSpan.some(Span({ first: firstA, last: lastA }));
      } else {
        select MaybeSpan.some(Span({ first: firstB, last: lastB }));
      };
      const stored = firstArena.create(mixed);
      return 0;
    }
  `;
  const mixedOwnerJoinDiagnostic = diagnostics(
    mixedOwnerJoin,
    "arena-stored-enum-mixed-join.zs",
  )[0];
  assert.equal(mixedOwnerJoinDiagnostic.code, "Z0206");
  assert.match(mixedOwnerJoinDiagnostic.message, /cannot join values from different Arena owners/);

  const consumingEnumMatch = storedEnumProvenance.replace(
    "return match (in span) {",
    "return match (span) {",
  );
  const consumingEnumMatchDiagnostic = diagnostics(
    consumingEnumMatch,
    "arena-stored-enum-consuming-match.zs",
  )[0];
  assert.equal(consumingEnumMatchDiagnostic.code, "Z0206");
  assert.match(consumingEnumMatchDiagnostic.message, /must be matched from proven storage with `match \(in value\)`/);

  const destructuredEnumPayload = storedEnumProvenance.replace(
    "primary(value) => total(in value);",
    "primary({ first, last }) => first.value + last.value;",
  );
  const destructuredEnumPayloadDiagnostic = diagnostics(
    destructuredEnumPayload,
    "arena-stored-enum-destructure.zs",
  )[0];
  assert.equal(destructuredEnumPayloadDiagnostic.code, "Z0206");
  assert.match(destructuredEnumPayloadDiagnostic.message, /requires one direct binding/);

  const wrongRegion = storedProvenance.replace(
    "const stored = arena.create(pending);",
    "let other = Arena();\n      const stored = other.create(pending);",
  );
  const wrongRegionDiagnostic = diagnostics(wrongRegion, "arena-stored-wrong-region.zs")[0];
  assert.equal(wrongRegionDiagnostic.code, "Z0206");
  assert.match(wrongRegionDiagnostic.message, /only in the Arena that owns every embedded view/);

  const copiedComposite = storedProvenance.replace(
    "const stored = arena.create(pending);",
    "const copied = pending;\n      const stored = arena.create(pending);",
  );
  const copiedCompositeDiagnostic = diagnostics(copiedComposite, "arena-stored-copy.zs")[0];
  assert.equal(copiedCompositeDiagnostic.code, "Z0206");
  assert.match(copiedCompositeDiagnostic.message, /must be bound directly from its producing expression/);

  const storedArrayProvenance = `
    import { Arena } from "std/memory";
    struct Coordinate { value: i32; }
    struct Span { first: view Coordinate; last: view Coordinate; }
    function main(): i32 {
      let arena = Arena();
      const first = arena.create(Coordinate({ value: 20 }));
      const last = arena.create(Coordinate({ value: 22 }));
      const pending = Span({ first, last });
      const pendingSpans = Array<Span>(pending);
      const spans = arena.create(pendingSpans);
      if (spans.length != 1) return 1;
      return 0;
    }
  `;
  const storedArrayDirectory = mkdtempSync("/tmp/z-arena-stored-array-");
  const storedArrayFile = resolve(storedArrayDirectory, "main.zs");
  writeFileSync(storedArrayFile, storedArrayProvenance);
  const storedArrayResult = spawnSync(process.execPath, [cli, "run", storedArrayFile], { encoding: "utf8" });
  assert.equal(storedArrayResult.status, 0, storedArrayResult.stderr);

  const mixedArrayOwners = storedArrayProvenance
    .replace("const last = arena.create", "let other = Arena();\n      const last = other.create");
  const mixedArrayDiagnostic = diagnostics(mixedArrayOwners, "arena-stored-array-mixed.zs")[0];
  assert.equal(mixedArrayDiagnostic.code, "Z0206");
  assert.match(mixedArrayDiagnostic.message, /must borrow from exactly one owner/);

  const wrongArrayRegion = storedArrayProvenance.replace(
    "const spans = arena.create(pendingSpans);",
    "let other = Arena();\n      const spans = other.create(pendingSpans);",
  );
  const wrongArrayRegionDiagnostic = diagnostics(wrongArrayRegion, "arena-stored-array-wrong-region.zs")[0];
  assert.equal(wrongArrayRegionDiagnostic.code, "Z0206");
  assert.match(wrongArrayRegionDiagnostic.message, /only in the Arena that owns every embedded view/);

  const emptyStoredArray = storedArrayProvenance.replace(
    "const pendingSpans = Array<Span>(pending);",
    "const pendingSpans = Array<Span>();",
  );
  const emptyStoredArrayDiagnostic = diagnostics(emptyStoredArray, "arena-stored-array-empty.zs")[0];
  assert.equal(emptyStoredArrayDiagnostic.code, "Z0206");
  assert.match(emptyStoredArrayDiagnostic.message, /empty view-bearing Array must use let/);

  const reusedStoredArrayElement = storedArrayProvenance.replace(
    "const spans = arena.create(pendingSpans);",
    "const observed = pending.first.value;\n      const spans = arena.create(pendingSpans);",
  );
  const reusedStoredArrayElementDiagnostic = diagnostics(reusedStoredArrayElement, "arena-stored-array-reuse.zs")[0];
  assert.equal(reusedStoredArrayElementDiagnostic.code, "Z0201");
  assert.match(reusedStoredArrayElementDiagnostic.message, /moved value "pending"/);

  const pushedStoredArray = storedArrayProvenance.replace(
    "const pendingSpans = Array<Span>(pending);",
    "let pendingSpans = Array<Span>();\n      pendingSpans.push(pending);",
  );
  const pushedStoredArrayDirectory = mkdtempSync("/tmp/z-arena-stored-array-push-");
  const pushedStoredArrayFile = resolve(pushedStoredArrayDirectory, "main.zs");
  writeFileSync(pushedStoredArrayFile, pushedStoredArray);
  const pushedStoredArrayResult = spawnSync(
    process.execPath,
    [cli, "run", pushedStoredArrayFile],
    { encoding: "utf8" },
  );
  assert.equal(pushedStoredArrayResult.status, 0, pushedStoredArrayResult.stderr);

  const branchEstablishedArray = pushedStoredArray.replace(
    "pendingSpans.push(pending);",
    "if (first.value == 20) {\n"
      + "        pendingSpans.push(pending);\n"
      + "      } else {\n"
      + "        pendingSpans.push(pending);\n"
      + "      }",
  );
  const branchEstablishedDirectory = mkdtempSync("/tmp/z-arena-stored-array-branch-");
  const branchEstablishedFile = resolve(branchEstablishedDirectory, "main.zs");
  writeFileSync(branchEstablishedFile, branchEstablishedArray);
  const branchEstablishedResult = spawnSync(
    process.execPath,
    [cli, "run", branchEstablishedFile],
    { encoding: "utf8" },
  );
  assert.equal(branchEstablishedResult.status, 0, branchEstablishedResult.stderr);

  const matchEstablishedArray = pushedStoredArray
    .replace(
      "struct Span { first: view Coordinate; last: view Coordinate; }",
      "struct Span { first: view Coordinate; last: view Coordinate; }\n"
        + "    enum Choice { primary, alternate, }",
    )
    .replace(
      "pendingSpans.push(pending);",
      "const choice = Choice.primary;\n"
        + "      match (choice) {\n"
        + "        primary => pendingSpans.push(pending);\n"
        + "        alternate => pendingSpans.push(pending);\n"
        + "      }",
    );
  const matchEstablishedDirectory = mkdtempSync("/tmp/z-arena-stored-array-match-");
  const matchEstablishedFile = resolve(matchEstablishedDirectory, "main.zs");
  writeFileSync(matchEstablishedFile, matchEstablishedArray);
  const matchEstablishedResult = spawnSync(
    process.execPath,
    [cli, "run", matchEstablishedFile],
    { encoding: "utf8" },
  );
  assert.equal(matchEstablishedResult.status, 0, matchEstablishedResult.stderr);

  const expressionEstablishedArray = pushedStoredArray.replace(
    "pendingSpans.push(pending);",
    "const selected = if (first.value == 20) {\n"
      + "        pendingSpans.push(pending);\n"
      + "        select 20;\n"
      + "      } else {\n"
      + "        pendingSpans.push(pending);\n"
      + "        select 22;\n"
      + "      };\n"
      + "      if (selected != 20) return 2;",
  );
  const expressionEstablishedDirectory = mkdtempSync("/tmp/z-arena-stored-array-expression-");
  const expressionEstablishedFile = resolve(expressionEstablishedDirectory, "main.zs");
  writeFileSync(expressionEstablishedFile, expressionEstablishedArray);
  const expressionEstablishedResult = spawnSync(
    process.execPath,
    [cli, "run", expressionEstablishedFile],
    { encoding: "utf8" },
  );
  assert.equal(expressionEstablishedResult.status, 0, expressionEstablishedResult.stderr);

  const pushedFromAnotherArena = pushedStoredArray.replace(
    "const spans = arena.create(pendingSpans);",
    "let other = Arena();\n"
      + "      const otherFirst = other.create(Coordinate({ value: 1 }));\n"
      + "      const otherLast = other.create(Coordinate({ value: 2 }));\n"
      + "      pendingSpans.push(Span({ first: otherFirst, last: otherLast }));\n"
      + "      const spans = arena.create(pendingSpans);",
  );
  const pushedFromAnotherArenaDiagnostic = diagnostics(
    pushedFromAnotherArena,
    "arena-stored-array-push-other-owner.zs",
  )[0];
  assert.equal(pushedFromAnotherArenaDiagnostic.code, "Z0206");
  assert.match(pushedFromAnotherArenaDiagnostic.message, /already carries provenance from another Arena/);

  const conditionalFirstPush = pushedStoredArray.replace(
    "pendingSpans.push(pending);",
    "if (true) pendingSpans.push(pending);",
  );
  const conditionalFirstPushDiagnostic = diagnostics(
    conditionalFirstPush,
    "arena-stored-array-conditional-first-push.zs",
  )[0];
  assert.equal(conditionalFirstPushDiagnostic.code, "Z0206");
  assert.match(conditionalFirstPushDiagnostic.message, /same Arena provenance on every continuing path/);

  const mixedBranchOwners = pushedStoredArray.replace(
    "pendingSpans.push(pending);",
    "let other = Arena();\n"
      + "      const otherFirst = other.create(Coordinate({ value: 1 }));\n"
      + "      const otherLast = other.create(Coordinate({ value: 2 }));\n"
      + "      if (true) {\n"
      + "        pendingSpans.push(pending);\n"
      + "      } else {\n"
      + "        pendingSpans.push(Span({ first: otherFirst, last: otherLast }));\n"
      + "      }",
  );
  const mixedBranchOwnersDiagnostic = diagnostics(
    mixedBranchOwners,
    "arena-stored-array-mixed-branch-owners.zs",
  )[0];
  assert.equal(mixedBranchOwnersDiagnostic.code, "Z0206");
  assert.match(mixedBranchOwnersDiagnostic.message, /same Arena provenance on every continuing path/);

  const loopFirstPush = pushedStoredArray.replace(
    "pendingSpans.push(pending);",
    "while (pendingSpans.length == 0) {\n"
      + "        pendingSpans.push(pending);\n"
      + "      }",
  );
  const loopFirstPushDiagnostic = diagnostics(
    loopFirstPush,
    "arena-stored-array-loop-first-push.zs",
  )[0];
  assert.equal(loopFirstPushDiagnostic.code, "Z0206");
  assert.match(loopFirstPushDiagnostic.message, /first push.*cannot occur in a loop/);

  const reusedPushedElement = pushedStoredArray.replace(
    "const spans = arena.create(pendingSpans);",
    "const observed = pending.first.value;\n      const spans = arena.create(pendingSpans);",
  );
  const reusedPushedElementDiagnostic = diagnostics(
    reusedPushedElement,
    "arena-stored-array-push-reuse.zs",
  )[0];
  assert.equal(reusedPushedElementDiagnostic.code, "Z0201");
  assert.match(reusedPushedElementDiagnostic.message, /moved value "pending"/);

  const conditionalLaterPush = pushedStoredArray
    .replace(
      "const spans = arena.create(pendingSpans);",
      "const second = Span({ first, last });\n"
        + "      if (true) pendingSpans.push(second);\n"
        + "      const spans = arena.create(pendingSpans);",
    )
    .replace("spans.length != 1", "spans.length != 2");
  const conditionalLaterPushDirectory = mkdtempSync("/tmp/z-arena-stored-array-conditional-later-");
  const conditionalLaterPushFile = resolve(conditionalLaterPushDirectory, "main.zs");
  writeFileSync(conditionalLaterPushFile, conditionalLaterPush);
  const conditionalLaterPushResult = spawnSync(
    process.execPath,
    [cli, "run", conditionalLaterPushFile],
    { encoding: "utf8" },
  );
  assert.equal(conditionalLaterPushResult.status, 0, conditionalLaterPushResult.stderr);

  const pushWhileElementViewLives = pushedStoredArray.replace(
    "const spans = arena.create(pendingSpans);",
    "const selected = view pendingSpans[0];\n"
      + "      pendingSpans.push(Span({ first, last }));\n"
      + "      const spans = arena.create(pendingSpans);\n"
      + "      if (selected.first.value == 0) return 2;",
  );
  const pushWhileElementViewLivesDiagnostic = diagnostics(
    pushWhileElementViewLives,
    "arena-stored-array-live-element-view.zs",
  )[0];
  assert.equal(pushWhileElementViewLivesDiagnostic.code, "Z0205");
  assert.match(pushWhileElementViewLivesDiagnostic.message, /cannot mutate "pendingSpans" while view "selected" is live/);

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
  assert.match(generated, /Z_Option___z_view_3a_Item Z_Store_find\(const Z_Store \*self, int32_t z_id\)/);
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

  const storedViewInClass = `
    struct Item { value: i32; }
    class Invalid { found: Option<view Item>; }
    function main(): i32 { return 0; }
  `;
  const storageDiagnostic = diagnostics(
    storedViewInClass,
    "optional-view-class-storage.zs",
  )[0];
  assert.equal(storageDiagnostic.code, "Z0206");
  assert.match(storageDiagnostic.message, /ARC class fields cannot store owner-tied views/);

  const bindingOffset = source.indexOf("found =") + 1;
  assert.match(hover(source, "optional-view.zs", bindingOffset)?.contents.value ?? "", /found: Option<view Item>.*view of store/);
  const payloadOffset = source.indexOf("some(item)") + "some(".length + 1;
  assert.match(hover(source, "optional-view.zs", payloadOffset)?.contents.value ?? "", /item: view Item/);
});

hostToolchainTest("retains owned Z closure environments across Objective-C blocks", () => {
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
}, 30_000);

hostToolchainTest("declares native block adapters before nested callable bodies in both compilers", () => {
  if (process.platform !== "darwin") return;
  const fixtures = resolve(projectRoot, "tests/fixtures");
  const fixture = resolve(fixtures, "objc-nested-blocks.zs");
  const source = readFileSync(fixture, "utf8");
  const directory = mkdtempSync("/tmp/z-nested-objc-blocks-");
  try {
    const stage0 = compileToNative(source, fixture).source;
    const emitter = resolve(directory, "emitter");
    const emission = spawnSync(process.execPath, [cli, "self-host-emit",
      resolve(fixtures, "self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const build = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", emitter], {
      encoding: "utf8", input: emission.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(build.status, 0, build.stderr);
    const wire = resolve(directory, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-blocks.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [fixtures]).get("native")!);
    const contract = resolve(directory, "native.zd");
    writeFileSync(contract, 'declare module "./objc-blocks.h" {}');
    const native = spawnSync(emitter, [wire, fixture, "", contract], {
      encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [label, text] of [["stage0", stage0], ["native", native.stdout]]) {
      const file = resolve(directory, `${label}.m`);
      writeFileSync(file, text);
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, "probe");
        const compiled = spawnSync("clang", ["-fobjc-arc", "-fblocks", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures, "-framework", "Foundation", file, "-o", executable], {
          encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compiled.status, 0, `${label} ${optimization}: ${compiled.stderr}`);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(run.status, 0, `${label} ${optimization}: ${run.stderr}`);
        assert.equal(run.stderr, "");
        assert.equal(run.stdout, "outer=42\nnested=42\nreleased=42\n");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("round-trips nullable Objective-C block values and protocol callbacks", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-block-native.zs");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);
  assert.match(artifact.source, /@interface Z_ObjCClosureBox : NSObject/);
  assert.match(artifact.source, /ZObjCProtocolAdapter_NativeBlockHandler/);
  assert.match(artifact.source, /z_objc_received_block_NativeBlockHandler_requestValue_1/);
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}, 30_000);

hostToolchainTest("drains explicit lexical Objective-C autorelease pools", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/autorelease-pool.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);

  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /static Z_Result_String_PoolError z_objc_autorelease_pool_[0-9]+/);
  assert.match(artifact.source, /@autoreleasepool \{\n    return callback\.call\(callback\.context\);\n  \}/);
  assert.doesNotMatch(artifact.source, /NSAutoreleasePool/);

  const exampleResult = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(exampleResult.status, 0, exampleResult.stderr);

  const lifetimeFixture = resolve(projectRoot, "tests/fixtures/objc-autorelease-pool.zs");
  const lifetimeResult = spawnSync(process.execPath, [cli, "run", lifetimeFixture], { encoding: "utf8" });
  assert.equal(lifetimeResult.status, 0, lifetimeResult.stderr);

  const asyncFixture = resolve(projectRoot, "tests/fixtures/objc-autorelease-pool-async.zs");
  const asyncArtifact = compileToNative(readFileSync(asyncFixture, "utf8"), asyncFixture);
  assert.match(asyncArtifact.source, /z_objc_autorelease_pool_[0-9]+\(/);
  const asyncResult = spawnSync(process.execPath, [cli, "run", asyncFixture], { encoding: "utf8" });
  assert.equal(asyncResult.status, 0, asyncResult.stderr);

  const poolOffset = source.indexOf("objc.pool") + "objc.".length + 1;
  assert.match(hover(source, example, poolOffset)?.contents.value ?? "", /lexical Objective-C autorelease pool/);
  const incomplete = source.replace("objc.pool", "objc.po");
  const completionOffset = incomplete.indexOf("objc.po") + "objc.po".length;
  assert.ok(completions(incomplete, example, completionOffset).some((item) => item.label === "pool"));

  const unhandled = source.replace("return try objc.pool", "return objc.pool");
  assert.match(diagnostics(unhandled, example)[0]?.message ?? "", /throwing objc\.pool requires `attempt` or `try`/);
  const suspending = source.replace("(): String throws PoolError", "async (): String throws PoolError");
  assert.match(diagnostics(suspending, example)[0]?.message ?? "", /objc\.pool requires a synchronous closure/);

  const escapingView = `
    import objc from "std/objc";
    struct Value { id: i32; }
    function inspect(in value: Value): i32 {
      const escaped = objc.pool((): view Value => value);
      return escaped.id;
    }
  `;
  assert.match(diagnostics(escapingView, "objc-pool-view.zs")[0]?.message ?? "", /closures cannot return receiver-tied views|borrowed value cannot escape objc\.pool/);
}, 20_000);

hostToolchainTest("enters the captured Z runtime for arbitrary-thread Objective-C blocks", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-block-runtime-entry.zs");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);

  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /\[ZObjCBlockFixture invokeOnWorker:_z_objc_block_/);
  assert.match(artifact.source, /captureRuntime:true/);
  assert.match(artifact.source, /Z_ForeignThreadEntry _z_runtime_entry = z_foreign_thread_enter/);
  assert.match(artifact.source, /z_foreign_thread_leave\(_z_runtime_entry\)/);
  assert.match(artifact.source, /_z_runtime_retain\(_z_runtime_context\)/);
  assert.match(artifact.source, /_z_runtime_release\(_z_runtime_context\)/);

  const mainCallerLeak = source
    .replace(
      "function observeNativeCallback(updates: TaskScope): void {",
      "function observeNativeCallback(updates: TaskScope): void on thread.main {",
    )
    .replace("current.record(value);", "current.published = value;");
  const mainCallerDiagnostic = diagnostics(mainCallerLeak, fixture).find((item) => item.code === "Z0711");
  assert.match(mainCallerDiagnostic?.message ?? "", /field .*Application.*published.*requires thread\.main/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
}, 15_000);

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

hostToolchainTest("owns an AppKit target/action router in a linked application root", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(
    projectRoot,
    "examples/applications/zapp-appkit/main.zs",
  );
  const source = readFileSync(example, "utf8");
  const callbackStart = source.indexOf("const actionConnection");
  const callbackEnd = source.indexOf("return new Application", callbackStart);
  const callbackSource = source.slice(callbackStart, callbackEnd);
  assert.match(callbackSource, /current\.recordAction\(ticket\)/);
  assert.doesNotMatch(callbackSource, /current\.finishWork\(ticket\)/);
  const artifact = compileToNative(source, example);

  assert.equal(artifact.language, "objective-c");
  assert.match(artifact.source, /ZObjCConnection \* actionConnection;/);
  assert.match(artifact.source, /self->actionConnection = _z_init_actionConnection;/);
  assert.match(artifact.source, /self->actionConnection = nil;/);
  assert.match(artifact.source, /z_objc_connect\(/);
  assert.match(artifact.source, /Router_dispatch\([^,]+, &\(\(\*message\)\)\)/);
  assert.match(artifact.source, /Application_recordAction/);
  assert.match(artifact.source, /Application_routedAction/);
  assert.match(artifact.source, /Application_triggerAction/);

  const compilation = spawnSync("xcrun", [
    "clang", "-x", "objective-c", "-fobjc-arc", "-fblocks",
    "-mmacosx-version-min=14.0",
    "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 5 modules, 9 local edges/);

  const result = spawnSync(process.execPath, [cli, "run", example], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "published AppKit job 42 on main\n"
      + "routed AppKit action 42 on main\n"
      + "worker completed AppKit job 1\n"
      + "published AppKit job 1 on main\n"
      + "worker resumed after publishing AppKit job 1\n"
      + "closing AppKit window on main\n"
      + "Zapp completed AppKit job 1\n",
  );
}, 60_000);

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

  const unsafeBindingFile = resolve(projectRoot, "tests/fixtures/objc-unsafe-binding-test.zs");
  const unsafeBinding = `
    import native from "objc-unsafe-binding.h";
    import objc from "std/objc";
    class Controller implements native.ZUnsafeBindingDelegate {}
    function main(): i32 {
      const owner = native.ZUnsafeBindingOwner.alloc().init();
      const controller = new Controller({});
      const binding = objc.bind(owner, { delegate: controller });
      return 0;
    }
  `;
  const unsafeDiagnostic = diagnostics(unsafeBinding, unsafeBindingFile)[0];
  assert.equal(unsafeDiagnostic.code, "Z0810");
  assert.match(unsafeDiagnostic.message, /requires a zeroing weak protocol property/);
  assert.match(unsafeDiagnostic.message, /assign/);
}, 15_000);

test("constructs Objective-C adapters and registrations inside methods and native callbacks", () => {
  if (process.platform !== "darwin") return;
  const input = resolve(projectRoot, "tests/fixtures/objc-nested-registration.zs");
  const artifact = compileToNative(readFileSync(input, "utf8"), input);
  const compilation = spawnSync("clang", [
    "-x", "objective-c", "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "tests/fixtures"), "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8", timeout: 20_000 });
  assert.equal(compilation.status, 0, compilation.stderr);
  const result = spawnSync(process.execPath, [cli, "run", input], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout,
    "registered parent\nregistered child\nreceived 42\nunregistered child\nunregistered parent\n");
}, 60_000);

test("owns standalone Objective-C protocol adapters as storable ARC values", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "examples/interop/objc/protocol-adapter.zs");
  const source = `
    import WebKit from "WebKit/WebKit.h";
    import objc from "std/objc";
    import { thread } from "std/thread";

    class SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {
      function start(
        in webView: WebKit.WKWebView,
        in task: WebKit.WKURLSchemeTask
      ): void as "webView:startURLSchemeTask:" {
        WebKit.NSArray.arrayWithObject(task);
        task.didFinish();
      }

      function stop(
        in webView: WebKit.WKWebView,
        in task: WebKit.WKURLSchemeTask
      ): void as "webView:stopURLSchemeTask:" {}
    }

    class AdapterOwner on thread.main {
      readonly id: i32;
      readonly adapter: objc.Adapter<WebKit.WKURLSchemeHandler>;
    }

    function main(): i32 {
      const controller = new SchemeHandler({});
      const adapter = objc.adapt<WebKit.WKURLSchemeHandler>(controller);
      const owner = new AdapterOwner({ id: 1, adapter });
      const configuration = WebKit.WKWebViewConfiguration.alloc().init();
      configuration.setURLSchemeHandler(owner.adapter, forURLScheme: "zapp");
      return 0;
    }
  `;
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /__strong id<WKURLSchemeHandler> adapter;/);
  assert.match(artifact.source, /\[\[ZObjCProtocolAdapter_SchemeHandler alloc\] initWithOwner:controller\]/);
  assert.match(artifact.source, /\[configuration setURLSchemeHandler:.*adapter.* forURLScheme:@"zapp"\]/);
  assert.match(artifact.source, /\[NSArray arrayWithObject:\s*task\]/);
  assert.match(artifact.source, /int32_t _z_init_id, id<WKURLSchemeHandler> _z_init_adapter/);
  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const adaptOffset = source.indexOf("objc.adapt") + "objc.".length + 2;
  assert.match(hover(source, fileName, adaptOffset)?.contents.value ?? "", /owned, storable Objective-C protocol adapter/);
  const incomplete = source.replace("objc.adapt", "objc.ada");
  const completionOffset = incomplete.indexOf("objc.ada") + "objc.ada".length;
  assert.equal(
    completions(incomplete, fileName, completionOffset).find((item) => item.label === "adapt")?.detail,
    "adapt<P>(controller: ZClass implements P): objc.Adapter<P>",
  );

  const moduleDirectory = mkdtempSync("/tmp/z-objc-adapter-module-");
  const ownerFile = resolve(moduleDirectory, "owner.zs");
  const entryFile = resolve(moduleDirectory, "main.zs");
  writeFileSync(ownerFile, `
    import WebKit from "WebKit/WebKit.h";
    import objc from "std/objc";
    import { thread } from "std/thread";

    export class ImportedAdapterOwner on thread.main
      implements WebKit.WKURLSchemeHandler {
      readonly adapter: objc.Adapter<WebKit.WKURLSchemeHandler>;

      function start(
        in webView: WebKit.WKWebView,
        in task: WebKit.WKURLSchemeTask
      ): void as "webView:startURLSchemeTask:" {
        const request = task.request;
      }

      function stop(
        in webView: WebKit.WKWebView,
        in task: WebKit.WKURLSchemeTask
      ): void as "webView:stopURLSchemeTask:" {}
    }

    export class ImportedMessageHandler on thread.main
      implements WebKit.WKScriptMessageHandler {
      function receive(
        in controller: WebKit.WKUserContentController,
        in message: WebKit.WKScriptMessage
      ): void as "userContentController:didReceiveScriptMessage:" {}
    }
  `);
  const entrySource = `
    import EntryWebKit from "WebKit/WebKit.h";
    import Foundation from "Foundation/Foundation.h";
    import { ImportedMessageHandler } from "./owner.zs";
    import objc from "std/objc";
    import { thread } from "std/thread";
    function install(
      in controller: EntryWebKit.WKUserContentController,
      in handler: ImportedMessageHandler,
      in name: Foundation.NSString
    ): objc.Registration on thread.main {
      return objc.register({
        add: controller.addScriptMessageHandler(handler, name),
        remove: controller.removeScriptMessageHandlerForName(name),
      });
    }
  `;
  writeFileSync(entryFile, entrySource);
  const importedProtocolParity = spawnSync(
    process.execPath,
    [cli, "check", entryFile, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(importedProtocolParity.status, 0, importedProtocolParity.stderr);
  rmSync(moduleDirectory, { recursive: true, force: true });

  const crossHeaderSource = `
    import WebKit from "WebKit/WebKit.h";
    import Foundation from "Foundation/Foundation.h";
    import { thread } from "std/thread";

    class CrossHeaderNavigationDelegate on thread.main
      implements WebKit.WKNavigationDelegate {
      function fail(
        in webView: WebKit.WKWebView,
        in navigation: WebKit.WKNavigation | null,
        in error: Foundation.NSError
      ): void as "webView:didFailProvisionalNavigation:withError:" {}
    }

    function bridgeString(): Foundation.NSString {
      const message: Foundation.NSString = "hello";
      return message;
    }

    function bridgeError(
      in message: Foundation.NSString
    ): Foundation.NSError {
      const userInfo = Foundation.NSDictionary.dictionaryWithObject(
        message,
        forKey: Foundation.NSLocalizedDescriptionKey
      );
      return Foundation.NSError.errorWithDomain(
        "com.example.z",
        code: 1,
        userInfo: userInfo
      );
    }
  `;
  assert.deepEqual(diagnostics(crossHeaderSource, "/tmp/z-objc-cross-header-protocol.zs"), []);

  const wrongProtocol = source.replace(
    "objc.adapt<WebKit.WKURLSchemeHandler>(controller)",
    "objc.adapt<WebKit.WKNavigationDelegate>(controller)",
  );
  assert.match(diagnostics(wrongProtocol, fileName)[0]?.message ?? "", /does not implement Objective-C protocol WKNavigationDelegate/);
}, 60_000);

test("dispatches through borrowed Objective-C protocol existential callback values", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "examples/interop/objc/protocol-existential.zs");
  const source = `
    import WebKit from "WebKit/WebKit.h";
    import { thread } from "std/thread";

    class SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {
      function start(
        in webView: WebKit.WKWebView,
        in urlSchemeTask: WebKit.WKURLSchemeTask
      ): void as "webView:startURLSchemeTask:" {
        urlSchemeTask.didFinish();
      }

      function stop(
        in webView: WebKit.WKWebView,
        in urlSchemeTask: WebKit.WKURLSchemeTask
      ): void as "webView:stopURLSchemeTask:" {}
    }

    function main(): i32 { return 0; }
  `;
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /- \(void\)webView:\(WKWebView \*\)webView startURLSchemeTask:\(id\)urlSchemeTask/);
  assert.match(artifact.source, /\[urlSchemeTask didFinish\]/);

  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const completionSource = `
    import WebKit from "WebKit/WebKit.h";
    import { thread } from "std/thread";
    class SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {
      sta
    }
    function main(): i32 { return 0; }
  `;
  const completionOffset = completionSource.indexOf("sta") + "sta".length;
  const scaffold = completions(completionSource, fileName, completionOffset)
    .find((item) => item.label === "startURLSchemeTask");
  assert.match(scaffold?.insertText ?? "", /in urlSchemeTask: WebKit\.WKURLSchemeTask/);

  const existentialOffset = source.indexOf("WKURLSchemeTask") + 2;
  assert.match(hover(source, fileName, existentialOffset)?.contents.value ?? "", /WKURLSchemeTask/);
  const methodOffset = source.indexOf("didFinish") + 2;
  assert.match(hover(source, fileName, methodOffset)?.contents.value ?? "", /didFinish/);
  const memberCompletionSource = source.replace("urlSchemeTask.didFinish();", "urlSchemeTask.did");
  const memberCompletionOffset = memberCompletionSource.lastIndexOf("did") + "did".length;
  const memberItems = completions(memberCompletionSource, fileName, memberCompletionOffset);
  assert.ok(memberItems.some((item) => item.label === "didFinish"));
  assert.ok(memberItems.some((item) => item.label === "didReceiveData"));

  const stored = source.replace(
    "class SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {",
    "struct Stored { task: WebKit.WKURLSchemeTask; }\nclass SchemeHandler on thread.main implements WebKit.WKURLSchemeHandler {",
  );
  assert.match(diagnostics(stored, fileName)[0]?.message ?? "", /borrowed callback capabilities/);
}, 20_000);

test("invokes received Objective-C protocol blocks through borrowed Z callables", () => {
  if (process.platform !== "darwin") return;
  const fileName = resolve(projectRoot, "examples/interop/objc/navigation-policy.zs");
  const source = readFileSync(fileName, "utf8");
  const artifact = compileToNative(source, fileName);
  assert.match(artifact.source, /z_objc_received_block_NavigationHandler_decidePolicyForNavigationAction_3/);
  assert.match(artifact.source, /\(\(void \(\^\)\(WKNavigationActionPolicy\)\)\(\(__bridge ZObjCReceivedBlockBox \*\)context\)->_z_block\)/);
  assert.match(artifact.source, /Z_Function_[0-9a-f]+ _z_received_block_3 = \{ \.call = z_objc_received_block_.* \.retain = z_objc_received_block_/);
  assert.match(artifact.source, /Z_NavigationHandler_decidePolicyForNavigationAction\(_z_owner, webView, navigationAction, &_z_received_block_3\)/);

  const compilation = spawnSync("clang", [
    "-x", "objective-c",
    "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror",
    "-fsyntax-only", "-",
  ], { input: artifact.source, encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);

  const completionSource = `
    import WebKit from "WebKit/WebKit.h";
    import { thread } from "std/thread";
    class NavigationHandler on thread.main implements WebKit.WKNavigationDelegate {
      dec
    }
    function main(): i32 { return 0; }
  `;
  const completionOffset = completionSource.lastIndexOf("dec") + "dec".length;
  const scaffold = completions(completionSource, fileName, completionOffset)
    .find((item) => item.label === "decidePolicyForNavigationAction");
  assert.match(scaffold?.insertText ?? "", /in decisionHandler: \(argument1: WebKit\.WKNavigationActionPolicy\) => void/);

  const unborrowed = source.replace(
    "in decisionHandler: (policy: WebKit.WKNavigationActionPolicy) => void",
    "decisionHandler: (policy: WebKit.WKNavigationActionPolicy) => void",
  );
  assert.match(diagnostics(unborrowed, fileName)[0]?.message ?? "", /decisionHandler.*must use `in`/);

  const runtimeFixture = resolve(projectRoot, "tests/fixtures/objc-received-block.zs");
  const runtimeSource = readFileSync(runtimeFixture, "utf8");
  const runtimeArtifact = compileToNative(runtimeSource, runtimeFixture);
  assert.match(runtimeArtifact.source, /z_objc_received_block_ReceivedBlockHandler_complete_2/);
  const result = spawnSync(process.execPath, [cli, "run", runtimeFixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}, 20_000);

test("owns method-based Objective-C protocol registrations through explicit guards", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-registration.zs");
  const source = readFileSync(fixture, "utf8");
  const analysis = analyzeSource(source, fixture);
  const owner = analysis.foreignModules
    .get("native")
    ?.interfaces.get("ZRegistrationOwner");
  const add = owner?.methods.find((method) => method.selector === "addHandler:name:");
  assert.deepEqual(add?.parameters[0]?.protocols, ["ZRegistrationHandler"]);

  const artifact = compileToNative(source, fixture);
  assert.match(artifact.source, /@interface ZObjCRegistration : NSObject/);
  assert.match(artifact.source, /@interface ZObjCRegistration_\d+ : ZObjCRegistration/);
  assert.match(artifact.source, /ZObjCProtocolAdapter_RegistrationHandler \*_z_adapter/);
  assert.match(artifact.source, /\[_z_object addHandler:_z_adapter name:_z_argument_1\]/);
  assert.match(artifact.source, /- \(void\)dealloc \{\n  \(void\)\[_z_object removeHandlerForName:_z_stored_1\]/);
  assert.match(artifact.source, /objc_precise_lifetime, unused\)\) ZObjCRegistration \* const registration/);
  assert.match(artifact.source, /struct Z_RegistrationRoot \{[^}]*__strong ZRegistrationOwner \* owner;[^}]*__strong ZObjCRegistration \* registration;/);
  assert.match(artifact.source, /self->registration = nil;/);
  assert.match(artifact.source, /Z_RegistrationRoot_publish\(root\)/);
  assert.doesNotMatch(artifact.source, /publish\(&\(owner\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "registered bridge\nreceived 42\nunregistered bridge\n");

  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", fixture, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 1 modules, 0 local edges/);

  const discarded = source.replace("const registration = objc.register", "objc.register");
  const discardedDiagnostic = diagnostics(discarded, fixture)[0];
  assert.equal(discardedDiagnostic.code, "Z0812");
  assert.match(discardedDiagnostic.message, /must be bound/);

  const missingConformance = source
    .replace(
      "class RegistrationHandler implements native.ZRegistrationHandler",
      "class RegistrationHandler",
    )
    .replace(' as "registrationOwner:didReceiveValue:"', "");
  const conformanceDiagnostic = diagnostics(missingConformance, fixture)[0];
  assert.equal(conformanceDiagnostic.code, "Z0812");
  assert.match(conformanceDiagnostic.message, /requires a Z class implementing ZRegistrationHandler/);

  const mismatchedTeardown = source.replace(
    'remove: owner.removeHandlerForName("bridge")',
    'remove: owner.removeHandlerForName("other")',
  );
  const teardownDiagnostic = diagnostics(mismatchedTeardown, fixture)[0];
  assert.equal(teardownDiagnostic.code, "Z0812");
  assert.match(teardownDiagnostic.message, /relate this remove argument/);

  const differentReceiver = source
    .replace(
      "  const handler = new RegistrationHandler({});",
      "  const otherOwner = native.ZRegistrationOwner.alloc().init();\n  const handler = new RegistrationHandler({});",
    )
    .replace(
      'remove: owner.removeHandlerForName("bridge")',
      'remove: otherOwner.removeHandlerForName("bridge")',
    );
  const receiverDiagnostic = diagnostics(differentReceiver, fixture)[0];
  assert.equal(receiverDiagnostic.code, "Z0812");
  assert.match(receiverDiagnostic.message, /same stored Objective-C receiver/);

  const untypedAdd = source.replace(
    'add: owner.addHandler(handler, "bridge")',
    'add: owner.removeHandlerForName("bridge")',
  );
  const untypedDiagnostic = diagnostics(untypedAdd, fixture)[0];
  assert.equal(untypedDiagnostic.code, "Z0812");
  assert.match(untypedDiagnostic.message, /exactly one `id<Protocol>` parameter/);

  const registerOffset = source.indexOf("objc.register") + "objc.".length + 2;
  assert.match(
    hover(source, fixture, registerOffset)?.contents.value ?? "",
    /installs now and unregisters exactly once/,
  );
  const incomplete = source.replace("objc.register", "objc.reg");
  const incompleteOffset = incomplete.indexOf("objc.reg") + "objc.reg".length;
  assert.equal(
    completions(incomplete, fixture, incompleteOffset)
      .find((item) => item.label === "register")?.detail,
    "register({ add: protocol registration call, remove: teardown call }): objc.Registration",
  );
  const registrationTypeOffset = source.indexOf("objc.Registration") + "objc.".length + 2;
  assert.match(
    hover(source, fixture, registrationTypeOffset)?.contents.value ?? "",
    /owned add\/remove Objective-C protocol registration lifetime/,
  );
}, 120_000);

test("stages Z String notification names once and retains caller block executor context", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-notification-main-callback.zs");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);
  assert.match(artifact.source, /_z_argument_[0-9]+ = notificationName;/);
  assert.match(artifact.source, /addObserverForName:z_nsstring_from_string\(_z_argument_[0-9]+\)/);
  const syntax = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks",
    "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], { input: artifact.source, encoding: "utf8", timeout: 30_000 });
  assert.equal(syntax.status, 0, syntax.stderr);
  const run = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const directory = mkdtempSync("/tmp/z-notification-native-");
  try {
    const oracleSource = resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-execution.zs");
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", oracleSource], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr);
    const oracle = resolve(directory, "native-emitter");
    const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: emitted.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(built.status, 0, built.stderr);
    const input = resolve(directory, "main.zs");
    const wire = resolve(directory, "native.zfdcl");
    const contract = resolve(directory, "native.zd");
    const emit = (source: string, header = "AppKit/AppKit.h", facts = `declare module "${header}" {}`) => {
      const stream = resolveForeignFunctionDeclarationStreams([{
        kind: "import", moduleName: "native", bindings: null, header,
        location: { fileName: fixture, offset: 0, line: 1, column: 1 },
      }], fixture, [resolve(projectRoot, "tests/fixtures")]).get("native")!;
      writeFileSync(wire, stream);
      writeFileSync(input, source);
      writeFileSync(contract, facts);
      return spawnSync(oracle, [wire, input, "", contract], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      });
    };
    const native = emit(source);
    assert.equal(native.status, 0, native.stderr);
    assert.match(native.stdout, /\[timer invalidate\]/);
    assert.doesNotMatch(native.stdout, /timer\.invalidate\(\)/);
    const typedTimer = source.replace("block: move (timer):", "block: move (timer: native.NSTimer):");
    const typed = emit(typedTimer);
    assert.equal(typed.status, 0, typed.stderr);
    const wrongTimer = source.replace("block: move (timer):", "block: move (timer: native.NSNotification):");
    assert.match(diagnostics(wrongTimer, fixture).map((item) => item.message).join("\n"), /NSTimer.*NSNotification/);
    const rejectedTimer = emit(wrongTimer);
    assert.equal(rejectedTimer.status, 1, rejectedTimer.stderr);
    assert.match(rejectedTimer.stderr, /NSTimer.*NSNotification/);
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `notification${optimization}`);
      const compiled = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks",
        "-Wall", "-Wextra", "-Werror", optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
        "-framework", "AppKit", "-mmacosx-version-min=14.0", "-", "-o", executable], {
        input: native.stdout, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(compiled.status, 0, compiled.stderr);
      const executed = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
      assert.equal(executed.status, 0, executed.stderr);
    }
    const nested = source.replace("if (observed.read() == 1) state.observe();",
      "const nested = move (): void => { state.observe(); }; nested();");
    assert.match(diagnostics(nested, fixture).map((item) => item.message).join("\n"), /thread.main/);
    const rejectedNested = emit(nested);
    assert.equal(rejectedNested.status, 1, rejectedNested.stderr);
    assert.match(rejectedNested.stderr, /thread.main/);
    const worker = source.replace("if (observed.read() == 1) state.observe();",
      "const nested: () => void on thread.any = move (): void => { state.observe(); }; nested();");
    assert.match(diagnostics(worker, fixture).map((item) => item.message).join("\n"), /thread.main|thread.any|thread-any/);
    const rejectedWorker = emit(worker);
    assert.equal(rejectedWorker.status, 1, rejectedWorker.stderr);
    assert.match(rejectedWorker.stderr, /thread.main|thread.any|thread-any|not shareable across arbitrary threads/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

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
  assert.match(hover(source, fixture, tokenUse)?.contents.value ?? "", /token: objc\.Object/);
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
}, 10_000);

test("copies borrowed Z byte storage into ARC-managed NSData", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/data-copy.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /static NSData \*z_nsdata_copy_bytes\(Z_Slice_[A-Za-z0-9_]+ bytes\)/);
  assert.match(artifact.source, /\[\[NSData alloc\] initWithBytes:source length:\(NSUInteger\)bytes\.length\]/);
  assert.match(artifact.source, /NSData \* const data = z_nsdata_copy_bytes\(bytes\)/);
  assert.match(artifact.source, /copiedLength\(\(Z_Slice_[A-Za-z0-9_]+\)\{ \.data = \(bytes\)\.data, \.length = \(bytes\)\.length \}\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const copyOffset = source.indexOf("NSData.copy") + "NSData.".length + 1;
  const copyHover = hover(source, example, copyOffset)?.contents.value ?? "";
  assert.match(copyHover, /copy\(bytes: Slice<u8>\): Foundation\.NSData/);
  assert.match(copyHover, /Copies the borrowed byte range/);

  const incomplete = source.replace("NSData.copy", "NSData.co");
  const completionOffset = incomplete.indexOf("NSData.co") + "NSData.co".length;
  const completion = completions(incomplete, example, completionOffset)
    .find((item) => item.label === "copy");
  assert.match(completion?.detail ?? "", /copies borrowed bytes into ARC-managed NSData/);

  const wrongElement = `
    import Foundation from "Foundation/Foundation.h";
    function main(): i32 {
      const values = Array<i32>(1, 2);
      const data = Foundation.NSData.copy(values);
      return data.length == 2 ? 0 : 1;
    }
  `;
  assert.match(diagnostics(wrongElement, example)[0]?.message ?? "", /expects Slice<u8>-compatible storage/);

  const temporary = source.replace("Foundation.NSData.copy(bytes)", "Foundation.NSData.copy(Array<u8>(1, 2))");
  assert.match(diagnostics(temporary, example)[0]?.message ?? "", /requires stored byte-array storage/);
});

test("borrows embedded process-lifetime bytes into NSData without copying", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/embedded-data.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /static NSData \*z_nsdata_borrow_static_bytes\(Z_StaticBytes bytes\)/);
  assert.match(artifact.source, /initWithBytesNoCopy:source length:\(NSUInteger\)bytes\.length freeWhenDone:NO/);
  assert.match(artifact.source, /NSData \* const data = z_nsdata_borrow_static_bytes\(PAYLOAD\)/);
  assert.doesNotMatch(artifact.source, /z_nsdata_copy_bytes/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const borrowOffset = source.indexOf("NSData.borrow") + "NSData.".length + 1;
  const borrowHover = hover(source, example, borrowOffset)?.contents.value ?? "";
  assert.match(borrowHover, /borrow\(bytes: embed\.StaticBytes\): Foundation\.NSData/);
  assert.match(borrowHover, /zero-copy/);

  const incomplete = source.replace("NSData.borrow", "NSData.bo");
  const completionOffset = incomplete.indexOf("NSData.bo") + "NSData.bo".length;
  const completion = completions(incomplete, example, completionOffset)
    .find((item) => item.label === "borrow");
  assert.match(completion?.detail ?? "", /zero-copy process-lifetime NSData view/);

  const ordinaryArray = source.replace("PAYLOAD);", "Array<u8>(1, 2));");
  assert.match(diagnostics(ordinaryArray, example)[0]?.message ?? "", /expects embed\.StaticBytes/);
});

hostToolchainTest("bridges conditional String results without converting their boolean conditions", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "tests/fixtures/objc-conditional-strings.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.doesNotMatch(artifact.source, /z_nsstring_from_string\(accepted\)/);
  const result = spawnSync(process.execPath, [cli, "run", example], {
    encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  });
  assert.equal(result.status, 0, result.stderr);
}, 60_000);

hostToolchainTest("copies owned Z strings across NSString boundaries without losing embedded nulls", () => {
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
  assert.equal(
    result.stdout,
    "round trip=answer=42\nproperty=answer=42\nscheme=https\nnullable=answer=42\nnarrowed=yes\nembedded=a\0b\n",
  );
}, 10_000);
