import { tmpdir } from "node:os";
import { symlinkSync } from "node:fs";
import { assert, cli, compileToNative, diagnostics, hover, completions, decodeSemanticTokens, semanticTokens, semanticTokenTypes, positionForOffset, hostToolchainTest, mkdtempSync, projectRoot,
  readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const fixture = resolve(directory, "objc-selector-execution.zs");
const source = readFileSync(fixture, "utf8");
const contract = resolve(directory, "objc-subclass.h.zd");
const registration = "receiver.registerTarget(receiver, selector: objc.selector(Receiver.receive));";

const cases: [string, string, RegExp][] = [
  ["bare SEL", source.replace("objc.selector(Receiver.receive)", "receiver.bareSelector()"), /requires checked objc.selector/],
  ["bound method", source.replace("objc.selector(Receiver.receive)", "objc.selector(receiver.receive)"), /declaration|explicitly declared/],
  ["invocation", source.replace("objc.selector(Receiver.receive)", "objc.selector(receiver.receive(1))"), /declaration/],
  ["stored selector", source.replace(registration, "const selector = objc.selector(Receiver.receive); receiver.registerTarget(receiver, selector: selector);"), /inline argument/],
  ["string selector", source.replace("objc.selector(Receiver.receive)", 'objc.selector("receive:")'), /declaration/],
  ["missing method", source.replace("objc.selector(Receiver.receive)", "objc.selector()"), /declaration|requires checked/],
  ["nullable target", source.replace(registration, "receiver.registerTarget(null, selector: objc.selector(Receiver.receive));"), /non-null|expected.*(?:id|objc.Object)|cannot.*null/],
  ["inherited method", source.replace("objc.selector(Receiver.receive)", "objc.selector(Receiver.add)"), /explicitly declared/],
  ["object signature", source.replace("objc.selector(Receiver.read)", "objc.selector(Receiver.receive)"), /callback signature/],
  ["compiler-owned selector", source.replace('as "receive:"', 'as "_z_checkedSelectorTarget"'), /compiler-owned native selectors/],
  ["wrong signature", source.replace("value: i32): i32 as", "value: i64): i32 as"), /callback signature|matching numeric|i32.*i64|i64.*i32/],
  ["wrong result", source.replace('value: i32): i32 as', 'value: i32): i64 as'), /callback signature|expected i64|found i32/],
  ["private method", source.replace("function receive", "private function receive"), /private/],
  ["wrong target", source.replace(registration, 'const other = native.ZSubclassFixture.alloc().initWithValue(10); receiver.registerTarget(other, selector: objc.selector(Receiver.receive));'), /selector target must be/],
  ["constructing receiver", source.replace("this.total = value;", "this.total = value; this.registerTarget(this, selector: objc.selector(Receiver.receive));"), /constructing or dying/],
  ["constructing alias", source.replace("this.total = value;", "this.total = value; const alias = this; alias.registerTarget(alias, selector: objc.selector(Receiver.receive));"), /constructing or dying/],
  ["dying receiver", source.replace("private total: i32;", 'private total: i32; deinit { this.registerTarget(this, selector: objc.selector(Receiver.receive)); }'), /dying receiver/],
  ["indirect dying receiver", source.replace("private total: i32;", "private total: i32; deinit { registerReceiver(this); }")
    + "\nfunction registerReceiver(in receiver: Receiver): void on thread.main { " + registration + " }", /dying receiver/],
  ["off main", source.replace("function exercise(): i32 on thread.main", "function exercise(): i32"), /thread.main|main.thread/],
];

hostToolchainTest("checks selector declaration evidence and surfaces the intrinsic in the editor", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, fixture), []);
  const at = source.indexOf("objc.selector") + 5;
  assert.match(hover(source, fixture, at)?.contents.value ?? "", /checked declaration reference/);
  const prefix = source.slice(0, at + 3);
  assert.ok(completions(prefix, fixture, prefix.length).some((entry) => entry.label === "selector"));
  const reference = source.indexOf("Receiver.receive");
  assert.match(hover(source, fixture, reference + "Receiver.".length)?.contents.value ?? "", /native selector declaration reference/);
  const partial = source.replace("Receiver.receive)", "Receiver.re)");
  const suggested = completions(partial, fixture, reference + "Receiver.re".length).find((entry) => entry.label === "receive");
  assert.equal(suggested?.insertText, "receive", "selector completion must not insert a method invocation");
  const emptyMember = source.replace("Receiver.receive)", "Receiver.)");
  assert.equal(completions(emptyMember, fixture, reference + "Receiver.".length)
    .find((entry) => entry.label === "receive")?.insertText, "receive");
  const tokens = decodeSemanticTokens(semanticTokens(source, fixture).data);
  for (const [offset, word, kind] of [[reference, "Receiver", "class"], [reference + "Receiver.".length, "receive", "method"]] as const) {
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => token.line === position.line && token.character === position.character
      && token.length === word.length && semanticTokenTypes[token.type] === kind), `${word} must be highlighted as ${kind}`);
  }
  for (const [name, candidate, expected] of cases) assert.throws(() => compileToNative(candidate, fixture), expected, name);
});

