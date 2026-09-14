import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync } from "./support/bootstrap.ts";

hostToolchainTest("normalizes contextual ObjC closure identities without weakening callable contracts", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-callable-aliases/main.zs");
  const source = readFileSync(fixture, "utf8");
  const artifact = compileToNative(source, fixture);
  const directory = mkdtempSync("/tmp/z-objc-callable-aliases-");
  try {
    // The parser-only resolver also rebases external namespace spellings before
    // Clang metadata is available; the executable oracle below checks full ABI identity.
    const parity = spawnSync(process.execPath, [cli, "check", fixture, "--native-frontend"], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(parity.status, 0, parity.stderr);
    const seed = spawnSync(process.execPath, [cli, "self-host-emit",
      resolve(projectRoot, "tests/fixtures/self-host-objc-callable-aliases.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(seed.status, 0, seed.stderr);
    const oracle = resolve(directory, "emitter");
    const build = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: seed.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(build.status, 0, build.stderr);
    writeFileSync(resolve(directory, "foundation.zfdcl"), resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "local", bindings: null, header: "Foundation/Foundation.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, []).get("local")!);
    writeFileSync(resolve(directory, "main.zs"), source);
    writeFileSync(resolve(directory, "contract.zs"), readFileSync(resolve(projectRoot,
      "tests/fixtures/objc-callable-aliases/contract.zs"), "utf8"));
    const native = spawnSync(oracle, [directory], {
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [frontend, output] of [["stage0", artifact.source], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, `${frontend}${optimization}`);
        const compiled = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", optimization,
          "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-framework", "Foundation", "-", "-o", executable], {
          input: output, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(compiled.status, 0, `${frontend}: ${compiled.stderr}`);
        const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
        assert.equal(result.status, 0, `${frontend} ${optimization}: ${result.stderr}`);
        assert.equal(result.stderr, "");
      }
    }
    const signature = "move (in value: local.NSString): local.NSString | null";
    for (const [name, replacement] of [
      ["different parameter class", "move (in value: local.NSNumber): local.NSString | null"],
      ["nullable parameter", "move (in value: local.NSString | null): local.NSString | null"],
      ["capability", "move (inout value: local.NSString): local.NSString | null"],
      ["nonnullable return", "move (in value: local.NSString): local.NSString"],
      ["different return class", "move (in value: local.NSString): local.NSNumber | null"],
      ["error contract", "move (in value: local.NSString): local.NSString | null throws i32"],
    ]) {
      const rejectedSource = source.replace(signature, replacement);
      assert.throws(() => compileToNative(rejectedSource, fixture),
        /expected|expects|requires|cannot/, name);
      writeFileSync(resolve(directory, "main.zs"), rejectedSource);
      const rejected = spawnSync(oracle, [directory], {
        encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
      });
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /expected|expects|requires|cannot/, name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
