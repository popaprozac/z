import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { test } from "bun:test";

const root = resolve(import.meta.dir, "..");
const clang = spawnSync("which", ["clang"], { encoding: "utf8" }).stdout.trim();
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture() {
  const directory = mkdtempSync("/tmp/z-shared-foreign-cache-");
  const tools = resolve(directory, "tools");
  const output = resolve(directory, "output");
  mkdirSync(tools);
  const log = resolve(directory, "clang.log");
  const wrapper = resolve(tools, "clang");
  writeFileSync(wrapper, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "-ast-dump=json" ]; then printf 'ast\\n' >> ${shellQuote(log)}; fi\ndone\nexec ${shellQuote(clang)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  writeFileSync(resolve(directory, "dependency.h"), "#define CACHE_VALUE 42\n");
  writeFileSync(resolve(directory, "native.h"), '#include "dependency.h"\ntypedef struct NativeRecord { int value; } NativeRecord;\nint cache_value(void);\nvoid record_drop(NativeRecord record);\n');
  for (const name of ["one", "two", "three", "four"]) {
    writeFileSync(resolve(directory, `${name}.zs`), 'import native from "native.h";\n');
  }
  function astCount() {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  }
  async function run(name: string, project?: string, adapter?: string) {
    const artifact = resolve(output, `${name}.zfdcl`);
    // Bound and reap the entire process group, including Clang on a failure.
    await new Promise<void>((accept, reject) => {
      const child = spawn(adapter ?? process.execPath, [
        ...(adapter ? [] : [resolve(root, "compiler/src/foreign-adapter-cli.ts")]),
        resolve(directory, `${name}.zs`), "native.h", artifact,
        ...(project ? [project] : []),
      ], {
        detached: true,
        env: { ...process.env, PATH: `${tools}${delimiter}${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (data) => { stderr += data; });
      const timer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        if (status === 0) accept();
        else reject(new Error(`adapter ${name}: ${status}/${signal}\n${stderr}`));
      });
    });
    return {
      source: readFileSync(artifact, "utf8"),
      key: readFileSync(`${artifact}.meta`, "utf8").trim(),
      dependencies: readFileSync(`${artifact}.deps`, "utf8").split("\0"),
    };
  }
  return { directory, output, run, astCount, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("shares declaration production across independent importing processes", async () => {
  const f = fixture();
  try {
    const first = await f.run("one");
    const second = await f.run("two");
    assert.equal(first.source, second.source);
    assert.equal(first.key, second.key);
    assert.equal(f.astCount(), 1);
    assert.ok(second.dependencies.includes(process.execPath));
    assert.ok(second.dependencies.includes(resolve(root, "compiler/src/foreign-adapter-cli.ts")));
    assert.ok(second.dependencies.includes(resolve(root, "compiler/src/foreign.ts")));
    await f.run("one");
    assert.equal(f.astCount(), 1);

    // A corrupt shared artifact must not be accepted merely for its prefix.
    const shared = resolve(f.output, "shared", `${first.key}.json`);
    const corrupt = JSON.parse(readFileSync(shared, "utf8"));
    corrupt.stream += "corruption";
    writeFileSync(shared, JSON.stringify(corrupt));
    assert.equal((await f.run("three")).source, first.source);
    assert.equal(f.astCount(), 2);
    const repaired = JSON.parse(readFileSync(shared, "utf8"));
    repaired.key = "an older producer key";
    writeFileSync(shared, JSON.stringify(repaired));
    await f.run("four");
    assert.equal(f.astCount(), 3);
    assert.ok(!readdirSync(resolve(f.output, "shared")).some((name) => name.endsWith(".tmp")));
  } finally { f.cleanup(); }
}, 30_000);

test("invalidates transitive macro content and source locations without merging aliases", async () => {
  const f = fixture();
  try {
    const first = await f.run("one");
    assert.ok(first.source.includes("native.NativeRecord"));
    writeFileSync(resolve(f.directory, "two.zs"), 'import other from "native.h";\n');
    const alias = await f.run("two");
    assert.notEqual(alias.key, first.key);
    assert.ok(alias.source.includes("other.NativeRecord"));
    assert.ok(!alias.source.includes("native.NativeRecord"));

    // This macro never appears in a declaration; preprocessing tokens alone
    // used to miss it. It must still invalidate the producer's macro inputs.
    writeFileSync(resolve(f.directory, "dependency.h"), "#define CACHE_VALUE 43\n");
    const changed = await f.run("one");
    assert.notEqual(changed.key, first.key);
    const header = resolve(f.directory, "native.h");
    writeFileSync(header, "// Shift source locations.\n" + readFileSync(header, "utf8"));
    const relocated = await f.run("one");
    assert.notEqual(relocated.key, changed.key);
    assert.notEqual(relocated.source, changed.source);
    assert.equal(f.astCount(), 4);
    assert.ok(relocated.dependencies.includes(resolve(f.directory, "dependency.h")));
  } finally { f.cleanup(); }
}, 30_000);

test("isolates contract evidence and tracks both declaration and header sidecars", async () => {
  const f = fixture();
  try {
    const first = await f.run("one");
    const contract = resolve(f.directory, "native.h.zd");
    writeFileSync(contract, 'declare module "native.h" { export type NativeRecord { move; deinit record_drop; } export function record_drop(move record: _): _; }\n');
    const projected = await f.run("two");
    assert.notEqual(projected.key, first.key);
    // Raw ABI bytes can stay identical; the changed contract still has to be
    // validated, not bypassed by another module's cache hit.
    assert.ok(projected.dependencies.includes(contract));
    assert.equal(f.astCount(), 2);
    assert.equal((await f.run("three")).source, projected.source);
    assert.equal(f.astCount(), 2);
    writeFileSync(contract, "this is not a declaration contract\n");
    await assert.rejects(f.run("two"), /expected|declare/);
    rmSync(contract);
    assert.equal((await f.run("four")).source, first.source);
    assert.equal(f.astCount(), 3);

    const includes = resolve(f.directory, "include");
    mkdirSync(includes);
    writeFileSync(resolve(includes, "external.h"), "int external_value(void);\n");
    const headerContract = resolve(includes, "external.h.zd");
    writeFileSync(headerContract, 'declare module "external.h" { export function external_value(): _; }\n');
    // Include a second contract source in the fingerprint directly, using the
    // exact selector also used by declaration production.
    const { fingerprintForeignFunctionDeclarations } = await import("../compiler/src/foreign.ts");
    const { parse } = await import("../compiler/src/parser.ts");
    const { lex } = await import("../compiler/src/lexer.ts");
    const sourcePath = resolve(f.directory, "external.zs");
    const declaration = parse(lex('import native from "external.h";', sourcePath), sourcePath).imports[0]!;
    const fingerprint = () => fingerprintForeignFunctionDeclarations(declaration, sourcePath, [includes], null, resolve(f.directory, "external.deps.make"));
    const before = fingerprint();
    const localContract = resolve(f.directory, "external.h.zd");
    writeFileSync(localContract, 'declare module "external.h" {}\n');
    const after = fingerprint();
    assert.notEqual(before.value, after.value);
    assert.ok(after.dependencies.includes(headerContract));
    assert.ok(after.dependencies.includes(localContract));
  } finally { f.cleanup(); }
}, 30_000);

test("separates include search order even for identical header bytes", async () => {
  const f = fixture();
  try {
    for (const include of ["a", "b"]) {
      mkdirSync(resolve(f.directory, include));
      writeFileSync(resolve(f.directory, include, "dependency.h"), "#define CACHE_VALUE 42\n");
    }
    // Angle include searches configured directories after the source directory.
    rmSync(resolve(f.directory, "dependency.h"));
    const manifest = resolve(f.directory, "z.json");
    function config(order: string[], minimumVersion?: string) {
      writeFileSync(manifest, JSON.stringify({
        target: { name: "cache-probe", entry: "one.zs", includeDirectories: order, ...(minimumVersion ? { platform: "macos", minimumVersion } : {}) },
      }));
    }
    config(["a", "b"]);
    const first = await f.run("one", manifest);
    config(["b", "a"]);
    const second = await f.run("two", manifest);
    assert.notEqual(first.key, second.key);
    assert.equal(f.astCount(), 2);
    if (process.platform === "darwin") {
      config(["a", "b"], "13.0");
      const target = await f.run("three", manifest);
      assert.notEqual(target.key, first.key);
      config(["a", "b"], "14.0");
      assert.notEqual((await f.run("four", manifest)).key, target.key);
      assert.equal(f.astCount(), 4);
    }
  } finally { f.cleanup(); }
}, 30_000);

test("publishes complete shared entries under concurrent cold producers", async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.run("one"), f.run("two"), f.run("three")]);
    for (const result of results) assert.equal(result.source, results[0]!.source);
    const count = f.astCount();
    assert.ok(count >= 1 && count <= 3);
    assert.equal((await f.run("four")).source, results[0]!.source);
    assert.equal(f.astCount(), count);
    assert.ok(!readdirSync(resolve(f.output, "shared")).some((name) => name.endsWith(".tmp")));
  } finally { f.cleanup(); }
}, 30_000);

test("invalidates an in-process producer after only a dependency changes", async () => {
  const f = fixture();
  try {
    const { writeForeignDeclarationArtifact } = await import("../compiler/src/foreign-adapter.ts");
    const header = resolve(f.directory, "native.h");
    writeFileSync(resolve(f.directory, "dependency.h"), "typedef int CacheScalar;\n");
    writeFileSync(header, readFileSync(header, "utf8") + "CacheScalar cache_scalar(void);\n");
    const source = resolve(f.directory, "one.zs");
    const output = resolve(f.output, "one.zfdcl");
    writeForeignDeclarationArtifact(source, "native.h", output);
    const before = readFileSync(output, "utf8");
    writeFileSync(resolve(f.directory, "dependency.h"), "typedef float CacheScalar;\n");
    writeForeignDeclarationArtifact(source, "native.h", output);
    assert.notEqual(readFileSync(output, "utf8"), before);
  } finally { f.cleanup(); }
});

test("includes built-in API notes in persistent dependency evidence", async () => {
  const f = fixture();
  try {
    const { fingerprintForeignFunctionDeclarations } = await import("../compiler/src/foreign.ts");
    const { parse } = await import("../compiler/src/parser.ts");
    const { lex } = await import("../compiler/src/lexer.ts");
    const source = resolve(f.directory, "stdio.zs");
    const declaration = parse(lex('import io from "stdio.h";', source), source).imports[0]!;
    const evidence = fingerprintForeignFunctionDeclarations(declaration, source, [], null, resolve(f.directory, "stdio.deps.make"));
    assert.ok(evidence.dependencies.includes(resolve(root, "compiler/api-notes/stdio.h.json")));
  } finally { f.cleanup(); }
});

test("records the packaged producer executable as a build dependency", async () => {
  const f = fixture();
  try {
    const adapter = resolve(f.directory, "z-foreign-adapter");
    const compiled = spawnSync(process.execPath, [
      "build", resolve(root, "compiler/src/foreign-adapter-cli.ts"), "--compile", "--outfile", adapter,
    ], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr);
    const first = await f.run("one", undefined, adapter);
    for (const path of first.dependencies.filter(Boolean)) {
      assert.ok(existsSync(path), `dependency must exist outside the bundled producer: ${path}`);
    }
    assert.ok(first.dependencies.some((path) => path && realpathSync(path) === realpathSync(adapter)), first.dependencies.join("\n"));
    const second = await f.run("two", undefined, adapter);
    assert.equal(first.source, second.source);
    assert.equal(f.astCount(), 1);
  } finally { f.cleanup(); }
}, 60_000);
