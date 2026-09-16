import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const fixtures = resolve(projectRoot, "tests/fixtures");

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

hostToolchainTest("keeps class and instance Objective-C properties distinct through inherited lookup", () => {
  if (process.platform !== "darwin") return;
  const fixture = resolve(fixtures, "objc-property-scopes.zs");
  const temporary = mkdtempSync("/tmp/z-objc-property-scopes-");
  try {
    const source = readFileSync(fixture, "utf8");
    const seed = command(process.execPath, [cli, "self-host-emit",
      resolve(fixtures, "self-host-objc-subclass-execution.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    const wire = resolve(temporary, "native.zfdcl");
    const contract = resolve(temporary, "native.zd");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "objc-property-scopes.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [fixtures]).get("native")!);
    writeFileSync(contract, 'declare module "objc-property-scopes.h" {}');
    const native = command(oracle, [wire, fixture, "", contract]);
    for (const [name, output] of [["stage0", compileToNative(source, fixture).source], ["native", native]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, `${name}${optimization}`);
        command("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures,
          "-framework", "Foundation", "-", "-o", executable], output);
        command(executable, [], undefined, 5_000);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