hostToolchainTest("executes checked target/selector pairs and explicit invalidation independently in both compilers", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-selector-execution-"));
  try {
    symlinkSync(resolve(directory, "objc-subclass.h"), resolve(temporary, "objc-subclass.h"));
    symlinkSync(contract, resolve(temporary, "objc-subclass.h.zd"));
    const oracleSource = resolve(directory, "self-host-objc-subclass-execution.zs");
    const emission = spawnSync(process.execPath, [cli, "self-host-emit", oracleSource], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 24 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const oracle = resolve(temporary, "emitter");
    const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", oracle], {
      encoding: "utf8", input: emission.stdout, timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(built.status, 0, built.stderr);
    const wire = resolve(temporary, "native.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams([{
      kind: "import", moduleName: "native", bindings: null, header: "./objc-subclass.h",
      location: { fileName: fixture, offset: 0, line: 1, column: 1 },
    }], fixture, [directory]).get("native")!);
    const input = resolve(temporary, "input.zs");
    const native = (text: string, companion = "") => {
      writeFileSync(input, text);
      return spawnSync(oracle, [wire, input, companion, contract], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 });
    };
    const indirect = source.replace("this.total = value;", "this.total = value; registerReceiver(this);")
      + "\nfunction registerReceiver(in receiver: Receiver): void on thread.main { " + registration + " }";
    const split = source.indexOf("function exercise");
    const companion = resolve(temporary, "receiver.zs");
    writeFileSync(companion, source.slice(0, split).replace("class Receiver", "export class Receiver"));
    const crossModule = 'import native from "./objc-subclass.h"; import objc from "std/objc"; import { thread } from "std/thread"; import { Receiver as Listener } from "./receiver.zs";\n'
      + source.slice(split).replaceAll("Receiver", "Listener");
    for (const [label, candidate, companionPath, expected] of [
      ["ordinary", source, "", 0], ["indirect-construction", indirect, "", 86], ["imported", crossModule, companion, 0],
    ] as const) {
      const stage0 = compileToNative(candidate, input).source;
      const emitted = native(candidate, companionPath);
      assert.equal(emitted.status, 0, `${label}: ${emitted.stderr}`);
      for (const [compiler, text] of [["stage0", stage0], ["native", emitted.stdout]]) {
        assert.match(text, /@selector\(receive:\)/);
        assert.match(text, /_z_checkedSelectorTarget/);
        const generated = resolve(temporary, `${label}-${compiler}.m`);
        writeFileSync(generated, text);
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(temporary, "probe");
          const built = spawnSync("clang", [optimization, "-fobjc-arc", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all",
            "-I", directory, "-framework", "Foundation", generated, resolve(directory, "objc-subclass.m"), "-o", executable], {
            encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
          });
          assert.equal(built.status, 0, `${label} ${compiler}: ${built.stderr}`);
          const result = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
          assert.equal(result.status, expected, `${label} ${compiler}: ${result.stderr} ${result.signal}`);
          if (expected === 86) assert.match(result.stderr, /Ready native target/);
        }
      }
    }
    for (const [name, candidate, expected] of cases) {
      const rejected = native(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stderr}`);
      assert.match(rejected.stderr, expected, `${name}: ${rejected.stderr}`);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);
