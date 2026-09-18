import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";
import { completions, diagnostics } from "../compiler/src/language-service.ts";

const fixtures = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(fixtures, "objc-optional-overrides.zs");

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

hostToolchainTest("checks optional inherited Objective-C callbacks without promising superclass implementations", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync("/tmp/z-objc-optional-overrides-");
  try {
    const source = readFileSync(fixture, "utf8");
    assert.deepEqual(diagnostics(source, fixture), []);
    const wire = resolve(temporary, "native.zfdcl");
    const contract = resolve(temporary, "native.zd");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "objc-optional-overrides.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [fixtures]).get("native")!);
    writeFileSync(contract, 'declare module "objc-optional-overrides.h" {}');
    const seed = command(process.execPath, [cli, "self-host-emit",
      resolve(fixtures, "self-host-objc-subclass-execution.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    const native = command(oracle, [wire, fixture, "", contract]);
    for (const [name, output] of [["stage0", compileToNative(source, fixture).source], ["native", native]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(temporary, `${name}${optimization}`);
        command("clang", ["-x", "objective-c", "-fobjc-arc", "-fblocks", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures,
          "-framework", "Foundation", "-", "-o", executable], output);
        command(executable, [], undefined, 5_000);
        for (const phase of [1, 2]) {
          const guarded = spawnSync(executable, [], {
            encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
            env: { ...process.env, Z_CALLBACK_PHASE: String(phase) },
          });
          assert.equal(guarded.status, 90 + phase, guarded.stderr);
          assert.match(guarded.stderr, /native callback entered before Ready or during teardown/);
        }
      }
    }
    for (const [name, candidate, expected] of [
      ["missing override", source.replace("override function accept", "function accept"), /requires.*override/],
      ["wrong result", source.replace('i32 as "acceptInfo:"', 'boolean as "acceptInfo:"'), /returns/],
      ["wrong parameter", source.replace("in info: native.ZDropInfo", "in info: native.ZCallbackBase"), /parameter.*expects/],
      ["unimplemented super", source.replace("return value + 7;", "return super.acceptInfo(info);"), /no method|superclass call must resolve/],
      ["unimplemented ordinary call", source.replace("return 0;", "return target.missingValue();"), /no method|unknown method|cannot resolve/],
      ["unimplemented getter", source.replace("const value = info.value;", "const value = info.missing;"), /no field|no .*property|no member|cannot resolve|unknown/],
    ] as const) {
      assert.throws(() => compileToNative(candidate, fixture), expected, name);
      const input = resolve(temporary, `${name.replaceAll(" ", "-")}.zs`);
      writeFileSync(input, candidate);
      const result = spawnSync(oracle, [wire, input, "", contract], {
        encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
      });
      assert.equal(result.status, 1, `${name}: ${result.stderr}`);
      assert.match(result.stderr, expected, name);
      assert.doesNotMatch(result.stderr, /internal compiler error/, name);
    }
    const callOffset = source.indexOf("target.inherited()") + "target.".length;
    const items = completions(source, fixture, callOffset);
    assert.ok(items.some((item) => item.label === "accept"));
    assert.ok(items.some((item) => item.label === "optionalValue"));
    assert.ok(!items.some((item) => item.label === "missingValue"));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
