import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/async-worker-scope.zs");
const expected = "workers joined; resources released; wakes published on main\n";
let cachedEmission: string | undefined;
function emit(input: string): string {
  const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
function fixtureEmission(): string { return cachedEmission ??= emit(fixture); }
function execute(source: string, stdout: string, repetitions = 1): void {
  const directory = mkdtempSync("/tmp/z-native-worker-yield-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
      "-I", resolve(projectRoot, "tests/fixtures"),
      ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : []),
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable,
    ], { encoding: "utf8", input: source, timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error));
    for (let run = 0; run < repetitions; run += 1) {
      const execution = spawnSync(executable, [], {
        encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
      });
      assert.equal(execution.status, 0, execution.stderr || String(execution.error ?? execution.signal));
      assert.equal(execution.stderr, "");
      assert.equal(execution.stdout, stdout);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("retains worker TaskScope captures and joins cancellation before main wake cleanup", () => {
  if (process.platform !== "darwin") return;
  const source = fixtureEmission();
  assert.match(source, /Z_TaskScope_retain\(worker_context->updates\)/);
  assert.match(source, /is_cancellation_requested\(_z_stage1_task_storage\)\) z_stage1_async_request_cancel\(invocation.task\)/);
  // Scope-owned executors need the same external-completion lifecycle as a
  // caller-owned executor when TaskScope and worker joins appear together.
  assert.match(source, /if \(executor == NULL\) z_stage1_async_executor_init_external\(scope->executor\)/);
  assert.match(source, /if \(scope->executor == &scope->local_executor\) z_stage1_async_executor_destroy_external/);
  execute(source, expected, 10);
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected, 3);
}, 240_000);

