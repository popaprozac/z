import { tmpdir } from "node:os";
import { mkdirSync, symlinkSync } from "node:fs";
import { assert, cli, compileToNative, diagnostics, hover, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync, completions,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-subclass-weak-state.zs");
const source = readFileSync(fixture, "utf8");
const helperFixture = resolve(directory, "objc-subclass-private-helpers.zs");
const helperSource = readFileSync(helperFixture, "utf8");
const methodFixture = resolve(directory, "objc-subclass-z-methods.zs");
const methodSource = readFileSync(methodFixture, "utf8");
const methodCases: [string, string, RegExp][] = [
  ["private installation", methodSource.replace("function observe(", "private function observe("), /private/],
  ["off-main installation", methodSource.replace("function install(window: WindowState): i32 on thread.main", "function install(window: WindowState): i32"), /thread.main|main.executor/],
  ["native weak ABI", methodSource.replace("observer: Weak<Observer>): void {", 'observer: Weak<Observer>): void as "observe:" {'), /new native entries/],
  ["public method selector", methodSource.replace('import { thread }', 'import objc from "std/objc";\nimport { thread }')
    .replace("window.observe(weak observer);", "window.registerTarget(window, selector: objc.selector(WindowState.observe));"), /explicit.*as|native selector/],
  ["borrowed receiver mutation", methodSource.replace("function install(window:", "function install(in window:"), /immutable|borrowed|inout/],
];
const helperCases: [string, string, RegExp][] = [
  ["async helper", helperSource.replace("private function currentObserver", "private async function currentObserver"), /synchronous/],
  ["consuming helper", helperSource.replace("currentObserver()", "currentObserver(move this)"), /non-consuming/],
  ["static helper", helperSource.replace("private function currentObserver", "private static function currentObserver"), /instance method/],
  ["throwing helper", helperSource.replace("currentObserver(): Option<Observer>", "currentObserver(): Option<Observer> throws i32"), /non-throwing/],
  ["generic helper", helperSource.replace("currentObserver()", "currentObserver<T>()"), /instance method/],
  ["helper override", helperSource.replace("private function currentObserver", "private override function currentObserver"), /override.*explicit.*as/],
  ["helper super", helperSource.replace("const found = this.currentObserver();", "const found = this.currentObserver(); const base = super.value();"), /superclass dispatch.*native entry/],
  ["construction helper", helperSource.replace("this.count = 0;", "this.count = 0; const found = this.currentObserver();"), /Ready receiver/],
  ["readonly helper write", helperSource.replace("update(inout this, value", "update(value"), /immutable|inout this|borrowed/],
  ["readonly nested write", helperSource.replace("const found = this.currentObserver();", "const changed = this.update(1); const found = this.currentObserver();"), /immutable|inout this|borrowed/],
  ["private external access", helperSource.replace("window.readAccess(0)", "window.observedValue()"), /private/],
  ["helper selector", helperSource.replace('import { thread }', 'import objc from "std/objc";\nimport { thread }')
    .replace("const found = this.currentObserver();", "this.registerTarget(this, selector: objc.selector(WindowState.currentObserver)); const found = this.currentObserver();"), /explicit.*as|native selector/],
  ["helper receiver capture", helperSource.replace("const found = this.currentObserver();", "const callback = (): i32 => this.observedValue(); const found = this.currentObserver();"), /captur/],
  ["field loan into helper", helperSource.replace("  private function update(",
    "  private function change(inout field: i32): i32 { field = 5; return this.count; }\n  private function update(")
    .replace("this.count = value;", "this.count = value; const changed = this.change(inout this.count);"), /class-field|field.*borrow|inout.*field|locally contained/],
];
const cases: [string, string, RegExp][] = [
  ["native weak", source.replaceAll("Weak<Observer>", "Weak<WindowState>"), /ordinary Z classes|native weak-reference/],
  ["non-class weak", source.replaceAll("Weak<Observer>", "Weak<i32>"), /ordinary Z classes|Weak.*class/],
  ["arbitrary aggregate", source.replace("private observer: Option<Weak<Observer>>", "private observer: Array<Weak<Observer>>"), /native stored fields/],
  ["uninitialized field", source.replace("this.observer = Option.none;", ""), /initialize every native stored field|not initialized/],
  ["borrow escape", source.replace("const snapshot = this.previous;", "const snapshot = view this.previous;"), /class-field projection|value storage|owner/],
  ["read-only receiver", source.replace("writeAccess(inout this, mode", "writeAccess(mode"), /inout this|immutable|read-only|readonly/],
  ["off-main construction", source.replace("function exercise(): i32 on thread.main", "function exercise(): i32"), /thread.main|main.executor/],
];

// Instrument only this generated translation unit, not Foundation. Every Z
// allocation (including weak control blocks) must be released by main's return.
// This catches leaks without ASan or an unbounded GUI/sanitizer process.
function allocationChecked(source: string): string {
  assert.ok(source.includes("#include <stdlib.h>"));
  return source.replace("#include <stdlib.h>", `#include <stdlib.h>
static long z_test_allocations;
static void *z_test_malloc(size_t size) { void *p = malloc(size); if (p) z_test_allocations++; return p; }
static void *z_test_calloc(size_t n, size_t size) { void *p = calloc(n, size); if (p) z_test_allocations++; return p; }
static void z_test_free(void *p) { if (p) z_test_allocations--; free(p); }
static __attribute__((unused)) void *z_test_realloc(void *p, size_t size) {
  if (size == 0) { z_test_free(p); return NULL; }
  int existing = p != NULL;
  void *next = realloc(p, size);
  if (next && !existing) z_test_allocations++;
  return next;
}
#define malloc z_test_malloc
#define calloc z_test_calloc
#define free z_test_free
#define realloc z_test_realloc
`).replace(/\bmain\(/g, "z_test_main(") + `
int main(int argc, char **argv) {
  (void)argc; (void)argv;
  int result = z_test_main(${/\bmain\(void\)/.test(source) ? "" : "argc, argv"});
  if (result != 0) return result;
  if (z_test_allocations != 0) { fprintf(stderr, "unreleased Z allocations: %ld\\n", z_test_allocations); return 90; }
  return 0;
}
`;
}

hostToolchainTest("owns weak Z state and visibility-checked Z methods in native subclasses without retaining an observer cycle", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, fixture), []);
  const tooltip = hover(source, fixture, source.indexOf("this.observer") + 6);
  assert.match(JSON.stringify(tooltip), /Option<Weak<Observer>>/);
  for (const [name, candidate, expected] of cases) assert.throws(() => compileToNative(candidate, fixture), expected, name);
  assert.deepEqual(diagnostics(helperSource, helperFixture), []);
  const helperTooltip = hover(helperSource, helperFixture, helperSource.indexOf("this.currentObserver") + 6);
  assert.match(JSON.stringify(helperTooltip), /currentObserver.*Option<Observer>/);
  assert.ok(completions(helperSource, helperFixture, helperSource.indexOf("this.currentObserver") + "this.current".length)
    .some((item) => item.label === "currentObserver"));
  for (const [name, candidate, expected] of helperCases) assert.throws(() => compileToNative(candidate, helperFixture), expected, name);
  assert.deepEqual(diagnostics(methodSource, methodFixture), []);
  const methodOffset = methodSource.indexOf("window.observe(") + "window.ob".length;
  assert.match(JSON.stringify(hover(methodSource, methodFixture, methodOffset)), /observe.*Weak<Observer>/);
  const methodItems = completions(methodSource, methodFixture, methodOffset);
  assert.ok(methodItems.some((item) => item.label === "observe" && item.detail?.includes("Z-only method")));
  assert.ok(!methodItems.some((item) => item.label === "currentObserver"));
  for (const [name, candidate, expected] of methodCases) assert.throws(() => compileToNative(candidate, methodFixture), expected, name);
  const temporary = mkdtempSync(resolve(tmpdir(), "z-subclass-state-"));
  try {
    symlinkSync(resolve(directory, "objc-subclass.h"), resolve(temporary, "objc-subclass.h"));
    const emission = spawnSync(process.execPath, [cli, "self-host-emit", resolve(directory, "self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const emitter = resolve(temporary, "emitter");
    const compiler = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", emitter], {
      encoding: "utf8", input: emission.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(compiler.status, 0, compiler.stderr);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    const native = (candidate: string, companion = "", packageMode = "") => {
      writeFileSync(input, candidate);
      return spawnSync(emitter, [wire, input, companion, resolve(directory, "objc-subclass.h.zd"), packageMode], {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
    };
    const result = native(source);
    assert.equal(result.status, 0, result.stderr);
    const helperResult = native(helperSource);
    assert.equal(helperResult.status, 0, helperResult.stderr);
    const methodResult = native(methodSource);
    assert.equal(methodResult.status, 0, methodResult.stderr);
    for (const [name, candidate, expected] of methodCases) {
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, name);
    }
    for (const [name, candidate, expected] of helperCases) {
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, name);
    }
    const helperModule = resolve(temporary, "window-state.zs");
    const helperBoundary = helperSource.indexOf("function exercise");
    writeFileSync(helperModule, helperSource.slice(0, helperBoundary).replace("class WindowState", "export class WindowState"));
    const importedHelpers = 'import native from "./objc-subclass.h";\nimport { thread } from "std/thread";\nimport { WindowState } from "./window-state.zs";\n'
      + helperSource.slice(helperBoundary);
    const importedHelperResult = native(importedHelpers, helperModule);
    assert.equal(importedHelperResult.status, 0, importedHelperResult.stderr);
    const methodModule = resolve(temporary, "window-methods.zs");
    const methodBoundary = methodSource.indexOf("function install");
    writeFileSync(methodModule, methodSource.slice(0, methodBoundary));
    const importedMethods = 'import native from "./objc-subclass.h";\nimport { thread } from "std/thread";\nimport { Observer, WindowState } from "./window-methods.zs";\n'
      + methodSource.slice(methodBoundary);
    const importedMethodResult = native(importedMethods, methodModule);
    assert.equal(importedMethodResult.status, 0, importedMethodResult.stderr);
    const importedMethodOffset = importedMethods.indexOf("window.observe(") + "window.ob".length;
    assert.match(JSON.stringify(hover(importedMethods, input, importedMethodOffset)), /observe.*Weak<Observer>/);
    assert.ok(completions(importedMethods, input, importedMethodOffset).some((item) => item.label === "observe"));
    const internalDeclaration = methodSource.slice(0, methodBoundary).replace("function observe(", "internal function observe(");
    writeFileSync(methodModule, internalDeclaration);
    writeFileSync(resolve(temporary, "z.json"), JSON.stringify({
      package: { name: "subclass-probe", version: "0.1.0" },
      target: { name: "subclass-probe", entry: "input.zs" },
    }));
    const internalGenerated = compileToNative(importedMethods, input).source;
    const internalResult = native(importedMethods, methodModule, "same-package");
    assert.equal(internalResult.status, 0, internalResult.stderr);
    const inaccessible = native(importedMethods, methodModule, "split-package");
    assert.equal(inaccessible.status, 1, inaccessible.stderr);
    assert.match(inaccessible.stderr, /observe.*internal to its package/);
    assert.ok(completions(importedMethods, input, importedMethodOffset)
      .some((item) => item.label === "observe" && item.detail?.startsWith("internal function")));
    const dependencyDirectory = resolve(temporary, "dependency");
    mkdirSync(dependencyDirectory);
    writeFileSync(resolve(dependencyDirectory, "z.json"), JSON.stringify({
      package: { name: "state", version: "0.1.0" },
      library: { entry: "window-methods.zs" },
    }));
    symlinkSync(resolve(directory, "objc-subclass.h"), resolve(dependencyDirectory, "objc-subclass.h"));
    writeFileSync(resolve(dependencyDirectory, "window-methods.zs"), internalDeclaration);
    writeFileSync(resolve(temporary, "z.json"), JSON.stringify({
      package: { name: "subclass-probe", version: "0.1.0" },
      target: { name: "subclass-probe", entry: "input.zs" },
      dependencies: { state: { path: "./dependency" } },
    }));
    const inaccessibleMethods = importedMethods.replace('"./window-methods.zs"', '"state"');
    assert.throws(() => compileToNative(inaccessibleMethods, input), /observe.*internal to its package/);
    const inaccessibleOffset = inaccessibleMethods.indexOf("window.observe(") + "window.ob".length;
    assert.ok(!completions(inaccessibleMethods, input, inaccessibleOffset).some((item) => item.label === "observe"));
    writeFileSync(methodModule, methodSource.slice(0, methodBoundary));
    for (const [name, candidate, expected] of cases) {
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, `${name}: ${rejected.stderr}`);
    }
    const withDeinit = source.replace("  override function readAccess", "  deinit { native.z_subclass_source_deinit(5, 2); }\n\n  override function readAccess")
      .replace("    index = index + 1;", "    if (native.z_subclass_source_deinits() != (index + 1) * 2) return 9;\n    index = index + 1;");
    const deinitResult = native(withDeinit);
    assert.equal(deinitResult.status, 0, deinitResult.stderr);
    const observerStart = source.indexOf("class Observer");
    const observerEnd = source.indexOf("\nfunction expiredObserver");
    const observerDeclaration = source.slice(observerStart, observerEnd);
    const companion = resolve(temporary, "observer.zs");
    writeFileSync(companion, source.slice(0, observerStart) + "export " + observerDeclaration);
    const imported = source.replace(observerDeclaration, 'import { Observer } from "./observer.zs";\n');
    const importedResult = native(imported, companion);
    assert.equal(importedResult.status, 0, importedResult.stderr);
    for (const [name, generated] of [
      ["stage0", compileToNative(source, fixture).source], ["native", result.stdout],
      ["stage0-helpers", compileToNative(helperSource, helperFixture).source], ["native-helpers", helperResult.stdout],
      ["stage0-helpers-import", compileToNative(importedHelpers, input).source], ["native-helpers-import", importedHelperResult.stdout],
      ["stage0-methods", compileToNative(methodSource, methodFixture).source], ["native-methods", methodResult.stdout],
      ["stage0-methods-import", compileToNative(importedMethods, input).source], ["native-methods-import", importedMethodResult.stdout],
      ["stage0-methods-internal", internalGenerated], ["native-methods-internal", internalResult.stdout],
      ["stage0-deinit", compileToNative(withDeinit, fixture).source], ["native-deinit", deinitResult.stdout],
      ["stage0-import", compileToNative(imported, input).source], ["native-import", importedResult.stdout],
    ]) {
      const teardown = generated.slice(generated.indexOf("- (void)dealloc"));
      assert.ok(/_deinit\(&self->_z_native_field_observer\)|z_weak_release\(\(self->_z_native_field_observer\)\.data.some\)/.test(teardown), `${name}: missing optional weak cleanup`);
      if (name.includes("helpers") || name.includes("methods")) {
        assert.doesNotMatch(generated, /[-+]\s*\([^\n]+\)currentObserver\b|@selector\(currentObserver\)/);
        assert.match(generated, /currentObserver\([^\n]+_z_native_subclass_parent_loan/);
        if (name.includes("methods")) {
          assert.doesNotMatch(generated, /[-+]\s*\([^\n]+\)(?:observe|snapshot)\b|@selector\((?:observe|snapshot)\b/);
          assert.match(generated, /observe\([^\n]+_z_native_subclass_parent_loan/);
        }
      } else assert.ok(/_deinit\(&self->_z_native_field_previous\)|z_weak_release\(self->_z_native_field_previous\)/.test(teardown), `${name}: missing direct weak cleanup`);
      const path = resolve(temporary, `${name}.m`);
      writeFileSync(path, allocationChecked(generated));
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, "probe");
        const built = spawnSync("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-I", directory, "-framework", "Foundation", path, resolve(directory, "objc-subclass.m"), "-o", executable], {
          encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, `${name} ${optimization}: ${built.stderr}`);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
          env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: "0" } });
        assert.equal(run.error, undefined);
        assert.equal(run.signal, null);
        assert.equal(run.status, 0, `${name} ${optimization}: ${run.stderr}`);
        assert.doesNotMatch(run.stderr, /runtime error|UndefinedBehaviorSanitizer/);
        if (name.includes("helpers") || name.includes("methods")) for (const scenario of [1, 2, 3]) {
          const conflict = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
            env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: String(scenario) } });
          assert.equal(conflict.status, 86, `${name} ${optimization} scenario ${scenario}: ${conflict.stderr}`);
          assert.equal(conflict.signal, null);
          assert.match(conflict.stderr, /reentrant native subclass access conflicts with inout this/);
        }
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
