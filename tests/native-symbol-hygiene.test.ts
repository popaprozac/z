import {
  assert, cli, compileToC, mkdtempSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

test("keeps user methods distinct from ARC helpers and escaped user methods", () => {
  const directory = mkdtempSync("/tmp/z-method-hygiene-");
  try {
    const input = resolve(directory, "main.zs");
    const source = `import console from "std/console";
trait Releasable { function release(): i32; }
class Resource implements Releasable {
  value: i32;
  deinit { console.log("destroyed"); }
  function release(): i32 { return this.value; }
  function retain(): i32 { return 2; }
  function __z_method_release(): i32 { return 3; }
  function weak_upgrade(): i32 { return 4; }
  static function weak_retain(): i32 { return 5; }
  function finalize_on_executor(): i32 { return 6; }
}
struct Record<T> {
  value: T;
  function release(): T { return this.value; }
}
function inspect<T: Releasable>(in resource: T): i32 { return resource.release(); }
function main(): i32 {
  const resource = new Resource({ value: 1 });
  const alias = resource;
  const weakResource: Weak<Resource> = weak resource;
  const record = Record<i32>({ value: 7 });
  const total = inspect(in alias) + resource.retain() + resource.__z_method_release()
    + resource.weak_upgrade() + Resource.weak_retain() + resource.finalize_on_executor()
    + record.release();
  if (total != 28) return 1;
  const upgraded = attempt weakResource.upgrade();
  match (upgraded) { success(value) => { if (value.release() != 1) return 2; } failure(_) => return 3; }
  console.log("methods passed");
  return 0;
}`;
    writeFileSync(input, source);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    for (const emission of [compileToC(source, input), native.stdout]) {
      assert.match(emission, /Z_Resource___z_method_release\(/);
      assert.match(emission, /Z_Resource___z_method___z_method_release\(/);
      const binary = resolve(directory, "program");
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O1",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
        input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(built.status, 0, built.stderr || String(built.error));
      const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(ran.status, 0, ran.stderr || String(ran.error));
      assert.equal(ran.stdout, "methods passed\ndestroyed\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("mangles private async bridges that collide with imported native functions", () => {
  const directory = mkdtempSync("/tmp/z-native-name-hygiene-");
  try {
    const input = resolve(directory, "main.zs");
    writeFileSync(resolve(directory, "native.h"), "static inline int listen(int first, int second) { return first + second; }\n");
    const source = `import native from "./native.h";
import { scheduler } from "std/async";
async function listen(): i32 { await scheduler.yield(); return 40; }
function nativeListen(): i32 = raw c { return listen(1, 1); }
async function main(): i32 {
  const result = await listen();
  return result + nativeListen() - 42;
}`;
    writeFileSync(input, source);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    assert.match(native.stdout, /__z_module_\d+_listen/);
    for (const emission of [compileToC(source, input), native.stdout]) {
      const binary = resolve(directory, "program");
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", directory,
        "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
        input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(built.status, 0, built.stderr || String(built.error));
      const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(ran.status, 0, ran.stderr || String(ran.error));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
