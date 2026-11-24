import {
  assert, check, cli, compileToC, diagnostics, mkdtempSync, projectRoot,
  readFileSync, resolve, rmSync, spawnSync, test,
} from "./support/bootstrap.ts";

function native(command: "self-host-resolve" | "self-host-emit", input: string) {
  return spawnSync(process.execPath, [cli, command, input], {
    encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
  });
}

function execute(source: string): void {
  const directory = mkdtempSync("/tmp/z-module-expression-");
  try {
    for (const optimization of ["-O0", "-O2"]) {
      const executable = resolve(directory, `program${optimization}`);
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        optimization, "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        input: source, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
      const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(ran.status, 0, ran.stderr || String(ran.error));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const fixture of ["imported-closure-errors/main.zs", "expression-diagnostics/valid.zs"]) {
  test(`executes checked module expressions in ${fixture}`, () => {
    const input = resolve(projectRoot, "tests/fixtures", fixture);
    const source = readFileSync(input, "utf8");
    assert.deepEqual(diagnostics(source, input), []);
    execute(compileToC(source, input));
    const resolved = native("self-host-resolve", input);
    assert.equal(resolved.status, 0, resolved.stderr || String(resolved.error));
    const emitted = native("self-host-emit", input);
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    execute(emitted.stdout);
  }, 240_000);
}

test("keeps imported explicit closure errors distinct from same-named local types", () => {
  const input = resolve(projectRoot, "tests/fixtures/imported-closure-errors/main.zs");
  const source = readFileSync(input, "utf8")
    .replace("throws ImportedFailure =>", "throws Failure =>")
    .replace('throw ImportedFailure({ message: "named" });', "throw Failure({ code: 1 });");
  assert.throws(() => check(source, input), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /unknown type/);
    assert.match(error.message, /Failure/);
    return true;
  });
});

// Stage 0 keeps its rule that a match value is a statement's direct value.
// The native compiler runs one anywhere an expression may be: here, as a
// field initializer.
for (const fixture of ["class-field-match", "struct-field-match"]) {
  test(`runs ${fixture} natively where Stage 0 requires a direct value`, () => {
    const input = resolve(projectRoot, `tests/fixtures/expression-diagnostics/${fixture}.zs`);
    const source = readFileSync(input, "utf8");
    assert.throws(() => check(source, input), /match must be the direct value/);
    const emitted = native("self-host-emit", input);
    assert.equal(emitted.status, 0, emitted.stderr || String(emitted.error));
    const directory = mkdtempSync("/tmp/z-field-match-");
    try {
      const executable = resolve(directory, "program");
      const compiled = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        input: emitted.stdout, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
      // `main` returns the field the match initialized.
      const ran = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(ran.status, 42, ran.stderr || String(ran.error));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 240_000);
}

for (const [fixture, message, line] of [
  // A named function's or instance method's `Option<T>` parameter supplies
  // this context (see below); a callable value's parameter does not yet.
  ["borrowed-contextual-none", /Option\.none requires a contextual Option<T> type/, 5],
] as const) {
  test(`rejects ${fixture} during native resolution, before C emission`, () => {
    const input = resolve(projectRoot, `tests/fixtures/expression-diagnostics/${fixture}.zs`);
    const source = readFileSync(input, "utf8");
    assert.throws(() => check(source, input), message);
    const editor = diagnostics(source, input);
    assert.equal(editor.length, 1);
    assert.match(editor[0].message, message);
    for (const command of ["self-host-resolve", "self-host-emit"] as const) {
      const result = native(command, input);
      assert.equal(result.status, 1, result.stderr || String(result.error));
      assert.equal(result.stdout, "", "Invalid native semantics must not publish metadata or generated C");
      assert.match(result.stderr, message);
      assert.ok(result.stderr.includes(`${input}:${line}:`), result.stderr);
    }
  }, 240_000);
}

test("borrows Option.none typed by a function or method parameter in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/contextual-none-argument.zs");
  const resolved = native("self-host-resolve", input);
  assert.equal(resolved.status, 0, resolved.stderr);
  const emitted = native("self-host-emit", input);
  assert.equal(emitted.status, 0, emitted.stderr);
  const directory = mkdtempSync("/tmp/z-contextual-none-argument-");
  try {
    for (const [tier, generated] of [["stage0", compileToC(readFileSync(input, "utf8"), input)], ["native", emitted.stdout]]) {
      const executable = resolve(directory, tier);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        encoding: "utf8", input: generated, timeout: 30_000,
      });
      assert.equal(built.status, 0, `${tier}: ${built.stderr}`);
      assert.equal(spawnSync(executable, [], { encoding: "utf8" }).status, 0, tier);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);
