import {
  assert,
  cli,
  existsSync,
  mkdtempSync,
  projectRoot,
  readFileSync,
  resolve,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("associates z.json with the implemented project-manifest schema", () => {
  const packagePath = resolve(projectRoot, "editors/vscode/package.json");
  const schemaPath = resolve(
    projectRoot,
    "editors/vscode/schemas/z.schema.json",
  );
  const extension = JSON.parse(readFileSync(packagePath, "utf8")) as {
    readonly contributes?: {
      readonly jsonValidation?: readonly {
        readonly fileMatch?: readonly string[];
        readonly url?: string;
      }[];
    };
  };
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    readonly required?: readonly string[];
    readonly properties?: {
      readonly target?: {
        readonly required?: readonly string[];
        readonly properties?: {
          readonly kind?: { readonly enum?: readonly string[] };
          readonly swift?: {
            readonly properties?: {
              readonly interop?: { readonly enum?: readonly string[] };
            };
          };
        };
      };
    };
  };

  assert.deepEqual(extension.contributes?.jsonValidation, [{
    fileMatch: ["z.json"],
    url: "./schemas/z.schema.json",
  }]);
  assert.deepEqual(schema.required, ["target"]);
  assert.deepEqual(schema.properties?.target?.required, ["name", "entry"]);
  assert.deepEqual(schema.properties?.target?.properties?.kind?.enum, [
    "executable",
    "static-library",
    "shared-library",
  ]);
  assert.deepEqual(
    schema.properties?.target?.properties?.swift?.properties?.interop?.enum,
    ["objc", "cxx"],
  );
});

function writeManifest(
  directory: string,
  target: Record<string, unknown>,
): string {
  const manifest = resolve(directory, "z.json");
  writeFileSync(manifest, JSON.stringify({ target }));
  return manifest;
}

function invoke(
  arguments_: readonly string[],
  cwd?: string,
) {
  return spawnSync(process.execPath, [cli, ...arguments_], {
    cwd,
    encoding: "utf8",
  });
}

test("requires a named entry for every discovered project target", () => {
  const directory = mkdtempSync("/tmp/z-project-required-fields-");
  const entry = resolve(directory, "main.zs");
  writeFileSync(entry, "function main(): i32 { return 0; }\n");

  writeManifest(directory, { entry: "main.zs" });
  const missingName = invoke(["check", directory]);
  assert.equal(missingName.status, 1);
  assert.match(missingName.stderr, /targets require target\.name/);

  writeManifest(directory, { name: "required-fields" });
  const missingEntry = invoke(["check", directory]);
  assert.equal(missingEntry.status, 1);
  assert.match(missingEntry.stderr, /targets require target\.entry/);

  writeManifest(directory, { name: "required-fields", entry: "main.zs" });
  const configured = invoke(["check", resolve(directory, "z.json")]);
  assert.equal(configured.status, 0, configured.stderr);

  writeManifest(directory, {
    kind: "dynamic-library",
    name: "required-fields",
    entry: "main.zs",
  });
  const invalidKind = invoke(["check", directory]);
  assert.equal(invalidKind.status, 1);
  assert.match(
    invalidKind.stderr,
    /target\.kind must be "executable", "static-library", or "shared-library"/,
  );

  writeManifest(directory, {
    name: "required-fields",
    entry: "main.zs",
    artifact: "typo",
  });
  const unknownField = invoke(["check", directory]);
  assert.equal(unknownField.status, 1);
  assert.match(
    unknownField.stderr,
    /target contains unknown field "artifact"/,
  );
});

test("separates project validation from explicit source-file checking", () => {
  const directory = mkdtempSync("/tmp/z-project-check-modes-");
  const entry = resolve(directory, "main.zs");
  const helper = resolve(directory, "helper.zs");
  writeFileSync(entry, "export function answer(): i32 { return 42; }\n");
  writeFileSync(helper, "export function helper(): i32 { return 1; }\n");
  writeManifest(directory, {
    name: "check-modes",
    entry: "main.zs",
  });

  const executableProject = invoke(["check", directory]);
  assert.equal(executableProject.status, 1);
  assert.match(executableProject.stderr, /program must declare `function main\(\): i32`/);

  const explicitFile = invoke(["check", helper]);
  assert.equal(explicitFile.status, 0, explicitFile.stderr);

  writeManifest(directory, {
    kind: "static-library",
    name: "check-modes",
    entry: "main.zs",
  });
  const staticProject = invoke(["check", directory]);
  assert.equal(staticProject.status, 1);
  assert.match(staticProject.stderr, /must declare at least one `export c function`/);

  writeManifest(directory, {
    kind: "shared-library",
    name: "check-modes",
    entry: "main.zs",
  });
  const sharedProject = invoke(["check", directory]);
  assert.equal(sharedProject.status, 1);
  assert.match(sharedProject.stderr, /must declare at least one `export c function`/);

  const staticFile = invoke(["check", entry]);
  assert.equal(staticFile.status, 0, staticFile.stderr);
  writeFileSync(entry, "export c function answer(): i32 { return 42; }\n");
  const exported = invoke(["check"], directory);
  assert.equal(exported.status, 0, exported.stderr);
});

