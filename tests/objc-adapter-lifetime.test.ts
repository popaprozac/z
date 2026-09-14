import {
  assert, cli, compileToNative, mkdtempSync, projectRoot, readFileSync,
  resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

test("pins a protocol adapter across reentrant removal of its last native owner", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(projectRoot, "tests/fixtures/objc-adapter-reentrant.zs");
  const stage0 = compileToNative(readFileSync(fixture, "utf8"), fixture).source;
  const directory = mkdtempSync("/tmp/z-adapter-lifetime-");
  try {
    // Build the source-owned emitter so CI does not depend on a locally
    // installed bootstrap binary or accidentally test stale native emission.
    const emission = spawnSync(process.execPath, [cli, "self-host-emit",
      resolve(projectRoot, "tests/fixtures/self-host-objc-subclass-execution.zs")], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const oracle = resolve(directory, "emitter");
    const builtOracle = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      input: emission.stdout, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(builtOracle.status, 0, builtOracle.stderr);
    const wire = resolve(directory, "native.zfdcl");
    const contract = resolve(directory, "native.zd");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "objc-adapter-reentrant.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, []).get("native")!);
    writeFileSync(contract, 'declare module "objc-adapter-reentrant.h" {}');
    const native = spawnSync(oracle, [wire, fixture, "", contract], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    for (const [frontend, source] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const binary = resolve(directory, `${frontend}${optimization}`);
        const built = spawnSync("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks",
          "-Wall", "-Wextra", "-Werror", optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all",
          "-I", resolve(projectRoot, "tests/fixtures"),
          "-framework", "Foundation", "-mmacosx-version-min=14.0", "-", "-o", binary], {
          input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, built.stderr);
        const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(run.status, 0, `${frontend} ${optimization}: ${run.stderr || run.status}`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);