test("releases a TaskScope capture when a native worker is cancelled before entry", () => {
  if (process.platform !== "darwin") return;
  const source = fixtureEmission();
  const helper = /static int32_t (z_stage1_thread_spawn_main_\d+)_body\(/.exec(source)?.[1];
  assert.ok(helper);
  execute(`#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  Z_TaskScope *scope = z_stage1_task_scope_new(NULL);
  ${helper}_Context *context = malloc(sizeof(*context));
  if (context == NULL) return 1;
  context->updates = Z_TaskScope_retain(scope);
  Z_Task_i32Storage storage = {0};
  storage.context = context;
  storage.cancellation_requested = true;
  if (pthread_mutex_init(&storage.state_mutex, NULL) != 0) return 2;
  if (pthread_cond_init(&storage.state_condition, NULL) != 0) return 3;
  if (pthread_create(&storage.thread, NULL, ${helper}_worker, &storage) != 0) return 4;
  if (pthread_join(storage.thread, NULL) != 0) return 5;
  if (!storage.finished || storage.result_live || storage.context != NULL) return 6;
  if (scope->refcount != 1 || scope->pending != 0 || entered_count != 0 || released_count != 0) return 7;
  if (pthread_cond_destroy(&storage.state_condition) != 0) return 8;
  if (pthread_mutex_destroy(&storage.state_mutex) != 0) return 9;
  z_stage1_task_scope_join(scope, true);
  Z_TaskScope_release(scope);
  // A borrowed enclosing executor must not be destroyed by its scope.
  Z_AsyncExecutor executor = {0};
  z_stage1_async_executor_init_external(&executor);
  scope = z_stage1_task_scope_new(&executor);
  z_stage1_task_scope_join(scope, false);
  Z_TaskScope_release(scope);
  z_stage1_async_external_lock(&executor);
  z_stage1_async_external_unlock(&executor);
  z_stage1_async_executor_destroy_external(&executor);
  return 0;
}`, "");
}, 240_000);

test("preserves imported TaskScope aliases in native worker captures", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-native-worker-alias-");
  try {
    const input = resolve(directory, "main.zs");
    const source = readFileSync(fixture, "utf8")
      .replace('"./async-worker-scope.h"', JSON.stringify(resolve(projectRoot, "tests/fixtures/async-worker-scope.h")))
      .replace("{ TaskScope, scheduler }", "{ TaskScope as WorkScope, scheduler }")
      .replaceAll("updates: TaskScope", "updates: WorkScope")
      .replace("new TaskScope()", "new WorkScope()");
    writeFileSync(input, source);
    const parity = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL",
    });
    assert.equal(parity.status, 0, parity.stderr || String(parity.error));
    execute(emit(input), expected);
    execute(compileToC(source, input), expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("joins nested yielding worker children and their owned resources on cancellation", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-native-worker-child-");
  try {
    const input = resolve(directory, "main.zs");
    const source = readFileSync(fixture, "utf8")
      .replace('"./async-worker-scope.h"', JSON.stringify(resolve(projectRoot, "tests/fixtures/async-worker-scope.h")))
      .replace('import probe', 'import console from "std/console";\nimport probe')
      .replaceAll("await listen(updates,", "await outerListen(updates,")
      .replace("async function main()", `
struct OuterResource { deinit { console.log("released outer"); } }
async function outerListen(updates: TaskScope, limit: i32): i32 {
  const resource = OuterResource();
  const owned = "outer worker frame";
  await scheduler.yield();
  const value = await listen(updates, limit);
  if (owned.byteLength == 0) return 0;
  return value;
}
async function main()`);
    writeFileSync(input, source);
    execute(emit(input), "released outer\nreleased outer\n" + expected, 5);
    execute(compileToC(source, input), "released outer\nreleased outer\n" + expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("drains scope work and releases every worker handle after completion, cancellation, or rejection", () => {
  if (process.platform !== "darwin") return;
  const source = fixtureEmission();
  const helpers = [...source.matchAll(/static int32_t (z_stage1_thread_spawn_main_\d+)_body\(/g)].map((match) => match[1]);
  assert.equal(helpers.length, 2);
  execute(`#define main z_fixture_main\n${source}\n#undef main
#include <CoreFoundation/CoreFoundation.h>
int main(void) {
  initialize();
  for (int repeat = 0; repeat < 20; ++repeat) {
    for (int phase = 0; phase < 3; ++phase) {
      entered_count = released_count = published_count = 0;
      Z_TaskScope *scope = z_stage1_task_scope_new(NULL);
      if (phase == 2) z_stage1_task_scope_join(scope, false);
      Z_Task_i32 task = phase == 1 ? ${helpers[1]}(scope) : ${helpers[0]}(scope);
      if (phase == 1) {
        wait_for_entry();
        Z_Task_i32_cancel(&task);
      } else {
        int32_t value = Z_Task_i32_await(&task);
        if (value != (phase == 0 ? 2 : 0)) return 1;
        Z_Task_i32_deinit(&task);
      }
      if (released_count != 1) return 2;
      z_stage1_task_scope_join(scope, phase == 1);
      for (int tick = 0; scope->refcount != 1 && tick < 20; ++tick)
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.001, true);
      if (scope->refcount != 1 || scope->pending != 0 || scope->external_head != NULL) return 3;
      if (published_count != (phase == 0 ? 1 : 0)) return 4;
      if (scope->local_executor.head != NULL || scope->local_executor.tail != NULL) return 5;
      Z_TaskScope_release(scope);
    }
  }
  return 0;
}`, "");
}, 240_000);

test("transfers owned captures into a void yielding native worker child", () => {
  const directory = mkdtempSync("/tmp/z-native-worker-result-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
import { scheduler } from "std/async";
import { thread } from "std/thread";
async function echo(input: String): void {
  await scheduler.yield();
  console.log(input);
}
async function main(): i32 {
  const input = "worker result";
  const worker = thread.spawn(async move (): void => await echo(move input));
  await worker;
  return 0;
}`;
    writeFileSync(input, source);
    execute(emit(input), "worker result\n");
    execute(compileToC(source, input), "worker result\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("rejects TaskScope worker shapes that cannot yet propagate child cancellation", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-native-worker-boundary-");
  try {
    const input = resolve(directory, "main.zs");
    const source = readFileSync(fixture, "utf8")
      .replace('"./async-worker-scope.h"', JSON.stringify(resolve(projectRoot, "tests/fixtures/async-worker-scope.h")))
      .replace("return await listen(updates, 2147483647);", "const result = await listen(updates, 2147483647);\n    return result;");
    writeFileSync(input, source);
    const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /terminal await of a named nonthrowing yielding function/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
