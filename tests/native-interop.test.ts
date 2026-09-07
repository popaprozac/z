import {
  ApiNoteConflictError,
  DiagnosticError,
  NativeFrontendDiagnosticError,
  analyzeSource,
  assert,
  basename,
  buildStage0ModuleGraph,
  check,
  cli,
  compileToC,
  compileToNative,
  completions,
  decodeSemanticTokens,
  decodeStage1DeclarationStream,
  decodeStage1ModuleGraphStream,
  decodeStage1ProgramBatchStream,
  decodeStage1ProgramStream,
  decodeStage1TokenStream,
  definition,
  delimiter,
  diagnostics,
  encodeForeignFunctionDeclarationStream,
  encodeStage1ModuleBatch,
  existsSync,
  formatDiagnostic,
  hostToolchainTest,
  hover,
  isProcessOutputOverflowError,
  mergeApiNotes,
  mkdirSync,
  mkdtempSync,
  normalizeForeignContracts,
  positionForOffset,
  projectRoot,
  readFileSync,
  readdirSync,
  realpathSync,
  resolve,
  resolveForeignFunctionDeclarationStreams,
  rmSync,
  runWithBufferedStdoutOrSpill,
  semanticTokens,
  semanticTokenTypes,
  spawn,
  spawnSync,
  statSync,
  test,
  utimesSync,
  writeFileSync,
  writeForeignDeclarationArtifact,
} from "./support/bootstrap.ts";
import type {
  ForeignFunctionDeclaration,
  ForeignModuleDeclarations,
  ImportDeclaration,
} from "./support/bootstrap.ts";

test("keeps imported C field spellings separate from Z aggregate storage names", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/field-hygiene-foreign.zs");
  const generated = compileToC(readFileSync(fixture, "utf8"), fixture);
  assert.match(generated, /\.template/);
  assert.doesNotMatch(generated, /\._z_field_template/);
  const result = spawnSync(process.execPath, [cli, "run", fixture], {
    encoding: "utf8", timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("captures machine-readable compiler output beyond the former 64 MiB pipe ceiling", () => {
  const mebibytes = 65;
  const result = runWithBufferedStdoutOrSpill(process.execPath, [
    "-e",
    `const chunk = "x".repeat(1024 * 1024); for (let i = 0; i < ${mebibytes}; i += 1) process.stdout.write(chunk);`,
  ], 64 * 1024 * 1024);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout), mebibytes * 1024 * 1024);
});

test("recognizes child-process buffer and decoded-string overflow failures", () => {
  const errorWith = (code: string, message: string): Error => Object.assign(new Error(message), { code });
  assert.equal(isProcessOutputOverflowError(errorWith("ENOBUFS", "spawnSync ENOBUFS")), true);
  assert.equal(isProcessOutputOverflowError(errorWith("ERR_STRING_TOO_LONG", "Cannot create a string longer than 0x1fffffe8 characters")), true);
  assert.equal(isProcessOutputOverflowError(new RangeError("Invalid string length")), true);
  assert.equal(isProcessOutputOverflowError(errorWith("ENOENT", "command not found")), false);
  assert.equal(isProcessOutputOverflowError(undefined), false);
});

test("shares one foreign header identity across linked module aliases", () => {
  const directory = mkdtempSync("/tmp/z-foreign-linked-aliases-");
  const headerPath = resolve(directory, "shared.h");
  const dependencyPath = resolve(directory, "dependency.zs");
  const entryPath = resolve(directory, "main.zs");
  writeFileSync(
    headerPath,
    "typedef enum ZSharedMode { ZSharedModeFirst = 0 } ZSharedMode;\n",
  );
  writeFileSync(
    dependencyPath,
    [
      'import native from "./shared.h";',
      "export function dependencyMode(): i32 {",
      "  const value: native.ZSharedMode = native.ZSharedModeFirst;",
      "  return i32(value);",
      "}",
      "",
    ].join("\n"),
  );
  const source = [
    'import { dependencyMode } from "./dependency.zs";',
    'import native from "./shared.h";',
    "function main(): i32 {",
    "  const value: native.ZSharedMode = native.ZSharedModeFirst;",
    "  return dependencyMode() + i32(value);",
    "}",
    "",
  ].join("\n");
  writeFileSync(entryPath, source);

  const analysis = analyzeSource(source, entryPath);
  assert.equal(analysis.semanticInfo.warnings.length, 0);
});

test("regenerates cached foreign declarations after a protocol upgrade", () => {
  const directory = mkdtempSync("/tmp/z-foreign-adapter-protocol-");
  const sourcePath = resolve(directory, "main.zs");
  const headerPath = resolve(directory, "native.h");
  const dependencyPath = resolve(directory, "native-dependency.h");
  const artifactPath = resolve(directory, "native.zfdcl");
  writeFileSync(dependencyPath, "#define Z_NATIVE_VALUE 42\n");
  writeFileSync(
    headerPath,
    '#include "native-dependency.h"\nint z_native_value(void);\n',
  );
  writeFileSync(
    sourcePath,
    'import native from "./native.h";\nfunction main(): i32 { return native.z_native_value(); }\n',
  );

  writeForeignDeclarationArtifact(sourcePath, "./native.h", artifactPath);
  const current = readFileSync(artifactPath, "utf8");
  assert.match(current, /^ZFDCL000000000000000d\n/);
  const dependencies = readFileSync(`${artifactPath}.deps`, "utf8")
    .split("\0")
    .filter(Boolean);
  assert.ok(dependencies.includes(headerPath));
  assert.ok(dependencies.includes(dependencyPath));

  writeFileSync(
    artifactPath,
    current.replace(
      /^ZFDCL000000000000000d\n/,
      "ZFDCL000000000000000c\n",
    ),
  );
  writeForeignDeclarationArtifact(sourcePath, "./native.h", artifactPath);
  assert.match(
    readFileSync(artifactPath, "utf8"),
    /^ZFDCL000000000000000d\n/,
  );
});

test("uses an explicit project manifest for headers imported by external source modules", () => {
  const directory = mkdtempSync("/tmp/z-foreign-adapter-project-");
  const projectDirectory = resolve(directory, "application");
  const sharedDirectory = resolve(directory, "shared");
  const includeDirectory = resolve(projectDirectory, "include");
  mkdirSync(projectDirectory, { recursive: true });
  mkdirSync(sharedDirectory, { recursive: true });
  mkdirSync(includeDirectory, { recursive: true });
  const entryPath = resolve(projectDirectory, "main.zs");
  const sourcePath = resolve(sharedDirectory, "native-value.zs");
  const manifestPath = resolve(projectDirectory, "z.json");
  const artifactPath = resolve(projectDirectory, "native.zfdcl");
  writeFileSync(entryPath, "function main(): i32 { return 0; }\n");
  writeFileSync(
    sourcePath,
    'import native from "native.h";\n'
      + "export function nativeValue(): i32 { return native.z_native_value(); }\n",
  );
  writeFileSync(
    resolve(includeDirectory, "native.h"),
    "int z_native_value(void);\n",
  );
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      target: {
        name: "foreign-adapter-project",
        entry: "main.zs",
        includeDirectories: ["include"],
      },
    }, null, 2)}\n`,
  );

  writeForeignDeclarationArtifact(
    sourcePath,
    "native.h",
    artifactPath,
    manifestPath,
  );
  assert.match(readFileSync(artifactPath, "utf8"), /z_native_value/);
});

test("compiles the shimless curl application without performing its network request", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/applications/z-curl/main.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /curl_easy_setopt\(easy, CURLOPT_URL/);
  assert.match(generated, /return CURL_WRITEFUNC_ERROR;/);
  assert.match(generated, /z_native_connection_deinit/);
  assert.match(generated, /curl_easy_perform\(easy\)/);

  const setoptOffset = source.indexOf("curl_easy_setopt") + 2;
  const setoptHover = hover(source, example, setoptOffset)?.contents.value ?? "";
  assert.match(setoptHover, /curl_easy_setopt\(curl: curl\.CURL, option: curl\.CURLOPT_URL, url: cstring\)/);
  assert.match(setoptHover, /curl_easy_setopt<E>.*move write: .*throws E.*native\.Connection throws curl\.CURLcode/);
  assert.match(setoptHover, /\*\*Native ABI\*\*/);
  assert.doesNotMatch(setoptHover, /\/\/ C:/);
});

test("compiles installed Raylib and SDL3 application pressure probes", () => {
  if (process.platform !== "darwin") return;

  const raylibHeader = "/opt/homebrew/include/raylib.h";
  if (existsSync(raylibHeader)) {
    const raylibExample = resolve(projectRoot, "examples/applications/z-raylib/main.zs");
    const generated = compileToNative(readFileSync(raylibExample, "utf8"), raylibExample).source;
    assert.match(generated, /InitWindow\(800, 450, "Z \+ raylib"\)/);
    assert.match(generated, /CheckCollisionPointRec\(mousePosition, quitButton\)/);
    assert.match(generated, /CloseWindow\(\)/);
  }

  const sdlHeader = "/opt/homebrew/include/SDL3/SDL_render.h";
  if (existsSync(sdlHeader)) {
    const sdlExample = resolve(projectRoot, "examples/applications/z-sdl3/main.zs");
    const generated = compileToNative(readFileSync(sdlExample, "utf8"), sdlExample).source;
    assert.match(generated, /SDL_CreateWindow\("Z \+ SDL3", 800, 450, 0ULL\)/);
    assert.match(generated, /SDL_GetMouseState\(&\(mouseX\), &\(mouseY\)\)/);
    assert.match(generated, /SDL_Event event;/);
    assert.match(generated, /SDL_PollEvent\(&\(event\)\)/);
    assert.match(generated, /switch \(_z_native_match_\d+->type\)/);
    assert.match(generated, /case SDL_EVENT_QUIT:/);
    assert.match(generated, /const SDL_WindowEvent \* const windowEvent = &\(_z_native_match_\d+->window\)/);
    assert.match(generated, /SDL_DestroyWindow\(window\)/);
  }
});

test("emits functions and direct imported C calls", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.puts("hello");
      return 0;
    }
  `;
  const generated = compileToC(source, "memory.zs");
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /puts\("hello"\);/);
  assert.doesNotMatch(generated, /stdio\.puts/);
});

test("exports checked scalar Z functions through a stable C ABI", () => {
  const source = `
    export c function z_math_add(left: i32, right: i32): i32 {
      return left + right;
    }

    export function ordinary(left: i32, right: i32): i32 {
      return z_math_add(left, right);
    }
  `;
  const artifact = compileToNative(source, "zmath.zs", { requireMain: false });
  assert.match(artifact.source, /static int32_t __z_c_impl_0_z_math_add\(int32_t left, int32_t right\)/);
  assert.match(artifact.source, /Z_API int32_t z_math_add\(int32_t left, int32_t right\)/);
  assert.match(artifact.source, /static int32_t ordinary\(int32_t left, int32_t right\)[\s\S]*return __z_c_impl_0_z_math_add\(left, right\);/);
  assert.match(artifact.source, /Z_API int32_t z_math_add\(int32_t left, int32_t right\) \{\s+return __z_c_impl_0_z_math_add\(left, right\);/);
  assert.ok(artifact.header);
  assert.match(artifact.header, /extern "C"/);
  assert.match(artifact.header, /Z_API int32_t z_math_add\(int32_t left, int32_t right\);/);
  assert.doesNotMatch(artifact.header, /ordinary/);

  const directory = mkdtempSync("/tmp/z-c-export-");
  const implementation = resolve(directory, "zmath.c");
  const header = resolve(directory, "zmath.h");
  const object = resolve(directory, "zmath.o");
  const library = resolve(directory, "libzmath.a");
  const consumer = resolve(directory, "consumer.c");
  const executable = resolve(directory, "consumer");
  writeFileSync(implementation, artifact.source);
  writeFileSync(header, artifact.header);
  writeFileSync(consumer, `
    #include "zmath.h"
    int main(void) {
      return z_math_add(20, 22) == 42 ? 0 : 1;
    }
  `);
  const compileLibrary = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-c", implementation, "-o", object,
  ], { encoding: "utf8" });
  assert.equal(compileLibrary.status, 0, compileLibrary.stderr);
  const archive = spawnSync("ar", ["rcs", library, object], { encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  const compileConsumer = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", consumer, library, "-o", executable,
  ], { encoding: "utf8" });
  assert.equal(compileConsumer.status, 0, compileConsumer.stderr);
  const result = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const moduleDirectory = mkdtempSync("/tmp/z-c-export-modules-");
  const libraryModule = resolve(moduleDirectory, "math.zs");
  const entryModule = resolve(moduleDirectory, "entry.zs");
  writeFileSync(libraryModule, `
    export c function z_module_add(left: i32, right: i32): i32 {
      return left + right;
    }
  `);
  writeFileSync(entryModule, `
    import { z_module_add } from "./math.zs";
    export c function z_module_answer(): i32 {
      return z_module_add(20, 22);
    }
  `);
  const moduleArtifact = compileToNative(
    readFileSync(entryModule, "utf8"),
    entryModule,
    { requireMain: false },
  );
  assert.match(moduleArtifact.source, /return __z_c_impl_1_z_module_add\(left, right\);/);
  assert.match(moduleArtifact.source, /return __z_c_impl_1_z_module_add\(20, 22\);/);
  assert.match(moduleArtifact.header ?? "", /z_module_add/);
  assert.match(moduleArtifact.header ?? "", /z_module_answer/);

  writeFileSync(resolve(moduleDirectory, "duplicate.zs"), `
    import { z_module_add as importedAdd } from "./math.zs";
    export c function z_module_add(): i32 { return 0; }
  `);
  const duplicate = resolve(moduleDirectory, "duplicate.zs");
  assert.throws(
    () => compileToNative(readFileSync(duplicate, "utf8"), duplicate, { requireMain: false }),
    /duplicate C export symbol "z_module_add"/,
  );
});

test("exports checked C-layout structs by value", () => {
  const source = `
    c struct Point {
      x: f64;
      y: f64;
    }

    c struct Segment {
      start: Point;
      end: Point;
    }

    export c function z_point_translate(point: Point, dx: f64, dy: f64): Point {
      return Point({ x: point.x + dx, y: point.y + dy });
    }

    export c function z_segment_end(segment: Segment): Point {
      return segment.end;
    }
  `;
  const artifact = compileToNative(source, "zgeometry.zs", { requireMain: false });
  assert.ok(artifact.header);
  assert.match(artifact.header, /typedef struct Point \{\s+double x;\s+double y;\s+\} Point;/);
  assert.match(artifact.header, /typedef struct Segment \{\s+Point start;\s+Point end;\s+\} Segment;/);
  assert.match(artifact.header, /Z_API Point z_point_translate\(Point point, double dx, double dy\);/);
  assert.match(artifact.source, /typedef struct Point Point;\s+typedef Point Z_Point;/);
  assert.match(artifact.source, /struct Point \{\s+double x;\s+double y;\s+\};/);

  const directory = mkdtempSync("/tmp/z-c-layout-struct-");
  const implementation = resolve(directory, "zgeometry.c");
  const header = resolve(directory, "zgeometry.h");
  const object = resolve(directory, "zgeometry.o");
  const library = resolve(directory, "libzgeometry.a");
  const consumer = resolve(directory, "consumer.c");
  const executable = resolve(directory, "consumer");
  writeFileSync(implementation, artifact.source);
  writeFileSync(header, artifact.header);
  writeFileSync(consumer, `
    #include "zgeometry.h"
    int main(void) {
      const Point translated = z_point_translate((Point){ .x = 20.0, .y = 21.0 }, 1.0, 1.0);
      const Segment segment = {
        .start = { .x = 0.0, .y = 0.0 },
        .end = translated,
      };
      const Point end = z_segment_end(segment);
      return end.x == 21.0 && end.y == 22.0 ? 0 : 1;
    }
  `);
  const compileLibrary = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-c", implementation, "-o", object,
  ], { encoding: "utf8" });
  assert.equal(compileLibrary.status, 0, compileLibrary.stderr);
  const archive = spawnSync("ar", ["rcs", library, object], { encoding: "utf8" });
  assert.equal(archive.status, 0, archive.stderr);
  const compileConsumer = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", consumer, library, "-o", executable,
  ], { encoding: "utf8" });
  assert.equal(compileConsumer.status, 0, compileConsumer.stderr);
  const result = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.throws(
    () => compileToNative(`
      c struct Invalid {
        value: String;
      }
      export c function z_invalid(value: Invalid): void {}
    `, "invalid-c-struct.zs", { requireMain: false }),
    /C-layout field type "String" does not have a C representation/,
  );
});

test("rejects duplicate public C names across linked modules and declaration kinds", () => {
  const directory = mkdtempSync("/tmp/z-c-public-names-");
  const first = resolve(directory, "first.zs");
  const second = resolve(directory, "second.zs");
  const duplicateTypes = resolve(directory, "duplicate-types.zs");
  const functionCollision = resolve(directory, "function-collision.zs");
  writeFileSync(first, `
    export c struct Shared {
      value: i32;
    }
  `);
  writeFileSync(second, `
    export c struct Shared {
      value: i32;
    }
  `);
  writeFileSync(duplicateTypes, `
    import { Shared as FirstShared } from "./first.zs";
    import { Shared as SecondShared } from "./second.zs";
  `);
  assert.throws(
    () => compileToNative(
      readFileSync(duplicateTypes, "utf8"),
      duplicateTypes,
      { requireMain: false },
    ),
    /duplicate public C type name "Shared"/,
  );

  writeFileSync(functionCollision, `
    import { Shared } from "./first.zs";
    export c function Shared(): i32 {
      return 42;
    }
  `);
  assert.throws(
    () => compileToNative(
      readFileSync(functionCollision, "utf8"),
      functionCollision,
      { requireMain: false },
    ),
    /duplicate public C symbol name "Shared"/,
  );
});

test("exports fixed-representation C enums as checked scalar values", () => {
  const source = `
    c enum Status: i32 {
      ready,
      busy,
      stopped,
    }

    c struct Report {
      status: Status;
      code: i32;
    }

    function statusCode(status: Status): i32 {
      return match (status) {
        ready => 20;
        busy => 21;
        stopped => 22;
      };
    }

    export c function z_next_status(status: Status): Status {
      if (statusCode(status) == 20) return Status.busy;
      return Status.stopped;
    }

    export c function z_status_report(status: Status): Report {
      return Report({ status, code: statusCode(status) });
    }
  `;
  const artifact = compileToNative(source, "zstatus.zs", { requireMain: false });
  assert.ok(artifact.header);
  assert.match(artifact.header, /typedef int32_t Status;/);
  assert.match(artifact.header, /#define Status_ready \(\(Status\)0\)/);
  assert.match(artifact.header, /#define Status_busy \(\(Status\)1\)/);
  assert.match(artifact.header, /Z_API Status z_next_status\(Status status\);/);
  assert.match(artifact.header, /typedef struct Report \{\s+Status status;\s+int32_t code;\s+\} Report;/);
  assert.match(artifact.header, /Z_API Report z_status_report\(Status status\);/);
  assert.match(artifact.source, /typedef int32_t Status;\s+typedef Status Z_Status;/);
  assert.match(
    artifact.source,
    /switch \(status\) \{\s+case Status_ready:\s+break;[\s\S]*default:\s+abort\(\);/,
  );

  const directory = mkdtempSync("/tmp/z-c-layout-enum-");
  const implementation = resolve(directory, "zstatus.c");
  const header = resolve(directory, "zstatus.h");
  const object = resolve(directory, "zstatus.o");
  const consumer = resolve(directory, "consumer.c");
  const executable = resolve(directory, "consumer");
  writeFileSync(implementation, artifact.source);
  writeFileSync(header, artifact.header);
  writeFileSync(consumer, `
    #include "zstatus.h"
    int main(void) {
      const Report report = z_status_report(Status_stopped);
      return z_next_status(Status_ready) == Status_busy
        && report.status == Status_stopped
        && report.code == 22
        ? 0 : 1;
    }
  `);
  const compileLibrary = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-c", implementation, "-o", object,
  ], { encoding: "utf8" });
  assert.equal(compileLibrary.status, 0, compileLibrary.stderr);
  const compileConsumer = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", consumer, object, "-o", executable,
  ], { encoding: "utf8" });
  assert.equal(compileConsumer.status, 0, compileConsumer.stderr);
  const result = spawnSync(executable, [], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.throws(
    () => compileToNative("c enum Invalid { ready }", "invalid-c-enum.zs", { requireMain: false }),
    /expected `:` before a C enum representation type/,
  );
  assert.throws(
    () => compileToNative("c enum Invalid: f64 { ready }", "invalid-c-enum.zs", { requireMain: false }),
    /requires a fixed integer representation/,
  );
  assert.throws(
    () => compileToNative("c enum Invalid: i32 { ready i32 }", "invalid-c-enum.zs", { requireMain: false }),
    /cannot carry a payload/,
  );
});

