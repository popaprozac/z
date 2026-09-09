import {
  assert, check, cli, compileToC, mkdtempSync, projectRoot, readFileSync,
  resolve, rmSync, spawnSync, test, writeFileSync,
} from "./support/bootstrap.ts";

function resolveNative(input: string) {
  return spawnSync(process.execPath, [cli, "self-host-resolve", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
}

test("rejects partial extraction through custom cleanup in both semantic frontends", () => {
  const directory = mkdtempSync("/tmp/z-destructure-cleanup-");
  try {
    const fixture = resolve(projectRoot, "tests/fixtures/struct-destructure-custom-cleanup.zs");
    assert.throws(() => check(readFileSync(fixture, "utf8"), fixture), /custom or foreign cleanup storage/);
    const result = resolveNative(fixture);
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.match(result.stderr, /custom or foreign cleanup storage/);
    assert.match(result.stderr, /error\[Z0220\]/);
    assert.match(result.stderr, /:13:3:/);

    const definitions = `
import { Map, Set } from "std/collections";
import { Hashable, Hasher } from "std/hash";
struct Resource { id: i32; deinit {} }
readonly struct ResourceKey implements Hashable {
  id: i32;
  deinit {}
  function equals(in other: ResourceKey): boolean { return this.id == other.id; }
  function hash(inout hasher: Hasher): void { hasher.add(this.id); }
}
struct Nested { item: Resource; }
enum Choice { some Resource, none, }
struct Envelope<T> { value: T; }
type Renamed = Resource;
`;
    for (const [name, fieldType] of [
      ["direct", "Resource"],
      ["nested", "Nested"],
      ["alias", "Renamed"],
      ["array", "Array<Resource>"],
      ["readonly-array", "readonly Array<Resource>"],
      ["map-value", "Map<String, Resource>"],
      ["readonly-map-value", "readonly Map<String, Resource>"],
      ["map-key", "Map<ResourceKey, i32>"],
      ["set-element", "Set<ResourceKey>"],
      ["fixed-array", "Resource[2]"],
      ["optional", "Option<Resource>"],
      ["result-error", "Result<i32, Resource>"],
      ["enum", "Choice"],
      ["generic", "Envelope<Resource>"],
      ["nested-generic", "Envelope<Envelope<Resource>>"],
      ["generic-array", "Envelope<Array<Renamed>>"],
      ["generic-map-value", "Envelope<Map<String, Renamed>>"],
    ]) {
      const input = resolve(directory, `${name}.zs`);
      const source = `${definitions}
struct Batch { safe: i32; value: ${fieldType}; }
function split(batch: Batch): i32 {
  const { safe } = move batch;
  return safe;
}
function main(): i32 { return 0; }
`;
      writeFileSync(input, source);
      assert.throws(() => check(source, input), /custom or foreign cleanup storage/, name);
      const native = resolveNative(input);
      assert.equal(native.status, 1, `${name}: ${native.stderr || String(native.error)}`);
      assert.match(native.stderr, /custom or foreign cleanup storage/, name);
    }
    for (const source of [
      "struct Batch { safe: i32; deinit {} }",
      "struct Value { safe: i32; deinit {} } type Batch = Value;",
    ]) {
      const input = resolve(directory, "root.zs");
      const program = `${source}\nfunction split(batch: Batch): i32 {
  const { safe } = move batch; return safe;
}\nfunction main(): i32 { return 0; }`;
      writeFileSync(input, program);
      assert.throws(() => check(program, input), /defines deinit/);
      const native = resolveNative(input);
      assert.equal(native.status, 1, native.stderr || String(native.error));
      assert.match(native.stderr, /defines deinit/);
    }

    const closureInput = resolve(directory, "captured-callback.zs");
    const closureSource = `
struct Resource { id: i32; deinit {} }
struct Batch { first: Resource; second: Resource; }
function main(): i32 {
  const id = 42;
  const callback = move (): void => {
    const batch = Batch({ first: Resource({ id }), second: Resource({ id: 1 }) });
    const { first } = move batch;
  };
  callback();
  return 0;
}
`;
    writeFileSync(closureInput, closureSource);
    assert.throws(() => check(closureSource, closureInput), /custom or foreign cleanup storage/);
    const closure = resolveNative(closureInput);
    assert.equal(closure.status, 1, closure.stderr || String(closure.error));
    assert.match(closure.stderr, /custom or foreign cleanup storage/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("rebases cleanup graphs through imported aliases and concrete generic fields", () => {
  const directory = mkdtempSync("/tmp/z-destructure-imports-");
  try {
    writeFileSync(resolve(directory, "resource.zs"), `
export struct Resource { id: i32; deinit {} }
export type Alias = Resource;
`);
    writeFileSync(resolve(directory, "envelope.zs"), `
export struct Envelope<T> { safe: i32; value: T; }
`);
    const input = resolve(directory, "main.zs");
    const source = `
import { Alias } from "./resource.zs";
import { Envelope } from "./envelope.zs";
struct Resource { id: i32; } // Same spelling, different nominal identity.
function split(batch: Envelope<Alias>): i32 {
  const { safe } = move batch; return safe;
}
function main(): i32 { return 0; }
`;
    writeFileSync(input, source);
    const stage0 = spawnSync(process.execPath, [cli, "check", input], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(stage0.status, 1, stage0.stderr || String(stage0.error));
    assert.match(stage0.stderr, /custom or foreign cleanup storage/);
    const native = resolveNative(input);
    assert.equal(native.status, 1, native.stderr || String(native.error));
    assert.match(native.stderr, /custom or foreign cleanup storage/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("preserves supported value, ARC, and phantom-generic object extraction", () => {
  const input = resolve(projectRoot, "tests/fixtures/struct-destructure-supported-cleanup.zs");
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr || String(native.error));
  const directory = mkdtempSync("/tmp/z-destructure-supported-");
  try {
    for (const source of [compileToC(readFileSync(input, "utf8"), input), native.stdout]) {
      const binary = resolve(directory, "program");
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-O1", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", binary],
        { input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(run.status, 0, run.stderr || String(run.error));
      assert.equal(run.stdout, "released shared\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
