import {
  assert, cli, compileToNative, mkdtempSync, projectRoot, readFileSync,
  resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

// Count Z's explicit allocations only; Foundation/ARC allocations remain owned
// by their native runtimes. Import headers before defining allocator macros.
function trackAllocations(source: string): string {
  return `#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <stdio.h>
static void *allocations[4096];
static size_t allocation_count;
static size_t allocation_index(void *pointer) {
  for (size_t i = 0; i < allocation_count; ++i) if (allocations[i] == pointer) return i;
  fprintf(stderr, "untracked allocation\\n"); exit(90);
}
static void record_allocation(void *pointer) {
  if (!pointer || allocation_count == 4096) exit(91);
  allocations[allocation_count++] = pointer;
}
static __attribute__((unused)) void *probe_malloc(size_t size) {
  void *pointer = malloc(size); record_allocation(pointer); return pointer;
}
static __attribute__((unused)) void *probe_calloc(size_t count, size_t size) {
  void *pointer = calloc(count, size); record_allocation(pointer); return pointer;
}
static __attribute__((unused)) void *probe_realloc(void *pointer, size_t size) {
  const size_t index = pointer ? allocation_index(pointer) : allocation_count;
  void *replacement = realloc(pointer, size);
  if (!replacement) exit(92);
  if (index == allocation_count) record_allocation(replacement);
  else allocations[index] = replacement;
  return replacement;
}
static __attribute__((unused)) void probe_free(void *pointer) {
  if (!pointer) return;
  const size_t index = allocation_index(pointer);
  allocations[index] = allocations[--allocation_count]; free(pointer);
}
#define malloc probe_malloc
#define calloc probe_calloc
#define realloc probe_realloc
#define free probe_free
#define main fixture_main
${source}
#undef main
int main(int argc, char **argv) {
  int status;
  @autoreleasepool { status = fixture_main(${/\bmain\(int argc/.test(source) ? "argc, argv" : ""}); }
  if (allocation_count) { fprintf(stderr, "leaked %zu allocations\\n", allocation_count); return 93; }
  return status;
}
`;
}

test("balances owned String conversions while preserving borrowed NSString inputs", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-objc-string-lifetime-");
  try {
    const fixture = resolve(projectRoot, "tests/fixtures/objc-string-lifetime.zs");
    const stage0 = compileToNative(readFileSync(fixture, "utf8"), fixture).source;
    const emission = spawnSync(process.execPath, [cli, "self-host-emit",
      resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-execution.zs")], {
      // A changed compiler rebuilds and fixed-point-checks the native frontend
      // library before emitting this oracle. Runtime cases remain five seconds.
      encoding: "utf8", timeout: 360_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
      detached: true,
    });
    if (emission.error && emission.pid > 0) {
      try { process.kill(-emission.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    assert.equal(emission.status, 0, emission.stderr || String(emission.error ?? emission.signal));
    const oracle = resolve(directory, "emitter");
    const builtOracle = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: emission.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(builtOracle.status, 0, builtOracle.stderr);
    const wire = resolve(directory, "native.zfdcl");
    const contract = resolve(directory, "native.zd");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "objc-string-lifetime.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, []).get("native")!);
    writeFileSync(contract, readFileSync(resolve(projectRoot, "tests/fixtures/objc-string-lifetime.h.zd"), "utf8"));
    const native = spawnSync(oracle, [wire, fixture, "", contract], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    const failures: string[] = [];
    for (const [frontend, source] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, `${frontend}${optimization}`);
        const built = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks",
          "-Wall", "-Wextra", "-Werror", optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-I", resolve(projectRoot, "tests/fixtures"), "-framework", "Foundation",
          "-mmacosx-version-min=14.0", "-", "-o", binary], {
          input: trackAllocations(source), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, built.stderr);
        for (const scenario of ["literal", "move", "borrow", "copy", "call", "template", "return", "in", "field", "conditional",
          "return-local", "return-parameter", "straight-borrow", "borrowed-call-temporary", "borrowed-template", "mixed", "mixed-template"]) {
          const run = spawnSync(binary, [scenario], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          if (run.status !== 0 || run.stdout !== "" || run.stderr !== "") {
            failures.push(`${frontend} ${optimization} ${scenario}: ${run.status} ${run.stderr || run.stdout || run.error}`);
          }
        }
      }
    }
    assert.deepEqual(failures, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 480_000);
