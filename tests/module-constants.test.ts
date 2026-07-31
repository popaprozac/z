import {
  assert,
  cli,
  compileToC,
  completions,
  diagnostics,
  hover,
  mkdtempSync,
  resolve,
  rmSync,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

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
