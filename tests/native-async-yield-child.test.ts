import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/async-yield-child.zs");
let cached: string | undefined;
function emit(): string {
  if (cached !== undefined) return cached;
  const result = spawnSync(process.execPath, [cli, "self-host-emit", fixture], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return cached = result.stdout;
}
function execute(source: string, expected: string): void {
  const directory = mkdtempSync("/tmp/z-yield-child-");
  try {
    const binary = resolve(directory, "probe");
    const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary],
      { input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(run.status, 0, run.stderr || `${run.error}\n${run.stdout}`);
    assert.equal(run.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("joins yielding children and preserves typed errors in native yield frames", () => {
  const expected = "released first\nendpoint\nreleased endpoint\nreleased second\nreleased endpoint\nreleased batch\nreleased batch\nreleased snapshot\nreleased error rejected\n";
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  const source = emit();
  assert.match(source, /frame->child.task->waiter = task/);
  // Yield-only frames retain their old footprint: no unused invocation slot.
  const leaf = source.match(/typedef struct _z_stage1_yield_deliver \{([\s\S]*?)\} _z_stage1_yield_deliver;/);
  assert.ok(leaf);
  assert.doesNotMatch(leaf[1], /Z_AsyncInvocation child/);
  execute(source, expected);
}, 240_000);

test("propagates child cancellation and owns completed child results across the join", () => {
  const source = `#define main z_fixture_main\n${emit()}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  Z_AsyncInvocation parent = _z_stage1_yield_listen_start(&executor,
    (Z_Request){ .label = Z_STRING_LITERAL("request") }, false);
  z_stage1_async_enqueue(&executor, parent.task);
  for (int tick = 0; tick < 2; ++tick) {
    if (!z_stage1_async_drive_one(&executor)) return 1;
  }
  _z_stage1_yield_listen *frame = (_z_stage1_yield_listen *)parent.task;
  if (frame->child.task == NULL || parent.task->cancellation_requested) return 2;
  z_stage1_async_request_cancel(frame->child.task);
  for (int tick = 0; !parent.task->completed; ++tick) {
    if (tick > 10 || !z_stage1_async_drive_one(&executor)) return 3;
  }
  if (!parent.task->cancelled || parent.task->cancellation_requested) return 4;
  parent.destroy(parent.task);
  if (executor.head != NULL || executor.tail != NULL) return 5;

  // The immediate child owns its snapshot until take_result; then the parent
  // owns it across a yield. Dropping at either point destroys it exactly once.
  for (int steps = 1; steps <= 3; ++steps) {
    Z_AsyncInvocation reader = _z_stage1_yield_readSnapshot_start(&executor);
    z_stage1_async_enqueue(&executor, reader.task);
    for (int tick = 0; tick < steps; ++tick) {
      if (!z_stage1_async_drive_one(&executor)) return 6;
    }
    z_stage1_async_request_cancel(reader.task);
    for (int tick = 0; !reader.task->completed; ++tick) {
      if (tick > 10 || !z_stage1_async_drive_one(&executor)) return 7;
    }
    reader.destroy(reader.task);
    if (executor.head != NULL || executor.tail != NULL) return 8;
  }
  return 0;
}`;
  execute(source, "released request\nreleased endpoint\n" + "released snapshot\n".repeat(3));
}, 240_000);

test("rejects unsupported child loans and nested await shapes instead of blocking a yield frame", () => {
  const directory = mkdtempSync("/tmp/z-yield-child-boundary-");
  try {
    const input = resolve(directory, "main.zs");
    const cases = [
      {
        source: `struct Request { count: i32; }
async function child(in request: Request): i32 { return request.count; }
async function main(): i32 {
  const request = Request({ count: 0 });
  await scheduler.yield();
  const value = await child(in request);
  return value;
}`,
        diagnostic: /child awaits require owned value arguments/,
      },
      {
        source: `async function child(): i32 { return 0; }
async function main(): i32 {
  await scheduler.yield();
  return (await child()) + 1;
}`,
        diagnostic: /Z0700/,
      },
      {
        source: `class Reader { async function read(): i32 { return 0; } }
async function main(): i32 {
  const reader = new Reader({});
  await scheduler.yield();
  const value = await reader.read();
  return value;
}`,
        diagnostic: /Z0700/,
      },
    ];
    for (const { source, diagnostic } of cases) {
      const program = `import { scheduler } from "std/async";\n${source}`;
      // These are valid Z programs; only the native executable tier is limited.
      compileToC(program, input);
      writeFileSync(input, program);
      const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.notEqual(result.status, 0, source);
      assert.match(result.stderr, diagnostic, `${source}\n${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("cancels and joins native yielding children before parent storage is released", () => {
  const source = `#define main z_fixture_main\n${emit()}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  // Cold drop; cancellation before entry; before child start; child cold;
  // child suspended; child failed but not yet consumed; after parent resumed.
  for (int steps = -1; steps <= 7; ++steps) {
    Z_AsyncInvocation parent = _z_stage1_yield_listen_start(&executor,
      (Z_Request){ .label = Z_STRING_LITERAL("request") }, true);
    if (steps >= 0) {
      z_stage1_async_enqueue(&executor, parent.task);
      for (int step = 0; step < steps && !parent.task->completed; ++step) {
        if (!z_stage1_async_drive_one(&executor)) return 1;
      }
      z_stage1_async_request_cancel(parent.task);
      for (int ticks = 0; !parent.task->completed; ++ticks) {
        if (ticks > 10 || !z_stage1_async_drive_one(&executor)) return 2;
      }
    }
    parent.destroy(parent.task);
    if (executor.head != NULL || executor.tail != NULL) return 3;
  }
  // Destroying an active parent must join a child, not free a reachable waiter.
  for (int steps = 2; steps <= 4; ++steps) {
    Z_AsyncInvocation parent = _z_stage1_yield_listen_start(&executor,
      (Z_Request){ .label = Z_STRING_LITERAL("request") }, false);
    z_stage1_async_enqueue(&executor, parent.task);
    for (int step = 0; step < steps; ++step) {
      if (!z_stage1_async_drive_one(&executor)) return 4;
    }
    parent.destroy(parent.task);
    if (executor.head != NULL || executor.tail != NULL) return 5;
  }
  return 0;
}`;
  const cold = "released request\n".repeat(2);
  const beforeChild = "released endpoint\nreleased request\n";
  const active = "released request\nreleased endpoint\n".repeat(3)
    + "released request\nreleased error rejected\nreleased endpoint\n"
    + "released request\nreleased endpoint\nreleased error rejected\n".repeat(2);
  // Three late cancellation/completion points have a produced owned error.
  execute(source, cold + beforeChild + active + "released request\nreleased endpoint\n".repeat(3));
}, 240_000);
