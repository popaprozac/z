import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { compileToC, compileToNative } from "../compiler/src/compiler.ts";
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

test("selectively imports C types and constants with the same aliases used by functions", () => {
  const example = resolve(projectRoot, "examples/selective-declarations.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective point=23,19 score=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static ZDirection direction\(void\)/);
  assert.match(generated, /return ZForward;/);
  assert.match(generated, /static ZPoint shift\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /return z_translate\(point, direction\(\), amount\);/);
  assert.match(generated, /const ZPoint point = \(ZPoint\)\{ \.x = 20, \.y = 19 \};/);
  assert.doesNotMatch(generated, /\b(Point|Direction|Count|forward|translate|score)\s*\(/);
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
      const point: Point = geometry.ZPoint { x: 20, y: 22 };
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
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrote handle\n");
  assert.equal(readFileSync("/tmp/z-lang-foreign-handle.txt", "utf8"), "owned by Z\n");

  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-double-close.txt", "w");
      if (!file) { return 1; }
      stdio.fclose(file);
      return stdio.fclose(file);
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-consume.z"),
    /use of moved value "file"/,
  );
});

test("discovers ownership notes beside project headers", () => {
  const source = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      const handle = handles.z_test_open();
      if (!handle) { return 1; }
      return handles.z_test_use(handle);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "foreign-local-notes.z"));
  assert.match(generated, /ZTestHandle \* const handle = z_test_open\(\);/);
  assert.match(generated, /if \(_z_live_handle_0 && handle != NULL\) z_test_close\(handle\);/);
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
  assert.match(generated, /const uint16_t result = \(value \+ 3\);/);
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
  assert.match(artifact.source, /const uint32_t shifted = \(one << 3U\);/);
  assert.match(artifact.source, /const uint32_t inverted = \(~one\);/);
  assert.match(artifact.source, /const uintptr_t toggled = \(filtered \^ 1ULL\);/);
  assert.match(artifact.source, /const float scientific = 1\.5e2F;/);
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
      const point = geometry.ZPoint { x: 1 };
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
      const point = geometry.ZPoint { x: 1, y: 2 };
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
      const point = geometry.ZPoint { x: 1, y: 2 };
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
      let point = geometry.ZPoint { x: 1, y: 2 };
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
      let point = geometry.ZPoint { x: 1, y: 2 };
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
    /arguments\.z:6:23: error: expected i32, found cstring/,
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
    /if-expression-types\.z:5:14: error: if branch produces cstring, but the other branch produces i32/,
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
    /closure-block-type\.z:3:23: error: a block-bodied closure requires an explicit return type/,
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
    /closure-argument\.z:4:23: error: expected i32, found cstring/,
  );
});

