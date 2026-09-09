import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/async-linear-tail.zs");
let cached: string | undefined;
function emit(): string {
  if (cached !== undefined) return cached;
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", fixture], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  return cached = emitted.stdout;
}

function execute(source: string, expected?: string): string {
  const directory = mkdtempSync("/tmp/z-linear-tail-");
  try {
    const binary = resolve(directory, "program");
    const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary,
      ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : ["-pthread"])],
      { input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    if (expected !== undefined) assert.equal(result.stdout, expected);
    return result.stdout;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

let cachedScopeSource: string | undefined;
function emitScopeJoin(): string {
  if (cachedScopeSource !== undefined) return cachedScopeSource;
  const input = resolve(projectRoot, "tests/fixtures/async-linear-scope-join.zs");
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  return cachedScopeSource = emitted.stdout;
}

let cachedOwnedScopeSource: string | undefined;
function emitOwnedScope(): string {
  if (cachedOwnedScopeSource !== undefined) return cachedOwnedScopeSource;
  const input = resolve(projectRoot, "tests/fixtures/async-linear-owned-scope.zs");
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  return cachedOwnedScopeSource = emitted.stdout;
}

let cachedThreadSource: string | undefined;
function emitThreadJoin(): string {
  if (cachedThreadSource !== undefined) return cachedThreadSource;
  const input = resolve(projectRoot, "tests/fixtures/async-linear-thread-join.zs");
  const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
  return cachedThreadSource = emitted.stdout;
}

test("joins native worker cancellation after an owned result without cancelling its parent", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-linear-thread-join.zs");
  const expected = "released parent\nreleased continuation\nreleased parent\n".repeat(2);
  execute(compileToC(readFileSync(input, "utf8"), input), expected);
  const source = emitThreadJoin();
  assert.match(source, /frame->child = z_stage1_async_thread_join_Task_String_start/);
  execute(source, expected);
}, 240_000);

test("drains native workers before frame owners on cancellation, early exit, and active destruction", () => {
  let source = emitThreadJoin();
  const start = source.match(/static Z_AsyncInvocation (\w+_start)\(void \*context, Z_AsyncExecutor \*executor, bool argument0, bool argument1, Z_Message argument2\)/)?.[1];
  assert.ok(start, "startup frame retains owned input and native worker");
  for (const anchor of ["storage->finished = true;", "free(task->storage);",
    "storage->owner_thread = pthread_self();", "void Z_Guard_deinit(Z_Guard *self) {"]) {
    assert.ok(source.includes(anchor), anchor);
  }
  source = source
    .replace("storage->owner_thread = pthread_self();", "$& ++createdWorkers; atomic_fetch_add(&activeWorkers, 1);")
    .replace("storage->finished = true;", "atomic_fetch_sub(&activeWorkers, 1); $&")
    .replace("free(task->storage);", "++joinedWorkers; $&")
    .replace("void Z_Guard_deinit(Z_Guard *self) {",
      "$& if (atomic_load(&activeWorkers) != 0 || createdWorkers != joinedWorkers) abort(); ++guardDrops;")
    .replace("void Z_Message_deinit(Z_Message *self) {", "$& ++messageDrops;")
    .replace("void Z_Failure_deinit(Z_Failure *self) {", "$& ++errorDrops;");
  execute(`#include <stdatomic.h>
static _Atomic int activeWorkers;
static int createdWorkers, joinedWorkers, guardDrops, messageDrops, errorDrops;
#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  for (int mode = 0; mode < 3; ++mode) {
    for (int early = 0; early <= 1; ++early) {
      for (int fail = 0; fail <= 1; ++fail) {
        for (int steps = 0; steps <= 24; ++steps) {
          Z_AsyncExecutor executor = {0};
          z_stage1_async_executor_init_external(&executor);
          createdWorkers = joinedWorkers = guardDrops = messageDrops = errorDrops = 0;
          Z_AsyncInvocation parent = ${start}(NULL, &executor, early, fail,
            (Z_Message){ .text = Z_STRING_LITERAL("owned") });
          if (mode != 0 || steps != 0) z_stage1_async_enqueue(&executor, parent.task);
          for (int step = 0; step < steps && !parent.task->completed; ++step) {
            if (!z_stage1_async_drive_one(&executor)) return 1;
          }
          if (mode == 2) {
            const bool alreadyCompleted = parent.task->completed;
            z_stage1_async_request_cancel(parent.task);
            for (int tick = 0; !parent.task->completed; ++tick)
              if (tick > 80 || !z_stage1_async_drive_one(&executor)) return 2;
            if (!alreadyCompleted && !parent.task->cancelled) return 3;
          }
          parent.destroy(parent.task);
          if (atomic_load(&activeWorkers) != 0 || createdWorkers != joinedWorkers
            || createdWorkers != (steps == 0 ? 0 : 1)
            || guardDrops < (steps == 0 ? 0 : 1)
            || messageDrops != (steps == 0 ? 1 : 2) || errorDrops > fail) {
            fprintf(stderr, "mode=%d early=%d fail=%d steps=%d workers=%d/%d guards=%d messages=%d errors=%d\\n",
              mode, early, fail, steps, createdWorkers, joinedWorkers, guardDrops, messageDrops, errorDrops);
            return 4;
          }
          if (executor.head != NULL || executor.tail != NULL) return 5;
          z_stage1_async_executor_destroy_external(&executor);
        }
      }
    }
  }
  return 0;
}`);
}, 240_000);

