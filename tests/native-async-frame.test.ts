import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, bindGeneratedNames,
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
  if (z_stage1_async_now_ms() - started > 5000) return 10;
  return 0;
}`;
  execute(source, "sleeping 1\nreleased job 1\nsleeping 3\nreleased job 3\nreleased job 2\n");
}, 240_000);
