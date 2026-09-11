// --check never opens a window. --run is an explicit, bounded GUI test.
// Strict Clang + UBSan only; never ASan. Expected receiver-guard aborts are
// caught by the test fixture to avoid macOS crash-report processes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileToNative } from "../compiler/src/compiler.ts";

const mode = process.argv[2];
if (process.platform !== "darwin" || !["--check", "--run"].includes(mode ?? "")
  || process.argv.slice(3).some((argument) => !["--native", "--webview"].includes(argument))) {
  console.error("Usage: bun scripts/probe-appkit-resize.ts --check|--run [--native] [--webview] (--run opens windows)");
  process.exit(2);
}
const root = resolve(import.meta.dir, "..");
const example = resolve(root, "examples/interop/objc/smooth-window");
const original = readFileSync(resolve(example, "main.zs"), "utf8");
const native = process.argv.includes("--native");
const webview = process.argv.includes("--webview");
const temporary = mkdtempSync(resolve(tmpdir(), "z-appkit-resize-"));
const controller = original.slice(0, original.indexOf("function main():"));
const scenarios = `
import probe from "./objc-subclass.h";
import console from "std/console";
function pump(seconds: f64): void on thread.main {
  const deadline = clock.CACurrentMediaTime() + seconds;
  while (clock.CACurrentMediaTime() < deadline) {
    AppKit.NSRunLoop.mainRunLoop.runUntilDate(AppKit.NSDate.dateWithTimeIntervalSinceNow(0.005));
  }
}
function near(left: f64, right: f64): boolean {
  return left - right < 1 && right - left < 1;
}
function sameFrame(left: AppKit.NSRect, right: AppKit.NSRect): boolean {
  return near(left.origin.x, right.origin.x) && near(left.origin.y, right.origin.y)
    && near(left.size.width, right.size.width) && near(left.size.height, right.size.height);
}
function printFrame(frame: AppKit.NSRect): void {
  console.error(\`(\${frame.origin.x}, \${frame.origin.y}, \${frame.size.width}, \${frame.size.height})\`);
}
function main(): i32 {
  probe.z_subclass_catch_abort();
  const app = AppKit.NSApplication.sharedApplication;
  const window = new SmoothWindow(AppKit.NSMakeRect(100, 100, 320, 240));
  window.makeKeyAndOrderFront(null);
  if (window.frame.size.width < 300) {
    console.error("WindowServer access required: the ordered window lost its requested geometry");
    window.close();
    return 3;
  }
  const original = window.frame;
  let expected = original;
  const enlarged = AppKit.NSMakeRect(original.origin.x, original.origin.y, original.size.width + 150, original.size.height + 100);
  const scenario = probe.z_subclass_access_scenario();
  if (scenario == 0) {
    window.resize(enlarged, true, true);
    pump(0.5);
    if (!sameFrame(window.frame, enlarged) || window.isAnimating()) {
      console.error("transition failed to reach its target and stop");
      return 10;
    }
    const callbacks = window.displayCallbacks();
    if (callbacks == 0) return 11;
    pump(0.1);
    if (window.displayCallbacks() != callbacks) return 12;
    window.resize(original, true, true);
  } else if (scenario == 1) {
    window.resize(enlarged, true, true);
    pump(0.08);
    window.resize(original, true, true);
  } else if (scenario == 2) {
    window.resize(enlarged, true, true);
    pump(0.08);
    window.setFrame(original, true);
    if (window.isAnimating()) return 20;
  } else if (scenario == 3) {
    window.zoom(null);
    if (!window.isAnimating() || !window.zoomed) return 31;
    pump(0.5);
    if (sameFrame(window.frame, original) || window.isAnimating() || !window.zoomed) return 30;
    window.zoom(null);
    if (!window.isAnimating() || window.zoomed) return 32;
  } else if (scenario == 4) {
    window.zoom(null);
    pump(0.08);
    window.zoom(null);
  } else if (scenario == 5) {
    window.resize(enlarged, true, true);
    pump(0.08);
    window.close();
    const callbacks = window.displayCallbacks();
    pump(0.25);
    if (window.isAnimating() || window.displayCallbacks() != callbacks) return 50;
    console.log("close cancelled display callbacks");
    return 0;
  } else if (scenario == 6) {
    window.resize(enlarged, true, true);
    if (window.isAnimating() || !sameFrame(window.frame, enlarged) || window.displayCallbacks() != 0) return 60;
    window.setFrame(original, true);
  } else if (scenario == 7 || scenario == 8) {
    window.zoom(null);
    pump(0.5);
    if (!window.zoomed) return 71;
    const maximized = window.frame;
    // Moving a maximized window must not replace the saved user frame.
    window.setFrameOrigin(AppKit.NSMakePoint(maximized.origin.x + 12, maximized.origin.y - 12));
    const movedIsZoomed = window.zoomed;
    if (scenario == 8) {
      // Once outside the standard frame, a subsequent user size change is
      // the new restore geometry rather than the original pre-zoom geometry.
      window.setFrame(enlarged, true);
      expected = window.frame;
      window.zoom(null);
      pump(0.5);
      if (!window.zoomed) return 81;
    }
    window.zoom(null);
    if (scenario == 7 && !movedIsZoomed) {
      // AppKit may regard the moved frame as nonstandard and maximize again
      // first. Preserve that native toggle, then verify the saved user frame.
      pump(0.5);
      if (!window.zoomed) return 72;
      window.zoom(null);
    }
  } else if (scenario == 9) {
    window.resize(original, true, true);
    if (window.isAnimating() || window.displayCallbacks() != 0) return 91;
  } else if (scenario == 10) {
    window.resize(enlarged, true, true);
    pump(0.08);
    if (!window.isAnimating()) return 101;
    window.reduceMotion();
    pump(0.1);
    if (window.isAnimating() || !sameFrame(window.frame, enlarged)) return 102;
    const callbacks = window.displayCallbacks();
    pump(0.1);
    if (window.displayCallbacks() != callbacks) return 103;
    window.setFrame(original, true);
  } else if (scenario == 11) {
    window.resize(enlarged, true, true);
    if (window.isAnimating() || !sameFrame(window.frame, enlarged) || window.displayCallbacks() != 0) return 111;
    window.setFrame(original, true);
  }
  pump(0.5);
  if (!sameFrame(window.frame, expected) || window.isAnimating()) {
    console.error("expected frame (x, y, width, height):");
    printFrame(expected);
    console.error("observed frame:");
    printFrame(window.frame);
    if (window.isAnimating()) console.error("still animating");
    window.close();
    return 70;
  }
  window.close();
  console.log("reached expected frame and stopped");
  return 0;
}
`;

