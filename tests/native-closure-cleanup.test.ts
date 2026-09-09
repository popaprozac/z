import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test,
} from "./support/bootstrap.ts";

function execute(source: string, expected: string): void {
  const directory = mkdtempSync("/tmp/z-closure-cleanup-");
  try {
    const executable = resolve(directory, "program");
    // UBSan checks generated operations; this ledger additionally proves that
    // invocation-local Strings and captured environments do not leak. It also
    // fails deterministically on double/foreign frees without an ASan process.
    const trackedSource = `
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
int main(void) {
  const int status = fixture_main(${/\bmain\(int argc/.test(source) ? "0, NULL" : ""});
  if (allocation_count) { fprintf(stderr, "leaked %zu allocations\\n", allocation_count); return 93; }
  return status;
}
`;
    const compilation = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable,
    ], { input: trackedSource, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error));
    const result = spawnSync(executable, [], {
      encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const [fixture, expected] of [
  ["self-host-emit-block-closure-owners.zs",
    'notes: {"text":"early"}\nreleased early\n'
    + 'notes: {"text":"move"}\nconsumed move\nreleased move\n'
    + 'notes: {"text":"normal"}\npayload\nreleased nested\n'
    + "released payload\nreleased normal\nreleased listener notes\n"],
  ["self-host-emit-block-closure-cleanup-edges.zs",
    "released delivery\nprepare\nreleased error prepare\n"
    + "released prepared\nreleased delivery\ncallback\nreleased error callback\n"
    + "released iteration 1\nreleased iteration 2\nreleased prepared\nreleased delivery\ndelivered\n"
    + "released iteration 1\nreleased iteration 2\nfirst 3\nsecond 3\nreleased prepared\nreleased delivery\ndelivered\n"],
] as const) {
  test(`owns invocation-local storage in ${fixture}`, () => {
    const input = resolve(projectRoot, "tests/fixtures", fixture);
    execute(compileToC(readFileSync(input, "utf8"), input), expected);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout, expected);
  }, 240_000);
}

test("keeps nested block-callable cleanup and same-named parameters in separate invocation scopes", () => {
  const input = resolve(projectRoot, "tests/fixtures/block-closure-nested.zs");
  const expected = "nested true\nnested true\nnested true done\ntrue\nfalse\n"
    + "nested false\nnested false\nnested false done\ntrue\nfalse\n";
  execute(compileToC(readFileSync(input, "utf8"), input), expected);
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  execute(emitted.stdout, expected);
}, 240_000);