test("checks the first C-export ABI tier and its editor surface", () => {
  const unsupported = `
    export c function z_name(): String {
      return "unsupported";
    }
  `;
  assert.throws(
    () => compileToNative(unsupported, "unsupported-export.zs", { requireMain: false }),
    /C export return type "String" is unsupported/,
  );
  assert.throws(
    () => compileToNative(
      "export c async function z_work(): i32 { return 42; }",
      "async-export.zs",
      { requireMain: false },
    ),
    /C-exported function cannot be async/,
  );
  for (const reserved of ["double", "namespace"]) {
    const reservedSource = `export c function ${reserved}(): i32 { return 42; }`;
    assert.throws(
      () => compileToNative(
        reservedSource,
        `reserved-${reserved}-export.zs`,
        { requireMain: false },
      ),
      new RegExp(`C export name "${reserved}" is not a valid public C identifier`),
    );

    const directory = mkdtempSync("/tmp/z-native-reserved-export-");
    const entry = resolve(directory, "library.zs");
    writeFileSync(entry, reservedSource);
    const native = spawnSync(
      process.execPath,
      [cli, "self-host-emit", entry],
      { encoding: "utf8" },
    );
    assert.equal(native.status, 1);
    assert.match(
      native.stderr,
      new RegExp(`C export name "${reserved}" is not a valid public C identifier`),
    );
    assert.doesNotMatch(native.stderr, /errors generated|expected identifier/);
  }

  const source = "export c function z_value(): i32 { return 42; }";
  const completionSource = "export c";
  assert.equal(
    completions(completionSource, "export-completion.zs", completionSource.length)
      .find((item) => item.label === "c")?.detail,
    "declare a checked public C ABI function or C-layout value type",
  );
  const cOffset = source.indexOf("c function");
  assert.match(hover(source, "export-hover.zs", cOffset)?.contents.value ?? "", /checked C ABI contract/);
  const layoutSource = "c struct Point { x: i32; }";
  assert.match(hover(layoutSource, "layout-hover.zs", 0)?.contents.value ?? "", /C ABI contract/);
  const enumLayoutSource = "c enum Status: i32 { ready }";
  assert.match(hover(enumLayoutSource, "enum-layout-hover.zs", 0)?.contents.value ?? "", /C ABI contract/);
  const grammar = readFileSync(resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"), "utf8");
  assert.match(grammar, /export\\\\s\)c/);

  const project = mkdtempSync("/tmp/z-static-library-project-");
  const entry = resolve(project, "library.zs");
  writeFileSync(resolve(project, "z.json"), JSON.stringify({
    target: {
      kind: "static-library",
      name: "zanswer",
      entry: "library.zs",
    },
  }));
  writeFileSync(entry, source);
  const configured = compileToNative(source, entry);
  assert.equal(configured.targetKind, "static-library");
  assert.equal(configured.targetName, "zanswer");
  assert.ok(configured.header);
  assert.match(configured.header, /typedef enum zanswer_runtime_status/);
  assert.match(
    configured.header,
    /Calling an ordinary export before successful initialization,[\s\S]*contract violation and terminates/,
  );
  assert.match(configured.header, /Z_API zanswer_runtime_status zanswer_runtime_initialize\(const zanswer_runtime_config \*config\);/);
  assert.match(configured.header, /Z_API zanswer_runtime_status zanswer_runtime_shutdown\(void\);/);
  assert.match(configured.source, /z_embedded_runtime_zanswer_enter/);
  assert.match(configured.source, /__atomic_add_fetch\(&z_embedded_runtime_zanswer\.active_entries/);
  const executorBound = compileToNative(`
    import { thread } from "std/thread";

    class MainIdentity on thread.main {
      value: i32;
    }

    export c function zanswer_affinity_marker(): i32 { return 42; }
  `, entry);
  assert.match(executorBound.header ?? "", /#define ZANSWER_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1/);
  assert.match(executorBound.header ?? "", /#define ZANSWER_RUNTIME_REQUIRES_MAIN_THREAD 1/);
  assert.match(executorBound.source, /return ZANSWER_RUNTIME_INVALID_CONFIG/);
  assert.match(executorBound.source, /is_main_thread/);
  assert.match(executorBound.source, /z_embedded_runtime_zanswer_complete_release/);
  const executorBoundSource = resolve(project, "executor-bound.c");
  const executorBoundObject = resolve(project, "executor-bound.o");
  writeFileSync(executorBoundSource, executorBound.source);
  const compileExecutorBound = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-pthread",
    "-c", executorBoundSource, "-o", executorBoundObject,
  ], { encoding: "utf8" });
  assert.equal(compileExecutorBound.status, 0, compileExecutorBound.stderr);
  assert.throws(
    () => compileToNative(
      "export c function zanswer_runtime_shutdown(): i32 { return 0; }",
      entry,
    ),
    /collides with the generated runtime contract for target "zanswer"/,
  );
  assert.throws(
    () => compileToNative(
      "export c function zanswer_runtime_is_main_thread(): i32 { return 0; }",
      entry,
    ),
    /collides with the generated runtime contract for target "zanswer"/,
  );
  const nativeCheck = spawnSync(process.execPath, [cli, "check", entry, "--native-frontend"], { encoding: "utf8" });
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
  assert.match(nativeCheck.stdout, /native frontend hybrid matches 1 module/);
}, 30_000);

test("builds the Z-to-C example project and runs its handwritten C consumer", () => {
  const project = resolve(projectRoot, "examples/interop/c/z-export");
  const build = spawnSync(process.execPath, [cli, "build"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /build\/libzmath\.a/);
  assert.match(build.stdout, /build\/zmath\.h/);

  const generated = readFileSync(resolve(project, ".z-cache/build/zmath.c"), "utf8");
  const header = readFileSync(resolve(project, "build/zmath.h"), "utf8");
  assert.match(generated, /static int32_t z_double\(int32_t value\)/);
  assert.match(generated, /__z_c_impl_0_z_math_add\(z_double\(10\), 22\)/);
  assert.match(
    generated,
    /z_math_text_byte_length\(const char \* text\)[\s\S]*__z_c_impl_0_z_math_text_byte_length\(z_string_from_cstring\(text\)\)/,
  );
  assert.match(
    generated,
    /const uintptr_t _z_return_\d+ = \(text\)\.length;\n  if \(_z_live_text_\d+ && \(text\)\.capacity > 0\) free\(\(void \*\)\(text\)\.data\);/,
  );
  assert.match(
    header,
    /Z_API uintptr_t z_math_text_byte_length\(const char \* text\);/,
  );
  assert.doesNotMatch(generated, /static int32_t double\(/);

  const consumer = resolve(project, "build/consumer");
  const compileConsumer = spawnSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I", resolve(project, "build"),
    resolve(project, "consumer.c"),
    resolve(project, "build/libzmath.a"),
    "-o", consumer,
  ], { encoding: "utf8" });
  assert.equal(compileConsumer.status, 0, compileConsumer.stderr);
  const run = spawnSync(consumer, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "sum=42 answer=42 even=true text=6 point=(21,22) status=1\n");

  const cppConsumer = resolve(project, "build/consumer-cpp");
  const compileCppConsumer = spawnSync("clang++", [
    "-std=c++20", "-Wall", "-Wextra", "-Werror",
    "-I", resolve(project, "build"),
    "-x", "c++", resolve(project, "consumer.c"),
    "-x", "none", resolve(project, "build/libzmath.a"),
    "-o", cppConsumer,
  ], { encoding: "utf8" });
  assert.equal(compileCppConsumer.status, 0, compileCppConsumer.stderr);
  const cppRun = spawnSync(cppConsumer, [], { encoding: "utf8" });
  assert.equal(cppRun.status, 0, cppRun.stderr);

  const invalidTextSource = resolve(project, "build/invalid-text-consumer.c");
  const invalidTextConsumer = resolve(project, "build/invalid-text-consumer");
  writeFileSync(invalidTextSource, [
    '#include "zmath.h"',
    "int main(int argc, char **argv) {",
    "  if (argc > 1) return (int)z_math_text_byte_length((const char *)0);",
    "  const char invalid[] = { (char)0xC3, (char)0x28, '\\0' };",
    "  (void)argv;",
    "  return (int)z_math_text_byte_length(invalid);",
    "}",
    "",
  ].join("\n"));
  const compileInvalidTextConsumer = spawnSync("clang", [
    "-std=c11", "-Wall", "-Wextra", "-Werror",
    "-I", resolve(project, "build"),
    invalidTextSource,
    resolve(project, "build/libzmath.a"),
    "-o", invalidTextConsumer,
  ], { encoding: "utf8" });
  assert.equal(compileInvalidTextConsumer.status, 0, compileInvalidTextConsumer.stderr);
  const invalidUtf8Run = spawnSync(invalidTextConsumer, [], { encoding: "utf8" });
  assert.notEqual(invalidUtf8Run.status, 0, "invalid UTF-8 crossed the C export boundary");
  const nullRun = spawnSync(invalidTextConsumer, ["null"], { encoding: "utf8" });
  assert.notEqual(nullRun.status, 0, "a null C string crossed the C export boundary");
});

test("keeps embedded runtime shutdown safe across host-created threads", () => {
  const project = resolve(projectRoot, "examples/interop/c/z-runtime-export");
  const entry = resolve(project, "library.zs");
  const build = spawnSync(process.execPath, [cli, "build", project], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  const generated = readFileSync(resolve(project, ".z-cache/build/zembed.c"), "utf8");
  assert.match(generated, /__atomic_add_fetch\(&z_embedded_runtime_zembed\.active_entries/);
  assert.match(generated, /return ZEMBED_RUNTIME_BUSY/);
  assert.match(generated, /return ZEMBED_RUNTIME_DRAINING/);
  assert.match(generated, /initializeRuntime\(\)/);
  assert.match(generated, /z_embedded_runtime_zembed_destroy_root/);
  assert.match(generated, /!z_embedded_runtime_zembed\.is_main_thread\(z_embedded_runtime_zembed\.context\)\) abort/);
  const header = readFileSync(resolve(project, "build/zembed.h"), "utf8");
  assert.match(header, /#define ZEMBED_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1/);
  assert.match(header, /#define ZEMBED_RUNTIME_REQUIRES_MAIN_THREAD 1/);
  assert.match(header, /ZEMBED_RUNTIME_WRONG_THREAD = 6/);
  assert.match(header, /ZEMBED_RUNTIME_DRAINING = 7/);
  assert.match(header, /zembed_runtime_is_main_thread is_main_thread/);

  const consumer = resolve(project, "build/consumer");
  const compilation = spawnSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pthread",
    "-I", project,
    "-I", resolve(project, "build"),
    resolve(project, "consumer.c"),
    resolve(project, "build/libzembed.a"),
    "-o", consumer,
  ], { encoding: "utf8" });
  assert.equal(compilation.status, 0, compilation.stderr);
  const run = spawnSync(consumer, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(
    run.stdout,
    "wrong=6 busy=3 completed=1 checksum=43 draining=7 stopped=0 released=1\n",
  );

  const source = readFileSync(entry, "utf8");
  assert.throws(
    () => compileToNative(
      `${source}\nexport c function z_embed_invalid_ui_revision(): i32 {\n  const current = application.get();\n  return current.uiRevision;\n}\n`,
      entry,
    ),
    /(?:uiRevision|main).*(?:thread\.main|main executor)|(?:thread\.main|main executor).*uiRevision/i,
  );
});

test("requires an explicit cleanup-bearing library runtime root", () => {
  const project = mkdtempSync("/tmp/z-runtime-root-contract-");
  const entry = resolve(project, "library.zs");
  writeFileSync(resolve(project, "z.json"), JSON.stringify({
    target: {
      kind: "static-library",
      name: "runtime_root_contract",
      entry: "library.zs",
      runtime: { initialize: "initializeRuntime" },
    },
  }));

  const missing = "export c function z_answer(): i32 { return 42; }\n";
  writeFileSync(entry, missing);
  assert.throws(
    () => compileToNative(missing, entry),
    /runtime initializer "initializeRuntime" was not found in the target entry module/,
  );

  const scalar = [
    "function initializeRuntime(): i32 { return 42; }",
    "export c function z_answer(): i32 { return 42; }",
    "",
  ].join("\n");
  writeFileSync(entry, scalar);
  assert.throws(
    () => compileToNative(scalar, entry),
    /runtime initializer return type "i32" does not own cleanup-bearing state/,
  );

  const parameter = [
    "class RuntimeRoot { value: i32; }",
    "function initializeRuntime(value: i32): RuntimeRoot {",
    "  return new RuntimeRoot({ value });",
    "}",
    "export c function z_answer(): i32 { return 42; }",
    "",
  ].join("\n");
  writeFileSync(entry, parameter);
  assert.throws(
    () => compileToNative(parameter, entry),
    /a runtime initializer cannot accept parameters in the first tier/,
  );
});

hostToolchainTest("builds the shared Z-to-C example and runs its handwritten C consumer", () => {
  if (process.platform === "win32") return;
  const project = resolve(projectRoot, "examples/interop/c/z-shared-export");
  const build = spawnSync(
    process.execPath,
    [cli, "build", project, "--release"],
    { encoding: "utf8" },
  );
  assert.equal(build.status, 0, build.stderr);
  const library = resolve(
    project,
    `build/libzshared${process.platform === "darwin" ? ".dylib" : ".so"}`,
  );
  assert.equal(existsSync(library), true);
  assert.equal(existsSync(resolve(project, "build/zshared.h")), true);

  const consumer = resolve(project, "build/consumer");
  const compileConsumer = spawnSync("clang", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I", resolve(project, "build"),
    resolve(project, "consumer.c"),
    library,
    `-Wl,-rpath,${resolve(project, "build")}`,
    "-o", consumer,
  ], { encoding: "utf8" });
  assert.equal(compileConsumer.status, 0, compileConsumer.stderr);
  const run = spawnSync(consumer, [], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "shared=42\n");
});

test("lowers raw native expressions through isolated helpers and supports raw function bodies", () => {
  const example = resolve(projectRoot, "examples/interop/raw/native-boundary.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c");
  assert.match(artifact.source, /static int32_t _z_raw_expression_/);
  assert.match(artifact.source, /const int32_t \*left, int32_t \*right, int32_t \*output/);
  assert.match(artifact.source, /#line 15 .*native-boundary\.zs/);
  assert.match(artifact.source, /static int32_t add\(int32_t left, int32_t right\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("keeps raw contextual when ordinary bindings expose native-language-named fields", () => {
  const source = `
    struct NativeFlags {
      c: boolean;
      cpp: boolean;
      objc: boolean;
    }

    function main(): i32 {
      const raw = NativeFlags({ c: true, cpp: false, objc: false });
      if (raw.c) { return 1; }
      if (raw.cpp) { return 2; }
      if (raw.objc) { return 3; }
      return 0;
    }
  `;
  const generated = compileToC(source, "raw-contextual.zs");
  assert.match(generated, /if \(\(raw\)\.c\)/);
  assert.match(generated, /if \(\(raw\)\.cpp\)/);
  assert.match(generated, /if \(\(raw\)\.objc\)/);
});

test("checks raw native boundary capabilities and supported representations", () => {
  const moved = `
    function main(): i32 {
      const value: i32 = 42;
      return raw c using (move value): i32 { return value; };
    }
  `;
  assert.throws(
    () => compileToNative(moved, "raw-move.zs"),
    /raw operands require `in`, `inout`, or `out`/,
  );

  const immutableOutput = `
    function main(): i32 {
      const value: i32 = 0;
      return raw c using (out value): i32 { *value = 42; return *value; };
    }
  `;
  assert.throws(
    () => compileToNative(immutableOutput, "raw-out.zs"),
    /out raw operand "value" requires a mutable let binding/,
  );

  const unsupported = `
    function main(): i32 {
      const value = "owned";
      return raw c using (in value): i32 { return 0; };
    }
  `;
  assert.throws(
    () => compileToNative(unsupported, "raw-owned.zs"),
    /type "String" cannot cross a raw native boundary/,
  );

  const throwing = `
    struct NativeError { code: i32; }
    function operation(): i32 throws NativeError = raw c { return 42; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(throwing, "raw-throws.zs"),
    /raw native function body must be synchronous and non-throwing/,
  );

  const asyncRaw = `
    async function operation(): i32 = raw c { return 42; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(asyncRaw, "raw-async.zs"),
    /raw native function body must be synchronous and non-throwing/,
  );

  const genericRaw = `
    function operation<T>(value: T): i32 = raw c { return 42; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(genericRaw, "raw-generic.zs"),
    /raw native function body cannot be generic/,
  );

  const rawMethod = `
    struct Counter {
      value: i32;
      function read(): i32 = raw c { return 42; }
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(rawMethod, "raw-method.zs"),
    /raw native method bodies are deferred/,
  );

  const generatedSymbol = `
    struct Guard { id: i32; }
    function main(): i32 {
      return raw c using (): i32 {
        Z_Guard guard;
        guard.id = 1;
        return guard.id;
      };
    }
  `;
  assert.throws(
    () => compileToNative(generatedSymbol, "raw-generated-symbol.zs"),
    /raw native source cannot reference compiler-owned symbol "Z_Guard"/,
  );

  const localZPrefix = `
    function main(): i32 {
      return raw c using (): i32 {
        int Z_OK = 0;
        return Z_OK;
      };
    }
  `;
  assert.match(compileToC(localZPrefix, "raw-local-z-prefix.zs"), /int Z_OK = 0/);

  const importedZPrefix = `
    import native from "tests/fixtures/raw-z-prefix.h";
    function main(): i32 {
      return raw c using (): i32 {
        return Z_VENDOR_STATUS() + Z_OK;
      };
    }
  `;
  const importedGenerated = compileToC(
    importedZPrefix,
    resolve(projectRoot, "raw-imported-z-prefix.zs"),
  );
  assert.match(importedGenerated, /return Z_VENDOR_STATUS\(\) \+ Z_OK;/);

  const harmlessText = `
    function main(): i32 {
      return raw c using (): i32 {
        // Z_NotAReference and _z_not_a_reference remain ordinary comment text.
        const char *message = "Z_AlsoNotAReference";
        return message[0] == 'Z' ? 0 : 1;
      };
    }
  `;
  assert.match(compileToC(harmlessText, "raw-generated-text.zs"), /Z_AlsoNotAReference/);
});

test("provides raw-boundary completion, hover, and syntax highlighting vocabulary", () => {
  const source = `
    function main(): i32 {
      const input: i32 = 42;
      let output: i32;
      return raw c using (in input, out output): i32 {
        *output = *input;
        return *output;
      };
    }
  `;
  const rawOffset = source.indexOf("raw c") + 1;
  assert.match(hover(source, "raw-editor.zs", rawOffset)?.contents.value ?? "", /isolated native-source boundary/);
  const usingOffset = source.indexOf("using") + 1;
  assert.match(hover(source, "raw-editor.zs", usingOffset)?.contents.value ?? "", /complete operand contract/);
  const outOffset = source.indexOf("out output") + 1;
  assert.match(hover(source, "raw-editor.zs", outOffset)?.contents.value ?? "", /must initialize mutable caller storage/);

  const languageSource = "function operation(): i32 = raw cp";
  const languages = completions(languageSource, "raw-editor.zs", languageSource.length);
  assert.deepEqual(languages.map((item) => item.label), ["cpp"]);

  const operandOffset = source.indexOf("in input");
  const operands = completions(source, "raw-editor.zs", operandOffset);
  assert.match(operands.find((item) => item.label === "in")?.detail ?? "", /raw native operand/);
  assert.match(operands.find((item) => item.label === "out")?.detail ?? "", /initializes caller storage/);
  assert.equal(operands.some((item) => item.label === "move"), false);
  assert.ok(operands.some((item) => item.label === "input"));

  const grammarPath = resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json");
  const grammar = readFileSync(grammarPath, "utf8");
  assert.ok(grammar.includes("keyword.control.raw.z"));
  assert.ok(grammar.includes("(c|cpp|objc)"));
  const parsedGrammar = JSON.parse(grammar) as {
    readonly patterns: Array<{ readonly include?: string }>;
    readonly repository: Record<string, unknown>;
  };
  assert.equal(parsedGrammar.patterns[0]?.include, "#rawNativeBodies");
  assert.ok(parsedGrammar.repository.rawCBody);
  assert.ok(parsedGrammar.repository.rawCppBody);
  assert.ok(parsedGrammar.repository.rawObjCBody);
  assert.match(grammar, /meta\.embedded\.block\.c\.z/);
  assert.match(grammar, /meta\.embedded\.block\.cpp\.z/);
  assert.match(grammar, /meta\.embedded\.block\.objc\.z/);
  assert.match(grammar, /"include": "source\.c"/);
  assert.match(grammar, /"include": "source\.cpp"/);
  assert.match(grammar, /"include": "source\.objc"/);

  const extension = JSON.parse(readFileSync(
    resolve(projectRoot, "editors/vscode/package.json"),
    "utf8",
  )) as {
    readonly contributes: {
      readonly grammars: Array<{
        readonly embeddedLanguages?: Record<string, string>;
      }>;
    };
  };
  assert.deepEqual(extension.contributes.grammars[0]?.embeddedLanguages, {
    "meta.embedded.block.c.z": "c",
    "meta.embedded.block.cpp.z": "cpp",
    "meta.embedded.block.objc.z": "objective-c",
  });

  const nativeBody = `
    function operation(): i32 = raw c {
      int rawOnlyName = 42;
      if (rawOnlyName > 0) {
        rawOnlyName -= 1;
      }
      return rawOnlyName + 1;
    }
    function main(): i32 { return operation() - 42; }
  `;
  const semantic = decodeSemanticTokens(
    semanticTokens(nativeBody, "raw-semantic-boundary.zs").data,
  );
  const rawOnly = positionForOffset(
    nativeBody,
    nativeBody.indexOf("rawOnlyName"),
  );
  assert.equal(semantic.some((token) => (
    token.line === rawOnly.line && token.character === rawOnly.character
  )), false);
});

test("selects native dialects for raw bodies and preserves executor affinity", () => {
  const cpp = `
    function operation(): i32 = raw cpp {
      return static_cast<int32_t>(42);
    }
    function main(): i32 { return operation() - 42; }
  `;
  assert.equal(compileToNative(cpp, "raw-cpp.zs").language, "c++");

  const objc = `
    import { thread } from "std/thread";
    function operation(): i32 on thread.main = raw objc {
      return 42;
    }
    function main(): i32 { return operation() - 42; }
  `;
  assert.equal(compileToNative(objc, "raw-objc.zs").language, "objective-c");
});

test("maps native raw-body diagnostics back to Z source", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/raw-native-error.zs");
  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /raw-native-error\.zs:3:/);
  assert.match(result.stderr, /native_name_that_does_not_exist/);
  assert.doesNotMatch(result.stderr, /\.z-cache\/raw-native-error/);
});

test("keeps unsafe native assertions typed and opaque pointer pass-through scoped", () => {
  const example = resolve(projectRoot, "examples/interop/unsafe/native-boundary.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.match(artifact.source, /char \* const borrowed = z_unsafe_version\(\);/);
  assert.match(artifact.source, /ZUnsafeHandle \* const handle = z_unsafe_open\(42\);/);
  assert.match(artifact.source, /z_unsafe_read\(handle\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "unsafe version=unsafe-native, observed=42\n");
});

test("selects only independently safe values from unsafe expressions", () => {
  const opaqueEscape = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      const handle = unsafe {
        select native.z_unsafe_open(42);
      };
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(opaqueEscape, resolve(projectRoot, "unsafe-select-opaque.zs")),
    /unsafe native value cannot be selected from its unsafe block/,
  );

  const borrowedEscape = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      const version: cstring = unsafe {
        select native.z_unsafe_version();
      };
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(borrowedEscape, resolve(projectRoot, "unsafe-select-cstring.zs")),
    /unsafe native value cannot be selected from its unsafe block/,
  );
});

test("rejects unsafe native use outside its boundary and incompatible local assertions", () => {
  const outside = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      const handle = native.z_unsafe_open(42);
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(outside, resolve(projectRoot, "unsafe-outside.zs")),
    /uses unsupported type "ZUnsafeHandle \*"/,
  );

  const incompatible = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      unsafe {
        const version: i32 = native.z_unsafe_version();
        return version;
      }
    }
  `;
  assert.throws(
    () => compileToNative(incompatible, resolve(projectRoot, "unsafe-assertion.zs")),
    /is not ABI-compatible with asserted Z type i32/,
  );

  const wrongIdentity = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      unsafe {
        const handle = native.z_unsafe_open(42);
        return native.z_unsafe_read_other(handle);
      }
    }
  `;
  assert.throws(
    () => compileToNative(wrongIdentity, resolve(projectRoot, "unsafe-identity.zs")),
    /expects "ZUnsafeOther \*", found opaque native ZUnsafeHandle \*/,
  );

  const escapedAssignment = `
    import native from "tests/fixtures/unsafe-native.h";
    function main(): i32 {
      let version: cstring = "safe";
      unsafe {
        version = native.z_unsafe_version();
      }
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(escapedAssignment, resolve(projectRoot, "unsafe-assignment-escape.zs")),
    /unsafe native value cannot be stored outside its unsafe block/,
  );

  const escapedReturn = `
    import native from "tests/fixtures/unsafe-native.h";
    function version(): cstring {
      unsafe {
        return native.z_unsafe_version();
      }
    }
    function main(): i32 {
      return 0;
    }
  `;
  assert.throws(
    () => compileToNative(escapedReturn, resolve(projectRoot, "unsafe-return-escape.zs")),
    /unsafe native value cannot be returned from its unsafe block/,
  );

  const launderedThroughCall = `
    import native from "tests/fixtures/unsafe-native.h";
    function identity(value: cstring): cstring { return value; }
    function version(): cstring {
      return unsafe {
        const borrowed: cstring = native.z_unsafe_version();
        select identity(borrowed);
      };
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToNative(launderedThroughCall, resolve(projectRoot, "unsafe-call-escape.zs")),
    /unsafe native value cannot cross an ordinary Z call boundary/,
  );
});

test("rejects suspension and capture across the first unsafe scope", () => {
  const suspended = `
    import { delay } from "std/time";
    async function main(): i32 {
      unsafe {
        await delay(1);
        return 0;
      }
    }
  `;
  assert.throws(
    () => compileToNative(suspended, "unsafe-await.zs"),
    /unsafe blocks must be isolated in a synchronous function in the first tier/,
  );

  const captured = `
    function main(): i32 {
      unsafe {
        const operation = (): i32 => 42;
        return operation();
      }
    }
  `;
  assert.throws(
    () => compileToNative(captured, "unsafe-closure.zs"),
    /closure construction cannot cross an unsafe block in the first tier/,
  );
});

test("surfaces unsafe boundaries and opaque native identity in editor tooling", () => {
  const example = resolve(projectRoot, "examples/interop/unsafe/native-boundary.zs");
  const source = readFileSync(example, "utf8");
  const unsafeOffset = source.indexOf("unsafe {") + 1;
  assert.match(hover(source, example, unsafeOffset)?.contents.value ?? "", /local unverified native assertions/);

  const handleOffset = source.indexOf("handle =") + 1;
  assert.match(
    hover(source, example, handleOffset)?.contents.value ?? "",
    /handle: opaque native ZUnsafeHandle \* — unsafe pass-through only/,
  );

  const prefix = "function main(): i32 { uns";
  assert.ok(completions(prefix, "unsafe-editor.zs", prefix.length).some((item) => item.label === "unsafe"));

  const grammar = readFileSync(resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"), "utf8");
  assert.match(grammar, /constructor\|unsafe\|raw/);
});

test("selectively imports C functions with optional local aliases", () => {
  const example = resolve(projectRoot, "examples/interop/c/selective-import.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(result.stdout, "selective C imports\nanswer=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /puts\("selective C imports"\);/);
  assert.match(generated, /printf\("answer=%d\\n", 42\);/);
  assert.doesNotMatch(generated, /\bprint\(/);

  const shadowed = `
    import { printf as value } from "stdio.h";
    function main(): i32 {
      const value = 7;
      return value;
    }
  `;
  const shadowedC = compileToC(shadowed, "selective-shadow.zs");
  assert.match(shadowedC, /const int32_t value = 7;/);
  assert.match(shadowedC, /return value;/);
  assert.doesNotMatch(shadowedC, /return printf;/);
});

test("keeps unselected C functions out of scope", () => {
  const source = `
    import { puts } from "stdio.h";
    function main(): i32 {
      printf("not imported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "selective-scope.zs"),
    /unknown function "printf"/,
  );

  const missing = source.replace("puts", "not_a_real_c_function").replace("printf", "not_a_real_c_function");
  assert.throws(
    () => compileToC(missing, "selective-missing.zs"),
    /header "stdio\.h" has no declaration "not_a_real_c_function"/,
  );
});

test("loads explicit Z exports through selective and namespace module imports", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Z module workspace revision=1, audit=enabled, point=Point { x: 21, y: 21 }, total=42\n");

  const analysis = analyzeSource(source, example);
  assert.equal(analysis.sourceModules.size, 4);
  assert.equal(analysis.nativeFrontendGraph, null);
  assert.equal(analysis.nativeSemanticIndex, null);
  assert.equal(analysis.nativeSemanticQueryCount, 0);
  assert.equal(analysis.nativeGenericCallEvidenceCount, 0);
  assert.equal(analysis.nativeBindingEvidenceCount, 0);
  assert.equal(analysis.nativeExpressionEvidenceCount, 0);
  assert.equal(analysis.nativeCallResolutionCount, 0);
  assert.equal(analysis.nativeMethodResolutionCount, 0);
  assert.equal(analysis.nativeConstructorResolutionCount, 0);
  assert.equal(analysis.nativeAggregateResolutionCount, 0);
  assert.equal(analysis.nativeFieldResolutionCount, 0);
  assert.equal(analysis.nativeEnumVariantResolutionCount, 0);
  assert.equal(analysis.nativeTypeResolutionCount, 0);
  assert.equal(analysis.nativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeFunctionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeMethodResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeConstructorResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeAggregateResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeFieldResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeEnumVariantResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeTypeResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeFrontendParityMilliseconds, null);
  assert.equal(analysis.sourceModuleBatch.entryFileName, example);
  assert.deepEqual(
    analysis.sourceModuleBatch.modules.map((module) => basename(module.fileName)),
    ["main.zs", "app-config.zs", "geometry.zs", "math.zs"],
  );
  assert.deepEqual(
    analysis.sourceModuleBatch.modules.map((module) => module.dependencies.size),
    [4, 0, 1, 0],
  );
  assert.ok(analysis.program.functions.find((item) => item.name.endsWith("_add"))!.location.offset > source.length);
  const generated = compileToC(source, example);
  assert.match(generated, /__z_module_\d+_translate/);
  assert.match(generated, /__z_module_\d+_add/);
  assert.doesNotMatch(generated, /#include <\.\/geometry\.zs>/);
  assert.doesNotMatch(generated, /#include <\.\/math\.zs>/);
});

test("keeps qualified standard-module types canonical across Z modules", () => {
  const directory = mkdtempSync("/tmp/z-standard-module-types-");
  const owner = resolve(directory, "owner.zs");
  const entry = resolve(directory, "main.zs");
  writeFileSync(owner, `
    import storage from "std/fs";

    export struct LockOwner {
      lock: storage.Lock;
    }
  `);
  writeFileSync(entry, `
    import { LockOwner } from "./owner.zs";

    function main(): i32 {
      return 0;
    }
  `);

  const source = readFileSync(entry, "utf8");
  assert.deepEqual(diagnostics(source, entry), []);
  const generated = compileToC(source, entry);
  assert.match(generated, /Z_FsLock lock;/);
  assert.doesNotMatch(generated, /__z_module_[0-9]+_import_storage\.Lock/);
  rmSync(directory, { recursive: true, force: true });
});

test("attaches native frontend evidence after authoritative stage-0 analysis", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
  const source = readFileSync(example, "utf8");
  let receivedModuleCount = 0;
  const analysis = analyzeSource(source, example, {
    nativeFrontendResolver: (sourceBatch) => {
      receivedModuleCount = sourceBatch.modules.length;
      return buildStage0ModuleGraph(sourceBatch);
    },
  });

  assert.equal(receivedModuleCount, 4);
  assert.equal(analysis.nativeFrontendGraph?.modules.length, 4);
  assert.equal(analysis.nativeFrontendGraph?.modules[analysis.nativeFrontendGraph.entry]?.path, example);
  const moved = analysis.nativeSemanticIndex?.resolveSymbol(example, "move");
  assert.equal(moved?.modulePath, analysis.sourceModuleBatch.modules[2].fileName);
  assert.equal(moved?.binding.importedName, "translate");
  assert.equal(moved?.declaration.functionSignature?.returnType, "Point");
  const total = analysis.nativeSemanticIndex?.resolveNamespaceMember(example, "geometry", "total");
  assert.equal(total?.declaration.functionSignature?.returnType, "i32");
  assert.ok(analysis.nativeSemanticQueryCount > (analysis.nativeFrontendGraph?.modules.length ?? 0));
  assert.equal(analysis.nativeGenericCallEvidenceCount, 0);
  assert.equal(analysis.nativeBindingEvidenceCount, 0);
  assert.equal(analysis.nativeExpressionEvidenceCount, 0);
  assert.ok(analysis.nativeCallResolutionCount > 0);
  assert.equal(analysis.nativeAuthoritativeFunctionResolutionCount, analysis.nativeCallResolutionCount);
  assert.equal(analysis.nativeAuthoritativeAggregateResolutionCount, analysis.nativeAggregateResolutionCount);
  assert.equal(analysis.nativeAuthoritativeFieldResolutionCount, analysis.nativeFieldResolutionCount);
  assert.equal(analysis.nativeAuthoritativeEnumVariantResolutionCount, analysis.nativeEnumVariantResolutionCount);
  assert.equal(analysis.nativeAuthoritativeTypeResolutionCount, analysis.nativeTypeResolutionCount);
  assert.equal(analysis.nativeAuthoritativeBindingResolutionCount, 0);
  assert.equal(analysis.nativeExpressionResolutionCount, 0);
  assert.equal(analysis.nativeAuthoritativeExpressionResolutionCount, 0);
  assert.ok((analysis.nativeFrontendParityMilliseconds ?? -1) >= 0);

  const callableFile = resolve(projectRoot, "native-callable-shadow.zs");
  const callable = analyzeSource(`
    struct Counter {
      value: i32;

      function plus(amount: i32): i32 {
        return this.value + amount;
      }

      static function zero(): Counter {
        return Counter({ value: 0 });
      }
    }

    class Session {
      private id: i32;

      constructor(id: i32) {
        this.id = id;
      }

      function identifier(): i32 {
        return this.id;
      }
    }

    enum CounterState {
      active Counter,
      empty,
    }

    function stateValue(state: CounterState): i32 {
      return match (state) {
        active({ value }) => value;
        empty => 0;
      };
    }

    function main(): i32 {
      let counter: Counter = Counter.zero();
      counter.value = counter.value + 1;
      const session: Session = new Session(2);
      const active: CounterState = CounterState.active(Counter({ value: 1 }));
      const empty: CounterState = CounterState.empty;
      return counter.plus(39) + session.identifier();
    }
  `, callableFile, {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.equal(callable.nativeCallResolutionCount, 0);
  assert.equal(callable.nativeMethodResolutionCount, 3);
  assert.equal(callable.nativeConstructorResolutionCount, 1);
  assert.equal(callable.nativeAggregateResolutionCount, 2);
  assert.equal(callable.nativeFieldResolutionCount, 10);
  assert.equal(callable.nativeEnumVariantResolutionCount, 4);
  assert.equal(callable.nativeTypeResolutionCount, 4);
  assert.equal(callable.nativeAuthoritativeMethodResolutionCount, 3);
  assert.equal(callable.nativeAuthoritativeConstructorResolutionCount, 1);
  assert.equal(callable.nativeAuthoritativeAggregateResolutionCount, 2);
  assert.equal(callable.nativeAuthoritativeFieldResolutionCount, 10);
  assert.equal(callable.nativeAuthoritativeEnumVariantResolutionCount, 4);
  assert.equal(callable.nativeAuthoritativeTypeResolutionCount, 4);

  const generic = analyzeSource(`
    function identity<T>(value: T): T {
      return value;
    }

    class Envelope<T> {
      private value: T;

      constructor(value: T) {
        this.value = value;
      }

      function get(): T {
        return this.value;
      }
    }

    function main(): i32 {
      const envelope = new Envelope(42);
      return identity(envelope.get());
    }
  `, resolve(projectRoot, "native-generic-call-shadow.zs"), {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.equal(generic.nativeCallResolutionCount, 1);
  assert.equal(generic.nativeGenericCallEvidenceCount, 0);
  assert.equal(generic.nativeMethodResolutionCount, 1);
  assert.equal(generic.nativeConstructorResolutionCount, 1);
  assert.equal(generic.nativeAuthoritativeFunctionResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeMethodResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeConstructorResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeAggregateResolutionCount, generic.nativeAggregateResolutionCount);
  assert.equal(generic.nativeAuthoritativeFieldResolutionCount, generic.nativeFieldResolutionCount);
  assert.equal(generic.nativeAuthoritativeEnumVariantResolutionCount, 0);
  assert.equal(generic.nativeAuthoritativeTypeResolutionCount, generic.nativeTypeResolutionCount);

  const nestedTypes = analyzeSource(`
    struct Item {
      value: i32;
    }

    function main(): i32 {
      const transform: (item: Item) => Item = (item: Item): Item => item;
      const items: Item[1] = [Item({ value: 42 })];
      return transform(items[0]).value - 42;
    }
  `, resolve(projectRoot, "native-nested-type-resolution.zs"), {
    nativeFrontendResolver: buildStage0ModuleGraph,
  });
  assert.ok(nestedTypes.nativeTypeResolutionCount > 0);
  assert.equal(
    nestedTypes.nativeAuthoritativeTypeResolutionCount,
    nestedTypes.nativeTypeResolutionCount,
  );

  assert.throws(
    () => analyzeSource(source, example, {
      nativeFrontendResolver: (sourceBatch) => ({
        ...buildStage0ModuleGraph(sourceBatch),
        dependencyOrder: [],
      }),
    }),
    /native frontend module graph mismatch/,
  );

  let resolverCalled = false;
  assert.throws(
    () => analyzeSource("function main(): i32 { return missing; }", "invalid-native-shadow.zs", {
      nativeFrontendResolver: () => {
        resolverCalled = true;
        throw new Error("buffered native failure");
      },
    }),
    /unknown name "missing"/,
  );
  assert.equal(resolverCalled, true);
  const nativeDiagnosticFile = resolve(projectRoot, "native-owned-diagnostic.zs");
  assert.throws(
    () => analyzeSource("function main(): i32 { return 0; }", nativeDiagnosticFile, {
      nativeFrontendResolver: () => {
        throw new NativeFrontendDiagnosticError(
          "unknownName",
          nativeDiagnosticFile,
          1,
          1,
          "native-owned diagnostic",
        );
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof DiagnosticError);
      assert.equal(error.fileName, nativeDiagnosticFile);
      assert.equal(error.summary, "native-owned diagnostic");
      return true;
    },
  );
  const deferredNativeDiagnosticFile = resolve(projectRoot, "deferred-native-diagnostic.zs");
  assert.throws(
    () => analyzeSource("function main(): i32 { return missing; }", deferredNativeDiagnosticFile, {
      nativeFrontendResolver: () => {
        throw new NativeFrontendDiagnosticError(
          "parser",
          deferredNativeDiagnosticFile,
          1,
          1,
          "native parser diagnostic should defer",
        );
      },
    }),
    /unknown name "missing"/,
  );
  assert.throws(
    () => analyzeSource(source, example, {
      nativeFrontendResolver: () => {
        throw new Error("native frontend failed after stage 0 succeeded");
      },
    }),
    /native frontend failed after stage 0 succeeded/,
  );
});

test("diagnoses missing Z exports, missing files, cycles, and module binding collisions", () => {
  const directory = mkdtempSync("/tmp/z-modules-");
  const main = resolve(directory, "main.zs");
  const values = resolve(directory, "values.zs");
  writeFileSync(values, "function hidden(): i32 { return 42; }\n");

  const missingExport = `import { hidden } from "./values.zs"; function main(): i32 { return hidden(); }`;
  assert.throws(() => compileToC(missingExport, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /has no export "hidden"/);
    return true;
  });

  const missingFile = `import missing from "./missing.zs"; function main(): i32 { return 0; }`;
  assert.throws(() => compileToC(missingFile, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0602");
    assert.match(error.message, /could not find Z module/);
    return true;
  });

  const left = resolve(directory, "left.zs");
  const right = resolve(directory, "right.zs");
  writeFileSync(left, `import right from "./right.zs"; export function left(): i32 { return right.right(); }`);
  writeFileSync(right, `import left from "./left.zs"; export function right(): i32 { return left.left(); }`);
  const cycleMain = `import left from "./left.zs"; function main(): i32 { return left.left(); }`;
  assert.throws(() => compileToC(cycleMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0601");
    assert.match(error.message, /left\.zs -> right\.zs -> left\.zs/);
    return true;
  });

  writeFileSync(values, "export function answer(): i32 { return 42; }\n");
  const collision = `
    import { answer } from "./values.zs";
    function answer(): i32 { return 0; }
    function main(): i32 { return answer(); }
  `;
  assert.throws(() => compileToC(collision, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.equal(error.code, "Z0603");
    assert.match(error.message, /duplicate module binding "answer"/);
    return true;
  });

  const broken = resolve(directory, "broken.zs");
  writeFileSync(broken, `export function broken(): i32 { return missing; }`);
  const brokenMain = `import { broken } from "./broken.zs"; function main(): i32 { return broken(); }`;
  assert.throws(() => compileToC(brokenMain, main), (error: unknown) => {
    assert.ok(error instanceof DiagnosticError);
    assert.match(error.fileName, /broken\.zs$/);
    assert.match(error.message, /broken\.zs:1:40: error: unknown name "missing"/);
    return true;
  });
  const editorDiagnostic = diagnostics(brokenMain, main)[0];
  assert.match(editorDiagnostic.message, /broken\.zs: unknown name "missing"/);
  assert.match(editorDiagnostic.relatedInformation?.[0].location.uri ?? "", /broken\.zs$/);
});

test("preserves generic inference and local shadowing across Z modules", () => {
  const directory = mkdtempSync("/tmp/z-generic-modules-");
  const library = resolve(directory, "library.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(library, `
    export struct Pair<T> {
      first: T;
      second: T;
      function choose<U>(left: U, right: U): U {
        if (this.first > 0 && left == right) return left;
        return right;
      }
    }
    export struct Utility {
      static function preserve<T>(value: T): T { return value; }
    }
    class HiddenCounter { value: i32; }
    struct HiddenResource { value: i32; deinit {} }
    function helper(): i32 { return 0; }
    export function first<T>(in pair: Pair<T>): T { return pair.first; }
    export function shadowed(): i32 { const helper = 42; return helper; }
  `);
  const source = `
    import library from "./library.zs";
    import { first, Utility as Tools } from "./library.zs";
    function main(): i32 {
      const pair = library.Pair({ first: 20, second: 22 });
      const chosen = pair.choose(1, 2);
      const preserved = Tools.preserve<i32>(1);
      return library.first<i32>(pair) + first(pair) + library.shadowed() + chosen + preserved - 85;
    }
  `;
  const generated = compileToC(source, main);
  assert.match(generated, /__z_mono___z_module_\d+_Pair_i32/);
  assert.match(generated, /__z_mono_choose_i32/);
  assert.match(generated, /__z_mono_preserve_i32/);
  const sourcePath = resolve(directory, "main.zs");
  writeFileSync(sourcePath, source);
  const result = spawnSync(process.execPath, [cli, "run", sourcePath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("provides completion, hover, definitions, and semantic tokens across Z modules", () => {
  const example = resolve(projectRoot, "examples/language/modules/main.zs");
  const source = readFileSync(example, "utf8");
  const uri = `file://${example}`;

  const incompleteMember = source.replace("geometry.total", "geometry.to");
  const memberOffset = incompleteMember.indexOf("geometry.to") + "geometry.to".length;
  const memberItems = completions(incompleteMember, example, memberOffset);
  assert.equal(memberItems.find((item) => item.label === "total")?.kind, 3);
  const incompleteType = source.replace("geometry.Point", "geometry.P");
  const typeOffset = incompleteType.indexOf("geometry.P") + "geometry.P".length;
  assert.equal(completions(incompleteType, example, typeOffset).find((item) => item.label === "Point")?.kind, 22);

  const namespaceUse = source.indexOf("geometry.Point") + 1;
  assert.match(hover(source, example, namespaceUse)?.contents.value ?? "", /Z module/);
  const pointUse = source.indexOf("Point", source.indexOf("geometry.Point")) + 1;
  assert.match(hover(source, example, pointUse)?.contents.value ?? "", /struct Point/);
  const moveUse = source.indexOf("move(origin") + 1;
  const moveHover = hover(source, example, moveUse)?.contents.value ?? "";
  assert.match(moveHover, /function move\(in point: Point, dx: i32, dy: i32\): Point/);
  assert.match(moveHover, /Alias of `translate` from `"\.\/geometry\.zs"`\./);
  const moveDeclaration = source.indexOf("move", source.indexOf("translate as")) + 1;
  assert.match(hover(source, example, moveDeclaration)?.contents.value ?? "", /Alias of `translate`/);

  const totalUse = source.indexOf("total(moved") + 1;
  const totalDefinition = definition(source, uri, totalUse);
  assert.match(totalDefinition?.uri ?? "", /geometry\.zs$/);
  assert.equal(totalDefinition?.range.start.line, 11);
  const moveDefinition = definition(source, uri, moveUse);
  assert.match(moveDefinition?.uri ?? "", /geometry\.zs$/);
  assert.equal(moveDefinition?.range.start.line, 7);

  const symbolSource = source.replace("return 0;", "mov; return 0;");
  const symbolOffset = symbolSource.indexOf("mov;") + 3;
  const moveCompletion = completions(symbolSource, example, symbolOffset).find((item) => item.label === "move");
  assert.equal(moveCompletion?.kind, 3);
  assert.match(moveCompletion?.detail ?? "", /function move\(in point: Point, dx: i32, dy: i32\): Point/);
  assert.match(moveCompletion?.detail ?? "", /alias of translate from "\.\/geometry\.zs"/);

  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const namespacePosition = positionForOffset(source, source.indexOf("geometry.Point"));
  const pointPosition = positionForOffset(source, source.indexOf("Point", source.indexOf("geometry.Point")));
  assert.ok(tokens.some((token) => token.line === namespacePosition.line
    && token.character === namespacePosition.character
    && token.type === semanticTokenTypes.indexOf("namespace")));
  assert.ok(tokens.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));
});

test("suggests Z tokens while source and declaration syntax is incomplete", () => {
  const functionItems = completions("fun", "tokens.zs", 3);
  assert.equal(functionItems.find((item) => item.label === "function")?.kind, 14);
  assert.equal(functionItems.find((item) => item.label === "function")?.detail, "Z keyword");

  const returnItems = completions("function main(): i32 { ret", "tokens.zs", 26);
  assert.equal(returnItems.find((item) => item.label === "return")?.kind, 14);

  const declaration = `declare module "vendor.h" {\n  exp`;
  const declarationItems = completions(declaration, "vendor.h.zd", declaration.length);
  assert.equal(declarationItems.find((item) => item.label === "export")?.detail, "Z declaration keyword");
  assert.equal(declarationItems.some((item) => item.label === "match"), false);

  const capability = `declare module "vendor.h" {\n  export function use(ino`;
  const capabilityItems = completions(capability, "vendor.h.zd", capability.length);
  assert.equal(capabilityItems.find((item) => item.label === "inout")?.kind, 14);

  const inferredItems = completions("_", "vendor.h.zd", 1);
  assert.equal(inferredItems.find((item) => item.label === "_")?.detail, "infer type from the native declaration");

  const callbackContract = `declare module "vendor.h" {\n  export function apply(value: _, context: _, in operation: _): _ {\n    cal`;
  const callbackItems = completions(callbackContract, "vendor.h.zd", callbackContract.length);
  assert.equal(callbackItems.find((item) => item.label === "callback")?.detail, "Z declaration keyword");
  const contextItems = completions("cont", "vendor.h.zd", 4);
  assert.equal(contextItems.find((item) => item.label === "context")?.kind, 14);
  const threadItems = completions("thr", "vendor.h.zd", 3);
  assert.equal(threadItems.find((item) => item.label === "thread")?.kind, 14);
  const callerItems = completions("call", "vendor.h.zd", 4);
  assert.equal(callerItems.find((item) => item.label === "caller")?.detail, "Z declaration keyword");
});

test("suggests selective imports and typed object fields", () => {
  const moduleFile = resolve(projectRoot, "examples/language/modules/main.zs");
  const localImport = `import { tr } from "./geometry.zs"; function main(): i32 { return 0; }`;
  const localImportOffset = localImport.indexOf("tr }") + 2;
  const translate = completions(localImport, moduleFile, localImportOffset)
    .find((item) => item.label === "translate");
  assert.equal(translate?.kind, 3);
  assert.match(translate?.detail ?? "", /translate\(in point: Point, dx: i32, dy: i32\): Point/);

  const standardImport = `import { d } from "std/time"; function main(): i32 { return 0; }`;
  const standardImportOffset = standardImport.indexOf("d }") + 1;
  assert.match(
    completions(standardImport, moduleFile, standardImportOffset).find((item) => item.label === "delay")?.detail ?? "",
    /async delay\(milliseconds: u64\): void/,
  );

  const nativeFile = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-array.zs");
  const nativeImport = `import { zc } from "../../../tests/fixtures/move-only.hpp"; function main(): i32 { return 0; }`;
  const nativeImportOffset = nativeImport.indexOf("zc }") + 2;
  assert.equal(
    completions(nativeImport, nativeFile, nativeImportOffset).find((item) => item.label === "zcpp")?.kind,
    9,
  );

  const importedObject = `
    import geometry from "./geometry.zs";
    function main(): i32 {
      const point = geometry.Point({ x: 20, y });
      return point.x;
    }
  `;
  const importedFieldOffset = importedObject.indexOf("y }") + 1;
  const importedField = completions(importedObject, moduleFile, importedFieldOffset)
    .find((item) => item.label === "y");
  assert.equal(importedField?.detail, "y: i32");
  assert.equal(importedField?.insertText, "y: ");

  const objectPatterns = `
    struct User {
      id: i32;
      name: String;
    }
    enum SessionState {
      ready User,
      empty,
    }
    function inspect(in state: SessionState): i32 {
      const created = SessionState.ready({ id: 1, na });
      return match (in state) {
        ready({ id, na }) => id;
        empty => 0;
      };
    }
  `;
  const constructorOffset = objectPatterns.indexOf("na });") + 2;
  const constructorField = completions(objectPatterns, "object-patterns.zs", constructorOffset)
    .find((item) => item.label === "name");
  assert.equal(constructorField?.detail, "name: String");
  assert.equal(constructorField?.insertText, "name: ");
  const patternOffset = objectPatterns.lastIndexOf("na })") + 2;
  const patternItems = completions(objectPatterns, "object-patterns.zs", patternOffset);
  assert.equal(patternItems.some((item) => item.label === "id"), false);
  const patternField = patternItems.find((item) => item.label === "name");
  assert.equal(patternField?.detail, "name: String");
  assert.equal(patternField?.insertText, "name");
});

test("analyzes export-only files as modules while executable commands still require main", () => {
  const moduleFile = resolve(projectRoot, "examples/language/modules/geometry.zs");
  const source = readFileSync(moduleFile, "utf8");
  assert.doesNotThrow(() => check(source, moduleFile));
  assert.deepEqual(diagnostics(source, moduleFile), []);

  const pointOffset = source.indexOf("Point") + 1;
  assert.match(hover(source, moduleFile, pointOffset)?.contents.value ?? "", /struct Point/);
  assert.ok(semanticTokens(source, moduleFile).data.length > 0);

  const checkResult = spawnSync(process.execPath, [cli, "check", moduleFile], { encoding: "utf8" });
  assert.equal(checkResult.status, 0, checkResult.stderr);
  assert.match(checkResult.stdout, /geometry\.zs: ok/);

  assert.throws(() => compileToNative(source, moduleFile), /program must declare `function main\(\): i32`/);
  const runResult = spawnSync(process.execPath, [cli, "run", moduleFile], { encoding: "utf8" });
  assert.notEqual(runResult.status, 0);
  assert.match(runResult.stderr, /program must declare `function main\(\): i32`/);
});

test("resolves native headers relative to the Z module that imports them", () => {
  const directory = mkdtempSync("/tmp/z-native-module-");
  const libraryDirectory = resolve(directory, "library");
  mkdirSync(libraryDirectory);
  writeFileSync(resolve(libraryDirectory, "native.h"), `static inline int z_module_answer(void) { return 42; }\n`);
  writeFileSync(resolve(libraryDirectory, "native.zs"), `
    import native from "native.h";
    export function answer(): i32 { return native.z_module_answer(); }
  `);
  const main = resolve(directory, "main.zs");
  const source = `
    import { answer } from "./library/native.zs";
    function main(): i32 { return answer() - 42; }
  `;
  writeFileSync(main, source);
  const artifact = compileToNative(source, main);
  assert.match(artifact.source, /#include <native\.h>/);
  assert.ok(artifact.includeDirectories.some((item) => item.endsWith("/library")));
  const result = spawnSync(process.execPath, [cli, "run", main], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("selectively imports C types and constants with the same aliases used by functions", () => {
  const example = resolve(projectRoot, "examples/interop/c/selective-declarations.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective point=23,19 score=42\n");

  const generated = compileToC(source, example);
  assert.match(generated, /static ZDirection direction\(void\)/);
  assert.match(generated, /return ZForward;/);
  assert.match(generated, /static ZPoint shift\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /return z_translate\(point, direction\(\), amount\);/);
  assert.match(generated, /const ZPoint point = \(ZPoint\)\{ \.x = 20, \.y = 19 \};/);
  assert.doesNotMatch(generated, /\b(Point|Direction|Count|forward|translate|score)\s*\(/);

  const translateUse = source.lastIndexOf("translate(") + 2;
  const translateDefinition = definition(source, `file://${example}`, translateUse);
  assert.match(translateDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(translateDefinition?.range.start.line, 32);
});

test("preserves scalar typedef identity for typed native constants", () => {
  const example = resolve(projectRoot, "tests/fixtures/typed-scalar-constant.zs");
  const source = readFileSync(example, "utf8");
  const module = analyzeSource(source, example).foreignModules.get("geometry");
  assert.equal(
    module?.constants.get("ZCountDefault")?.typeName,
    "geometry.ZCount",
  );
  const generated = compileToC(source, example);
  assert.match(generated, /const ZCount amount = ZCountDefault;/);
  assert.match(generated, /const int64_t widened = .*ZCountDefault/);
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("imports typed object-like integer macros without textual substitution", () => {
  const example = resolve(projectRoot, "tests/fixtures/macro-constants.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /Z_STATIC_ANSWER/);

  const module = analyzeSource(source, example).foreignModules.get("macros");
  assert.equal(module?.constants.get("Z_MACRO_ANSWER")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_NEGATIVE")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_UNSIGNED")?.typeName, "u32");
  assert.equal(module?.constants.get("Z_MACRO_WIDE")?.typeName, "u64");
  assert.equal(module?.constants.get("Z_MACRO_MASK")?.typeName, "u32");
  assert.equal(module?.constants.get("Z_MACRO_LARGE_DECIMAL")?.typeName, "i64");
  assert.equal(module?.constants.get("Z_MACRO_ALIAS")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_EXPRESSION")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_FLAGS")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_MACRO_ANSWER")?.sourceKind, "macro");
  assert.equal(module?.constants.get("Z_STATIC_ANSWER")?.typeName, "i32");
  assert.equal(module?.constants.get("Z_STATIC_ANSWER")?.sourceKind, "variable");
  assert.equal(module?.constants.has("Z_MACRO_TEXT"), false);
  assert.equal(module?.constants.has("Z_MACRO_FUNCTION"), false);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const answerOffset = source.indexOf("Z_MACRO_ANSWER") + 2;
  assert.match(
    hover(source, example, answerOffset)?.contents.value ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );
  const answerDefinition = definition(source, `file://${example}`, answerOffset);
  assert.match(answerDefinition?.uri ?? "", /tests\/fixtures\/macro-constants\.h$/);
  assert.equal(answerDefinition?.range.start.line, 3);

  const staticOffset = source.indexOf("Z_STATIC_ANSWER") + 2;
  assert.match(
    hover(source, example, staticOffset)?.contents.value ?? "",
    /Z_STATIC_ANSWER: i32.*native global constant/,
  );
  const staticDefinition = definition(source, `file://${example}`, staticOffset);
  assert.match(staticDefinition?.uri ?? "", /tests\/fixtures\/macro-constants\.h$/);
  assert.equal(staticDefinition?.range.start.line, 4);

  const completionSource = source.replace("macros.Z_MACRO_ANSWER", "macros.Z_MACRO_A");
  const completionOffset = completionSource.indexOf("macros.Z_MACRO_A") + "macros.Z_MACRO_A".length;
  assert.match(
    completions(completionSource, example, completionOffset)
      .find((item) => item.label === "Z_MACRO_ANSWER")?.detail ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );
  const importCompletionSource = `
    import { Z_MACRO_A } from "tests/fixtures/macro-constants.h";
    function main(): i32 { return 0; }
  `;
  const importCompletionOffset = importCompletionSource.indexOf("Z_MACRO_A") + "Z_MACRO_A".length;
  assert.match(
    completions(importCompletionSource, resolve(projectRoot, "macro-import-completion.zs"), importCompletionOffset)
      .find((item) => item.label === "Z_MACRO_ANSWER")?.detail ?? "",
    /Z_MACRO_ANSWER: i32.*C object-like macro/,
  );

  const selective = `
    import { Z_MACRO_ANSWER as answer } from "tests/fixtures/macro-constants.h";
    function main(): i32 { return answer - 42; }
  `;
  assert.match(
    compileToC(selective, resolve(projectRoot, "selective-macro.zs")),
    /return z_checked_subtract_i32\(Z_MACRO_ANSWER, 42\);/,
  );
});

test("imports anonymous typedef enums and validates flat sidecars for qualified headers", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/anonymous-status.zs");
  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);
  assert.match(generated, /z_anonymous_start\(Z_ANONYMOUS_ALL\)/);
  assert.match(generated, /ZAnonymousStatus _z_native_status_/);
  assert.match(generated, /Z_ANONYMOUS_OK/);
  assert.match(generated, /Z_ANONYMOUS_FAILED/);

  const analysis = analyzeSource(source, fileName);
  const native = analysis.foreignModules.get("native");
  assert.equal(native?.namedTypes.get("ZAnonymousStatus")?.kind, "enum");
  assert.equal(native?.constants.get("Z_ANONYMOUS_OK")?.typeName, "native.ZAnonymousStatus");
  assert.equal(native?.constants.get("Z_ANONYMOUS_ALL")?.typeName, "i32");

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const declarationFile = resolve(projectRoot, "tests/fixtures/anonymous-status.h.zd");
  assert.deepEqual(diagnostics(readFileSync(declarationFile, "utf8"), declarationFile), []);
  const invalidDeclaration = readFileSync(declarationFile, "utf8")
    .replace("z_anonymous_start", "z_anonymous_missing");
  assert.match(
    diagnostics(invalidDeclaration, declarationFile)[0]?.message ?? "",
    /unknown foreign function "z_anonymous_missing"/,
  );
});

test("projects header constants and discriminated C variadic arguments through Z declarations", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/typed-variadic.zs");
  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);
  assert.match(generated, /z_typed_setopt\(Z_TYPED_TEXT, "typed"\)/);
  assert.match(generated, /z_typed_setopt\(Z_TYPED_TIMEOUT, \(long\)\(10LL\)\)/);
  assert.match(generated, /_z_native_status_\d+ == Z_TYPED_OK/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const alternateOption = source.replace("native.Z_TYPED_TEXT", "native.Z_TYPED_OTHER");
  assert.match(compileToC(alternateOption, fileName), /z_typed_setopt\(Z_TYPED_OTHER, "typed"\)/);

  const wrongOption = source.replace("native.Z_TYPED_TEXT", "native.Z_TYPED_UNKNOWN");
  assert.throws(
    () => compileToC(wrongOption, fileName),
    /no overload of foreign function "z_typed_setopt" accepts these arguments/,
  );

  const wrongValue = source.replace('"typed"', "42");
  assert.throws(
    () => compileToC(wrongValue, fileName),
    /no overload of foreign function "z_typed_setopt" accepts these arguments|expected cstring, found i32/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/typed-variadic.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const optionOffset = declarationSource.indexOf("Z_TYPED_TEXT") + 2;
  assert.match(
    hover(declarationSource, declarationFile, optionOffset)?.contents.value ?? "",
    /Z_TYPED_TEXT: .*ZTypedOption[\s\S]*exact native argument discriminant/,
  );
  const statusOffset = declarationSource.indexOf("Z_TYPED_OK") + 2;
  assert.match(
    hover(declarationSource, declarationFile, statusOffset)?.contents.value ?? "",
    /Z_TYPED_OK: .*ZTypedOption[\s\S]*successful void completion/,
  );
  const clongOffset = declarationSource.indexOf("clong") + 2;
  assert.match(
    hover(declarationSource, declarationFile, clongOffset)?.contents.value ?? "",
    /clong.*explicit safe type for a C variadic argument/,
  );
  const completionSource = declarationSource.replace("success Z_TYPED_OK;", "success Z_TYPED_");
  const completionOffset = completionSource.indexOf("success Z_TYPED_") + "success Z_TYPED_".length;
  assert.equal(
    completions(completionSource, declarationFile, completionOffset)
      .find((item) => item.label === "Z_TYPED_OK")?.kind,
    20,
  );
  const duplicateProjection = declarationSource.replace("option: Z_TYPED_OTHER", "option: Z_TYPED_TEXT");
  assert.match(
    diagnostics(duplicateProjection, declarationFile)[0]?.message ?? "",
    /duplicate typed variadic declaration/,
  );
});

test("ties projected native callbacks to their owner with a move-only connection", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/callback-connection.zs");
  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);

  assert.match(generated, /typedef struct Z_NativeConnection/);
  assert.match(generated, /Z_Slice_\S+ _z_callback_bytes = \{/);
  assert.match(generated, /\.length = \(uintptr_t\)\(native_argument_2\) \* \(uintptr_t\)\(native_argument_3\)/);
  assert.match(generated, /->call\([^,]+, _z_callback_bytes\)/);
  assert.doesNotMatch(generated, /->call\([^,]+, &_z_callback_bytes\)/);
  assert.match(generated, /z_callback_setopt\(owner, Z_CALLBACK_CONTEXT, callback_context\)/);
  assert.match(generated, /z_callback_setopt\(owner, Z_CALLBACK_WRITE, __z_c_callback_/);
  assert.match(
    generated,
    /disconnect_status = z_callback_setopt\(owner, Z_CALLBACK_WRITE, \(ZCallbackWrite\)NULL\)[\s\S]*if \(!\(disconnect_status == Z_CALLBACK_OK\)\) abort\(\);[\s\S]*disconnect_status = z_callback_setopt\(owner, Z_CALLBACK_CONTEXT, \(void \*\)NULL\)/,
  );
  assert.match(
    generated,
    /if \(_z_live_writer_\d+\) z_native_connection_deinit\(&\(writer\)\);\n\s+if \(_z_live_owner_\d+ && owner != NULL\) z_callback_close\(owner\);/,
  );

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const bytesOffset = source.indexOf("bytes: Slice") + 2;
  assert.match(hover(source, fileName, bytesOffset)?.contents.value ?? "", /bytes: Slice<u8>/);
  const callbackOffset = source.indexOf("move (bytes") + 1;
  assert.match(
    hover(source, fileName, callbackOffset)?.contents.value ?? "",
    /\(bytes: Slice<u8>\) => usize/,
  );
  assert.doesNotMatch(
    hover(source, fileName, callbackOffset)?.contents.value ?? "",
    /in bytes/,
  );
  const writerOffset = source.indexOf("writer =") + 2;
  assert.match(hover(source, fileName, writerOffset)?.contents.value ?? "", /writer: native\.Connection/);

  const discarded = source.replace("const writer = try native.z_callback_setopt(", "try native.z_callback_setopt(");
  const discardedDiagnostic = diagnostics(discarded, fileName)[0];
  assert.equal(discardedDiagnostic?.code, "Z0811");
  assert.match(
    discardedDiagnostic?.message ?? "",
    /native\.Connection must be bound/,
  );

  const earlyClose = source.replace(
    "try native.z_callback_perform(owner);",
    "native.z_callback_close(owner);",
  );
  assert.match(
    diagnostics(earlyClose, fileName)[0]?.message ?? "",
    /cannot move \"owner\" while native connection \"writer\" is live/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/callback-connection.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const mutableDirectory = mkdtempSync("/tmp/z-callback-mutable-projection-");
  const mutableHeader = resolve(mutableDirectory, "callback-connection.h");
  const mutableDeclaration = resolve(mutableDirectory, "callback-connection.h.zd");
  const mutableFile = resolve(mutableDirectory, "callback-connection.zs");
  writeFileSync(mutableHeader, readFileSync(resolve(projectRoot, "tests/fixtures/callback-connection.h"), "utf8"));
  writeFileSync(
    mutableDeclaration,
    declarationSource.replace("project bytes: Slice<u8>", "project inout bytes: Slice<u8>"),
  );
  const mutableSource = source
    .replace('import native from "callback-connection.h";', 'import native from "./callback-connection.h";')
    .replace("move (bytes: Slice<u8>)", "move (inout bytes: Slice<u8>)")
    .replace("return bytes.length;", "bytes[0] = 42; return bytes.length;");
  writeFileSync(mutableFile, mutableSource);
  const mutableGenerated = compileToC(mutableSource, mutableFile);
  assert.match(mutableGenerated, /->call\([^,]+, &_z_callback_bytes\)/);
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("connection throws") + 2,
    )?.contents.value ?? "",
    /connection throws .*ZCallbackStatus.*move-only native\.Connection/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("ZCallbackWrite") + 2,
    )?.contents.value ?? "",
    /header callback typedef projected to \(bytes: Slice<u8>\) => usize/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("Z_CALLBACK_CONTEXT") + 2,
    )?.contents.value ?? "",
    /native option used to install the retained callback context/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("owner owner") + "owner ".length + 2,
    )?.contents.value ?? "",
    /callback connection cannot outlive this native owner/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("invoked repeatedly") + 2,
    )?.contents.value ?? "",
    /invoked repeatedly.*zero or more native invocations/,
  );
  const invocationCompletionSource = declarationSource.replace("invoked repeatedly;", "invoked rep");
  const invocationCompletionOffset = invocationCompletionSource.indexOf("invoked rep") + "invoked rep".length;
  assert.equal(
    completions(invocationCompletionSource, declarationFile, invocationCompletionOffset)
      .find((item) => item.label === "repeatedly")?.insertText,
    "repeatedly;",
  );
  const typeCompletionSource = declarationSource.replace("type ZCallbackWrite;", "type ZCall");
  const typeCompletionOffset = typeCompletionSource.indexOf("type ZCall") + "type ZCall".length;
  assert.equal(
    completions(typeCompletionSource, declarationFile, typeCompletionOffset)
      .find((item) => item.label === "ZCallbackWrite")?.insertText,
    "ZCallbackWrite;",
  );
  const ownerCompletionSource = declarationSource.replace("owner owner;", "owner ow");
  const ownerCompletionOffset = ownerCompletionSource.indexOf("owner ow") + "owner ow".length;
  assert.equal(
    completions(ownerCompletionSource, declarationFile, ownerCompletionOffset)
      .find((item) => item.label === "owner")?.insertText,
    "owner;",
  );
  const byteCompletionSource = declarationSource.replace("data buffer;", "data bu");
  const byteCompletionOffset = byteCompletionSource.indexOf("data bu") + "data bu".length;
  assert.match(
    completions(byteCompletionSource, declarationFile, byteCompletionOffset)
      .find((item) => item.label === "buffer")?.detail ?? "",
    /buffer: char \*/,
  );
  const factorCompletionSource = declarationSource.replace("size * nitems;", "size * ni");
  const factorCompletionOffset = factorCompletionSource.indexOf("size * ni") + "size * ni".length;
  assert.match(
    completions(factorCompletionSource, declarationFile, factorCompletionOffset)
      .find((item) => item.label === "nitems")?.detail ?? "",
    /nitems: size_t/,
  );
  const invalidProjection = declarationSource.replace("data buffer;", "data missing;");
  assert.match(
    diagnostics(invalidProjection, declarationFile)[0]?.message ?? "",
    /byte projection names unknown callback parameter \"missing\"/,
  );
  const wrongCardinality = declarationSource.replace("invoked repeatedly;", "invoked once;");
  assert.match(
    diagnostics(wrongCardinality, declarationFile)[0]?.message ?? "",
    /callback connection.*requires `invoked repeatedly;`/,
  );
  const missingCardinality = declarationSource.replace("      invoked repeatedly;\n", "");
  assert.match(
    diagnostics(missingCardinality, declarationFile)[0]?.message ?? "",
    /requires explicit invocation cardinality/,
  );
});

test("projects an ordinary native pointer and length as one borrowed byte slice", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/byte-buffer.zs");
  const source = readFileSync(fileName, "utf8");
  const generated = compileToC(source, fileName);

  assert.match(generated, /z_byte_sum\(\(\(bytes\)\.data\), 3\)/);
  assert.match(generated, /z_byte_increment\(\(\(bytes\)\.data\), 3\)/);
  assert.doesNotMatch(generated, /z_byte_sum\([^)]*Z_Slice/);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const functionOffset = source.indexOf("z_byte_sum") + 2;
  assert.match(
    hover(source, fileName, functionOffset)?.contents.value ?? "",
    /z_byte_sum\(input: Slice<u8>\): i32/,
  );
  const mutableFunctionOffset = source.indexOf("z_byte_increment") + 2;
  assert.match(
    hover(source, fileName, mutableFunctionOffset)?.contents.value ?? "",
    /z_byte_increment\(inout bytes: Slice<u8>\): void/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/byte-buffer.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("project input") + 2,
    )?.contents.value ?? "",
    /input: Slice<u8>.*named borrowed argument/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("inout bytes: Slice") + 2,
    )?.contents.value ?? "",
    /inout bytes: Slice<u8>/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("data data;") + "data ".length + 2,
    )?.contents.value ?? "",
    /native pointer supplied by input\.data/,
  );
  assert.match(
    hover(
      declarationSource,
      declarationFile,
      declarationSource.indexOf("length length;") + "length ".length + 2,
    )?.contents.value ?? "",
    /hidden native length supplied by input\.length/,
  );

  const bufferCompletionSource = declarationSource.replace("data data;", "data da");
  const bufferCompletionOffset = bufferCompletionSource.indexOf("data da") + "data da".length;
  assert.match(
    completions(bufferCompletionSource, declarationFile, bufferCompletionOffset)
      .find((item) => item.label === "data")?.detail ?? "",
    /native pointer projected as Slice<u8>\.data/,
  );
  const lengthCompletionSource = declarationSource.replace("length length;", "length len");
  const lengthCompletionOffset = lengthCompletionSource.lastIndexOf("length len") + "length len".length;
  assert.match(
    completions(lengthCompletionSource, declarationFile, lengthCompletionOffset)
      .find((item) => item.label === "length")?.detail ?? "",
    /native length derived from Slice<u8>\.length/,
  );

  const missingBorrow = declarationSource.replace("in data: _", "data: _");
  assert.match(
    diagnostics(missingBorrow, declarationFile)[0]?.message ?? "",
    /projection "input" requires native parameter "data" to use in/,
  );
  const wrongName = declarationSource.replace("data data;", "data missing;");
  assert.match(
    diagnostics(wrongName, declarationFile)[0]?.message ?? "",
    /byte projection names unknown function parameter "missing"/,
  );
  const redundantProjectionIn = declarationSource.replace("project input:", "project in input:");
  assert.match(
    diagnostics(redundantProjectionIn, declarationFile)[0]?.message ?? "",
    /Slice projections are already borrowed; omit `in`/,
  );
  const unsupportedElement = declarationSource.replace("project input: Slice<u8>", "project input: Slice<f32>");
  assert.match(
    diagnostics(unsupportedElement, declarationFile)[0]?.message ?? "",
    /support only `Slice<u8>`/,
  );
  const mutableAsReadOnly = declarationSource
    .replace("inout data: _", "in data: _")
    .replace("project inout bytes:", "project bytes:");
  assert.match(
    diagnostics(mutableAsReadOnly, declarationFile)[0]?.message ?? "",
    /read-only projection requires a const native byte pointer/,
  );
  const constAsMutable = declarationSource
    .replace("in data: _", "inout data: _")
    .replace("project input:", "project inout input:");
  assert.match(
    diagnostics(constAsMutable, declarationFile)[0]?.message ?? "",
    /inout projection requires a mutable native byte pointer/,
  );
  const missingInout = source.replace("native.z_byte_increment(inout bytes);", "native.z_byte_increment(bytes);");
  assert.match(
    diagnostics(missingInout, fileName)[0]?.message ?? "",
    /requires inout <mutable binding> for projected parameter "bytes"/,
  );
  const immutableInout = source.replace("let bytes:", "const bytes:");
  assert.match(
    diagnostics(immutableInout, fileName)[0]?.message ?? "",
    /inout argument "bytes" requires a mutable let binding/,
  );

  const overflow = source.replace("[19, 20, 0]", "[256, 20, 0]");
  assert.match(
    diagnostics(overflow, fileName)[0]?.message ?? "",
    /integer literal 256 does not fit u8/,
  );
  const wrongLength = source.replace("u8[3]", "u8[4]");
  assert.match(
    diagnostics(wrongLength, fileName)[0]?.message ?? "",
    /expected u8\[4\], found u8\[3\]/,
  );

  const dynamicSource = `
    import native from "tests/fixtures/byte-buffer.h";

    function sum(bytes: Slice<u8>): i32 {
      return native.z_byte_sum(bytes);
    }

    function main(): i32 {
      let bytes = Array<u8>();
      bytes.push(20);
      bytes.push(21);
      bytes.push(1);
      return native.z_byte_sum(bytes) + sum(bytes) - 84;
    }
  `;
  const dynamicFile = resolve(projectRoot, "byte-buffer-dynamic.zs");
  const dynamicGenerated = compileToC(dynamicSource, dynamicFile);
  assert.match(dynamicGenerated, /z_byte_sum\(\(\(bytes\)\.data\), \(\(bytes\)\.length\)\)/);
  const dynamicDirectory = mkdtempSync("/tmp/z-byte-buffer-");
  const dynamicRunFile = resolve(dynamicDirectory, "main.zs");
  writeFileSync(dynamicRunFile, dynamicSource.replace(
    '"tests/fixtures/byte-buffer.h"',
    JSON.stringify(resolve(projectRoot, "tests/fixtures/byte-buffer.h")),
  ));
  const dynamicResult = spawnSync(process.execPath, [cli, "run", dynamicRunFile], { encoding: "utf8" });
  assert.equal(dynamicResult.status, 0, dynamicResult.stderr);
});

test("keeps unselected C types and constants out of scope", () => {
  const missingType = `
    import { z_score } from "tests/fixtures/geometry.h";
    function inspect(point: ZPoint): i32 { return z_score(point); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(missingType, resolve(projectRoot, "selective-type-scope.zs")),
    /unknown type "ZPoint"/,
  );

  const missingConstant = `
    import { ZDirection } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const direction: ZDirection = ZForward;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(missingConstant, resolve(projectRoot, "selective-constant-scope.zs")),
    /unknown name "ZForward"/,
  );
});

