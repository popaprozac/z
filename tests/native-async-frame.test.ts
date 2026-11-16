import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, bindGeneratedNames, writeFileSync,
} from "./support/bootstrap.ts";

// General native async frames: suspending functions that no shape tier claims.
function emit(fixture: string): string {
  const result = spawnSync(process.execPath, [cli, "self-host-emit", fixture], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

function execute(source: string, expected: string): void {
  const directory = mkdtempSync("/tmp/z-async-frame-");
  try {
    const binary = resolve(directory, "probe");
    const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary],
      { input: bindGeneratedNames(source), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 0, run.stderr || `${run.error}\n${run.stdout}`);
    assert.equal(run.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("runs timer suspensions, computed delays, and non-scalar results in general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-delay.zs");
  const expected = "start 1\nreleased job 1\njob-1\nreleased job 2\ncounted 2 ticks=5\nrelay ok=6 failed=-9\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /z_stage1_async_schedule_delay\(task, \(uint64_t\)\(/);
  execute(source, expected);
}, 240_000);

test("wakes a sleeping general native frame on cancellation and releases its owners", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-sleeper.zs");
  const source = `#define main z_fixture_main\n${emit(fixture)}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation leaf = _z_stage1_yield_sleeper_start(&executor, (Z_Job){ .id = 1 });
  z_stage1_async_enqueue(&executor, leaf.task);
  if (!z_stage1_async_drive_one(&executor) || leaf.task->completed) return 1;
  if (!leaf.task->timer_scheduled || executor.timers != leaf.task) return 2;
  const uint64_t started = z_stage1_async_now_ms();
  z_stage1_async_request_cancel(leaf.task);
  if (leaf.task->timer_scheduled || executor.timers != NULL || !leaf.task->queued) return 3;
  if (!z_stage1_async_drive_one(&executor) || !leaf.task->completed || !leaf.task->cancelled) return 4;
  leaf.destroy(leaf.task);
  if (executor.head != NULL || executor.timers != NULL) return 5;

  Z_AsyncInvocation outer = _z_stage1_yield_parent_start(&executor, (Z_Job){ .id = 2 });
  z_stage1_async_enqueue(&executor, outer.task);
  for (int tick = 0; executor.timers == NULL; ++tick) {
    if (tick > 4 || !z_stage1_async_drive_one(&executor)) return 6;
  }
  z_stage1_async_request_cancel(outer.task);
  for (int tick = 0; !outer.task->completed; ++tick) {
    if (tick > 8 || !z_stage1_async_drive_one(&executor)) return 7;
  }
  if (!outer.task->cancelled || executor.timers != NULL) return 8;
  outer.destroy(outer.task);
  if (executor.head != NULL) return 9;

  // Cancelling a parent cancels and joins its spawned children first.
  Z_AsyncInvocation cancelled = _z_stage1_yield_supervisor_start(&executor, (Z_Job){ .id = 10 });
  z_stage1_async_enqueue(&executor, cancelled.task);
  for (int tick = 0; tick < 3; ++tick) {
    if (!z_stage1_async_drive_one(&executor)) return 11;
  }
  if (executor.head != NULL || cancelled.task->completed) return 12;
  z_stage1_async_request_cancel(cancelled.task);
  for (int tick = 0; !cancelled.task->completed; ++tick) {
    if (tick > 8 || !z_stage1_async_drive_one(&executor)) return 13;
  }
  if (!cancelled.task->cancelled || executor.timers != NULL) return 14;
  cancelled.destroy(cancelled.task);

  // Dropping an unfinished parent drains its children before freeing it.
  Z_AsyncInvocation dropped = _z_stage1_yield_supervisor_start(&executor, (Z_Job){ .id = 20 });
  z_stage1_async_enqueue(&executor, dropped.task);
  for (int tick = 0; tick < 3; ++tick) {
    if (!z_stage1_async_drive_one(&executor)) return 15;
  }
  dropped.destroy(dropped.task);
  if (executor.head != NULL || executor.timers != NULL) return 16;

  // A cancelled parent releases the temporary it lent to its child once.
  Z_AsyncInvocation lender = _z_stage1_yield_borrower_start(&executor);
  z_stage1_async_enqueue(&executor, lender.task);
  for (int tick = 0; tick < 8 && (executor.timers == NULL || executor.timers->wake_at_ms - z_stage1_async_now_ms() < 1000); ++tick) {
    if (!z_stage1_async_drive_one(&executor)) return 17;
  }
  z_stage1_async_request_cancel(lender.task);
  for (int tick = 0; !lender.task->completed; ++tick) {
    if (tick > 8 || !z_stage1_async_drive_one(&executor)) return 18;
  }
  if (!lender.task->cancelled || executor.timers != NULL) return 19;
  lender.destroy(lender.task);

  // A frame cancelled inside a scope joins its child, then releases the
  // scope's local once.
  Z_AsyncInvocation scope = _z_stage1_yield_scoped_start(&executor);
  z_stage1_async_enqueue(&executor, scope.task);
  for (int tick = 0; executor.timers == NULL; ++tick) {
    if (tick > 4 || !z_stage1_async_drive_one(&executor)) return 20;
  }
  z_stage1_async_request_cancel(scope.task);
  for (int tick = 0; !scope.task->completed; ++tick) {
    if (tick > 8 || !z_stage1_async_drive_one(&executor)) return 21;
  }
  if (!scope.task->cancelled || executor.timers != NULL) return 22;
  scope.destroy(scope.task);

  // A frame cancelled inside a suspending match arm releases the arm's owned
  // payload once.
  Z_AsyncInvocation arm = _z_stage1_yield_holding_start(&executor,
    (Z_Holder){ .tag = Z_HolderTag_held, .payload = { .held = (Z_Job){ .id = 50 } } });
  z_stage1_async_enqueue(&executor, arm.task);
  for (int tick = 0; executor.timers == NULL; ++tick) {
    if (tick > 4 || !z_stage1_async_drive_one(&executor)) return 23;
  }
  z_stage1_async_request_cancel(arm.task);
  for (int tick = 0; !arm.task->completed; ++tick) {
    if (tick > 8 || !z_stage1_async_drive_one(&executor)) return 24;
  }
  if (!arm.task->cancelled || executor.timers != NULL) return 25;
  arm.destroy(arm.task);
  if (z_stage1_async_now_ms() - started > 5000) return 10;
  return 0;
}`;
  execute(source, "sleeping 1\nreleased job 1\nsleeping 3\nreleased job 3\nreleased job 2\n"
    + "sleeping 11\nsleeping 12\nreleased job 11\nreleased job 12\nreleased job 10\n"
    // A dropped frame destroys its children in reverse order, as Stage 0 does.
    + "sleeping 21\nsleeping 22\nreleased job 22\nreleased job 21\nreleased job 20\n"
    + "released job 30\nreleased job 40\nreleased job 50\n");
}, 240_000);

test("runs async main as a general native frame when it awaits timers directly", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-main.zs");
  const expected = "begin\nreleased 5\nvalue 5 job 4 index 3 code 6\nreleased 4\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /_z_stage1_yield_(?:_z_function_\d+_)?main_start\(&executor\)/);
  execute(source, expected);
}, 240_000);

