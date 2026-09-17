import {
  assert, cli, compileToC, hostToolchainTest, mkdtempSync, resolve, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

hostToolchainTest("formats all integer template widths without narrowing or overflowing", () => {
  const directory = mkdtempSync("/tmp/z-template-scalars-");
  const input = resolve(directory, "main.zs");
  const source = `import console from "std/console";
struct Event {
  clickCount: isize;
  displayId: u32;
  function count(): isize { return this.clickCount; }
  function identity(): u32 { return this.displayId; }
}
type DisplayId = u32;
function main(): i32 {
  const minimum: isize = -9223372036854775808;
  const maximum: isize = 9223372036854775807;
  const zero: isize = 0;
  const event = Event({ clickCount: -42, displayId: 4294967295 });
  console.log(\`values: \${minimum}/\${maximum}/\${zero}/\${event.clickCount}/\${event.count()}\`);
  const low8: i8 = -128; const high8: i8 = 127;
  const low16: i16 = -32768; const high16: i16 = 32767;
  const highU8: u8 = 255; const highU16: u16 = 65535;
  const highU32: DisplayId = 4294967295; const zeroU32: u32 = 0;
  console.log(\`integers: \${low8}/\${high8}/\${low16}/\${high16}/\${highU8}/\${highU16}/\${highU32}/\${zeroU32}/\${event.displayId}/\${event.identity()}\`);
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
        assert.equal(ran.stdout, "values: -9223372036854775808/9223372036854775807/0/-42/-42\n"
          + "integers: -128/127/-32768/32767/255/65535/4294967295/0/4294967295/4294967295\n");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