test("shares imported C type identity across namespace and selective imports", () => {
  const source = `
    import geometry from "tests/fixtures/geometry.h";
    import { ZPoint as Point, z_read } from "tests/fixtures/geometry.h";
    function main(): i32 {
      const point: Point = geometry.ZPoint({ x: 20, y: 22 });
      return z_read(point);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "selective-record.zs"));
  assert.match(generated, /return z_read\(&\(point\)\);/);
});

test("imports C function signatures through Clang", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const written = stdio.puts("typed");
      return written;
    }
  `;
  const generated = compileToC(source, "typed-header.zs");
  assert.match(generated, /const int32_t written = puts\("typed"\);/);
  assert.equal(analyzeSource(source, "typed-header.zs").foreignModules.get("stdio")?.producer, "clang");
});

test("passes typed Z functions to call-only C callbacks with optional context adapters", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-main.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /z_apply_i32\(6, 7, multiply\)/);
  assert.match(generated, /z_apply_twice_i32\(40, __z_closure_call_[0-9]+\)/);
  assert.match(
    generated,
    /z_apply_context_i32\(40, \(void \*\)&\(addOffset\), __z_c_callback_Z_Function_[0-9a-f]+_context_1\)/,
  );
  assert.match(
    generated,
    /static __attribute__\(\(unused\)\) int32_t __z_c_callback_Z_Function_[0-9a-f]+_context_1\(int32_t argument1, void \*callback_context\)/,
  );
  assert.match(generated, /Z_Function_[0-9a-f]+_c_escape_box\(Z_Function_[0-9a-f]+ value\)/);
  assert.match(generated, /Z_Function_[0-9a-f]+_c_escape_box_release\(void \*context\)/);
  assert.match(
    generated,
    /z_register_context_callback\(__z_c_callback_Z_Function_[0-9a-f]+_context_1, Z_Function_[0-9a-f]+_c_escape_box\(escaped\), Z_Function_[0-9a-f]+_c_escape_box_release\)/,
  );

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "escape-drop=2\n");

  const callbackUse = source.indexOf("operation);") + 1;
  assert.match(hover(source, fixture, callbackUse)?.contents.value ?? "", /operation: \(left: i32, right: i32\) => i32/);
  const importedUse = source.indexOf("z_apply_i32") + 1;
  assert.match(
    hover(source, fixture, importedUse)?.contents.value ?? "",
    /callback: \(argument1: i32, argument2: i32\) => i32/,
  );
  const contextUse = source.indexOf("z_apply_context_i32") + 1;
  const contextDetail = hover(source, fixture, contextUse)?.contents.value ?? "";
  assert.match(contextDetail, /z_apply_context_i32\(value: i32, callback: \(argument1: i32\) => i32\): i32/);
  const escapingUse = source.indexOf("z_register_context_callback") + 1;
  assert.match(
    hover(source, fixture, escapingUse)?.contents.value ?? "",
    /z_register_context_callback\(move callback: \(argument1: i32\) => i32\): void/,
  );
  const completionSource = source.replace("callbacks.z_apply_i32", "callbacks.z_app");
  const completionOffset = completionSource.indexOf("callbacks.z_app") + "callbacks.z_app".length;
  assert.match(
    completions(completionSource, fixture, completionOffset).find((item) => item.label === "z_apply_i32")?.detail ?? "",
    /callback: \(argument1: i32, argument2: i32\) => i32/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/callbacks.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const declarationFunction = declarationSource.indexOf("z_apply_i32") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declarationFunction)?.contents.value ?? "",
    /z_apply_i32\(left: i32, right: i32, callback: \(argument1: i32, argument2: i32\) => i32\): i32/,
  );
  const declarationCallback = declarationSource.indexOf("callback: _") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declarationCallback)?.contents.value ?? "",
    /in callback: \(argument1: i32, argument2: i32\) => i32/,
  );
  const declarationCallbackType = declarationSource.indexOf("callback: _") + "callback: ".length;
  assert.match(
    hover(declarationSource, declarationFile, declarationCallbackType)?.contents.value ?? "",
    /_: \(argument1: i32, argument2: i32\) => i32/,
  );
  const declarationCompletionSource = declarationSource.replace("in callback: _", "in cal");
  const declarationCompletionOffset = declarationCompletionSource.indexOf("in cal") + "in cal".length;
  assert.equal(
    completions(declarationCompletionSource, declarationFile, declarationCompletionOffset)
      .find((item) => item.label === "callback")?.insertText,
    "callback: _",
  );
  const callbackRelation = declarationSource.indexOf("callback callback") + "callback ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, callbackRelation)?.contents.value ?? "",
    /call-scoped callback using native context context/,
  );
  const contextRelation = declarationSource.indexOf("context context") + "context ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, contextRelation)?.contents.value ?? "",
    /context: void \*.*native context for callback callback/,
  );
  const callbackRelationSource = declarationSource.replace("callback callback {", "callback call {");
  const callbackRelationOffset = callbackRelationSource.indexOf("callback call") + "callback call".length;
  assert.equal(
    completions(callbackRelationSource, declarationFile, callbackRelationOffset)
      .find((item) => item.label === "callback")?.kind,
    6,
  );
  const contextRelationSource = declarationSource.replace("context context;", "context cont;");
  const contextRelationOffset = contextRelationSource.indexOf("context cont") + "context cont".length;
  assert.equal(
    completions(contextRelationSource, declarationFile, contextRelationOffset)
      .find((item) => item.label === "context")?.kind,
    6,
  );
  const escapingCallbackRelation = declarationSource.lastIndexOf("callback callback") + "callback ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, escapingCallbackRelation)?.contents.value ?? "",
    /move callback:.*escaping retained callback using native context context/,
  );
  const releaseRelation = declarationSource.lastIndexOf("deinit release") + "deinit ".length + 2;
  assert.match(
    hover(declarationSource, declarationFile, releaseRelation)?.contents.value ?? "",
    /release: void \(\s*\*\)\(void \*\).*exactly-once native release/,
  );
  const callerRelation = declarationSource.lastIndexOf("caller") + 2;
  assert.match(
    hover(declarationSource, declarationFile, callerRelation)?.contents.value ?? "",
    /only on the registering thread/,
  );
  const releaseCompletionSource = declarationSource.replace("deinit release;", "deinit rel;");
  const releaseCompletionOffset = releaseCompletionSource.indexOf("deinit rel") + "deinit rel".length;
  assert.equal(
    completions(releaseCompletionSource, declarationFile, releaseCompletionOffset)
      .find((item) => item.label === "release")?.kind,
    6,
  );

  const wrongShape = source.replace(
    "function multiply(left: i32, right: i32): i32 {\n  return left * right;\n}",
    "function multiply(left: i32): i32 {\n  return left;\n}",
  );
  assert.throws(
    () => compileToC(wrongShape, fixture),
    /native callback expects \(argument1: i32, argument2: i32\) => i32, found \(left: i32\) => i32/,
  );

  const capturedCallback = source.replace(
    "const add: (left: i32, right: i32) => i32 =\n    (left: i32, right: i32): i32 => left + right;",
    "const capturedOffset = 0;\n  const add: (left: i32, right: i32) => i32 =\n    move (left: i32, right: i32): i32 => left + right + capturedOffset;",
  );
  const capturedDiagnostic = diagnostics(capturedCallback, fixture).find((diagnostic) => diagnostic.code === "Z0213");
  assert.match(capturedDiagnostic?.message ?? "", /function value carries or may carry an environment/);

  const unclassified = source.replace(
    "const product = callbacks.z_apply_i32(6, 7, operation);",
    "callbacks.z_store_callback(operation); const product = callbacks.z_apply_i32(6, 7, operation);",
  );
  assert.throws(
    () => compileToC(unclassified, fixture),
    /z_store_callback.*unsupported type.*ZBinaryCallback/,
  );
});

