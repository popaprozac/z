import {
  assert, cli, compileToC, hostToolchainTest, mkdtempSync, resolve, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

hostToolchainTest("formats signed pointer-sized template values without narrowing or overflowing", () => {
  const directory = mkdtempSync("/tmp/z-template-scalars-");
  const input = resolve(directory, "main.zs");
  const source = `import console from "std/console";
struct Event {
  clickCount: isize;
  function count(): isize { return this.clickCount; }
}
function main(): i32 {
  const minimum: isize = -9223372036854775808;
  const maximum: isize = 9223372036854775807;
  const zero: isize = 0;
  const event = Event({ clickCount: -42 });
  console.log(\`values: \${minimum}/\${maximum}/\${zero}/\${event.clickCount}/\${event.count()}\`);
  return 0;
}`;
  try {
    writeFileSync(input, source);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    for (const emission of [compileToC(source, input), native.stdout]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, "program");
        const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          input: emission, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        });
        assert.equal(built.status, 0, built.stderr || String(built.error));
        const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        assert.equal(ran.status, 0, ran.stderr || String(ran.error));
        assert.equal(ran.stdout, "values: -9223372036854775808/9223372036854775807/0/-42/-42\n");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
