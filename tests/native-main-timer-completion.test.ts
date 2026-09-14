import {
  assert, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

test("preserves timer-frame match initialization, failures, scope joins, and cancellation", () => {
  const input = resolve(projectRoot, "tests/fixtures/async-main-timer-completion.zs");
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr || String(native.error));
  const expected = "released 1\nfailure 10\nerror 10\n"
    + "released 2\nreleased 1\nfailure 11\nerror 11\n"
    + "released 3\nreleased 2\nreleased 1\nfailure 12\nerror 12\n"
    + "released 3\nreleased 2\nreleased 1\nfailure 13\nerror 13\n"
    + "released 3\nreleased 2\nreleased 1\nresult 42\n"
    + "entered\nreleased 2\nreleased 4\nreleased 2\n2\n7\nservice released\nreleased 5\ncapture 8\n";
  const directory = mkdtempSync("/tmp/z-main-timer-completion-");
  try {
    for (const source of [compileToC(readFileSync(input, "utf8"), input), native.stdout]) {
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, "probe");
        const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-pthread", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          ...(process.platform === "darwin" ? ["-framework", "CoreFoundation"] : []), "-", "-o", binary],
        { input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
        assert.equal(compiled.status, 0, compiled.stderr);
        const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(run.status, 0, run.stderr || `${run.error}\n${run.stdout}`);
        assert.equal(run.stdout, expected);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps worker-to-main early timer completion fail-closed until forwarding is implemented", () => {
  const directory = mkdtempSync("/tmp/z-worker-timer-completion-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(input, `import { thread } from "std/thread";
import { delay } from "std/time";
async function load(): i32 on thread.main {
  const selected = match (Option<i32>.some(1)) { some(value) => value; none => return 2; };
  await delay(1);
  return selected;
}
async function main(): i32 {
  const worker = thread.spawn(async move (): i32 => { return await on thread.main load(); });
  return await worker;
}`);
    assert.ok(compileToC(readFileSync(input, "utf8"), input).length > 0);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.notEqual(native.status, 0);
    assert.match(native.stderr, /Z0700/);
    assert.match(native.stderr, /native worker-to-main timer segments.*completion forwarding/);
    assert.doesNotMatch(native.stderr, /internal compiler error/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