test("passes contextual inline closures directly to imported C callbacks", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-inline.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /z_apply_i32\(6, 7, __z_closure_call_[0-9]+\)/);
  assert.match(generated, /z_apply_context_i32\(40, \(void \*\)&\(_z_argument_[0-9]+\), __z_c_callback_/);
  assert.match(generated, /z_register_context_callback\(__z_c_callback_[^,]+, Z_Function_[0-9a-f]+_c_escape_box\(_z_argument_[0-9]+\)/);
  assert.doesNotMatch(generated, /__atomic_(?:add|sub)_fetch\(&environment->refcount/);

  const parameter = source.indexOf("(left, right)") + 2;
  assert.match(hover(source, fixture, parameter)?.contents.value ?? "", /left: i32/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "inline-escape-drop=2\n");
});

test("routes an escaping C callback through a class-owned Z handler map", () => {
  const example = resolve(
    projectRoot,
    "examples/applications/message-router/native-callback.zs",
  );
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(generated, /retainOperation\(__z_c_callback_/);
  assert.match(generated, /_c_escape_box\(_z_argument_[0-9]+\)/);
  assert.match(generated, /Router_dispatch\(router, &\(message\)\)/);
  assert.match(generated, /Router_retain\(router\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "native callback routed=42\n",
  );
});

test("narrows thrown callback errors to declared native failure values", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callback-failure.zs");
  const declarationFile = resolve(projectRoot, "tests/fixtures/callback-failure.h.zd");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /Z_Result_i32_VisitError _z_callback_result = .*->call/);
  assert.match(generated, /_z_callback_result\.tag == .*failure/);
  assert.match(generated, /Z_VisitError_deinit\(&\(_z_callback_result\.data\.failure\)\)/);
  assert.match(generated, /return 1;/);
  assert.match(generated, /return _z_callback_result\.data\.success;/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const withoutFailure = readFileSync(
    resolve(projectRoot, "tests/fixtures/callback-failure.h.zd"),
    "utf8",
  ).replace("      failure 1;\n", "");
  const directory = mkdtempSync("/tmp/z-callback-failure-");
  writeFileSync(resolve(directory, "callback-failure.h"), readFileSync(
    resolve(projectRoot, "tests/fixtures/callback-failure.h"),
    "utf8",
  ));
  writeFileSync(resolve(directory, "callback-failure.h.zd"), withoutFailure);
  const missingContractSource = source.replace(
    'import native from "callback-failure.h";',
    'import native from "./callback-failure.h";',
  );
  const missingFile = resolve(directory, "main.zs");
  writeFileSync(missingFile, missingContractSource);
  assert.match(
    diagnostics(missingContractSource, missingFile)[0]?.message ?? "",
    /throwing callback .* has no native failure projection/,
  );

  const declarationSource = readFileSync(declarationFile, "utf8");
  const failureKeyword = declarationSource.indexOf("failure 1");
  assert.match(
    hover(declarationSource, declarationFile, failureKeyword + 2)?.contents.value ?? "",
    /thrown Z callback error is destroyed here and narrowed/,
  );
  const failureValue = failureKeyword + "failure ".length;
  assert.match(
    hover(declarationSource, declarationFile, failureValue)?.contents.value ?? "",
    /returned through the native callback ABI/,
  );
  const completionSource = declarationSource.replace("      failure 1;", "      fai");
  const completionOffset = completionSource.lastIndexOf("fai") + "fai".length;
  assert.equal(
    completions(completionSource, declarationFile, completionOffset)
      .find((item) => item.label === "failure")?.insertText,
    "failure ",
  );
  assert.match(
    diagnostics(
      declarationSource.replace("failure 1;", "success 1;"),
      declarationFile,
    )[0]?.message ?? "",
    /success inside callback .* return successful values from the Z callback body instead/,
  );
  assert.match(
    diagnostics(
      declarationSource.replace("success Z_VISIT_OK;", "success Z_VISIT_OK;\n    failure 1;"),
      declarationFile,
    )[0]?.message ?? "",
    /failure is scoped to a callback return/,
  );
});

test("rejects invalid C callback and context declaration pairs", () => {
  const directory = mkdtempSync("/tmp/z-callback-context-notes-");
  const header = resolve(directory, "invalid-context.h");
  const sourceFile = resolve(directory, "main.zs");
  writeFileSync(header, `
    #include <stdint.h>
    typedef int32_t (*InvalidContextCallback)(int32_t value, void *context);
    static inline int32_t invalid_context(
      int32_t value,
      int32_t *not_context,
      InvalidContextCallback callback
    ) {
      (void)not_context;
      (void)callback;
      return value;
    }
  `);
  writeFileSync(`${header}.zd`, `
    declare module "invalid-context.h" {
      export function invalid_context(value: _, not_context: _, in callback: _): _ {
        callback callback {
          context not_context;
          invoked once;
        }
      }
    }
  `);
  const source = `
    import invalid from "invalid-context.h";
    function identity(value: i32): i32 { return value; }
    function main(): i32 { return invalid.invalid_context(42, identity); }
  `;
  writeFileSync(sourceFile, source);
  assert.throws(
    () => compileToC(source, sourceFile),
    /do not describe a valid callback and void \* context pair/,
  );
});

test("rejects escaping C callbacks without complete release and threading contracts", () => {
  const directory = mkdtempSync("/tmp/z-escaping-callback-notes-");
  const header = resolve(directory, "escaping.h");
  const sourceFile = resolve(directory, "main.zs");
  writeFileSync(header, `
    #include <stdint.h>
    typedef int32_t (*EscapingCallback)(int32_t value, void *context);
    typedef void (*EscapingRelease)(void *context);
    static inline void retain_callback(EscapingCallback callback, void *context, EscapingRelease release) {
      (void)callback;
      (void)context;
      (void)release;
    }
  `);
  writeFileSync(`${header}.zd`, `
    declare module "escaping.h" {
      export function retain_callback(move callback: _, context: _, release: _): _ {
        callback callback {
          context context;
          invoked repeatedly;
        }
      }
    }
  `);
  const source = `
    import escaping from "escaping.h";
    function identity(value: i32): i32 { return value; }
    function main(): i32 { escaping.retain_callback(identity); return 0; }
  `;
  writeFileSync(sourceFile, source);
  const diagnostic = diagnostics(source, sourceFile).find((item) => item.code === "Z0214");
  assert.match(diagnostic?.message ?? "", /requires deinit and thread contracts/);

  writeFileSync(`${header}.zd`, `
    declare module "escaping.h" {
      export function retain_callback(in callback: _, context: _, release: _): _ {
        callback callback {
          context context;
          invoked once;
          thread any;
        }
      }
    }
  `);
  assert.throws(
    () => compileToC(source, sourceFile),
    /call-scoped callback "callback" cannot declare deinit or threading contracts/,
  );
});

test("owns arbitrary-thread native callback environments atomically and checks captures", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/callbacks-any-thread.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /__atomic_add_fetch\(&environment->refcount, 1, __ATOMIC_RELAXED\)/);
  assert.match(generated, /__atomic_sub_fetch\(&environment->refcount, 1, __ATOMIC_ACQ_REL\)/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/callbacks-any-thread.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const threadHover = hover(
    declarationSource,
    declarationFile,
    declarationSource.indexOf("any;") + 1,
  );
  assert.match(threadHover?.contents.value ?? "", /arbitrary threads/);

  const result = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const mutableCapture = `
    import callbacks from "callbacks-any-thread.h";
    function main(): i32 {
      let offset = 2;
      callbacks.z_start_any_thread_callback(
        40,
        move (value) => { offset = value; return offset; }
      );
      return callbacks.z_join_any_thread_callback();
    }
  `;
  const mutable = diagnostics(mutableCapture, fixture).find((item) => item.code === "Z0704");
  assert.match(mutable?.message ?? "", /mutable capture "offset" cannot enter an arbitrary-thread native callback/);

  const borrowedCapture = `
    import callbacks from "callbacks-any-thread.h";
    class CalculationInput { readonly offset: i32; }
    function install(in input: CalculationInput): void {
      callbacks.z_start_any_thread_callback(40, move (value) => value + input.offset);
    }
    function main(): i32 { return 0; }
  `;
  const borrowed = diagnostics(borrowedCapture, fixture).find((item) => item.code === "Z0704");
  assert.match(borrowed?.message ?? "", /borrowed capture "input" cannot enter an arbitrary-thread native callback/);

  const namedFunction = `
    import callbacks from "callbacks-any-thread.h";
    function increment(value: i32): i32 { return value + 1; }
    function main(): i32 {
      callbacks.z_start_any_thread_callback(41, increment);
      return callbacks.z_join_any_thread_callback() - 42;
    }
  `;
  assert.doesNotThrow(() => compileToC(namedFunction, fixture));

  const borrowedTextParameter = `
    import callbacks from "callbacks-any-thread.h";
    function main(): i32 {
      callbacks.z_invoke_any_thread_text_callback(
        move (value): void => {
          const copied = String.from(value);
          if (copied.byteLength == 0) return;
        }
      );
      return 0;
    }
  `;
  assert.doesNotThrow(() => compileToC(borrowedTextParameter, fixture));

  const objectiveCObjectParameter = `
    import native from "objc-blocks.h";
    function main(): i32 {
      native.ZObjCBlockFixture.invokeObjectOnWorker(
        move (value): void => {
          const copied: String = value;
          if (copied.byteLength == 0) return;
        }
      );
      return 0;
    }
  `;
  assert.doesNotThrow(() => compileToC(
    objectiveCObjectParameter,
    resolve(projectRoot, "tests/fixtures/objc-object-callback.zs"),
  ));

  const completionFile = resolve(projectRoot, "tests/fixtures/objc-object-completion.zs");
  const generatedCompletion = compileToC(
    readFileSync(completionFile, "utf8"),
    completionFile,
  );
  assert.match(generatedCompletion, /NSString \* result;/);
  assert.match(generatedCompletion, /bool live_result;/);
  const completion = spawnSync(
    process.execPath,
    [cli, "run", completionFile],
    { encoding: "utf8" },
  );
  assert.equal(completion.status, 0, completion.stderr);

  const linkedCompletionFile = resolve(
    projectRoot,
    "tests/fixtures/objc-object-completion-main.zs",
  );
  const linkedCompletion = spawnSync(
    process.execPath,
    [cli, "run", linkedCompletionFile],
    { encoding: "utf8" },
  );
  assert.equal(linkedCompletion.status, 0, linkedCompletion.stderr);

  const storedEnvironment = `
    import callbacks from "callbacks-any-thread.h";
    function main(): i32 {
      const offset = 2;
      const operation: (value: i32) => i32 = move (value) => value + offset;
      callbacks.z_start_any_thread_callback(40, operation);
      return callbacks.z_join_any_thread_callback() - 42;
    }
  `;
  const stored = diagnostics(storedEnvironment, fixture).find((item) => item.code === "Z0704");
  assert.match(stored?.message ?? "", /requires an inline closure or named function/);

  const mainCallerLeak = `
    import callbacks from "callbacks-any-thread.h";
    import { Once } from "std/sync";
    import { thread } from "std/thread";

    class Application {
      published: i32 on thread.main;
    }

    const application = Once<Application>();

    function currentApplication(): Application {
      return application.get();
    }

    function main(): i32 on thread.main {
      callbacks.z_start_any_thread_callback(
        42,
        move (value): i32 => {
          const current = currentApplication();
          current.published = value;
          return value;
        }
      );
      return 0;
    }
  `;
  const mainCallerDiagnostic = diagnostics(mainCallerLeak, fixture).find((item) => item.code === "Z0711");
  assert.match(mainCallerDiagnostic?.message ?? "", /field .*Application.*published.*requires thread\.main/);
});

test("rejects unknown functions from imported headers", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.not_a_real_function("nope");
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-name.zs"),
    /header "stdio\.h" has no function "not_a_real_function"/,
  );
});

