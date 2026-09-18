import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Header lookup must survive moving the generated C away from its Z modules. */
export function exerciseModuleHeaderBuilds(
  command: readonly string[],
  nativeCache = false,
): void {
  const directory = mkdtempSync("/tmp/z-module-headers-");
  const project = resolve(directory, "project with spaces");
  const entry = resolve(project, "source");
  const nested = resolve(entry, "nested");
  const includes = resolve(project, "configured headers");
  const manifest = resolve(project, "z.json");
  const dependency = resolve(nested, "factor.h");
  const header = resolve(nested, "ticks.h");
  const execute = (binary: string, args: string[], status = 0) => {
    const result = spawnSync(binary, args, {
      cwd: directory, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, status, `${binary} ${args.join(" ")}\n${result.stdout}${result.stderr}${result.error ?? result.signal ?? ""}`);
    return result;
  };
  const run = (args: string[], status = 0) => execute(command[0]!, [...command.slice(1), ...args], status);
  const configure = (kind: string, source: string) => writeFileSync(manifest, JSON.stringify({
    target: { name: "headers", kind, entry: `source/${source}`, includeDirectories: ["configured headers"] },
  }));
  const headerSource = `#ifndef MODULE_TICKS_H
#define MODULE_TICKS_H
#include "factor.h"
static inline int module_ticks(int value) { return value * MODULE_FACTOR; }
#endif
`;
  try {
    mkdirSync(nested, { recursive: true });
    mkdirSync(includes);
    writeFileSync(dependency, "#define MODULE_FACTOR 2\n");
    writeFileSync(header, headerSource);
    writeFileSync(resolve(entry, "entry.h"), "static inline int entry_value(void) { return 40; }\n");
    writeFileSync(resolve(includes, "configured.h"), "static inline int configured_value(void) { return 2; }\n");
    writeFileSync(resolve(nested, "bare.zs"), `
import native from "ticks.h";
export function bare(): i32 { return native.module_ticks(21); }
`);
    writeFileSync(resolve(nested, "relative.zs"), `
import native from "./ticks.h";
export function relative(): i32 { return native.module_ticks(21); }
`);
    const imports = `
import native from "entry.h";
import configured from "configured.h";
import { bare } from "./nested/bare.zs";
import { relative } from "./nested/relative.zs";
`;
    const sum = "native.entry_value() + configured.configured_value() + bare() + relative()";
    writeFileSync(resolve(entry, "main.zs"), `${imports}\nfunction main(): i32 { return ${sum} - 126; }\n`);
    writeFileSync(resolve(entry, "library.zs"), `${imports}\nexport c function header_answer(): i32 { return ${sum}; }\n`);

    configure("executable", "main.zs");
    run(["check", project]);
    run(["run", project]);
    run(["build", project, "--release"]);
    const executable = resolve(project, "build/headers");
    execute(executable, []);
    const cached = run(["build", project, "--release"]);
    if (nativeCache) assert.match(cached.stdout, /cache hit:/);

    // The adapter's transitive header evidence must invalidate a warm build.
    writeFileSync(dependency, "#define MODULE_FACTOR 3\n");
    const changed = run(["build", project, "--release"]);
    if (nativeCache) assert.doesNotMatch(changed.stdout, /cache hit:/);
    execute(executable, [], 42);
    run(["run", project], 42);
    writeFileSync(dependency, "#define MODULE_FACTOR 2\n");

    // Exercise each final compiler-argument path, then link a real C consumer.
    const consumer = resolve(directory, "consumer.c");
    writeFileSync(consumer, `#include "headers.h"
#include <stddef.h>
int main(void) {
  if (headers_runtime_initialize(NULL) != HEADERS_RUNTIME_OK) return 1;
  const int answer = header_answer();
  if (headers_runtime_shutdown() != HEADERS_RUNTIME_OK) return 2;
  return answer == 126 ? 0 : 3;
}
`);
    for (const kind of ["static-library", "shared-library"]) {
      configure(kind, "library.zs");
      run(["build", project, "--release"]);
      const extension = kind === "static-library" ? ".a" : process.platform === "darwin" ? ".dylib" : ".so";
      const library = resolve(project, `build/libheaders${extension}`);
      const output = resolve(directory, `consumer-${kind}`);
      execute("clang", ["-Wall", "-Wextra", "-Werror", "-I", resolve(project, "build"), consumer, library, "-o", output]);
      execute(output, []);
    }

    // A cached successful build must not mask a subsequently missing header.
    rmSync(header);
    const missing = run(["build", project, "--release"], 1);
    assert.match(missing.stderr, /ticks\.h/);
    if (nativeCache) assert.doesNotMatch(missing.stdout, /cache hit:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
