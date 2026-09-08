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

function execute(source: string, expected: string): void {
  const directory = mkdtempSync("/tmp/z-linear-tail-");
  try {
    const binary = resolve(directory, "program");
    const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary],
      { input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(result.stdout, expected);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

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