test("checks fixed C arguments and variadic boundaries", () => {
  const wrongType = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.puts(42);
    }
  `;
  assert.throws(
    () => compileToC(wrongType, "foreign-type.zs"),
    /expected cstring, found i32/,
  );

  const missingFormat = `
    import stdio from "stdio.h";
    function main(): i32 {
      return stdio.printf();
    }
  `;
  assert.throws(
    () => compileToC(missingFormat, "foreign-variadic.zs"),
    /C function "printf" expects at least 1 argument\(s\), found 0/,
  );
});

test("reports unsupported C signatures at the Z call site", () => {
  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      stdio.freopen("file", "r", "unsupported");
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-pointer.zs"),
    /C function "freopen" uses unsupported type "FILE \*"/,
  );
});

test("requires and enforces checked contracts for pointer-bearing C value resources", () => {
  const directory = mkdtempSync("/tmp/z-native-value-diagnostic-");
  const header = resolve(directory, "native-value.h");
  const declaration = `${header}.zd`;
  const fileName = resolve(directory, "main.zs");
  writeFileSync(header, `
    typedef struct NativeImage {
      void *data;
      int width;
    } NativeImage;

    static inline NativeImage z_image_load(void) {
      NativeImage image = { 0, 0 };
      return image;
    }

    static inline void z_image_unload(NativeImage image) {
      (void)image;
    }
  `);
  const source = `
    import native from "./native-value.h";
    function main(): i32 {
      const image = native.z_image_load();
      return 0;
    }
  `;
  writeFileSync(fileName, source);

  const direct = diagnostics(source, fileName)[0];
  assert.equal(direct.code, "Z0823");
  assert.match(direct.message, /native record "NativeImage" by value.*contains pointer storage/);
  assert.match(direct.message, /adjacent \.zd/);
  assert.match(direct.message, /raw c\/cpp\/objc/);
  assert.doesNotMatch(direct.message, /place a local unverified call inside `unsafe/);

  writeFileSync(declaration, `
    declare module "native-value.h" {
      export type NativeImage {
        move;
        deinit z_image_unload;
      }
      export function z_image_load(): _ {
      }
      export function z_image_unload(move image: _): _;
    }
  `);
  const missingOwnership = diagnostics(source, fileName)[0];
  assert.equal(missingOwnership.code, "Z0823");
  assert.match(missingOwnership.message, /requires an explicit ownership capability/);

  writeFileSync(
    declaration,
    readFileSync(declaration, "utf8").replace("export function z_image_load(): _ {\n", "export function z_image_load(): _ {\n        owned;\n"),
  );
  assert.deepEqual(diagnostics(source, fileName), []);
  assert.match(compileToNative(source, fileName).source, /z_image_unload\(image\)/);

  rmSync(declaration);
  const unsafeSource = source.replace(
    "const image = native.z_image_load();",
    "unsafe { const image = native.z_image_load(); }",
  );
  const unsafeDiagnostic = diagnostics(unsafeSource, fileName)[0];
  assert.equal(unsafeDiagnostic.code, "Z0823");
  assert.match(unsafeDiagnostic.message, /unsafe cannot represent native record "NativeImage" passed by value/);
  assert.match(unsafeDiagnostic.message, /raw c\/cpp\/objc/);
  assert.doesNotMatch(unsafeDiagnostic.message, /checked \.zd projection/);
});

test("moves, borrows, aliases, and destroys native C value resources", () => {
  const fileName = resolve(projectRoot, "tests/fixtures/value-resource-main.zs");
  const source = `
    import native from "./value-resource.h";

    struct Loaded {
      image: native.ZImage;
    }

    enum Asset {
      image native.ZImage,
      empty,
    }

    function exercise(): i32 {
      let image = native.z_image_make(40);
      native.z_image_flip(inout image);
      const copied = native.z_image_copy(image);
      const loaded = Loaded({ image: move image });
      const texture = native.z_texture_make(loaded.image);
      const systemTexture = native.z_texture_default();
      const width = native.z_texture_width(systemTexture);
      native.z_texture_drop(move texture);
      const asset = Asset.image(move copied);
      return width - 1;
    }

    function main(): i32 {
      const result = exercise();
      return result + native.z_resource_live_count();
    }
  `;
  assert.deepEqual(diagnostics(source, fileName), []);
  const generated = compileToNative(source, fileName).source;
  assert.match(generated, /ZImage image = z_image_make\(40\)/);
  assert.match(generated, /z_image_flip\(&\(image\)\)/);
  assert.match(generated, /ZTexture2D texture = z_texture_make/);
  assert.match(generated, /z_texture_drop\(texture\)/);
  assert.match(generated, /z_image_drop/);

  // The CLI consumes files, so execute an equivalent temporary source.
  const directory = mkdtempSync("/tmp/z-value-resource-run-");
  const runnable = resolve(directory, "main.zs");
  writeFileSync(runnable, source.replace("./value-resource.h", resolve(projectRoot, "tests/fixtures/value-resource.h")));
  const run = spawnSync(process.execPath, [cli, "run", runnable], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.status, 0);

  const movedTwice = source.replace(
    "native.z_texture_drop(move texture);",
    "native.z_texture_drop(move texture);\n      native.z_texture_drop(move texture);",
  );
  assert.match(diagnostics(movedTwice, fileName)[0]?.message ?? "", /moved value "texture"/);

  const aliasContract = analyzeSource(source, fileName)
    .foreignModules.get("native")?.namedTypes.get("ZTexture2D");
  assert.equal(aliasContract?.kind, "record");
  if (aliasContract?.kind === "record") {
    assert.deepEqual(aliasContract.resource, { release: "z_texture_drop" });
  }

  const borrowedEscape = `
    import native from "./value-resource.h";
    struct Theme { texture: native.ZTexture2D; }
    function main(): i32 {
      const texture = native.z_texture_default();
      const theme = Theme({ texture });
      return native.z_texture_width(theme.texture);
    }
  `;
  const borrowedDiagnostic = diagnostics(borrowedEscape, fileName)[0];
  assert.equal(borrowedDiagnostic.code, "Z0206");
  assert.match(borrowedDiagnostic.message, /borrowed native resource cannot be stored in a struct field/i);

  const borrowedArray = `
    import native from "./value-resource.h";
    function main(): i32 {
      const texture = native.z_texture_default();
      const textures = [texture];
      return textures.length;
    }
  `;
  assert.match(diagnostics(borrowedArray, fileName)[0]?.message ?? "", /borrowed native resource cannot be stored in an array/i);

  const borrowedEnum = `
    import native from "./value-resource.h";
    enum MaybeTexture { some native.ZTexture2D, none }
    function main(): i32 {
      const texture = native.z_texture_default();
      const selected = MaybeTexture.some(texture);
      return 0;
    }
  `;
  assert.match(diagnostics(borrowedEnum, fileName)[0]?.message ?? "", /borrowed native resource cannot be stored in an enum payload/i);

  const borrowedClass = `
    import native from "./value-resource.h";
    class Theme { texture: native.ZTexture2D; }
    function main(): i32 {
      const texture = native.z_texture_default();
      const theme = new Theme({ texture });
      return native.z_texture_width(theme.texture);
    }
  `;
  assert.match(
    diagnostics(borrowedClass, fileName)[0]?.message ?? "",
    /ARC class fields cannot store move-only native values|borrowed native resource cannot be stored in a struct field/i,
  );

  const borrowedReturn = `
    import native from "./value-resource.h";
    function currentTexture(): native.ZTexture2D {
      const texture = native.z_texture_default();
      return texture;
    }
    function main(): i32 { return native.z_texture_width(currentTexture()); }
  `;
  assert.match(diagnostics(borrowedReturn, fileName)[0]?.message ?? "", /borrowed native resource cannot be returned from a function/i);

  const borrowedCapture = `
    import native from "./value-resource.h";
    function main(): i32 {
      const texture = native.z_texture_default();
      const inspect: () => i32 = (): i32 => native.z_texture_width(texture);
      return inspect();
    }
  `;
  assert.match(diagnostics(borrowedCapture, fileName)[0]?.message ?? "", /borrowed native resource "texture" cannot be captured/i);

  const borrowedSuspension = `
    import native from "./value-resource.h";
    import { delay } from "std/time";
    async function main(): i32 {
      const texture = native.z_texture_default();
      await delay(1);
      return native.z_texture_width(texture);
    }
  `;
  assert.match(
    diagnostics(borrowedSuspension, fileName)[0]?.message ?? "",
    /cannot await while borrowed storage "texture" is live/i,
  );

  const copiedResource = source.replace(
    "const copied = native.z_image_copy(image);",
    "const copied = copy image;",
  );
  assert.match(diagnostics(copiedResource, fileName)[0]?.message ?? "", /type native\.ZImage cannot be explicitly copied/i);

  const resourceLiteral = `
    import native from "./value-resource.h";
    function main(): i32 {
      const texture = native.ZTexture({ id: 1, width: 1 });
      return texture.width;
    }
  `;
  assert.match(diagnostics(resourceLiteral, fileName)[0]?.message ?? "", /native value resource .* cannot be constructed with a Z struct literal/i);

  const fieldMutation = `
    import native from "./value-resource.h";
    function main(): i32 {
      let texture = native.z_texture_make(native.z_image_make(1));
      texture.width = 2;
      return texture.width;
    }
  `;
  assert.match(diagnostics(fieldMutation, fileName)[0]?.message ?? "", /native resource field "width" is read-only in safe Z/i);

  const declarationFile = resolve(projectRoot, "tests/fixtures/value-resource.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const resourceTypeOffset = declarationSource.indexOf("ZTexture") + 2;
  assert.match(
    hover(declarationSource, declarationFile, resourceTypeOffset)?.contents.value ?? "",
    /move-only native C resource.*z_texture_drop/s,
  );
  const ownedOffset = declarationSource.indexOf("owned") + 2;
  assert.match(
    hover(declarationSource, declarationFile, ownedOffset)?.contents.value ?? "",
    /caller receives unique native value-resource ownership and deterministic cleanup/s,
  );
  const borrowedOffset = declarationSource.indexOf("borrowed") + 2;
  assert.match(
    hover(declarationSource, declarationFile, borrowedOffset)?.contents.value ?? "",
    /native runtime retains ownership.*lexical and non-escaping/s,
  );
  const lifecycleCompletionSource = declarationSource.replace(
    "export type ZTexture {\n    move;",
    "export type ZTexture {\n    mo",
  );
  const lifecycleCompletionOffset = lifecycleCompletionSource.indexOf(
    "mo",
    lifecycleCompletionSource.indexOf("export type ZTexture"),
  ) + 2;
  assert.equal(
    completions(lifecycleCompletionSource, declarationFile, lifecycleCompletionOffset)
      .find((item) => item.label === "move")?.insertText,
    "move;",
  );
  const resultCompletionSource = declarationSource.replace("owned;", "own");
  const resultCompletionOffset = resultCompletionSource.indexOf("own") + 3;
  assert.equal(
    completions(resultCompletionSource, declarationFile, resultCompletionOffset)
      .find((item) => item.label === "owned")?.insertText,
    "owned;",
  );
});

test("fails closed on contradictory or unverifiable C value-resource contracts", () => {
  const directory = mkdtempSync("/tmp/z-value-resource-contract-");
  const header = resolve(directory, "value-resource.h");
  const declaration = `${header}.zd`;
  const sourceFile = resolve(directory, "main.zs");
  const headerSource = readFileSync(resolve(projectRoot, "tests/fixtures/value-resource.h"), "utf8");
  const declarationSource = readFileSync(resolve(projectRoot, "tests/fixtures/value-resource.h.zd"), "utf8");
  writeFileSync(header, headerSource);
  writeFileSync(sourceFile, `
    import native from "./value-resource.h";
    function main(): i32 {
      const image = native.z_image_make(1);
      return native.z_image_width(image);
    }
  `);

  const both = declarationSource.replace("owned;", "owned;\n    borrowed;");
  writeFileSync(declaration, both);
  assert.match(
    diagnostics(both, declaration)[0]?.message ?? "",
    /cannot declare both owned and borrowed result ownership/i,
  );

  const conflictingAlias = declarationSource.replace(
    "export function z_image_make",
    `export type ZTexture2D {
    move;
    deinit z_image_drop;
  }

  export function z_image_make`,
  );
  writeFileSync(declaration, conflictingAlias);
  assert.match(
    diagnostics(conflictingAlias, declaration)[0]?.message ?? "",
    /aliases for canonical C record .* conflicting resource facts/i,
  );

  const invalidRelease = declarationSource.replace("deinit z_image_drop;", "deinit z_image_width;");
  writeFileSync(declaration, invalidRelease);
  assert.match(
    diagnostics(invalidRelease, declaration)[0]?.message ?? "",
    /value-resource deinit "z_image_width" must name a C function taking the classified record by value and returning void/i,
  );

  writeFileSync(header, `
    typedef union ZNativeUnion {
      void *pointer;
      int value;
    } ZNativeUnion;
    static inline void z_union_drop(ZNativeUnion value) { (void)value; }
  `);
  const unionContract = `
    declare module "value-resource.h" {
      export type ZNativeUnion {
        move;
        deinit z_union_drop;
      }
    }
  `;
  writeFileSync(declaration, unionContract);
  assert.match(
    diagnostics(unionContract, declaration)[0]?.message ?? "",
    /value-resource contract "ZNativeUnion" requires a C struct, found union/i,
  );

  writeFileSync(header, `
    typedef struct ZPoint { int x; int y; } ZPoint;
    static inline ZPoint z_point_make(void) { ZPoint value = { 1, 2 }; return value; }
  `);
  const ordinaryOwned = `
    declare module "value-resource.h" {
      export function z_point_make(): _ {
        owned;
      }
    }
  `;
  writeFileSync(declaration, ordinaryOwned);
  assert.match(
    diagnostics(ordinaryOwned, declaration)[0]?.message ?? "",
    /owned result ownership on "z_point_make" requires a classified native value-resource return/i,
  );
});

test("narrows, borrows, consumes, and cleans up owned C handles", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-handle.zs");
  const exampleSource = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrote handle\n");
  assert.equal(readFileSync("/tmp/z-lang-foreign-handle.txt", "utf8"), "owned by Z\n");

  const declarationOffset = exampleSource.indexOf("file =") + 1;
  const guardOffset = exampleSource.indexOf("file == null") + 1;
  const narrowedOffset = exampleSource.indexOf("file);", exampleSource.indexOf("fputs")) + 1;
  assert.match(hover(exampleSource, example, declarationOffset)?.contents.value ?? "", /file: stdio\.FILE \| null/);
  assert.match(hover(exampleSource, example, guardOffset)?.contents.value ?? "", /file: stdio\.FILE \| null/);
  assert.match(hover(exampleSource, example, narrowedOffset)?.contents.value ?? "", /file: stdio\.FILE(?! \| null)/);

  const source = `
    import stdio from "stdio.h";
    function main(): i32 {
      const file = stdio.fopen("/tmp/z-lang-double-close.txt", "w");
      if (file == null) { return 1; }
      stdio.fclose(file);
      return stdio.fclose(file);
    }
  `;
  assert.throws(
    () => compileToC(source, "foreign-consume.zs"),
    /use of moved value "file"/,
  );
});

