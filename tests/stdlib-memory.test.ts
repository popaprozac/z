import {
  assert,
  cli,
  compileToC,
  completions,
  decodeSemanticTokens,
  diagnostics,
  hover,
  mkdtempSync,
  positionForOffset,
  projectRoot,
  resolve,
  rmSync,
  semanticTokens,
  semanticTokenTypes,
  spawnSync,
  test,
  writeFileSync,
} from "./support/bootstrap.ts";

test("exchanges owned storage without copying or leaving it uninitialized", () => {
  const directory = mkdtempSync("/tmp/z-memory-replace-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { replace } from "std/memory";
      import console from "std/console";

      struct Resource {
        value: i32;

        deinit {
          console.log(\`released \${this.value}\`);
        }
      }

      function main(): i32 {
        let current = Resource({ value: 40 });
        const next = Resource({ value: 42 });
        const previous = replace(inout current, move next);
        return previous.value - 40 + current.value - 42;
      }
    `;
    writeFileSync(file, source);

    const generated = compileToC(source, file);
    assert.match(generated, /z_memory_replace_Resource\(&\(current\), [^;]*next\)/);
    assert.match(generated, /Z_Resource previous = \*target;\s+\*target = replacement;/);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "released 40\nreleased 42\n");

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);

    const nativeEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", file],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(nativeEmission.status, 0, nativeEmission.stderr);
    assert.match(nativeEmission.stdout, /z_stage1_memory_replace_8_Resource\(&\(current\), next\)/);
    assert.match(nativeEmission.stdout, /template <typename Z_Replacement>/);
    const nativeExecutable = resolve(directory, "native-program");
    const nativeCompilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", nativeExecutable],
      { encoding: "utf8", input: nativeEmission.stdout },
    );
    assert.equal(nativeCompilation.status, 0, nativeCompilation.stderr);
    const nativeExecution = spawnSync(nativeExecutable, [], { encoding: "utf8" });
    assert.equal(nativeExecution.status, 0, nativeExecution.stderr);
    assert.equal(nativeExecution.stdout, "released 40\nreleased 42\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("transfers direct ARC identity and local uniqueness with the owner", () => {
  const directory = mkdtempSync("/tmp/z-memory-replace-class-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { replace } from "std/memory";

      class Document {
        title: String;
        revision: i32;
      }

      function combine(inout updated: Document, in observed: Document): i32 {
        updated.revision = updated.revision + 1;
        return observed.revision;
      }

      function main(): i32 {
        let current = new Document({ title: "Draft", revision: 20 });
        const oldAlias = current;
        const next = new Document({ title: "Published", revision: 22 });
        let previous = replace(inout current, move next);
        const title = view current.title;
        return i32(title.byteLength) - 9
          + previous.revision - 20
          + oldAlias.revision - 20;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);

    const aliasConflict = source.replace(
      `return i32(title.byteLength) - 9
          + previous.revision - 20
          + oldAlias.revision - 20;`,
      "return combine(inout previous, oldAlias);",
    );
    const stage0Diagnostic = diagnostics(aliasConflict, "replace-class-alias.zs")[0];
    assert.equal(stage0Diagnostic.code, "Z0306");
    assert.match(stage0Diagnostic.message, /ARC aliases "previous" and "oldAlias"/);
    writeFileSync(file, aliasConflict);
    const nativeConflict = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(nativeConflict.status, 1, nativeConflict.stderr);
    assert.match(nativeConflict.stderr, /ARC aliases "previous" and "oldAlias"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("replaces initialized struct fields through an inout receiver", () => {
  const directory = mkdtempSync("/tmp/z-memory-replace-field-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { replace } from "std/memory";

      struct State {
        current: i32;

        function exchange(inout this, next: i32): i32 {
          return replace(inout this.current, next);
        }
      }

      function main(): i32 {
        let state = State({ current: 20 });
        const previous = state.exchange(22);
        return previous + state.current - 42;
      }
    `;
    writeFileSync(file, source);

    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const native = spawnSync(
      process.execPath,
      [cli, "check", file, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 0, native.stderr);

    const nativeEmission = spawnSync(
      process.execPath,
      [cli, "self-host-emit", file],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(nativeEmission.status, 0, nativeEmission.stderr);
    assert.match(
      nativeEmission.stdout,
      /z_stage1_memory_replace_(?:\d+_)?i32\(&\(self->current\),/,
    );
    const nativeExecutable = resolve(directory, "native-program");
    const nativeCompilation = spawnSync(
      "clang",
      ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", nativeExecutable],
      { encoding: "utf8", input: nativeEmission.stdout },
    );
    assert.equal(nativeCompilation.status, 0, nativeCompilation.stderr);
    const nativeExecution = spawnSync(nativeExecutable, [], { encoding: "utf8" });
    assert.equal(nativeExecution.status, 0, nativeExecution.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("moves noncopyable C++ storage through the same exchange", () => {
  const directory = mkdtempSync("/tmp/z-memory-replace-cpp-");
  const file = resolve(directory, "main.zs");
  try {
    const header = resolve(projectRoot, "tests/fixtures/move-only.hpp");
    const source = `
      import { replace } from "std/memory";
      import native from ${JSON.stringify(header)};

      function main(): i32 {
        let current = native.zcpp.UniqueValue(20);
        const next = native.zcpp.UniqueValue(22);
        const previous = replace(inout current, move next);
        return previous.value() - 20
          + current.value() - 22
          + native.zcpp.unique_live() - 2
          + native.zcpp.unique_moves() - 2;
      }
    `;
    writeFileSync(file, source);
    const generated = compileToC(source, file);
    assert.match(generated, /static_cast<zcpp::UniqueValue&&>\(\*target\)/);
    assert.match(generated, /template <typename Z_Replacement>/);
    assert.match(generated, /static_cast<Z_Replacement&&>\(replacement\)/);
    const result = spawnSync(process.execPath, [cli, "run", file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test("requires mutable initialized storage and explicit ownership transfer", () => {
  const source = `
    import { replace } from "std/memory";

    struct Resource {
      value: i32;
      deinit {}
    }

    function main(): i32 {
      let current = Resource({ value: 40 });
      const next = Resource({ value: 42 });
      const previous = replace(inout current, move next);
      return previous.value + current.value - 82;
    }
  `;

  const missingCapability = source.replace("inout current", "current");
  assert.match(
    diagnostics(missingCapability, "replace-missing-inout.zs")[0].message,
    /requires inout <mutable storage>/,
  );

  const immutable = source.replace("let current", "const current");
  assert.match(
    diagnostics(immutable, "replace-immutable.zs")[0].message,
    /requires a mutable let binding/,
  );

  const implicitMove = source.replace("move next", "next");
  const moveDiagnostic = diagnostics(implicitMove, "replace-explicit-move.zs")[0];
  assert.equal(moveDiagnostic.code, "Z0218");
  assert.match(moveDiagnostic.message, /requires an explicit move/);

  const wrongType = source.replace("move next", "42");
  assert.match(
    diagnostics(wrongType, "replace-type-mismatch.zs")[0].message,
    /expected Resource, found i32/,
  );

  const aggregateClassIdentity = `
    import { replace } from "std/memory";
    class Session { id: i32; }
    struct Holder { session: Session; }
    function main(): i32 {
      let current = Holder({ session: new Session({ id: 1 }) });
      const next = Holder({ session: new Session({ id: 2 }) });
      const previous = replace(inout current, move next);
      return previous.session.id + current.session.id - 3;
    }
  `;
  assert.match(
    diagnostics(aggregateClassIdentity, "replace-class-aggregate.zs")[0].message,
    /aggregate storage containing ARC class identity/,
  );
  const aggregateDirectory = mkdtempSync("/tmp/z-memory-replace-aggregate-");
  const aggregateFile = resolve(aggregateDirectory, "main.zs");
  try {
    writeFileSync(aggregateFile, aggregateClassIdentity);
    const nativeAggregate = spawnSync(
      process.execPath,
      [cli, "check", aggregateFile, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(nativeAggregate.status, 1, nativeAggregate.stderr);
    assert.match(
      nativeAggregate.stderr,
      /aggregate storage containing ARC class identity/,
    );
  } finally {
    rmSync(aggregateDirectory, { recursive: true, force: true });
  }
});

test("uses the same exchange inside owned async frames", () => {
  const directory = mkdtempSync("/tmp/z-memory-replace-async-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { replace } from "std/memory";

      async function exchange(): i32 {
        let current = 20;
        const previous = replace(inout current, 22);
        return previous + current;
      }

      async function main(): i32 {
        const value = await exchange();
        return value - 42;
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

test("completes, highlights, and explains imported memory replacement", () => {
  const source = `
    import { replace } from "std/memory";
    function main(): i32 {
      let value = 20;
      const previous = replace(inout value, 22);
      return previous + value - 42;
    }
  `;
  const file = "memory-replace-editor.zs";
  const offset = source.indexOf("replace(inout") + 1;
  assert.match(
    hover(source, file, offset)?.contents.value ?? "",
    /replace<T>\(inout target: T, replacement: T\): T/,
  );

  const position = positionForOffset(source, source.indexOf("replace(inout"));
  const tokens = decodeSemanticTokens(semanticTokens(source, file).data);
  assert.ok(tokens.some((token) => (
    token.line === position.line
    && token.character === position.character
    && semanticTokenTypes[token.type] === "function"
  )));

  const importSource = source.replace("{ replace }", "{ rep }");
  const importOffset = importSource.indexOf("{ rep }") + 5;
  assert.ok(
    completions(importSource, file, importOffset)
      .some((item) => item.label === "replace" && item.kind === 3),
  );
});
