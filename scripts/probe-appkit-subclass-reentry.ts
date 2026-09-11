// Explicit manual probe: --run requires a logged-in macOS GUI session;
// --check validates both receiver modes without opening any windows.
// Do not turn the read-only control into a production workaround: it has no
// mutable animation state. All native subprocesses are bounded; never use ASan.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileToNative } from "../compiler/src/compiler.ts";

if (process.platform !== "darwin" || !["--run", "--check"].includes(process.argv[2] ?? "")
  || process.argv.slice(3).some((argument) => !["--native", "--async"].includes(argument))) {
  console.error("Usage: bun scripts/probe-appkit-subclass-reentry.ts --check|--run [--native] [--async] (--run opens windows)");
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const file = resolve(root, "tests/fixtures/objc-subclass-appkit-reentry.zs");
const fixture = readFileSync(file, "utf8");
const asynchronous = process.argv.includes("--async");
const source = asynchronous ? fixture
  .replace("function main()", "async function main()")
  .replace('import console from "std/console";', 'import console from "std/console";\nimport { delay } from "std/time";')
  .replace('console.log("before native operation");', 'const resumed = await resumeProbe();\n  console.log("before native operation");')
  .concat('\nasync function resumeProbe(): i32 on thread.main { await delay(1); return 0; }\n')
  : fixture;
const directory = mkdtempSync(resolve(tmpdir(), "z-appkit-reentry-"));
const native = process.argv.includes("--native");
try {
  for (const name of ["objc-subclass.h", "objc-subclass.h.zd"]) {
    symlinkSync(resolve(root, "tests/fixtures", name), resolve(directory, name));
  }
  for (const mode of ["exclusive", "reader"] as const) {
    const input = mode === "exclusive" ? source : source
      .replace("resize(inout this, ", "resize(")
      .replace("zoom(inout this, ", "zoom(")
      .replaceAll("this.changes = this.changes + 1;", "");
    const generated = resolve(directory, `${mode}.m`);
    if (native) {
      const nativeInput = resolve(directory, `${mode}.zs`);
      writeFileSync(nativeInput, input);
      const emitted = spawnSync(resolve(root, ".z-cache/bootstrap/z"), ["emit", nativeInput], {
        encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, `${mode}: ${emitted.stderr} ${emitted.error ?? ""}`);
      writeFileSync(generated, emitted.stdout);
    } else {
      writeFileSync(generated, compileToNative(input, file).source);
    }
    if (process.argv[2] === "--check") {
      const checked = spawnSync("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsyntax-only",
        "-I", resolve(root, "tests/fixtures"), generated], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(checked.status, 0, `${mode}: ${checked.stderr} ${checked.error ?? ""}`);
      console.log(`${native ? "native" : "stage0"} ${asynchronous ? "async" : "sync"} ${mode}: checked without opening windows`);
      continue;
    }
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `${mode}${optimization}`);
      const build = spawnSync("xcrun", ["clang", "-fobjc-arc", "-Wall", "-Wextra", "-Werror", optimization,
        "-g", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", resolve(root, "tests/fixtures"), "-framework", "AppKit", generated,
        resolve(root, "tests/fixtures/objc-subclass.m"), "-o", executable], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(build.status, 0, `${mode} ${optimization}: ${build.stderr} ${build.error ?? ""}`);
      for (const operation of mode === "exclusive" ? ["resize", "zoom"] : ["zoom"]) {
        const result = spawnSync(executable, [], {
          encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
          env: { ...process.env, Z_SUBCLASS_ACCESS_SCENARIO: operation === "resize" ? "1" : "0" },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, `${mode} ${operation} ${optimization}: ${result.stderr}`);
        assert.match(result.stdout, /before native operation/);
        assert.match(result.stdout, /after native operation/);
        assert.doesNotMatch(result.stderr, /runtime error|UndefinedBehaviorSanitizer/);
        console.log(`${native ? "native" : "stage0"} ${mode} ${operation} ${optimization}: completed`);
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