test("discovers owned-handle contracts from adjacent Z declaration files", () => {
  const source = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      const handle = handles.z_test_open();
      if (handle == null) { return 1; }
      return handles.z_test_use(handle);
    }
  `;
  const generated = compileToC(source, resolve(projectRoot, "foreign-local-notes.zs"));
  assert.match(generated, /ZTestHandle \* const handle = z_test_open\(\);/);
  assert.match(generated, /if \(_z_live_handle_0 && handle != NULL\) z_test_close\(handle\);/);

  const borrowedSource = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      const handle = handles.z_test_default();
      if (handle == null) return 1;
      return handles.z_test_use(handle);
    }
  `;
  const borrowedGenerated = compileToC(
    borrowedSource,
    resolve(projectRoot, "foreign-borrowed-handle.zs"),
  );
  assert.match(borrowedGenerated, /ZTestHandle \* const handle = z_test_default\(\);/);
  assert.doesNotMatch(borrowedGenerated, /z_test_close\(handle\)/);
  const borrowedBindingOffset = borrowedSource.indexOf("handle =") + 2;
  assert.match(
    hover(
      borrowedSource,
      resolve(projectRoot, "foreign-borrowed-handle.zs"),
      borrowedBindingOffset,
    )?.contents.value ?? "",
    /borrowed native resource; non-escaping/,
  );

  assert.throws(
    () => compileToC(
      `import handles from "tests/fixtures/foreign-handles.h";
       function expose(): handles.ZTestHandle | null {
         return handles.z_test_default();
       }
       function main(): i32 { return 0; }`,
      resolve(projectRoot, "foreign-borrowed-return.zs"),
    ),
    /a borrowed native resource cannot be returned from a function/,
  );
  assert.throws(
    () => compileToC(
      `import handles from "tests/fixtures/foreign-handles.h";
       struct StoredHandle { handle: handles.ZTestHandle; }
       function main(): i32 {
         const handle = handles.z_test_default();
         if (handle == null) return 1;
         const stored = StoredHandle({ handle });
         return handles.z_test_use(stored.handle);
       }`,
      resolve(projectRoot, "foreign-borrowed-storage.zs"),
    ),
    /a borrowed native resource cannot be stored in a struct field/,
  );
  assert.throws(
    () => compileToC(
      `import handles from "tests/fixtures/foreign-handles.h";
       function main(): i32 {
         const handle = handles.z_test_default();
         if (handle == null) return 1;
         const inspect = (): i32 => handles.z_test_use(handle);
         return inspect();
       }`,
      resolve(projectRoot, "foreign-borrowed-capture.zs"),
    ),
    /borrowed native resource "handle" cannot be captured/,
  );
  assert.throws(
    () => compileToC(
      `import handles from "tests/fixtures/foreign-handles.h";
       function main(): i32 {
         const invalid = Option.fromNullable(handles.z_test_default());
         return 0;
       }`,
      resolve(projectRoot, "foreign-borrowed-option.zs"),
    ),
    /a borrowed native resource cannot be lifted into Option storage/,
  );

  const outputSource = `
    import handles from "tests/fixtures/foreign-handles.h";
    function main(): i32 {
      let handle;
      const status = handles.z_test_create(out handle);
      if (status != 0) return 1;
      if (handle == null) return 1;
      return handles.z_test_created_use(handle);
    }
  `;
  const outputGenerated = compileToC(outputSource, resolve(projectRoot, "foreign-output-handle.zs"));
  assert.match(outputGenerated, /ZCreatedHandle \*handle = NULL;/);
  assert.match(outputGenerated, /z_test_create\(&\(handle\)\)/);
  assert.match(outputGenerated, /if \(_z_live_handle_\d+ && handle != NULL\) z_test_created_close\(handle\);/);
  const outputBindingOffset = outputSource.indexOf("handle;") + 2;
  assert.match(hover(outputSource, resolve(projectRoot, "foreign-output-handle.zs"), outputBindingOffset)?.contents.value ?? "", /handle: handles\.ZCreatedHandle \| null/);
  assert.match(
    diagnostics("function main(): i32 { let unresolved; return 0; }", "unresolved-out.zs")[0]?.message ?? "",
    /cannot infer type of uninitialized let "unresolved"/,
  );

  const declarationFile = resolve(projectRoot, "tests/fixtures/foreign-handles.h.zd");
  assert.deepEqual(diagnostics(readFileSync(declarationFile, "utf8"), declarationFile), []);
  const declarationCheck = spawnSync(process.execPath, [cli, "check", declarationFile], { encoding: "utf8" });
  assert.equal(declarationCheck.status, 0, declarationCheck.stderr);
  assert.match(declarationCheck.stdout, /foreign-handles\.h\.zd: ok/);

  const declarationSource = readFileSync(declarationFile, "utf8");
  const functionOffset = declarationSource.indexOf("z_test_open") + 2;
  assert.match(hover(declarationSource, declarationFile, functionOffset)?.contents.value ?? "", /z_test_open\(\): ZTestHandle \* \| null/);
  const returnTypeOffset = declarationSource.indexOf("_ | null");
  assert.match(hover(declarationSource, declarationFile, returnTypeOffset)?.contents.value ?? "", /_: ZTestHandle \* \| null; deinit z_test_close/);
  const closeOffset = declarationSource.indexOf("z_test_close", declarationSource.indexOf("deinit")) + 2;
  assert.match(hover(declarationSource, declarationFile, closeOffset)?.contents.value ?? "", /deinitializer for z_test_open result/);
  const closeDeclarationOffset = declarationSource.indexOf("z_test_close(move handle");
  const handleParameterOffset = declarationSource.indexOf("handle: _", closeDeclarationOffset) + 2;
  assert.match(hover(declarationSource, declarationFile, handleParameterOffset)?.contents.value ?? "", /move handle: ZTestHandle \*/);
  const handleTypeOffset = declarationSource.indexOf("handle: _", closeDeclarationOffset) + "handle: ".length;
  assert.match(hover(declarationSource, declarationFile, handleTypeOffset)?.contents.value ?? "", /_: ZTestHandle \*/);

  const functionCompletionSource = declarationSource.replace("z_test_open", "z_test_op");
  const functionCompletionOffset = functionCompletionSource.indexOf("z_test_op") + "z_test_op".length;
  assert.equal(
    completions(functionCompletionSource, declarationFile, functionCompletionOffset).find((item) => item.label === "z_test_open")?.kind,
    3,
  );
  const parameterCompletionSource = declarationSource.replace("z_test_use(in handle: _)", "z_test_use(in han)");
  const parameterCompletionOffset = parameterCompletionSource.indexOf("han)") + 3;
  const parameterCompletion = completions(parameterCompletionSource, declarationFile, parameterCompletionOffset)
    .find((item) => item.label === "handle");
  assert.equal(parameterCompletion?.insertText, "handle: _");
  const deinitCompletionSource = declarationSource.replace("deinit z_test_close", "deinit z_test_cl");
  const deinitCompletionOffset = deinitCompletionSource.indexOf("z_test_cl") + "z_test_cl".length;
  assert.equal(
    completions(deinitCompletionSource, declarationFile, deinitCompletionOffset).find((item) => item.label === "z_test_close")?.kind,
    3,
  );
  const threadOffset = declarationSource.indexOf("thread") + 2;
  assert.match(
    hover(declarationSource, declarationFile, threadOffset)?.contents.value ?? "",
    /native thread contract for the z_test_open result/,
  );
  const transferOffset = declarationSource.indexOf("transfer") + 2;
  assert.match(
    hover(declarationSource, declarationFile, transferOffset)?.contents.value ?? "",
    /ownership may move to another thread/,
  );
  const transferCompletionSource = declarationSource.replace("transfer;", "trans");
  const transferCompletionOffset = transferCompletionSource.indexOf("trans") + "trans".length;
  assert.equal(
    completions(transferCompletionSource, declarationFile, transferCompletionOffset)
      .find((item) => item.label === "transfer")?.insertText,
    "transfer;",
  );

  const example = resolve(projectRoot, "examples/interop/c/declared-handle.zs");
  const exampleSource = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "declared handle=42\n");
  const exampleC = compileToC(exampleSource, example);
  assert.match(exampleC, /typedef ZDeclaredHandle \*Z_Option_/);
  assert.match(exampleC, /if \(_z_match_\d+ != NULL\)/);
  assert.match(exampleC, /z_declared_close\(value\);/);
  assert.doesNotMatch(exampleC, /struct Z_Option/);

  const optionBinding = exampleSource.indexOf("handle = Option") + 2;
  assert.match(hover(exampleSource, example, optionBinding)?.contents.value ?? "", /handle: Option<native\.ZDeclaredHandle>/);
  const payloadBinding = exampleSource.indexOf("value)", exampleSource.indexOf("some(")) + 2;
  assert.match(hover(exampleSource, example, payloadBinding)?.contents.value ?? "", /value: native\.ZDeclaredHandle/);

  const narrowedSource = exampleSource.replace(
    "const handle = Option.fromNullable(native.z_declared_open(value));",
    `const raw = native.z_declared_open(value);
  if (raw == null) return -1;
  const handle = Option.fromNullable(raw);`,
  );
  assert.throws(
    () => compileToC(narrowedSource, example),
    /Option\.fromNullable requires native\.ZDeclaredHandle \| null, found owned native\.ZDeclaredHandle/,
  );

  const storedOwnerSource = `
    import handles from "tests/fixtures/foreign-handles.h";
    class HandleOwner {
      private handle: handles.ZTestHandle;

      constructor() throws i32 {
        const handle = handles.z_test_open();
        if (handle == null) throw 1;
        this.handle = move handle;
      }

      function read(): i32 {
        return handles.z_test_use(this.handle);
      }
    }

    function inspectMaybe(handle: handles.ZTestHandle | null): i32 {
      if (handle == null) return 0;
      return handles.z_test_use(handle);
    }

    function lift(handle: handles.ZTestHandle | null): Option<handles.ZTestHandle> {
      return Option.fromNullable(handle);
    }

    function main(): i32 {
      const opened = attempt new HandleOwner();
      return match (opened) {
        success(owner) => owner.read();
        failure(status) => status;
      };
    }
  `;
  const storedOwnerFile = resolve(projectRoot, "foreign-stored-handle.zs");
  const storedOwnerGenerated = compileToC(storedOwnerSource, storedOwnerFile);
  assert.match(storedOwnerGenerated, /ZTestHandle \* handle;/);
  assert.match(storedOwnerGenerated, /z_test_close\(self->handle\);/);
  const storedTypeOffset = storedOwnerSource.indexOf("handles.ZTestHandle") + "handles.".length + 2;
  assert.match(
    hover(storedOwnerSource, storedOwnerFile, storedTypeOffset)?.contents.value ?? "",
    /handles\.ZTestHandle/,
  );
  const partialStoredOwner = storedOwnerSource.replace("handles.ZTestHandle", "handles.ZTestH");
  const partialStoredOwnerOffset = partialStoredOwner.indexOf("handles.ZTestH") + "handles.ZTestH".length;
  const handleCompletion = completions(
    partialStoredOwner,
    storedOwnerFile,
    partialStoredOwnerOffset,
  ).find((item) => item.label === "ZTestHandle");
  assert.match(handleCompletion?.detail ?? "", /owned opaque native handle ZTestHandle \*; deinit z_test_close/);
});

test("ties borrowed C pointer views to an explicit native owner", () => {
  const fileName = resolve(projectRoot, "owner-tied-borrowed-handle.zs");
  const source = `
    import native from "tests/fixtures/owned-handle-native.h";

    function child(in owner: native.ZOwnedHandle): Option<view native.ZOwnedChild> {
      return Option.fromNullable(native.z_owned_handle_child(in owner));
    }

    function main(): i32 {
      const owner = native.z_owned_handle_open(42);
      if (owner == null) return 1;
      const label = native.z_owned_handle_label(in owner);
      if (label == null) return -2;
      const selected = child(in owner);
      return match (in selected) {
        some(value) => native.z_owned_child_read(value);
        none => -1;
      };
    }
  `;
  const generated = compileToC(source, fileName);
  assert.match(generated, /return z_owned_handle_child\(owner\);/);
  assert.match(generated, /const char \* const label = z_owned_handle_label\(owner\);/);
  assert.match(generated, /selected = child\(owner\);/);
  assert.match(generated, /z_owned_child_read\(value\)/);
  assert.match(generated, /z_owned_handle_close\(owner\)/);

  const childOffset = source.indexOf("selected =") + 2;
  assert.match(
    hover(source, fileName, childOffset)?.contents.value ?? "",
    /selected: Option<view native\.ZOwnedChild>/,
  );

  const movedOwner = `
    import native from "tests/fixtures/owned-handle-native.h";
    function main(): i32 {
      const owner = native.z_owned_handle_open(42);
      if (owner == null) return 1;
      const child = native.z_owned_handle_child(owner);
      native.z_owned_handle_close(move owner);
      if (child == null) return 2;
      return native.z_owned_child_read(child);
    }
  `;
  assert.match(
    diagnostics(movedOwner, fileName)[0]?.message ?? "",
    /cannot (?:move|consume).*owner.*view "child" is live/i,
  );

  const erasedBorrow = `
    import native from "tests/fixtures/owned-handle-native.h";
    function main(): i32 {
      const owner = native.z_owned_handle_open(42);
      if (owner == null) return 1;
      const child: Option<native.ZOwnedChild> = Option.fromNullable(
        native.z_owned_handle_child(in owner)
      );
      return 0;
    }
  `;
  assert.match(
    diagnostics(erasedBorrow, fileName)[0]?.message ?? "",
    /requires `Option<view T>` so its owner provenance remains visible/,
  );

  const invalidatedView = `
    import native from "tests/fixtures/owned-handle-native.h";
    function main(): i32 {
      const owner = native.z_owned_handle_open(42);
      if (owner == null) return 1;
      const child = native.z_owned_handle_child(in owner);
      native.z_owned_handle_advance(in owner);
      if (child == null) return 2;
      return native.z_owned_child_read(in child);
    }
  `;
  const invalidationDiagnostic = diagnostics(invalidatedView, fileName)[0];
  assert.equal(invalidationDiagnostic.code, "Z0205");
  assert.match(
    invalidationDiagnostic.message,
    /cannot call "z_owned_handle_advance" because it can invalidate views derived from "owner" while view "child" is live/,
  );

  const copiedBeforeInvalidation = invalidatedView.replace(
    "native.z_owned_handle_advance(in owner);\n      if (child == null) return 2;\n      return native.z_owned_child_read(in child);",
    "if (child == null) return 2;\n      const observed = native.z_owned_child_read(in child);\n      native.z_owned_handle_advance(in owner);\n      return observed;",
  );
  assert.deepEqual(diagnostics(copiedBeforeInvalidation, fileName), []);
  assert.match(compileToC(copiedBeforeInvalidation, fileName), /z_owned_handle_advance\(owner\)/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/owned-handle-native.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const borrowedOffset = declarationSource.indexOf("borrowed from handle") + 2;
  assert.match(
    hover(declarationSource, declarationFile, borrowedOffset)?.contents.value ?? "",
    /borrowed from handle.*input owner is live/,
  );
  const ownerOffset = declarationSource.indexOf("handle;", borrowedOffset) + 2;
  assert.match(
    hover(declarationSource, declarationFile, ownerOffset)?.contents.value ?? "",
    /handle: owner.*lifetime source/,
  );
  const fromCompletionSource = declarationSource.replace("borrowed from handle;", "borrowed fr");
  const fromCompletionOffset = fromCompletionSource.indexOf("borrowed fr") + "borrowed fr".length;
  assert.equal(
    completions(fromCompletionSource, declarationFile, fromCompletionOffset)
      .find((item) => item.label === "from")?.insertText,
    "from ",
  );
  const ownerCompletionSource = declarationSource.replace("borrowed from handle;", "borrowed from han");
  const ownerCompletionOffset = ownerCompletionSource.indexOf("borrowed from han") + "borrowed from han".length;
  assert.equal(
    completions(ownerCompletionSource, declarationFile, ownerCompletionOffset)
      .find((item) => item.label === "handle")?.insertText,
    "handle;",
  );
  const invalidatesOffset = declarationSource.indexOf("invalidates handle") + 2;
  assert.match(
    hover(declarationSource, declarationFile, invalidatesOffset)?.contents.value ?? "",
    /invalidates handle.*may invalidate every outstanding view/,
  );
  const invalidatesCompletionSource = declarationSource.replace("invalidates handle;", "invalidates han");
  const invalidatesCompletionOffset = invalidatesCompletionSource.indexOf("invalidates han") + "invalidates han".length;
  assert.equal(
    completions(invalidatesCompletionSource, declarationFile, invalidatesCompletionOffset)
      .find((item) => item.label === "handle")?.insertText,
    "handle;",
  );
  const grammar = readFileSync(resolve(projectRoot, "editors/vscode/syntaxes/z.tmLanguage.json"), "utf8");
  assert.match(grammar, /\\b\(invalidates\)\\\\s\+\(\[A-Za-z_\]/);
});

test("projects native integer statuses into typed throws and preserves out cleanup", () => {
  const example = resolve(projectRoot, "tests/fixtures/status-api.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);

  assert.match(generated, /const int32_t _z_native_status_\d+ = z_status_open\(7, &\(handle\)\);/);
  assert.match(generated, /_z_live_handle_\d+ = true;/);
  assert.match(generated, /_z_native_status_\d+ == 0/);
  assert.match(generated, /_z_native_status_\d+ == 0 \|\| _z_native_status_\d+ == 2/);
  assert.match(generated, /Z_Result_void_i32_failure/);
  assert.match(generated, /z_status_close\(handle\);/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const declarationFile = resolve(projectRoot, "tests/fixtures/status-api.h.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);

  const functionOffset = declarationSource.indexOf("z_status_open") + 2;
  assert.match(
    hover(declarationSource, declarationFile, functionOffset)?.contents.value ?? "",
    /z_status_open\(status: i32, out handle: ZStatusHandle \* \| null\): void throws i32/,
  );
  const voidOffset = declarationSource.indexOf("void throws");
  assert.match(
    hover(declarationSource, declarationFile, voidOffset)?.contents.value ?? "",
    /void throws i32.*native integer status/,
  );
  const throwsOffset = declarationSource.indexOf("throws") + 2;
  assert.match(
    hover(declarationSource, declarationFile, throwsOffset)?.contents.value ?? "",
    /throws i32.*inferred from the native integer status/,
  );
  const successOffset = declarationSource.indexOf("success") + 2;
  assert.match(
    hover(declarationSource, declarationFile, successOffset)?.contents.value ?? "",
    /success 0.*successful void completion/,
  );
  const completionSource = declarationSource.replace("success 0;", "suc");
  const completionOffset = completionSource.indexOf("suc") + 3;
  assert.equal(
    completions(completionSource, declarationFile, completionOffset)
      .find((item) => item.label === "success")?.insertText,
    "success ",
  );
  const resultBindingOffset = source.indexOf("plainSuccess =") + 2;
  assert.match(
    hover(source, example, resultBindingOffset)?.contents.value ?? "",
    /plainSuccess: Result<void, i32>/,
  );

  assert.throws(
    () => compileToC(
      `import native from "tests/fixtures/status-api.h";
       function main(): i32 {
         native.z_status_plain(0);
         return 0;
       }`,
      resolve(projectRoot, "unhandled-native-status.zs"),
    ),
    /throwing native call requires `attempt` or `try`/,
  );
});

test("diagnoses malformed and mismatched Z declaration contracts", () => {
  const unknownBorrowOwner = `
    declare module "contract.h" {
      export function child(in handle: _): _ | null {
        borrowed from missing;
      }
    }
  `;
  assert.match(
    diagnostics(unknownBorrowOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /names unknown owner parameter "missing"/,
  );

  const mutableBorrowOwner = `
    declare module "contract.h" {
      export function child(inout handle: _): _ | null {
        borrowed from handle;
      }
    }
  `;
  assert.match(
    diagnostics(mutableBorrowOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /owner "handle" must be an immutable `in` parameter/,
  );

  const nullableBorrowOwner = `
    declare module "contract.h" {
      export function child(in handle: _ | null): _ | null {
        borrowed from handle;
      }
    }
  `;
  assert.match(
    diagnostics(nullableBorrowOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /owner "handle" must be non-null/,
  );

  const unknownInvalidatedOwner = `
    declare module "contract.h" {
      export function advance(in handle: _): _ {
        invalidates missing;
      }
    }
  `;
  assert.match(
    diagnostics(unknownInvalidatedOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /names unknown owner parameter "missing"/,
  );

  const mutableInvalidatedOwner = `
    declare module "contract.h" {
      export function advance(inout handle: _): _ {
        invalidates handle;
      }
    }
  `;
  assert.match(
    diagnostics(mutableInvalidatedOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /invalidated owner "handle" must be an immutable `in` parameter/,
  );

  const nullableInvalidatedOwner = `
    declare module "contract.h" {
      export function advance(in handle: _ | null): _ {
        invalidates handle;
      }
    }
  `;
  assert.match(
    diagnostics(nullableInvalidatedOwner, "/tmp/contract.h.zd")[0]?.message ?? "",
    /invalidated owner "handle" must be non-null/,
  );

  const malformed = `
    declare module "contract.h" {
      export function known(): invented;
    }
  `;
  const malformedDiagnostic = diagnostics(malformed, "/tmp/contract.h.zd")[0];
  assert.equal(malformedDiagnostic.code, "Z0801");
  assert.match(malformedDiagnostic.message, /requires `_` for a header-derived type/);

  const executableContract = `
    declare module "contract.h" {
      export function known(): _ {
        return 1;
      }
    }
  `;
  const executableDiagnostic = diagnostics(executableContract, "/tmp/contract.h.zd")[0];
  assert.equal(executableDiagnostic.code, "Z0801");
  assert.match(executableDiagnostic.message, /expected "async", "project", "deinit", "owned", "borrowed", "invalidates", "thread", "callback", or "success" in foreign function contract/);

  const threadWithoutOwner = `
    declare module "contract.h" {
      export function known(): _ {
        thread { transfer; deinit; }
      }
    }
  `;
  const ownerDiagnostic = diagnostics(threadWithoutOwner, "/tmp/contract.h.zd")[0];
  assert.equal(ownerDiagnostic.code, "Z0801");
  assert.match(ownerDiagnostic.message, /requires an owned return with deinit/);

  const conflictingThreadContract = `
    declare module "contract.hpp" {
      export type Value {
        move;
        deinit;
        thread { transfer; share; deinit; }
      }
    }
  `;
  const conflictingDiagnostic = diagnostics(conflictingThreadContract, "/tmp/contract.hpp.zd")[0];
  assert.equal(conflictingDiagnostic.code, "Z0801");
  assert.match(conflictingDiagnostic.message, /cannot declare both transfer and share/);

  const mismatchDirectory = mkdtempSync("/tmp/z-zd-module-");
  const mismatchHeader = resolve(mismatchDirectory, "contract.h");
  const mismatchSource = resolve(mismatchDirectory, "main.zs");
  writeFileSync(mismatchHeader, "int known(void);\n");
  writeFileSync(`${mismatchHeader}.zd`, `
    declare module "other.h" {
      export function known(): _;
    }
  `);
  const imported = `import contract from "contract.h"; function main(): i32 { return contract.known(); }`;
  const mismatch = diagnostics(imported, mismatchSource)[0];
  assert.equal(mismatch.code, "Z0801");
  assert.match(mismatch.message, /does not match imported header "contract\.h"/);

  const parameterDirectory = mkdtempSync("/tmp/z-zd-parameter-");
  const parameterHeader = resolve(parameterDirectory, "contract.h");
  const parameterSource = resolve(parameterDirectory, "main.zs");
  writeFileSync(parameterHeader, "int use(void *handle);\n");
  writeFileSync(`${parameterHeader}.zd`, `
    declare module "contract.h" {
      export function use(in missing: _): _;
    }
  `);
  const missingParameter = diagnostics(imported.replace("known", "use"), parameterSource)[0];
  assert.equal(missingParameter.code, "Z0801");
  assert.match(missingParameter.message, /does not match native parameter "handle"/);

  const callbackDirectory = mkdtempSync("/tmp/z-zd-callback-");
  const callbackHeader = resolve(callbackDirectory, "contract.h");
  const callbackSource = resolve(callbackDirectory, "main.zs");
  writeFileSync(callbackHeader, `
    typedef int (*Operation)(int value, void *context);
    static inline int apply(int value, void *context, Operation operation) {
      return operation(value, context);
    }
  `);
  writeFileSync(`${callbackHeader}.zd`, `
    declare module "contract.h" {
      export function apply(value: _, context: _, in operation: _): _ {
        callback operation {
          context missing;
          invoked once;
        }
      }
    }
  `);
  const callbackImport = `import contract from "contract.h"; function identity(value: i32): i32 { return value; } function main(): i32 { return contract.apply(42, identity); }`;
  const missingContext = diagnostics(callbackImport, callbackSource)[0];
  assert.equal(missingContext.code, "Z0801");
  assert.match(missingContext.message, /unknown context parameter "missing"/);

  writeFileSync(`${callbackHeader}.zd`, `
    declare module "contract.h" {
      export function apply(value: _, context: _, move operation: _): _ {
        callback operation {
          context context;
          invoked repeatedly;
        }
      }
    }
  `);
  const incompleteEscape = diagnostics(callbackImport, callbackSource)[0];
  assert.equal(incompleteEscape.code, "Z0214");
  assert.match(incompleteEscape.message, /requires deinit and thread contracts/);
});

test("checks discriminated native union declarations against the imported ABI", () => {
  const declarationFile = resolve(projectRoot, "tests/fixtures/native-union.h.zd");
  const source = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(source, declarationFile), []);

  const lifetimeOffset = source.indexOf("eventMemory") + 2;
  assert.match(
    hover(source, declarationFile, lifetimeOffset)?.contents.value ?? "",
    /compile-time identity for native-managed borrowed storage/,
  );
  const projectionOffset = source.indexOf("project text") + "project ".length + 1;
  assert.match(
    hover(source, declarationFile, projectionOffset)?.contents.value ?? "",
    /project text: view cstring \| null.*const char \*/s,
  );
  const projectionLifetimeOffset = source.indexOf("eventMemory", source.indexOf("borrowed from")) + 2;
  assert.match(
    hover(source, declarationFile, projectionLifetimeOffset)?.contents.value ?? "",
    /view ends before any call that invalidates this native lifetime/,
  );

  const discriminantOffset = source.indexOf("discriminant") + 2;
  assert.match(
    hover(source, declarationFile, discriminantOffset)?.contents.value ?? "",
    /checked borrowed matching for native union ZNativeEvent/,
  );
  const variantOffset = source.indexOf("value {", source.indexOf("variant")) + 2;
  assert.match(
    hover(source, declarationFile, variantOffset)?.contents.value ?? "",
    /value\(value\).*Z_NATIVE_EVENT_VALUE.*Z_NATIVE_EVENT_RESET/s,
  );
  const tagOffset = source.indexOf("Z_NATIVE_EVENT_VALUE") + 2;
  assert.match(
    hover(source, declarationFile, tagOffset)?.contents.value ?? "",
    /selects value/,
  );
  const discriminantCompletionSource = source.replace("discriminant type", "discriminant ty");
  const discriminantCompletionOffset = discriminantCompletionSource.indexOf("discriminant ty") + "discriminant ty".length;
  assert.equal(
    completions(discriminantCompletionSource, declarationFile, discriminantCompletionOffset)
      .find((item) => item.label === "type")?.detail,
    "type: i32; native union member",
  );
  const tagCompletionSource = source.replace("when Z_NATIVE_EVENT_VALUE", "when Z_NATIVE_EVENT_V");
  const tagCompletionOffset = tagCompletionSource.indexOf("when Z_NATIVE_EVENT_V") + "when Z_NATIVE_EVENT_V".length;
  assert.ok(
    completions(tagCompletionSource, declarationFile, tagCompletionOffset)
      .some((item) => item.label === "Z_NATIVE_EVENT_VALUE"),
  );
  const lifetimeCompletionSource = source.replace("borrowed from eventMemory", "borrowed from eventM");
  const lifetimeCompletionOffset = lifetimeCompletionSource.indexOf("borrowed from eventM") + "borrowed from eventM".length;
  assert.ok(
    completions(lifetimeCompletionSource, declarationFile, lifetimeCompletionOffset)
      .some((item) => item.label === "eventMemory"),
  );
  const invalidationCompletionSource = source.replace("invalidates eventMemory", "invalidates eventM");
  const invalidationCompletionOffset = invalidationCompletionSource.indexOf("invalidates eventM") + "invalidates eventM".length;
  assert.ok(
    completions(invalidationCompletionSource, declarationFile, invalidationCompletionOffset)
      .some((item) => item.label === "eventMemory"),
  );

  assert.match(
    diagnostics(source.replace("discriminant type", "discriminant missing"), declarationFile)[0]?.message ?? "",
    /has no supported discriminator member "missing"/,
  );
  assert.match(
    diagnostics(source.replace("member value", "member missing"), declarationFile)[0]?.message ?? "",
    /has no safely representable member "missing"/,
  );
  assert.match(
    diagnostics(source.replace("member value", "member opaque"), declarationFile)[0]?.message ?? "",
    /has no safely representable member "opaque"/,
  );
  assert.match(
    diagnostics(source.replace("Z_NATIVE_EVENT_VALUE", "Z_NATIVE_EVENT_UNKNOWN"), declarationFile)[0]?.message ?? "",
    /names unknown header constant "Z_NATIVE_EVENT_UNKNOWN"/,
  );
  assert.match(
    diagnostics(source.replace("      fallback other;\n", ""), declarationFile)[0]?.message ?? "",
    /requires `fallback <name>;`/,
  );
  assert.match(
    diagnostics(source.replace("    discriminant type {", "    move;\n    discriminant type {"), declarationFile)[0]?.message ?? "",
    /cannot also declare value lifecycle facts/,
  );
});

test("merges API-note sources without allowing safety contracts to conflict", () => {
  const merged = mergeApiNotes([
    {
      name: "base",
      notes: { functions: { open: { return: { ownership: "owned", release: "close" } } } },
    },
    {
      name: "overlay",
      notes: { functions: { open: { return: { nullable: false }, invalidates: [0] } } },
    },
  ]);
  assert.deepEqual(merged.functions?.open.return, {
    ownership: "owned",
    release: "close",
    nullable: false,
  });
  assert.deepEqual(merged.functions?.open.invalidates, [0]);
  assert.throws(
    () => mergeApiNotes([
      { name: "base", notes: { functions: { use: { parameters: { "0": { ownership: "borrowed" } } } } } },
      { name: "overlay", notes: { functions: { use: { parameters: { "0": { ownership: "consuming" } } } } } },
    ]),
    (error) => error instanceof ApiNoteConflictError
      && error.path === "functions.use.parameters.0.ownership"
      && error.firstSource === "base"
      && error.secondSource === "overlay",
  );
  assert.throws(
    () => mergeApiNotes([
      { name: "base", notes: { functions: { use: { invalidates: [0] } } } },
      { name: "overlay", notes: { functions: { use: { invalidates: [1] } } } },
    ]),
    (error) => error instanceof ApiNoteConflictError
      && error.path === "functions.use.invalidates"
      && error.firstSource === "base"
      && error.secondSource === "overlay",
  );
});

test("normalizes producer declarations without exposing Clang nodes to FIIR consumers", () => {
  const declaration: ForeignFunctionDeclaration = {
    name: "answer",
    namespacePath: [],
    qualifiedName: "answer",
    overloads: [{
      name: "answer",
      nativeName: "answer",
      returnType: { nativeName: "int" },
      parameters: [],
      variadic: false,
      nativeSignature: "int (void)",
      metadata: { source: null, availability: [], executorAffinity: null },
    }],
  };
  const normalized = normalizeForeignContracts(
    new Map([[declaration.name, declaration]]),
    new Map(),
    {},
    {
      mapType: (spelling) => ({
        kind: "z",
        name: spelling.nativeName === "void" ? "void" : "i32",
        cName: spelling.nativeName,
      }),
      mapCallbackContext: (cName) => ({ kind: "unsupported", cName }),
      mapCallbackRelease: (cName) => ({ kind: "unsupported", cName }),
      mapVariadicType: (type) => ({
        kind: "z",
        name: type === "cstring" ? "cstring" : "i64",
        cName: type === "cstring" ? "const char *" : "long",
      }),
    },
    "cached-producer.fiir",
    { offset: 0, line: 1, column: 1 },
  );
  assert.equal(normalized.functions.get("answer")?.overloads[0].returnType.kind, "z");
  assert.equal(normalized.functions.get("answer")?.overloads[0].cSignature, "int (void)");
});

test("preserves native declaration locations for FIIR and editor definitions", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-types.zs");
  const source = readFileSync(example, "utf8");
  const context = analyzeSource(source, example);
  const geometry = context.foreignModules.get("geometry")!;
  const translated = geometry.functions.get("z_translate")!;
  assert.match(translated.overloads[0].metadata.source?.fileName ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(translated.overloads[0].metadata.source?.line, 33);

  const functionUse = source.indexOf("z_translate") + 2;
  const functionDefinition = definition(source, `file://${example}`, functionUse);
  assert.match(functionDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
  assert.equal(functionDefinition?.range.start.line, 32);

  const typeUse = source.indexOf("geometry.ZPoint") + "geometry.".length + 2;
  const typeDefinition = definition(source, `file://${example}`, typeUse);
  assert.match(typeDefinition?.uri ?? "", /tests\/fixtures\/geometry\.h$/);
});

test("surfaces native availability in hover and rejects universally unavailable APIs", () => {
  const fileName = resolve(projectRoot, "examples/interop/c/availability-metadata-test.zs");
  const source = `
    import native from "../../../tests/fixtures/z-availability.h";
    function main(): i32 { return native.z_legacy(1); }
  `;
  const context = analyzeSource(source, fileName);
  const legacy = context.foreignModules.get("native")!.functions.get("z_legacy")!;
  assert.deepEqual(legacy.overloads[0].metadata.availability, [{
    platform: "macos",
    introduced: "10.12",
    deprecated: true,
    deprecatedVersion: "13.0",
    obsoleted: null,
    unavailable: false,
    message: "use z_current",
  }]);
  const legacyUse = source.indexOf("z_legacy") + 2;
  assert.match(
    hover(source, fileName, legacyUse)?.contents.value ?? "",
    /\*\*Availability\*\*[\s\S]*macOS: 10\.12\+; deprecated 13\.0/,
  );
  const legacyDefinition = definition(source, `file://${fileName}`, legacyUse);
  assert.match(legacyDefinition?.uri ?? "", /tests\/fixtures\/z-availability\.h$/);
  assert.equal(legacyDefinition?.range.start.line, 5);

  const unavailable = source.replace("z_legacy", "z_never");
  const diagnostic = diagnostics(unavailable, fileName)[0];
  assert.equal(diagnostic.code, "Z0802");
  assert.match(diagnostic.message, /foreign declaration "z_never" is unavailable/);
  assert.match(diagnostic.message, /not supported anywhere/);
  assert.match(diagnostic.relatedInformation?.[0]?.location.uri ?? "", /tests\/fixtures\/z-availability\.h$/);
});

test("checks native availability against an explicit deployment target", () => {
  if (process.platform !== "darwin") return;
  const directory = mkdtempSync("/tmp/z-deployment-target-");
  const header = resolve(directory, "z-availability.h");
  const sourceFile = resolve(directory, "main.zs");
  const manifest = resolve(directory, "z.json");
  writeFileSync(header, readFileSync(resolve(projectRoot, "tests/fixtures/z-availability.h"), "utf8"));
  const sourceFor = (name: string) => `
    import native from "z-availability.h";
    function main(): i32 { return native.${name}(1); }
  `;
  const configure = (minimumVersion: string) => writeFileSync(manifest, JSON.stringify({
    target: {
      name: "deployment-target",
      entry: "main.zs",
      platform: "macos",
      minimumVersion,
    },
  }));

  configure("12.0");
  writeFileSync(sourceFile, sourceFor("z_future"));
  const introduced = diagnostics(readFileSync(sourceFile, "utf8"), sourceFile)[0];
  assert.equal(introduced.code, "Z0802");
  assert.equal(introduced.severity, 1);
  assert.match(introduced.message, /requires macOS 15\.0, but the deployment target is macOS 12\.0/);
  assert.match(introduced.message, /raise target\.minimumVersion to "15\.0"/);
  assert.match(introduced.relatedInformation?.[0]?.location.uri ?? "", /z-availability\.h$/);

  configure("13.0");
  const deprecatedSource = sourceFor("z_legacy");
  writeFileSync(sourceFile, deprecatedSource);
  const deprecation = diagnostics(deprecatedSource, sourceFile)[0];
  assert.equal(deprecation.code, "Z0804");
  assert.equal(deprecation.severity, 2);
  assert.match(deprecation.message, /deprecated in macOS 13\.0/);
  assert.match(deprecation.message, /use z_current/);
  const artifact = compileToNative(deprecatedSource, sourceFile);
  assert.deepEqual(artifact.deploymentTarget, { platform: "macos", minimumVersion: "13.0" });
  assert.equal(artifact.warnings[0]?.code, "Z0804");

  const obsoleteSource = sourceFor("z_obsolete");
  writeFileSync(sourceFile, obsoleteSource);
  const obsolete = diagnostics(obsoleteSource, sourceFile)[0];
  assert.equal(obsolete.code, "Z0802");
  assert.match(obsolete.message, /was obsoleted in macOS 13\.0; the deployment target is 13\.0/);

  configure("15.0");
  const currentSource = sourceFor("z_current");
  writeFileSync(sourceFile, currentSource);
  assert.deepEqual(diagnostics(currentSource, sourceFile), []);

  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "deployment-target",
      entry: "main.zs",
      minimumVersion: "13.0",
    },
  }));
  assert.match(diagnostics(currentSource, sourceFile)[0]?.message ?? "", /target\.platform must be a platform name/);
  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "deployment-target",
      entry: "main.zs",
      platform: "macos",
      minimumVersion: "latest",
    },
  }));
  assert.match(diagnostics(currentSource, sourceFile)[0]?.message ?? "", /target\.minimumVersion must be a numeric version/);
});

test("threads deployment targets and warnings through CLI native execution", () => {
  if (process.platform !== "darwin") return;
  const example = resolve(projectRoot, "examples/interop/c/deployment-target/main.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning\[Z0804\]: foreign declaration "z_legacy" is deprecated in macOS 13\.0/);
  assert.match(result.stderr, /native-api\.h:8:19/);
});

test("adds explicit target native libraries without exposing raw linker flags", () => {
  const directory = mkdtempSync("/tmp/z-native-link-");
  const sourceFile = resolve(directory, "main.zs");
  const manifest = resolve(directory, "z.json");
  const source = "function main(): i32 { return 0; }";
  writeFileSync(sourceFile, source);
  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-link",
      entry: "main.zs",
      link: {
        libraries: ["sqlite3", "sqlite3"],
        frameworks: ["AppKit", "AppKit"],
      },
    },
  }));

  const artifact = compileToNative(source, sourceFile);
  assert.deepEqual(artifact.nativeLinkerArguments, ["-lsqlite3"]);
  assert.deepEqual(artifact.frameworks, ["AppKit"]);

  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-link",
      entry: "main.zs",
      link: { libraries: ["-Wl,unsafe"] },
    },
  }));
  assert.match(
    diagnostics(source, sourceFile)[0]?.message ?? "",
    /target\.link\.libraries must contain native library names/,
  );

  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-link",
      entry: "main.zs",
      link: { frameworks: ["-framework AppKit"] },
    },
  }));
  assert.match(
    diagnostics(source, sourceFile)[0]?.message ?? "",
    /target\.link\.frameworks must contain Apple framework names/,
  );
});

