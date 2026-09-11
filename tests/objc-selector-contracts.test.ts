import { tmpdir } from "node:os";
import { analyzeSource, assert, cli, completions, decodeSemanticTokens, diagnostics, hostToolchainTest, hover, mkdtempSync, positionForOffset, semanticTokens, semanticTokenTypes,
  projectRoot, readFileSync, resolve, resolveForeignFunctionDeclarationStreams, rmSync, spawnSync, writeFileSync,
} from "./support/bootstrap.ts";
import { resolveForeignModules } from "../compiler/src/foreign.ts";

const directory = resolve(projectRoot, "tests/fixtures");
const contractFile = resolve(directory, "objc-selector.h.zd");
const source = readFileSync(contractFile, "utf8");
const imported = [{ kind: "import" as const, moduleName: "native", bindings: null, header: "objc-selector.h",
  location: { fileName: contractFile, offset: 0, line: 1, column: 1 } }];

const cases: [string, string, RegExp][] = [
  ["unknown target", source.replace("target target;", "target absent;"), /unknown.*(target|parameter)/],
  ["scalar target", source.replace(".registerTarget", ".wrongTarget"), /target.*Objective-C object/],
  ["non-selector", source.replace(".registerTarget", ".wrongSelector"), /native SEL parameter/],
  ["missing target", source.replace("target target;", ""), /requires.*target|requires.*context/],
  ["missing signature", source.replace("type (in link: ZSelectorLink) => void on thread.main;", ""), /both target/],
  ["unknown type", source.replace("in link: ZSelectorLink", "in link: Absent"), /unsupported selector callback/],
  ["owned object", source.replace("in link:", "link:"), /requires.*in/],
  ["borrowed scalar", source.replace("ZSelectorLink)", "i32)"), /value passing/],
  ["writable parameter", source.replace("in link:", "inout link:"), /value or in/],
  ["object result", source.replace("=> void", "=> ZSelectorLink"), /unsupported selector callback/],
  ["String result", source.replace("=> void", "=> String"), /unsupported selector callback/],
  ["inferred type", source.replace("in link: ZSelectorLink", "in link: _"), /must be explicit/],
  ["wrong parameter name", source.replace("registerTarget(target:", "registerTarget(other:"), /does not match|unknown.*parameter/],
  ["caller guarantee", source.replace("target target;", "target target; thread caller;"), /cannot mix/],
  ["context", source.replace("target target;", "target target; context target;"), /cannot mix/],
  ["release", source.replace("target target;", "target target; deinit target;"), /cannot mix/],
  ["consumed target", source.replace("registerTarget(target:", "registerTarget(move target:"), /ordinary target/],
  ["borrowed target", source.replace("registerTarget(target:", "registerTarget(in target:"), /ordinary target/],
  ["nullable target", source.replace("target: _,", "target: _ | null,"), /ordinary target/],
  ["duplicate target", source.replace("target target;", "target target; target target;"), /target.*more than once/],
  ["duplicate type", source.replace("invoked repeatedly;", "type () => void on thread.main; invoked repeatedly;"), /more than one native type/],
  ["duplicate binding", source.replace("in link: ZSelectorLink", "in link: ZSelectorLink, in link: ZSelectorLink"), /duplicate selector callback parameter/],
  ["no cardinality", source.replace("invoked repeatedly;", ""), /requires explicit invocation cardinality/],
  ["no executor", source.replace(" on thread.main", ""), /on|thread.main/],
  ["wrong executor", source.replace("thread.main", "thread.any"), /main/],
];

