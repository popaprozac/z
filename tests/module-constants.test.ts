import {
  assert,
  cli,
  compileToC,
  completions,
  diagnostics,
  hover,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  resolve,
  rmSync,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";
import { lex } from "../compiler/src/lexer.ts";
import { linkSourceModules } from "../compiler/src/modules.ts";
import { parse } from "../compiler/src/parser.ts";
import { prepareProject } from "../compiler/src/project.ts";

test("links bundled source-backed standard modules as ordinary Z source", () => {
  const directory = mkdtempSync("/tmp/z-source-stdlib-");
  const entryFile = resolve(directory, "main.zs");
  const standardLibraryRoot = resolve(directory, "stdlib");
  const standardModule = resolve(standardLibraryRoot, "math.zs");
  try {
    mkdirSync(standardLibraryRoot, { recursive: true });
    writeFileSync(standardModule, "export function answer(): i32 { return 42; }");
    const source = `
      import { answer } from "std/math";
      function main(): i32 { return answer() - 42; }
    `;
    writeFileSync(entryFile, source);
    const program = parse(lex(source, entryFile), entryFile);
    const linked = linkSourceModules(source, program, entryFile, {
      standardLibraryRoot,
    });

    assert.equal(linked.sourceBatch.modules.length, 2);
    assert.equal(linked.program.imports.length, 0);
    assert.ok(linked.program.functions.some((declaration) => declaration.name === "main"));
    assert.ok(linked.program.functions.some((declaration) => (
      declaration.name.startsWith("__z_module_")
      && declaration.name.endsWith("_answer")
    )));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("resolves local package roots, subpath exports, and transitive dependencies", () => {
  const directory = mkdtempSync("/tmp/z-package-imports-");
  const applicationDirectory = resolve(directory, "application");
  const zappDirectory = resolve(directory, "zapp");
  const utilityDirectory = resolve(directory, "utility");
  const rootModule = resolve(zappDirectory, "src/zapp.zs");
  const windowModule = resolve(zappDirectory, "src/window.zs");
  const utilityModule = resolve(utilityDirectory, "src/utility.zs");
  const utilityIncludeDirectory = resolve(utilityDirectory, "include");
  const decoyModule = resolve(applicationDirectory, "zapp.zs");
  const mainFile = resolve(applicationDirectory, "main.zs");
  try {
    mkdirSync(resolve(zappDirectory, "src"), { recursive: true });
    mkdirSync(resolve(utilityDirectory, "src"), { recursive: true });
    mkdirSync(utilityIncludeDirectory, { recursive: true });
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(resolve(utilityIncludeDirectory, "utility-native.h"), `
      #include <stdint.h>
      static inline int32_t utility_native_answer(void) { return 40; }
    `);
    writeFileSync(utilityModule, `
      import native from "utility-native.h";
      export function baseAnswer(): i32 { return native.utility_native_answer(); }
    `);
    writeFileSync(resolve(utilityDirectory, "z.json"), JSON.stringify({
      package: { name: "utility", version: "0.1.0" },
      library: {
        entry: "src/utility.zs",
        native: { includeDirectories: ["include"] },
      },
    }));
    writeFileSync(rootModule, `
      import { baseAnswer } from "utility";
      export function frameworkAnswer(): i32 { return baseAnswer(); }
    `);
    writeFileSync(windowModule, `
      export function windowAnswer(): i32 { return 2; }
    `);
    writeFileSync(resolve(zappDirectory, "z.json"), JSON.stringify({
      package: { name: "zapp", version: "0.1.0-dev.1+local" },
      library: {
        entry: "src/zapp.zs",
        exports: { "./window": "src/window.zs" },
      },
      dependencies: { utility: { path: "../utility" } },
    }));
    writeFileSync(decoyModule, `
      export function decoyAnswer(): i32 { return 0; }
    `);
    writeFileSync(mainFile, `
      import { frameworkAnswer } from "zapp";
      import { windowAnswer } from "zapp/window";
      import { decoyAnswer } from "./zapp.zs";

      function main(): i32 {
        return frameworkAnswer() + windowAnswer() + decoyAnswer() - 42;
      }
    `);
    writeFileSync(resolve(applicationDirectory, "z.json"), JSON.stringify({
      dependencies: { zapp: { path: "../zapp" } },
      target: {
        name: "package-imports",
        entry: "main.zs",
      },
    }));

    const generated = compileToC(readFileSync(mainFile, "utf8"), mainFile);
    assert.match(generated, /frameworkAnswer/);
    assert.match(generated, /windowAnswer/);
    assert.deepEqual(prepareProject(mainFile).includeDirectories, [
      realpathSync(utilityIncludeDirectory),
    ]);
    const editorSource = readFileSync(mainFile, "utf8");
    const usageOffset = editorSource.lastIndexOf("frameworkAnswer") + 1;
    assert.match(
      hover(editorSource, mainFile, usageOffset)?.contents.value ?? "",
      /function frameworkAnswer\(\): i32/,
    );
    const importCompletionSource = editorSource.replace(
      "{ frameworkAnswer }",
      "{ frame }",
    );
    const importCompletionOffset = importCompletionSource.indexOf("frame }")
      + "frame".length;
    assert.equal(
      completions(importCompletionSource, mainFile, importCompletionOffset)
        .find((item) => item.label === "frameworkAnswer")?.detail,
      "function frameworkAnswer(): i32",
    );

    const libraryCheck = spawnSync(process.execPath, [
      cli,
      "check",
      zappDirectory,
      "--native-frontend",
    ], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(libraryCheck.status, 0, libraryCheck.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", mainFile, "--native-frontend"],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(native.status, 0, native.stderr);

    const execution = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(execution.status, 0, execution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("enforces manifest-scoped internal declarations and members", () => {
  const directory = mkdtempSync("/tmp/z-package-internal-");
  const applicationDirectory = resolve(directory, "application");
  const packageDirectory = resolve(directory, "framework");
  const packageSourceDirectory = resolve(packageDirectory, "src");
  const internalsFile = resolve(packageSourceDirectory, "internals.zs");
  const apiFile = resolve(packageSourceDirectory, "api.zs");
  const mainFile = resolve(applicationDirectory, "main.zs");
  try {
    mkdirSync(applicationDirectory, { recursive: true });
    mkdirSync(packageSourceDirectory, { recursive: true });
    writeFileSync(internalsFile, `
      internal function packageAnswer(): i32 { return 42; }

      export struct PackageCounter {
        internal value: i32 = 42;

        internal function secret(): i32 {
          return this.value;
        }

        function publicValue(): i32 {
          return this.value;
        }
      }
    `);
    writeFileSync(apiFile, `
      import { packageAnswer, PackageCounter } from "./internals.zs";

      export function answer(): i32 {
        const counter = PackageCounter();
        return packageAnswer() + counter.secret() - counter.publicValue();
      }
    `);
    writeFileSync(resolve(packageDirectory, "z.json"), JSON.stringify({
      package: { name: "framework", version: "0.1.0" },
      library: {
        entry: "src/api.zs",
        exports: { "./internals": "src/internals.zs" },
      },
    }));
    writeFileSync(resolve(applicationDirectory, "z.json"), JSON.stringify({
      dependencies: { framework: { path: "../framework" } },
      target: { name: "package-internal", entry: "main.zs" },
    }));

    writeFileSync(mainFile, `
      import { answer } from "framework";
      function main(): i32 { return answer() - 42; }
    `);
    assert.doesNotThrow(() => compileToC(readFileSync(mainFile, "utf8"), mainFile));
    const native = spawnSync(process.execPath, [cli, "check", mainFile, "--native-frontend"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(native.status, 0, native.stderr);
    const metadata = spawnSync(process.execPath, [cli, "metadata", mainFile], {
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(metadata.status, 0, metadata.stderr);
    assert.doesNotMatch(metadata.stdout, /packageAnswer|secret|\"name\":\"value\"/);
    assert.match(metadata.stdout, /publicValue/);

    const siblingCompletionSource = `
      import { pack } from "./internals.zs";
      function probe(): i32 { return 0; }
    `;
    const siblingCompletionOffset = siblingCompletionSource.indexOf("pack }") + "pack".length;
    const siblingItems = completions(siblingCompletionSource, apiFile, siblingCompletionOffset);
    assert.ok(siblingItems.some((item) => (
      item.label === "packageAnswer" && item.detail?.startsWith("internal function")
    )), JSON.stringify(siblingItems));

    const siblingMemberSource = `
      import { PackageCounter } from "./internals.zs";
      function probe(): i32 {
        const counter = PackageCounter();
        return counter.se;
      }
    `;
    const siblingMemberOffset = siblingMemberSource.indexOf("counter.se") + "counter.se".length;
    const siblingMemberItems = completions(siblingMemberSource, apiFile, siblingMemberOffset);
    assert.ok(siblingMemberItems.some((item) => (
      item.label === "secret" && item.detail?.startsWith("internal function")
    )), JSON.stringify(siblingMemberItems));

    const externalCompletionSource = `
      import { pack } from "framework/internals";
      function main(): i32 { return 0; }
    `;
    const externalCompletionOffset = externalCompletionSource.indexOf("pack }") + "pack".length;
    const externalItems = completions(externalCompletionSource, mainFile, externalCompletionOffset);
    assert.ok(externalItems.some((item) => item.label === "PackageCounter"));
    assert.ok(!externalItems.some((item) => item.label === "packageAnswer"));

    const externalMemberSource = `
      import { PackageCounter } from "framework/internals";
      function main(): i32 {
        const counter = PackageCounter();
        return counter.pu;
      }
    `;
    const externalMemberOffset = externalMemberSource.indexOf("counter.pu") + "counter.pu".length;
    const externalMemberItems = completions(externalMemberSource, mainFile, externalMemberOffset);
    assert.ok(externalMemberItems.some((item) => item.label === "publicValue"));
    assert.ok(!externalMemberItems.some((item) => item.label === "secret"));

    writeFileSync(mainFile, `
      import { packageAnswer } from "framework/internals";
      function main(): i32 { return packageAnswer(); }
    `);
    assert.throws(
      () => compileToC(readFileSync(mainFile, "utf8"), mainFile),
      /packageAnswer.*internal to package "framework"/,
    );

    writeFileSync(mainFile, `
      import { PackageCounter } from "framework/internals";
      function main(): i32 {
        const counter = PackageCounter();
        return counter.secret();
      }
    `);
    assert.throws(
      () => compileToC(readFileSync(mainFile, "utf8"), mainFile),
      /method "secret" is internal to its package/,
    );

    writeFileSync(mainFile, `
      import { PackageCounter } from "framework/internals";
      function main(): i32 {
        const counter = PackageCounter();
        return counter.value;
      }
    `);
    assert.throws(
      () => compileToC(readFileSync(mainFile, "utf8"), mainFile),
      /field "value" is internal to its package/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires a manifest-defined package identity for top-level internal declarations", () => {
  const fileName = "/tmp/z-internal-without-package.zs";
  assert.match(
    diagnostics("internal function helper(): i32 { return 42; }", fileName)[0]?.message ?? "",
    /requires a manifest-defined package identity/,
  );
});

test("composes and deduplicates package-owned native link requirements", () => {
  const directory = mkdtempSync("/tmp/z-package-native-");
  const applicationDirectory = resolve(directory, "application");
  const packageDirectory = resolve(directory, "library");
  const includeDirectory = resolve(packageDirectory, "include");
  const linkDirectory = resolve(packageDirectory, "lib");
  const mainFile = resolve(applicationDirectory, "main.zs");
  try {
    mkdirSync(applicationDirectory, { recursive: true });
    mkdirSync(resolve(packageDirectory, "src"), { recursive: true });
    mkdirSync(includeDirectory, { recursive: true });
    mkdirSync(linkDirectory, { recursive: true });
    writeFileSync(resolve(packageDirectory, "src/library.zs"),
      "export function answer(): i32 { return 42; }");
    writeFileSync(resolve(packageDirectory, "z.json"), JSON.stringify({
      package: { name: "native_sample", version: "0.1.0" },
      library: {
        entry: "src/library.zs",
        native: {
          includeDirectories: ["include"],
          link: {
            directories: ["lib"],
            libraries: ["sample_native", "sample_native"],
            frameworks: ["AppKit", "AppKit"],
          },
        },
      },
    }));
    writeFileSync(mainFile, `
      import { answer } from "native_sample";
      function main(): i32 { return answer() - 42; }
    `);
    writeFileSync(resolve(applicationDirectory, "z.json"), JSON.stringify({
      dependencies: { native_sample: { path: "../library" } },
      target: {
        name: "native-consumer",
        entry: "main.zs",
        includeDirectories: ["../library/include"],
        link: {
          directories: ["../library/lib"],
          libraries: ["sample_native"],
          frameworks: ["AppKit"],
        },
      },
    }));

    const build = prepareProject(mainFile);
    assert.deepEqual(build.includeDirectories, [realpathSync(includeDirectory)]);
    assert.deepEqual(build.nativeLinkerArguments, [
      `-L${realpathSync(linkDirectory)}`,
      "-lsample_native",
    ]);
    assert.deepEqual(build.frameworks, ["AppKit"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a missing package-owned native include directory", () => {
  const directory = mkdtempSync("/tmp/z-package-native-missing-");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(mainFile, "export function answer(): i32 { return 42; }");
    writeFileSync(resolve(directory, "z.json"), JSON.stringify({
      package: { name: "broken_native", version: "0.1.0" },
      library: {
        entry: "main.zs",
        native: { includeDirectories: ["missing"] },
      },
    }));
    assert.throws(
      () => prepareProject(mainFile),
      /library\.native\.includeDirectories directory .* does not exist/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects malformed public package export names in z.json", () => {
  const directory = mkdtempSync("/tmp/z-package-import-diagnostic-");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(mainFile, "function main(): i32 { return 0; }");
    writeFileSync(resolve(directory, "module.zs"), "export function value(): i32 { return 0; }");
    writeFileSync(resolve(directory, "z.json"), JSON.stringify({
      package: { name: "invalid", version: "0.1.0" },
      library: {
        entry: "module.zs",
        exports: { "../internal": "module.zs" },
      },
    }));
    assert.throws(
      () => compileToC(readFileSync(mainFile, "utf8"), mainFile),
      /library\.exports key .* must be a public subpath/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects undeclared package subpaths before native-header import", () => {
  const directory = mkdtempSync("/tmp/z-package-private-");
  const packageDirectory = resolve(directory, "library");
  const applicationDirectory = resolve(directory, "application");
  const mainFile = resolve(applicationDirectory, "main.zs");
  try {
    mkdirSync(resolve(packageDirectory, "src"), { recursive: true });
    mkdirSync(applicationDirectory, { recursive: true });
    writeFileSync(resolve(packageDirectory, "src/root.zs"), "export function value(): i32 { return 42; }");
    writeFileSync(resolve(packageDirectory, "src/private.zs"), "export function secret(): i32 { return 1; }");
    writeFileSync(resolve(packageDirectory, "z.json"), JSON.stringify({
      package: { name: "sample", version: "0.1.0" },
      library: { entry: "src/root.zs" },
    }));
    writeFileSync(mainFile, `
      import { secret } from "sample/private";
      function main(): i32 { return secret(); }
    `);
    writeFileSync(resolve(applicationDirectory, "z.json"), JSON.stringify({
      dependencies: { sample: { path: "../library" } },
      target: { name: "package-private", entry: "main.zs" },
    }));
    assert.throws(
      () => compileToC(readFileSync(mainFile, "utf8"), mainFile),
      /package "sample" does not export subpath "\.\/private"/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs local, namespace-imported, and selectively aliased module constants", () => {
  const directory = mkdtempSync("/tmp/z-module-constants-");
  const valuesFile = resolve(directory, "values.zs");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(valuesFile, `
      export const ANSWER: i32 = 42;
      export const ENABLED: boolean = true;
      export const TITLE: String = "Z";
    `);
    const source = `
      import values from "./values.zs";
      import { ANSWER as selected } from "./values.zs";

      const OFFSET = 1;

      function main(): i32 {
        if (!values.ENABLED) return 1;
        return values.ANSWER + selected + OFFSET - 85;
      }
    `;
    writeFileSync(mainFile, source);

    const generated = compileToC(source, mainFile);
    assert.match(generated, /static __attribute__\(\(unused\)\) const int32_t OFFSET = 1;/);
    assert.match(generated, /static __attribute__\(\(unused\)\) const int32_t __z_module_\d+_ANSWER = 42;/);
    assert.match(generated, /static __attribute__\(\(unused\)\) const bool __z_module_\d+_ENABLED = true;/);
    assert.match(generated, /static __attribute__\(\(unused\)\) const Z_String __z_module_\d+_TITLE =/);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires exported module constants to state their public type", () => {
  const source = "export const ANSWER = 42;";
  const diagnostic = diagnostics(source, "/tmp/z-module-constant-inferred-export.zs")[0];
  assert.equal(diagnostic?.code, "Z0604");
  assert.match(diagnostic?.message ?? "", /exported module constant "ANSWER" requires an explicit type/);
  assert.match(diagnostic?.message ?? "", /help: write `export const ANSWER: Type/);
});

test("rejects runtime module initialization in the literal-only tier", () => {
  const source = `
    function loadAnswer(): i32 {
      return 42;
    }

    export const ANSWER: i32 = loadAnswer();
  `;
  const diagnostic = diagnostics(source, "/tmp/z-module-constant-runtime.zs")[0];
  assert.equal(diagnostic?.code, "Z0604");
  assert.match(diagnostic?.message ?? "", /requires a compile-time literal initializer in the first tier/);
  assert.match(diagnostic?.message ?? "", /note: module constants do not run initialization code and therefore introduce no module initialization order/);
});

test("surfaces module constants through hover and completion", () => {
  const directory = mkdtempSync("/tmp/z-module-constant-editor-");
  const valuesFile = resolve(directory, "values.zs");
  const mainFile = resolve(directory, "main.zs");
  try {
    const valuesSource = `
      export const ANSWER: i32 = 42;
      export const TITLE: String = "Z";
    `;
    writeFileSync(valuesFile, valuesSource);
    const source = `
      import values from "./values.zs";
      import { ANSWER as selected } from "./values.zs";

      const LOCAL_LIMIT = 8;

      function main(): i32 {
        return selected + LOCAL_LIMIT;
      }
    `;
    writeFileSync(mainFile, source);

    const declarationOffset = source.indexOf("LOCAL_LIMIT") + 1;
    assert.match(
      hover(source, mainFile, declarationOffset)?.contents.value ?? "",
      /const LOCAL_LIMIT: i32/,
    );

    const aliasOffset = source.lastIndexOf("selected") + 1;
    const aliasHover = hover(source, mainFile, aliasOffset)?.contents.value ?? "";
    assert.match(aliasHover, /const selected: i32/);
    assert.match(aliasHover, /Alias of `ANSWER` from `"\.\/values\.zs"`/);

    const localCompletionSource = source.replace("selected + LOCAL_LIMIT", "selected + LOCAL");
    const localCompletionOffset = localCompletionSource.indexOf("LOCAL;") + "LOCAL".length;
    assert.equal(
      completions(localCompletionSource, mainFile, localCompletionOffset)
        .find((item) => item.label === "LOCAL_LIMIT")?.detail,
      "const LOCAL_LIMIT: i32",
    );

    const namespaceCompletionSource = source.replace("selected + LOCAL_LIMIT", "values.AN + LOCAL_LIMIT");
    const namespaceCompletionOffset = namespaceCompletionSource.indexOf("values.AN") + "values.AN".length;
    const namespaceItem = completions(namespaceCompletionSource, mainFile, namespaceCompletionOffset)
      .find((item) => item.label === "ANSWER");
    assert.equal(namespaceItem?.detail, "const ANSWER: i32");

    const importCompletionSource = source.replace(
      "import { ANSWER as selected }",
      "import { TI }",
    );
    const importCompletionOffset = importCompletionSource.indexOf("TI }") + 2;
    assert.equal(
      completions(importCompletionSource, mainFile, importCompletionOffset)
        .find((item) => item.label === "TITLE")?.detail,
      "const TITLE: String",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owns a main-affine class in Once until the inferred lifetime leaves scope", () => {
  const directory = mkdtempSync("/tmp/z-once-lifetime-");
  const stateFile = resolve(directory, "state.zs");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(stateFile, `
      import console from "std/console";
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      export class Application on thread.main {
        readonly id: i32;

        deinit {
          console.log(\`released application \${this.id}\`);
        }
      }

      export const application: Once<Application> = Once<Application>();
    `);
    const source = `
      import { Application, application } from "./state.zs";
      import console from "std/console";

      function main(): i32 {
        {
          const lifetime = application.initialize(
            new Application({ id: 42 })
          );
          const current = application.get();
          if (current.id != 42) return 1;
        }
        return 0;
      }
    `;
    writeFileSync(mainFile, source);

    const generated = compileToC(source, mainFile);
    assert.match(generated, /Once/);
    assert.match(generated, /OnceLifetime/);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "released application 42\n");

    const native = spawnSync(
      process.execPath,
      [cli, "check", mainFile, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("traps when Once is read before initialization, after lifetime cleanup, or initialized twice", () => {
  const directory = mkdtempSync("/tmp/z-once-invariants-");
  const stateFile = resolve(directory, "state.zs");
  try {
    writeFileSync(stateFile, `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      export class Application on thread.main {
        readonly id: i32;
      }

      export const application: Once<Application> = Once<Application>();
    `);

    const cases = new Map<string, { readonly source: string; readonly expected: RegExp }>([
      ["before", { source: `
        import { application } from "./state.zs";
        function main(): i32 {
          const current = application.get();
          return current.id;
        }
      `, expected: /Once<.*Application> has not been initialized/i }],
      ["after", { source: `
        import { Application, application } from "./state.zs";
        function main(): i32 {
          {
            const lifetime = application.initialize(
              new Application({ id: 1 })
            );
          }
          const current = application.get();
          return current.id;
        }
      `, expected: /Once<.*Application> lifetime has already closed/i }],
      ["duplicate", { source: `
        import { Application, application } from "./state.zs";
        function main(): i32 {
          const lifetime = application.initialize(
            new Application({ id: 1 })
          );
          const duplicate = application.initialize(
            new Application({ id: 2 })
          );
          return 0;
        }
      `, expected: /Once<.*Application> is already initialized and cannot reinitialize/i }],
      ["reinitialize", { source: `
        import { Application, application } from "./state.zs";
        function main(): i32 {
          {
            const lifetime = application.initialize(
              new Application({ id: 1 })
            );
          }
          const second = application.initialize(
            new Application({ id: 2 })
          );
          return 0;
        }
      `, expected: /Once<.*Application> lifetime has already closed and cannot reinitialize/i }],
    ]);

    for (const [name, current] of cases) {
      const file = resolve(directory, `${name}.zs`);
      writeFileSync(file, current.source);
      const result = spawnSync(process.execPath, [cli, "run", file], {
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
      assert.match(result.stderr, current.expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps a class retained by get alive after its Once lifetime closes", () => {
  const directory = mkdtempSync("/tmp/z-once-retained-get-");
  const mainFile = resolve(directory, "main.zs");
  try {
    const source = `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      class Application on thread.main {
        readonly id: i32;
      }

      const application = Once<Application>();

      function retainApplication(): Application on thread.main {
        const lifetime = application.initialize(
          new Application({ id: 42 })
        );
        const current = application.get();
        return current;
      }

      function main(): i32 {
        const retained = retainApplication();
        return retained.id - 42;
      }
    `;
    writeFileSync(mainFile, source);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cleans a Once lifetime when an async frame throws", () => {
  const directory = mkdtempSync("/tmp/z-once-async-cleanup-");
  const mainFile = resolve(directory, "main.zs");
  try {
    const source = `
      import console from "std/console";
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      struct StartupError {
        code: i32;
      }

      class Application on thread.main {
        readonly id: i32;

        deinit {
          console.log(\`released async application \${this.id}\`);
        }
      }

      const application = Once<Application>();

      async function failAfterPublish(): i32 throws StartupError on thread.main {
        const lifetime = application.initialize(
          new Application({ id: 42 })
        );
        throw StartupError({ code: 7 });
      }

      async function main(): i32 on thread.main {
        const outcome = attempt await failAfterPublish();
        return match (outcome) {
          success(value) => value + 1;
          failure(error) => error.code - 7;
        };
      }
    `;
    writeFileSync(mainFile, source);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "released async application 42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves Once empty when evaluating its class value throws", () => {
  const directory = mkdtempSync("/tmp/z-once-construction-failure-");
  const mainFile = resolve(directory, "main.zs");
  try {
    const source = `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      struct StartupError {
        code: i32;
      }

      class Application on thread.main {
        readonly id: i32;

        constructor(id: i32, shouldFail: boolean) throws StartupError {
          if (shouldFail) throw StartupError({ code: id });
          this.id = id;
        }
      }

      const application = Once<Application>();

      function initializeFailure(): void throws StartupError on thread.main {
        const value = try new Application(7, true);
        const lifetime = application.initialize(move value);
      }

      function initializeSuccessfully(): i32 throws StartupError on thread.main {
        const ready = try new Application(42, false);
        const lifetime = application.initialize(move ready);
        const current = application.get();
        return current.id - 42;
      }

      function main(): i32 {
        const attempted = attempt initializeFailure();
        const failedBeforeInitialization = match (attempted) {
          success => false;
          failure(error) => error.code == 7;
        };
        if (!failedBeforeInitialization) return 1;

        const initialized = attempt initializeSuccessfully();
        return match (initialized) {
          success(value) => value;
          failure(error) => error.code;
        };
      }
    `;
    writeFileSync(mainFile, source);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restricts Once to main-lifecycle classes while allowing synchronized retrieval", () => {
  const structSource = `
    import { Once } from "std/sync";
    struct Application { id: i32; }
    const application = Once<Application>();
    function main(): i32 { return 0; }
  `;
  assert.match(
    diagnostics(structSource, "/tmp/z-once-struct.zs")[0]?.message ?? "",
    /Once<T>.*class.*thread\.main/i,
  );

  const ordinaryClassSource = `
    import { Once } from "std/sync";
    class Application { readonly id: i32; }
    const application = Once<Application>();
    function main(): i32 {
      const application = new Application({ id: 42 });
      return application.id - 42;
    }
  `;
  assert.match(
    diagnostics(
      ordinaryClassSource,
      "/tmp/z-once-ordinary-class.zs",
    )[0]?.message ?? "",
    /Once<T>.*class.*thread\.main/i,
  );

  const storedHandleSource = `
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    class Controller on thread.main {
      readonly id: i32;
    }

    class Application {
      readonly controller: Controller;
    }

    const application = Once<Application>();
    function main(): i32 { return 0; }
  `;
  assert.match(
    diagnostics(
      storedHandleSource,
      "/tmp/z-once-stored-handle.zs",
    )[0]?.message ?? "",
    /Once<T>.*class.*thread\.main/i,
  );

  const inheritedValueAffinitySource = `
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    struct WindowState {
      id: i32 on thread.main;
    }

    class Application {
      readonly state: WindowState;
    }

    const application = Once<Application>();
    function main(): i32 { return 0; }
  `;
  assert.equal(
    diagnostics(
      inheritedValueAffinitySource,
      "/tmp/z-once-inherited-value-affinity.zs",
    ).length,
    0,
  );

  const offMainSource = `
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    class Application on thread.main {
      readonly id: i32;
    }

    const application = Once<Application>();

    function inspect(): i32 {
      const current = application.get();
      return current.id;
    }

    function main(): i32 { return 0; }
  `;
  const diagnostic = diagnostics(
    offMainSource,
    "/tmp/z-once-off-main.zs",
  )[0];
  assert.equal(diagnostic?.code, "Z0711");
  assert.match(
    diagnostic?.message ?? "",
    /field "Application\.id".*requires thread\.main executor context/i,
  );
});

test("retrieves a mixed-affinity Once identity on a worker and routes final cleanup to main", () => {
  const directory = mkdtempSync("/tmp/z-once-worker-get-");
  const mainFile = resolve(directory, "main.zs");
  try {
    const source = `
      import { Mutex, Once } from "std/sync";
      import { thread } from "std/thread";

      struct State {
        value: i32;
      }

      class Application {
        readonly state: Mutex<State>;
        windowId: i32 on thread.main;

        function value(): i32 {
          return this.state.withLock(
            (in state): i32 => state.value
          );
        }

        function window(): i32 on thread.main {
          return this.windowId;
        }
      }

      const application = Once<Application>();

      function currentApplication(): Application {
        return application.get();
      }

      async function main(): i32 on thread.main {
        const lifetime = application.initialize(
          new Application({
            state: Mutex(State({ value: 42 })),
            windowId: 7
          })
        );
        const worker = thread.spawn((): i32 => {
          const current = currentApplication();
          return current.value();
        });
        const value = await worker;
        const current = currentApplication();
        return value - current.window() - 35;
      }
    `;
    writeFileSync(mainFile, source);

    const generated = compileToC(source, mainFile);
    assert.match(generated, /pthread_mutex_lock|AcquireSRWLockShared/);
    assert.match(generated, /__atomic_add_fetch/);
    assert.match(generated, /z_async_release_from_thread/);
    assert.match(generated, /z_executor_bound_release_enqueue/);
    assert.match(generated, /finalize_on_executor/);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", mainFile, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tracks one canonical ARC identity through a transparent Once accessor", () => {
  const directory = mkdtempSync("/tmp/z-once-accessor-identity-");
  const stateFile = resolve(directory, "state.zs");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(stateFile, `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      export class Application {
        value: i32;
        marker: i32 on thread.main;

        function increment(inout this): void on thread.main {
          this.value = this.value + 1;
        }

        function read(): i32 on thread.main {
          return this.value;
        }
      }

      const application = Once<Application>();
      const previewApplicationCell = Once<Application>();

      export function currentApplication(): Application {
        return application.get();
      }

      export function previewApplication(): Application {
        return previewApplicationCell.get();
      }
    `);
    const source = `
      import { thread } from "std/thread";
      import {
        Application,
        currentApplication,
        previewApplication,
      } from "./state.zs";

      function updateAndInspect(
        inout updated: Application,
        in observed: Application
      ): i32 on thread.main {
        updated.increment();
        return observed.read();
      }

      function main(): i32 on thread.main {
        let primary = currentApplication();
        const alias = currentApplication();
        return updateAndInspect(inout primary, alias);
      }
    `;
    writeFileSync(mainFile, source);

    const diagnostic = diagnostics(source, mainFile)[0];
    assert.equal(diagnostic?.code, "Z0306");
    assert.match(
      diagnostic?.message ?? "",
      /overlapping inout and in uses of ARC aliases "primary" and "alias"/,
    );

    const sequential = source.replace(
      "return updateAndInspect(inout primary, alias);",
      "primary.increment();\n        return alias.read();",
    );
    assert.doesNotThrow(() => compileToC(sequential, mainFile));

    const distinctCells = source.replace(
      "const alias = currentApplication();",
      "const alias = previewApplication();",
    );
    assert.doesNotThrow(() => compileToC(distinctCells, mainFile));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps Once cell identity confined to its declaring module constant", () => {
  const prelude = `
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    class Application on thread.main {
      readonly id: i32;
    }

    const application = Once<Application>();
  `;
  const cases = new Map<string, string>([
    ["parameter", `
      function inspect(root: Once<Application>): i32 { return 0; }
      function main(): i32 { return 0; }
    `],
    ["return", `
      function expose(): Once<Application> { return application; }
      function main(): i32 { return 0; }
    `],
    ["field", `
      struct Holder {
        root: Once<Application>;
      }
      function main(): i32 { return 0; }
    `],
    ["local", `
      function main(): i32 {
        const alias: Once<Application> = application;
        return 0;
      }
    `],
  ]);

  for (const [name, body] of cases) {
    const diagnostic = diagnostics(
      `${prelude}\n${body}`,
      `/tmp/z-once-${name}-storage.zs`,
    )[0];
    assert.match(
      diagnostic?.message ?? "",
      /Once(?:<T>|<Application>).*?(?:only.*module.*const|cannot.*(?:parameter|return|field|local|storage))/i,
    );
  }
});

test("keeps OnceLifetime payloads main-affine and emits their standalone ABI shape", () => {
  const invalid = `
    import { OnceLifetime } from "std/sync";
    function pass(value: OnceLifetime<i32>): OnceLifetime<i32> {
      return move value;
    }
    function main(): i32 { return 0; }
  `;
  assert.match(
    diagnostics(invalid, "/tmp/z-once-lifetime-invalid.zs")[0]?.message ?? "",
    /OnceLifetime<T>.*class.*thread\.main/i,
  );

  const valid = `
    import { OnceLifetime } from "std/sync";
    import { thread } from "std/thread";

    class Application on thread.main {
      readonly id: i32;
    }

    function pass(
      value: OnceLifetime<Application>
    ): OnceLifetime<Application> on thread.main {
      return move value;
    }

    function main(): i32 {
      const application = new Application({ id: 42 });
      return application.id - 42;
    }
  `;
  const directory = mkdtempSync("/tmp/z-once-lifetime-standalone-");
  const file = resolve(directory, "main.zs");
  try {
    writeFileSync(file, valid);
    const generated = compileToC(valid, file);
    assert.match(generated, /typedef struct Z_OnceLifetime_Application/);
    assert.match(generated, /z_once_lifetime_Application_deinit/);
    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonicalizes generic and aliased main-affine class payloads", () => {
  const directory = mkdtempSync("/tmp/z-once-generic-alias-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      class Root<T> on thread.main {
        readonly value: T;
      }

      type ApplicationRoot = Root<i32>;
      const root = Once<ApplicationRoot>();

      function main(): i32 {
        const lifetime = root.initialize(
          new Root<i32>({ value: 42 })
        );
        const current = root.get();
        return current.value - 42;
      }
    `;
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("requires named Once values to move into initialize and makes its lifetime move-only", () => {
  const missingMove = `
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    class Application on thread.main {
      readonly id: i32;
    }

    const application = Once<Application>();

    function main(): i32 {
      const value = new Application({ id: 42 });
      const lifetime = application.initialize(value);
      return 0;
    }
  `;
  assert.match(
    diagnostics(missingMove, "/tmp/z-once-missing-move.zs")[0]?.message ?? "",
    /initialize.*move value|pass.*move value/i,
  );

  const copiedLifetime = missingMove
    .replace(
      "application.initialize(value)",
      "application.initialize(move value)",
    )
    .replace(
      "return 0;",
      "const copied = copy lifetime;\n      return 0;",
    );
  assert.match(
    diagnostics(
      copiedLifetime,
      "/tmp/z-once-copy-lifetime.zs",
    )[0]?.message ?? "",
    /OnceLifetime<Application>.*move-only|cannot copy.*OnceLifetime/i,
  );

  const discardedLifetime = missingMove
    .replace(
      "const lifetime = application.initialize(value);",
      "application.initialize(move value);",
    );
  assert.match(
    diagnostics(
      discardedLifetime,
      "/tmp/z-once-discarded-lifetime.zs",
    )[0]?.message ?? "",
    /ownership-bearing value must be bound or transferred|cleanup-bearing return value|OnceLifetime<Application>.*must be owned/i,
  );
});

test("surfaces Once imports, aliases, members, and inferred lifetimes in the editor", () => {
  const directory = mkdtempSync("/tmp/z-once-editor-");
  const stateFile = resolve(directory, "state.zs");
  const mainFile = resolve(directory, "main.zs");
  try {
    writeFileSync(stateFile, `
      import { Once } from "std/sync";
      import { thread } from "std/thread";

      export class Application on thread.main {
        readonly id: i32;
      }

      export const application: Once<Application> = Once<Application>();
    `);
    const source = `
      import state from "./state.zs";
      import { application as root, Application } from "./state.zs";

      function main(): i32 {
        const lifetime = root.initialize(
          new Application({ id: 42 })
        );
        const current = root.get();
        const namespaced = state.application.get();
        return current.id - namespaced.id;
      }
    `;
    writeFileSync(mainFile, source);

    const result = spawnSync(process.execPath, [cli, "run", mainFile], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    assert.match(
      hover(
        source,
        mainFile,
        source.indexOf("root.initialize") + 1,
      )?.contents.value ?? "",
      /const root: Once<Application>.*Alias of `application`/s,
    );
    assert.match(
      hover(
        source,
        mainFile,
        source.indexOf("initialize") + 1,
      )?.contents.value ?? "",
      /initialize\(move value: Application\): OnceLifetime<Application>.*thread\.main/s,
    );
    assert.match(
      hover(
        source,
        mainFile,
        source.indexOf("lifetime =") + 1,
      )?.contents.value ?? "",
      /lifetime: OnceLifetime<Application>/,
    );
    assert.match(
      hover(
        source,
        mainFile,
        source.indexOf("current =") + 1,
      )?.contents.value ?? "",
      /current: Application/,
    );

    const memberSource = source.replace("const current = root.get()", "const current = root.ge");
    const memberOffset = memberSource.indexOf("root.ge") + "root.ge".length;
    const getItem = completions(memberSource, mainFile, memberOffset)
      .find((item) => item.label === "get");
    assert.match(getItem?.detail ?? "", /get\(\): Application/);
    assert.doesNotMatch(getItem?.detail ?? "", /on thread\.main/);

    assert.match(
      hover(
        source,
        mainFile,
        source.indexOf("root.get") + "root.".length + 1,
      )?.contents.value ?? "",
      /get\(\): Application.*synchronized retrieval from any Z-managed thread/s,
    );

    const namespaceSource = source.replace(
      "state.application.get()",
      "state.appl",
    );
    const namespaceOffset = namespaceSource.indexOf("state.appl")
      + "state.appl".length;
    const applicationItem = completions(
      namespaceSource,
      mainFile,
      namespaceOffset,
    ).find((item) => item.label === "application");
    assert.match(
      applicationItem?.detail ?? "",
      /const application: Once<Application>/,
    );
    assert.match(applicationItem?.detail ?? "", /thread\.main/);

    const importSource = `
      import { On } from "std/sync";
      function main(): i32 { return 0; }
    `;
    const importOffset = importSource.indexOf("On }") + 2;
    assert.equal(
      completions(importSource, mainFile, importOffset)
        .find((item) => item.label === "Once")?.kind,
      22,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
