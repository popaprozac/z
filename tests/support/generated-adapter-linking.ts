import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The same source/overlay contract must work in Stage 0 and the native driver. */
export function exerciseGeneratedAdapterLinking(command: readonly string[]): void {
  const directory = mkdtempSync("/tmp/z-generated-linking-");
  const application = resolve(directory, "application");
  const framework = resolve(directory, "framework");
  const generated = resolve(directory, "generated");
  const entryFile = resolve(application, "main.zs");
  const registrationFile = resolve(application, "registration.zs");
  const adapterFile = resolve(generated, "adapters.zs");
  const overlayFile = resolve(generated, "services.zbuild.json");
  const entrySource = `
import console from "std/console";
import { Builder } from "framework";
import { registerOther } from "./registration.zs";
export const BONUS: i32 = 1;
export struct Payload {
  value: i32;
  deinit { console.log(\`\${this.value}\`); }
}
function answer(): Payload {
  console.log("101");
  return Payload({ value: 41 });
}
function main(): i32 {
  let builder = Builder({ result: 0 });
  builder.register("answer", answer());
  builder.register("second", Payload({ value: 5 }));
  registerOther(inout builder);
  return builder.result - 56;
}
`;
  const registrationSource = `
import console from "std/console";
import { Builder } from "framework";
export struct OtherPayload {
  value: i32;
  deinit { console.log(\`\${this.value}\`); }
}
export function registerOther(inout builder: Builder): void {
  builder.register("other", OtherPayload({ value: 7 }));
}
`;
  const adapterSource = `
import { Payload, BONUS } from "../application/main.zs";
import { OtherPayload } from "../application/registration.zs";
import { EXTRA } from "./constants.zs";
export function adapt(value: Payload): i32 { return value.value + BONUS + EXTRA; }
export function adaptOther(value: OtherPayload): i32 { return value.value + BONUS; }
`;
  const adapter = (source: string, sourceText: string, marker: string, exported: string) => ({
    source,
    sourceHash: createHash("sha256").update(sourceText).digest("hex"),
    offset: sourceText.indexOf(marker),
    target: "Builder.register",
    replacement: "Builder.install",
    argument: 1,
    adapter: { module: "framework/generated/services", export: exported },
  });
  const overlay = (source = entrySource) => ({
    schemaVersion: 1,
    modules: { "framework/generated/services": { source: "adapters.zs", package: "framework" } },
    callAdapters: [
      adapter("../application/main.zs", source, '("answer"', "adapt"),
      adapter("../application/main.zs", source, '("second"', "adapt"),
      adapter("../application/registration.zs", registrationSource, '("other"', "adaptOther"),
    ],
  });
  const run = (operation: string) => spawnSync(command[0]!, [
    ...command.slice(1), operation, application, "--generated", overlayFile,
  ], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
  const rejected = (pattern: RegExp) => {
    const result = run("check");
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.match(result.stderr, pattern);
  };
  try {
    for (const dir of [application, framework, generated]) mkdirSync(dir);
    writeFileSync(resolve(framework, "z.json"), JSON.stringify({
      package: { name: "framework", version: "0.1.0" }, library: { entry: "framework.zs" },
    }));
    writeFileSync(resolve(framework, "framework.zs"), `
export struct Builder {
  result: i32;
  function register<T>(inout this, name: String, value: T): void {}
  internal function install(inout this, name: String, value: i32): void {
    this.result = this.result + value;
  }
}
`);
    writeFileSync(resolve(application, "z.json"), JSON.stringify({
      dependencies: { framework: { path: "../framework" } },
      target: { name: "generated-linking", entry: "main.zs" },
    }));
    writeFileSync(entryFile, entrySource);
    writeFileSync(registrationFile, registrationSource);
    writeFileSync(adapterFile, adapterSource);
    writeFileSync(resolve(generated, "constants.zs"), "export const EXTRA: i32 = 0;\n");
    writeFileSync(overlayFile, JSON.stringify(overlay()));

    // Same-entry nominal types/constants, multiple links, imported call sites,
    // and exactly-once evaluation/destruction of each move-only argument.
    const executed = run("run");
    assert.equal(executed.status, 0, executed.stderr || String(executed.error));
    assert.equal(executed.stdout.replace(/^compiled [0-9]+ Z modules to [^\n]+\n/, ""), "101\n41\n5\n7\n");
    const built = run("build");
    assert.equal(built.status, 0, built.stderr);
    const cached = run("build");
    assert.equal(cached.status, 0, cached.stderr);
    // An ordinary dependency reachable only through generated code must remain
    // an input after reuse, not disappear from cache invalidation.
    writeFileSync(resolve(generated, "constants.zs"), "export const EXTRA: i32 = 2;\n");
    const changed = run("run");
    assert.equal(changed.status, 4, changed.stderr || String(changed.error));
    assert.equal(changed.stdout.replace(/^compiled [0-9]+ Z modules to [^\n]+\n/, ""), "101\n41\n5\n7\n");
    writeFileSync(resolve(generated, "constants.zs"), "export const EXTRA: i32 = 0;\n");

    // Provenance is not a generated-looking identifier or filename. A real
    // authored import into the adapter creates a real source cycle.
    const cyclicEntry = entrySource + '\nimport { adapt as __z_generated_call_adapter_0 } from "framework/generated/services";\n';
    writeFileSync(entryFile, cyclicEntry);
    writeFileSync(overlayFile, JSON.stringify(overlay(cyclicEntry)));
    rejected(/circular Z module import/);
    writeFileSync(entryFile, entrySource);
    writeFileSync(overlayFile, JSON.stringify(overlay()));

    // Ordinary cycles that are only discovered via a generated root still fail.
    writeFileSync(resolve(generated, "constants.zs"), 'import { adapt } from "./adapters.zs";\nexport const EXTRA: i32 = 0;\n');
    rejected(/circular Z module import/);
    writeFileSync(resolve(generated, "constants.zs"), "export const EXTRA: i32 = 0;\n");

    writeFileSync(adapterFile, adapterSource.replace("export function adapt(", "function adapt("));
    rejected(/no export.*adapt|does not export.*adapt/);
    writeFileSync(adapterFile, adapterSource);
    const privateEntry = entrySource.replace("export struct Payload", "struct Payload");
    writeFileSync(entryFile, privateEntry);
    writeFileSync(overlayFile, JSON.stringify(overlay(privateEntry)));
    rejected(/no export.*Payload|does not export.*Payload/);
    writeFileSync(entryFile, entrySource);
    writeFileSync(overlayFile, JSON.stringify(overlay()));

    writeFileSync(adapterFile, adapterSource.replace("return value.value + BONUS + EXTRA;", 'return "wrong";'));
    rejected(/expected i32.*String|String.*i32/);
    writeFileSync(adapterFile, adapterSource);
    // Ordinary initialization restrictions are unchanged by adapter discovery.
    writeFileSync(resolve(generated, "constants.zs"), "function value(): i32 { return 0; }\nexport const EXTRA: i32 = value();\n");
    rejected(/constant.*literal initializer/);

    // Real service adapters return a generated ARC implementation, not a scalar.
    // The caller's generic replacement observes that nominal type before the
    // generated module's bodies have been lowered. It still owns each input once.
    writeFileSync(resolve(generated, "constants.zs"), "export const EXTRA: i32 = 0;\n");
    writeFileSync(resolve(framework, "framework.zs"), `
export trait Readable { function read(): i32; }
export struct Builder {
  result: i32;
  function register<T>(inout this, name: String, value: T): void {}
  internal function install<T: Readable>(inout this, name: String, value: T): void {
    this.result = this.result + value.read();
  }
}
`);
    writeFileSync(adapterFile, `
import { Payload, BONUS } from "../application/main.zs";
import { OtherPayload } from "../application/registration.zs";
import { Readable } from "framework";
export readonly class Adapter implements Readable {
  payload: Payload;
  function read(): i32 { return this.payload.value + BONUS; }
}
export readonly class OtherAdapter implements Readable {
  payload: OtherPayload;
  function read(): i32 { return this.payload.value + BONUS; }
}
export function adapt(value: Payload): Adapter { return new Adapter({ payload: move value }); }
export function adaptOther(value: OtherPayload): OtherAdapter { return new OtherAdapter({ payload: move value }); }
`);
    const ownedResult = run("run");
    assert.equal(ownedResult.status, 0, ownedResult.stderr || String(ownedResult.error));
    assert.equal(ownedResult.stdout.replace(/^compiled [0-9]+ Z modules to [^\n]+\n/, ""), "101\n41\n5\n7\n");
    const emitted = run("emit");
    assert.equal(emitted.status, 0, emitted.stderr);
    const sanitizedBinary = resolve(directory, "owned-adapters-ubsan");
    const compiled = spawnSync("clang", [
      "-x", "c", "-std=c11", "-O1", "-g", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", sanitizedBinary,
    ], { encoding: "utf8", input: emitted.stdout, timeout: 30_000, killSignal: "SIGKILL" });
    assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
    const sanitized = spawnSync(sanitizedBinary, [], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(sanitized.status, 0, sanitized.stderr || String(sanitized.error));
    assert.equal(sanitized.stdout, "101\n41\n5\n7\n");
    assert.equal(sanitized.stderr, "");

    // Specializations are globally deduplicated, but every adapted caller
    // (including the imported registration module) needs the result ABI.
    writeFileSync(adapterFile, `
import { Payload, BONUS } from "../application/main.zs";
import { OtherPayload } from "../application/registration.zs";
import { Readable } from "framework";
export readonly class Adapter implements Readable {
  value: i32;
  function read(): i32 { return this.value; }
}
export function adapt(value: Payload): Adapter { return new Adapter({ value: value.value + BONUS }); }
export function adaptOther(value: OtherPayload): Adapter { return new Adapter({ value: value.value + BONUS }); }
`);
    const sharedResult = run("run");
    assert.equal(sharedResult.status, 0, sharedResult.stderr || String(sharedResult.error));
    assert.equal(sharedResult.stdout.replace(/^compiled [0-9]+ Z modules to [^\n]+\n/, ""), "101\n41\n5\n7\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