const pageObserver = `
import probe from "./objc-subclass.h";
import console from "std/console";
class PageObserver on thread.main implements WebKit.WKScriptMessageHandler {
  readonly window: AppKit.NSWindow;
  status: i32;
  function receive(inout this, in controller: WebKit.WKUserContentController, in message: WebKit.WKScriptMessage): void as "userContentController:didReceiveScriptMessage:" {
    const body = message.body;
    if (body instanceof WebKit.NSString) {
      const text: String = body;
      console.log(text);
      if (text == "ready") {
        this.window.zoom(null);
      } else {
        this.status = text == "resized" ? 1 : -1;
        this.window.close();
      }
    }
  }
}
`;
const page = `<!doctype html><style>body{background:#15212b;color:white}#edge{position:fixed;bottom:0;right:0}</style>
<h1>Real WebView resize verification</h1><div id="edge">edge</div><script>
const initial=innerWidth;const sizes=new Set([initial]);
addEventListener('error',()=>webkit.messageHandlers.probe.postMessage('error'));
function observe(){sizes.add(innerWidth);requestAnimationFrame(observe)}
requestAnimationFrame(()=>requestAnimationFrame(()=>{
  observe();webkit.messageHandlers.probe.postMessage('ready');
  setTimeout(()=>{const edge=document.getElementById('edge').getBoundingClientRect();
    const passed=sizes.size>3&&innerWidth>initial&&Math.abs(edge.right-innerWidth)<2;
    webkit.messageHandlers.probe.postMessage(passed?'resized':'failed: '+JSON.stringify({initial,final:innerWidth,sizes:[...sizes],edgeRight:edge.right}));
  },1200);
}));</script>`;
const webviewSource = original.replaceAll("AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion", "false")
  .replace("function main(): i32 {", `${pageObserver}\nfunction main(): i32 {\n  probe.z_subclass_catch_abort();`)
  .replace("  window.contentView = webview;", `  window.contentView = webview;
  const observer = new PageObserver({ window, status: 0 });
  const contentController = configuration.userContentController;
  const registration = objc.register({
    add: contentController.addScriptMessageHandler(observer, "probe"),
    remove: contentController.removeScriptMessageHandlerForName("probe"),
  });`)
  .replace(/webview.loadHTMLString\(".*", baseURL: null\);/, () => `webview.loadHTMLString(${JSON.stringify(page)}, baseURL: null);`)
  .replace("  app.run();", `  console.log("entering AppKit event loop");
  app.run();`)
  .replace("  center.removeObserver(closeObserver);", `  center.removeObserver(closeObserver);
  if (observer.status != 1) return 90;
  console.log("WebView reported readiness, intermediate viewport sizes, and clean AppKit-loop shutdown");`);