test("defers move captures that require owned closure environments", () => {
  const source = `
    struct Resource {
      value: i32;
      deinit {}
    }
    function main(): i32 {
      const resource = Resource { value: 42 };
      const consume = move (): i32 => resource.value;
      return consume();
    }
  `;
  assert.throws(
    () => compileToC(source, "closure-owned-move.z"),
    /closure-owned-move\.z:8:39: error: move-capturing cleanup-bearing Resource requires an owned closure environment, which is not implemented yet/,
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
      const first = Resource { id: 1 };
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
      const resource = Resource { id: 1 };
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
      match choice {
        move value => consume(resource);
        keep value => value;
      }
      return resource.id;
    }
    function main(): i32 {
      return choose(Choice.keep 1, Resource { id: 2 });
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
    function make(): Resource { return Resource { id: 1 }; }
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
      const resource = Resource { id: 1 };
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
      let resource = Resource { id: 1 };
      while (index < 2) {
        consume(resource);
        resource = Resource { id: index + 2 };
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
        match Action.stop {
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
      let matrix = Matrix { rows: [[1, 2], [3, 4]] };
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
      let items = [Item { value: 1 }, Item { value: 2 }];
      consume(items[0]);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "array-element-move.z"),
    /moving a cleanup-bearing element out of its owner is not implemented yet/,
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
      const resource = Resource { id: 1 };
      const other = identity(resource);
      return resource.id + other.id;
    }
  `;
  assert.throws(() => compileToC(moved, "generic-move.z"), /use of moved value "resource"/);
});

test("infers generic calls while preserving explicit instantiation", () => {
  const wrongArity = `
    struct Pair<T, U> { first: T; second: U; }
    function main(): i32 { const pair = Pair<i32> { first: 1, second: 2 }; return 0; }
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

test("infers nested generic calls and calls within generic functions", () => {
  const source = `
    struct Box<T> { value: T; }
    function identity<T>(value: T): T { return value; }
    function unbox<T>(box: Box<T>): T { return identity(box.value); }
    function main(): i32 {
      const box = Box<i32> { value: 42 };
      return identity(unbox(box));
    }
  `;
  const generated = compileToC(source, "generic-nested-inference.z");
  assert.match(generated, /__z_mono_unbox_i32/);
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
    function main(): i32 { return read(Reading {}); }
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
      const holder = Holder<Reading> { value: Reading {} };
      return read(holder.value);
    }
  `;
  assert.match(compileToC(valid, "generic-multiple-constraints.z"), /__z_mono_Holder_Reading/);

  const invalidAggregate = `
    trait Measured { function measure(): i32; }
    struct Plain {}
    struct Holder<T: Measured> { value: T; }
    function main(): i32 { const holder = Holder<Plain> { value: Plain {} }; return 0; }
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
    struct Box<T> { value: T; }
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
      const pair = Pair<i32> { first: 20, second: 22 };
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
      values.push(Item { id: 1 });
      const item = values[0];
      return item.id;
    }
  `;
  assert.throws(() => compileToC(partialMove, "dynamic-array-partial-move.z"), /moving a cleanup-bearing element out of its owner is not implemented/);
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
      const point = Point { x: 20, y: 22 };
      return point.sum();
    }
  `;
  const generated = compileToC(source, "point.z");
  assert.match(generated, /struct Z_Point \{/);
  assert.match(generated, /static int32_t Z_Point_sum\(const Z_Point \*self\)/);
  assert.match(generated, /const Z_Point point = \(Z_Point\)\{ \.x = 20, \.y = 22 \};/);
  assert.match(generated, /return Z_Point_sum\(&\(point\)\);/);
});

test("requires every struct field exactly once", () => {
  const source = `
    struct Point {
      x: i32;
      y: i32;
    }
    function main(): i32 {
      const point = Point { x: 1 };
      return point.x;
    }
  `;
  assert.throws(
    () => compileToC(source, "missing-field.z"),
    /missing-field\.z:7:21: error: missing field "y" when constructing "Point"/,
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
      const counter = Counter { value: 1 };
      return counter.add("wrong");
    }
  `;
  assert.throws(
    () => compileToC(source, "method-arguments.z"),
    /method-arguments\.z:10:26: error: expected i32, found cstring/,
  );
});

test("requires exhaustive enum matches", () => {
  const source = `
    enum Outcome {
      success i32,
      failure i32,
    }
    function main(): i32 {
      const outcome = Outcome.success 42;
      match outcome {
        success value => return value;
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

test("compiles expression matches with concise and selecting block arms", () => {
  const example = resolve(projectRoot, "examples/match-expression.z");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "code=41\ndirect=41\nselected=42\n");
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
      const choice = Choice.first 42;
      const value = match choice {
        first number => number;
        second number => "wrong";
      };
      return value;
    }
  `;
  assert.throws(
    () => compileToC(source, "match-types.z"),
    /match-types\.z:7:9: error: match arm produces cstring, but previous arms produce i32/,
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
    function main(): i32 { throw Problem { code: 1 }; }
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
  assert.match(generated, /count = \(count \+ 1\);/);
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
      const counter = Counter { value: 1 };
      counter.add(2);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, "immutable-receiver.z"),
    /mutable method "add" cannot be called through immutable binding "counter"/,
  );

  const temporary = immutable.replace(
    "const counter = Counter { value: 1 };\n      counter.add(2);",
    "Counter { value: 1 }.add(2);",
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
      let resource = Resource { value: 1 };
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
  assert.match(generated, /self\.id = \(self\.id \+ offset\);/);
  assert.match(generated, /Z_Resource_relay\(\(_z_live_first_\d+ = false, first\)\)/);
  assert.match(generated, /Z_Resource_finish\(\(_z_live_second_\d+ = false, second\), 2\)/);

  const useAfterConsume = `
    struct Resource {
      id: i32;
      function finish(move this): void {}
      deinit {}
    }
    function main(): i32 {
      const resource = Resource { id: 1 };
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
      const resource = Resource { id: 1 };
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
      const point = Point { x: 1 };
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
  assert.match(generated, /if \(value->_z_refcount == 0\) \{\n\s+Z_Counter_deinit\(value\);\n\s+free\(value\);/);
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
      const size = Size { value: 42 };
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
      const counter = Counter { value: 1 };
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
      const counter = Counter { count: 1 };
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

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}

test("editor grammar tracks keywords without reserving Result variants", () => {
  const grammarPath = resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json");
  const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));
  const keywordPattern = grammar.repository.keywords.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const constantPattern = grammar.repository.constants.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const operatorPattern = grammar.repository.operators.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  const typePattern = grammar.repository.types.patterns.map((pattern: { match: string }) => pattern.match).join(" ");
  assert.match(keywordPattern, /throw/);
  assert.match(keywordPattern, /attempt/);
  assert.match(keywordPattern, /yield/);
  assert.match(keywordPattern, /select/);
  assert.match(keywordPattern, /move/);
  assert.match(keywordPattern, /deinit/);
  assert.match(keywordPattern, /out\|inout/);
  assert.match(keywordPattern, /\bin\b/);
  assert.match(keywordPattern, /\bas\b/);
  assert.match(keywordPattern, /implements/);
  assert.match(keywordPattern, /while/);
  assert.match(keywordPattern, /break/);
  assert.match(keywordPattern, /continue/);
  assert.match(grammar.repository.declarations.patterns.map((pattern: { match: string }) => pattern.match).join(" "), /trait\|class/);
  assert.match(constantPattern, /true\|false/);
  assert.match(constantPattern, /null/);
  assert.match(constantPattern, /this/);
  assert.match(operatorPattern, /&&/);
  assert.match(operatorPattern, /<</);
  assert.match(operatorPattern, /\^/);
  assert.match(operatorPattern, /=/);
  assert.match(typePattern, /Slice/);
  assert.match(typePattern, /Array/);
  assert.doesNotMatch(keywordPattern, /success|failure/);

  const extension = readFileSync(resolve(projectRoot, "editors/vscode/extension.js"), "utf8");
  assert.match(extension, /6: vscode\.CompletionItemKind\.Variable/);
  assert.match(extension, /8: vscode\.CompletionItemKind\.Interface/);
  assert.match(extension, /createFileSystemWatcher/);
  assert.match(extension, /restartLanguageServer/);
});