test("uses project header and library search directories across analysis and native builds", () => {
  const directory = mkdtempSync("/tmp/z-native-search-paths-");
  const includeDirectory = resolve(directory, "include");
  const libraryDirectory = resolve(directory, "lib");
  const sourceFile = resolve(directory, "main.zs");
  const manifest = resolve(directory, "z.json");
  mkdirSync(includeDirectory);
  mkdirSync(libraryDirectory);
  writeFileSync(resolve(includeDirectory, "vendor.h"), "static inline int z_project_answer(void) { return 42; }\n");
  const source = `
    import vendor from "vendor.h";
    function main(): i32 { return vendor.z_project_answer(); }
  `;
  writeFileSync(sourceFile, source);
  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-search-paths",
      entry: "main.zs",
      includeDirectories: ["include", "include"],
      link: {
        directories: ["lib", "lib"],
        libraries: [],
      },
    },
  }));

  assert.deepEqual(diagnostics(source, sourceFile), []);
  const functionOffset = source.indexOf("z_project_answer") + 1;
  assert.match(hover(source, sourceFile, functionOffset)?.contents.value ?? "", /z_project_answer\(\): i32/);
  const artifact = compileToNative(source, sourceFile);
  assert.deepEqual(artifact.includeDirectories, [realpathSync(includeDirectory)]);
  assert.deepEqual(artifact.nativeLinkerArguments, [`-L${realpathSync(libraryDirectory)}`]);
  assert.match(artifact.source, /z_project_answer\(\)/);

  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-search-paths",
      entry: "main.zs",
      includeDirectories: ["missing"],
    },
  }));
  assert.match(
    diagnostics(source, sourceFile)[0]?.message ?? "",
    /target\.includeDirectories directory .*missing.* does not exist/,
  );

  writeFileSync(manifest, JSON.stringify({
    target: {
      name: "native-search-paths",
      entry: "main.zs",
      link: { directories: "lib" },
    },
  }));
  assert.match(
    diagnostics(source, sourceFile)[0]?.message ?? "",
    /target\.link\.directories must contain directory paths/,
  );
});

test("rejects malformed or unmatched Z declarations before FIIR reaches sema", () => {
  const directory = mkdtempSync("/tmp/z-fiir-notes-");
  const header = resolve(directory, "contract.h");
  const sourceFile = resolve(directory, "main.zs");
  const source = `
    import contract from "contract.h";
    function main(): i32 { return contract.known(); }
  `;
  writeFileSync(header, "int known(void);\n");
  writeFileSync(sourceFile, source);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function known(): _;
    }
  `);
  assert.match(compileToC(source, sourceFile), /return known\(\);/);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function missing(): _;
    }
  `);
  const missing = diagnostics(source, sourceFile)[0];
  assert.equal(missing.code, "Z0801");
  assert.match(missing.message, /declaration names unknown foreign function "missing"/);
  const directMissing = spawnSync(process.execPath, [cli, "check", `${header}.zd`], { encoding: "utf8" });
  assert.equal(directMissing.status, 1);
  assert.match(directMissing.stderr, /declaration names unknown foreign function "missing"/);

  writeFileSync(`${header}.zd`, `
    declare module "contract.h" {
      export function known(): _ nullible;
    }
  `);
  const malformed = diagnostics(source, sourceFile)[0];
  assert.equal(malformed.code, "Z0801");
  assert.match(malformed.message, /expected ";" in Z declaration file, found "nullible"/);
});

test("imports C typedefs, records, enums, constants, and qualified signatures", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-types.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "point=13,20 width=640 flags=7 id=42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /static ZPoint move\(ZPoint point, ZCount amount\)/);
  assert.match(generated, /\(ZPoint\)\{ \.x = 10, \.y = 20 \}/);
  assert.match(generated, /z_translate\(point, ZForward, amount\)/);
});

test("checks contextual literals and preserves exact integer expression types", () => {
  const source = `
    function plus(value: u16): u16 {
      const result = value + 3;
      return result;
    }
    function maxWord(): u32 {
      return 4294967295;
    }
    function maxWide(): u64 {
      return 18446744073709551615;
    }
    function main(): i32 {
      plus(65535);
      return 0;
    }
  `;
  const generated = compileToC(source, "integer-widths.zs");
  assert.match(generated, /static uint16_t plus\(uint16_t value\)/);
  assert.match(generated, /const uint16_t result = z_checked_add_u16\(value, 3\);/);
  assert.match(generated, /return 4294967295U;/);
  assert.match(generated, /return 18446744073709551615ULL;/);

  assert.throws(
    () => compileToC(source.replace("65535", "65536"), "integer-overflow.zs"),
    /integer literal 65536 does not fit u16/,
  );

  const inferredWide = `
    function main(): i32 {
      const value = 4294967295;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(inferredWide, "integer-default.zs"),
    /does not fit default i32; add an explicit integer type/,
  );
});

test("contextually types signed literals at their destination width", () => {
  const source = `
    struct Tiny { value: i8; }

    function echo(value: i8): i8 { return value; }
    function minimum(): i16 { return -32768; }

    function main(): i32 {
      const narrow: i8 = -128;
      const positive: i16 = +32767;
      const fraction: f32 = -1.5;
      let assigned: i16 = 0;
      assigned = -32768;
      const called = echo(-128);
      const tiny = Tiny({ value: -128 });
      if (narrow == called && tiny.value == narrow && assigned == minimum() && positive > 0 && fraction < 0.0) {
        return 0;
      }
      return 1;
    }
  `;
  const generated = compileToC(source, "signed-context.zs");
  assert.match(generated, /const int8_t narrow = INT8_MIN;/);
  assert.match(generated, /const int16_t positive = 32767;/);
  assert.match(generated, /const float fraction = \(-1\.5F\);/);
  assert.match(generated, /assigned = INT16_MIN;/);
  assert.match(generated, /echo\(INT8_MIN\)/);
  assert.match(generated, /\.value = INT8_MIN/);

  const narrowLiteral = source.indexOf("128", source.indexOf("narrow:")) + 1;
  assert.match(hover(source, "signed-context.zs", narrowLiteral)?.contents.value ?? "", /128: i8/);

  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: i8 = -129"), "signed-too-small.zs"),
    /integer literal -129 does not fit i8/,
  );
  assert.throws(
    () => compileToC(source.replace("const narrow: i8 = -128", "const narrow: u8 = -1"), "unsigned-negative.zs"),
    /integer literal -1 does not fit u8/,
  );

  const directory = mkdtempSync("/tmp/z-signed-context-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("checks integer arithmetic and provides explicit wrapping and saturation", () => {
  const example = resolve(projectRoot, "examples/language/basics/integer-safety.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "wrapped=0,255,254, saturated=255,-128,255, division=3,2, negated=-3, shifts=12,6\n");

  const generated = compileToC(source, example);
  assert.match(generated, /z_wrapping_add_u8\(maximum, 1\)/);
  assert.match(generated, /z_wrapping_subtract_u8\(unsignedZero, 1\)/);
  assert.match(generated, /z_wrapping_multiply_u8\(maximum, 2\)/);
  assert.match(generated, /z_saturating_add_u8\(maximum, 1\)/);
  assert.match(generated, /z_saturating_subtract_i8\(minimum, 2\)/);
  assert.match(generated, /z_saturating_multiply_u8\(maximum, 2\)/);
  assert.match(generated, /z_checked_divide_i32\(17, 5\)/);
  assert.match(generated, /z_checked_remainder_i32\(17, 5\)/);
  assert.match(generated, /z_checked_negate_i32\(quotient\)/);
  assert.match(generated, /z_checked_shift_left_i32\(quotient, 2\)/);
  assert.match(generated, /z_checked_shift_right_i32\(shifted, 1\)/);

  const wrappingOffset = source.indexOf("wrappingAdd") + 1;
  assert.match(hover(source, example, wrappingOffset)?.contents.value ?? "", /wrappingAdd\(other: u8\): u8/);
  const completionSource = source.replace("maximum.wrappingAdd(1)", "maximum.wrap");
  const completionOffset = completionSource.indexOf("maximum.wrap") + "maximum.wrap".length;
  const wrappingCompletion = completions(completionSource, example, completionOffset)
    .find((item) => item.label === "wrappingAdd");
  assert.equal(wrappingCompletion?.kind, 2);
  assert.match(wrappingCompletion?.detail ?? "", /wraps modulo the integer width/);

  const constantCases = [
    ["function main(): i32 { return 2147483647 + 1; }", "constant-add-overflow.zs", "Z0101", /overflows i32/],
    ["function main(): i32 { return 10 / 0; }", "constant-divide-zero.zs", "Z0102", /division by zero/],
    ["function main(): i32 { return 1 << 32; }", "constant-shift-range.zs", "Z0103", /outside the range for i32/],
  ] as const;
  for (const [invalidSource, fileName, code, summary] of constantCases) {
    let caught: unknown;
    try {
      compileToC(invalidSource, fileName);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DiagnosticError);
    assert.equal(caught.code, code);
    assert.match(caught.summary, summary);
    assert.equal(diagnostics(invalidSource, fileName)[0].code, code);
  }

  const directory = mkdtempSync("/tmp/z-integer-trap-");
  const trapSource = resolve(directory, "main.zs");
  writeFileSync(trapSource, `
    function overflow(value: i32): i32 { return value + 1; }
    function main(): i32 { return overflow(2147483647); }
  `);
  const trapped = spawnSync(process.execPath, [cli, "run", trapSource], { encoding: "utf8" });
  assert.notEqual(trapped.status, 0);
});

test("constructs numeric values with explicit value-preserving conversions", () => {
  const source = `
    import math from "std/math";

    function widen(value: u8): i32 {
      return i32(value);
    }

    function narrow(value: i32): u8 {
      return u8(value);
    }

    function nativeCount(value: usize): isize {
      return isize(value);
    }

    function contentSize(value: f64): u32 {
      return u32(math.trunc(value));
    }

    function compactSize(value: f32): u32 {
      return u32(math.trunc(value));
    }

    function main(): i32 {
      const small: u8 = 42;
      const count: usize = 44;
      if (widen(small) != 42) return 1;
      if (narrow(43) != 43) return 2;
      if (nativeCount(count) != 44) return 3;
      const nativeWidth = f64(count);
      if (contentSize(nativeWidth + 0.75) != 44) return 4;
      if (compactSize(3.75) != 3) return 5;
      if (u32(42.0) != 42) return 6;
      return 0;
    }
  `;
  const generated = compileToC(source, "integer-conversions.zs");
  assert.match(generated, /return \(\(int32_t\)\(value\)\);/);
  assert.match(generated, /z_checked_convert_i32_to_u8/);
  assert.match(generated, /z_checked_convert_usize_to_isize/);
  assert.match(generated, /__builtin_trunc/);
  assert.match(generated, /__builtin_truncf/);
  assert.match(generated, /z_checked_convert_f64_to_u32/);

  const conversionOffset = source.indexOf("isize(value)") + 1;
  const conversionHover = hover(source, "integer-conversions.zs", conversionOffset)?.contents.value ?? "";
  assert.match(conversionHover, /isize\(value: usize\): isize/);
  assert.match(conversionHover, /runtime representability check/);
  const truncOffset = source.indexOf("math.trunc") + "math.".length + 1;
  assert.match(hover(source, "integer-conversions.zs", truncOffset)?.contents.value ?? "", /rounds toward zero/);
  const incompleteMath = source.replace("math.trunc", "math.tr");
  const completionOffset = incompleteMath.indexOf("math.tr") + "math.tr".length;
  assert.equal(completions(incompleteMath, "integer-conversions.zs", completionOffset).some((item) => item.label === "trunc"), true);

  assert.throws(
    () => compileToC("function main(): i32 { const value = u8(256); return i32(value); }", "constant-conversion.zs"),
    /integer literal 256 does not fit u8/,
  );
  assert.throws(
    () => compileToC("function main(): i32 { const value: usize = 1; const native: isize = value; return 0; }", "implicit-conversion.zs"),
    /expected isize, found usize/,
  );
  const floating = compileToC("function main(): i32 { const value = f64(1); return i32(value); }", "float-conversion.zs");
  assert.match(floating, /const double value = \(\(double\)\(1\.0\)\)/);
  assert.throws(
    () => compileToC("function main(): i32 { const value = u32(42.5); return i32(value); }", "fractional-conversion.zs"),
    /floating-point value 42\.5 cannot convert exactly to u32/,
  );

  const directory = mkdtempSync("/tmp/z-integer-conversion-");
  const successFile = resolve(directory, "success.zs");
  writeFileSync(successFile, source);
  const success = spawnSync(process.execPath, [cli, "run", successFile], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);

  const trapFile = resolve(directory, "trap.zs");
  writeFileSync(trapFile, `
    function narrow(value: i32): u8 { return u8(value); }
    function main(): i32 {
      const value = narrow(-1);
      return i32(value);
    }
  `);
  const trapped = spawnSync(process.execPath, [cli, "run", trapFile], { encoding: "utf8" });
  assert.notEqual(trapped.status, 0);

  const lossyFloatFile = resolve(directory, "lossy-float.zs");
  writeFileSync(lossyFloatFile, `
    function main(): i32 {
      const value: u64 = 9007199254740993;
      const converted = f64(value);
      return converted == 0.0 ? 1 : 0;
    }
  `);
  const lossyFloat = spawnSync(process.execPath, [cli, "run", lossyFloatFile], { encoding: "utf8" });
  assert.notEqual(lossyFloat.status, 0);

  const asyncFile = resolve(directory, "async.zs");
  writeFileSync(asyncFile, `
    async function convert(value: usize): isize {
      return isize(value);
    }
    async function main(): i32 {
      const converted = await convert(42);
      return i32(converted) - 42;
    }
  `);
  const asyncResult = spawnSync(process.execPath, [cli, "run", asyncFile], { encoding: "utf8" });
  assert.equal(asyncResult.status, 0, asyncResult.stderr);
});

test("converts nominal imported enums through explicit integer construction", () => {
  const example = resolve(projectRoot, "examples/interop/c/foreign-enum-conversion.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToC(source, example);
  assert.match(generated, /const int32_t direction = \(\(int32_t\)\(\(\(int32_t\)\(ZForward\)\)\)\);/);

  const conversionOffset = source.indexOf("i32(geometry") + 1;
  const conversionHover = hover(source, example, conversionOffset)?.contents.value ?? "";
  assert.match(conversionHover, /i32\(value: geometry\.ZDirection\): i32/);
  assert.match(conversionHover, /native enum representation: i32/);
  assert.match(conversionHover, /direct value-preserving cast/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("runs floating-point values and typed bitwise option masks", () => {
  const example = resolve(projectRoot, "examples/interop/c/apple-groundwork.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");

  const artifact = compileToNative(readFileSync(example, "utf8"), example);
  assert.equal(artifact.language, "c");
  assert.deepEqual(artifact.frameworks, []);
  assert.match(artifact.source, /static float twice\(float value\)/);
  assert.match(artifact.source, /static double negate\(double value\)/);
  assert.match(artifact.source, /const float width = 800\.0F;/);
  assert.match(artifact.source, /const ZCoordinate windowArea = z_area\(800\.0, 600\.0\);/);
  assert.match(artifact.source, /const uintptr_t styleMask = \(\(titled \| 2ULL\) \| 8ULL\);/);
  assert.match(artifact.source, /const uint32_t shifted = z_checked_shift_left_u32\(one, 3U\);/);
  assert.match(artifact.source, /const uint32_t inverted = \(~one\);/);
  assert.match(artifact.source, /const uintptr_t toggled = \(filtered \^ 1ULL\);/);
  assert.match(artifact.source, /const float scientific = 1\.5e2F;/);
});

test("preserves C++ namespaces and resolves overload sets", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-interop.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.deepEqual(artifact.frameworks, []);
  assert.match(artifact.source, /#include <cpp_math\.hpp>/);
  assert.match(artifact.source, /const zcpp::Point origin/);
  assert.match(artifact.source, /const alpha::Point alphaPoint/);
  assert.match(artifact.source, /const beta::Point betaPoint/);
  assert.match(artifact.source, /zcpp::translate\(origin, 1, \(-1\)\)/);
  assert.match(artifact.source, /zcpp::sum\(moved\)/);
  assert.match(artifact.source, /zcpp::scale\(6, 7\)/);
  assert.match(artifact.source, /zcpp::scale\(2\.5, 2\.0\)/);
  assert.match(artifact.source, /alpha::adjust\(\(alphaPoint\)\.value\)/);
  assert.match(artifact.source, /beta::adjust\(\(betaPoint\)\.value\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "cpp=42, integer=42, floating=5, adjusted=40, point=Point { x: 21, y: 21 }\n");

  const translateOffset = source.indexOf("translate") + 1;
  assert.match(hover(source, example, translateOffset)?.contents.value ?? "", /Point \(Point, int, int\)/);
  const completionSource = source.replace("cpp.zcpp.translate", "cpp.zcpp.tr");
  const completionOffset = completionSource.indexOf("cpp.zcpp.tr") + "cpp.zcpp.tr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "translate")?.kind, 3);
  const rootCompletionSource = source.replace("cpp.zcpp.translate", "cpp.z");
  const rootCompletionOffset = rootCompletionSource.indexOf("cpp.z") + "cpp.z".length;
  assert.equal(completions(rootCompletionSource, example, rootCompletionOffset).find((item) => item.label === "zcpp")?.kind, 9);
  const typeCompletionSource = source.replace("cpp.zcpp.Point", "cpp.zcpp.Po");
  const typeCompletionOffset = typeCompletionSource.indexOf("cpp.zcpp.Po") + "cpp.zcpp.Po".length;
  assert.equal(completions(typeCompletionSource, example, typeCompletionOffset).find((item) => item.label === "Point")?.kind, 22);
  const ambiguousTypeCompletionSource = source.replace("cpp.zcpp.Point", "cpp.Po");
  const ambiguousTypeCompletionOffset = ambiguousTypeCompletionSource.indexOf("cpp.Po") + "cpp.Po".length;
  assert.equal(completions(ambiguousTypeCompletionSource, example, ambiguousTypeCompletionOffset).find((item) => item.label === "Point"), undefined);
  const fieldOffset = source.indexOf("x: 20") + 1;
  assert.match(hover(source, example, fieldOffset)?.contents.value ?? "", /x: i32/);
  const pointOffset = source.indexOf("cpp.zcpp.Point") + "cpp.zcpp.".length + 1;
  assert.match(hover(source, example, pointOffset)?.contents.value ?? "", /Point: zcpp::Point/);
  const pointDefinition = definition(source, `file://${example}`, pointOffset);
  assert.match(pointDefinition?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);
  assert.equal(pointDefinition?.range.start.line, 4);
  const semantic = decodeSemanticTokens(semanticTokens(source, example).data);
  const pointPosition = positionForOffset(source, source.indexOf("cpp.zcpp.Point") + "cpp.zcpp.".length);
  assert.ok(semantic.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));

  const overloadHoverOffset = source.indexOf("cpp.zcpp.scale") + "cpp.zcpp.".length + 1;
  const overloadHover = hover(source, example, overloadHoverOffset)?.contents.value ?? "";
  assert.match(overloadHover, /scale\(value: i32, factor: i32\): i32/);
  assert.match(overloadHover, /scale\(value: f64, factor: f64\): f64/);
  const floatingScaleOffset = source.indexOf("cpp.zcpp.scale(2.5") + "cpp.zcpp.".length + 1;
  const floatingScaleDefinition = definition(source, `file://${example}`, floatingScaleOffset);
  assert.match(floatingScaleDefinition?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);
  assert.equal(floatingScaleDefinition?.range.start.line, 21);
  const genericOverload = source
    .replace("function main(): i32 {", "function identity<T>(value: T): T { return value; }\n\nfunction main(): i32 {")
    .replace("cpp.zcpp.scale(2.5, 2.0)", "identity(cpp.zcpp.scale(2.5, 2.0))");
  assert.match(compileToNative(genericOverload, example).source, /__z_mono_identity_f64\(zcpp::scale\(2\.5, 2\.0\)\)/);
  assert.throws(() => compileToNative(source.replace("cpp.sum(moved)", "cpp.choose(1)"), example), /call to foreign function "zcpp\.choose" is ambiguous/);
  assert.throws(() => compileToNative(source.replace("cpp.sum(moved)", "cpp.adjust(1)"), example), /has no function "adjust"/);
  assert.throws(() => compileToNative(source.replace("= cpp.zcpp.Point", "= cpp.Point"), example), /native type "Point" is ambiguous across C\+\+ namespaces/);
});