test("tests a project entry without requiring an executable main", () => {
  const directory = mkdtempSync("/tmp/z-project-test-mode-");
  const entry = resolve(directory, "calculator.zs");
  writeFileSync(entry, `
    import { expect } from "std/test";

    function add(left: i32, right: i32): i32 {
      return left + right;
    }

    test "adds values" {
      expect(add(20, 22)).toEqual(42);
    }
  `);
  writeManifest(directory, {
    name: "calculator-tests",
    entry: "calculator.zs",
  });

  const result = invoke(["test", directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 passed; 0 failed/);
});

test("builds and runs executable projects with strict release and argument parsing", () => {
  const directory = mkdtempSync("/tmp/z-project-executable-");
  const entry = resolve(directory, "main.zs");
  writeFileSync(entry, "function main(): i32 { return 0; }\n");
  writeManifest(directory, {
    name: "project-app",
    entry: "main.zs",
  });

  const built = invoke(["build", "--release"], directory);
  assert.equal(built.status, 0, built.stderr);
  const executable = resolve(
    directory,
    "build",
    `project-app${process.platform === "win32" ? ".exe" : ""}`,
  );
  assert.equal(existsSync(executable), true);
  assert.equal(spawnSync(executable, [], { encoding: "utf8" }).status, 0);

  const run = invoke(["run", directory, "--release", "--", "accepted"]);
  assert.equal(run.status, 0, run.stderr);
  const unknown = invoke(["run", directory, "not-an-option"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown run option "not-an-option"/);

  const projectEmit = invoke(["emit", directory]);
  assert.equal(projectEmit.status, 1);
  assert.match(projectEmit.stderr, /project output is deferred/);
  const fileEmit = invoke(["emit", entry]);
  assert.equal(fileEmit.status, 0, fileEmit.stderr);
  assert.match(fileEmit.stdout, /int32_t main\(int argc, char \*\*argv\)/);
});

test("builds static projects, rejects project run, and keeps explicit file run ad hoc", () => {
  const directory = mkdtempSync("/tmp/z-project-static-");
  const library = resolve(directory, "library.zs");
  const executable = resolve(directory, "probe.zs");
  writeFileSync(library, "export c function answer(): i32 { return 42; }\n");
  writeFileSync(executable, "function main(): i32 { return 0; }\n");
  writeManifest(directory, {
    kind: "static-library",
    name: "project_math",
    entry: "library.zs",
  });

  const built = invoke(["build", resolve(directory, "z.json")]);
  assert.equal(built.status, 0, built.stderr);
  assert.equal(
    existsSync(resolve(
      directory,
      "build",
      process.platform === "win32" ? "project_math.lib" : "libproject_math.a",
    )),
    true,
  );
  assert.equal(existsSync(resolve(directory, "build", "project_math.h")), true);

  const projectRun = invoke(["run", directory]);
  assert.equal(projectRun.status, 1);
  assert.match(projectRun.stderr, /run requires an executable project/);
  assert.doesNotMatch(projectRun.stderr, /undefined reference|linker command failed/);

  const fileRun = invoke(["run", executable]);
  assert.equal(fileRun.status, 0, fileRun.stderr);
});

test("builds a shared library and runs a handwritten C consumer", () => {
  const directory = mkdtempSync("/tmp/z-project-shared-");
  const library = resolve(directory, "library.zs");
  writeFileSync(
    library,
    "export c function z_shared_answer(): i32 { return 42; }\n",
  );
  writeManifest(directory, {
    kind: "shared-library",
    name: "shared_math",
    entry: "library.zs",
  });

  const checked = invoke(["check", directory]);
  assert.equal(checked.status, 0, checked.stderr);
  const built = invoke(["build", directory, "--release"]);
  assert.equal(built.status, 0, built.stderr);

  const buildDirectory = resolve(directory, "build");
  const libraryPath = resolve(
    buildDirectory,
    `${process.platform === "win32" ? "" : "lib"}shared_math${
      process.platform === "darwin"
        ? ".dylib"
        : process.platform === "win32"
          ? ".dll"
          : ".so"
    }`,
  );
  const headerPath = resolve(buildDirectory, "shared_math.h");
  assert.equal(existsSync(libraryPath), true);
  assert.equal(existsSync(headerPath), true);

  const consumerSource = resolve(directory, "consumer.c");
  const consumer = resolve(
    directory,
    `consumer${process.platform === "win32" ? ".exe" : ""}`,
  );
  writeFileSync(consumerSource, [
    '#include "shared_math.h"',
    "int main(void) { return z_shared_answer() == 42 ? 0 : 1; }",
    "",
  ].join("\n"));
  const compilerArguments = [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I", buildDirectory,
    consumerSource,
    libraryPath,
    ...(process.platform === "win32"
      ? []
      : [`-Wl,-rpath,${buildDirectory}`]),
    "-o", consumer,
  ];
  const compiled = process.platform === "darwin"
    ? spawnSync("xcrun", ["clang", ...compilerArguments], { encoding: "utf8" })
    : spawnSync("clang", compilerArguments, { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(spawnSync(consumer, [], { encoding: "utf8" }).status, 0);

  const run = invoke(["run", directory]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /run requires an executable project/);
});