function command(executable: string, args: string[], timeout = 30_000): string {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

try {
  for (const name of ["AppKit.h.zd", "z.json"]) symlinkSync(resolve(example, name), resolve(temporary, name));
  for (const name of ["objc-subclass.h", "objc-subclass.h.zd"]) symlinkSync(resolve(root, "tests/fixtures", name), resolve(temporary, name));
  for (const reduced of webview ? [false] : [false, true]) {
    const input = resolve(temporary, "main.zs");
    // Deterministic test inputs only: do not change the user's accessibility
    // preference or turn the forced test duration into a production policy.
    const candidate = webview ? webviewSource : controller
      .replace("  private displayLink:", "  private testReducedMotion: boolean;\n  private displayLink:")
      .replace("    this.displayLink = null;", `    this.testReducedMotion = ${reduced};\n    this.displayLink = null;`)
      .replace("  function isAnimating()", '  function reduceMotion(inout this): void as "zResizeReduceMotion" { this.testReducedMotion = true; }\n  function isAnimating()')
      .replaceAll("AppKit.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion", "this.testReducedMotion")
      .replaceAll("const screen = this.screen;", `let screen: AppKit.NSScreen | null = this.screen;
    if (probe.z_subclass_access_scenario() == 11) screen = null;`)
      .replace(/const duration = super\.animationResizeTime\((frame|target)\);/g, "const duration: f64 = 0.25;") + scenarios;
    writeFileSync(input, candidate);
    const generated = resolve(temporary, "main.m");
    writeFileSync(generated, native ? command(resolve(root, ".z-cache/bootstrap/z"), ["emit", input], 60_000)
      : compileToNative(candidate, input).source);
    if (mode === "--check") {
      command("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0",
        "-fsyntax-only", "-I", resolve(root, "tests/fixtures"), generated]);
      console.log(`${native ? "native" : "stage0"} ${webview ? "WebView" : `reduceMotion=${reduced}`}: checked without opening windows`);
      continue;
    }
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(temporary, "probe");
      command("xcrun", ["clang", optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", resolve(root, "tests/fixtures"),
        "-framework", "AppKit", "-framework", "QuartzCore", "-framework", "WebKit",
        generated, resolve(root, "tests/fixtures/objc-subclass.m"), "-o", executable]);
      for (const scenario of webview ? [0] : reduced ? [6] : [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
        const result = spawnSync(executable, [], { encoding: "utf8", timeout: webview ? 15_000 : 8_000, killSignal: "SIGKILL",
          env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: String(scenario) } });
        assert.equal(result.status, 0, `${native ? "native" : "stage0"} ${optimization} scenario ${scenario}: ${result.stdout} ${result.stderr} ${result.error ?? ""}`);
        console.log(`${native ? "native" : "stage0"} ${optimization} scenario ${scenario}: ${result.stdout.trim()}`);
      }
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
