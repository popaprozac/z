import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot, readFileSync,
  resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, test, writeFileSync } from "./support/bootstrap.ts";

test("native analysis rejects deferred class defaults rather than treating them as struct defaults", () => {
  const directory = mkdtempSync("/tmp/z-class-default-parity-");
  const input = resolve(directory, "main.zs");
  try {
    for (const declaration of [
      "class State { count: i32 = 0; }",
      "class State { count: i32 = 0; constructor() { this.count = 1; } }",
    ]) {
      writeFileSync(input, `${declaration}\nfunction main(): i32 { return 0; }`);
      for (const command of ["check", "self-host-resolve"]) {
        const result = spawnSync(process.execPath, [cli, command, input], {
          encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
        });
        assert.equal(result.status, 1, `${command}: ${result.stderr}`);
        assert.match(result.stderr, /class field defaults are deferred/);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

hostToolchainTest("preserves instanceof proofs through negated guards and short-circuit conditions natively", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-instanceof-guards.zs");
  const directory = mkdtempSync("/tmp/z-instanceof-guards-");
  try {
    symlinkSync(resolve(projectRoot, "tests/fixtures/objc-instanceof.h"), resolve(directory, "objc-instanceof.h"));
    const seed = spawnSync(process.execPath, [cli, "self-host-emit",
      resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(seed.status, 0, seed.stderr);
    const oracle = resolve(directory, "emitter");
    const compiledOracle = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: seed.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(compiledOracle.status, 0, compiledOracle.stderr);
    const contract = resolve(directory, "objc-instanceof.h.zd");
    writeFileSync(contract, 'declare module "./objc-instanceof.h" {}');
    const wire = resolve(directory, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-instanceof.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [resolve(projectRoot, "tests/fixtures")]).get("native")!);
    const input = resolve(directory, "input.zs");
    const native = (source: string) => {
      writeFileSync(input, source);
      return spawnSync(oracle, [wire, input, "", contract], {
        encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
      });
    };
    const source = readFileSync(fixture, "utf8");
    const emitted = native(source);
    assert.equal(emitted.status, 0, emitted.stderr);
    for (const [command, output] of [["stage0", compileToNative(source, input).source], ["native", emitted.stdout]]) {
      assert.match(output, /isKindOfClass/);
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, `${command}${optimization}`);
        const compiled = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", optimization,
          "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-I", resolve(projectRoot, "tests/fixtures"), "-framework", "Foundation", "-", "-o", binary], {
          input: output, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compiled.status, 0, compiled.stderr);
        const result = spawnSync(binary, [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
        assert.equal(result.status, 0, `${command} ${optimization}: ${result.stderr}`);
        assert.equal(result.stderr, "");
      }
    }
    const prelude = `import native from "./objc-instanceof.h";
      function inspect(in owner: native.ZObjCDynamicOwner, flag: boolean): i32 {
        const body = owner.body;`;
    const unsafe = [
      `if (!(body instanceof native.NSString)) { const text: String = body; return 1; } return 0;`,
      `if (body instanceof native.NSString || flag) { const text: String = body; return 1; } return 0;`,
      `if (body instanceof native.NSString) {} const text: String = body; return 0;`,
    ];
    for (const body of unsafe) {
      const candidate = `${prelude}${body}} function main(): i32 { return 0; }`;
      assert.throws(() => compileToNative(candidate, input), /expected String|requires.*NSString|cannot.*String/, body);
      const result = native(candidate);
      assert.equal(result.status, 1, `${body}\n${result.stderr}`);
      assert.match(result.stderr, /expected String|requires.*NSString|cannot.*String/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