hostToolchainTest("validates explicit SEL callback contracts without treating them as block closures", () => {
  if (process.platform !== "darwin") return;
  assert.deepEqual(diagnostics(source, contractFile), []);
  const modules = resolveForeignModules(imported, contractFile, [directory]);
  const method = modules.get("native")!.interfaces.get("ZSelectorTarget")!.methods.find((method) => method.baseName === "registerTarget")!;
  assert.equal(method.metadata.executorAffinity, null);
  const callback = method.selectorCallbacks?.[0];
  assert.ok(callback);
  assert.equal(callback.targetParameter, 0);
  assert.equal(callback.selectorParameter, 1);
  assert.equal(callback.executorAffinity, "main");
  assert.equal(callback.cardinality, "repeatedly");
  assert.equal(callback.parameters[0].mode, "in");
  assert.equal(callback.parameters[0].type.cName, "ZSelectorLink *");
  assert.throws(() => analyzeSource(`
    import native from "objc-selector.h";
    function register(in object: native.ZSelectorTarget): void {
      const selector = object.callbackSelector();
      object.registerTarget(object, selector: selector);
    }
  `, resolve(directory, "selector-registration-gate.zs"), { requireMain: false }), /selector registration requires checked objc.selector/);
  for (const [name, candidate, expected] of cases) {
    const errors = diagnostics(candidate, contractFile);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0].message, expected, name);
  }
});

hostToolchainTest("checks the same selector contracts independently in native Z", () => {
  if (process.platform !== "darwin") return;
  const temporary = mkdtempSync(resolve(tmpdir(), "z-selector-contracts-"));
  try {
    const decoder = resolve(directory, "objc-selector-contract-decoder.zs");
    const emission = spawnSync(process.execPath, [cli, "self-host-emit", decoder], {
      encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(emission.status, 0, emission.stderr);
    const executable = resolve(temporary, "decoder");
    const compilation = spawnSync("clang", ["-x", "c", "-std=c11", "-O1", "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-", "-o", executable], {
      encoding: "utf8", input: emission.stdout, timeout: 60_000,
    });
    assert.equal(compilation.status, 0, compilation.stderr);
    const wire = resolve(temporary, "input.zfdcl");
    writeFileSync(wire, resolveForeignFunctionDeclarationStreams(imported, contractFile, [directory]).get("native")!);
    const candidatePath = resolve(temporary, "input.zd");
    const run = (candidate: string) => {
      writeFileSync(candidatePath, candidate);
      return spawnSync(executable, [wire, candidatePath], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
    };
    const valid = run(source);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.match(valid.stdout, /void void repeatedly/);
    assert.match(valid.stdout, /in ZSelectorLink ZSelectorLink \*/);
    const scalar = run(source.replace("in link: ZSelectorLink", "phase: ZSelectorPhase, count: i32").replace("=> void", "=> usize").replace("repeatedly", "once"));
    assert.equal(scalar.status, 0, scalar.stdout + scalar.stderr);
    assert.match(scalar.stdout, /usize uintptr_t once/);
    assert.match(scalar.stdout, /value ZSelectorPhase ZSelectorPhase/);
    for (const [name, candidate, expected] of cases) {
      const rejected = run(candidate);
      assert.equal(rejected.status, 1, `${name}: ${rejected.stdout}${rejected.stderr} ${rejected.signal}`);
      assert.match(rejected.stdout + rejected.stderr, expected, name);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 240_000);

hostToolchainTest("explains and completes selector targets and callback types in declaration files", () => {
  if (process.platform !== "darwin") return;
  const target = source.indexOf("target target") + "target ".length;
  assert.match(hover(source, contractFile, target)!.contents.value, /native target receiving selector/);
  const type = source.indexOf("ZSelectorLink");
  assert.match(hover(source, contractFile, type)!.contents.value, /asserted native selector/);
  const selector = source.indexOf("callback selector") + "callback ".length;
  assert.match(hover(source, contractFile, selector)!.contents.value, /not an automatic hop/);
  const targetPrefix = source.slice(0, target + 3);
  assert.ok(completions(targetPrefix, contractFile, targetPrefix.length).some((entry) => entry.label === "target"));
  const typePrefix = source.slice(0, type + 5);
  assert.ok(completions(typePrefix, contractFile, typePrefix.length).some((entry) => entry.label === "ZSelectorLink"));
  const tokens = decodeSemanticTokens(semanticTokens(source, contractFile).data);
  for (const [offset, kind] of [[target, "parameter"], [target - 7, "keyword"], [type, "type"], [source.indexOf("type ("), "keyword"]] as const) {
    const position = positionForOffset(source, offset);
    assert.ok(tokens.some((token) => token.line === position.line && token.character === position.character && token.type === semanticTokenTypes.indexOf(kind)), `${kind} at ${offset}`);
  }
});
