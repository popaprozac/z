import {
  assert, cli, mkdtempSync, projectRoot, readFileSync, resolve, rmSync,
  spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

test("wakes an idle native host loop after the first worker completion", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-host-worker-wake-");
  const input = resolve(projectRoot, "tests/fixtures/async-host-worker-wake.zs");
  try {
    for (const mode of ["worker", "worker-then-timer"]) {
      const fixture = readFileSync(input, "utf8")
        .replace('"./async-host-worker-wake.h"', JSON.stringify(resolve(projectRoot, "tests/fixtures/async-host-worker-wake.h")));
      const entry = resolve(directory, `${mode}.zs`);
      writeFileSync(entry, mode === "worker" ? fixture :
        'import { delay } from "std/time";\nasync function pause(): void on thread.main { await delay(5); }\n'
          + fixture.replace("  const control =", "  const timer = updates.schedule(thread.main, async (): void => await pause());\n  const control ="));
      const compiler = process.env.Z_HOST_WAKE_COMPILER;
      const emitted = spawnSync(compiler ?? process.execPath, compiler ? ["emit", entry] : [cli, "self-host-emit", entry], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
      const frame = emitted.stdout.match(/typedef struct (\w+)_task \{[^}]*\bZ_Task_i32 _z_local_worker;/)?.[1];
      assert.ok(frame, "native worker-await frame");
      const start = `${frame}_start`;
      const source = resolve(directory, `${mode}.c`);
      // Exercise the runtime timer after the worker continuation independently
      // of the native frontend's still-limited mixed-suspension syntax tier.
      const withTimer = mode === "worker-then-timer";
      const emittedSource = withTimer ? emitted.stdout.replace("z_test_deliver(value);", "z_test_delay_delivery(value);") : emitted.stdout;
      if (withTimer) assert.notEqual(emittedSource, emitted.stdout);
      writeFileSync(source, `#include <stdint.h>
${withTimer ? "static void z_test_delay_delivery(int32_t value);" : ""}
#define main fixture_main\n${emittedSource}\n#undef main
${withTimer ? `
static Z_AsyncTask delivery_timer;
static int32_t delivery_value;
static void delivery_timer_poll(Z_AsyncTask *task) {
  task->completed = true;
  z_test_deliver(delivery_value);
}
static void z_test_delay_delivery(int32_t value) {
  delivery_value = value;
  delivery_timer = (Z_AsyncTask){ .executor = z_stage1_current_executor, .poll = delivery_timer_poll };
  z_stage1_async_schedule_delay(&delivery_timer, 5);
}
` : ""}
int main(void) {
 for (int mode = 0; mode < 3; ++mode) {
  gate_open = false;
  delivered = 0;
  delivery_count = 0;
  Z_AsyncExecutor executor = {0};
  z_stage1_async_executor_init_external(&executor);
  Z_TaskScope *scope = z_stage1_task_scope_new(&executor);
  Z_TaskControl *control = z_stage1_task_scope_spawn_async(scope, ${start}, NULL, NULL);
  if (!control->accepted) return 1;
  if (mode == 2) z_stage1_task_control_request_cancel(control);
  const int result = mode == 0 ? z_test_run_host() : 0;
  z_test_release_worker();
  // Cleanup may drive the executor, but must not turn a missed host wake into
  // success: capture the observable result before driving any more Z work.
  z_stage1_task_scope_join(scope, mode == 2);
  ${withTimer ? "while (executor.timers != NULL) if (!z_stage1_async_drive_one(&executor)) abort();" : ""}
  Z_TaskControl_release(control);
  Z_TaskScope_release(scope);
  z_stage1_async_executor_destroy_external(&executor);
  memset(&executor, 0xa5, sizeof(executor));
  // A wake queued before teardown must not access the former stack executor.
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, false);
  if (mode == 0 && result != 42) return 2;
  if (delivered != (mode == 2 ? 0 : 42)) return 3;
  if (delivery_count != (mode == 2 ? 0 : 1)) return 4;
 }
 // A non-hosted executor must not accumulate retained main-queue work.
 gate_open = true;
 Z_AsyncExecutor standalone = {0};
 z_stage1_async_executor_init_external(&standalone);
 Z_AsyncInvocation invocation = ${start}(NULL, &standalone);
 z_stage1_async_enqueue(&standalone, invocation.task);
 while (!invocation.task->completed)
   if (!z_stage1_async_drive_one(&standalone)) abort();
 ${withTimer ? "while (standalone.timers != NULL) if (!z_stage1_async_drive_one(&standalone)) abort();" : ""}
 invocation.destroy(invocation.task);
 if (standalone.host_wake->refcount != 1) return 5;
 z_stage1_async_executor_destroy_external(&standalone);
 return 0;
}
`);
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, `${mode}${optimization}`);
        const compiled = spawnSync("clang", [source, "-std=c11", "-Wall", "-Wextra", "-Werror",
          "-I", resolve(projectRoot, "tests/fixtures"),
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-framework", "CoreFoundation", "-o", binary],
          { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
        assert.equal(compiled.status, 0, compiled.stderr);
        const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(run.status, 0, `${mode} ${optimization}: ${run.stderr || String(run.error)}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("services timer deadlines and external completions without false exhaustion", () => {
  if (process.platform === "win32") return;
  const directory = mkdtempSync("/tmp/z-executor-wait-");
  try {
    const input = resolve(directory, "wait.zs");
    writeFileSync(input, `import { delay } from "std/time";
import { thread } from "std/thread";
async function waitForTimer(): void on thread.main { await delay(5); }
async function main(): i32 on thread.main {
  const worker = thread.spawn((): i32 => 42);
  return await worker;
}`);
    const compiler = process.env.Z_HOST_WAKE_COMPILER;
    const emitted = spawnSync(compiler ?? process.execPath, compiler ? ["emit", input] : [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    const source = resolve(directory, "wait.c");
    writeFileSync(source, `#if !defined(__APPLE__)
#define _POSIX_C_SOURCE 200809L
#endif
#include <pthread.h>
static pthread_cond_t *spurious_condition;
static int spurious_remaining;
static void (*release_on_wait)(void);
static int simulate_wake(pthread_cond_t *condition) {
  if (condition != spurious_condition) return 0;
  if (spurious_remaining > 0) { --spurious_remaining; return 1; }
  if (release_on_wait != NULL) { release_on_wait(); release_on_wait = NULL; }
  return 0;
}
static int test_cond_wait(pthread_cond_t *condition, pthread_mutex_t *mutex) {
  return simulate_wake(condition) ? 0 : pthread_cond_wait(condition, mutex);
}
#if defined(__APPLE__)
static __attribute__((unused)) int test_timedwait(pthread_cond_t *condition, pthread_mutex_t *mutex, const struct timespec *deadline) {
  return simulate_wake(condition) ? 0 : pthread_cond_timedwait_relative_np(condition, mutex, deadline);
}
#define pthread_cond_timedwait_relative_np test_timedwait
#else
static __attribute__((unused)) int test_timedwait(pthread_cond_t *condition, pthread_mutex_t *mutex, const struct timespec *deadline) {
  return simulate_wake(condition) ? 0 : pthread_cond_timedwait(condition, mutex, deadline);
}
#define pthread_cond_timedwait test_timedwait
#endif
#define pthread_cond_wait test_cond_wait
#define main fixture_main
${emitted.stdout}
#undef main
${readFileSync(resolve(projectRoot, "tests/fixtures/async-executor-wait.c"), "utf8")}`);
    for (const optimization of ["-O0", "-O2"]) {
      const binary = resolve(directory, `wait${optimization}`);
      const compiled = spawnSync("clang", [source, "-std=c11", "-Wall", "-Wextra", "-Werror",
        optimization, "-pthread", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-o", binary],
      { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      assert.equal(compiled.status, 0, compiled.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL" });
      assert.equal(run.status, 0, `${optimization}: ${run.stderr || String(run.error)}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
