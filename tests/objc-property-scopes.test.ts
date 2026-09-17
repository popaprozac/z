import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const fixtures = resolve(projectRoot, "tests/fixtures");

hostToolchainTest("shares immutable foreign signatures without merging namespaces or contracts", () => {
  const fixture = resolve(fixtures, "foreign-signature-sharing.zs");
  const temporary = mkdtempSync("/tmp/z-foreign-signature-sharing-");
  try {
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "foreign-signature-sharing.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [fixtures]).get("native")!);
    const emitted = command(process.execPath, [cli, "self-host-emit", fixture], undefined, 180_000);
    const executable = resolve(temporary, "probe");
    command("clang", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], emitted, 60_000);
    assert.equal(command(executable, [wire], undefined, 5_000), "signature sharing passed\n");
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);

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
    for (const [name, invalid, diagnostic] of [
      ["value", source.replace("shared.writableValue = 61", "shared.value = 61"), "readonly field"],
      ["missing", source.replace("shared.writableValue = 61", "shared.missing = 61"), "no field"],
      ["slot", source.replace("owner.object.writableValue = 72", "owner.object = object"), "immutable binding"],
      ["nested-readonly", source.replace("owner.object.writableValue = 72", "owner.object.value = 72"), "readonly field"],
      ["nullable-true-arm", source.replace("object == null ? -1 : object.value", "object == null ? object.value : -1"), "nullable receiver"],
      ["nullable-false-arm", source.replace("object != null ? object.value : -2", "object != null ? -2 : object.value"), "nullable receiver"],
      ["nullable-after-join", source.replace("return object != null ? object.value : -2;",
        "const value = object != null ? object.value : -2; return object.value;"), "nullable receiver"],
    ]) {
      assert.throws(() => compileToNative(invalid, fixture));
      const invalidInput = resolve(temporary, `invalid-${name}.zs`);
      writeFileSync(invalidInput, invalid);
      const rejected = spawnSync(oracle, [wire, invalidInput, "", contract], {
        encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr + rejected.stdout, new RegExp(diagnostic));
    }
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
