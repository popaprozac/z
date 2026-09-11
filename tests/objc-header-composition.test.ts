import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const fixtures = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(fixtures, "objc-header-composition.zs");
const source = readFileSync(fixture, "utf8");

function command(executable: string, args: string[], input?: string, timeout = 30_000): string {
  const result = spawnSync(executable, args, {
    encoding: "utf8", input, timeout, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}

hostToolchainTest("completes forward native object returns and compares selector types across header imports", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-objc-header-composition-"));
  try {
    for (const header of ["objc-forward.h", "objc-subclass.h", "objc-registration.h"]) {
      symlinkSync(resolve(fixtures, header), resolve(temporary, header));
      if (header === "objc-registration.h") {
        writeFileSync(resolve(temporary, `${header}.zd`), `declare module "./${header}" {}`);
      } else {
        symlinkSync(resolve(fixtures, `${header}.zd`), resolve(temporary, `${header}.zd`));
      }
      writeFileSync(resolve(temporary, `${header}.zfdcl`), resolveForeignFunctionDeclarationStreams([{
        kind: "import", moduleName: header === "objc-forward.h" ? "forward" : "complete", bindings: null, header: `./${header}`,
        location: { fileName: fixture, offset: 0, line: 1, column: 1 },
      }], fixture, [fixtures]).values().next().value!);
    }
    const seed = command(process.execPath, [cli, "self-host-emit", resolve(fixtures, "self-host-objc-header-composition.zs")], undefined, 180_000);
    const oracle = resolve(temporary, "emitter");
    command("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], seed, 60_000);
    const input = resolve(temporary, "main.zs");
    // Both import orders and inferred properties/methods use the same native
    // class identity. Defining-module contracts are not discarded or merged.
    const orders = [source, source.replace('import forward from "./objc-forward.h";\nimport complete from "./objc-subclass.h";',
      'import complete from "./objc-subclass.h";\nimport forward from "./objc-forward.h";')];
    for (const candidate of orders) {
      writeFileSync(input, candidate);
      const native = command(oracle, [temporary, input], undefined, 15_000);
      for (const output of [compileToNative(candidate, input).source, native]) {
        assert.match(output, /@selector\(observe:\)/);
        const generated = resolve(temporary, "main.m");
        writeFileSync(generated, output);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "probe");
          command("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
            "-I", fixtures, "-framework", "Foundation", generated, resolve(fixtures, "objc-forward.m"), resolve(fixtures, "objc-subclass.m"), "-o", executable]);
          command(executable, [], undefined, 5_000);
        }
      }
    }
    for (const [name, candidate, expected] of [
      ["no complete header imported", `import forward from "./objc-forward.h";
        function main(): i32 { const object = forward.ZForwardFactory.makeObject(); return object.value(); }`, /no method|unknown.*(method|member)|no.*value|cannot resolve.*value/],
      ["other native class", source.replaceAll("in object: complete.ZSubclassFixture", "in object: complete.ZSubclassStoredResource"), /registration callback signature/],
      ["nullable callback", source.replace("in object: complete.ZSubclassFixture", "in object: complete.ZSubclassFixture | null")
        .replace("return object.value();", "if (object == null) return 0; return object.value();"), /registration callback signature|borrowed concrete imported object parameters/],
      ["other target", source.replace("factory.registerTarget(reader,", "factory.registerTarget(object,"), /target.*Reader/],
    ] as const) {
      assert.throws(() => compileToNative(candidate, input), expected, name);
      writeFileSync(input, candidate);
      const rejected = spawnSync(oracle, [temporary, input], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" });
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, name);
    }
    // Registration's add-time NSString argument must use the same contextual
    // bridge as ordinary calls. The token owns it beyond the helper's local
    // String lifetime and reuses that native value when unregistering.
    const registration = readFileSync(resolve(fixtures, "objc-registration.zs"), "utf8")
      .replace('from "objc-registration.h"', 'from "./objc-registration.h"');
    const namedRegistration = registration
      .replace("  const registration = objc.register({", '  const name: String = "bridge";\n  const registration = objc.register({')
      .replaceAll('"bridge"),', 'name),');
    for (const candidate of [registration, namedRegistration]) {
      writeFileSync(input, candidate);
      const native = command(oracle, [temporary, input], undefined, 15_000);
      for (const output of [compileToNative(candidate, input).source, native]) {
        const generated = resolve(temporary, "registration.m");
        writeFileSync(generated, output);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "registration");
          command("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror",
            "-fsanitize=undefined", "-fno-sanitize-recover=all", "-I", fixtures,
            "-framework", "Foundation", generated, "-o", executable]);
          assert.equal(command(executable, [], undefined, 5_000),
            "registered bridge\nreceived 42\nunregistered bridge\n");
        }
      }
    }
    const movedRegistration = namedRegistration.replace("  const registration = objc.register({",
      "  const consumed = move name;\n  const registration = objc.register({");
    assert.throws(() => compileToNative(movedRegistration, input), /moved|consumed/);
    writeFileSync(input, movedRegistration);
    const rejectedRegistration = spawnSync(oracle, [temporary, input], {
      encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL",
    });
    assert.equal(rejectedRegistration.status, 1, rejectedRegistration.stderr);
    assert.match(rejectedRegistration.stderr, /moved|consumed/);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("checks the display-link controller and exact interpolation without opening windows", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/objc/smooth-window/main.zs");
  const source = readFileSync(example, "utf8");
  const temporary = mkdtempSync(resolve(tmpdir(), "z-resize-geometry-"));
  try {
    const generated = resolve(temporary, "main.m");
    writeFileSync(generated, compileToNative(source, example).source);
    command("clang", ["-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0", "-fsyntax-only", generated]);
    const math = source.slice(0, source.indexOf("function main():")) + `
      function equal(left: AppKit.NSRect, right: AppKit.NSRect): boolean {
        return left.origin.x == right.origin.x && left.origin.y == right.origin.y
          && left.size.width == right.size.width && left.size.height == right.size.height;
      }
      function main(): i32 {
        const start = AppKit.NSMakeRect(0, 0, 320, 240);
        const target = AppKit.NSMakeRect(160, 80, 640, 480);
        if (!equal(interpolateFrame(start, target, -1), start)) return 1;
        if (!equal(interpolateFrame(start, target, 0), start)) return 2;
        if (!equal(interpolateFrame(start, target, 0.25), AppKit.NSMakeRect(10, 5, 340, 255))) return 3;
        if (!equal(interpolateFrame(start, target, 0.5), AppKit.NSMakeRect(80, 40, 480, 360))) return 4;
        if (!equal(interpolateFrame(start, target, 0.75), AppKit.NSMakeRect(150, 75, 620, 465))) return 5;
        if (!equal(interpolateFrame(start, target, 1), target)) return 6;
        if (!equal(interpolateFrame(start, target, 2), target)) return 7;
        if (!equal(interpolateFrame(target, start, 0.25), AppKit.NSMakeRect(150, 75, 620, 465))) return 8;
        return 0;
      }
    `;
    writeFileSync(generated, compileToNative(math, example).source);
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(temporary, "geometry");
      command("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-framework", "AppKit", "-framework", "QuartzCore", "-framework", "WebKit", generated, "-o", executable]);
      command(executable, [], undefined, 5_000);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 60_000);
