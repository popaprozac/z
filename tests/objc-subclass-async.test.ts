import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-subclass-async.zs");
const source = readFileSync(fixture, "utf8");
const rejectedCases: [string, string, RegExp][] = [
  ["async override", source.replace("override function value()", "override async function value()"),
    /synchronous|async.*override|override.*async/],
  ["off-main construction", source + `
    function offMain(): i32 { const counter = new AsyncCounter(1); return counter.value(); }
  `, /construction.*thread.main|thread.main.*construction/],
  ["opaque worker capture", source + `
    async function workerCapture(): i32 on thread.main {
      const counter = new AsyncCounter(1);
      const work = thread.spawn(async move (): i32 => {
        return await on thread.main using (in counter) { select counter.value(); };
      });
      return await work;
    }
  `, /capture.*(native thread boundary|Objective-C object storage)/],
];

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

hostToolchainTest("preserves native subclass identity and ARC across asynchronous task storage", () => {
  if (process.platform !== "darwin") return;
  for (const [name, candidate, expected] of rejectedCases) {
    assert.throws(() => compileToNative(candidate, fixture), expected, name);
  }
  const temporary = mkdtempSync(resolve(tmpdir(), "z-subclass-async-"));
  try {
    for (const name of ["objc-subclass.h", "objc-subclass.h.zd"]) {
      symlinkSync(resolve(directory, name), resolve(temporary, name));
    }
    const seed = command(process.execPath,
      [cli, "self-host-emit", resolve(directory, "self-host-objc-subclass-execution.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    writeFileSync(input, source);
    const native = command(oracle, [wire, input, "", resolve(directory, "objc-subclass.h.zd")], undefined, 15_000);
    for (const [name, candidate, expected] of rejectedCases) {
      writeFileSync(input, candidate);
      const result = spawnSync(oracle, [wire, input, "", resolve(directory, "objc-subclass.h.zd")], {
        encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, expected, name);
    }
    for (const [compiler, output] of [["stage0", compileToNative(source, fixture).source], ["native", native]]) {
      assert.match(output, /@interface ZNative_(?:0_)?AsyncCounter : ZSubclassFixture/);
      assert.doesNotMatch(output, /\bZ_(?:0_)?AsyncCounter_(retain|release)\b/);
      const generated = resolve(temporary, `${compiler}.m`);
      writeFileSync(generated, output);
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, "probe");
        command("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", directory,
          "-framework", "Foundation", generated, resolve(directory, "objc-subclass.m"), "-o", executable]);
        for (let iteration = 0; iteration < 5; iteration++) {
          const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          assert.equal(result.status, 0, `${compiler} ${optimization} ${iteration}: ${result.stderr} ${result.error ?? ""}`);
          assert.equal(result.stdout, "", `${compiler} ${optimization}`);
        }
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