test("runs task spawns, joins, scopes, and failure cancellation in general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-tasks.zs");
  const expected = [
    "spawned", "quick 2", "finished 1", "released job 1", "value 1",
    "quick 4", "released job 4", "finished 5", "finished 3", "released job 3", "released job 5",
    "scope done", "released job 6", "cancelled", "released job 9", "code 3", "released job 2", "",
  ].join("\n");
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /_release_slot\(task, &frame->_z_spawn_\d+\)/);
  execute(source, expected);
}, 240_000);

test("passes borrowed parameters and frame borrow temporaries to general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-borrows.zs");
  const expected = "inspected 40\ninspected 40\ninspected 5\nreleased report 5\ninspected 40\n"
    + "seen 40 counter 3 filled 7 relayed 41 temporary 5 sum 42\nreleased report 40\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /_z_await_borrow_\d+_1_live = true;/);
  execute(source, expected);
}, 240_000);

test("hoists awaits nested in expressions ahead of their statement in general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-hoisted.zs");
  const expected = "baseline 0 missing -3 sum 42 total 42 joined 6\nexpected\nunexpected\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /_z_stage1_frame_binding__z_await_value_\d+ = _z_child_result_\d+;/);
  execute(source, expected);

  // An owned nested result needs a frame slot handoff: both compilers reject it.
  const directory = mkdtempSync("/tmp/z-async-frame-hoist-boundary-");
  try {
    const input = resolve(directory, "main.zs");
    const program = `import { delay } from "std/time";
function size(text: String): usize { return text.byteLength; }
async function name(): String {
  await delay(1);
  return "named";
}
async function main(): i32 {
  await delay(1);
  const count = size(await name());
  return i32(count) - 5;
}`;
    writeFileSync(input, program);
    assert.throws(() => compileToC(program, input), /an ownership-bearing nested await result is not executable yet/);
    const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /main\.zs:9:22: error\[Z0700\]: an ownership-bearing nested await result is not executable yet/);
    assert.doesNotMatch(result.stderr, /internal compiler error/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps async scope locals in general native frames until the scope joins its children", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-scope-locals.zs");
  const expected = "inspected 2\ninspected 1\nobserved 1\nreleased report 2\nreleased report 1\nscope closed\n"
    + "inspected 10\nreleased report 10\ninspected 11\nreleased report 11\nsum 42\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  execute(emit(fixture), expected);
}, 240_000);

test("keeps suspending match arm payloads in general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-match-arms.zs");
  const expected = "released job 1\nreleased job 2\nresolved 1 2 -3\nconsumed cached 6\nreleased job 6\n"
    + "consume done\nconsumed missing 7\nconsume done\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /_z_stage1_frame_binding__z_stage1_match_payload_\d+_\d+ = _z_stage1_match_\d+\.payload\./);
  execute(source, expected);
}, 240_000);

test("runs, spawns, and joins class, moved-struct, and static async methods in general native frames", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/native-async-frame-methods.zs");
  const expected = "forwarded 6 temporary 9\nreleased request 7\nreleased request 8\nspawned 9 8\n"
    + "sent 7 code 5 echoes 11 13\nreleased client 9\nreleased client 5\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit(fixture);
  assert.match(source, /#define self \(frame->_z_receiver\)/);
  assert.match(source, /frame->_z_receiver = Z_Client_retain\(receiver\);/);
  execute(source, expected);
}, 240_000);
