import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";
import { completions, diagnostics, hover } from "../compiler/src/language-service.ts";

const fixtures = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(fixtures, "objc-optional-overrides.zs");

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

hostToolchainTest("preserves Objective-C protocol identity across imported namespaces", () => {
  if (process.platform !== "darwin") return;
  const source = `
import first from "objc-optional-overrides.h";
import second from "objc-optional-overrides.h";
import { thread } from "std/thread";
function value(in sender: first.ZDropInfo): i32 on thread.main { return sender.value; }
function forward(in sender: second.ZDropInfo): i32 on thread.main { return value(in sender); }
function main(): i32 { return 0; }
`;
  const artifact = compileToNative(source, fixture);
  assert.match(artifact.source, /value\(id<ZDropInfo> sender\)/);
  command("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
    "-I", fixtures, "-fsyntax-only", "-"], artifact.source);
  const different = source.replace("in sender: second.ZDropInfo", "in sender: second.ZOptionalCallbacks");
  assert.throws(() => compileToNative(different, fixture), /expected.*ZDropInfo.*found.*ZOptionalCallbacks/);
}, 60_000);

hostToolchainTest("checks optional inherited Objective-C callbacks without promising superclass implementations", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync("/tmp/z-objc-optional-overrides-");
  try {
    const source = readFileSync(fixture, "utf8");
    assert.deepEqual(diagnostics(source, fixture), []);
    const optionalOffset = source.indexOf("objc.optionalCall") + "objc.".length;
    assert.ok(completions(source, fixture, optionalOffset).some((item) => item.label === "optionalCall"));
    assert.match(JSON.stringify(hover(source, fixture, optionalOffset + 2)), /lexical superclass.*before evaluating arguments/);
    const optionalMember = source.indexOf("super.missingIncrement") + "super.".length;
    assert.ok(completions(source, fixture, optionalMember).some((item) => item.label === "missingIncrement"));
    assert.match(JSON.stringify(hover(source, fixture, optionalMember + 2)), /missingIncrement/);
    const wire = resolve(temporary, "native.zfdcl");
    const contract = resolve(temporary, "native.zd");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "objc-optional-overrides.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [fixtures]).get("native")!);
    writeFileSync(contract, 'declare module "objc-optional-overrides.h" {}');
    const seed = command(process.execPath, [cli, "self-host-emit",
      resolve(fixtures, "self-host-objc-subclass-execution.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    const native = command(oracle, [wire, fixture, "", contract]);
    for (const [name, output] of [["stage0", compileToNative(source, fixture).source], ["native", native]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, `${name}${optimization}`);
        command("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures,
          "-framework", "Foundation", "-", "-o", executable], output);
        command(executable, [], undefined, 5_000);
        for (const phase of [1, 2]) {
          const guarded = spawnSync(executable, [], {
            encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
            env: { ...process.env, Z_CALLBACK_PHASE: String(phase) },
          });
          assert.equal(guarded.status, 90 + phase, guarded.stderr);
          assert.match(guarded.stderr, /native callback entered before Ready or during teardown/);
        }
      }
    }
    for (const [name, candidate, expected] of [
      ["missing override", source.replace("override function accept", "function accept"), /requires.*override/],
      ["wrong result", source.replace('i32 as "acceptInfo:"', 'boolean as "acceptInfo:"'), /returns/],
      ["wrong parameter", source.replace("override function accept(in info: native.ZDropInfo", "override function accept(in info: native.ZCallbackBase"), /parameter.*expects/],
      ["unimplemented super", source.replace("return value + 7;", "return super.acceptInfo(info);"), /no method|superclass call must resolve/],
      ["unimplemented ordinary call", source.replace("return 0;", "return target.missingValue();"), /no method|unknown method|cannot resolve/],
      ["unimplemented getter", source.replace("return info.value;", "return info.missing;"), /no field|no .*property|no member|cannot resolve|unknown/],
      ["ordinary optional target", source.replace("super.missingIncrement(native.z_callback_argument())", "this.optionalValue()"), /requires one direct synchronous super/],
      ["optional argument type", source.replace("super.missingIncrement(native.z_callback_argument())", "super.missingIncrement(true)"), /expects|expected|matching|argument/],
      ["conditional initializer", source.replace("super.init();", "objc.optionalCall(super.init());"), /constructor must begin|constructor.*super|first.*super|initialize/],
      ["optional extra argument", source.replace("super.missingNote(native.z_callback_argument())", "super.missingNote(native.z_callback_argument()), 1"), /requires one direct synchronous super/],
      ["unguarded optional call", source.replace("objc.optionalCall(super.missingIncrement(native.z_callback_argument()))", "super.missingIncrement(native.z_callback_argument())"), /no method|superclass call must resolve/],
      ["shadowed namespace", source.replace("const absent =", "const objc = Fake(); const absent =")
        + "\nstruct Fake { function optionalCall(value: i32): Option<i32> { return Option.some(value); } }", /no method|unknown method|cannot resolve|superclass call must resolve/],
      ["unguarded nested optional", source.replace("super.missingIncrement(native.z_callback_argument())", "super.missingIncrement(super.missingValue())"), /no method|unknown method|cannot resolve|superclass call must resolve/],
    ] as const) {
      assert.throws(() => compileToNative(candidate, fixture), expected, name);
      const input = resolve(temporary, `${name.replaceAll(" ", "-")}.zs`);
      writeFileSync(input, candidate);
      const result = spawnSync(oracle, [wire, input, "", contract], {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, expected, `${name}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /internal compiler error/, name);
    }
    const callOffset = source.indexOf("target.optionalValue()") + "target.".length;
    const items = completions(source, fixture, callOffset);
    assert.ok(items.some((item) => item.label === "accept"));
    assert.ok(items.some((item) => item.label === "optionalValue"));
    assert.ok(!items.some((item) => item.label === "missingValue"));

    // Real SDK requirements live on NSView's adopted protocol, several bases
    // above WKWebView. Presence eligibility must survive inherited lookup.
    const sdkSource = `import WebKit from "WebKit/WebKit.h";
import objc from "std/objc";
import { thread } from "std/thread";
class DropView extends WebKit.WKWebView on thread.main {
  constructor(frame: WebKit.CGRect, configuration: WebKit.WKWebViewConfiguration) {
    super.initWithFrame(frame, configuration: configuration);
  }
  override function draggingEntered(in sender: WebKit.NSDraggingInfo): WebKit.NSDragOperation as "draggingEntered:" {
    const inherited = objc.optionalCall(super.draggingEntered(sender));
    return match (in inherited) { some(operation) => operation; none => WebKit.NSDragOperationNone; };
  }
  override function performDragOperation(in sender: WebKit.NSDraggingInfo): boolean as "performDragOperation:" {
    const inherited = objc.optionalCall(super.performDragOperation(sender));
    return match (in inherited) { some(accepted) => accepted; none => false; };
  }
}
function main(): i32 on thread.main { return 0; }`;
    const sdkFile = resolve(temporary, "webview.zs");
    const sdkWire = resolve(temporary, "webview.zfdcl");
    const sdkContract = resolve(temporary, "webview.zd");
    writeFileSync(sdkFile, sdkSource);
    writeFileSync(sdkContract, 'declare module "WebKit/WebKit.h" {}');
    writeFileSync(sdkWire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "WebKit", bindings: null, header: "WebKit/WebKit.h",
      location: { fileName: sdkFile, offset: 0, line: 1, column: 1 },
    }], sdkFile, []).get("WebKit")!);
    for (const output of [compileToNative(sdkSource, sdkFile).source, command(oracle, [sdkWire, sdkFile, "", sdkContract])]) {
      command("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], output);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
