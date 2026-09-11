// Explicit manual probe: requires a logged-in macOS GUI session.
// Do not turn the read-only control into a production workaround: it has no
// mutable animation state. All native subprocesses are bounded; never use ASan.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileToNative } from "../compiler/src/compiler.ts";

if (process.platform !== "darwin" || process.argv[2] !== "--run"
  || process.argv.slice(3).some((argument) => argument !== "--native")) {
  console.error("Run explicitly in a macOS GUI session: bun scripts/probe-appkit-subclass-reentry.ts --run [--native]");
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const file = resolve(root, "tests/fixtures/objc-subclass-appkit-reentry.zs");
const source = readFileSync(file, "utf8");
const directory = mkdtempSync(resolve(tmpdir(), "z-appkit-reentry-"));
const native = process.argv.includes("--native");
try {
  for (const name of ["objc-subclass.h", "objc-subclass.h.zd"]) {
    symlinkSync(resolve(root, "tests/fixtures", name), resolve(directory, name));
  }
  for (const mode of ["exclusive", "reader"] as const) {
    const input = mode === "exclusive" ? source : source
      .replace("resize(inout this, ", "resize(")
      .replace("requestZoom(inout this)", "requestZoom()")
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
