import {
  assert,
  cli,
  existsSync,
  mkdtempSync,
  resolve,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

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