test("selectively imports and aliases C++ namespaces", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-selective-interop.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /const zcpp::Point origin/);
  assert.match(artifact.source, /zcpp::translate\(origin, 1, \(-1\)\)/);
  assert.match(artifact.source, /alpha::adjust\(\(leftPoint\)\.value\)/);
  assert.match(artifact.source, /beta::adjust\(\(rightPoint\)\.value\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "selective cpp=42, adjusted=40\n");

  const namespaceOffset = source.indexOf("math.Point") + 1;
  assert.match(hover(source, example, namespaceOffset)?.contents.value ?? "", /native namespace zcpp imported as math/);
  const pointOffset = source.indexOf("math.Point") + "math.".length + 1;
  assert.match(hover(source, example, pointOffset)?.contents.value ?? "", /Point: zcpp::Point/);
  assert.match(definition(source, `file://${example}`, pointOffset)?.uri ?? "", /examples\/interop\/cpp\/cpp_math\.hpp$/);

  const completionSource = source.replace("math.translate", "math.tr");
  const completionOffset = completionSource.indexOf("math.tr") + "math.tr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "translate")?.kind, 3);
  const symbolSource = source.replace("const origin", "mat;\n  const origin");
  const symbolOffset = symbolSource.indexOf("mat;") + 3;
  assert.equal(completions(symbolSource, example, symbolOffset).find((item) => item.label === "math")?.kind, 9);

  const semantic = decodeSemanticTokens(semanticTokens(source, example).data);
  const namespacePosition = positionForOffset(source, source.indexOf("math.Point"));
  const pointPosition = positionForOffset(source, source.indexOf("math.Point") + "math.".length);
  assert.ok(semantic.some((token) => token.line === namespacePosition.line
    && token.character === namespacePosition.character
    && token.type === semanticTokenTypes.indexOf("namespace")));
  assert.ok(semantic.some((token) => token.line === pointPosition.line
    && token.character === pointPosition.character
    && token.type === semanticTokenTypes.indexOf("type")));

  const annotated = source.replace("const origin =", "const origin: math.Point =");
  assert.match(compileToNative(annotated, example).source, /const zcpp::Point origin/);
});

test("declares, copies, aggregates, and destroys foreign C++ values", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/foreign-values.zs");
  const source = readFileSync(example, "utf8");
  const artifact = compileToNative(source, example);
  assert.equal(artifact.language, "c++");
  assert.match(artifact.source, /struct Z_NativeOwner \{\s*zcpp::ManagedValue value;/);
  assert.match(artifact.source, /const Z_NativeOwner owner = .*\.value = first/);
  assert.match(artifact.source, /Z_NativeOwner copied = owner/);
  assert.match(artifact.source, /\(copied\)\.value\.add\(2\)/);
  assert.match(artifact.source, /\(copied\)\.value\.value\(\)/);

  const context = analyzeSource(source, example);
  const managed = context.foreignModules.get("native")?.namedTypes.get("zcpp.ManagedValue");
  assert.equal(managed?.kind, "value");
  if (managed?.kind === "value") {
    assert.deepEqual(managed.lifecycle, { copy: true, move: false, deinit: true });
  }
  const typeOffset = source.indexOf("ManagedValue") + 2;
  assert.match(hover(source, example, typeOffset)?.contents.value ?? "", /native value: copy, deinit; unavailable: move/);
  const publicFieldOffset = source.indexOf("copied.value") + "copied.".length + 1;
  assert.equal(
    hover(source, example, publicFieldOffset)?.contents.value,
    "```z\nvalue: native.zcpp.ManagedValue\n```",
  );
  const publicFieldCompletionSource = source.replace(
    "  copied.value.add(2);",
    "  copied.;\n  copied.value.add(2);",
  );
  const publicFieldCompletionOffset = publicFieldCompletionSource.indexOf("copied.;") + "copied.".length;
  assert.equal(
    completions(publicFieldCompletionSource, example, publicFieldCompletionOffset).find((item) => item.label === "value")?.detail,
    "native.zcpp.ManagedValue",
  );
  const nativeValue = context.foreignModules.get("native")?.namedTypes.get("zcpp.ManagedValue");
  assert.equal(nativeValue?.kind, "value");
  if (nativeValue?.kind === "value") {
    assert.equal(nativeValue.constructors.length, 1);
    assert.equal(nativeValue.constructors[0]?.parameters[0]?.name, "value");
    assert.equal(nativeValue.staticMethods.find((method) => method.name === "from")?.overloads.length, 1);
    assert.equal(nativeValue.staticMethods.find((method) => method.name === "sum")?.overloads.length, 2);
    assert.equal(nativeValue.methods.find((method) => method.name === "value")?.overloads[0]?.receiverAccess, "in");
    assert.equal(nativeValue.methods.find((method) => method.name === "add")?.overloads[0]?.receiverAccess, "inout");
    assert.equal(nativeValue.methods.find((method) => method.name === "plus")?.overloads.length, 2);
  }
  const methodOffset = source.lastIndexOf("value()") + 1;
  assert.match(hover(source, example, methodOffset)?.contents.value ?? "", /value\(\): i32.*C\+\+ const/);
  const methodCompletionSource = source.replace(
    "  return copied.value.value();",
    "  copied.value.;\n  return copied.value.value();",
  );
  const methodCompletionOffset = methodCompletionSource.indexOf("copied.value.;") + "copied.value.".length;
  const methodItems = completions(methodCompletionSource, example, methodCompletionOffset);
  assert.match(methodItems.find((item) => item.label === "add")?.detail ?? "", /C\+\+ mutable/);
  assert.match(methodItems.find((item) => item.label === "value")?.detail ?? "", /C\+\+ const/);
  assert.match(definition(source, `file://${example}`, methodOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const overloadedMethod = source.replace("copied.value.value()", "copied.value.plus(0)");
  assert.match(compileToNative(overloadedMethod, example).source, /\(copied\)\.value\.plus\(0\)/);
  assert.throws(
    () => compileToNative(source.replace("copied.value.value()", 'copied.value.plus("no")'), example),
    /no overload of native method "zcpp\.ManagedValue\.plus" accepts these arguments/,
  );

  const immutableMutation = source.replace("let copied = owner;", "const copied = owner;");
  assert.throws(
    () => compileToNative(immutableMutation, example),
    /mutable native method "add" requires addressable let storage/,
  );
  const immutableRead = immutableMutation
    .replace("  copied.value.add(2);\n", "")
    .replace("copied.value.value()", "copied.value.plus(2)");
  assert.match(compileToNative(immutableRead, example).source, /\(copied\)\.value\.plus\(2\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer=42, copies=2, drops=3, live=0\n");

  const declarationFile = resolve(projectRoot, "tests/fixtures/foreign-values.hpp.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  assert.deepEqual(diagnostics(declarationSource, declarationFile), []);
  const declaredType = declarationSource.indexOf("ManagedValue") + 2;
  assert.match(
    hover(declarationSource, declarationFile, declaredType)?.contents.value ?? "",
    /type ManagedValue: zcpp::ManagedValue.*native value: copy, deinit; unavailable: move/,
  );
  const copyCapability = declarationSource.indexOf("copy") + 1;
  assert.match(hover(declarationSource, declarationFile, copyCapability)?.contents.value ?? "", /copy: native lifecycle capability/);
  const typeCompletionSource = declarationSource.replace("zcpp.ManagedValue {", "zcpp.Man");
  const typeCompletionOffset = typeCompletionSource.indexOf("zcpp.Man") + "zcpp.Man".length;
  assert.equal(
    completions(typeCompletionSource, declarationFile, typeCompletionOffset)
      .find((item) => item.label === "zcpp.ManagedValue")?.kind,
    22,
  );
  const lifecycleCompletionSource = declarationSource.replace("copy;", "cop");
  const lifecycleCompletionOffset = lifecycleCompletionSource.indexOf("cop") + "cop".length;
  assert.equal(
    completions(lifecycleCompletionSource, declarationFile, lifecycleCompletionOffset)
      .find((item) => item.label === "copy")?.insertText,
    "copy;",
  );

  const invalidDirectory = mkdtempSync("/tmp/z-foreign-value-lifecycle-");
  const invalidHeader = resolve(invalidDirectory, "foreign-values.hpp");
  const invalidSource = resolve(invalidDirectory, "main.zs");
  writeFileSync(invalidHeader, readFileSync(resolve(projectRoot, "tests/fixtures/foreign-values.hpp"), "utf8"));
  writeFileSync(`${invalidHeader}.zd`, `
    declare module "foreign-values.hpp" {
      export type zcpp.ManagedValue {
        move;
        deinit;
      }
    }
  `);
  const invalidProgram = `import native from "foreign-values.hpp"; function main(): i32 { return 0; }`;
  const invalidDiagnostic = diagnostics(invalidProgram, invalidSource)[0];
  assert.equal(invalidDiagnostic.code, "Z0801");
  assert.match(invalidDiagnostic.message, /declares move, but Clang cannot prove that capability/);

  const moveOnlyDirectory = mkdtempSync("/tmp/z-foreign-move-only-");
  const moveOnlyHeader = resolve(moveOnlyDirectory, "move-only.hpp");
  const moveOnlySource = resolve(moveOnlyDirectory, "main.zs");
  writeFileSync(moveOnlyHeader, `
    namespace zcpp {
      class MoveOnly {
      public:
        explicit MoveOnly(int value) : value_(value) {}
        MoveOnly(const MoveOnly &) = delete;
        MoveOnly &operator=(const MoveOnly &) = delete;
        MoveOnly(MoveOnly &&other) : value_(other.value_) { other.value_ = 0; }
        MoveOnly &operator=(MoveOnly &&other) { value_ = other.value_; other.value_ = 0; return *this; }
        ~MoveOnly() {}
      private:
        int value_;
      };
    }
  `);
  writeFileSync(`${moveOnlyHeader}.zd`, `
    declare module "move-only.hpp" {
      export type zcpp.MoveOnly {
        move;
        deinit;
      }
    }
  `);
  const moveOnlyProgram = `import native from "move-only.hpp"; function main(): i32 { return 0; }`;
  assert.deepEqual(diagnostics(moveOnlyProgram, moveOnlySource), []);
  assert.match(compileToNative(moveOnlyProgram, moveOnlySource).source, /#include <utility>/);
});

test("moves non-copyable C++ values through owned Z bindings and value structs", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-move-only.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /#include <utility>/);
  assert.match(generated, /zcpp::UniqueValue first = zcpp::UniqueValue\(40\);/);
  assert.match(generated, /relay\(std::move\(first\)\)/);
  assert.match(generated, /\.value = std::move\(second\)/);
  assert.match(generated, /Z_NativeOwner moved = std::move\(owner\);/);
  assert.doesNotMatch(generated, /const zcpp::UniqueValue first/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const movedUse = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      const first = native.zcpp.UniqueValue(42);
      const second = first;
      return first.value();
    }
  `;
  const movedDiagnostic = diagnostics(movedUse, example)[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "first"/);

  const classStorage = `
    import native from "../../../tests/fixtures/move-only.hpp";
    class Session {
      value: native.zcpp.UniqueValue;
    }
    function main(): i32 { return 0; }
  `;
  const classDiagnostic = diagnostics(classStorage, example)[0];
  assert.equal(classDiagnostic.code, "Z0240");
  assert.match(classDiagnostic.message, /ARC class fields cannot store move-only native values/);

  const uninitializedStorage = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let value: native.zcpp.UniqueValue;
      return 0;
    }
  `;
  const uninitializedDiagnostic = diagnostics(uninitializedStorage, example)[0];
  assert.equal(uninitializedDiagnostic.code, "Z0240");
  assert.match(uninitializedDiagnostic.message, /must be initialized when their storage is declared/);

  const declarationFile = resolve(projectRoot, "tests/fixtures/move-only.hpp.zd");
  const declarationSource = readFileSync(declarationFile, "utf8");
  const typeOffset = declarationSource.indexOf("UniqueValue") + 2;
  assert.match(
    hover(declarationSource, declarationFile, typeOffset)?.contents.value ?? "",
    /native value: move, deinit; unavailable: copy/,
  );
});

test("stores move-only C++ values in Array and named enum payloads", () => {
  const arrayExample = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-array.zs");
  const arraySource = readFileSync(arrayExample, "utf8");
  const arrayGenerated = compileToNative(arraySource, arrayExample).source;
  assert.match(arrayGenerated, /#include <memory>/);
  assert.match(arrayGenerated, /#include <new>/);
  assert.match(arrayGenerated, /std::construct_at\(&storage\[index\], std::move\(self->data\[index\]\)\)/);
  assert.match(arrayGenerated, /std::destroy_at\(&self->data\[index - 1\]\)/);
  assert.match(arrayGenerated, /::operator delete\(self->data\)/);
  assert.match(arrayGenerated, /Z_LabeledValue_deinit\([^\n]+\);\n\s*std::destroy_at/);
  assert.doesNotMatch(arrayGenerated, /realloc\(self->data/);
  const arrayHoverOffset = arraySource.indexOf("values = makeValues") + 2;
  assert.match(
    hover(arraySource, arrayExample, arrayHoverOffset)?.contents.value ?? "",
    /values: Array<zcpp\.UniqueValue>/,
  );
  const arrayResult = spawnSync(process.execPath, [cli, "run", arrayExample], { encoding: "utf8" });
  assert.equal(arrayResult.status, 0, arrayResult.stderr);
  assert.match(arrayResult.stdout, /^array answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const enumExample = resolve(projectRoot, "examples/interop/cpp/cpp-move-only-enum.zs");
  const enumSource = readFileSync(enumExample, "utf8");
  const enumGenerated = compileToNative(enumSource, enumExample).source;
  assert.match(enumGenerated, /Z_NativeState\(Z_NativeState &&other\)/);
  assert.match(enumGenerated, /operator=\(Z_NativeState &&other\)/);
  assert.match(enumGenerated, /std::construct_at\(&result\.data\.ready, std::move\(value\)\)/);
  assert.match(enumGenerated, /std::destroy_at\(&data\.ready\)/);
  assert.match(enumGenerated, /const Z_NativeState \*_z_match_/);
  assert.match(enumGenerated, /zcpp::UniqueValue const \*value = &\(_z_match_[0-9]+->data\.ready\)/);
  assert.match(enumGenerated, /zcpp::UniqueValue value = std::move\(_z_match_[0-9]+\.data\.ready\)/);
  assert.match(enumGenerated, /Z_LabeledValue_deinit\(&\(\(labeled\)\.data\.ready\)\);[\s\S]*labeled = std::move\(_z_replacement_[0-9]+\);/);
  const borrowedPayloadOffset = enumSource.indexOf("ready(value)") + "ready(".length + 1;
  assert.match(
    hover(enumSource, enumExample, borrowedPayloadOffset)?.contents.value ?? "",
    /value: zcpp\.UniqueValue/,
  );
  const enumResult = spawnSync(process.execPath, [cli, "run", enumExample], { encoding: "utf8" });
  assert.equal(enumResult.status, 0, enumResult.stderr);
  assert.match(enumResult.stdout, /^enum answer=42, moves=[1-9][0-9]*, live=0\n$/);

  const movedElement = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Array<native.zcpp.UniqueValue>();
      values.push(native.zcpp.UniqueValue(42));
      const extracted = values[0];
      return extracted.value();
    }
  `;
  const elementDiagnostic = diagnostics(movedElement, arrayExample)[0];
  assert.match(elementDiagnostic.message, /cannot move an ownership-bearing field or element out of its owner/);

  const optionDirectory = mkdtempSync("/tmp/z-native-option-");
  const optionFile = resolve(optionDirectory, "main.zs");
  const compilerOption = `
    import native from ${JSON.stringify(resolve(projectRoot, "tests/fixtures/move-only.hpp"))};

    function open(fail: boolean): native.zcpp.UniqueValue throws i32 {
      if (fail) throw 7;
      return native.zcpp.UniqueValue(42);
    }

    function relay(): native.zcpp.UniqueValue throws i32 {
      return try open(false);
    }

    function main(): i32 {
      const option: Option<native.zcpp.UniqueValue> = Option.some(native.zcpp.UniqueValue(42));
      const optionAnswer = match (option) {
        some(value) => value.finish(0);
        none => 0;
      };
      const empty: Option<native.zcpp.UniqueValue> = Option.none;
      const emptyAnswer = match (empty) {
        some(value) => value.finish(0);
        none => 0;
      };
      const result = attempt relay();
      const resultAnswer = match (result) {
        success(value) => value.finish(0);
        failure(error) => -error;
      };
      const failed = attempt open(true);
      const failureCode = match (failed) {
        success(value) => value.finish(0);
        failure(error) => error;
      };
      return optionAnswer - 42 + emptyAnswer + resultAnswer - 42 + failureCode - 7 + native.zcpp.unique_live();
    }
  `;
  writeFileSync(optionFile, compilerOption);
  const optionGenerated = compileToNative(compilerOption, optionFile).source;
  assert.match(optionGenerated, /Z_Option_[^:]+::make_some/);
  assert.match(optionGenerated, /Z_Option_[^:]+::make_none/);
  assert.match(optionGenerated, /Z_Result_[^:]+::make_success/);
  assert.match(optionGenerated, /Z_Result_[^:]+::make_failure/);
  assert.match(optionGenerated, /zcpp::UniqueValue value = std::move/);
  const optionResult = spawnSync(process.execPath, [cli, "run", optionFile], { encoding: "utf8" });
  assert.equal(optionResult.status, 0, optionResult.stderr);

  const mixedStructReplacement = `
    import native from "../../../tests/fixtures/move-only.hpp";
    struct LabeledValue {
      label: String;
      value: native.zcpp.UniqueValue;
    }
    function main(): i32 {
      let value = LabeledValue({ label: "first", value: native.zcpp.UniqueValue(1) });
      value = LabeledValue({ label: "second", value: native.zcpp.UniqueValue(2) });
      return 0;
    }
  `;
  const replacementDiagnostic = diagnostics(mixedStructReplacement, arrayExample)[0];
  assert.equal(replacementDiagnostic.code, "Z0240");
  assert.match(replacementDiagnostic.message, /replacement assignment for a value combining Z cleanup and move-only native storage/);
});

test("maps C++ references and receiver qualifiers onto existing Z capabilities", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-references.zs");
  const source = readFileSync(example, "utf8");
  const analysis = analyzeSource(source, example);
  const module = analysis.foreignModules.get("native")!;
  const inspectParameter = module.functions.get("zcpp.inspect_unique")?.overloads[0]?.parameters[0]?.type;
  const adjustParameter = module.functions.get("zcpp.adjust_unique")?.overloads[0]?.parameters[0]?.type;
  const consumeParameter = module.functions.get("zcpp.consume_unique")?.overloads[0]?.parameters[0]?.type;
  assert.equal(inspectParameter?.kind === "reference" ? inspectParameter.access : null, "in");
  assert.equal(adjustParameter?.kind === "reference" ? adjustParameter.access : null, "inout");
  assert.equal(consumeParameter?.kind === "reference" ? consumeParameter.access : null, "move");
  const nativeValue = module.namedTypes.get("zcpp.UniqueValue");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "value")?.overloads[0]?.receiverAccess
    : null, "in");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "add")?.overloads[0]?.receiverAccess
    : null, "inout");
  assert.equal(nativeValue?.kind === "value"
    ? nativeValue.methods.find((method) => method.name === "finish")?.overloads[0]?.receiverAccess
    : null, "move");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /inspect_unique\(functionValue\)/);
  assert.match(generated, /adjust_unique\(functionValue, 2\)/);
  assert.match(generated, /consume_unique\(std::move\(functionValue\)\)/);
  assert.match(generated, /methodValue\.value\(\)/);
  assert.match(generated, /methodValue\.add\(2\)/);
  assert.match(generated, /std::move\(methodValue\)\.finish\(0\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "answer=42, live=0\n");

  const inspectHover = hover(source, example, source.indexOf("inspect_unique") + 2)?.contents.value ?? "";
  assert.match(inspectHover, /inspect_unique\(in value: .*UniqueValue\): i32/);
  const adjustHover = hover(source, example, source.indexOf("adjust_unique") + 2)?.contents.value ?? "";
  assert.match(adjustHover, /adjust_unique\(inout value: .*UniqueValue, amount: i32\): void/);
  const consumeHover = hover(source, example, source.indexOf("consume_unique") + 2)?.contents.value ?? "";
  assert.match(consumeHover, /consume_unique\(value: .*UniqueValue\): i32.*UniqueValue &&/s);
  const finishHover = hover(source, example, source.lastIndexOf("finish(") + 2)?.contents.value ?? "";
  assert.match(finishHover, /finish\(move this, offset: i32\): i32.*C\+\+ consuming receiver/s);
  const completionSource = `
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let value = native.zcpp.UniqueValue(1);
      value.;
      return 0;
    }
  `;
  const completionOffset = completionSource.indexOf("value.;") + "value.".length;
  const finishCompletion = completions(completionSource, example, completionOffset)
    .find((item) => item.label === "finish");
  assert.match(finishCompletion?.detail ?? "", /move this.*C\+\+ consuming receiver/s);

  const missingInout = source.replace("adjust_unique(inout functionValue", "adjust_unique(functionValue");
  assert.match(
    diagnostics(missingInout, example)[0]?.message ?? "",
    /C\+\+ mutable reference parameter requires inout <mutable binding>/,
  );

  const immutableReceiver = source
    .replace("let methodValue", "const methodValue")
    .replace("methodValue.finish(0)", "native.zcpp.consume_unique(methodValue)");
  assert.match(
    diagnostics(immutableReceiver, example)[0]?.message ?? "",
    /mutable native method "add" requires addressable let storage/,
  );

  const useAfterFunctionMove = source.replace(
    "const consumed = native.zcpp.consume_unique(functionValue);",
    "const consumed = native.zcpp.consume_unique(functionValue);\n  const invalid = functionValue.value();",
  );
  assert.equal(diagnostics(useAfterFunctionMove, example)[0]?.code, "Z0201");

  const useAfterMethodMove = source.replace(
    "const finished = methodValue.finish(0);",
    "const finished = methodValue.finish(0);\n  const invalid = methodValue.value();",
  );
  assert.equal(diagnostics(useAfterMethodMove, example)[0]?.code, "Z0201");

  const ambiguousReceiver = source.replace("methodValue.finish(0)", "methodValue.qualified()");
  const ambiguousDiagnostic = diagnostics(ambiguousReceiver, example)[0];
  assert.equal(ambiguousDiagnostic?.code, "Z0803");
  assert.match(ambiguousDiagnostic?.message ?? "", /receiver-qualified overloads that require an explicit receiver capability choice/);

  const ambiguousArgument = source.replace(
    "native.zcpp.consume_unique(functionValue)",
    "native.zcpp.qualified_unique(functionValue)",
  );
  const argumentDiagnostic = diagnostics(ambiguousArgument, example)[0];
  assert.equal(argumentDiagnostic?.code, "Z0803");
  assert.match(argumentDiagnostic?.message ?? "", /requires an explicit argument capability choice/);
});

test("imports C++ constructors and static methods as direct type-level calls", () => {
  const example = resolve(projectRoot, "examples/interop/cpp/cpp-callables.zs");
  const source = readFileSync(example, "utf8");
  const generated = compileToNative(source, example).source;
  assert.match(generated, /const zcpp::ManagedValue direct = zcpp::ManagedValue\(20\);/);
  assert.match(generated, /const zcpp::ManagedValue made = zcpp::ManagedValue::from\(22\);/);
  assert.match(generated, /zcpp::ManagedValue::sum\(direct\.value\(\), made\.value\(\)\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const constructorOffset = source.indexOf("ManagedValue(20)");
  assert.match(hover(source, example, constructorOffset)?.contents.value ?? "", /ManagedValue\(value: i32\).*C\+\+ constructor/);
  assert.match(definition(source, `file://${example}`, constructorOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const staticOffset = source.indexOf("from(22)");
  assert.match(hover(source, example, staticOffset)?.contents.value ?? "", /from\(value: i32\): native\.zcpp\.ManagedValue.*C\+\+ static/);
  assert.match(definition(source, `file://${example}`, staticOffset)?.uri ?? "", /foreign-values\.hpp$/);

  const completionSource = source.replace("native.zcpp.ManagedValue.from(22)", "native.zcpp.ManagedValue.");
  const completionOffset = completionSource.indexOf("native.zcpp.ManagedValue.") + "native.zcpp.ManagedValue.".length;
  const items = completions(completionSource, example, completionOffset);
  assert.match(items.find((item) => item.label === "from")?.detail ?? "", /C\+\+ static/);
  assert.match(items.find((item) => item.label === "sum")?.detail ?? "", /sum\(left: i32, right: i32\)/);
  assert.equal(items.some((item) => item.label === "value"), false);

  const selective = source
    .replace('import native from "../../../tests/fixtures/foreign-values.hpp";', 'import { ManagedValue as Value } from "../../../tests/fixtures/foreign-values.hpp";')
    .replaceAll("native.zcpp.ManagedValue", "Value");
  const selectiveGenerated = compileToNative(selective, example).source;
  assert.match(selectiveGenerated, /zcpp::ManagedValue::from\(22\)/);
  const selectiveStaticOffset = selective.indexOf("from(22)");
  assert.match(hover(selective, example, selectiveStaticOffset)?.contents.value ?? "", /C\+\+ static/);
  const selectiveCompletionSource = selective.replace("Value.from(22)", "Value.");
  const selectiveCompletionOffset = selectiveCompletionSource.indexOf("Value.") + "Value.".length;
  assert.equal(
    completions(selectiveCompletionSource, example, selectiveCompletionOffset)
      .find((item) => item.label === "from")?.insertText,
    "from()",
  );

  assert.throws(
    () => compileToNative(source.replace("ManagedValue.sum(direct.value(), made.value())", 'ManagedValue.sum("left", "right")'), example),
    /no overload of native static method "zcpp\.ManagedValue\.sum" accepts these arguments/,
  );
  assert.throws(
    () => compileToNative(source.replace("ManagedValue.from(22)", "ManagedValue.missing(22)"), example),
    /native value type "native\.zcpp\.ManagedValue" has no static method "missing"/,
  );
  assert.throws(
    () => compileToNative(source.replace("ManagedValue.from(22)", "ManagedValue.value()"), example),
    /native instance method "value" must be called through a native\.zcpp\.ManagedValue value/,
  );
});