test("composes native-thread joins independently of TaskScope and through main-bound methods", () => {
  const directory = mkdtempSync("/tmp/z-linear-worker-shapes-");
  try {
    const input = resolve(directory, "main.zs");
    const fixtureSource = readFileSync(resolve(projectRoot, "tests/fixtures/async-linear-thread-join.zs"), "utf8");
    const withoutScope = fixtureSource.replace(", TaskScope", "")
      .replace("  const updates = new TaskScope();\n", "")
      .replace("  await updates.cancel();\n", "");
    const mainMethod = withoutScope.replace("thread as threads", "thread").replaceAll("threads.spawn", "thread.spawn")
      .replace("async function startup(", "readonly class Reader {\nasync function startup(")
      .replace("input: Message): Message throws Failure {\n  const before", "input: Message): Message throws Failure on thread.main {\n  const before")
      .replace("\nfunction inspect(", "\n}\nfunction inspect(")
      .replace("async function main(): i32 {", "async function main(): i32 on thread.main {\n  const reader = new Reader({});")
      .replaceAll("attempt await startup(", "attempt await reader.startup(");
    const mainHop = withoutScope.replace("thread as threads", "thread").replaceAll("threads.spawn", "thread.spawn")
      .replace("async function startup(", "function publish(value: String): String on thread.main { return value; }\nasync function startup(")
      .replace("async (): String => await listen()", "async (): String => await on thread.main publish(\"worker result\")")
      .replace("input: Message): Message throws Failure {\n  const before", "input: Message): Message throws Failure on thread.main {\n  const before")
      .replace("async function main(): i32 {", "async function main(): i32 on thread.main {");
    const expected = "released parent\nreleased continuation\nreleased parent\n".repeat(2);
    for (const source of [withoutScope, mainMethod, ...(process.platform === "darwin" ? [mainHop] : [])]) {
      execute(compileToC(source, input), expected);
      writeFileSync(input, source);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
      execute(emitted.stdout, expected);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps a cold or externally waiting native join alive until worker completion", () => {
  let source = emitThreadJoin();
  const helper = source.match(/static Z_Task_String (z_stage1_thread_spawn_startup_\d+)\(void\);/)?.[1];
  assert.ok(helper);
  const body = `static Z_String ${helper}_body(Z_Task_StringStorage *_z_stage1_task_storage) {`;
  assert.ok(source.includes(body));
  source = source.replace(body, `${body}
    while (!Z_Task_String_is_cancellation_requested(_z_stage1_task_storage)) {
      struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }`);
  execute(`#include <time.h>
#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  for (int mode = 0; mode < 2; ++mode) {
    for (int run = 0; run < 32; ++run) {
      Z_AsyncExecutor executor = {0};
      z_stage1_async_executor_init_external(&executor);
      Z_Task_String worker = ${helper}();
      Z_AsyncInvocation join = z_stage1_async_thread_await_Task_String_start(&executor, &worker);
      if (mode != 0) {
        z_stage1_async_enqueue(&executor, join.task);
        if (!z_stage1_async_run_one(&executor) || !join.task->external_completion) return 1;
      }
      join.destroy(join.task);
      Z_Task_String_deinit(&worker);
      if (executor.head != NULL || executor.tail != NULL) return 2;
      z_stage1_async_executor_destroy_external(&executor);
    }
  }
  return 0;
}`, "");
}, 240_000);

test("implicitly joins continuation-owned scopes on return and propagated error", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-linear-owned-scope.zs");
  const expected = "released parent\n".repeat(4);
  execute(compileToC(readFileSync(input, "utf8"), input), expected);
  const source = emitOwnedScope();
  assert.match(source, /_z_scope_unwind:/);
  assert.match(source, /Z_TaskScope_retain\(.*_z_stage1_frame_binding_/);
  execute(source, expected);
}, 240_000);

test("cancels and drains locally owned scopes before releasing the parent at every suspension", () => {
  let source = emitOwnedScope();
  const start = source.match(/static Z_AsyncInvocation (\w+_start)\(void \*context, Z_AsyncExecutor \*executor, bool argument0, bool argument1, Z_Message argument2\)/)?.[1];
  assert.ok(start, "startup frame with owned input and two local scopes");
  source = source
    .replace("scope->refcount = 1;", "scope->refcount = 1; ++createdScopes;")
    .replace("free(scope);", "++releasedScopes; free(scope);")
    .replace("scope->pending += 1;", "scope->pending += 1; ++activeJobs;")
    .replace("scope->pending -= 1;", "scope->pending -= 1; --activeJobs; ++finishedJobs;")
    .replace("void Z_Guard_deinit(Z_Guard *self) {", "void Z_Guard_deinit(Z_Guard *self) { if (activeJobs != 0) abort(); ++guardDrops;")
    .replace("void Z_Message_deinit(Z_Message *self) {", "void Z_Message_deinit(Z_Message *self) { ++messageDrops;")
    .replace("void Z_Failure_deinit(Z_Failure *self) {", "void Z_Failure_deinit(Z_Failure *self) { ++errorDrops;");
  execute(`static int createdScopes, releasedScopes, activeJobs, finishedJobs, guardDrops, messageDrops, errorDrops;
#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  for (int mode = 0; mode < 3; ++mode) {
    for (int early = 0; early <= 1; ++early) {
      for (int fail = 0; fail <= 1; ++fail) {
        for (int steps = 0; steps <= 40; ++steps) {
          Z_AsyncExecutor executor = {0};
          createdScopes = releasedScopes = activeJobs = finishedJobs = guardDrops = messageDrops = errorDrops = 0;
          Z_AsyncInvocation parent = ${start}(NULL, &executor, early, fail,
            (Z_Message){ .text = Z_STRING_LITERAL("owned") });
          if (mode != 0 || steps != 0) z_stage1_async_enqueue(&executor, parent.task);
          for (int step = 0; step < steps && !parent.task->completed; ++step) {
            if (!z_stage1_async_run_one(&executor)) break;
          }
          if (mode == 2) {
            const bool alreadyCompleted = parent.task->completed;
            z_stage1_async_request_cancel(parent.task);
            for (int tick = 0; !parent.task->completed; ++tick)
              if (tick > 80 || !z_stage1_async_drive_one(&executor)) return 1;
            if (!alreadyCompleted && !parent.task->cancelled) return 2;
          }
          // Both cold and active destruction must drain the same unwind path.
          parent.destroy(parent.task);
          if (activeJobs != 0 || createdScopes != releasedScopes
            || finishedJobs != createdScopes || guardDrops != (steps == 0 ? 0 : 1)) {
            fprintf(stderr, "mode=%d early=%d fail=%d steps=%d created=%d released=%d jobs=%d finished=%d guards=%d\\n",
              mode, early, fail, steps, createdScopes, releasedScopes, activeJobs, finishedJobs, guardDrops);
            return 3;
          }
          if (messageDrops != (steps == 0 ? 1 : 2) || errorDrops > fail) return 4;
          if (executor.head != NULL || executor.tail != NULL || executor.timers != NULL) return 5;
        }
      }
    }
  }
  return 0;
}`);
}, 240_000);

test("native re-entry schedules scope work while an outer Z poll is inside a host call", () => {
  let source = emitOwnedScope();
  const implementation = /static int32_t (__z_c_impl_\w*nativeEcho)\(int32_t value\) \{/;
  assert.match(source, implementation);
  source = source.replace(implementation, "$& if (z_stage1_current_executor != NULL) abort(); boundaryHook();");
  execute(`static void (*boundaryHook)(void);
#define main z_fixture_main\n${source}\n#undef main
static int finished;
static Z_TaskScope *scope;
static Z_TaskControl *callbackControl;
static void test_poll(Z_AsyncTask *task) { ++finished; task->completed = true; }
static void test_destroy(Z_AsyncTask *task) { if (!task->completed) abort(); free(task); }
static Z_AsyncInvocation test_start(void *context, Z_AsyncExecutor *executor) {
  (void)context;
  Z_AsyncTask *task = calloc(1, sizeof(*task));
  task->poll = test_poll; task->executor = executor;
  return (Z_AsyncInvocation){ .task = task, .destroy = test_destroy };
}
static void native_callback(void) {
  callbackControl = z_stage1_task_scope_spawn_async(scope, test_start, NULL, NULL);
}
int main(void) {
  Z_AsyncExecutor executor = {0};
  scope = z_stage1_task_scope_new(&executor);
  boundaryHook = native_callback;
  z_stage1_current_executor = &executor;
  Z_TaskControl *direct = z_stage1_task_scope_spawn_async(scope, test_start, NULL, NULL);
  if (finished != 0) return 1; // Normal polling admits work without recursion.
  if (nativeEcho(42) != 42 || finished != 2) return 2;
  if (z_stage1_current_executor != &executor) return 3; // Native entry restored it.
  z_stage1_current_executor = NULL;
  z_stage1_task_scope_join(scope, false);
  Z_TaskControl_release(direct); Z_TaskControl_release(callbackControl);
  if (scope->refcount != 1 || executor.head != NULL || executor.timers != NULL) return 4;
  Z_TaskScope_release(scope);
  return 0;
}`);
}, 240_000);

test("preserves owned success and failure through sequential TaskScope joins", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-linear-scope-join.zs");
  const expected = "released parent\n" + ("before close\nbetween joins\nafter cancel\n"
    + "released continuation\nreleased parent\n").repeat(2);
  execute(compileToC(readFileSync(input, "utf8"), input), expected);
  const source = emitScopeJoin();
  assert.match(source, /frame->child = z_stage1_task_scope_join_start/);
  execute(source, expected);
}, 240_000);

test("TaskScope join waiters suspend, fan out, cancel, and retain their scope through destruction", () => {
  let source = emitScopeJoin();
  const start = source.match(/static Z_AsyncInvocation (\w+_start)\(void \*context, Z_AsyncExecutor \*executor, bool argument0, bool argument1, Z_Message argument2, Z_TaskScope \* argument3\)/)?.[1];
  assert.ok(start, "owned startup with a TaskScope parameter");
  source = source.replace("void Z_Message_deinit(Z_Message *self) {", "void Z_Message_deinit(Z_Message *self) { ++messageDrops;")
    .replace("void Z_Failure_deinit(Z_Failure *self) {", "void Z_Failure_deinit(Z_Failure *self) { ++errorDrops;")
    .replace("void Z_Guard_deinit(Z_Guard *self) {", "void Z_Guard_deinit(Z_Guard *self) { if (joining && finished != 1) abort();");
  const output = execute(`static int messageDrops, errorDrops, finished;\nstatic _Bool joining;
#define main z_fixture_main\n${source}\n#undef main
static int destroyed, released;
typedef struct TestChild { Z_AsyncTask task; bool entered; } TestChild;
static TestChild *active;
static void test_poll(Z_AsyncTask *task) {
  TestChild *child = (TestChild *)task;
  if (!child->entered) { child->entered = true; return; }
  ++finished;
  task->cancelled = task->cancellation_requested;
  task->completed = true;
}
static void test_cancel(Z_AsyncTask *task) {
  if (!task->queued) z_stage1_async_enqueue(task->executor, task);
}
static void test_destroy(Z_AsyncTask *task) {
  if (!task->completed) abort();
  ++destroyed; active = NULL; free(task);
}
static void test_release(void *context) { if (context != &released) abort(); ++released; }
static Z_AsyncInvocation test_start(void *context, Z_AsyncExecutor *executor) {
  if (context != &released) abort();
  active = calloc(1, sizeof(*active));
  active->task.poll = test_poll; active->task.request_cancel = test_cancel;
  active->task.executor = executor;
  return (Z_AsyncInvocation){ .task = &active->task, .destroy = test_destroy };
}
int main(void) {
  for (int mode = 0; mode < 6; ++mode) {
    Z_AsyncExecutor executor = {0};
    Z_TaskScope *scope = z_stage1_task_scope_new(mode == 5 ? NULL : &executor);
    finished = destroyed = released = 0;
    Z_TaskControl *control = z_stage1_task_scope_spawn_async(scope, test_start, &released, test_release);
    if (!control->accepted || scope->pending != 1 || active == NULL) return 1;
    Z_AsyncInvocation first = z_stage1_task_scope_join_start(scope, mode == 1 || mode == 5, &executor);
    if (mode == 3) {
      // Cold destruction must close admission and join admitted work too.
      first.destroy(first.task);
    } else {
      z_stage1_async_enqueue(&executor, first.task);
      if (!z_stage1_async_run_one(&executor)) return 2;
      if (mode != 1 && mode != 5 && (first.task->completed || scope->join_waiters == NULL)) return 3;
      if (mode == 0) {
        // A second waiter must not overwrite the first one.
        Z_AsyncInvocation second = z_stage1_task_scope_join_start(scope, false, &executor);
        z_stage1_async_enqueue(&executor, second.task);
        if (!z_stage1_async_run_one(&executor)) return 4;
        if (z_stage1_async_run_one(&executor)) return 5; // no busy polling
        z_stage1_async_enqueue(&executor, &active->task);
        for (int ticks = 0; !first.task->completed || !second.task->completed; ++ticks)
          if (ticks > 12 || !z_stage1_async_run_one(&executor)) return 6;
        second.destroy(second.task);
      } else if (mode == 2) {
        z_stage1_async_request_cancel(first.task);
      }
      if (mode != 4) {
        for (int ticks = 0; !first.task->completed; ++ticks)
          if (ticks > 12 || !z_stage1_async_run_one(&executor)) return 7;
        if (mode == 2 && !first.task->cancelled) return 8;
      }
      // Mode 4 drops the active waiter while its child is still suspended.
      first.destroy(first.task);
    }
    if (finished != 1 || destroyed != 1 || released != 1 || scope->pending != 0
      || scope->join_waiters != NULL || scope->jobs != NULL || !scope->closing) return 9;
    Z_TaskControl *rejected = z_stage1_task_scope_spawn_async(scope, test_start, &released, test_release);
    if (rejected->accepted || released != 2) return 10;
    Z_TaskControl_release(rejected);
    Z_TaskControl_release(control);
    if (scope->refcount != 1) return 11;
    Z_TaskScope_release(scope);
    if (executor.head != NULL || executor.tail != NULL) return 12;
  }
  for (int fail = 0; fail <= 1; ++fail) {
    for (int steps = 0; steps <= 18; ++steps) {
      Z_AsyncExecutor executor = {0};
      Z_TaskScope *scope = z_stage1_task_scope_new(&executor);
      finished = destroyed = released = messageDrops = errorDrops = 0;
      joining = false;
      Z_TaskControl *control = z_stage1_task_scope_spawn_async(scope, test_start, &released, test_release);
      Z_AsyncInvocation parent = ${start}(NULL, &executor, false, fail,
        (Z_Message){ .text = Z_STRING_LITERAL("owned") }, Z_TaskScope_retain(scope));
      z_stage1_async_enqueue(&executor, parent.task);
      for (int tick = 0; tick < steps && !parent.task->completed; ++tick) {
        if (!z_stage1_async_run_one(&executor)) break;
      }
      joining = scope->join_waiters != NULL;
      z_stage1_async_request_cancel(parent.task);
      for (int tick = 0; !parent.task->completed; ++tick)
        if (tick > 40 || !z_stage1_async_drive_one(&executor)) return 13;
      if (!parent.task->cancelled) return 14;
      parent.destroy(parent.task);
      // Cancellation before the join was reached does not close a passed-in
      // scope. The caller still owns it and must finish its independent jobs.
      if (scope->pending != 0) z_stage1_task_scope_join(scope, true);
      Z_TaskControl_release(control);
      if (messageDrops != (steps == 0 ? 1 : 2) || errorDrops > fail
        || finished != 1 || destroyed != 1 || released != 1 || scope->refcount != 1
        || scope->join_waiters != NULL || executor.head != NULL || executor.tail != NULL) return 15;
      Z_TaskScope_release(scope);
    }
  }
  // A naturally completing pending scope resumes the actual Z continuation,
  // without recomputing the owned Result or its side effects.
  for (int fail = 0; fail <= 1; ++fail) {
    Z_AsyncExecutor executor = {0};
    Z_TaskScope *scope = z_stage1_task_scope_new(&executor);
    finished = destroyed = released = messageDrops = errorDrops = 0;
    joining = false;
    Z_TaskControl *control = z_stage1_task_scope_spawn_async(scope, test_start, &released, test_release);
    Z_AsyncInvocation parent = ${start}(NULL, &executor, false, fail,
      (Z_Message){ .text = Z_STRING_LITERAL("owned") }, Z_TaskScope_retain(scope));
    z_stage1_async_enqueue(&executor, parent.task);
    for (int tick = 0; z_stage1_async_run_one(&executor); ++tick) if (tick > 30) return 16;
    if (parent.task->completed || scope->join_waiters == NULL || active == NULL) return 17;
    joining = true;
    z_stage1_async_enqueue(&executor, &active->task);
    for (int tick = 0; !parent.task->completed; ++tick)
      if (tick > 30 || !z_stage1_async_run_one(&executor)) return 18;
    if (parent.task->cancelled) return 19;
    parent.destroy(parent.task);
    Z_TaskControl_release(control);
    if (messageDrops != 2 || errorDrops != fail || finished != 1 || destroyed != 1
      || scope->refcount != 1 || executor.head != NULL || executor.tail != NULL) return 20;
    Z_TaskScope_release(scope);
  }
  return 0;
}`);
  assert.equal(output.match(/between joins/g)?.length, 2);
  assert.equal(output.match(/after cancel/g)?.length, 2);
}, 240_000);

test("composes early awaited returns with an owned awaited-local continuation", () => {
  const expected = "released before\nreleased later\nreleased before\n".repeat(4);
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit();
  assert.match(source, /frame->_z_resume_state = 3/);
  assert.match(source, /frame->_z_resume_state == 3/);
  execute(source, expected);
}, 240_000);

test("keeps broader continuation shapes explicit instead of reporting a timer error", () => {
  const directory = mkdtempSync("/tmp/z-linear-tail-boundary-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import { thread } from "std/thread";
async function operation(): i32 { return 0; }
async function startup(early: boolean): i32 on thread.main {
  if (early) return await operation();
  const first = await operation();
  const second = await operation();
  return first + second;
}
async function main(): i32 on thread.main { return await startup(false); }`;
    compileToC(source, input);
    writeFileSync(input, source);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(emitted.status, 0);
    assert.match(emitted.stderr, /Z0700.*early terminal awaits followed by one awaited local/);
    assert.doesNotMatch(emitted.stderr, /await delay|unnamed.*Task/);
    const ownedScope = `import { TaskScope as Scope } from "std/async";
import { thread } from "std/thread";
async function operation(): i32 { return 0; }
async function startup(early: boolean): i32 on thread.main {
  const updates = new Scope();
  if (early) return await operation();
  const outcome = await operation();
  await updates.cancel();
  return outcome;
}
async function main(): i32 on thread.main { return await startup(false); }`;
    compileToC(ownedScope, input);
    writeFileSync(input, ownedScope);
    const safeUnwind = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(safeUnwind.status, 0, safeUnwind.stderr);
    execute(safeUnwind.stdout);
    const nestedScope = ownedScope.replace(
      "const updates = new Scope();",
      "const updates = early ? new Scope() : new Scope();",
    );
    compileToC(nestedScope, input);
    writeFileSync(input, nestedScope);
    const rejectedScope = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(rejectedScope.status, 0);
    assert.match(rejectedScope.stderr, /Z0700.*nested TaskScope constructor.*root-local/);
    for (const method of ["close", "cancel"]) {
      const ordinaryReceiver = `import { thread } from "std/thread";
readonly class Other { async function ${method}(): void {} }
async function operation(): i32 { return 0; }
async function startup(early: boolean, other: Other): i32 on thread.main {
  if (early) return await operation();
  const value = await operation();
  await other.${method}();
  return value;
}
async function main(): i32 on thread.main { return await startup(false, new Other({})); }`;
      compileToC(ordinaryReceiver, input);
      writeFileSync(input, ordinaryReceiver);
      const rejected = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Z0700.*broader continuation frame/);
    }
    const nested = `import { thread } from "std/thread";
struct Request { text: String; }
async function read(in request: Request): i32 { return i32(request.text.byteLength); }
async function startup(early: boolean): i32 on thread.main {
  if (early) {
    const request = Request({ text: "nested" });
    return await read(in request);
  }
  const request = Request({ text: "root" });
  const value = await read(in request);
  return value;
}
async function main(): i32 on thread.main { return await startup(false); }`;
    assert.throws(() => compileToC(nested, input), /conditional-local binding needs lexical frame cleanup states/);
    writeFileSync(input, nested);
    const rejected = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Z0700.*broader continuation frame/);
    // Main-bound throwing methods already admit ordinary two-await bodies.
    // The early-return diagnostic must not reject this existing path.
    const ordinary = `import { thread } from "std/thread";
struct Failure { code: i32; }
async function operation(): i32 throws Failure { return 0; }
readonly class Importer {
  async function read(): i32 throws Failure on thread.main {
    const first = attempt await operation();
    const second = attempt await operation();
    return match (second) { success(value) => value; failure(error) => throw error; };
  }
}
async function main(): i32 throws Failure on thread.main {
  const importer = new Importer({});
  return try await importer.read();
}`;
    execute(compileToC(ordinary, input), "");
    writeFileSync(input, ordinary);
    const accepted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    execute(accepted.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("joins early and continued children before releasing frame owners", () => {
  let source = emit();
  const start = source.match(/static Z_AsyncInvocation (\w+_start)\(void \*context, Z_AsyncExecutor \*executor, bool argument0, bool argument1, Z_Message argument2\)/)?.[1];
  assert.ok(start, "owned startup invocation");
  const messageDeinit = "void Z_Message_deinit(Z_Message *self) {";
  const errorDeinit = "void Z_Failure_deinit(Z_Failure *self) {";
  assert.ok(source.includes(messageDeinit));
  assert.ok(source.includes(errorDeinit));
  source = source.replace(messageDeinit, `${messageDeinit}\n  ++messageDrops;`)
    .replace(errorDeinit, `${errorDeinit}\n  ++errorDrops;`);
  source = `static int messageDrops, errorDrops;\n#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  for (int early = 0; early <= 1; ++early) {
    for (int fail = 0; fail <= 1; ++fail) {
      // Cold drop, pre-entry cancellation, child creation, child suspension,
      // child completion, parent resumption, and completed-result destruction.
      for (int steps = -1; steps <= 12; ++steps) {
        messageDrops = 0;
        errorDrops = 0;
        Z_AsyncInvocation parent = ${start}(NULL, &executor, early, fail,
          (Z_Message){ .text = Z_STRING_LITERAL("owned") });
        if (steps >= 0) {
          z_stage1_async_enqueue(&executor, parent.task);
          for (int step = 0; step < steps && !parent.task->completed; ++step) {
            if (!z_stage1_async_drive_one(&executor)) return 1;
          }
          z_stage1_async_request_cancel(parent.task);
          for (int tick = 0; !parent.task->completed; ++tick) {
            if (tick > 20 || !z_stage1_async_drive_one(&executor)) return 2;
          }
        }
        parent.destroy(parent.task);
        if (executor.head != NULL || executor.tail != NULL) return 3;
        if (messageDrops != (steps > 0 ? 2 : 1)) return 4;
        if (errorDrops > fail || (steps >= 12 && errorDrops != fail)) return 5;
      }
      // Dropping an active frame invokes its cancel/join path too.
      for (int steps = 1; steps <= 4; ++steps) {
        messageDrops = 0;
        Z_AsyncInvocation parent = ${start}(NULL, &executor, early, fail,
          (Z_Message){ .text = Z_STRING_LITERAL("owned") });
        z_stage1_async_enqueue(&executor, parent.task);
        for (int step = 0; step < steps; ++step) {
          if (!z_stage1_async_drive_one(&executor)) return 6;
        }
        parent.destroy(parent.task);
        if (executor.head != NULL || executor.tail != NULL || messageDrops != 2) return 7;
      }
    }
  }
  return 0;
}`;
  execute(source, "released later\nreleased before\n".repeat(32)
    + "released before\n".repeat(32));
}, 240_000);
