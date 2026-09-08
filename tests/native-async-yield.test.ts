import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/self-host-emit-async-yield-frame.zs");
const parameterFixture = resolve(projectRoot, "tests/fixtures/self-host-emit-async-yield-parameters.zs");
let cachedEmission: string | undefined;
let cachedParameterEmission: string | undefined;
function emit(input: string): string {
  const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
function fixtureEmission(): string { return cachedEmission ??= emit(fixture); }
function parameterEmission(): string { return cachedParameterEmission ??= emit(parameterFixture); }
function nativeYieldStart(source: string, name: string): string {
  // Imported headers can require private bridge mangling. Harnesses inspect
  // generated storage, but must not treat its module-qualified name as an ABI.
  const frame = new RegExp(`typedef struct (_z_stage1_yield_(?:__z_module_\\d+_)?${name}) \\{`).exec(source)?.[1];
  assert.ok(frame, `Missing frame for ${name}`);
  return `${frame}_start`;
}
function execute(source: string, expected: string, flags: string[] = []): void {
  const directory = mkdtempSync("/tmp/z-native-yield-frame-");
  try {
    const executable = resolve(directory, "program");
    const compilation = spawnSync("clang", [
      "-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", ...flags, "-", "-o", executable,
    ], { encoding: "utf8", input: source, timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compilation.status, 0, compilation.stderr || String(compilation.error));
    const run = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 0, run.stderr || String(run.error ?? run.signal));
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("runs native yield frames with branches, loop control, and destructured ownership", () => {
  const expected = "prepared delivery\nreleased discarded\nselected\nreleased selected\n";
  const source = fixtureEmission();
  assert.match(source, /case \d+: goto _z_resume_/);
  assert.match(source, /z_stage1_async_enqueue\(task->executor, task\)/);
  // A field transfer must not disarm the entire source temporary.
  assert.doesNotMatch(source, /live__z_destructure_\d+ = false, [^\n]*\.selected/);
  execute(source, expected);
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  for (const name of ["async-launch-listener.zs", "async-launch-owned-destructure.zs"]) {
    execute(emit(resolve(projectRoot, "tests/fixtures", name)), "");
  }
}, 240_000);

test("retains TaskScope and TaskControl handles across native yields and cancellation", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-yield-scope.zs");
  const source = emit(input);
  const flags = ["-pthread", "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all",
    ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : [])];
  execute(compileToC(readFileSync(input, "utf8"), input), "wake on main\nwake on main\n", flags);
  execute(source, "wake on main\nwake on main\n", flags);
  execute(`#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  for (int phase = 0; phase < 3; ++phase) {
    Z_TaskScope *scope = z_stage1_task_scope_new(NULL);
    Z_AsyncInvocation invocation = ${nativeYieldStart(source, "listen")}(&executor, Z_TaskScope_retain(scope), 2);
    if (scope->refcount != 2) return 1;
    if (phase != 0) {
      z_stage1_async_enqueue(&executor, invocation.task);
      if (phase == 2 && !z_stage1_async_drive_one(&executor)) return 2;
      z_stage1_async_request_cancel(invocation.task);
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 3;
    }
    invocation.destroy(invocation.task);
    if (scope->refcount != 1 || executor.head != NULL) return 4;
    z_stage1_task_scope_join(scope, true);
    Z_TaskScope_release(scope);

    Z_TaskControl *control = z_stage1_task_control_new(true);
    invocation = ${nativeYieldStart(source, "holdControl")}(&executor, Z_TaskControl_retain(control));
    if (control->refcount != 2) return 5;
    if (phase != 0) {
      z_stage1_async_enqueue(&executor, invocation.task);
      if (phase == 2 && !z_stage1_async_drive_one(&executor)) return 6;
      z_stage1_async_request_cancel(invocation.task);
      if (!z_stage1_async_drive_one(&executor) || !invocation.task->cancelled) return 7;
    }
    invocation.destroy(invocation.task);
    if (control->refcount != 1 || executor.head != NULL) return 8;
    Z_TaskControl_release(control);
  }
  return 0;
}`, "wake on main\n", flags);
}, 240_000);

test("joins main-bound wakeups queued by a yielding native worker frame", () => {
  if (process.platform !== "darwin") return;
  const source = emit(resolve(projectRoot, "tests/fixtures/async-yield-scope.zs"));
  execute(`#define main z_fixture_main\n${source}\n#undef main
#include <CoreFoundation/CoreFoundation.h>
typedef struct { Z_TaskScope *scope; int cancel; int status; } Probe;
static int callable_releases;
static Z_AsyncInvocation must_not_start(void *context, Z_AsyncExecutor *executor) {
  (void)context; (void)executor;
  abort();
}
static void release_probe(void *context) { free(context); callable_releases += 1; }
static void *queue_cancelled_or_rejected(void *context) {
  Probe *probe = context;
  void *owned = malloc(1);
  if (owned == NULL) abort();
  Z_TaskControl *control = z_stage1_task_scope_spawn_async(probe->scope, must_not_start, owned, release_probe);
  if (control->accepted == probe->scope->closing) abort();
  Z_TaskControl_release(control);
  return NULL;
}
static void *run_listener(void *context) {
  Probe *probe = context;
  if (pthread_main_np() != 0) abort();
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation invocation = ${nativeYieldStart(source, "listen")}(&executor, Z_TaskScope_retain(probe->scope), 2);
  z_stage1_async_enqueue(&executor, invocation.task);
  for (int tick = 0; !invocation.task->completed; ++tick) {
    if (tick > 4 || !z_stage1_async_drive_one(&executor)) abort();
    if (probe->cancel) z_stage1_async_request_cancel(invocation.task);
  }
  if (probe->cancel) { if (!invocation.task->cancelled) abort(); }
  else { int result = 0; invocation.take_result(invocation.task, &result); if (result != 2) abort(); }
  invocation.destroy(invocation.task);
  if (executor.head != NULL || executor.tail != NULL) abort();
  probe->status = 1;
  return NULL;
}
int main(void) {
  for (int cancel = 0; cancel < 2; ++cancel) {
    Z_TaskScope *scope = z_stage1_task_scope_new(NULL);
    Probe probe = { .scope = scope, .cancel = cancel };
    pthread_t worker;
    if (pthread_create(&worker, NULL, run_listener, &probe) != 0) return 1;
    // No main callback runs before this join. The listener only admits work;
    // it never depends on the host while the host is joining the listener.
    if (pthread_join(worker, NULL) != 0 || probe.status != 1) return 2;
    if (scope->pending != (cancel ? 1u : 2u)) return 3;
    z_stage1_task_scope_join(scope, cancel);
    if (scope->pending != 0 || scope->external_head != NULL) return 4;
    // Drain already-posted dispatch notifications before the host is released.
    for (int tick = 0; scope->refcount != 1 && tick < 20; ++tick)
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
    if (scope->refcount != 1) return 5;
    Z_TaskScope_release(scope);
  }
  for (int closed = 0; closed < 2; ++closed) {
    Z_TaskScope *scope = z_stage1_task_scope_new(NULL);
    if (closed) z_stage1_task_scope_join(scope, false);
    Probe probe = { .scope = scope };
    pthread_t worker;
    if (pthread_create(&worker, NULL, queue_cancelled_or_rejected, &probe) != 0) return 6;
    if (pthread_join(worker, NULL) != 0) return 7;
    if (callable_releases != closed || scope->pending != (closed ? 0u : 1u)) return 8;
    z_stage1_task_scope_join(scope, true);
    if (callable_releases != 1) return 9;
    for (int tick = 0; scope->refcount != 1 && tick < 20; ++tick)
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
    if (scope->refcount != 1) return 10;
    Z_TaskScope_release(scope);
    callable_releases = 0;
  }
  return 0;
}`, "wake on main\nwake on main\n", ["-pthread", "-framework", "CoreFoundation", "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
}, 240_000);

test("cancels native yield frames before entry and after owned initialization without leaks", () => {
  const source = `#define main z_fixture_main\n${fixtureEmission()}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation before = _z_stage1_yield_waitForCancellation_start(&executor);
  z_stage1_async_enqueue(&executor, before.task);
  z_stage1_async_request_cancel(before.task);
  if (!z_stage1_async_drive_one(&executor) || !before.task->completed || !before.task->cancelled) return 1;
  before.destroy(before.task);
  if (executor.head != NULL || executor.tail != NULL) return 2;

  Z_AsyncInvocation after = _z_stage1_yield_waitForCancellation_start(&executor);
  z_stage1_async_enqueue(&executor, after.task);
  if (!z_stage1_async_drive_one(&executor) || after.task->completed) return 3;
  if (!after.task->queued || executor.head != after.task) return 4;
  z_stage1_async_request_cancel(after.task);
  if (!z_stage1_async_drive_one(&executor) || !after.task->completed || !after.task->cancelled) return 5;
  after.destroy(after.task);
  if (executor.head != NULL || executor.tail != NULL) return 6;
  return 0;
}`;
  const expected = "prepared delivery\nreleased discarded\nreleased selected\n";
  execute(source, expected);
  execute(source, expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
}, 240_000);

test("preserves copied collections and early void returns in native yield frames", () => {
  const directory = mkdtempSync("/tmp/z-native-yield-collections-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
import { scheduler } from "std/async";
class Receipt { label: String; deinit { console.log(this.label); } }
struct Snapshot { tags: Array<String>; result: Option<String>; }
function finish(): void { console.log("finished"); }
async function inspect(): void {
  const receipt = new Receipt({ label: "released" });
  const snapshot = Snapshot({ tags: Array<String>("notes", "draft"), result: Option.some("ready") });
  const { tags, result } = copy snapshot;
  await scheduler.yield();
  if (tags[1] != snapshot.tags[1] || receipt.label != "released") return;
  await scheduler.yield();
  finish();
  if (tags.length == 2) return;
  console.log("unexpected fallthrough");
}
async function main(): i32 { await inspect(); return 0; }
`;
    writeFileSync(input, source);
    const expected = "finished\nreleased\n";
    execute(compileToC(source, input), expected);
    execute(emit(input), expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps native yield frame expansion behind ownership and storage checks", () => {
  const directory = mkdtempSync("/tmp/z-native-yield-rejection-");
  try {
    const invalid = `import { scheduler } from "std/async";
struct Record { title: String; }
async function main(): i32 {
  const record = Record({ title: "draft" });
  const { title } = move record;
  await scheduler.yield();
  return i32(record.title.byteLength);
}`;
    assert.throws(() => compileToC(invalid, "yield-moved.zs"), /use of moved value/);
    const input = resolve(directory, "main.zs");
    writeFileSync(input, invalid);
    const moved = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.notEqual(moved.status, 0);
    assert.match(moved.stderr, /moved value/);

    writeFileSync(input, `import { scheduler } from "std/async";
import { Mutex } from "std/sync";
struct State { value: i32; }
async function main(): i32 {
  const state = Mutex(State({ value: 1 }));
  await scheduler.yield();
  return 0;
}`);
    const storage = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.equal(storage.status, 0, storage.stderr);
    execute(storage.stdout, "");

    writeFileSync(input, `import { scheduler } from "std/async";
import { Set } from "std/collections";
struct Bundle { state: Set<i32>; code: i32; }
function prepare(): Bundle { return Bundle({ state: Set<i32>(), code: 7 }); }
async function main(): i32 {
  const { code } = prepare();
  await scheduler.yield();
  return code - 7;
}`);
    const hiddenStorage = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.notEqual(hiddenStorage.status, 0);
    assert.match(hiddenStorage.stderr, /Z0700/);
    assert.match(hiddenStorage.stderr, /destructuring source requires supported owned frame storage/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("moves owned parameters into native yield frames with hygienic storage", () => {
  const expected = "prepared launch\nreleased discarded\nselected\nreleased selected\n";
  const source = parameterEmission();
  assert.match(source, /_z_binding_state/);
  assert.match(source, /_z_binding_result/);
  assert.match(source, /_z_binding_task/);
  execute(source, expected);
  execute(source, expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
  execute(compileToC(readFileSync(parameterFixture, "utf8"), parameterFixture), expected);
}, 240_000);

test("cleans native owned inputs when a cold invocation is dropped or cancelled", () => {
  const source = `#define main z_fixture_main\n${parameterEmission()}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation cold = _z_stage1_yield_waitOwned_start(&executor, launch());
  if (executor.head != NULL || cold.task->completed) return 1;
  cold.destroy(cold.task);

  Z_AsyncInvocation before = _z_stage1_yield_waitOwned_start(&executor, launch());
  z_stage1_async_enqueue(&executor, before.task);
  z_stage1_async_request_cancel(before.task);
  if (!z_stage1_async_drive_one(&executor) || !before.task->cancelled || !before.task->completed) return 2;
  before.destroy(before.task);

  Z_AsyncInvocation after = _z_stage1_yield_waitOwned_start(&executor, launch());
  z_stage1_async_enqueue(&executor, after.task);
  if (!z_stage1_async_drive_one(&executor) || after.task->completed || !after.task->queued) return 3;
  z_stage1_async_request_cancel(after.task);
  if (!z_stage1_async_drive_one(&executor) || !after.task->cancelled || !after.task->completed) return 4;
  after.destroy(after.task);
  if (executor.head != NULL || executor.tail != NULL) return 5;
  return 0;
}`;
  const release = "released discarded\nreleased selected\n";
  const expected = `prepared launch\n${release}prepared launch\n${release}prepared launch\nentered listener\nreleased local\n${release}`;
  execute(source, expected);
  execute(source, expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
}, 240_000);

test("retains the caller's ARC alias while owning a yield-frame argument", () => {
  const directory = mkdtempSync("/tmp/z-native-yield-arc-input-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
import { scheduler } from "std/async";
class Receipt { label: String; deinit { console.log(\`released \${this.label}\`); } }
function message(): String { return \`owned \${7}\`; }
async function inspect(receipt: Receipt, context: String, executor: i32): i32 {
  await scheduler.yield();
  console.log(context);
  console.log(receipt.label);
  return executor - 1;
}
async function main(): i32 {
  const shared = new Receipt({ label: "shared" });
  const result = await inspect(shared, message(), 1);
  console.log(shared.label);
  return result;
}`;
    writeFileSync(input, source);
    const expected = "owned 7\nshared\nshared\nreleased shared\n";
    execute(compileToC(source, input), expected);
    execute(emit(input), expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
    const transferred = source
      .replace("await inspect(shared,", "await inspect(move shared,")
      .replace("  console.log(shared.label);\n", "");
    writeFileSync(input, transferred);
    const movedExpected = "owned 7\nshared\nreleased shared\n";
    execute(compileToC(transferred, input), movedExpected);
    execute(emit(input), movedExpected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);

    // The cleanup correction is shared with ordinary calls, not an async-only exception.
    const synchronous = source
      .replaceAll("async function", "function")
      .replace("  await scheduler.yield();\n", "")
      .replace("await inspect(", "inspect(");
    writeFileSync(input, synchronous);
    execute(compileToC(synchronous, input), expected);
    execute(emit(input), expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);

    const aliased = source
      .replace("function message()", "type ReceiptAlias = Receipt;\ntype SharedReceipt = ReceiptAlias;\nfunction message()")
      .replace("receipt: Receipt,", "receipt: SharedReceipt,")
      .replace("const shared =", "const shared: SharedReceipt =");
    writeFileSync(input, aliased);
    execute(compileToC(aliased, input), expected);
    execute(emit(input), expected, ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("rejects invalid moved inputs and unsupported borrowed or collection yield parameters", () => {
  const directory = mkdtempSync("/tmp/z-native-yield-input-rejection-");
  try {
    const input = resolve(directory, "main.zs");
    const moved = `import { scheduler } from "std/async";
struct Request { label: String; }
async function inspect(request: Request): i32 {
  const local = move request;
  await scheduler.yield();
  return i32(request.label.byteLength);
}
function main(): i32 { return 0; }`;
    assert.throws(() => compileToC(moved, input), /moved value/);
    const cases = [
      { source: moved, expected: /moved value/ },
      { source: `import { scheduler } from "std/async";
async function inspect(in message: String): void {
  while (true) { await scheduler.yield(); }
}
function main(): i32 { return 0; }`, expected: /Z0700/ },
      { source: `import { scheduler } from "std/async";
import { Set } from "std/collections";
async function inspect(state: Set<i32>): void {
  while (true) { await scheduler.yield(); }
}
function main(): i32 { return 0; }`, expected: /parameter "state" requires supported owned frame storage/ },
    ];
    for (const item of cases) {
      writeFileSync(input, item.source);
      const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, item.expected);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("owns synchronized inbox storage without holding its lock across native yields", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-yield-inbox.zs");
  const source = emit(input);
  execute(compileToC(readFileSync(input, "utf8"), input), "released inbox\n");
  execute(source, "released inbox\n", ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
  const harness = `#define main z_fixture_main\n${source}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation cold = _z_stage1_yield_deliver_start(&executor, makeInbox(), 2);
  cold.destroy(cold.task);

  Z_AsyncInvocation before = _z_stage1_yield_deliver_start(&executor, makeInbox(), 2);
  z_stage1_async_enqueue(&executor, before.task);
  z_stage1_async_request_cancel(before.task);
  if (!z_stage1_async_drive_one(&executor) || !before.task->cancelled) return 1;
  before.destroy(before.task);

  Z_Mutex_InboxState inbox = makeInbox();
  Z_AsyncInvocation active = _z_stage1_yield_deliver_start(&executor, Z_Mutex_InboxState_retain(inbox), 2);
  z_stage1_async_enqueue(&executor, active.task);
  if (!z_stage1_async_drive_one(&executor) || active.task->completed) return 2;
#if !defined(_WIN32)
  if (pthread_mutex_trylock(&inbox.storage->native) != 0) return 3;
#endif
  if (inbox.storage->value.count != 1 || inbox.storage->value.pending.length != 1) return 4;
#if !defined(_WIN32)
  if (pthread_mutex_unlock(&inbox.storage->native) != 0) return 5;
#endif
  z_stage1_async_request_cancel(active.task);
  if (!z_stage1_async_drive_one(&executor) || !active.task->cancelled) return 6;
  active.destroy(active.task);
  if (inbox.storage->refcount != 1) return 7;
  Z_Mutex_InboxState_deinit(&inbox);
  if (executor.head != NULL || executor.tail != NULL) return 8;
  return 0;
}`;
  execute(harness, "released inbox\nreleased inbox\nreleased inbox\n",
    ["-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all"]);
}, 240_000);
