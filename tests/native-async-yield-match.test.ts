import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

const fixture = resolve(projectRoot, "tests/fixtures/async-yield-match.zs");
const expected = "retry\nreleased error retry\n"
  + "retry\nreleased error retry\nreleased endpoint outer\n"
  + "retry\nreleased endpoint outer\nretry\nreleased error retry\n"
  + "retry\nreleased error retry\nreleased endpoint outer\npropagated\nreleased error propagated\n"
  + "retry\nreleased error retry\nreleased endpoint outer\n"
  + "borrowed\nreleased error borrowed\n"
  + "retry\nreleased error retry\n".repeat(2)
  + "nested\nreleased error nested\nreleased error nested\n";
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
  const directory = mkdtempSync("/tmp/z-yield-match-");
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

test("handles receive failures with synchronous match arms in native yielding loops", () => {
  execute(compileToC(readFileSync(fixture, "utf8"), fixture), expected);
  execute(emit(), expected);
}, 240_000);

test("shares match cleanup and temporary argument handling with synchronous native code", () => {
  const directory = mkdtempSync("/tmp/z-match-cleanup-");
  try {
    const input = resolve(directory, "main.zs");
    const synchronous = readFileSync(fixture, "utf8")
      .replaceAll("await scheduler.yield();", "")
      .replaceAll("async function", "function").replaceAll("await ", "");
    execute(compileToC(synchronous, input), expected);
    writeFileSync(input, synchronous);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr);
    execute(emitted.stdout, expected);

    const source = `import { scheduler } from "std/async";
function inspect(in label: String): Option<usize> { return Option.some(label.byteLength); }
async function main(): i32 {
  await scheduler.yield();
  match (inspect(\`temporary \${1}\`)) {
    some(count) => { if (count == 11) return 0; }
    none => return 2;
  }
  return 1;
}`;
    // Stage 0 still rejects interpolated arguments in async expressions;
    // compare its synchronous semantics with the native suspending version.
    execute(compileToC(source.replaceAll("async function", "function")
      .replaceAll("await scheduler.yield();", ""), input), "");
    writeFileSync(input, source);
    const temporary = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(temporary.status, 0, temporary.stderr);
    assert.match(temporary.stdout, /Z_String_deinit\(&_z_stage1_borrow_\d+\);\s+switch/);
    execute(temporary.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("destroys match payloads before yielding and preserves owners across cancellation", () => {
  execute(`#define main z_fixture_main\n${emit()}\n#undef main
int main(void) {
  Z_AsyncExecutor executor = {0};
  for (int steps = 1; steps <= 2; ++steps) {
    Z_AsyncInvocation reader = _z_stage1_yield_borrowAndDiscard_start(&executor);
    z_stage1_async_enqueue(&executor, reader.task);
    for (int step = 0; step < steps; ++step) {
      if (!z_stage1_async_drive_one(&executor)) return 1;
    }
    z_stage1_async_request_cancel(reader.task);
    if (!z_stage1_async_drive_one(&executor) || !reader.task->cancelled) return 2;
    reader.destroy(reader.task);
    if (executor.head != NULL || executor.tail != NULL) return 3;
  }
  // A propagated payload belongs to the completed result, not the arm.
  // Dropping it unclaimed must release it once, after parent cleanup.
  Z_AsyncInvocation failing = _z_stage1_yield_exitArm_start(&executor, 1);
  z_stage1_async_enqueue(&executor, failing.task);
  for (int tick = 0; !failing.task->completed; ++tick) {
    if (tick > 4 || !z_stage1_async_drive_one(&executor)) return 4;
  }
  failing.destroy(failing.task);
  if (executor.head != NULL || executor.tail != NULL) return 5;
  return 0;
}`, "borrowed\nreleased error borrowed\nborrowed\nreleased error borrowed\n"
    + "retry\nreleased endpoint outer\nreleased error retry\n");
}, 240_000);

test("keeps suspending match payloads and nested locals outside the native yielding tier", () => {
  const directory = mkdtempSync("/tmp/z-yield-match-boundary-");
  try {
    const input = resolve(directory, "main.zs");
    const cases = [
      `const option = Option.some(1);
       match (option) { some(value) => { await scheduler.yield(); } none => {} }`,
      `match (await child()) { some(value) => {} none => {} }`,
      `const option = Option.some(Item({ count: 1 }));
       match (option) { some({ count }) => {} none => {} }`,
      `const option = Option.some(1);
       match (option) { some(value) => { const local = value + 1; } none => {} }`,
    ];
    for (const body of cases) {
      const source = `import { scheduler } from "std/async";
struct Item { count: i32; }
async function child(): Option<i32> { return Option.some(1); }
async function main(): i32 {
  ${body}
  await scheduler.yield();
  return 0;
}`;
      compileToC(source, input);
      writeFileSync(input, source);
      const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      });
      assert.notEqual(result.status, 0, source);
      assert.match(result.stderr, /Z0700/, `${source}\n${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("preserves moved-payload rejection before native match frame emission", () => {
  const directory = mkdtempSync("/tmp/z-yield-match-ownership-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import { scheduler } from "std/async";
import console from "std/console";
struct Item { message: String; }
function consume(value: Item): void {}
async function main(): i32 {
  const option = Option.some(Item({ message: "owned" }));
  await scheduler.yield();
  match (option) {
    some(value) => { consume(move value); console.log(value.message); }
    none => {}
  }
  return 0;
}`;
    assert.throws(() => compileToC(source, input), /moved/);
    writeFileSync(input, source);
    const result = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /moved/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
