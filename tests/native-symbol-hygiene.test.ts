import {
  assert, cli, compileTestsToNative, compileToC, mkdtempSync, resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";
import { readFileSync } from "node:fs";

test("escapes borrowed collection bindings with native keyword names", () => {
  const input = resolve("tests/fixtures/borrowed-loop-binding-hygiene.zs");
  const source = readFileSync(input, "utf8");
  const directory = mkdtempSync("/tmp/z-loop-hygiene-");
  try {
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    // Destructuring for-bindings are still a Stage 0 execution tier.
    const destructured = source.replace("for (const entry of entries)",
      "for (const { label: namespace, item: template } of entries)")
      .replace("entry.label", "namespace").replace("entry.item.text", "template.text");
    for (const [emitter, emission] of [["Stage 0", compileToC(source, input)],
      ["Stage 0 destructured", compileToC(destructured, input)], ["native", native.stdout]]) {
      for (const language of emitter === "native" ? ["c"] : ["c", "c++"]) {
        const binary = resolve(directory, "program");
        const built = spawnSync("clang", ["-x", language, language === "c" ? "-std=c11" : "-std=c++20",
          "-Wall", "-Wextra", "-Werror", "-O2", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-", "-o", binary], {
          input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, `${emitter}/${language}: ${built.stderr || built.error}`);
        const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(ran.status, 0, ran.stderr || String(ran.error));
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("keeps authored self bindings distinct from receivers and raw native boundaries", () => {
  const input = resolve("tests/fixtures/self-host-emit-receiver-hygiene.zs");
  const source = readFileSync(input, "utf8");
  const directory = mkdtempSync("/tmp/z-receiver-hygiene-");
  try {
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    const rawBlockSource = source.replace("const observed = rawIdentity(self);",
      "const observed = raw c using (in self): i32 { return *self; };");
    // Named raw functions work in both emitters; raw expression helpers still
    // use Stage 0. Preserve authored boundary names in both supported paths.
    for (const [emitter, emission] of [["Stage 0", compileToC(source, input)],
      ["Stage 0 raw block", compileToC(rawBlockSource, input)], ["native", native.stdout]]) {
      for (const language of emitter === "native" ? ["c"] : ["c", "c++"]) {
        const binary = resolve(directory, "program");
        const built = spawnSync("clang", ["-x", language, language === "c" ? "-std=c11" : "-std=c++20",
          "-Wall", "-Wextra", "-Werror", "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-", "-o", binary], {
          input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, `${emitter}/${language}: ${built.stderr || built.error}`);
        const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(ran.status, 0, `${emitter}/${language}: ${ran.stderr || ran.error}`);
        assert.equal(ran.stdout, "released owner\nreceiver bindings passed\nreleased store firstsecond\n");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("preserves self parameters and locals across owned async frames", () => {
  const input = resolve("tests/fixtures/self-host-emit-async-receiver-hygiene.zs");
  const source = readFileSync(input, "utf8");
  const directory = mkdtempSync("/tmp/z-async-receiver-hygiene-");
  try {
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    for (const [emitter, emission] of [["Stage 0", compileToC(source, input)], ["native", native.stdout]]) {
      const binary = resolve(directory, "program");
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
        "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
        input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(built.status, 0, `${emitter}: ${built.stderr || built.error}`);
      const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(ran.status, 0, `${emitter}: ${ran.stderr || ran.error}`);
      assert.equal(ran.stdout, "");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("preserves C trigraph sequences in literals, templates, async frames, and test names", () => {
  const directory = mkdtempSync("/tmp/z-string-hygiene-");
  const payload = "??= ??/ ??' ??( ??) ??! ??< ??> ??- JavaScript: cache ??= new Map();";
  const literal = JSON.stringify(payload);
  try {
    for (const async of [false, true]) {
      const input = resolve(directory, async ? "async.zs" : "sync.zs");
      const source = `import console from "std/console";
${async ? 'import { scheduler } from "std/async";' : ""}
const embedded: String = ${literal};
const nativeValue: cstring = ${literal};
function nativeText(value: cstring): void = raw c { puts(value); }
function sourceText(): String { return ${literal}; }
${async ? "async " : ""}function main(): i32 {
  const stored = ${literal};
  ${async ? "await scheduler.yield();" : ""}
  console.log(stored);
  console.log(embedded);
  console.log(${literal});
  const prefix = "start:";
  console.log(\`\${prefix}${payload}\`);
  const interpolated = \`\${prefix}${payload}\`;
  console.log(interpolated);
  nativeText(nativeValue);
  const returned = sourceText();
  console.log(returned);
  return 0;
}`;
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr || String(native.error));
      for (const emission of [compileToC(source, input), native.stdout]) {
        const expected = [payload, payload, payload, `start:${payload}`, `start:${payload}`, payload, payload].join("\n") + "\n";
        const languages = process.platform === "darwin" ? ["c", "objective-c"] : ["c"];
        for (const language of languages) for (const optimization of ["-O0", "-O2"]) {
          const binary = resolve(directory, "program");
          const built = spawnSync("clang", ["-x", language, "-std=c11", "-Wall", "-Wextra", "-Werror",
            "-Wtrigraphs", optimization, "-pthread", "-fsanitize=undefined", "-fno-sanitize-recover=all",
            "-", "-o", binary], {
            input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
          });
          assert.equal(built.status, 0, `${async}/${language}/${optimization}: ${built.stderr || built.error}`);
          const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          assert.equal(ran.status, 0, ran.stderr || String(ran.error));
          assert.equal(ran.stdout, expected);
        }
      }
    }
    const testSource = compileTestsToNative(`test ${literal} {}`, resolve(directory, "test.zs")).source;
    const binary = resolve(directory, "tests");
    const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wtrigraphs", "-", "-o", binary], {
      input: testSource, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    assert.equal(ran.status, 0, ran.stderr || String(ran.error));
    assert.ok(ran.stdout.includes(`test ${payload} ... ok\n`));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("preserves trigraph text through Stage 0 NSString literals and Z String conversion", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-objc-string-hygiene-");
  const payload = "??= ??/ ??' ??( ??) ??! ??< ??> ??-";
  try {
    const input = resolve(directory, "main.zs");
    const source = `import Foundation from "Foundation/Foundation.h";
import console from "std/console";
function main(): i32 {
  const message: Foundation.NSString = ${JSON.stringify(payload)};
  const snapshot: String = message;
  console.log(snapshot);
  return 0;
}`;
    writeFileSync(input, source);
    // The native emitter uses its shared byte-literal path, covered above.
    // Stage 0 additionally emits Objective-C @"..." literals directly.
    for (const emission of [compileToC(source, input)]) {
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, "program");
        const built = spawnSync("clang", ["-x", "objective-c", "-std=c11", "-fobjc-arc", "-framework", "Foundation",
          "-Wall", "-Wextra", "-Werror", "-Wtrigraphs", optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-", "-o", binary], { input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
        assert.equal(built.status, 0, built.stderr || String(built.error));
        const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(ran.status, 0, ran.stderr || String(ran.error));
        assert.equal(ran.stdout, `${payload}\n`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

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
    assert.match(native.stdout, /_z_function_\d+_listen/);
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

test("keeps Z function identities separate from runtime and imported C symbols", () => {
  const directory = mkdtempSync("/tmp/z-function-hygiene-");
  try {
    writeFileSync(resolve(directory, "native.h"),
      "static inline int customHook(int value) { return value + 1; }\n");
    for (const asynchronous of [false, true]) {
      const input = resolve(directory, asynchronous ? "async.zs" : "sync.zs");
      const source = `import fs from "std/fs";
import native from "./native.h";
${asynchronous ? 'import { scheduler } from "std/async";' : ""}
function write(depth: i32): i32 {
  if (depth == 0) return 0;
  return 1 + write(depth - 1);
}
function pause(): i32 { return 2; }
export function puts(): i32 { return 3; }
export function customHook(): i32 { return 4; }
function nativeHook(): i32 = raw c { return customHook(10); }
function releases(delta: i32): i32 = raw c {
  static int count = 0;
  count += delta;
  return count;
}
class Resource {
  value: i32;
  constructor() { this.value = puts(); }
  deinit { const count = releases(pause()); }
}
struct Defaults { value: i32 = puts(); }
function exerciseLifecycle(): i32 {
  const resource = new Resource();
  const defaults = Defaults();
  return resource.value + defaults.value;
}
function filesystemReady(): boolean { return fs.exists("."); }
function checkFunctions(): i32 {
  const callback = write;
  if (callback(2) != 2 || write(3) != 3 || pause() != 2 || puts() != 3) return 1;
  if (customHook() != 4 || nativeHook() != 11) return 2;
  if (!filesystemReady()) return 3;
  if (exerciseLifecycle() != 6 || releases(0) != 2) return 5;
  return 0;
}
${asynchronous ? "async " : ""}function main(): i32 {
  ${asynchronous ? "await scheduler.yield();" : ""}
  if (pause() != 2 || write(1) != 1) return 4;
  return checkFunctions();
}`;
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr || String(native.error));
      for (const [emitter, emission] of [["Stage 0", compileToC(source, input)], ["native", native.stdout]]) {
        for (const optimization of ["-O0", "-O2"]) {
          const binary = resolve(directory, "program");
          const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pthread",
            "-I", directory, optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary], {
            input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
          });
          assert.equal(built.status, 0, `${emitter}/${asynchronous}/${optimization}: ${built.stderr || built.error}`);
          const ran = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          assert.equal(ran.status, 0, `${emitter}: ${ran.stderr || ran.error}`);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
