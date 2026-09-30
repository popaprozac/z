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
} from "./support/bootstrap.ts";
import type {
  ForeignFunctionDeclaration,
  ForeignModuleDeclarations,
  ImportDeclaration,
} from "./support/bootstrap.ts";

test("formats typed values through the imported console namespace and interpolation", () => {
  const example = resolve(projectRoot, "examples/language/basics/console.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^42 with text in between, struct: Point \{ x: 20, y: 22 \}; literal \{braces\}, escaped \$\{answer\}\narray \[1, 2, 3\] enum Status\.ready\(7\) class Counter@0x[0-9a-f]+\npartial true done\nsequence 1 then 2\n$/,
  );
  assert.equal(result.stderr, "problem Point { x: 20, y: 22 }\ndebug 42\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /#include <stdio\.h>/);
  assert.match(generated, /fputs\(" with text in between, struct: ", stdout\)/);
  assert.match(generated, /fprintf\(stdout, "%lld", \(long long\)/);
  assert.match(generated, /fflush\(stdout\)/);
  assert.match(generated, /fflush\(stderr\)/);
  assert.match(generated, /switch \(\(_z_console_\d+\)\.tag\)/);
  assert.doesNotMatch(generated, /console\.log/);
});

test("lowers interpolated String values nested inside conditions", () => {
  const source = `
    function main(): i32 {
      const service = "notes";
      if ("notes.create" == \`\${service}.create\`) return 0;
      return 1;
    }
  `;
  const generated = compileToC(source, "interpolated-condition.zs");
  assert.match(generated, /z_string_equal/);
  assert.match(generated, /_z_expression_result_\d+/);
  const directory = mkdtempSync("/tmp/z-interpolated-condition-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("streams native console output before z run exits", async () => {
  const directory = mkdtempSync("/tmp/z-streaming-console-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, `
    import console from "std/console";
    import { sleep } from "std/time";
    function main(): i32 {
      console.log("live");
      sleep(300);
      console.log("done");
      return 0;
    }
  `);

  const child = spawn(process.execPath, [cli, "run", fileName], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let sawLive = false;
  const streamedWhileRunning = new Promise<boolean>((resolveStream, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!sawLive && stdout.includes("live\n")) {
        sawLive = true;
        resolveStream(child.exitCode === null);
      }
    });
    child.once("close", () => {
      if (!sawLive) resolveStream(false);
    });
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const completion = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });

  assert.equal(await streamedWhileRunning, true);
  assert.equal(await completion, 0, stderr);
  assert.equal(stdout, "live\ndone\n");
});

test("resolves explicit standard console imports without routing them through Clang", () => {
  const missing = `function main(): i32 { console.log(42); return 0; }`;
  const missingDiagnostic = diagnostics(missing, "missing-console.zs")[0];
  assert.equal(missingDiagnostic.code, "Z0403");
  assert.match(missingDiagnostic.message, /import console from "std\/console"/);

  const focused = `
    import logging from "std/console";
    function main(): i32 { logging.log(42); return 0; }
  `;
  assert.deepEqual(diagnostics(focused, "focused-console.zs"), []);
  const focusedGenerated = compileToC(focused, "focused-console.zs");
  assert.match(focusedGenerated, /fprintf\(stdout, "%lld", \(long long\)/);
  assert.doesNotMatch(focusedGenerated, /#include <std\/console>/);

  const facade = `
    import { console as logging } from "std";
    function main(): i32 { logging.write(42); return 0; }
  `;
  assert.deepEqual(diagnostics(facade, "facade-console.zs"), []);
  assert.doesNotMatch(compileToC(facade, "facade-console.zs"), /#include <std>/);

  const unknownModule = `import future from "std/future"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(unknownModule, "unknown-std.zs")[0].code, "Z0501");
  const unknownExport = `import { future } from "std"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "unknown-std-export.zs")[0].message, /std has no export "future"/);
});

test("sleeps the current thread through the portable std/time module", () => {
  const source = `
    import { sleep as pause } from "std/time";
    function main(): i32 {
      pause(1);
      const delay: (milliseconds: u64) => void = pause;
      delay(1);
      return 0;
    }
  `;
  const generated = compileToC(source, "sleep.zs");
  assert.match(generated, /#if defined\(_WIN32\)[\s\S]*#include <windows\.h>[\s\S]*#include <time\.h>/);
  assert.match(generated, /static void z_sleep_ms\(uint64_t milliseconds\)/);
  assert.match(generated, /nanosleep\(&remaining, &remaining\)/);
  assert.match(generated, /Sleep\(\(DWORD\)milliseconds\)/);
  assert.match(generated, /z_sleep_ms\(1ULL\);/);
  assert.match(generated, /delay = \(Z_Function_[0-9a-f]+\)\{ \.call = __z_standard_function_adapter_sleep/);
  assert.match(generated, /\(delay\)\.call\(\(delay\)\.context, 1ULL\)/);
  assert.doesNotMatch(generated, /#include <std\/time>/);

  const directory = mkdtempSync("/tmp/z-sleep-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const pauseUse = source.indexOf("pause(1)") + 1;
  assert.match(hover(source, "sleep-editor.zs", pauseUse)?.contents.value ?? "", /pause\(milliseconds: u64\): void/);
  assert.match(hover(source, "sleep-editor.zs", pauseUse)?.contents.value ?? "", /alias of sleep/);
  const completionSource = source.replace("pause(1)", "pau");
  const completionOffset = completionSource.indexOf("pau", completionSource.indexOf("main")) + 3;
  assert.match(
    completions(completionSource, "sleep-editor.zs", completionOffset).find((item) => item.label === "pause")?.detail ?? "",
    /blocks the current thread/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, "sleep-editor.zs").data);
  const pausePosition = positionForOffset(source, pauseUse - 1);
  assert.ok(tokens.some((token) => (
    token.line === pausePosition.line
    && token.character === pausePosition.character
    && token.type === semanticTokenTypes.indexOf("function")
  )));

  const defaultImport = `import time from "std/time"; function main(): i32 { return 0; }`;
  assert.equal(diagnostics(defaultImport, "sleep-default.zs")[0].code, "Z0501");
  const unknownExport = `import { timer } from "std/time"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(unknownExport, "sleep-export.zs")[0].message, /std\/time has no export "timer"/);
  const wrongType = `import { sleep } from "std/time"; function main(): i32 { sleep(-1); return 0; }`;
  assert.match(diagnostics(wrongType, "sleep-type.zs")[0].message, /integer literal -1 does not fit u64/);
});

test("preserves the value ABI of explicit standard-library borrows", () => {
  const directory = mkdtempSync("/tmp/z-standard-borrow-abi-");
  try {
    const fileName = resolve(directory, "main.zs");
    const output = resolve(directory, "written.txt");
    const source = `
      import fs from "std/fs";
      struct Location { path: String; }
      function writeBorrowedPath(in path: String, in contents: String): void throws String {
        try fs.writeText(in path, in contents);
      }
      function exists(inout path: String): boolean { return fs.exists(in path); }
      function run(): i32 throws String {
        const directory: String = ${JSON.stringify(directory)};
        let path = \`\${directory}/written.txt\`;
        const description: String = "payload";
        const contents = \`borrowed \${description}\`;
        try fs.writeText(in path, in contents);
        try writeBorrowedPath(in path, in contents);
        try writeBorrowedPath(path, \`borrowed \${description}\`);
        try fs.writeText(\`\${directory}/written.txt\`, contents);
        if (!exists(inout path)) return 1;
        const location = Location({ path: copy path });
        const text = try fs.readText(in location.path);
        const bytes = try fs.readBytes(in path);
        if (text != contents || bytes.length != contents.byteLength) return 2;
        if (!fs.exists(path) || path != ${JSON.stringify(output)}) return 3;
        return 0;
      }
      function main(): i32 {
        return match (attempt run()) { success(code) => code; failure(_) => 4; };
      }
    `;
    writeFileSync(fileName, source);
    const stage0 = compileToC(source, fileName);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", fileName], {
      encoding: "utf8", timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr || String(native.error));
    for (const [mode, generated] of [["stage0", stage0], ["native", native.stdout]] as const) {
      const executable = resolve(directory, mode);
      const compilation = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-O2", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        input: generated, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
      });
      assert.equal(compilation.status, 0, `${mode}: ${compilation.stderr}`);
      const executed = spawnSync(executable, [], { encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
      assert.equal(executed.status, 0, `${mode}: ${executed.stderr}`);
      assert.equal(readFileSync(output, "utf8"), "borrowed payload");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 240_000);

test("reads files, exposes program arguments, and runs child processes through standard modules", () => {
  const directory = mkdtempSync("/tmp/z-system-std-");
  const fileName = resolve(directory, "main.zs");
  const copyPath = resolve(directory, "copy.zs");
  const replacementSourcePath = resolve(directory, "replacement.pending");
  const replacementDestinationPath = resolve(directory, "replacement.txt");
  const binaryPath = resolve(directory, "bytes.bin");
  const nestedDirectory = resolve(directory, "cache/generated/native");
  writeFileSync(binaryPath, Buffer.from([0, 255, 42]));
  const source = `
    import console from "std/console";
    import fs from "std/fs";
    import process from "std/process";

    function runTool(): i32 throws String {
      const bytes = try fs.readBytes(${JSON.stringify(binaryPath)});
      if (
        bytes.length != 3
        || bytes[0] != 0
        || bytes[1] != 255
        || bytes[2] != 42
      ) return 83;
      const source = try fs.readText(${JSON.stringify(fileName)});
      try fs.writeText(${JSON.stringify(copyPath)}, source);
      if (!fs.exists(${JSON.stringify(copyPath)})) return 90;
      try fs.writeText(${JSON.stringify(replacementDestinationPath)}, "old");
      try fs.writeText(${JSON.stringify(replacementSourcePath)}, "new");
      try fs.replace(
        ${JSON.stringify(replacementSourcePath)},
        ${JSON.stringify(replacementDestinationPath)}
      );
      if (fs.exists(${JSON.stringify(replacementSourcePath)})) return 82;
      const replaced = try fs.readText(
        ${JSON.stringify(replacementDestinationPath)}
      );
      if (replaced != "new") return 81;
      const missingReplacement = attempt fs.replace(
        ${JSON.stringify(replacementSourcePath)},
        ${JSON.stringify(replacementDestinationPath)}
      );
      const missingReplacementFailed = match (missingReplacement) {
        success => false;
        failure(_) => true;
      };
      if (!missingReplacementFailed) return 80;
      if (!fs.isDirectory(${JSON.stringify(directory)})) return 87;
      if (fs.isDirectory(${JSON.stringify(fileName)})) return 86;
      try fs.createDirectories(${JSON.stringify(nestedDirectory)});
      try fs.createDirectories(${JSON.stringify(nestedDirectory)});
      if (!fs.isDirectory(${JSON.stringify(nestedDirectory)})) return 85;
      const occupied = attempt fs.createDirectories(${JSON.stringify(copyPath)});
      const occupiedWasFailure = match (occupied) {
        success => false;
        failure(_) => true;
      };
      if (!occupiedWasFailure) return 84;
      const canonical = try fs.realPath(${JSON.stringify(`${directory}/./main.zs`)});
      if (canonical != ${JSON.stringify(resolve(realpathSync(directory), "main.zs"))}) return 88;
      const arguments = process.args();
      const executablePath = try process.executablePath();
      if (!fs.exists(executablePath)) return 79;
      const childArguments = ["-e", "process.exit(0)"];
      const exitCode = try process.run(${JSON.stringify(process.execPath)}, childArguments);
      const missing = attempt process.run("/z/definitely/missing/executable", childArguments);
      const missingWasTypedFailure = match (missing) {
        success(code) => code < 0;
        failure(message) => !fs.exists(message);
      };
      if (!missingWasTypedFailure) return 89;
      console.log(\`args=\${arguments.length}, child=\${exitCode}\`);
      return exitCode;
    }

    function main(): i32 {
      const result = attempt runTool();
      return match (result) {
        success(code) => code;
        failure(message) => {
          console.error(message);
          select 91;
        }
      };
    }
  `;
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName, "--", "alpha", "beta"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "args=2, child=0\n");
  assert.equal(readFileSync(copyPath, "utf8"), source);
  assert.equal(existsSync(replacementSourcePath), false);
  assert.equal(readFileSync(replacementDestinationPath, "utf8"), "new");

  const generated = compileToC(source, fileName);
  assert.match(generated, /static Z_Result_.* z_fs_read_bytes/);
  assert.match(generated, /static Z_Result_String_String z_fs_read_text/);
  assert.match(generated, /static Z_Result_String_String z_fs_real_path/);
  assert.match(generated, /static Z_Result_void_String z_fs_replace/);
  assert.match(generated, /rename\(native_source, native_destination\)/);
  assert.match(generated, /static bool z_fs_is_directory/);
  assert.match(generated, /static Z_Result_void_String z_fs_create_directories/);
  assert.match(generated, /static Z_DynamicArray_.* z_process_args\(void\)/);
  assert.match(
    generated,
    /static Z_Result_String_String z_process_executable_path\(void\)/,
  );
  assert.match(generated, /execvp\(argv\[0\], argv\)/);
  assert.match(generated, /int32_t main\(int argc, char \*\*argv\)/);
  assert.doesNotMatch(generated, /#include <std\/(?:fs|process)>/);

  const readOffset = source.indexOf("readText") + 2;
  assert.match(hover(source, fileName, readOffset)?.contents.value ?? "", /readText\(in path: String\): String throws String/);
  const readBytesOffset = source.indexOf("readBytes") + 2;
  assert.match(
    hover(source, fileName, readBytesOffset)?.contents.value ?? "",
    /readBytes\(in path: String\): Array<u8> throws String/,
  );
  const createOffset = source.indexOf("createDirectories") + 2;
  assert.match(
    hover(source, fileName, createOffset)?.contents.value ?? "",
    /createDirectories\(in path: String\): void throws String/,
  );
  const replaceOffset = source.indexOf("replace(") + 2;
  assert.match(
    hover(source, fileName, replaceOffset)?.contents.value ?? "",
    /replace\(in source: String, in destination: String\): void throws String/,
  );
  const executablePathOffset = source.indexOf("executablePath()") + 2;
  assert.match(
    hover(source, fileName, executablePathOffset)?.contents.value ?? "",
    /executablePath\(\): String throws String/,
  );
  const completionSource = source.replace("fs.readText", "fs.re");
  const completionOffset = completionSource.indexOf("fs.re") + "fs.re".length;
  assert.match(
    completions(completionSource, fileName, completionOffset).find((item) => item.label === "readText")?.detail ?? "",
    /throws String/,
  );
  const createCompletionSource = source.replace(
    "fs.createDirectories",
    "fs.createD",
  );
  const createCompletionOffset = createCompletionSource.indexOf("fs.createD")
    + "fs.createD".length;
  assert.match(
    completions(
      createCompletionSource,
      fileName,
      createCompletionOffset,
    ).find((item) => item.label === "createDirectories")?.detail ?? "",
    /throws String/,
  );
  const replaceCompletionSource = source.replace("fs.replace", "fs.rep");
  const replaceCompletionOffset = replaceCompletionSource.indexOf("fs.rep")
    + "fs.rep".length;
  assert.match(
    completions(
      replaceCompletionSource,
      fileName,
      replaceCompletionOffset,
    ).find((item) => item.label === "replace")?.detail ?? "",
    /throws String/,
  );
  const processCompletionSource = source.replace(
    "process.executablePath",
    "process.exe",
  );
  const processCompletionOffset = processCompletionSource.indexOf("process.exe")
    + "process.exe".length;
  assert.match(
    completions(
      processCompletionSource,
      fileName,
      processCompletionOffset,
    ).find((item) => item.label === "executablePath")?.detail ?? "",
    /throws String/,
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const readPosition = positionForOffset(source, source.indexOf("readText"));
  assert.ok(tokens.some((token) => (
    token.line === readPosition.line
    && token.character === readPosition.character
    && token.type === semanticTokenTypes.indexOf("method")
  )));

  const unchecked = `import fs from "std/fs"; function main(): i32 { fs.readText("missing"); return 0; }`;
  assert.match(diagnostics(unchecked, "unchecked-fs.zs")[0].message, /requires `attempt` or `try`/);
  const uncheckedReplace = `import fs from "std/fs"; function main(): i32 { fs.replace("source", "destination"); return 0; }`;
  assert.match(
    diagnostics(uncheckedReplace, "unchecked-fs-replace.zs")[0].message,
    /requires `attempt` or `try`/,
  );
  const uncheckedExecutablePath = `import process from "std/process"; function main(): i32 { process.executablePath(); return 0; }`;
  assert.match(
    diagnostics(
      uncheckedExecutablePath,
      "unchecked-process-executable-path.zs",
    )[0].message,
    /requires `attempt` or `try`/,
  );
  const selective = `import { readText } from "std/fs"; function main(): i32 { return 0; }`;
  assert.match(diagnostics(selective, "selective-fs.zs")[0].message, /default module import/);

  const mixedFile = resolve(directory, "mixed.zs");
  const nativeHeader = resolve(projectRoot, "tests/fixtures/foreign-values.hpp");
  writeFileSync(mixedFile, `
    import fs from "std/fs";
    import native from ${JSON.stringify(nativeHeader)};
    function main(): i32 {
      const value = native.zcpp.ManagedValue(42);
      if (!fs.exists(${JSON.stringify(mixedFile)})) return 1;
      return value.value() - 42;
    }
  `);
  const mixed = spawnSync(process.execPath, [cli, "run", mixedFile], { encoding: "utf8" });
  assert.equal(mixed.status, 0, mixed.stderr);

  const invalidUtf8Path = resolve(directory, "invalid-utf8.txt");
  writeFileSync(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
  const invalidUtf8File = resolve(directory, "invalid-utf8.zs");
  writeFileSync(invalidUtf8File, `
    import fs from "std/fs";
    function main(): i32 {
      const result = attempt fs.readText(${JSON.stringify(invalidUtf8Path)});
      return match (result) {
        success(contents) => 1;
        failure(message) => fs.exists(message) ? 2 : 0;
      };
    }
  `);
  const invalidUtf8 = spawnSync(process.execPath, [cli, "run", invalidUtf8File], { encoding: "utf8" });
  assert.equal(invalidUtf8.status, 0, invalidUtf8.stderr);
});

test("owns exclusive filesystem locks and releases them deterministically", async () => {
  const directory = mkdtempSync("/tmp/z-fs-lock-");
  const lockPath = resolve(directory, "shared.lock");
  const source = `
    import console from "std/console";
    import fs from "std/fs";
    import { sleep } from "std/time";

    function holdLock(): i32 throws String {
      const lock: fs.Lock = try fs.lock(${JSON.stringify(lockPath)});
      console.log("acquired");
      sleep(250);
      return 0;
    }

    function main(): i32 {
      return match (attempt holdLock()) {
        success(status) => status;
        failure(message) => {
          console.error(message);
          select 1;
        }
      };
    }
  `;
  const generated = compileToC(source, resolve(directory, "main.zs"));
  assert.match(generated, /typedef struct Z_FsLock/);
  assert.match(generated, /flock\(descriptor, LOCK_EX\)/);
  assert.match(generated, /Z_FsLock_deinit/);

  const executable = resolve(directory, "holder");
  const compilation = spawnSync(
    "clang",
    ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable],
    { encoding: "utf8", input: generated },
  );
  assert.equal(compilation.status, 0, compilation.stderr);

  const first = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
  let firstOutput = "";
  let firstError = "";
  first.stdout.on("data", (chunk) => { firstOutput += chunk.toString(); });
  first.stderr.on("data", (chunk) => { firstError += chunk.toString(); });
  await new Promise<void>((resolveAcquired, reject) => {
    first.once("error", reject);
    first.stdout.on("data", () => {
      if (firstOutput.includes("acquired\n")) resolveAcquired();
    });
  });

  const second = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
  let secondOutput = "";
  let secondError = "";
  second.stdout.on("data", (chunk) => { secondOutput += chunk.toString(); });
  second.stderr.on("data", (chunk) => { secondError += chunk.toString(); });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
  assert.equal(secondOutput, "", "the second process must wait for the first lock owner");

  const firstExit = await new Promise<number | null>((resolveExit, reject) => {
    first.once("error", reject);
    first.once("close", resolveExit);
  });
  assert.equal(firstExit, 0, firstError);
  const secondExit = await new Promise<number | null>((resolveExit, reject) => {
    second.once("error", reject);
    second.once("close", resolveExit);
  });
  assert.equal(secondExit, 0, secondError);
  assert.equal(firstOutput, "acquired\n");
  assert.equal(secondOutput, "acquired\n");

  const explicit = `
    import fs from "std/fs";
    function releaseEarly(): i32 throws String {
      const lock = try fs.lock(${JSON.stringify(lockPath)});
      lock.unlock();
      return 0;
    }
    function main(): i32 { return 0; }
  `;
  assert.equal(diagnostics(explicit, "fs-lock-unlock.zs").length, 0);
  const unlockOffset = explicit.indexOf("unlock") + 2;
  assert.match(
    hover(explicit, "fs-lock-unlock.zs", unlockOffset)?.contents.value ?? "",
    /consumes fs\.Lock and releases it immediately/,
  );
  const lockBindingOffset = explicit.indexOf("lock =") + 1;
  assert.match(
    hover(explicit, "fs-lock-binding.zs", lockBindingOffset)?.contents.value ?? "",
    /lock: fs\.Lock/,
  );
  const memberSource = explicit.replace("lock.unlock()", "lock.un");
  const memberOffset = memberSource.indexOf("lock.un") + "lock.un".length;
  assert.match(
    completions(memberSource, "fs-lock-completion.zs", memberOffset)
      .find((item) => item.label === "unlock")?.detail ?? "",
    /consumes and releases/,
  );
  const typeOffset = source.indexOf("fs.Lock") + "fs.".length + 1;
  assert.match(
    hover(source, "fs-lock-type.zs", typeOffset)?.contents.value ?? "",
    /move-only exclusive interprocess filesystem lock/,
  );
  const tokens = decodeSemanticTokens(
    semanticTokens(source, "fs-lock-type.zs").data,
  );
  const lockTypePosition = positionForOffset(
    source,
    source.indexOf("Lock", source.indexOf("fs.Lock")),
  );
  assert.ok(tokens.some((token) => (
    token.line === lockTypePosition.line
    && token.character === lockTypePosition.character
    && token.type === semanticTokenTypes.indexOf("type")
  )));

  const doubleUnlock = explicit.replace(
    "lock.unlock();",
    "lock.unlock();\n      lock.unlock();",
  );
  assert.match(
    diagnostics(doubleUnlock, "fs-lock-double-unlock.zs")[0].message,
    /use of moved value|used after move|already been moved/,
  );
});

test("decodes borrowed byte storage into independent UTF-8 Strings with typed errors", () => {
  const file = resolve(projectRoot, "tests/fixtures/string-from-bytes.zs");
  const source = readFileSync(file, "utf8");
  const directory = mkdtempSync("/tmp/z-string-from-bytes-");
  try {
    const stage0 = compileToC(source, file);
    const checked = spawnSync(process.execPath, [cli, "check", file, "--native-frontend"], {
      encoding: "utf8", timeout: 240_000,
    });
    assert.equal(checked.status, 0, checked.stderr);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", file], {
      encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [name, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      const executable = resolve(directory, name);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        input: generated, encoding: "utf8", timeout: 30_000,
      });
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);

test("preserves byte-decoding errors across modules and Strings across async suspension", () => {
  const directory = mkdtempSync("/tmp/z-string-from-bytes-composition-");
  try {
    for (const [fixture, expectedStatus] of [
      ["string-from-bytes-async.zs", 0],
      ["string-from-bytes-async-error.zs", 1],
      ["string-from-bytes-modules/main.zs", 0],
      ["string-from-bytes-inferred.zs", 0],
      ["string-from-bytes-error.zs", 0],
    ] as const) {
      const file = resolve(projectRoot, "tests/fixtures", fixture);
      const source = readFileSync(file, "utf8");
      const checked = spawnSync(process.execPath, [cli, "check", file, "--native-frontend"], {
        encoding: "utf8", timeout: 240_000,
      });
      assert.equal(checked.status, 0, checked.stderr);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", file], {
        encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      for (const generated of [compileToC(source, file), native.stdout]) {
        const executable = resolve(directory, "probe");
        const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          encoding: "utf8", input: generated, timeout: 30_000,
        });
        assert.equal(built.status, 0, built.stderr);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, expectedStatus, `${fixture}: ${run.stderr}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);

test("checks and explains byte decoding ownership, errors, and imported error types", () => {
  const file = resolve(projectRoot, "tests/fixtures/string-from-bytes.zs");
  const source = readFileSync(file, "utf8");
  const missingHandling = source.replace("attempt String.fromBytes(bytes)", "String.fromBytes(bytes)");
  assert.match(diagnostics(missingHandling, file)[0]?.message ?? "", /throwing call requires/);
  const moved = source.replace("try String.fromBytes(bytes)", "try String.fromBytes(move bytes)");
  assert.ok(diagnostics(moved, file).length > 0, "borrowing must not silently consume the buffer");
  const wrongType = source.replace("try String.fromBytes(bytes)", "try String.fromBytes(42)");
  assert.match(diagnostics(wrongType, file)[0]?.message ?? "", /Slice|slice/);
  const redundantBorrow = source.replace("try String.fromBytes(bytes)", "try String.fromBytes(in bytes)");
  assert.ok(diagnostics(redundantBorrow, file).length > 0, "Slice is already the borrowing contract");
  const extraArgument = source.replace("try String.fromBytes(bytes)", "try String.fromBytes(bytes, bytes)");
  assert.match(diagnostics(extraArgument, file)[0]?.message ?? "", /expects 1 argument/);
  const changedError = 'import { Utf8Error } from "std/text"; function change(inout error: Utf8Error): void { error.byteOffset = 0; }';
  assert.match(diagnostics(changedError, file)[0]?.message ?? "", /readonly/);
  const wrongField = 'import { Utf8Error } from "std/text"; function main(): i32 { const error = Utf8Error({ offset: 1 }); return 0; }';
  assert.ok(diagnostics(wrongField, file).length > 0);
  const unknownEncoding = source.replace("try String.fromBytes(bytes)", "try String.fromBytes(bytes, { encoding: \"utf16\" })");
  assert.ok(diagnostics(unknownEncoding, file).length > 0, "encoding options are not implemented implicitly");
  const methodOffset = source.indexOf("fromBytes") + 2;
  assert.match(hover(source, file, methodOffset)?.contents.value ?? "", /fromBytes.*Slice<u8>.*throws Utf8Error/);
  const fieldOffset = source.indexOf("byteOffset") + 2;
  assert.match(hover(source, file, fieldOffset)?.contents.value ?? "", /byteOffset: usize/);
  const importSource = 'import { Utf } from "std/text";';
  assert.ok(completions(importSource, file, importSource.indexOf("Utf") + 3)
    .some((item) => item.label === "Utf8Error"));
  const memberSource = "function main(): i32 { String.fromB; return 0; }";
  assert.ok(completions(memberSource, file, memberSource.indexOf("fromB") + 5)
    .some((item) => item.label === "fromBytes"));
});

test("builds owned UTF-8 String values through explicit std/text TextBuffer", () => {
  const directory = mkdtempSync("/tmp/z-text-buffer-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    import console from "std/console";
    import { TextBuffer } from "std/text";

    function main(): i32 {
      let output = TextBuffer();
      output.append("alpha");
      output.appendAscii(10);
      output.appendCodePoint(937);
      output.appendCodePoint(128640);
      output.appendBytes("éZ", 0, 2);
      output.append(\`=\${40 + 2}\`);
      const text = output.finish();
      console.log(text);
      return 0;
    }
  `;
  writeFileSync(fileName, source);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "alpha\nΩ🚀é=42\n");

  const generated = compileToC(source, fileName);
  assert.match(generated, /Z_String output = z_string_new\(\);/);
  assert.match(generated, /z_text_buffer_append\(&\(output\)/);
  assert.match(generated, /z_text_buffer_append_ascii\(&\(output\), 10/);
  assert.match(generated, /z_text_buffer_append_code_point\(&\(output\), 937/);
  assert.match(generated, /z_text_buffer_append_bytes\(&\(output\)/);
  assert.match(generated, /Z_String text = \(_z_live_output_\d+ = false, output\);/);

  const aliased = source
    .replace("{ TextBuffer }", "{ TextBuffer as Buffer }")
    .replace("TextBuffer()", "Buffer()");
  assert.doesNotThrow(() => compileToC(aliased, "aliased-text-buffer.zs"));

  const missingImport = `function main(): i32 { let text = TextBuffer(); return 0; }`;
  assert.match(diagnostics(missingImport, "missing-text-import.zs")[0].message, /unknown function "TextBuffer"/);

  const immutable = `
    import { TextBuffer } from "std/text";
    function main(): i32 { const text = TextBuffer(); text.append("no"); return 0; }
  `;
  const immutableDiagnostic = diagnostics(immutable, "immutable-text-buffer.zs")[0];
  assert.match(immutableDiagnostic.message, /requires addressable let storage/);
  let immutableCompilerDiagnostic: unknown;
  try {
    compileToC(immutable, "immutable-text-buffer.zs");
  } catch (error) {
    immutableCompilerDiagnostic = error;
  }
  assert.ok(immutableCompilerDiagnostic instanceof DiagnosticError);
  assert.match(immutableCompilerDiagnostic.helps.join(" "), /bind the TextBuffer with `let`/);

  const consumed = `
    import { TextBuffer } from "std/text";
    function main(): i32 {
      let text = TextBuffer();
      const finished = text.finish();
      text.append("too late");
      return finished.byteLength;
    }
  `;
  assert.match(diagnostics(consumed, "consumed-text-buffer.zs")[0].message, /moved value "text"/);

  const printable = `
    import console from "std/console";
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); console.log(text); return 0; }
  `;
  const printableDiagnostic = diagnostics(printable, "printable-text-buffer.zs")[0];
  assert.match(printableDiagnostic.message, /mutable construction storage, not printable text/);
  let printableCompilerDiagnostic: unknown;
  try {
    compileToC(printable, "printable-text-buffer.zs");
  } catch (error) {
    printableCompilerDiagnostic = error;
  }
  assert.ok(printableCompilerDiagnostic instanceof DiagnosticError);
  assert.match(printableCompilerDiagnostic.helps.join(" "), /finish\(\)/);

  const invalidBoundaryFile = resolve(directory, "invalid-boundary.zs");
  writeFileSync(invalidBoundaryFile, `
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); text.appendBytes("é", 1, 2); return 0; }
  `);
  const invalidBoundary = spawnSync(process.execPath, [cli, "run", invalidBoundaryFile], { encoding: "utf8" });
  assert.notEqual(invalidBoundary.status, 0);

  const invalidAsciiFile = resolve(directory, "invalid-ascii.zs");
  writeFileSync(invalidAsciiFile, `
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); text.appendAscii(128); return 0; }
  `);
  const invalidAscii = spawnSync(process.execPath, [cli, "run", invalidAsciiFile], { encoding: "utf8" });
  assert.notEqual(invalidAscii.status, 0);

  const invalidCodePointFile = resolve(directory, "invalid-code-point.zs");
  writeFileSync(invalidCodePointFile, `
    import { TextBuffer } from "std/text";
    function main(): i32 { let text = TextBuffer(); text.appendCodePoint(55296); return 0; }
  `);
  const invalidCodePoint = spawnSync(process.execPath, [cli, "run", invalidCodePointFile], { encoding: "utf8" });
  assert.notEqual(invalidCodePoint.status, 0);

  const importSource = `import { TextB } from "std/text"; function main(): i32 { return 0; }`;
  const importOffset = importSource.indexOf("TextB") + "TextB".length;
  assert.equal(completions(importSource, fileName, importOffset).find((item) => item.label === "TextBuffer")?.kind, 22);
  const symbolSource = source.replace("let output = TextBuffer();", "let output = TextB;");
  const symbolOffset = symbolSource.indexOf("TextB;") + "TextB".length;
  assert.equal(completions(symbolSource, fileName, symbolOffset).find((item) => item.label === "TextBuffer")?.kind, 22);
  const memberSource = source.replace("output.append(\"alpha\")", "output.app");
  const memberOffset = memberSource.indexOf("output.app") + "output.app".length;
  const memberItems = completions(memberSource, fileName, memberOffset);
  const appendCompletion = memberItems.find((item) => item.label === "append");
  assert.ok(appendCompletion, JSON.stringify(memberItems));
  assert.match(appendCompletion?.detail ?? "", /append\(in text: String\): void/);
  const codePointSource = source.replace("output.append(\"alpha\")", "output.appendCodeP");
  const codePointOffset = codePointSource.indexOf("output.appendCodeP") + "output.appendCodeP".length;
  const codePointCompletion = completions(codePointSource, fileName, codePointOffset)
    .find((item) => item.label === "appendCodePoint");
  assert.match(codePointCompletion?.detail ?? "", /checked Unicode scalar/);
  const codePointHoverOffset = source.indexOf("appendCodePoint") + 2;
  assert.match(hover(source, fileName, codePointHoverOffset)?.contents.value ?? "", /codePoint: u32/);
  const finishOffset = source.indexOf("finish") + 2;
  assert.match(hover(source, fileName, finishOffset)?.contents.value ?? "", /consumes the TextBuffer/);
  const tokens = decodeSemanticTokens(semanticTokens(source, fileName).data);
  const importedType = positionForOffset(source, source.indexOf("TextBuffer"));
  assert.ok(tokens.some((token) => (
    token.line === importedType.line
    && token.character === importedType.character
    && token.type === semanticTokenTypes.indexOf("type")
  )));
});

test("stores, returns, moves, and formats owned String values", () => {
  const example = resolve(projectRoot, "examples/language/basics/strings.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Message { text: [point=Point { x: 20, y: 22 }, total=42] }\n12left=1|right=2\n[first, second]\nyes=42\nborrowed=42\n42\ndouble|single|literal\nliteral\ndouble\nffi=42\nmade=42\n",
  );

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /typedef struct \{\n  const char \*data;\n  uintptr_t length;/);
  assert.match(generated, /Z_String _z_string_\d+ = z_string_new\(\);/);
  assert.match(generated, /Z_String _z_argument_\d+;/);
  assert.match(generated, /Z_String _z_aggregate_\d+;/);
  assert.match(generated, /const int32_t _z_call_result_\d+ = _z_function_inspect/);
  assert.match(generated, /if \(\(_z_argument_\d+\)\.capacity > 0\) free\(\(void \*\)\(_z_argument_\d+\)\.data\);/);
  assert.match(generated, /Z_String doubleQuoted = \(Z_String\)\{ \.data = "double", \.length = sizeof\("double"\) - 1, \.capacity = 0 \}/);
  assert.match(generated, /puts\(\(\(doubleQuoted\)\.data != NULL/);
  assert.match(generated, /const char \* const boundary = "literal";/);
  assert.match(generated, /Z_String copied = z_string_from_cstring\(boundary\);/);
  assert.match(generated, /z_string_append_signed/);
  assert.match(generated, /if \(\(self->text\)\.capacity > 0\) free\(\(void \*\)\(self->text\)\.data\);/);

  const source = readFileSync(example, "utf8");
  const chosenOffset = source.indexOf("chosen: String") + 1;
  assert.match(hover(source, example, chosenOffset)?.contents.value ?? "", /chosen: String/);
  const doubleOffset = source.indexOf("doubleQuoted") + 1;
  assert.match(hover(source, example, doubleOffset)?.contents.value ?? "", /doubleQuoted: String/);
  const boundaryOffset = source.indexOf("boundary: cstring") + 1;
  assert.match(hover(source, example, boundaryOffset)?.contents.value ?? "", /boundary: cstring/);
  const fromOffset = source.indexOf("from(boundary)") + 1;
  assert.match(hover(source, example, fromOffset)?.contents.value ?? "", /from\(value: cstring\): String/);
  const completionSource = source.replace("String.from(boundary)", "String.fr");
  const completionOffset = completionSource.indexOf("String.fr") + "String.fr".length;
  assert.equal(completions(completionSource, example, completionOffset).find((item) => item.label === "from")?.kind, 2);

  const byteSource = `
    import console from "std/console";
    function main(): i32 {
      const word = "éZ";
      console.log(\`\${word.byteLength}|\${word.byteAt(0)}|\${word.isEmpty}\`);
      const first = word.copyBytes(0, 2);
      console.log(first);
      const empty = "";
      console.log(empty.isEmpty);
      return 0;
    }
  `;
  const byteFile = resolve(mkdtempSync("/tmp/z-string-bytes-"), "main.zs");
  writeFileSync(byteFile, byteSource);
  const byteResult = spawnSync(process.execPath, [cli, "run", byteFile], { encoding: "utf8" });
  assert.equal(byteResult.status, 0, byteResult.stderr);
  assert.equal(byteResult.stdout, "3|195|false\né\ntrue\n");
  const byteGenerated = compileToC(byteSource, byteFile);
  assert.match(byteGenerated, /z_string_byte_at\(word, 0ULL\)/);
  assert.match(byteGenerated, /z_string_copy_bytes\(word, 0ULL, 2ULL\)/);
  assert.match(byteGenerated, /z_string_is_utf8_boundary/);

  const byteLengthOffset = byteSource.indexOf("byteLength") + 2;
  assert.match(hover(byteSource, byteFile, byteLengthOffset)?.contents.value ?? "", /byteLength: usize/);
  const byteAtOffset = byteSource.indexOf("byteAt") + 2;
  assert.match(hover(byteSource, byteFile, byteAtOffset)?.contents.value ?? "", /byteAt\(index: usize\): u8/);
  const byteCompletionSource = byteSource.replace("word.byteLength", "word.by");
  const byteCompletionOffset = byteCompletionSource.indexOf("word.by") + "word.by".length;
  const byteLabels = completions(byteCompletionSource, byteFile, byteCompletionOffset).map((item) => item.label);
  assert.ok(byteLabels.includes("byteLength"));
  assert.ok(byteLabels.includes("byteAt"));
  const byteTokens = decodeSemanticTokens(semanticTokens(byteSource, byteFile).data);
  const byteLengthPosition = positionForOffset(byteSource, byteSource.indexOf("byteLength"));
  const byteAtPosition = positionForOffset(byteSource, byteSource.indexOf("byteAt"));
  assert.ok(byteTokens.some((token) => (
    token.line === byteLengthPosition.line
    && token.character === byteLengthPosition.character
    && token.type === semanticTokenTypes.indexOf("property")
  )));
  assert.ok(byteTokens.some((token) => (
    token.line === byteAtPosition.line
    && token.character === byteAtPosition.character
    && token.type === semanticTokenTypes.indexOf("method")
  )));

  const invalidByteCall = `function main(): i32 { const text = "hello"; return text.byteAt("0"); }`;
  assert.match(diagnostics(invalidByteCall, "invalid-string-byte.zs")[0].message, /expected usize, found String/);
  const reservedLength = `function main(): i32 { const text = "hello"; return text.length; }`;
  assert.match(diagnostics(reservedLength, "reserved-string-length.zs")[0].message, /String has no property "length"/);

  const invalidBoundaryFile = resolve(mkdtempSync("/tmp/z-string-boundary-"), "main.zs");
  writeFileSync(invalidBoundaryFile, `
    function main(): i32 {
      const text = "é";
      const invalid = text.copyBytes(1, 2);
      return 0;
    }
  `);
  const invalidBoundary = spawnSync(process.execPath, [cli, "run", invalidBoundaryFile], { encoding: "utf8" });
  assert.notEqual(invalidBoundary.status, 0);

  const escapingBorrow = `
    function main(): i32 {
      const owned = \`value=42\`;
      const escaped: cstring = owned;
      return 0;
    }
  `;
  assert.match(diagnostics(escapingBorrow, "escaping-cstring.zs")[0].message, /expected cstring, found String/);

  const singleQuotedImport = `
    import stdio from 'stdio.h';
    function main(): i32 { return stdio.puts('single import'); }
  `;
  assert.deepEqual(diagnostics(singleQuotedImport, "single-quoted-import.zs"), []);
  assert.match(compileToC(singleQuotedImport, "single-quoted-import.zs"), /return puts\("single import"\);/);

  const directArgument = `
    function consume(value: String): void {}
    function main(): i32 { consume(\`value=\${42}\`); return 0; }
  `;
  assert.deepEqual(diagnostics(directArgument, "string-argument.zs"), []);
  assert.doesNotThrow(() => compileToC(directArgument, "string-argument.zs"));

  const throwingArgument = `
    enum ParseError { invalid, }
    function parse(in value: String): i32 throws ParseError { return 42; }
    function forward(): i32 throws ParseError { return try parse(\`value=\${42}\`); }
    function main(): i32 { return 0; }
  `;
  assert.deepEqual(diagnostics(throwingArgument, "throwing-string-argument.zs"), []);
  const throwingGenerated = compileToC(throwingArgument, "throwing-string-argument.zs");
  assert.match(throwingGenerated, /const Z_Result_i32_ParseError _z_call_result_\d+ = _z_function_parse/);

  const movedString = `
    import console from "std/console";
    function main(): i32 {
      const first = \`value=42\`;
      const second = first;
      console.log(first);
      return 0;
    }
  `;
  const movedStringDiagnostic = diagnostics(movedString, "moved-string.zs");
  assert.equal(movedStringDiagnostic[0].code, "Z0201");
  assert.match(movedStringDiagnostic[0].message, /use of moved value "first"/);

  const cppSource = `
    import console from "std/console";
    import cpp from "cpp_math.hpp";
    function main(): i32 {
      const point = cpp.zcpp.Point({ x: 20, y: 22 });
      const answer = cpp.sum(point);
      const text = \`cpp=\${answer}\`;
      console.log(text);
      return 0;
    }
  `;
  const cppFile = resolve(projectRoot, "examples/interop/cpp/string-cpp-probe.zs");
  const cppArtifact = compileToNative(cppSource, cppFile);
  assert.equal(cppArtifact.language, "c++");
  const cppCompilation = spawnSync("clang++", [
    "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", resolve(projectRoot, "examples/interop/cpp"),
    "-x", "c++", "-fsyntax-only", "-",
  ], { input: cppArtifact.source, encoding: "utf8" });
  assert.equal(cppCompilation.status, 0, cppCompilation.stderr);

  const cleanupTemporary = `
    import console from "std/console";
    struct Resource { value: i32; deinit {} }
    function make(): Resource { return Resource({ value: 42 }); }
    function main(): i32 {
      console.log(make());
      return 0;
    }
  `;
  const cleanupDiagnostic = diagnostics(cleanupTemporary, "console-temporary.zs");
  assert.equal(cleanupDiagnostic[0].code, "Z0402");
  assert.match(cleanupDiagnostic[0].message, /bind the value to a const or let before logging it/);

  const unknownMethod = `
    import console from "std/console";
    function main(): i32 { console.table(42); return 0; }
  `;
  const methodDiagnostic = diagnostics(unknownMethod, "console-method.zs");
  assert.equal(methodDiagnostic[0].code, "Z0401");
  assert.match(methodDiagnostic[0].message, /use console\.log, console\.write, console\.error, or console\.debug/);
});

test("compares owned String values by their UTF-8 bytes", () => {
  const directory = mkdtempSync("/tmp/z-string-equality-");
  const fileName = resolve(directory, "main.zs");
  const source = `
    function main(): i32 {
      const source: cstring = "same";
      const copied = String.from(source);
      const built = \`sa\${"me"}\`;
      if (copied != built) return 1;
      if (copied == "different") return 2;
      if ("" != "") return 3;
      return 0;
    }
  `;
  writeFileSync(fileName, source);

  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const generated = compileToC(source, fileName);
  assert.match(generated, /static .*bool z_string_equal\(Z_String left, Z_String right\)/);
  assert.match(generated, /!z_string_equal\(copied, built\)/);

  const asyncFile = resolve(directory, "async.zs");
  const asyncSource = `
    async function equal(): boolean {
      const left = "same";
      const right = "same";
      return left == right;
    }
    async function main(): i32 {
      const same = await equal();
      return same ? 0 : 1;
    }
  `;
  writeFileSync(asyncFile, asyncSource);
  const asyncResult = spawnSync(process.execPath, [cli, "run", asyncFile], { encoding: "utf8" });
  assert.equal(asyncResult.status, 0, asyncResult.stderr);
});

test("compares payload-free Z enums by tag", () => {
  const source = `
    enum Direction { north, south, }
    enum Payload { value i32, }
    function main(): i32 {
      const direction = Direction.north;
      return direction == Direction.north && direction != Direction.south ? 0 : 1;
    }
  `;
  const directory = mkdtempSync("/tmp/z-enum-equality-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(compileToC(source, fileName), /direction\)\.tag == .*\.tag/);

  const payloadComparison = source.replace(
    "return direction == Direction.north && direction != Direction.south ? 0 : 1;",
    "return Payload.value(1) == Payload.value(1) ? 0 : 1;",
  );
  assert.match(
    diagnostics(payloadComparison, "payload-enum-equality.zs")[0]?.message ?? "",
    /payload-free enum/,
  );
});

test("exposes console methods and interpolated expressions to editor services", () => {
  const source = `
    import console from "std/console";
    function main(): i32 {
      const answer = 42;
      console.log(\`answer=\${answer}\`);
      return 0;
    }
  `;
  const consoleOffset = source.indexOf("console") + 1;
  assert.match(hover(source, "console-editor.zs", consoleOffset)?.contents.value ?? "", /standard console imported as console/);
  const logOffset = source.indexOf("log") + 1;
  assert.match(hover(source, "console-editor.zs", logOffset)?.contents.value ?? "", /stdout with newline/);
  const items = completions(source.replace("console.log", "console.lo"), "console-editor.zs", source.indexOf("console.log") + "console.lo".length);
  assert.equal(items.find((item) => item.label === "log")?.kind, 2);
  const answerUse = source.lastIndexOf("answer") + 1;
  assert.match(hover(source, "console-editor.zs", answerUse)?.contents.value ?? "", /answer: i32/);

  const aliasSource = source
    .replace("import console from", "import logging from")
    .replaceAll("console.log", "logging.log");
  const aliasUse = aliasSource.indexOf("logging.log") + 1;
  assert.match(hover(aliasSource, "console-alias-editor.zs", aliasUse)?.contents.value ?? "", /standard console imported as logging/);
  const incompleteAlias = aliasSource.replace("logging.log", "logging.lo");
  const incompleteAliasOffset = incompleteAlias.indexOf("logging.lo") + "logging.lo".length;
  assert.equal(completions(incompleteAlias, "console-alias-editor.zs", incompleteAliasOffset).find((item) => item.label === "log")?.kind, 2);
  const symbolSource = `
    import logging from "std/console";
    function main(): i32 { logg; return 0; }
  `;
  const symbolOffset = symbolSource.indexOf("logg;") + 4;
  assert.equal(completions(symbolSource, "console-alias-editor.zs", symbolOffset).find((item) => item.label === "logging")?.kind, 9);
});

test("keeps loop control inside an enclosing loop", () => {
  const outsideBreak = `
    function main(): i32 {
      break;
      return 0;
    }
  `;
  assert.throws(() => compileToC(outsideBreak, "break-outside.zs"), /break requires an enclosing loop/);

  const outsideContinue = outsideBreak.replace("break", "continue");
  assert.throws(() => compileToC(outsideContinue, "continue-outside.zs"), /continue requires an enclosing loop/);

  const unreachable = `
    function main(): i32 {
      while (true) {
        break;
        return 1;
      }
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(unreachable, "loop-unreachable.zs"),
    /unreachable statement after guaranteed loop control transfer/,
  );
});

test("requires boolean while conditions", () => {
  const source = `
    function main(): i32 {
      while (42) { break; }
      return 0;
    }
  `;
  assert.throws(() => compileToC(source, "while-condition.zs"), /expected boolean, found i32/);
});

test("reaches a fixed ownership state across loop iterations", () => {
  const repeatedMove = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): void {}
    function main(): i32 {
      let index = 0;
      const resource = Resource({ id: 1 });
      while (index < 2) {
        consume(resource);
        index = index + 1;
      }
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(repeatedMove, "loop-repeated-move.zs"),
    /resource.*may have been moved|may have been moved.*resource/,
  );

  const maybeMovedAfterBreak = repeatedMove
    .replace("index = index + 1;", "break;")
    .replace("      return 0;", "      consume(resource);\n      return 0;");
  assert.throws(
    () => compileToC(maybeMovedAfterBreak, "loop-break-move.zs"),
    /resource.*may have been moved|may have been moved.*resource/,
  );

  const restored = `
    struct Resource { id: i32; deinit {} }
    function consume(resource: Resource): void {}
    function main(): i32 {
      let index = 0;
      let resource = Resource({ id: 1 });
      while (index < 2) {
        consume(resource);
        resource = Resource({ id: index + 2 });
        index = index + 1;
      }
      consume(resource);
      return 0;
    }
  `;
  assert.match(compileToC(restored, "loop-restored-owner.zs"), /while \(index < 2\)/);
});

test("lowers loop control through match without targeting the generated switch", () => {
  const source = `
    enum Action { skip, stop, }
    function main(): i32 {
      let running = true;
      while (running) {
        match (Action.stop) {
          skip => { continue; }
          stop => { break; }
        }
      }
      return 0;
    }
  `;
  const generated = compileToC(source, "loop-match-control.zs");
  assert.match(generated, /case Z_Action_skip:[\s\S]*goto _z_loop_continue_0;/);
  assert.match(generated, /case Z_Action_stop:[\s\S]*goto _z_loop_break_0;/);
});

test("keeps loop-local bindings visible to editor services", () => {
  const source = `
    function main(): i32 {
      let index = 0;
      while (index < 1) {
        const inside = index;
        ins;
      }
      return 0;
    }
  `;
  const offset = source.indexOf("ins;") + 3;
  const items = completions(source, "loop-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "inside")?.detail, "const inside: i32");
});

test("runs fixed arrays with checked indexing and reverse element cleanup", () => {
  const example = resolve(projectRoot, "examples/language/collections/arrays.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "length=4 sum=112\nmiddle=2\ndrop=3\ndrop=2\ndrop=1\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /if \(index >= length\) abort\(\);/);
  assert.match(generated, /data\[z_bounds_index\(\(uintptr_t\)\(2\), 4\)\]\) = 42/);
  assert.match(generated, /for \(uintptr_t _z_cleanup_index_\d+ = 3;[\s\S]*Z_Item_deinit/);
});

test("checks fixed array types, indices, and mutability", () => {
  const immutable = `
    function main(): i32 {
      const values = [1, 2, 3];
      values[0] = 4;
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(immutable, "array-immutable.zs"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const wrongLength = `
    function main(): i32 {
      const values: i32[3] = [1, 2];
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongLength, "array-length.zs"), /expected i32\[3\], found i32\[2\]/);

  const wrongIndex = `
    function main(): i32 {
      const values = [1, 2];
      return values[1.5];
    }
  `;
  assert.throws(() => compileToC(wrongIndex, "array-index.zs"), /array index must be an integer, found f64/);

  const staticBounds = wrongIndex.replace("1.5", "2");
  assert.throws(
    () => compileToC(staticBounds, "array-static-bounds.zs"),
    /array index 2 is out of bounds for length 2/,
  );

  const empty = `function main(): i32 { const values = []; return 0; }`;
  assert.throws(() => compileToC(empty, "array-empty.zs"), /cannot infer an empty fixed array/);
});

test("supports nested fixed arrays and arrays inside value structs", () => {
  const source = `
    struct Matrix { rows: i32[2][2]; }
    function main(): i32 {
      let matrix = Matrix({ rows: [[1, 2], [3, 4]] });
      matrix.rows[1][0] = 20;
      return matrix.rows[1][0] + matrix.rows[0][1];
    }
  `;
  const generated = compileToC(source, "nested-arrays.zs");
  assert.match(generated, /data\[2\]/);
  assert.match(generated, /struct Z_Matrix/);
  assert.match(generated, /z_bounds_index/);

  const recursive = `
    struct Node { children: Node[1]; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(recursive, "recursive-array-layout.zs"), /recursive value layout/);
});

test("does not move cleanup-bearing elements out of fixed arrays", () => {
  const source = `
    struct Item { value: i32; deinit {} }
    function consume(item: Item): void {}
    function main(): i32 {
      let items = [Item({ value: 1 }), Item({ value: 2 })];
      consume(items[0]);
      return 0;
    }
  `;
  assert.throws(
    () => compileToC(source, "array-element-move.zs"),
    /cannot move an ownership-bearing field or element out of its owner/,
  );
});

test("exposes fixed array length and readable types to editor services", () => {
  const source = `
    function main(): i32 {
      const values = [1, 2, 3];
      values.;
      return 0;
    }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "array-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const valuesDeclaration = valid.indexOf("values =");
  assert.match(hover(valid, "array-editor.zs", valuesDeclaration + 1)?.contents.value ?? "", /values: i32\[3\]/);
});

test("destructures contiguous collections with explicit zero-copy rest views", () => {
  const example = resolve(projectRoot, "examples/language/basics/array-destructuring.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "draft: 1\n");

  const native = spawnSync(
    process.execPath,
    [cli, "check", example, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /native frontend hybrid matches 1 modules/);

  const generated = compileToC(source, example);
  assert.match(generated, /_z_array_destructure_\d+.*\.data = \{ 20, 22 \}/);
  assert.match(generated, /if \(\(\(values\)\.length\) < 1\) abort\(\);/);
  assert.match(generated, /const Z_Slice_\S+ tail = .*\.data = .*?\(\(values\)\.data \+ 1\).*\.length = \(\(values\)\.length\) - 1/);
  assert.match(generated, /const Z_Document \* const current = &\(\(\(documents\)\.data\[0\]\)\)/);

  const headUse = source.indexOf("head +");
  assert.match(hover(source, example, headUse)?.contents.value ?? "", /head: i32/);
  const tailUse = source.indexOf("sum(tail)") + "sum(".length;
  assert.match(hover(source, example, tailUse)?.contents.value ?? "", /tail: Slice<i32>/);
  const currentUse = source.indexOf("current.title");
  const currentHover = hover(source, example, currentUse)?.contents.value ?? "";
  assert.match(currentHover, /current: view Document/);
  assert.match(currentHover, /view of documents/);
  const completionSource = source.replace("sum(tail)", "sum(tai)");
  const completionOffset = completionSource.indexOf("sum(tai)") + "sum(tai".length;
  assert.equal(
    completions(completionSource, example, completionOffset)
      .find((item) => item.label === "tail")?.detail,
    "const tail: Slice<i32>",
  );
  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const tailBindingOffset = source.indexOf("...tail") + 3;
  const tailBindingPosition = positionForOffset(source, tailBindingOffset);
  assert.ok(tokens.some((token) => (
    token.line === tailBindingPosition.line
    && token.character === tailBindingPosition.character
  )));
  const discardOffset = source.indexOf("_, third");
  const discardPosition = positionForOffset(source, discardOffset);
  assert.ok(tokens.some((token) => (
    token.line === discardPosition.line
    && token.character === discardPosition.character
    && token.type === semanticTokenTypes.indexOf("keyword")
  )));

  const noView = `
    function main(): i32 {
      const values = [1, 2, 3];
      const [first, ...remaining] = values;
      return first + i32(remaining.length);
    }
  `;
  const noViewDiagnostic = diagnostics(noView, "array-rest-view.zs")[0];
  assert.equal(noViewDiagnostic.code, "Z0206");
  assert.match(noViewDiagnostic.message, /rest is a borrowed Slice and requires an explicit view/);

  const tooShort = `
    function main(): i32 {
      const values = [1, 2];
      const [first, _, third] = values;
      return first + third;
    }
  `;
  const tooShortDiagnostic = diagnostics(tooShort, "array-destructure-length.zs")[0];
  assert.equal(tooShortDiagnostic.code, "Z0220");
  assert.match(tooShortDiagnostic.message, /requires 3 elements.*length 2/);

  const ownedWithoutView = `
    struct Item { value: i32; deinit {} }
    function main(): i32 {
      const values = [Item({ value: 42 })];
      const [item] = values;
      return item.value;
    }
  `;
  const ownedDiagnostic = diagnostics(ownedWithoutView, "array-destructure-owned.zs")[0];
  assert.equal(ownedDiagnostic.code, "Z0220");
  assert.match(ownedDiagnostic.message, /ownership-bearing Item elements requires an explicit view/);

  const liveMutation = `
    function main(): i32 {
      let values = Array<i32>(1, 2, 3);
      const [first, ...remaining] = view values;
      values.push(4);
      return first + i32(remaining.length);
    }
  `;
  const mutationDiagnostic = diagnostics(liveMutation, "array-rest-live-mutation.zs")[0];
  assert.equal(mutationDiagnostic.code, "Z0205");
  assert.match(mutationDiagnostic.message, /cannot mutate "values" while view "remaining" is live/);
});

test("borrows fixed arrays as read-only and mutable Slice parameters", () => {
  const example = resolve(projectRoot, "examples/language/collections/slices.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "before=10 after=28\n");

  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z_Slice_[\s\S]*int32_t \*data;\n\s+uintptr_t length;/);
  assert.match(generated, /static int32_t _z_function_sum\(Z_Slice_\S+ values\)/);
  assert.match(generated, /sum\(\(Z_Slice_\S+\)\{ \.data = \(void \*\)\(values\)\.data, \.length = 4 \}\)/);
});

test("keeps Slice values non-escaping until lifetime contracts exist", () => {
  const returned = `
    function expose(values: Slice<i32>): Slice<i32> { return values; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(returned, "slice-return.zs"),
    /returning Slice values requires an explicit lifetime contract/,
  );

  const stored = `
    struct Holder { values: Slice<i32>; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(stored, "slice-field.zs"), /Slice values cannot be stored in struct or class fields/);

  const local = `
    function inspect(values: Slice<i32>): i32 {
      const saved = values;
      return saved.length;
    }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(local, "slice-local.zs"), /Slice values cannot be stored in local bindings yet/);
});

test("borrows only stored arrays as Slice arguments in both semantic frontends", () => {
  const accepted = resolve(projectRoot, "tests/fixtures/slice-argument-storage.zs");
  const checked = spawnSync(process.execPath, [cli, "check", accepted, "--native-frontend"], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  const directory = mkdtempSync("/tmp/z-slice-argument-storage-");
  try {
    for (const call of ["total(Array<u8>(2))", "rows([1, 2])", "rows(Array<i32>(1)) + 1"]) {
      const source = `function total(values: Slice<u8>): usize { return values.length; }
        function rows(values: Slice<i32>): usize { return values.length; }
        function main(): i32 { const n = ${call}; return 0; }`;
      assert.throws(() => compileToC(source, "slice-temporary.zs"), /array-to-Slice borrow requires stored array storage/);
      const input = resolve(directory, "main.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${call}\n${native.stderr}`);
      assert.match(native.stderr, /array-to-Slice borrow requires stored array storage/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("borrows checked sub-ranges with values.slice(start, end) in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/slice-range.zs");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const directory = mkdtempSync("/tmp/z-slice-range-");
  try {
    const run = (tier: string, generated: string, optimization: string) => {
      const executable = resolve(directory, tier + optimization);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        encoding: "utf8", input: generated, timeout: 30_000,
      });
      assert.equal(built.status, 0, `${tier}: ${built.stderr}`);
      return spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
    };
    for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const result = run(tier, generated, optimization);
        assert.equal(result.status, 0, `${tier}${optimization}: ${result.stderr}`);
      }
    }
    // start <= end <= length, or a trap; an empty range at the end is valid.
    for (const [bounds, status] of [["1, 5", null], ["2, 1", null], ["3, 3", 0], ["0, 3", 3]] as const) {
      const source = `function total(values: Slice<i32>): usize { return values.length; }
        function main(): i32 { const values = Array<i32>(1, 2, 3); return i32(total(values.slice(${bounds}))); }`;
      const file = resolve(directory, "bounds.zs");
      writeFileSync(file, source);
      const emitted = spawnSync(process.execPath, [cli, "self-host-emit", file], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(emitted.status, 0, emitted.stderr);
      for (const [tier, generated] of [["stage0", compileToC(source, file)], ["native", emitted.stdout]]) {
        const result = run(`bounds-${tier}`, generated, "-O2");
        if (status === null) assert.equal(result.signal, "SIGABRT", `${tier} slice(${bounds})`);
        else assert.equal(result.status, status, `${tier} slice(${bounds})`);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("checks values.slice(start, end) position, storage, bounds types, and call loans", () => {
  const cases: [string, RegExp][] = [
    ["let values = Array<i32>(1, 2); values.append(values.slice(0, 1));", /overlapping inout and in uses of "values"/],
    ["const values = Array<i32>(1, 2); const part = values.slice(0, 1);", /borrows only for one call; pass it directly as a Slice argument/],
    ["const values = Array<i32>(1, 2); const n = count(values.slice(0, 1));", /borrows only for one call/],
    ["const values = Array<i32>(1, 2); const n = total(values.slice(0, 1).slice(0, 1));", /borrows only for one call/],
    ["const values = Array<i32>(1, 2); const n = total(values.slice(0));", /slice.* expects 2 argument/],
    ["const values = Array<i32>(1, 2); const n = total(values.slice(-1, 1));", /integer literal -1 does not fit usize/],
    ["const values = Array<i32>(1, 2); const n = total(values.slice(true, 1));", /expected usize, found boolean/],
    ["const n = total(Array<i32>(1).slice(0, 1));", /requires stored array or Slice storage/],
    ["const values = Array<u8>(1, 2); const n = total(values.slice(0, 1));", /expected Slice<i32>, found Slice<u8>/],
  ];
  const directory = mkdtempSync("/tmp/z-slice-range-invalid-");
  try {
    const prefix = `function total(values: Slice<i32>): usize { return values.length; }
      function count(values: Array<i32>): usize { return values.length; }`;
    for (const [body, message] of cases) {
      const source = `${prefix} function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "slice-range-invalid.zs"), message);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8", timeout: 120_000 });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, message);
    }
    const asynchronous = `${prefix} async function later(values: Array<i32>): usize { return total(values.slice(0, 1)); }
      function main(): i32 { return 0; }`;
    assert.throws(() => compileToC(asynchronous, "slice-range-async.zs"), /Z0700.*not yet available in async functions|not yet available in async functions/);
    const input = resolve(directory, "async.zs");
    writeFileSync(input, asynchronous);
    const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8", timeout: 120_000 });
    assert.equal(native.status, 1, native.stderr);
    assert.match(native.stderr, /not yet available in async functions/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("surfaces values.slice(start, end) in hover and completion", () => {
  for (const declaration of ["const values = Array<u8>(1);", "const values: u8[2] = [1, 2];"]) {
    const source = `function total(values: Slice<u8>): usize { return values.length; }
      function main(): i32 { ${declaration} const n = total(values.slice(0, 1)); return 0; }`;
    const offset = source.lastIndexOf("slice(");
    assert.match(hover(source, "slice-range-hover.zs", offset)?.contents.value ?? "", /slice\(start: usize, end: usize\): Slice</);
    assert.ok(completions(source, "slice-range-hover.zs", offset + "slice".length).some((entry) => entry.label === "slice"));
    // Completing right after the dot, where the source does not parse yet.
    const partial = `function main(): i32 { ${declaration} const n = values.; return 0; }`;
    const labels = completions(partial, "slice-range-partial.zs", partial.indexOf(".;") + 1).map((entry) => entry.label);
    assert.ok(labels.includes("length") && labels.includes("slice"), `${declaration}: ${labels.join(",")}`);
    assert.ok(!labels.includes("wrappingAdd"), declaration);
  }
});

test("call loans keep the field path before an element index in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/call-loan-paths.zs");
  const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  const directory = mkdtempSync("/tmp/z-call-loan-paths-");
  try {
    for (const [tier, generated] of [["stage0", compileToC(readFileSync(input, "utf8"), input)], ["native", native.stdout]]) {
      const executable = resolve(directory, tier);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        encoding: "utf8", input: generated, timeout: 30_000,
      });
      assert.equal(built.status, 0, `${tier}: ${built.stderr}`);
      assert.equal(spawnSync(executable, [], { encoding: "utf8" }).status, 0, tier);
    }
    // Elements of one collection still overlap, and so does self-append.
    for (const [body, path] of [
      ["this.strings[first].append(this.strings[second].slice(0, 1));", "this\\.strings"],
      ["this.small.append(this.small.slice(0, 1));", "this\\.small"],
    ] as const) {
      const source = `struct Heap {
        strings: Array<Array<u8>>;
        small: Array<u8>;
        function probe(inout this, first: usize, second: usize): void { ${body} }
      }
      function main(): i32 { return 0; }`;
      const message = new RegExp(`overlapping inout and in uses of "${path}" in one call are not allowed`);
      assert.throws(() => compileToC(source, "call-loan-overlap.zs"), message);
      const file = resolve(directory, "overlap.zs");
      writeFileSync(file, source);
      const resolved = spawnSync(process.execPath, [cli, "self-host-resolve", file], { encoding: "utf8", timeout: 120_000 });
      assert.equal(resolved.status, 1, `${body}\n${resolved.stderr}`);
      assert.match(resolved.stderr, message);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("a by-value copy takes no call loan in both compilers and async frames", () => {
  const directory = mkdtempSync("/tmp/z-call-copy-loans-");
  try {
    for (const name of ["call-copy-loans", "call-copy-loans-async"]) {
      const input = resolve(projectRoot, `tests/fixtures/${name}.zs`);
      const stage0 = compileToC(readFileSync(input, "utf8"), input);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(directory, `${name}-${tier}${optimization}`);
          const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization,
            "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
            encoding: "utf8", input: generated, timeout: 30_000,
          });
          assert.equal(built.status, 0, `${name} ${tier}${optimization}: ${built.stderr}`);
          const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
          assert.equal(run.status, 0, `${name} ${tier}${optimization}: ${run.stderr}`);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("a value that moves, shares ARC identity, or is borrowed keeps its call loan in both compilers", () => {
  const declarations = `import { Map, Set } from "std/collections";
    struct Box { items: Array<u32>; names: Array<String>; title: String;
      function rename(inout this, title: String): void { this.title = title; }
    }
    struct Resource { value: i32; function merge(inout this, other: Resource): void {} deinit {} }
    struct Wrap<T> { item: T; }
    class Node { children: Array<Node>; weight: u32;
      function adopt(inout this, child: Node): void { this.children.push(child); }
    }
    function take(title: String, inout box: Box): void { box.title = title; }
    function mix<T>(inout target: Wrap<T>, value: T): void { target.item = value; }
    function keep<T>(inout slot: T, value: T): void { slot = value; }`;
  const box = `let box = Box({ items: Array<u32>(7), names: Array<String>(), title: "t" });`;
  const node = `let node = new Node({ children: Array<Node>(), weight: 1 });`;
  const cases: [string, RegExp][] = [
    [`let resource = Resource({ value: 1 }); resource.merge(resource);`, /overlapping inout and value uses of "resource" in one call are not allowed/],
    [`let resource = Resource({ value: 1 }); keep(inout resource, resource);`, /overlapping inout and value uses of "resource" in one call are not allowed/],
    [`${box} box.rename(box.title);`, /overlapping inout and value uses of "box" and "box\.title" in one call are not allowed/],
    [`${box} take(box.title, inout box);`, /overlapping value and inout uses of "box\.title" and "box" in one call are not allowed/],
    [`let wrap = Wrap<String>({ item: "a" }); mix(inout wrap, wrap.item);`, /overlapping inout and value uses of "wrap" and "wrap\.item" in one call are not allowed/],
    [`${node} node.adopt(node);`, /overlapping inout and value uses of "node" in one call are not allowed/],
    [`${node} const alias = node; node.adopt(alias);`, /overlapping inout and value uses of ARC aliases "node" and "alias" in one call are not allowed/],
    [`${node} node.children.push(node);`, /overlapping inout and value uses of "node\.children" and "node" in one call are not allowed/],
    [`${node} const alias = node; node.children.push(alias);`, /overlapping inout and value uses of ARC aliases "node" and "alias" in one call are not allowed/],
    [`let names = Array<String>("a"); names.push(names[0]);`, /overlapping inout and value uses of "names" in one call are not allowed/],
    [`let lists = Array<Array<u32>>(); lists.push(lists);`, /overlapping inout and value uses of "lists" in one call are not allowed/],
    [`let map = Map<usize, u32>(); map.delete(map.length);`, /overlapping inout and in uses of "map" and "map\.length" in one call are not allowed/],
    [`let seen = Set<usize>(); seen.remove(seen.length);`, /overlapping inout and in uses of "seen" and "seen\.length" in one call are not allowed/],
  ];
  const directory = mkdtempSync("/tmp/z-call-move-loans-");
  try {
    for (const [body, message] of cases) {
      const source = `${declarations}\nfunction main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "call-move-loans.zs"), message, body);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, message, body);
    }
    // An explicit copy of a moving value is an expression of its own, not a
    // use of the storage, and a sibling field never overlapped.
    for (const body of [
      `let names = Array<String>("a"); names.push(copy names[0]);`,
      `${box} box.items.push(box.items[0]); box.names.push(copy box.title);`,
      `${node} let other = new Node({ children: Array<Node>(), weight: 2 }); node.children.push(other); node.adopt(new Node({ children: Array<Node>(), weight: node.weight }));`,
    ]) {
      const source = `${declarations}\nfunction main(): i32 { ${body} return 0; }`;
      compileToC(source, "call-move-loans-valid.zs");
      const input = resolve(directory, "valid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 0, `${body}\n${native.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("accesses elements with an asserted bound inside unsafe in both compilers", () => {
  const input = resolve(projectRoot, "tests/fixtures/unchecked-access.zs");
  const stage0 = compileToC(readFileSync(input, "utf8"), input);
  assert.match(stage0, /#ifdef NDEBUG[\s\S]*z_unchecked_index/);
  const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
    encoding: "utf8", timeout: 120_000,
  });
  assert.equal(checked.status, 0, checked.stderr);
  const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(native.status, 0, native.stderr);
  assert.match(native.stdout, /_at_mut_assumed\(/);
  const directory = mkdtempSync("/tmp/z-unchecked-access-");
  try {
    const build = (name: string, generated: string, flags: readonly string[]) => {
      const executable = resolve(directory, name);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", ...flags, "-Wall", "-Wextra", "-Werror",
        "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
        encoding: "utf8", input: generated, timeout: 30_000,
      });
      assert.equal(built.status, 0, `${name}: ${built.stderr}`);
      return spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
    };
    for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const [mode, flags] of [["debug", ["-O0"]], ["release", ["-O2", "-DNDEBUG"]]] as const) {
        const run = build(`${tier}-${mode}`, generated, flags);
        assert.equal(run.status, 0, `${tier} ${mode}: ${run.stderr}`);
      }
    }
    // A debug build still checks the asserted bound.
    const outOfRange = `function main(): i32 {
      const values = Array<i32>(1, 2);
      const item = unsafe { select values.uncheckedAt(5); };
      return item;
    }`;
    const file = resolve(directory, "out-of-range.zs");
    writeFileSync(file, outOfRange);
    const emitted = spawnSync(process.execPath, [cli, "self-host-emit", file], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(emitted.status, 0, emitted.stderr);
    for (const [tier, generated] of [["stage0", compileToC(outOfRange, file)], ["native", emitted.stdout]]) {
      assert.equal(build(`trap-${tier}`, generated, ["-O0"]).signal, "SIGABRT", tier);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("checks unchecked element access for unsafe, element types, storage, and arguments", () => {
  const cases: [string, RegExp][] = [
    ["const values = Array<i32>(1); const item = values.uncheckedAt(0);", /uncheckedAt skips the bounds check and requires an unsafe block/],
    ["const names = Array<String>(\"a\"); const item = unsafe { select names.uncheckedAt(0); };", /requires a cleanup-free element type, found String/],
    ["const item = unsafe { select Array<i32>(1).uncheckedAt(0); };", /requires stored array or Slice storage/],
    ["let values = Array<i32>(1); const frozen = values.freeze(); unsafe { frozen.uncheckedSet(0, 2); }", /readonly (Array|collection) has no mutating method "uncheckedSet"/],
    ["const values = Array<i32>(1); unsafe { values.uncheckedSet(0, 2); }", /uncheckedSet"? requires addressable let storage/],
    ["let values = Array<i32>(1); const item = unsafe { select values.uncheckedAt(true); };", /expected usize, found boolean/],
    ["let values = Array<i32>(1); unsafe { values.uncheckedSet(0, true); }", /expected i32, found boolean/],
    ["let values = Array<i32>(1); const item = unsafe { select values.uncheckedAt(0, 1); };", /uncheckedAt"? expects 1 argument/],
  ];
  const directory = mkdtempSync("/tmp/z-unchecked-access-invalid-");
  try {
    for (const [body, message] of cases) {
      const source = `function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "unchecked-access-invalid.zs"), message);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8", timeout: 120_000 });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, message);
    }
    const slice = `function touch(values: Slice<i32>): void { unsafe { values.uncheckedSet(0, 1); } }
      function main(): i32 { return 0; }`;
    assert.throws(() => compileToC(slice, "unchecked-slice-set.zs"), /uncheckedSet requires Array or fixed-array storage/);
    const viewed = `function inspect(in value: i32): i32 { return value; }
      function main(): i32 {
        let values = Array<i32>(1, 2);
        const first = view values[0];
        unsafe { values.uncheckedSet(1, 3); }
        const seen = inspect(first);
        return 0;
      }`;
    assert.throws(() => compileToC(viewed, "unchecked-view.zs"), /cannot mutate "values" while view "first" is live/);
    const viewedInput = resolve(directory, "viewed.zs");
    writeFileSync(viewedInput, viewed);
    const viewedNative = spawnSync(process.execPath, [cli, "self-host-resolve", viewedInput], { encoding: "utf8", timeout: 120_000 });
    assert.equal(viewedNative.status, 1, viewedNative.stderr);
    assert.match(viewedNative.stderr, /cannot mutate "values" while view "first" is live/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("surfaces unchecked element access in hover and completion", () => {
  const source = "function main(): i32 { let values = Array<u8>(1); const item = unsafe { select values.uncheckedAt(0); }; return 0; }";
  const offset = source.indexOf("uncheckedAt");
  assert.match(hover(source, "unchecked-hover.zs", offset)?.contents.value ?? "", /uncheckedAt\(index: usize\): u8[\s\S]*debug build/);
  assert.ok(completions(source, "unchecked-hover.zs", offset + "uncheckedAt".length).some((entry) => entry.label === "uncheckedAt"));
});

test("checks Slice capabilities, element types, and overlapping borrows", () => {
  const readOnlyMutation = `
    function mutate(values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(readOnlyMutation, "slice-readonly.zs"),
    /cannot mutate an indexed element through immutable binding "values"/,
  );

  const redundantIn = `
    function inspect(in values: Slice<i32>): i32 { return values.length; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(redundantIn, "slice-in.zs"), /Slice parameters are already borrowed; omit `in`/);

  const immutableMutation = `
    function fill(inout values: Slice<i32>): void { values[0] = 1; }
    function main(): i32 {
      const values = [1, 2];
      fill(inout values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutableMutation, "slice-const.zs"), /requires a mutable let binding/);

  const wrongElement = `
    function sum(values: Slice<u32>): u32 { return values[0]; }
    function main(): i32 {
      const values = [1, 2];
      sum(values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "slice-element.zs"), /expected Slice<u32>, found i32\[2\]/);

  const overlap = `
    function mix(inout target: Slice<i32>, source: Slice<i32>): void {}
    function main(): i32 {
      let values = [1, 2];
      mix(inout values, values);
      return 0;
    }
  `;
  assert.throws(() => compileToC(overlap, "slice-overlap.zs"), /overlapping inout and in uses of "values"/);
});

test("exposes Slice length and generic spelling to editor services", () => {
  const source = `
    function inspect(values: Slice<i32>): i32 {
      values.;
      return 0;
    }
    function main(): i32 { return 0; }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  assert.equal(completions(source, "slice-editor.zs", offset).find((item) => item.label === "length")?.detail, "usize");

  const valid = source.replace("      values.;\n", "      const count = values.length;\n");
  const declaration = valid.indexOf("values:");
  assert.match(hover(valid, "slice-editor.zs", declaration + 1)?.contents.value ?? "", /values: Slice<i32>/);
});

test("monomorphizes generic structs and functions", () => {
  const example = resolve(projectRoot, "examples/language/types/generics.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "generic=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z___z_mono_Pair_i32/);
  assert.match(generated, /__z_mono_first_i32/);
  assert.doesNotMatch(generated, /\bT\b/);
});

test("creates distinct generic instances and preserves ownership semantics", () => {
  const distinct = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const number = identity<i32>(42);
      const flag = identity<boolean>(true);
      if (flag) { return number; }
      return 0;
    }
  `;
  const generated = compileToC(distinct, "generic-distinct.zs");
  assert.match(generated, /__z_mono_identity_i32/);
  assert.match(generated, /__z_mono_identity_boolean/);

  const moved = `
    struct Resource { id: i32; deinit {} }
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const resource = Resource({ id: 1 });
      const other = identity(resource);
      return resource.id + other.id;
    }
  `;
  assert.throws(() => compileToC(moved, "generic-move.zs"), /use of moved value "resource"/);
});

test("infers generic calls while preserving explicit instantiation", () => {
  const wrongArity = `
    struct Pair<T, U> { first: T; second: U; }
    function main(): i32 { const pair = Pair<i32>({ first: 1, second: 2 }); return 0; }
  `;
  assert.throws(() => compileToC(wrongArity, "generic-arity.zs"), /Pair expects 2 type argument\(s\), received 1/);

  const implicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(42); }
  `;
  assert.match(compileToC(implicit, "generic-inferred.zs"), /__z_mono_identity_i32\(42\)/);

  const explicit = `
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity<i32>(42); }
  `;
  assert.match(compileToC(explicit, "generic-explicit.zs"), /__z_mono_identity_i32\(42\)/);

  const contextualReturn = `
    function make<T>(): T { return 1; }
    function main(): i32 { return make(); }
  `;
  assert.match(compileToC(contextualReturn, "generic-contextual-return.zs"), /__z_mono_make_i32/);

  const contextualBinding = `
    function make<T>(): T { return 1; }
    function main(): i32 { const value: i64 = make(); return 0; }
  `;
  assert.match(compileToC(contextualBinding, "generic-contextual-binding.zs"), /__z_mono_make_i64/);

  const ambiguous = `
    function make<T>(): T { return 1; }
    function main(): i32 { const value = make(); return 0; }
  `;
  assert.throws(() => compileToC(ambiguous, "generic-ambiguous.zs"), /cannot infer type parameter "T" for "make"/);

  const conflicting = `
    function choose<T>(left: T, right: T): T { return left; }
    function main(): i32 { return choose(1, true); }
  `;
  assert.throws(() => compileToC(conflicting, "generic-conflict.zs"), /expected i32, found boolean/);

  const duplicate = `
    struct Invalid<T, T> { value: T; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(duplicate, "generic-duplicate.zs"), /duplicate type parameter "T"/);
});

test("infers generic results from annotations, assignments, and returns", () => {
  const source = `
    trait Measured { function measure(): i32; }
    struct Reading implements Measured { function measure(): i32 { return 42; } }
    function absent<T>(): Option<T> { return Option<T>.none; }
    function preserve<T>(value: T): T { return value; }
    function choose<T>(left: T, right: T): T { return left; }
    function constrained<T: Measured>(): Option<T> { return Option<T>.none; }
    struct Factory {
      static function preserve<T>(value: T): T { return value; }
      function preserveInstance<T>(value: T): T { return value; }
    }
    struct Bundle<T> { value: T; }
    struct Wrapper<T> {
      value: T;
      static function wrap(value: T): Wrapper<T> { return Wrapper({ value }); }
    }
    class Envelope<T> {
      value: T;
      constructor(value: T) { this.value = value; }
    }
    struct Utility {
      static function absent<T>(): Option<T> { return Option<T>.none; }
    }
    function returned(): Option<i32> { return absent(); }
    function main(): i32 {
      const local: Option<i64> = absent();
      let assigned: Option<i32> = Option<i32>.none;
      assigned = absent();
      const method: Option<i16> = Utility.absent();
      const checked: Option<Reading> = constrained();
      const nested: Option<i32> = preserve(absent());
      const conditional: Option<i32> = true ? absent() : absent();
      const sequential = choose(Option<i32>.none, absent());
      const branch: Option<i32> = if (true) { select absent(); } else { select absent(); };
      const matched: Option<i32> = match (Option<boolean>.none) {
        some(value) => absent();
        none => absent();
      };
      const factory = Factory({});
      const staticNested: Option<i32> = Factory.preserve(absent());
      const instanceNested: Option<i32> = factory.preserveInstance(absent());
      const inferredEnvelope: Envelope<Option<i32>> = new Envelope(absent());
      const explicitEnvelope = new Envelope<Option<i32>>(absent());
      const inferredBundle: Bundle<Option<i32>> = Bundle({ value: absent() });
      const explicitBundle = Bundle<Option<i32>>({ value: absent() });
      const inferredWrapper: Wrapper<Option<i32>> = Wrapper.wrap(absent());
      const explicitWrapper = Wrapper.wrap<Option<i32>>(absent());
      return 0;
    }
  `;
  const generated = compileToC(source, "generic-result-context.zs");
  assert.match(generated, /__z_mono_absent_i64/);
  assert.match(generated, /__z_mono_absent_i32/);
  assert.match(generated, /Z_Utility___z_mono_absent_i16/);
  assert.match(generated, /__z_mono_constrained_Reading/);

  const directory = mkdtempSync("/tmp/z-native-generic-result-context-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8" });
  assert.equal(native.status, 0, native.stderr);
  const hybrid = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], { encoding: "utf8" });
  assert.equal(hybrid.status, 0, hybrid.stderr);
  assert.match(hybrid.stdout, /native frontend hybrid exports 29 resolved call contracts/);
  assert.match(hybrid.stdout, /native frontend hybrid uses 22 function, 5 method, and 2 constructor native-authoritative contracts/);

  const invalid = source.replace("Option<Reading> = constrained()", "Option<i32> = constrained()");
  writeFileSync(input, invalid);
  const nativeConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", input], { encoding: "utf8" });
  assert.equal(nativeConstraint.status, 1);
  assert.match(nativeConstraint.stderr, /i32 does not satisfy Measured for T in "constrained"/);
});

test("keeps distinct receiver evidence for each generic method specialization", () => {
  const source = `
    trait Readable { function read(): i32; }
    readonly class First implements Readable {
      value: i32;
      function read(): i32 { return this.value + 1; }
    }
    readonly class Second implements Readable {
      value: i32;
      function read(): i32 { return this.value * 2; }
    }
    struct Reader {
      function read<T: Readable>(value: T): i32 { return value.read(); }
      static function inspect<T: Readable>(value: T): i32 { return value.read(); }
    }
    struct GenericReader<U> {
      marker: U;
      function read<T: Readable>(value: T): i32 { return value.read(); }
    }
    function main(): i32 {
      const reader = Reader();
      const generic = GenericReader({ marker: 0 });
      const first = new First({ value: 19 });
      const second = new Second({ value: 11 });
      return reader.read(first) + reader.read(second)
        + Reader.inspect(first) + Reader.inspect(second)
        + generic.read(first) + generic.read(second) - 126;
    }
  `;
  const directory = mkdtempSync("/tmp/z-generic-method-evidence-");
  try {
    const entry = resolve(directory, "main.zs");
    writeFileSync(entry, source);
    const result = spawnSync(process.execPath, [cli, "run", entry], {
      encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("specializes separately generic instance and static methods", () => {
  const source = `
    struct Utility {
      static function preserve<T>(value: T): T { return value; }
    }
    struct Record {
      value: i32;
      function choose<T>(left: T, right: T): T {
        if (this.value > 0 && left == right) return left;
        return right;
      }
    }
    struct Holder<T> {
      value: T;
      function replace<U>(candidate: U): U {
        if (this.value > 0) return candidate;
        return candidate;
      }
    }
    function main(): i32 {
      const record = Record({ value: 1 });
      const holder = Holder({ value: 20 });
      const inferred = record.choose(20, 22);
      const explicit = record.choose<i32>(20, 22);
      return Utility.preserve(inferred) + Utility.preserve<i32>(explicit) + holder.replace(2) - 42;
    }
  `;
  const generated = compileToC(source, "generic-methods.zs");
  assert.match(generated, /Z_Utility___z_mono_preserve_i32/);
  assert.match(generated, /Z_Record___z_mono_choose_i32/);
  assert.match(generated, /Z___z_mono_Holder_i32___z_mono_replace_i32/);
  assert.doesNotMatch(generated, /\bfunction preserve<T>|\bfunction choose<T>|\bfunction replace<U>/);
  assert.deepEqual(diagnostics(source, "generic-methods.zs"), []);
  const chooseOffset = source.indexOf("record.choose") + "record.".length + 1;
  assert.match(hover(source, "generic-methods.zs", chooseOffset)?.contents.value ?? "", /function choose<T>\(left: T, right: T\): T/);
  const completionSource = source.replace("record.choose(20, 22)", "record.ch");
  const completionOffset = completionSource.indexOf("record.ch") + "record.ch".length;
  const chooseCompletions = completions(completionSource, "generic-methods.zs", completionOffset)
    .filter((item) => item.label === "choose");
  assert.equal(chooseCompletions.length, 1);
  const chooseCompletion = chooseCompletions[0];
  assert.match(chooseCompletion.detail ?? "", /function choose<T>\(left: T, right: T\): T/);

  const conflict = source.replace("record.choose(20, 22)", "record.choose(20, true)");
  assert.throws(
    () => compileToC(conflict, "generic-method-conflict.zs"),
    /conflicting inferred types for T.*i32 and boolean/,
  );

  const ambiguous = `
    struct Utility { static function make<T>(): T { return 1; } }
    function main(): i32 { const value = Utility.make(); return 0; }
  `;
  assert.throws(
    () => compileToC(ambiguous, "generic-method-ambiguous.zs"),
    /cannot infer type parameter "T" for "Utility\.make"/,
  );

  const wrongArity = source.replace("record.choose<i32>(20, 22)", "record.choose<i32, boolean>(20, 22)");
  assert.throws(
    () => compileToC(wrongArity, "generic-method-arity.zs"),
    /Record\.choose expects 1 type argument\(s\), received 2/,
  );

  const twoLevelStatic = `
    struct Owner<T> {
      static function preserve<U>(candidate: U): U { return candidate; }
    }
    function main(): i32 { return Owner.preserve(42); }
  `;
  assert.throws(
    () => compileToC(twoLevelStatic, "generic-static-two-level.zs"),
    /static method "Owner\.preserve" has independent owner and method type parameters/,
  );
});

test("infers generic aggregate construction, class construction, and static factories", () => {
  const source = `
    struct Pair<T> {
      first: T;
      second: T;
    }
    class Envelope<T> {
      private value: T;
      constructor(value: T) { this.value = value; }
      function get(): T { return this.value; }
    }
    class Holder<T> { value: T; }
    struct Container<T> {
      value: T;
      static function wrap(value: T): Container<T> {
        return Container({ value });
      }
    }
    class Shelf<T> {
      private content: Container<T>;
      constructor(value: T) { this.content = Container.wrap(value); }
      function get(): T { return this.content.value; }
    }
    struct Marker<T> {
      tag: i32;
      static function create(): Marker<T> { return Marker<T>({ tag: 0 }); }
    }
    function makeMarker(): Marker<i32> { return Marker.create(); }
    function main(): i32 {
      const pair = Pair({ first: 20, second: 22 });
      const envelope = new Envelope(42);
      const holder = new Holder({ value: 42 });
      const wrapped = Container.wrap(42);
      const explicit = Container.wrap<i32>(42);
      const shelf = new Shelf(42);
      const marker: Marker<i32> = Marker.create();
      return pair.first + pair.second + envelope.get() + holder.value
        + wrapped.value + explicit.value + shelf.get() + marker.tag + makeMarker().tag - 252;
    }
  `;
  const generated = compileToC(source, "aggregate-inference.zs");
  assert.match(generated, /Z___z_mono_Pair_i32/);
  assert.match(generated, /Z___z_mono_Envelope_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Holder_i32_new\(int32_t _z_init_value\)/);
  assert.match(generated, /Z___z_mono_Container_i32_wrap\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Shelf_i32_new\(int32_t value\)/);
  assert.match(generated, /Z___z_mono_Marker_i32_create\(void\)/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("pair =") + 1)?.contents.value ?? "", /pair: Pair<i32>/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("envelope =") + 1)?.contents.value ?? "", /envelope: Envelope<i32>/);
  assert.match(hover(source, "aggregate-inference.zs", source.indexOf("wrapped =") + 1)?.contents.value ?? "", /wrapped: Container<i32>/);

  const contextualWidth = `
    struct Pair<T> { first: T; second: T; }
    function wide(): i64 {
      const pair: Pair<i64> = Pair({ first: 20, second: 22 });
      return pair.first + pair.second;
    }
    function main(): i32 { return 0; }
  `;
  assert.match(compileToC(contextualWidth, "aggregate-expected-type.zs"), /struct Z___z_mono_Pair_i64 \{[\s\S]*int64_t first/);

  const conflict = `
    struct Pair<T> { first: T; second: T; }
    function main(): i32 { const pair = Pair({ first: 1, second: true }); return 0; }
  `;
  assert.throws(() => compileToC(conflict, "aggregate-inference-conflict.zs"), /conflicting inferred types for T.*i32 and boolean/);

  const ambiguous = `
    struct Marker<T> { tag: i32; static function create(): Marker<T> { return Marker<T>({ tag: 0 }); } }
    function main(): i32 { const marker = Marker.create(); return marker.tag; }
  `;
  assert.throws(() => compileToC(ambiguous, "static-inference-ambiguous.zs"), /cannot infer type parameter "T" for "Marker\.create"/);

  const wrongStaticArity = source.replace("Container.wrap<i32>(42)", "Container.wrap<i32, boolean>(42)");
  assert.throws(() => compileToC(wrongStaticArity, "static-inference-arity.zs"), /expects 1 type argument\(s\), received 2/);

  const oldStaticShape = source.replace("Container.wrap<i32>(42)", "Container<i32>.wrap(42)");
  assert.throws(() => compileToC(oldStaticShape, "static-owner-specialization.zs"), /static generic arguments follow the method name/);
});

test("infers nested generic calls and calls within generic functions", () => {
  const source = `
    struct Envelope<T> { value: T; }
    function identity<T>(value: T): T { return value; }
    function unwrap<T>(envelope: Envelope<T>): T { return identity(envelope.value); }
    function main(): i32 {
      const envelope = Envelope({ value: 42 });
      return identity(unwrap(envelope));
    }
  `;
  const generated = compileToC(source, "generic-nested-inference.zs");
  assert.match(generated, /__z_mono_unwrap_i32/);
  assert.match(generated, /__z_mono_identity_i32/);
});

test("infers generic Slice element types from fixed arrays", () => {
  const source = `
    function firstItem<T>(values: Slice<T>): T { return values[0]; }
    function main(): i32 {
      const values = [42, 43];
      return firstItem(values);
    }
  `;
  const generated = compileToC(source, "generic-slice-inference.zs");
  assert.match(generated, /__z_mono_firstItem_i32/);
  assert.match(generated, /\.length = 2/);
});

test("infers generic arguments from imported C results", () => {
  const source = `
    import stdio from "stdio.h";
    function identity<T>(value: T): T { return value; }
    function main(): i32 { return identity(stdio.getchar()); }
  `;
  const generated = compileToC(source, "generic-c-inference.zs");
  assert.match(generated, /__z_mono_identity_i32\(getchar\(\)\)/);
});

test("checks nominal trait constraints on inferred and explicit generic instances", () => {
  const example = resolve(projectRoot, "examples/language/types/generic-constraints.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "measured=42\n");

  const structuralOnly = `
    trait Measured { function measure(): i32; }
    struct Reading { function measure(): i32 { return 42; } }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { return read(Reading({})); }
  `;
  assert.throws(
    () => compileToC(structuralOnly, "generic-constraint-nominal.zs"),
    /Reading does not satisfy Measured for T in "read"/,
  );

  const primitive = `
    trait Measured { function measure(): i32; }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { return read<i32>(42); }
  `;
  assert.throws(
    () => compileToC(primitive, "generic-constraint-primitive.zs"),
    /i32 does not satisfy Measured for T in "read"/,
  );

  const unknown = `
    function read<T: Missing>(value: T): T { return value; }
    function main(): i32 { return 0; }
  `;
  assert.throws(() => compileToC(unknown, "generic-constraint-unknown.zs"), /unknown trait constraint "Missing"/);

  const outsideSurface = `
    trait Measured { function measure(): i32; }
    function reveal<T: Measured>(value: T): i32 { return value.secret(); }
    function main(): i32 { return 0; }
  `;
  assert.throws(
    () => compileToC(outsideSurface, "generic-constraint-surface.zs"),
    /member "secret" is not provided by the trait constraints on T/,
  );

  const directory = mkdtempSync("/tmp/z-native-generic-constraints-");
  const model = resolve(directory, "model.zs");
  const main = resolve(directory, "main.zs");
  writeFileSync(model, `
    export trait Measured { function measure(): i32; }
    export trait Named { function name(): cstring; }
    export struct Reading implements Measured, Named {
      function measure(): i32 { return 42; }
      function name(): cstring { return "reading"; }
    }
    export struct Plain { function measure(): i32 { return 42; } }
    export struct Holder<T: Measured> { value: T; }
    export class Owner<T: Measured> { value: T; }
    export struct Utility {
      static function inspect<T: Measured>(value: T): i32 { return value.measure(); }
    }
    export function read<T: Measured>(value: T): i32 { return value.measure(); }
    export function own<T: Measured>(value: T): Owner<T> {
      return new Owner<T>({ value });
    }
    export function readBoth<T: Measured & Named>(value: T): i32 {
      const label = value.name();
      return value.measure();
    }
  `);
  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 {
      const owner = model.own(model.Reading({}));
      return model.readBoth(owner.value);
    }
  `);
  const nativeValid = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeValid.status, 0, nativeValid.stderr);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.read(model.Plain({})); }
  `);
  const nativeStructuralOnly = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeStructuralOnly.status, 1);
  assert.match(nativeStructuralOnly.stderr, /Plain does not satisfy model\.Measured for T in "read"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.read<i32>(42); }
  `);
  const nativePrimitive = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativePrimitive.status, 1);
  assert.match(nativePrimitive.stderr, /i32 does not satisfy model\.Measured for T in "read"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 { return model.Utility.inspect(model.Plain({})); }
  `);
  const nativeMethodConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeMethodConstraint.status, 1);
  assert.match(nativeMethodConstraint.stderr, /Plain does not satisfy model\.Measured for T in "Utility\.inspect"/);

  writeFileSync(main, `
    import model from "./model.zs";
    function main(): i32 {
      const holder = model.Holder({ value: model.Plain({}) });
      return 0;
    }
  `);
  const nativeAggregateConstraint = spawnSync(process.execPath, [cli, "self-host-resolve", main], { encoding: "utf8" });
  assert.equal(nativeAggregateConstraint.status, 1);
  assert.match(nativeAggregateConstraint.stderr, /Plain does not satisfy model\.Measured for T in "Holder"/);

  const invalidBody = resolve(directory, "invalid-body.zs");
  writeFileSync(invalidBody, `
    trait Measured { function measure(): i32; }
    function reveal<T: Measured>(value: T): i32 { return value.secret(); }
    function main(): i32 { return 0; }
  `);
  const nativeOutsideSurface = spawnSync(process.execPath, [cli, "self-host-resolve", invalidBody], { encoding: "utf8" });
  assert.equal(nativeOutsideSurface.status, 1);
  assert.match(
    nativeOutsideSurface.stderr,
    /member "secret" is not provided by the trait constraints on T/,
  );

  const typeUse = resolve(directory, "type-use.zs");
  writeFileSync(typeUse, `
    import { Measured, Holder, Reading } from "./model.zs";
    function retain<T: Measured>(value: Holder<T>): i32 { return 1; }
    function inspect(value: Option<Holder<Reading>>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeValidTypeUse = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeValidTypeUse.status, 0, nativeValidTypeUse.stderr);

  writeFileSync(typeUse, `
    import { Holder, Plain } from "./model.zs";
    function inspect(value: Option<Holder<Plain>>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidTypeUse = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidTypeUse.status, 1);
  assert.match(
    nativeInvalidTypeUse.stderr,
    /Plain does not satisfy Measured for T in "Holder"/,
  );

  writeFileSync(typeUse, `
    import { Holder } from "./model.zs";
    function inspect(value: Holder<i32, i32>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidTypeArity = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidTypeArity.status, 1);
  assert.match(nativeInvalidTypeArity.stderr, /Holder expects 1 type argument\(s\), received 2/);

  writeFileSync(typeUse, `
    import { Holder } from "./model.zs";
    function inspect(value: Holder): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeMissingTypeArgument = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeMissingTypeArgument.status, 1);
  assert.match(nativeMissingTypeArgument.stderr, /Holder expects 1 type argument\(s\), received 0/);

  writeFileSync(typeUse, `
    import { Holder, Plain } from "./model.zs";
    function inspect(callback: (value: Holder<Plain>) => i32): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeInvalidFunctionType = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeInvalidFunctionType.status, 1);
  assert.match(
    nativeInvalidFunctionType.stderr,
    /Plain does not satisfy Measured for T in "Holder"/,
  );

  writeFileSync(typeUse, `
    function inspect(value: Option<i32, i32>): i32 { return 1; }
    function main(): i32 { return 0; }
  `);
  const nativeIntrinsicTypeArity = spawnSync(process.execPath, [cli, "self-host-resolve", typeUse], { encoding: "utf8" });
  assert.equal(nativeIntrinsicTypeArity.status, 1);
  assert.match(nativeIntrinsicTypeArity.stderr, /Option expects 1 type argument\(s\), received 2/);
});

test("supports multiple trait constraints and constrained generic aggregates", () => {
  const valid = `
    trait Measured { function measure(): i32; }
    trait Named { function name(): cstring; }
    struct Reading implements Measured, Named {
      function measure(): i32 { return 42; }
      function name(): cstring { return "reading"; }
    }
    struct Holder<T: Measured & Named> { value: T; }
    function read<T: Measured & Named>(value: T): i32 {
      return identity(value.measure());
    }
    function identity<T>(value: T): T { return value; }
    function main(): i32 {
      const holder = Holder<Reading>({ value: Reading({}) });
      return read(holder.value);
    }
  `;
  assert.match(compileToC(valid, "generic-multiple-constraints.zs"), /__z_mono_Holder_Reading/);

  const invalidAggregate = `
    trait Measured { function measure(): i32; }
    struct Plain {}
    struct Holder<T: Measured> { value: T; }
    function main(): i32 { const holder = Holder<Plain>({ value: Plain({}) }); return 0; }
  `;
  assert.throws(
    () => compileToC(invalidAggregate, "generic-aggregate-constraint.zs"),
    /Plain does not satisfy Measured for T in "Holder"/,
  );
});

test("shows generic trait constraints in editor signatures", () => {
  const source = `
    trait Measured { function measure(): i32; }
    struct Reading implements Measured { function measure(): i32 { return 42; } }
    function read<T: Measured>(value: T): i32 { return value.measure(); }
    function main(): i32 { rea; return 0; }
  `;
  const declaration = source.indexOf("read<T:");
  assert.match(
    hover(source.replace(" rea;", ""), "generic-constraint-editor.zs", declaration + 1)?.contents.value ?? "",
    /function read<T: Measured>\(value: T\): i32/,
  );
  const offset = source.indexOf("rea;") + 3;
  assert.equal(
    completions(source, "generic-constraint-editor.zs", offset).find((item) => item.label === "read")?.detail,
    "function read<T: Measured>",
  );
});

test("exposes generic templates without leaking monomorphized names to editor completion", () => {
  const source = `
    struct Envelope<T> { value: T; }
    function identity<T>(value: T): T { return value; }
    function main(): i32 { const value = identity<i32>(1); ide; return value; }
  `;
  const offset = source.indexOf("ide;") + 3;
  const items = completions(source, "generic-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "identity")?.detail, "function identity<T>");
  assert.equal(items.some((item) => item.label.startsWith("__z_mono_")), false);
  const declaration = source.indexOf("identity<T>");
  assert.match(hover(source.replace(" ide;", ""), "generic-editor.zs", declaration + 1)?.contents.value ?? "", /function identity<T>/);
});

test("shows source generic fields and concrete generic binding types on hover", () => {
  const source = `
    struct Pair<T> {
      first: T;
      second: T;
    }
    function first<T>(pair: Pair<T>): T { return pair.first; }
    function main(): i32 {
      const pair = Pair({ first: 20, second: 22 });
      return pair.second;
    }
  `;
  const firstField = source.indexOf("first: T");
  const secondField = source.indexOf("second: T");
  const firstInitializer = source.indexOf("first: 20");
  const secondInitializer = source.indexOf("second: 22");
  const pairBinding = source.indexOf("pair =");
  assert.match(hover(source, "generic-hover.zs", firstField + 1)?.contents.value ?? "", /first: T/);
  assert.match(hover(source, "generic-hover.zs", secondField + 1)?.contents.value ?? "", /second: T/);
  assert.match(hover(source, "generic-hover.zs", firstInitializer + 1)?.contents.value ?? "", /first: i32/);
  assert.match(hover(source, "generic-hover.zs", secondInitializer + 1)?.contents.value ?? "", /second: i32/);
  const pairHover = hover(source, "generic-hover.zs", pairBinding + 1)?.contents.value ?? "";
  assert.match(pairHover, /pair: Pair<i32>/);
  assert.doesNotMatch(pairHover, /__z_mono_/);
  const beforeFirst = source.slice(0, firstField).split("\n");
  const firstToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.zs").data).find((token) => (
    token.line === beforeFirst.length - 1 && token.character === beforeFirst.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[firstToken?.type ?? -1], "property");
  const beforeInitializer = source.slice(0, firstInitializer).split("\n");
  const initializerToken = decodeSemanticTokens(semanticTokens(source, "generic-hover.zs").data).find((token) => (
    token.line === beforeInitializer.length - 1 && token.character === beforeInitializer.at(-1)!.length
  ));
  assert.equal(semanticTokenTypes[initializerToken?.type ?? -1], "property");
});

test("grows owned Array values with checked indexing and generic inout mutation", () => {
  const example = resolve(projectRoot, "examples/language/collections/dynamic-arrays.zs");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "length=3 capacity=4 middle=42\n");
  const generated = compileToC(readFileSync(example, "utf8"), example);
  assert.match(generated, /struct Z_DynamicArray_/);
  assert.match(generated, /realloc\(self->data, next \* sizeof\(int32_t\)\)/);
  assert.match(generated, /z_bounds_index/);
  assert.match(generated, /free\(\(values\)\.data\)/);
});

test("constructs populated Array values with owned elements in source order", () => {
  const source = `
    import { expect } from "std/test";

    struct Entry {
      id: i32;
      label: String;
    }

    function next(inout sequence: i32): i32 {
      sequence = sequence + 1;
      return sequence;
    }

    function exercise(): i32 {
      const entries = Array<Entry>(
        Entry({ id: 20, label: "draft" }),
        Entry({ id: 22, label: "published" })
      );
      const single = Array<i32>(7);
      let sequence: i32 = 0;
      const ordered = Array<i32>(
        next(inout sequence),
        next(inout sequence)
      );
      return entries[0].id + entries[1].id + single[0]
        + ordered[0] * 10 + ordered[1];
    }

    test "populated arrays retain every supplied element" {
      expect(exercise()).toEqual(61);
    }

    function main(): i32 {
      return exercise() - 61;
    }
  `;

  assert.deepEqual(diagnostics(source, "populated-array.zs"), []);
  const generated = compileToC(source, "populated-array.zs");
  assert.match(generated, /Z_DynamicArray_.*Entry_push\(&\(_z_array_/);
  assert.match(generated, /Z_DynamicArray_.*i32_push\(&\(_z_array_/);

  const directory = mkdtempSync("/tmp/z-populated-array-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const run = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const tests = spawnSync(process.execPath, [cli, "test", fileName], { encoding: "utf8" });
  assert.equal(tests.status, 0, tests.stderr);
  assert.match(tests.stdout, /1 passed; 0 failed/);

  const wrongElement = diagnostics(`
    function main(): i32 {
      const values = Array<i32>(1, true);
      return values[0];
    }
  `, "populated-array-type.zs")[0];
  assert.match(wrongElement.message, /expected i32, found boolean/);

  const asyncSource = `
    enum AsyncArrayInput {
      name String,
      values Array<i32>,
    }

    async function main(): i32 {
      const values = Array<i32>(20, 22);
      const input = AsyncArrayInput.values(values);
      const observed = match (input) {
        name(value) => i32(value.byteLength);
        values(value) => value[0] + value[1];
      };
      return observed - 42;
    }
  `;
  const asyncGenerated = compileToC(asyncSource, "populated-array-async.zs");
  assert.match(asyncGenerated, /Z_DynamicArray_.*i32_push\(&\(_z_async_array_/);
  const asyncDirectory = mkdtempSync("/tmp/z-populated-array-async-");
  const asyncFileName = resolve(asyncDirectory, "main.zs");
  writeFileSync(asyncFileName, asyncSource);
  const asyncRun = spawnSync(process.execPath, [cli, "run", asyncFileName], { encoding: "utf8" });
  assert.equal(asyncRun.status, 0, asyncRun.stderr);
});

test("borrows growable Array storage as read-only and mutable Slice values", () => {
  const source = `
    function first<T>(values: Slice<T>): T { return values[0]; }
    function replace(inout values: Slice<i32>, value: i32): void { values[0] = value; }
    function main(): i32 {
      let values = Array<i32>();
      values.push(1);
      replace(inout values, 42);
      return first(values);
    }
  `;
  const generated = compileToC(source, "dynamic-array-slice.zs");
  assert.match(generated, /\.data = \(values\)\.data, \.length = \(values\)\.length/);
  assert.match(generated, /__z_mono_first_i32/);
});

test("specializes generic Array mutation helpers for every element type", () => {
  const source = `
    function append<T>(inout values: Array<T>, value: T): void { values.push(value); }
    function main(): i32 {
      let numbers = Array<i32>();
      let flags = Array<boolean>();
      append(inout numbers, 42);
      append(inout flags, true);
      if (flags[0]) { return numbers[0]; }
      return 0;
    }
  `;
  const generated = compileToC(source, "dynamic-array-specializations.zs");
  assert.match(generated, /DynamicArray_.*i32.*_push/);
  assert.match(generated, /DynamicArray_.*boolean.*_push/);
  const compilation = spawnSync("clang", ["-x", "c", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", "-"], {
    input: generated,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr);
});

test("parses adjacent generic closers for nested Array types", () => {
  const source = `
    function main(): i32 {
      let inner = Array<i32>();
      inner.push(42);
      let outer = Array<Array<i32>>();
      outer.push(inner);
      return outer[0][0];
    }
  `;
  const generated = compileToC(source, "nested-dynamic-arrays.zs");
  assert.match(generated, /Z_DynamicArray_.*Z_DynamicArray_/);
  assert.match(generated, /free\(\(\(outer\)\.data\[/);
});

test("moves Array storage and destroys initialized owned elements in reverse order", () => {
  const example = resolve(projectRoot, "examples/language/collections/dynamic-array-cleanup.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "drop=2\ndrop=1\n");
  assert.throws(
    () => compileToC(source.replace("  return 0;", "  return first.id;"), "dynamic-array-move.zs"),
    /use of moved value "first"/,
  );

  const movedArray = `
    function main(): i32 {
      let first = Array<i32>();
      first.push(1);
      const second = first;
      return first.length + second.length;
    }
  `;
  assert.throws(() => compileToC(movedArray, "dynamic-array-owner-move.zs"), /use of moved value "first"/);
});

test("reserves Array capacity across native lowering, generics, ownership, and async frames", () => {
  const directory = mkdtempSync("/tmp/z-array-capacity-");
  try {
    for (const name of ["array-capacity", "array-capacity-generic", "array-capacity-async"]) {
      const input = resolve(projectRoot, `tests/fixtures/${name}.zs`);
      const source = readFileSync(input, "utf8");
      const stage0 = compileToC(source, input);
      const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(checked.status, 0, checked.stderr);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      const expected = name === "array-capacity" ? "released 2\nreleased 1\n"
        : name.endsWith("async") ? "released 42\n" : "";
      for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(directory, `${name}-${tier}${optimization}`);
          const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization,
            "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
            encoding: "utf8", input: generated, timeout: 30_000,
          });
          assert.equal(built.status, 0, built.stderr);
          const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
          assert.equal(run.status, 0, `${name} ${tier}: ${run.stderr}`);
          assert.equal(run.stdout, expected);
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("checks Array capacity arity, numeric types, mutability, and live loans", () => {
  const cases: [string, RegExp][] = [
    ["let values = Array<i32>.withCapacity();", /expects 1 argument/],
    ["let values = Array<i32>.withCapacity(1, 2);", /expects 1 argument/],
    ["let values = Array<i32>.withCapacity(-1);", /usize|range|negative/],
    ["let values = Array<i32>.withCapacity(1.5);", /usize|integer/],
    ["let values = Array<view i32>.withCapacity(1);", /cannot carry stored provenance/],
    ["const size: i32 = 8; let values = Array<i32>.withCapacity(size);", /usize/],
    ["const values = Array<i32>.withCapacity(8); values.reserveCapacity(16);", /requires addressable let storage/],
    ["let values = Array<i32>(); values.reserveCapacity();", /expects 1 argument/],
    ["let values = Array<i32>(); values.reserveCapacity(-1);", /usize|range|negative/],
    ["let values = Array<i32>(); values.reserveCapacity(true);", /usize|boolean/],
    ["let values = Array<i32>(); values.reserveCapacity(1, 2);", /expects 1 argument/],
    ["let values = Array<i32>(); const frozen = values.freeze(); frozen.reserveCapacity(8);", /readonly/],
    ["let values = Array<i32>(42); const current = view values[0]; values.reserveCapacity(8); console.log(current);", /cannot mutate.*while view/],
    ["let values = Array<i32>(42); for (const value of values) { values.reserveCapacity(8); }", /cannot structurally mutate Array/],
    ["let values = Array<i32>(42); const [first, ...rest] = view values; values.reserveCapacity(8); console.log(rest[0]);", /borrow|view/],
  ];
  const directory = mkdtempSync("/tmp/z-array-capacity-invalid-");
  try {
    for (const [body, message] of cases) {
      const source = `import console from "std/console"; function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "array-capacity-invalid.zs"), message);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, /Array|array|usize|mutat|borrow|view|argument/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("surfaces Array capacity contracts in hover and completion", () => {
  const source = "function main(): i32 { let values = Array<i32>.withCapacity(8); values.reserveCapacity(16); return 0; }";
  for (const method of ["withCapacity", "reserveCapacity"]) {
    const offset = source.indexOf(method);
    const help = hover(source, "array-capacity-hover.zs", offset);
    assert.match(help?.contents.value ?? "", new RegExp(`${method}\\(minimumCapacity: usize\\)`));
    const entries = completions(source, "array-capacity-hover.zs", offset + method.length);
    assert.ok(entries.some((entry) => entry.label === method), method);
  }
  const alias = "type Bytes = Array<u8>; function main(): i32 { let bytes = Bytes.withCapacity(8); return 0; }";
  const offset = alias.indexOf("withCapacity");
  assert.match(hover(alias, "array-capacity-alias-hover.zs", offset)?.contents.value ?? "", /withCapacity.*Array<u8>/);
  assert.ok(completions(alias, "array-capacity-alias-hover.zs", offset + 12).some((item) => item.label === "withCapacity"));
  const importedFile = resolve(projectRoot, "tests/fixtures/array-capacity-generic.zs");
  const imported = readFileSync(importedFile, "utf8");
  const importedOffset = imported.indexOf("ByteBuffer.withCapacity") + "ByteBuffer.".length;
  assert.match(hover(imported, importedFile, importedOffset)?.contents.value ?? "", /withCapacity.*Array<u8>/);
  assert.ok(completions(imported, importedFile, importedOffset + 12).some((item) => item.label === "withCapacity"));
});

test("Array capacity reservation eliminates intermediate buffer growth allocations", () => {
  const directory = mkdtempSync("/tmp/z-array-capacity-allocations-");
  const instrumentation = `
    #include <stdlib.h>
    #include <stdio.h>
    static unsigned allocation_calls;
    static void *counted_realloc(void *pointer, size_t bytes) {
      allocation_calls += 1;
      return realloc(pointer, bytes);
    }
    #define realloc counted_realloc
    #define main measured_main
  `;
  const wrapper = `
    #undef main
    int main(void) {
      int result = measured_main();
      printf("%u\\n", allocation_calls);
      return result;
    }
  `;
  try {
    for (const reserved of [false, true]) {
      const input = resolve(directory, "main.zs");
      const source = `function main(): i32 {
        let bytes = ${reserved ? "Array<u8>.withCapacity(1024)" : "Array<u8>()"};
        let index: usize = 0;
        while (index < 1024) { bytes.push(65); index = index + 1; }
        return bytes.length == 1024 && bytes[1023] == 65 ? 0 : 1;
      }`;
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      for (const [tier, generated] of [["stage0", compileToC(source, input)], ["native", native.stdout]]) {
        const executable = resolve(directory, tier);
        const entryWrapper = /main\(int argc, char \*\*argv\)/.test(generated)
          ? wrapper.replace("measured_main()", "measured_main(0, NULL)") : wrapper;
        const built = spawnSync("clang", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
          encoding: "utf8", input: instrumentation + generated + entryWrapper, timeout: 30_000,
        });
        assert.equal(built.status, 0, built.stderr);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, 0, run.stderr);
        if (reserved) assert.equal(Number(run.stdout), 1, tier);
        else assert.ok(Number(run.stdout) > 1, tier);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("appends a Slice of cleanup-free elements in one step across both compilers and async frames", () => {
  const directory = mkdtempSync("/tmp/z-array-append-");
  try {
    for (const name of ["array-append", "array-append-async"]) {
      const input = resolve(projectRoot, `tests/fixtures/${name}.zs`);
      const stage0 = compileToC(readFileSync(input, "utf8"), input);
      assert.match(stage0, /_append\([^)]*\*self, [^)]*items\) \{\s+if \(items\.length == 0\) return;/);
      const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(checked.status, 0, checked.stderr);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(directory, `${name}-${tier}${optimization}`);
          const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization,
            "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
            encoding: "utf8", input: generated, timeout: 30_000,
          });
          assert.equal(built.status, 0, built.stderr);
          const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
          assert.equal(run.status, 0, `${name} ${tier}${optimization}: ${run.stderr}`);
          assert.equal(run.stdout, "");
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("Array.append grows storage at most once for the whole run", () => {
  const directory = mkdtempSync("/tmp/z-array-append-allocations-");
  const instrumentation = `
    #include <stdlib.h>
    #include <stdio.h>
    static unsigned allocation_calls;
    static void *counted_realloc(void *pointer, size_t bytes) {
      allocation_calls += 1;
      return realloc(pointer, bytes);
    }
    #define realloc counted_realloc
    #define main measured_main
  `;
  const wrapper = `
    #undef main
    int main(void) {
      int result = measured_main();
      printf("%u\\n", allocation_calls);
      return result;
    }
  `;
  try {
    const input = resolve(directory, "main.zs");
    // One growth for the reserved source and one for the whole append.
    const source = `function main(): i32 {
      let source = Array<u8>.withCapacity(1024);
      let index: usize = 0;
      while (index < 1024) { source.push(65); index = index + 1; }
      let bytes = Array<u8>();
      bytes.append(source);
      return bytes.length == 1024 && bytes[1023] == 65 ? 0 : 1;
    }`;
    writeFileSync(input, source);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [tier, generated] of [["stage0", compileToC(source, input)], ["native", native.stdout]]) {
      const executable = resolve(directory, tier);
      const entryWrapper = /main\(int argc, char \*\*argv\)/.test(generated)
        ? wrapper.replace("measured_main()", "measured_main(0, NULL)") : wrapper;
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
        encoding: "utf8", input: instrumentation + generated + entryWrapper, timeout: 30_000,
      });
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(Number(run.stdout), 2, tier);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("checks Array.append element types, storage, arity, and call loans", () => {
  const cases: [string, RegExp][] = [
    ["let values = Array<u8>(1); values.append(values);", /overlapping inout and in uses of "values"/],
    ["let holder = Holder({ bytes: Array<u8>(1), other: Array<u8>(2) }); holder.bytes.append(holder.bytes);", /overlapping inout and in uses of "holder\.bytes"/],
    ["const values = Array<u8>(1); const more = Array<u8>(2); values.append(more);", /requires addressable let storage/],
    ["let values = Array<u8>(1); const frozen = values.freeze(); const more = Array<u8>(2); frozen.append(more);", /readonly Array has no mutating method "append"/],
    ["let names = Array<String>(\"a\"); const more = Array<String>(\"b\"); names.append(more);", /requires a cleanup-free element type, found String/],
    ["let values = Array<u8>(1, 2); const first = view values[0]; const more = Array<u8>(3); values.append(more); console.log(first);", /cannot mutate "values" while view "first" is live/],
    ["let values = Array<u8>(1, 2); const more = Array<u8>(3); for (const value of values) { values.append(more); }", /cannot structurally mutate Array "values" while for\.\.\.of is borrowing it/],
    ["let values = Array<u8>(1); const more = Array<i32>(2); values.append(more);", /expected Slice<u8>, found Array<i32>/],
    ["let values = Array<u8>(1); values.append();", /expects 1 argument/],
    ["let values = Array<u8>(1); const more = Array<u8>(2); values.append(more, more);", /expects 1 argument/],
    ["let values = Array<u8>(1); values.append(Array<u8>(2));", /array-to-Slice borrow requires stored array storage/],
  ];
  const directory = mkdtempSync("/tmp/z-array-append-invalid-");
  try {
    for (const [body, message] of cases) {
      const source = `import console from "std/console"; struct Holder { bytes: Array<u8>; other: Array<u8>; } function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "array-append-invalid.zs"), message);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, /overlapping|addressable|readonly|cleanup-free|view|borrowing|expected Slice|argument|stored array storage/);
    }
    const disjoint = `struct Holder { bytes: Array<u8>; other: Array<u8>; } function main(): i32 { let holder = Holder({ bytes: Array<u8>(1), other: Array<u8>(2) }); holder.bytes.append(holder.other); return holder.bytes.length == 2 ? 0 : 1; }`;
    compileToC(disjoint, "array-append-disjoint.zs");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("surfaces Array.append in hover and completion", () => {
  const source = "function main(): i32 { let values = Array<u8>(); const more = Array<u8>(1); values.append(more); return 0; }";
  const offset = source.indexOf("append");
  assert.match(hover(source, "array-append-hover.zs", offset)?.contents.value ?? "", /append\(items: Slice<u8>\): void/);
  assert.ok(completions(source, "array-append-hover.zs", offset + "append".length).some((entry) => entry.label === "append"));
});

test("stores one value many times in one step across both compilers and async frames", () => {
  const directory = mkdtempSync("/tmp/z-array-append-repeated-");
  try {
    for (const name of ["array-append-repeated", "array-append-repeated-async"]) {
      const input = resolve(projectRoot, `tests/fixtures/${name}.zs`);
      const stage0 = compileToC(readFileSync(input, "utf8"), input);
      assert.match(stage0, /Z_INLINE_ALWAYS void \w+_appendRepeated\([^)]*\*self, [^)]*value, uintptr_t count\) \{\s+if \(count == 0\) return;/);
      const checked = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(checked.status, 0, checked.stderr);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      for (const [tier, generated] of [["stage0", stage0], ["native", native.stdout]]) {
        for (const optimization of ["-O0", "-O2"]) {
          const executable = resolve(directory, `${name}-${tier}${optimization}`);
          const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization,
            "-Wall", "-Wextra", "-Werror", "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
            encoding: "utf8", input: generated, timeout: 30_000,
          });
          assert.equal(built.status, 0, built.stderr);
          const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
          assert.equal(run.status, 0, `${name} ${tier}${optimization}: ${run.stderr}`);
          assert.equal(run.stdout, "");
        }
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("Array.appendRepeated grows storage at most once and makes no library fill for a short run", () => {
  const directory = mkdtempSync("/tmp/z-array-append-repeated-allocations-");
  const instrumentation = `
    #include <stdlib.h>
    #include <stdio.h>
    static unsigned allocation_calls;
    static void *counted_realloc(void *pointer, size_t bytes) {
      allocation_calls += 1;
      return realloc(pointer, bytes);
    }
    #define realloc counted_realloc
    #define main measured_main
  `;
  const wrapper = `
    #undef main
    int main(void) {
      int result = measured_main();
      printf("%u\\n", allocation_calls);
      return result;
    }
  `;
  try {
    const input = resolve(directory, "main.zs");
    // One growth for the whole run, none for the short run that fits.
    const source = `function main(): i32 {
      let words = Array<u64>();
      words.appendRepeated(9221120237041090561, 1024);
      words.appendRepeated(7, 0);
      let few = Array<u64>.withCapacity(16);
      few.appendRepeated(9221120237041090561, few.capacity - 3);
      return words.length == 1024 && words[1023] == 9221120237041090561 && few.length == 13 && few[12] == words[0] ? 0 : 1;
    }`;
    writeFileSync(input, source);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [tier, generated] of [["stage0", compileToC(source, input)], ["native", native.stdout]]) {
      const executable = resolve(directory, tier);
      const entryWrapper = /main\(int argc, char \*\*argv\)/.test(generated)
        ? wrapper.replace("measured_main()", "measured_main(0, NULL)") : wrapper;
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
        encoding: "utf8", input: instrumentation + generated + entryWrapper, timeout: 30_000,
      });
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(Number(run.stdout), 2, tier);
      // A run of sixteen or fewer is a switch of plain stores; only the
      // longer form is a loop the C compiler may replace.
      assert.match(generated, /case 16: target\[15\] = value;[\s\S]*case 1: target\[0\] = value; break;\s+default: for \(/, tier);
      assert.match(generated, /(Z_INLINE_ALWAYS|always_inline\)\)) void \w+_appendRepeated\(/, tier);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("checks Array.appendRepeated element types, storage, arity, and argument types", () => {
  const cases: [string, RegExp][] = [
    ["const values = Array<u8>(1); values.appendRepeated(2, 3);", /requires addressable let storage/],
    ["let values = Array<u8>(1); const frozen = values.freeze(); frozen.appendRepeated(2, 3);", /readonly Array has no mutating method "appendRepeated"/],
    ["let names = Array<String>(\"a\"); names.appendRepeated(\"b\", 2);", /Array\.appendRepeated requires a cleanup-free element type, found String/],
    ["let values = Array<u8>(1, 2); const first = view values[0]; values.appendRepeated(3, 2); console.log(first);", /cannot mutate "values" while view "first" is live/],
    ["let values = Array<u8>(1, 2); for (const value of values) { values.appendRepeated(value, 2); }", /cannot structurally mutate Array "values" while for\.\.\.of is borrowing it/],
    ["let values = Array<u8>(1); values.appendRepeated(true, 2);", /expected u8, found boolean/],
    ["let values = Array<u8>(1); values.appendRepeated(2, true);", /expected usize, found boolean/],
    ["let values = Array<u8>(1); const count: i32 = 2; values.appendRepeated(2, count);", /expected usize, found i32/],
    ["let values = Array<u8>(1); values.appendRepeated(2);", /expects 2 arguments, received 1/],
    ["let values = Array<u8>(1); values.appendRepeated(2, 3, 4);", /expects 2 arguments, received 3/],
  ];
  const directory = mkdtempSync("/tmp/z-array-append-repeated-invalid-");
  try {
    for (const [body, message] of cases) {
      const source = `import console from "std/console"; function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "array-append-repeated-invalid.zs"), message);
      const input = resolve(directory, "invalid.zs");
      writeFileSync(input, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", input], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, /addressable|readonly|cleanup-free|view|expected u8|expected usize|argument/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 300_000);

test("surfaces Array.appendRepeated in hover and completion", () => {
  const source = "function main(): i32 { let values = Array<u8>(); values.appendRepeated(7, 3); return 0; }";
  const offset = source.indexOf("appendRepeated");
  assert.match(hover(source, "array-append-repeated-hover.zs", offset)?.contents.value ?? "", /appendRepeated\(value: u8, count: usize\): void/);
  assert.ok(completions(source, "array-append-repeated-hover.zs", offset + "appendRepeated".length).some((entry) => entry.label === "appendRepeated"));
});

test("pops the last Array element by ownership transfer and retains capacity", () => {
  const input = resolve(projectRoot, "tests/fixtures/array-pop.zs");
  const directory = mkdtempSync("/tmp/z-array-pop-");
  try {
    const source = readFileSync(input, "utf8");
    const stage0 = compileToC(source, input);
    assert.match(stage0, /_pop\([^)]*\*self\) \{\s+if \(self->length == 0\)/);
    const nativeCheck = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
      encoding: "utf8", timeout: 120_000,
    });
    assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
    const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
      encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(native.status, 0, native.stderr);
    for (const [name, generated] of [["stage0", stage0], ["native", native.stdout]]) {
      for (const optimization of ["-O0", "-O2"]) {
        const executable = resolve(directory, name + optimization);
        const built = spawnSync("clang", ["-x", "c", "-std=c11", optimization, "-Wall", "-Wextra", "-Werror",
          "-fsanitize=undefined", "-fno-sanitize-recover=all", "-", "-o", executable], {
          encoding: "utf8", input: generated, timeout: 30_000,
        });
        assert.equal(built.status, 0, built.stderr);
        const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stdout, "released 1\nreleased 2\nreleased 3\nreleased 4\n");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);

test("preserves popped ARC identity, Arena provenance, and async frame ownership", () => {
  const directory = mkdtempSync("/tmp/z-array-pop-composition-");
  try {
    for (const name of ["array-pop-class", "array-pop-arena", "array-pop-async"]) {
      const input = resolve(projectRoot, `tests/fixtures/${name}.zs`);
      const stage0 = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8", timeout: 30_000 });
      assert.equal(stage0.status, 0, stage0.stderr);
      if (name.endsWith("class")) assert.equal(stage0.stdout, "released 42\n");
      const parity = spawnSync(process.execPath, [cli, "check", input, "--native-frontend"], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(parity.status, 0, parity.stderr);
      const native = spawnSync(process.execPath, [cli, "self-host-emit", input], {
        encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(native.status, 0, native.stderr);
      const executable = resolve(directory, name);
      const built = spawnSync("clang", ["-x", "c", "-std=c11", "-Wall", "-Wextra", "-Werror", "-", "-o", executable], {
        encoding: "utf8", input: native.stdout, timeout: 30_000,
      });
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(executable, [], { encoding: "utf8", timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, stage0.stdout);
    }
    const source = readFileSync(resolve(projectRoot, "tests/fixtures/array-pop-arena.zs"), "utf8")
      .replace("let arena = Arena();", "let arena = Arena(); let other = Arena();")
      .replace("arena.create(removed)", "other.create(removed)");
    assert.match(diagnostics(source, "array-pop-wrong-arena.zs")[0]?.message ?? "", /only in the Arena that owns every embedded view/);
    const invalid = resolve(directory, "invalid.zs");
    writeFileSync(invalid, source);
    const rejected = spawnSync(process.execPath, [cli, "self-host-resolve", invalid], {
      encoding: "utf8", timeout: 120_000,
    });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /Arena|arena/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);

test("checks Array.pop mutability, arity, live views, and iteration", () => {
  const cases: [string, RegExp][] = [
    ["const values = Array<i32>(42); values.pop();", /requires addressable let storage/],
    ["let values = Array<i32>(42); values.pop(1);", /expects 0 arguments/],
    ["let values = Array<i32>(42); const frozen = values.freeze(); frozen.pop();", /readonly Array/],
    ["let values = Array<i32>(42); const current = view values[0]; values.pop(); console.log(current);", /cannot mutate.*while view/],
    ["let values = Array<i32>(42); for (const value of values) { values.pop(); }", /cannot structurally mutate Array/],
    ["let values = Array<i32>(42); for (const value of values) { values.push(1); }", /cannot structurally mutate Array/],
    ["let values = Array<i32>(42); for (const value of values) { values.clear(); }", /cannot structurally mutate Array/],
    ["let values = Array<i32>(42); const result = for (const value of values) { values.pop(); select value; } else { select 0; };", /cannot structurally mutate Array/],
    ["let values = Array<String>(\"Draft\"); values.pop();", /ownership-bearing value must be bound or transferred/],
    ["let values = Array<Owner>(); values.push(new Owner({ id: 42 })); values.pop();", /ownership-bearing value must be bound or transferred/],
  ];
  const directory = mkdtempSync("/tmp/z-array-pop-invalid-");
  try {
    for (const [body, message] of cases) {
      const source = `import console from "std/console"; class Owner { id: i32; } function main(): i32 { ${body} return 0; }`;
      assert.throws(() => compileToC(source, "array-pop-invalid.zs"), message);
      const file = resolve(directory, "invalid.zs");
      writeFileSync(file, source);
      const native = spawnSync(process.execPath, [cli, "self-host-resolve", file], {
        encoding: "utf8", timeout: 120_000,
      });
      assert.equal(native.status, 1, `${body}\n${native.stderr}`);
      assert.match(native.stderr, /Array|array|pop|mutat|ownership-bearing/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const source = "function main(): i32 { let values = Array<i32>(42); const last = values.pop(); return 0; }";
  const offset = source.indexOf("pop");
  const help = hover(source, "array-pop-hover.zs", offset);
  assert.match(help?.contents.value ?? "", /pop\(\): Option<i32>/);
  assert.match(help?.contents.value ?? "", /retains capacity/);
  const entries = completions(source, "array-pop-hover.zs", offset + 3);
  assert.ok(entries.some((entry) => entry.label === "pop"));
}, 300_000);

test("clears dynamic Arrays with deterministic cleanup while retaining capacity", () => {
  const directory = mkdtempSync("/tmp/z-array-clear-");
  const input = resolve(directory, "main.zs");
  try {
    const source = `
      import console from "std/console";

      struct Resource {
        id: i32;
        deinit { console.log(\`drop=\${this.id}\`); }
      }

      function main(): i32 {
        let values = Array<Resource>(Resource({ id: 1 }), Resource({ id: 2 }));
        const capacity: usize = values.capacity;
        values.clear();
        if (values.length != 0 || values.capacity != capacity) return 1;
        values.push(Resource({ id: 3 }));
        return values.length == 1 ? 0 : 2;
      }
    `;
    writeFileSync(input, source);
    const generated = compileToC(source, input);
    assert.match(generated, /DynamicArray_.*_clear\(&\(values\)\)/);
    assert.match(generated, /while \(self->length > 0\).*self->length -= 1/s);
    assert.doesNotMatch(
      generated.match(/static .*DynamicArray_.*_clear[\s\S]*?\n\}/)?.[0] ?? "",
      /free\(self->data\)/,
    );

    const result = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "drop=2\ndrop=1\ndrop=3\n");

    const asyncSource = `
      async function main(): i32 {
        let values = Array<i32>(20, 22);
        const capacity: usize = values.capacity;
        values.clear();
        if (values.length != 0 || values.capacity != capacity) return 1;
        values.push(42);
        return values[0] - 42;
      }
    `;
    const asyncGenerated = compileToC(asyncSource, "dynamic-array-clear-async.zs");
    assert.match(asyncGenerated, /DynamicArray_.*_clear\(&\(frame->value_values\)\)/);
    const asyncInput = resolve(directory, "async.zs");
    writeFileSync(asyncInput, asyncSource);
    const asyncResult = spawnSync(process.execPath, [cli, "run", asyncInput], { encoding: "utf8" });
    assert.equal(asyncResult.status, 0, asyncResult.stderr);

    const immutable = source.replace("let values =", "const values =");
    assert.throws(
      () => compileToC(immutable, "dynamic-array-clear-const.zs"),
      /Array\.clear requires addressable let storage/,
    );

    const wrongArity = source.replace("values.clear();", "values.clear(1);");
    assert.throws(
      () => compileToC(wrongArity, "dynamic-array-clear-arity.zs"),
      /"clear" expects 0 arguments, received 1/,
    );

    const liveView = `
      function main(): i32 {
        let values = Array<i32>(42);
        const first = view values[0];
        values.clear();
        return first;
      }
    `;
    assert.match(
      diagnostics(liveView, "dynamic-array-clear-live-view.zs")[0]?.message ?? "",
      /cannot mutate "values" while view/,
    );

    const iteration = `
      function main(): i32 {
        let values = Array<i32>(42);
        for (const value of values) {
          values.clear();
        }
        return 0;
      }
    `;
    const iterationDiagnostic = diagnostics(iteration, "dynamic-array-clear-iteration.zs")[0];
    assert.equal(iterationDiagnostic?.code, "Z0311");
    assert.match(iterationDiagnostic?.message ?? "", /cannot structurally mutate Array "values"/);

    const arenaProvenance = `
      import { Arena } from "std/memory";
      struct Item { value: i32; }
      struct Link { item: view Item; }
      function main(): i32 {
        let firstArena = Arena();
        let secondArena = Arena();
        const first = firstArena.create(Item({ value: 1 }));
        const second = secondArena.create(Item({ value: 2 }));
        let links = Array<Link>();
        links.push(Link({ item: first }));
        links.clear();
        links.push(Link({ item: second }));
        return 0;
      }
    `;
    assert.match(
      diagnostics(arenaProvenance, "dynamic-array-clear-arena.zs")[0]?.message ?? "",
      /already carries provenance from another Arena/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checks Array mutation, element types, and partial moves", () => {
  const empty = `
    function main(): i32 { const values = Array<i32>(); return 0; }
  `;
  const emptyGenerated = compileToC(empty, "dynamic-array-empty.zs");
  assert.doesNotMatch(emptyGenerated, /DynamicArray_.*_push\(/);

  const immutable = `
    function main(): i32 {
      const values = Array<i32>();
      values.push(1);
      return 0;
    }
  `;
  assert.throws(() => compileToC(immutable, "dynamic-array-const.zs"), /Array.push requires addressable let storage/);

  const wrongElement = `
    function main(): i32 {
      let values = Array<i32>();
      values.push(true);
      return 0;
    }
  `;
  assert.throws(() => compileToC(wrongElement, "dynamic-array-element.zs"), /expected i32, found boolean/);

  const partialMove = `
    struct Item { id: i32; deinit {} }
    function main(): i32 {
      let values = Array<Item>();
      values.push(Item({ id: 1 }));
      const item = values[0];
      return item.id;
    }
  `;
  assert.throws(() => compileToC(partialMove, "dynamic-array-partial-move.zs"), /cannot move an ownership-bearing field or element out of its owner/);
});

test("exposes Array members and source-level types to editor services", () => {
  const source = `
    function main(): i32 {
      let values = Array<i32>();
      values.;
      return 0;
    }
  `;
  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "dynamic-array-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "usize");
  assert.equal(items.find((item) => item.label === "capacity")?.detail, "usize");
  assert.match(items.find((item) => item.label === "push")?.detail ?? "", /push\(value: i32\): void/);
  assert.match(items.find((item) => item.label === "clear")?.detail ?? "", /destroys all elements and retains capacity/);
  assert.match(items.find((item) => item.label === "freeze")?.detail ?? "", /readonly Array<i32>.*without copying/);

  const valid = source.replace("      values.;", "      values.push(1);");
  const declaration = valid.indexOf("values =");
  assert.match(hover(valid, "dynamic-array-editor.zs", declaration + 1)?.contents.value ?? "", /values: Array<i32>/);
  const push = valid.indexOf("push(1)");
  assert.match(hover(valid, "dynamic-array-editor.zs", push + 1)?.contents.value ?? "", /push\(value: i32\): void/);
  const clearSource = source.replace("      values.;", "      values.clear();");
  const clear = clearSource.indexOf("clear()") + 1;
  assert.match(hover(clearSource, "dynamic-array-editor.zs", clear)?.contents.value ?? "", /destroys all elements and retains capacity/);
});

test("owns Map keys and values with optional views and deterministic removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/map.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Map.*_get\(const .*\*self, Z_String key\)/);
  assert.match(generated, /return &self->entries\.data\[stored - 1\]\.value/);
  assert.match(generated, /Map.*_rehash/);
  assert.match(generated, /self->buckets\.data\[slot\] = self->entries\.length/);
  assert.match(generated, /Map.*_remove/);
  assert.match(generated, /Map.*_delete/);
  assert.match(generated, /MapEntry.*_deinit/);
  assert.match(generated, /< \(users\)\.entries\.length/);
  assert.match(generated, /const Z_User \*value = &/);

  const directory = mkdtempSync("/tmp/z-map-cleanup-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    import { Map } from "std/collections";
    import console from "std/console";
    struct Resource {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    function main(): i32 {
      let resources = Map<i32, Resource>();
      resources.set(1, Resource({ id: 1 }));
      resources.set(1, Resource({ id: 2 }));
      if (!resources.has(1) || resources.length != 1) return 1;
      resources.clear();
      if (resources.length != 0) return 1;
      resources.set(2, Resource({ id: 3 }));
      if (!resources.delete(2)) return 1;
      if (resources.delete(2)) return 1;
      return 0;
    }
  `);
  const cleanup = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(cleanup.stdout, "drop=1\ndrop=2\ndrop=3\n");

  writeFileSync(input, `
    import { Map } from "std/collections";
    enum Key { first, second }
    function main(): i32 {
      let flags = Map<Key, boolean>();
      flags.set(Key.first, true);
      if (flags.has(Key.first) && !flags.has(Key.second)) return 0;
      return 1;
    }
  `);
  const enumKey = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(enumKey.status, 0, enumKey.stderr);

  const borrowed = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      values.set("other", 1);
      return match (in found) { some(value) => value; none => 0; };
    }
  `;
  const borrowDiagnostic = diagnostics(borrowed, "map-view-mutation.zs")[0];
  assert.equal(borrowDiagnostic.code, "Z0205");
  assert.match(borrowDiagnostic.message, /cannot set "values" while view/);

  const arenaValues = `
    import { Map } from "std/collections";
    import { Arena } from "std/memory";
    struct Item { value: i32; }
    struct Link { item: view Item; }
    function main(): i32 {
      let arena = Arena();
      const item = arena.create(Item({ value: 42 }));
      let links = Map<String, Link>();
      links.set("answer", Link({ item }));
      const found = links.get("answer");
      const answer = match (in found) {
        some(link) => {
          const linked = link.item;
          select linked.value;
        }
        none => 0;
      };
      const stored = arena.create(links);
      const storedFound = stored.get("answer");
      const storedAnswer = match (in storedFound) {
        some(link) => {
          const linked = link.item;
          select linked.value;
        }
        none => 0;
      };
      return answer + storedAnswer - 84;
    }
  `;
  assert.deepEqual(diagnostics(arenaValues, "map-arena-values.zs"), []);
  writeFileSync(input, arenaValues);
  const arenaValuesResult = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(arenaValuesResult.status, 0, arenaValuesResult.stderr);

  const emptyArenaMap = arenaValues.replace(
    "let links = Map<String, Link>();",
    "const links = Map<String, Link>();",
  );
  assert.match(
    diagnostics(emptyArenaMap, "map-arena-empty.zs")[0].message,
    /empty view-bearing Map must use let/,
  );

  const mixedArenaMap = arenaValues
    .replace(
      "const item = arena.create(Item({ value: 42 }));",
      "let other = Arena();\n      const item = arena.create(Item({ value: 42 }));\n      const second = other.create(Item({ value: 22 }));",
    )
    .replace(
      'links.set("answer", Link({ item }));',
      'links.set("answer", Link({ item }));\n      links.set("second", Link({ item: second }));',
    );
  assert.match(
    diagnostics(mixedArenaMap, "map-arena-mixed.zs")[0].message,
    /already carries provenance from another Arena/,
  );

  const wrongArenaMap = arenaValues
    .replace("let arena = Arena();", "let arena = Arena();\n      let other = Arena();")
    .replace("const stored = arena.create(links);", "const stored = other.create(links);");
  assert.match(
    diagnostics(wrongArenaMap, "map-arena-wrong-region.zs")[0].message,
    /only in the Arena that owns every embedded view/,
  );

  const removedIntoWrongArena = `
    import { Map } from "std/collections";
    import { Arena } from "std/memory";
    struct Item { value: i32; }
    struct Link { item: view Item; }
    function main(): i32 {
      let source = Arena();
      let destination = Arena();
      const item = source.create(Item({ value: 42 }));
      let links = Map<String, Link>();
      links.set("answer", Link({ item }));
      const removed = links.remove("answer");
      const stored = destination.create(removed);
      return 0;
    }
  `;
  assert.match(
    diagnostics(removedIntoWrongArena, "map-arena-remove-wrong-region.zs")[0].message,
    /only in the Arena that owns every embedded view/,
  );

  const clearKeepsArena = arenaValues
    .replace(
      "const item = arena.create(Item({ value: 42 }));",
      "let other = Arena();\n      const item = arena.create(Item({ value: 42 }));\n      const second = other.create(Item({ value: 22 }));",
    )
    .replace(
      'links.set("answer", Link({ item }));',
      'links.set("answer", Link({ item }));\n      links.clear();\n      links.set("second", Link({ item: second }));',
    );
  assert.match(
    diagnostics(clearKeepsArena, "map-arena-clear-keeps-region.zs")[0].message,
    /already carries provenance from another Arena/,
  );

  const iterationMutation = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      for (const entry of values) {
        values.delete(entry.key);
      }
      return 0;
    }
  `;
  const iterationMutationDiagnostic = diagnostics(iterationMutation, "map-iteration-mutation.zs")[0];
  assert.equal(iterationMutationDiagnostic.code, "Z0311");
  assert.match(iterationMutationDiagnostic.message, /cannot structurally mutate Map "values" while for\.\.\.of is borrowing it/);

  const iterationMove = iterationMutation.replace(
    "values.delete(entry.key);",
    "const taken = move entry;",
  );
  const iterationMoveDiagnostic = diagnostics(iterationMove, "map-iteration-move.zs")[0];
  assert.equal(iterationMoveDiagnostic.code, "Z0203");
  assert.match(iterationMoveDiagnostic.message, /cannot move borrowed iteration binding "entry"/);

  const copyableView = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      const answer = match (in found) {
        some(value) => value;
        none => 0;
      };
      return answer - 42;
    }
  `;
  assert.deepEqual(diagnostics(copyableView, "map-copyable-view.zs"), []);
  const copyableGenerated = compileToC(copyableView, "map-copyable-view.zs");
  assert.match(copyableGenerated, /\*\(value\)/);
  writeFileSync(input, copyableView);
  const copyableResult = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(copyableResult.status, 0, copyableResult.stderr);

  const selectedView = copyableView.replace(
    "some(value) => value;",
    "some(value) => { select value; }",
  );
  assert.deepEqual(diagnostics(selectedView, "map-selected-view.zs"), []);

  const conditionalView = copyableView.replace(
    "some(value) => value;",
    "some(value) => (if (true) { select value; } else { select 0; });",
  );
  assert.deepEqual(diagnostics(conditionalView, "map-conditional-view.zs"), []);

  const directReturnView = `
    import { Map } from "std/collections";
    function main(): i32 {
      let values = Map<String, i32>();
      values.set("answer", 42);
      const found = values.get("answer");
      return match (in found) {
        some(value) => value;
        none => 0;
      };
    }
  `;
  assert.deepEqual(diagnostics(directReturnView, "map-direct-return-view.zs"), []);

  const ownedView = `
    import { Map } from "std/collections";
    struct Resource {
      id: i32;
      deinit {}
    }
    function take(in resources: Map<i32, Resource>): Resource {
      const found = resources.get(1);
      return match (in found) {
        some(value) => value;
        none => Resource({ id: 0 });
      };
    }
    function main(): i32 { return 0; }
  `;
  assert.match(
    diagnostics(ownedView, "map-owned-view.zs")[0].message,
    /expected Resource, found view Resource/,
  );

  const immutable = `
    import { Map } from "std/collections";
    function main(): i32 {
      const values = Map<i32, i32>();
      values.set(1, 2);
      return 0;
    }
  `;
  assert.match(diagnostics(immutable, "map-const.zs")[0].message, /Map\.set requires addressable let storage/);

  const movedKey = `
    import { Map } from "std/collections";
    function key(): String { return \`owned key\`; }
    function main(): i32 {
      let values = Map<String, i32>();
      const name = key();
      values.set(name, 42);
      return name.byteLength;
    }
  `;
  assert.match(diagnostics(movedKey, "map-moved-key.zs")[0].message, /use of moved value "name"/);

  const unsupportedKey = `
    import { Map } from "std/collections";
    function main(): i32 { const values = Map<f64, i32>(); return 0; }
  `;
  assert.match(diagnostics(unsupportedKey, "map-float-key.zs")[0].message, /key type "f64" is not hashable/);

  writeFileSync(input, `
    import { Map } from "std/collections";
    import console from "std/console";
    class Session {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    function main(): i32 {
      let values = Map<i32, Session>();
      const first = new Session({ id: 1 });
      values.set(1, first);
      const found = values.get(1);
      const observed = match (in found) {
        some(session) => session.id;
        none => 0;
      };
      if (observed != 1 || first.id != 1) return 1;
      values.set(1, new Session({ id: 2 }));
      const removed = values.remove(1);
      const removedID = match (in removed) {
        some(session) => session.id;
        none => 0;
      };
      if (removedID != 2 || values.length != 0) return 1;
      return 0;
    }
  `);
  const identity = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(identity.status, 0, identity.stderr);
  assert.equal(identity.stdout, "drop=2\ndrop=1\n");

  const missingImport = `function main(): i32 { const values = Map<i32, i32>(); return 0; }`;
  assert.match(diagnostics(missingImport, "map-import.zs")[0].message, /Map requires an explicit standard-library import/);
});

test("owns and cleans recursive enums through Array and Map storage", () => {
  const fixture = resolve(projectRoot, "tests/fixtures/recursive-map-value.zs");
  const source = readFileSync(fixture, "utf8");
  const generated = compileToC(source, fixture);
  assert.match(generated, /static void Z_JsonValue_deinit\(Z_JsonValue \*self\)/);
  assert.match(generated, /Z_JsonValue_deinit\(&\(\(self->data\.arrayValue\)\.data/);
  assert.match(generated, /Z___z_Map_6_StringJsonValue_deinit\(&\(self->data\.objectValue\)\)/);

  const execution = spawnSync(process.execPath, [cli, "run", fixture], { encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stderr);
});

test("stores ARC-managed function values in Map and returns retained handlers", () => {
  const example = resolve(projectRoot, "examples/applications/message-router/main.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(
    generated,
    /_get\(const [^\n]+\*self, Z_String key\)[\s\S]*?_retain\(self->entries\.data\[stored - 1\]\.value\)/,
  );
  assert.match(
    generated,
    /_set\(&\(self->handlers\), [^\n]+_retain\(handler\)\)/,
  );
  assert.match(
    generated,
    /_RouteRegistry_register\(&\(routes\), [^\n]+_retain\(addOffset\)\)/,
  );
  assert.match(generated, /_release\(self->entries\.data\[index\]\.value\)/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "increment=42 offset=42 missing=missing\n",
  );

  const retainedLookup = `
    import { Map } from "std/collections";
    type Handler = () => i32;
    function main(): i32 {
      let handlers = Map<String, Handler>();
      const offset = 42;
      const handler: Handler = move () => offset;
      handlers.set("answer", handler);
      const found = handlers.get("answer");
      handlers.clear();
      return match (found) {
        some(operation) => operation() - 42;
        none => 1;
      };
    }
  `;
  assert.deepEqual(diagnostics(retainedLookup, "map-function-retain.zs"), []);
  const directory = mkdtempSync("/tmp/z-map-function-retain-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, retainedLookup);
  const retainedResult = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(retainedResult.status, 0, retainedResult.stderr);

  const lifecycle = `
    import { Map } from "std/collections";
    import console from "std/console";
    class State {
      id: i32;
      deinit { console.log(\`drop=\${this.id}\`); }
    }
    type Handler = () => i32;
    function makeHandler(id: i32): Handler {
      const state = new State({ id });
      const handler: Handler = move () => state.id;
      return handler;
    }
    function main(): i32 {
      let handlers = Map<String, Handler>();
      handlers.set("replace", makeHandler(1));
      handlers.set("replace", makeHandler(2));
      if (!handlers.delete("replace")) return 1;
      handlers.set("clear", makeHandler(3));
      handlers.clear();
      handlers.set("remove", makeHandler(4));
      const removed = handlers.remove("remove");
      handlers.set("destroy", makeHandler(5));
      const observed = match (removed) {
        some(operation) => operation();
        none => 0;
      };
      console.log(\`observed=\${observed}\`);
      return observed - 4;
    }
  `;
  writeFileSync(fileName, lifecycle);
  const lifecycleResult = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(lifecycleResult.status, 0, lifecycleResult.stderr);
  assert.equal(lifecycleResult.stdout, "drop=1\ndrop=2\ndrop=3\ndrop=4\nobserved=4\ndrop=5\n");
});

test("consumes a wrapper when extracting its sole owned field", () => {
  const source = `
    struct PendingValues {
      values: Array<i32>;

      function finish(move this): Array<i32> {
        return this.values;
      }
    }

    function main(): i32 {
      let pending = PendingValues({ values: Array<i32>(20, 22) });
      const values = pending.finish();
      return values[0] + values[1] - 42;
    }
  `;
  const generated = compileToC(source, "consume-wrapper-field.zs");
  assert.match(generated, /_z_live_this_\d+ = false, self\.values/);
  const directory = mkdtempSync("/tmp/z-consume-wrapper-field-");
  const input = resolve(directory, "consume-wrapper-field.zs");
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const nested = `
    struct ValueRegistry {
      values: Array<i32>;
    }

    struct PendingRegistry {
      registry: ValueRegistry;

      function finish(move this): Array<i32> {
        return this.registry.values;
      }
    }

    function main(): i32 {
      let pending = PendingRegistry({
        registry: ValueRegistry({ values: Array<i32>(20, 22) }),
      });
      const values = pending.finish();
      return values[0] + values[1] - 42;
    }
  `;
  const nestedGenerated = compileToC(nested, "consume-nested-wrapper-field.zs");
  assert.match(nestedGenerated, /_z_live_this_\d+ = false, \(self\.registry\)\.values/);
  const nestedInput = resolve(directory, "consume-nested-wrapper-field.zs");
  writeFileSync(nestedInput, nested);
  const nestedResult = spawnSync(process.execPath, [cli, "run", nestedInput], { encoding: "utf8" });
  assert.equal(nestedResult.status, 0, nestedResult.stderr);

  const multipleOwners = source.replace(
    "      values: Array<i32>;",
    "      values: Array<i32>;\n      remaining: Array<i32>;",
  ).replace(
    "PendingValues({ values: Array<i32>(20, 22) })",
    "PendingValues({ values: Array<i32>(20, 22), remaining: Array<i32>() })",
  );
  assert.throws(
    () => compileToC(multipleOwners, "consume-wrapper-multiple-fields.zs"),
    /cannot move an ownership-bearing field or element out of its owner/,
  );

  const customCleanup = source.replace(
    "      function finish(move this)",
    "      deinit {}\n\n      function finish(move this)",
  );
  assert.throws(
    () => compileToC(customCleanup, "consume-wrapper-custom-cleanup.zs"),
    /cannot move an ownership-bearing field or element out of its owner/,
  );
});

test("hashes readonly nominal keys through the standard Hashable contract", () => {
  const example = resolve(projectRoot, "examples/language/collections/custom-hash.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(generated, /typedef struct \{\n  uint64_t state;\n\} Z_Hasher/);
  assert.match(generated, /Z_ProjectKey_equals\(&left, &right\)/);
  assert.match(generated, /Z_ProjectKey_hash\(&value, &hasher\)/);
  assert.match(generated, /z_hasher_add_string/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const moduleDirectory = mkdtempSync("/tmp/z-hashable-module-");
  writeFileSync(resolve(moduleDirectory, "key.zs"), `
    import { Hashable, Hasher } from "std/hash";
    export readonly struct ProjectKey implements Hashable {
      id: i32;
      function equals(in other: ProjectKey): boolean { return this.id == other.id; }
      function hash(inout hasher: Hasher): void { hasher.add(this.id); }
    }
  `);
  const moduleMain = resolve(moduleDirectory, "main.zs");
  writeFileSync(moduleMain, `
    import { Map } from "std/collections";
    import { ProjectKey } from "./key.zs";
    function main(): i32 {
      let values = Map<ProjectKey, i32>();
      values.set(ProjectKey({ id: 7 }), 42);
      const found = values.get(ProjectKey({ id: 7 }));
      return match (in found) { some(value) => value - 42; none => 1; };
    }
  `);
  const moduleResult = spawnSync(process.execPath, [cli, "run", moduleMain], { encoding: "utf8" });
  assert.equal(moduleResult.status, 0, moduleResult.stderr);

  const mutable = source.replace("readonly struct ProjectKey", "struct ProjectKey");
  const mutableDiagnostic = diagnostics(mutable, "mutable-hash-key.zs")[0];
  assert.equal(mutableDiagnostic.code, "Z0401");
  assert.match(mutableDiagnostic.message, /must be readonly to preserve its stored hash/);

  const missingMethod = source.replace(
    "  function hash(inout hasher: Hasher): void {\n    hasher.add(this.workspace);\n    hasher.add(this.path);\n  }\n",
    "",
  );
  assert.match(diagnostics(missingMethod, "incomplete-hashable.zs")[0].message, /does not implement Hashable\.hash/);

  const invalidFeed = source.replace("hasher.add(this.path);", "hasher.add(1.5);");
  assert.match(diagnostics(invalidFeed, "invalid-hash-feed.zs")[0].message, /Hasher\.add cannot hash "f64"/);

  const partialImport = source.replace("Hashable, Hasher", "Hash, Hasher");
  const importOffset = partialImport.indexOf("Hash, Hasher") + "Hash".length;
  assert.equal(completions(partialImport, example, importOffset).find((item) => item.label === "Hashable")?.kind, 8);

  const addOffset = source.indexOf("hasher.add(this.workspace)") + "hasher.".length;
  assert.match(completions(source, example, addOffset).find((item) => item.label === "add")?.detail ?? "", /one hash component/);
  assert.match(hover(source, example, source.indexOf("add(this.workspace)") + 1)?.contents.value ?? "", /feeds a supported scalar/);
});

test("supports explicit copy and move ownership expressions", () => {
  const source = `
    struct Document {
      title: String;
    }

    struct Library {
      document: Document;

      function current(): view Document {
        return this.document;
      }
    }

    function main(): i32 {
      const library = Library({ document: Document({ title: "draft" }) });
      const snapshot = copy library.current();
      const transferred = move library;
      if (snapshot.title.byteLength == 5 && transferred.document.title.byteLength == 5) return 0;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(source, "explicit-copy-move.zs"), []);
  const generated = compileToC(source, "explicit-copy-move.zs");
  assert.match(generated, /Z_Document snapshot = z_copy_Document\(/);
  assert.match(generated, /z_string_copy\(source\.title\)/);
  assert.match(generated, /_z_live_library_[0-9]+ = false/);
  const copyHover = hover(source, "explicit-copy-move.zs", source.indexOf("copy library"))?.contents.value ?? "";
  assert.match(copyHover, /copy view Document -> Document/);
  assert.match(copyHover, /compiler-synthesized from copyable fields and payloads/);
  assert.match(copyHover, /materializes an owned Document from borrowed storage/);
  assert.match(copyHover, /allocates for owned strings or growable buffers/);
  const moveHover = hover(source, "explicit-copy-move.zs", source.indexOf("move library"))?.contents.value ?? "";
  assert.match(moveHover, /move Library -> Library/);
  assert.match(moveHover, /named source becomes unavailable/);
  assert.match(moveHover, /owned fields are not cloned/);
  const directory = mkdtempSync("/tmp/z-explicit-copy-move-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, source);
  const result = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const copyKeepsSource = `
    function main(): i32 {
      const value = 21;
      const snapshot = copy value;
      return value + snapshot - 42;
    }
  `;
  assert.deepEqual(diagnostics(copyKeepsSource, "explicit-trivial-copy.zs"), []);

  const contextualKeywords = `
    function copy(value: i32): i32 { return value + 1; }
    function move(value: i32): i32 { return value + 1; }
    function main(): i32 {
      const value = move(copy(40));
      const text = "ready";
      const copy = copy text;
      const move = move copy;
      if (move.byteLength == 5) return value - 42;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(contextualKeywords, "contextual-copy-move.zs"), []);
  const contextualOwnershipTokens = decodeSemanticTokens(
    semanticTokens(contextualKeywords, "contextual-copy-move.zs").data,
  );
  const copyBindingOffset = contextualKeywords.indexOf("const copy") + "const ".length;
  const copyOperatorOffset = contextualKeywords.indexOf("= copy") + 2;
  const copyBindingPosition = positionForOffset(contextualKeywords, copyBindingOffset);
  const copyOperatorPosition = positionForOffset(contextualKeywords, copyOperatorOffset);
  assert.ok(contextualOwnershipTokens.some((token) => (
    token.line === copyBindingPosition.line
    && token.character === copyBindingPosition.character
    && token.type === semanticTokenTypes.indexOf("variable")
  )));
  assert.ok(contextualOwnershipTokens.some((token) => (
    token.line === copyOperatorPosition.line
    && token.character === copyOperatorPosition.character
    && token.type === semanticTokenTypes.indexOf("keyword")
  )));
  const moveUseOffset = contextualKeywords.indexOf("move.byteLength");
  assert.match(
    hover(contextualKeywords, "contextual-copy-move.zs", moveUseOffset)?.contents.value ?? "",
    /move: String/,
  );

  const recursiveCopies = `
    enum Label { present String, missing }
    function main(): i32 {
      let names = Array<String>();
      names.push("first");
      const copiedNames = copy names;
      names.push("second");

      const label = Label.present("draft");
      const copiedLabel = copy label;
      const firstLength: usize = match (in label) {
        present(value) => value.byteLength;
        missing => names.length;
      };
      const secondLength: usize = match (in copiedLabel) {
        present(value) => value.byteLength;
        missing => copiedNames.length;
      };
      if (names.length == 2 && copiedNames.length == 1 && firstLength == secondLength) return 0;
      return 1;
    }
  `;
  assert.deepEqual(diagnostics(recursiveCopies, "explicit-recursive-copy.zs"), []);
  const recursiveInput = resolve(directory, "recursive.zs");
  writeFileSync(recursiveInput, recursiveCopies);
  const recursiveResult = spawnSync(process.execPath, [cli, "run", recursiveInput], { encoding: "utf8" });
  assert.equal(recursiveResult.status, 0, recursiveResult.stderr);

  const useAfterMove = source.replace(
    "if (snapshot.title.byteLength == 5 && transferred.document.title.byteLength == 5) return 0;",
    "if (library.document.title.byteLength == 5) return 0;",
  );
  const movedDiagnostic = diagnostics(useAfterMove, "explicit-use-after-move.zs")[0];
  assert.equal(movedDiagnostic.code, "Z0201");
  assert.match(movedDiagnostic.message, /use of moved value "library"/);

  const meaninglessMove = diagnostics(`
    function main(): i32 {
      const value = 42;
      const transferred = move value;
      return transferred;
    }
  `, "explicit-scalar-move.zs")[0];
  assert.equal(meaninglessMove.code, "Z0218");
  assert.match(meaninglessMove.message, /has no unique ownership to move/);

  const uncopyable = diagnostics(`
    struct Resource {
      id: i32;
      deinit {}
    }
    function main(): i32 {
      const resource = Resource({ id: 42 });
      const duplicate = copy resource;
      return duplicate.id;
    }
  `, "explicit-uncopyable.zs")[0];
  assert.equal(uncopyable.code, "Z0217");
  assert.match(uncopyable.message, /cannot be explicitly copied/);
});

test("supports inferred local views into named value storage", () => {
  const example = resolve(projectRoot, "examples/language/ownership/local-views.zs");
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(generated, /const Z_SyntaxNode \* const node = &\(/);
  assert.match(generated, /evidence\)\), \(node\)->kind\)/);
  assert.match(generated, /return \(\(node\)->text\)\.length/);

  const bindingOffset = source.indexOf("const node") + "const ".length;
  const bindingHover = hover(source, example, bindingOffset)?.contents.value ?? "";
  assert.match(bindingHover, /node: view SyntaxNode/);
  assert.match(bindingHover, /view of tree/);

  const operatorOffset = source.indexOf("view tree");
  const operatorHover = hover(source, example, operatorOffset)?.contents.value ?? "";
  assert.match(operatorHover, /view SyntaxNode of tree/);
  assert.match(operatorHover, /read-only projection/);
  assert.match(operatorHover, /loan ends after the view's last use/);

  const tokens = decodeSemanticTokens(semanticTokens(source, example).data);
  const operatorPosition = positionForOffset(source, operatorOffset);
  assert.ok(tokens.some((token) => (
    token.line === operatorPosition.line
    && token.character === operatorPosition.character
    && token.type === semanticTokenTypes.indexOf("keyword")
  )));

  const testResult = spawnSync(process.execPath, [cli, "test", example], { encoding: "utf8" });
  assert.equal(testResult.status, 0, testResult.stderr);
  assert.match(testResult.stdout, /1 passed; 0 failed/);

  const liveMutation = source.replace(
    "evidence.record(node.kind);",
    "tree.append(SyntaxNode({ kind: 7, text: \"number\" }));\n  evidence.record(node.kind);",
  );
  const mutationDiagnostic = diagnostics(liveMutation, "local-view-live-mutation.zs")[0];
  assert.equal(mutationDiagnostic.code, "Z0205");
  assert.match(mutationDiagnostic.message, /cannot mutate "tree" while view "node" is live/);

  const mutableBinding = source.replace(
    "const node = view tree.nodes[index];",
    "let node = view tree.nodes[index];",
  );
  const mutableDiagnostic = diagnostics(mutableBinding, "mutable-local-view.zs")[0];
  assert.equal(mutableDiagnostic.code, "Z0206");
  assert.match(mutableDiagnostic.message, /must initialize a const binding/);

  const annotatedBinding = source.replace(
    "const node = view tree.nodes[index];",
    "const node: SyntaxNode = view tree.nodes[index];",
  );
  const annotationDiagnostic = diagnostics(annotatedBinding, "annotated-local-view.zs")[0];
  assert.equal(annotationDiagnostic.code, "Z0206");
  assert.match(annotationDiagnostic.message, /uses an inferred view type/);

  const returnedProjection = `
    struct Item { value: i32; }
    struct Store {
      item: Item;
      function current(): view Item {
        return view this.item;
      }
    }
  `;
  const returnedDiagnostic = diagnostics(returnedProjection, "returned-local-view.zs")[0];
  assert.equal(returnedDiagnostic.code, "Z0206");
  assert.match(returnedDiagnostic.message, /view method must return a field or indexed element derived directly from this/);

  const nonProjection = `
    struct Item { value: i32; }
    function main(): i32 {
      const item = Item({ value: 42 });
      const alias = view item;
      return alias.value - 42;
    }
  `;
  const projectionDiagnostic = diagnostics(nonProjection, "non-projection-view.zs")[0];
  assert.equal(projectionDiagnostic.code, "Z0206");
  assert.match(projectionDiagnostic.message, /requires a direct field or indexed projection/);

  const contextualName = `
    struct Item { value: i32; }
    function view(value: i32): i32 { return value; }
    function main(): i32 {
      const item = Item({ value: 42 });
      const view = view item.value;
      return view - 42;
    }
  `;
  assert.deepEqual(diagnostics(contextualName, "contextual-view.zs"), []);
  const contextualTokens = decodeSemanticTokens(semanticTokens(contextualName, "contextual-view.zs").data);
  const viewBindingOffset = contextualName.indexOf("const view") + "const ".length;
  const viewOperatorOffset = contextualName.indexOf("= view") + 2;
  const viewUseOffset = contextualName.indexOf("return view") + "return ".length;
  for (const offset of [viewBindingOffset, viewUseOffset]) {
    const position = positionForOffset(contextualName, offset);
    assert.ok(contextualTokens.some((token) => (
      token.line === position.line
      && token.character === position.character
      && token.type === semanticTokenTypes.indexOf("variable")
    )));
  }
  const viewOperatorPosition = positionForOffset(contextualName, viewOperatorOffset);
  assert.ok(contextualTokens.some((token) => (
    token.line === viewOperatorPosition.line
    && token.character === viewOperatorPosition.character
    && token.type === semanticTokenTypes.indexOf("keyword")
  )));
});

test("ties returned parameter views to every possible input owner", () => {
  const source = `
    struct Item {
      value: i32;
    }

    struct Store {
      items: Array<Item>;

      function append(inout this, item: Item): void {
        this.items.push(item);
      }
    }

    function choose(condition: boolean, in left: Store, in right: Store): view Item {
      if (condition) return left.items[0];
      return right.items[0];
    }

    function main(): i32 {
      let left = Store({ items: Array<Item>() });
      let right = Store({ items: Array<Item>() });
      left.append(Item({ value: 20 }));
      right.append(Item({ value: 22 }));

      const selected = choose(true, in left, in right);
      const observed = selected.value;

      left.append(Item({ value: 1 }));
      right.append(Item({ value: 2 }));
      return observed - 20;
    }
  `;

  assert.deepEqual(diagnostics(source, "parameter-views.zs"), []);
  const generated = compileToC(source, "parameter-views.zs");
  assert.match(
    generated,
    /const Z_Item \*\s*_z_function_choose\(bool condition, const Z_Store \*left, const Z_Store \*right\)/,
  );
  assert.match(generated, /return &\([^;]*\(\*left\)[^;]*items[^;]*data[^;]*\);/);
  assert.match(generated, /return &\([^;]*\(\*right\)[^;]*items[^;]*data[^;]*\);/);

  const directory = mkdtempSync("/tmp/z-parameter-views-");
  const fileName = resolve(directory, "main.zs");
  writeFileSync(fileName, source);
  const result = spawnSync(process.execPath, [cli, "run", fileName], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const selectedOffset = source.indexOf("selected =");
  assert.match(
    hover(source, "parameter-views.zs", selectedOffset)?.contents.value ?? "",
    /selected: view Item.*view of left \| right/,
  );

  const leftMutation = source.replace(
    "const observed = selected.value;",
    "left.append(Item({ value: 1 }));\n      const observed = selected.value;",
  );
  const leftDiagnostic = diagnostics(leftMutation, "parameter-view-left-loan.zs")[0];
  assert.equal(leftDiagnostic.code, "Z0205");
  assert.match(leftDiagnostic.message, /cannot mutate "left" while view "selected" is live/);

  const rightMutation = source.replace(
    "const observed = selected.value;",
    "right.append(Item({ value: 2 }));\n      const observed = selected.value;",
  );
  const rightDiagnostic = diagnostics(rightMutation, "parameter-view-right-loan.zs")[0];
  assert.equal(rightDiagnostic.code, "Z0205");
  assert.match(rightDiagnostic.message, /cannot mutate "right" while view "selected" is live/);

  const localReturn = `
    struct Item { value: i32; }
    function invalid(in item: Item): view Item {
      const local = Item({ value: item.value });
      return local;
    }
  `;
  const localDiagnostic = diagnostics(localReturn, "parameter-view-local.zs")[0];
  assert.equal(localDiagnostic.code, "Z0206");
  assert.match(localDiagnostic.message, /requires at least one direct return from an immutable `in` parameter/);

  const classOwner = `
    struct Item { value: i32; }
    class Store { item: Item; }
    function current(in store: Store): view Item {
      return store.item;
    }
  `;
  const classDiagnostic = diagnostics(classOwner, "parameter-view-class.zs")[0];
  assert.equal(classDiagnostic.code, "Z0206");
  assert.match(classDiagnostic.message, /require value-storage owners/);

  const moduleDirectory = mkdtempSync("/tmp/z-parameter-view-modules-");
  const libraryFile = resolve(moduleDirectory, "library.zs");
  const mainFile = resolve(moduleDirectory, "main.zs");
  writeFileSync(libraryFile, `
    export struct Item { value: i32; }
    export struct Store { items: Array<Item>; }
    export function choose(
      first: boolean,
      in left: Store,
      in right: Store
    ): view Item {
      if (first) return left.items[0];
      return right.items[0];
    }
  `);
  writeFileSync(mainFile, `
    import { Item, Store, choose } from "./library.zs";

    function main(): i32 {
      const left = Store({ items: Array<Item>(Item({ value: 20 })) });
      const right = Store({ items: Array<Item>(Item({ value: 22 })) });
      const selected = choose(false, left, right);
      return selected.value - 22;
    }
  `);
  const moduleRun = spawnSync(process.execPath, [cli, "run", mainFile], { encoding: "utf8" });
  assert.equal(moduleRun.status, 0, moduleRun.stderr);
  const nativeCheck = spawnSync(
    process.execPath,
    [cli, "check", mainFile, "--native-frontend"],
    { encoding: "utf8" },
  );
  assert.equal(nativeCheck.status, 0, nativeCheck.stderr);
});

test("preserves optional parameter-view provenance through match and precise last use", () => {
  const example = resolve(
    projectRoot,
    "tests/fixtures/self-host-resolve-parameter-optional-view.zs",
  );
  const source = readFileSync(example, "utf8");
  assert.deepEqual(diagnostics(source, example), []);

  const generated = compileToC(source, example);
  assert.match(generated, /typedef const Z_Document \*Z_Option___z_view_3a_Document;/);
  assert.match(
    generated,
    /findDocument\(int32_t z_id, const Z_Workspace \*active, const Z_Workspace \*archive\)/,
  );
  assert.match(generated, /return &\([^;]*active[^;]*documents[^;]*data/);
  assert.match(generated, /return &\([^;]*archive[^;]*documents[^;]*data/);
  assert.match(generated, /return NULL;/);
  assert.doesNotMatch(generated, /struct Z___z_Option___z_view/);

  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const foundOffset = source.indexOf("found =") + 1;
  assert.match(
    hover(source, example, foundOffset)?.contents.value ?? "",
    /found: Option<view Document>.*view of active \| archive/,
  );
  const payloadOffset = source.indexOf("some(document)") + "some(".length + 1;
  assert.match(
    hover(source, example, payloadOffset)?.contents.value ?? "",
    /document: view Document.*view of active \| archive/,
  );

  const invalidExample = resolve(
    projectRoot,
    "tests/fixtures/self-host-resolve-parameter-optional-view-invalid.zs",
  );
  const invalidSource = readFileSync(invalidExample, "utf8");
  const archiveDiagnostic = diagnostics(invalidSource, invalidExample)[0];
  assert.equal(archiveDiagnostic.code, "Z0205");
  assert.match(archiveDiagnostic.message, /cannot mutate "archive" while view "found" is live/);

  const activeMutation = invalidSource.replace(
    "archive.add(Document({ id: 24 }));",
    "active.add(Document({ id: 24 }));",
  );
  const activeDiagnostic = diagnostics(activeMutation, "optional-parameter-view-active.zs")[0];
  assert.equal(activeDiagnostic.code, "Z0205");
  assert.match(activeDiagnostic.message, /cannot mutate "active" while view "found" is live/);

  const armMutation = source.replace(
    "      const id = document.id;\n      active.add(Document({ id: 24 }));",
    "      active.add(Document({ id: 24 }));\n      const id = document.id;",
  );
  const armDiagnostic = diagnostics(armMutation, "optional-parameter-view-arm.zs")[0];
  assert.equal(armDiagnostic.code, "Z0205");
  assert.match(armDiagnostic.message, /cannot mutate "active" while view "document" is live/);

  const localEscape = `
    struct Document { id: i32; }
    struct Workspace { documents: Array<Document>; }
    function choose(local: boolean, in workspace: Workspace): Option<view Document> {
      if (!local) return Option.some(workspace.documents[0]);
      const document = Document({ id: 42 });
      return Option.some(document);
    }
  `;
  const localDiagnostic = diagnostics(localEscape, "optional-parameter-view-local.zs")[0];
  assert.equal(localDiagnostic.code, "Z0206");
  assert.match(localDiagnostic.message, /must project immutable borrowed storage directly/);
});

test("exposes Map imports, members, and source-level types to editor services", () => {
  const source = `
    import { Map as Dictionary } from "std/collections";
    function main(): i32 {
      let users = Dictionary<String, i32>();
      users.;
      return 0;
    }
  `;
  const importItems = completions(
    source.replace("Map as Dictionary", "Ma"),
    "map-editor.zs",
    source.indexOf("Map as Dictionary") + 2,
  );
  assert.equal(importItems.find((item) => item.label === "Map")?.kind, 22);

  const offset = source.indexOf("users.;") + "users.".length;
  const items = completions(source, "map-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "length: usize");
  assert.match(items.find((item) => item.label === "get")?.detail ?? "", /Option<view i32>/);
  assert.match(items.find((item) => item.label === "remove")?.detail ?? "", /Option<i32>/);
  assert.match(items.find((item) => item.label === "delete")?.detail ?? "", /boolean.*destroys/);
  assert.match(items.find((item) => item.label === "freeze")?.detail ?? "", /readonly Map<String, i32>.*without copying/);

  const valid = source.replace("      users.;", "      users.set(\"answer\", 42);");
  const binding = valid.indexOf("users =");
  assert.match(hover(valid, "map-editor.zs", binding + 1)?.contents.value ?? "", /users: Map<String, i32>/);
  const method = valid.indexOf("set(\"answer") + 1;
  assert.match(hover(valid, "map-editor.zs", method)?.contents.value ?? "", /set\(key: String, value: i32\): void/);

  const identitySource = `
    import { Map } from "std/collections";
    class Session { id: i32; }
    function main(): i32 {
      let sessions = Map<i32, Session>();
      sessions.;
      return 0;
    }
  `;
  const identityOffset = identitySource.indexOf("sessions.;") + "sessions.".length;
  const identityItems = completions(identitySource, "map-identity-editor.zs", identityOffset);
  assert.match(identityItems.find((item) => item.label === "get")?.detail ?? "", /Option<Session>/);
  assert.doesNotMatch(identityItems.find((item) => item.label === "get")?.detail ?? "", /view Session/);

  const handlerSource = `
    import { Map } from "std/collections";
    type Handler = (value: i32) => i32;
    function main(): i32 {
      let handlers = Map<String, Handler>();
      handlers.;
      return 0;
    }
  `;
  const handlerOffset = handlerSource.indexOf("handlers.;") + "handlers.".length;
  const handlerItems = completions(handlerSource, "map-handler-editor.zs", handlerOffset);
  const handlerGet = handlerItems.find((item) => item.label === "get")?.detail ?? "";
  assert.match(handlerGet, /Option<\(value: i32\) => i32>/);
  assert.doesNotMatch(handlerGet, /Option<view/);

  const iteration = `
    import { Map } from "std/collections";
    function main(): i32 {
      let users = Map<String, i32>();
      for (const entry of users) {
        entry.;
      }
      return 0;
    }
  `;
  const entryOffset = iteration.indexOf("entry.;") + "entry.".length;
  const entryItems = completions(iteration, "map-iteration-editor.zs", entryOffset);
  assert.equal(entryItems.find((item) => item.label === "key")?.detail, "String");
  assert.equal(entryItems.find((item) => item.label === "value")?.detail, "i32");
  const validIteration = iteration.replace("entry.;", "const observed = entry.value;");
  const entryBinding = validIteration.indexOf("entry of");
  assert.match(hover(validIteration, "map-iteration-editor.zs", entryBinding + 1)?.contents.value ?? "", /entry: Map\.Entry<String, i32>/);
});

test("moves native C++ values through Map storage and owned removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/map-native-values.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToNative(source, example).source;
  assert.match(generated, /std::construct_at\(&self->entries\.data\[index\]\.value, std::move\(value\)\)/);
  assert.match(generated, /::make_some\(std::move\(self->entries\.data\[index\]\.value\)\)/);
  assert.match(generated, /std::destroy_at\(&self->entries\.data\[last\]\)/);
  assert.match(generated, /return &self->entries\.data\[stored - 1\]\.value/);

  const getOffset = source.indexOf("get(\"primary") + 1;
  assert.match(hover(source, example, getOffset)?.contents.value ?? "", /Option<view native\.zcpp\.UniqueValue>/);

  const moved = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Map<String, native.zcpp.UniqueValue>();
      const resource = native.zcpp.UniqueValue(42);
      values.set("answer", resource);
      return resource.value();
    }
  `;
  assert.equal(diagnostics(moved, example)[0]?.code, "Z0201");

  const borrowed = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/move-only.hpp";
    function main(): i32 {
      let values = Map<String, native.zcpp.UniqueValue>();
      values.set("answer", native.zcpp.UniqueValue(42));
      const found = values.get("answer");
      values.delete("answer");
      return match (in found) { some(resource) => resource.value(); none => 0; };
    }
  `;
  assert.equal(diagnostics(borrowed, example)[0]?.code, "Z0205");

  const copyOnly = `
    import { Map } from "std/collections";
    import native from "../../../tests/fixtures/foreign-values.hpp";
    function main(): i32 {
      const values = Map<i32, native.zcpp.ManagedValue>();
      return 0;
    }
  `;
  assert.match(diagnostics(copyOnly, example)[0]?.message ?? "", /must provide move construction/);
});

test("owns unique Set values with insertion status and deterministic removal", () => {
  const example = resolve(projectRoot, "examples/language/collections/set.zs");
  const source = readFileSync(example, "utf8");
  const result = spawnSync(process.execPath, [cli, "run", example], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const generated = compileToC(source, example);
  assert.match(generated, /Set.*_add\(.*\*self, Z_String value\)/);
  assert.match(generated, /if \(\(value\)\.capacity > 0\) free/);
  assert.match(generated, /Set.*_remove/);
  assert.match(generated, /Set.*_delete/);
  assert.match(generated, /Set.*_rehash/);
  assert.match(generated, /self->values\.data\[last\] = \(Z_String\)\{ 0 \}/);
  assert.match(generated, /< \(openDocuments\)\.values\.length/);
  assert.match(generated, /const Z_String \*path = &/);

  const directory = mkdtempSync("/tmp/z-set-runtime-");
  const input = resolve(directory, "main.zs");
  writeFileSync(input, `
    import { Set } from "std/collections";
    enum Permission { read, write }
    function main(): i32 {
      let permissions = Set<Permission>();
      if (!permissions.add(Permission.read)) return 1;
      if (permissions.add(Permission.read)) return 2;
      if (!permissions.has(Permission.read) || permissions.has(Permission.write)) return 3;
      const removed = permissions.remove(Permission.read);
      return match (removed) { some(value) => value == Permission.read ? 0 : 4; none => 5; };
    }
  `);
  const enumElement = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(enumElement.status, 0, enumElement.stderr);

  const arenaElements = `
    import { Set } from "std/collections";
    import { Hashable, Hasher } from "std/hash";
    import { Arena } from "std/memory";
    struct Coordinate { line: i32; column: i32; }
    readonly struct CoordinateKey implements Hashable {
      coordinate: view Coordinate;
      function equals(in other: CoordinateKey): boolean {
        const current = this.coordinate;
        const candidate = other.coordinate;
        return current.line == candidate.line && current.column == candidate.column;
      }
      function hash(inout hasher: Hasher): void {
        const current = this.coordinate;
        hasher.add(current.line);
        hasher.add(current.column);
      }
    }
    function main(): i32 {
      let arena = Arena();
      const coordinate = arena.create(Coordinate({ line: 20, column: 22 }));
      let keys = Set<CoordinateKey>();
      keys.add(CoordinateKey({ coordinate }));
      const removed = keys.remove(CoordinateKey({ coordinate }));
      const answer = match (in removed) {
        some(key) => {
          const storedCoordinate = key.coordinate;
          select storedCoordinate.line + storedCoordinate.column;
        }
        none => 0;
      };
      const stored = arena.create(keys);
      return answer - 42 + i32(stored.length);
    }
  `;
  assert.deepEqual(diagnostics(arenaElements, "set-arena-elements.zs"), []);
  writeFileSync(input, arenaElements);
  const arenaElementResult = spawnSync(process.execPath, [cli, "run", input], { encoding: "utf8" });
  assert.equal(arenaElementResult.status, 0, arenaElementResult.stderr);

  const mixedArenaSet = arenaElements
    .replace(
      "let arena = Arena();",
      "let arena = Arena();\n      let other = Arena();",
    )
    .replace(
      "let keys = Set<CoordinateKey>();",
      "const second = other.create(Coordinate({ line: 1, column: 2 }));\n      let keys = Set<CoordinateKey>();",
    )
    .replace(
      "keys.add(CoordinateKey({ coordinate }));",
      "keys.add(CoordinateKey({ coordinate }));\n      keys.add(CoordinateKey({ coordinate: second }));",
    );
  assert.match(
    diagnostics(mixedArenaSet, "set-arena-mixed.zs")[0].message,
    /already carries provenance from another Arena/,
  );

  const wrongArenaSet = arenaElements
    .replace("let arena = Arena();", "let arena = Arena();\n      let other = Arena();")
    .replace("const stored = arena.create(keys);", "const stored = other.create(keys);");
  assert.match(
    diagnostics(wrongArenaSet, "set-arena-wrong-region.zs")[0].message,
    /only in the Arena that owns every embedded view/,
  );

  const removedIntoWrongArena = arenaElements
    .replace("let arena = Arena();", "let arena = Arena();\n      let other = Arena();")
    .replace(
      "const stored = arena.create(keys);",
      "const stored = other.create(removed);",
    );
  assert.match(
    diagnostics(removedIntoWrongArena, "set-arena-remove-wrong-region.zs")[0].message,
    /only in the Arena that owns every embedded view/,
  );

  const emptyArenaSet = arenaElements.replace(
    "let keys = Set<CoordinateKey>();",
    "const keys = Set<CoordinateKey>();",
  );
  assert.match(
    diagnostics(emptyArenaSet, "set-arena-empty.zs")[0].message,
    /empty view-bearing Set must use let/,
  );

  const conditionalFirstAdd = arenaElements.replace(
    "keys.add(CoordinateKey({ coordinate }));",
    "if (true) keys.add(CoordinateKey({ coordinate }));",
  );
  assert.match(
    diagnostics(conditionalFirstAdd, "set-arena-conditional-add.zs")[0].message,
    /same Arena provenance on every continuing path/,
  );

  const loopFirstAdd = arenaElements.replace(
    "keys.add(CoordinateKey({ coordinate }));",
    "while (false) { keys.add(CoordinateKey({ coordinate })); }",
  );
  assert.match(
    diagnostics(loopFirstAdd, "set-arena-loop-add.zs")[0].message,
    /first add.*cannot occur in a loop/,
  );

  const immutable = `
    import { Set } from "std/collections";
    function main(): i32 {
      const values = Set<i32>();
      values.add(1);
      return 0;
    }
  `;
  assert.match(diagnostics(immutable, "set-const.zs")[0].message, /Set\.add requires addressable let storage/);

  const movedValue = `
    import { Set } from "std/collections";
    function name(): String { return \`owned value\`; }
    function main(): i32 {
      let values = Set<String>();
      const item = name();
      values.add(item);
      return item.byteLength;
    }
  `;
  assert.match(diagnostics(movedValue, "set-moved-value.zs")[0].message, /use of moved value "item"/);

  const iterationMutation = `
    import { Set } from "std/collections";
    function main(): i32 {
      let values = Set<String>();
      values.add("ready");
      for (const value of values) {
        values.add(copy value);
      }
      return 0;
    }
  `;
  const iterationMutationDiagnostic = diagnostics(iterationMutation, "set-iteration-mutation.zs")[0];
  assert.equal(iterationMutationDiagnostic.code, "Z0311");
  assert.match(iterationMutationDiagnostic.message, /cannot structurally mutate Set "values" while for\.\.\.of is borrowing it/);

  const unsupportedElement = `
    import { Set } from "std/collections";
    function main(): i32 { const values = Set<f64>(); return 0; }
  `;
  assert.match(diagnostics(unsupportedElement, "set-float-element.zs")[0].message, /element type "f64" is not hashable/);

  const missingImport = `function main(): i32 { const values = Set<i32>(); return 0; }`;
  assert.match(diagnostics(missingImport, "set-import.zs")[0].message, /Set requires an explicit standard-library import/);
});

test("exposes Set imports, members, and source-level types to editor services", () => {
  const source = `
    import { Set as UniqueValues } from "std/collections";
    function main(): i32 {
      let values = UniqueValues<String>();
      values.;
      return 0;
    }
  `;
  const importItems = completions(
    source.replace("Set as UniqueValues", "Se"),
    "set-editor.zs",
    source.indexOf("Set as UniqueValues") + 2,
  );
  assert.equal(importItems.find((item) => item.label === "Set")?.kind, 22);

  const offset = source.indexOf("values.;") + "values.".length;
  const items = completions(source, "set-editor.zs", offset);
  assert.equal(items.find((item) => item.label === "length")?.detail, "length: usize");
  assert.match(items.find((item) => item.label === "add")?.detail ?? "", /add\(value: String\): boolean/);
  assert.match(items.find((item) => item.label === "remove")?.detail ?? "", /Option<String>/);
  assert.match(items.find((item) => item.label === "delete")?.detail ?? "", /boolean.*destroys/);
  assert.match(items.find((item) => item.label === "freeze")?.detail ?? "", /readonly Set<String>.*without copying/);

  const valid = source.replace("      values.;", "      values.add(\"ready\");");
  const binding = valid.indexOf("values =");
  assert.match(hover(valid, "set-editor.zs", binding + 1)?.contents.value ?? "", /values: Set<String>/);
  const method = valid.indexOf("add(\"ready") + 1;
  assert.match(hover(valid, "set-editor.zs", method)?.contents.value ?? "", /add\(value: String\): boolean/);

  const iteration = `
    import { Set } from "std/collections";
    function main(): i32 {
      let values = Set<String>();
      for (const value of values) {
        value.;
      }
      return 0;
    }
  `;
  const valueOffset = iteration.indexOf("value.;") + "value.".length;
  const valueItems = completions(iteration, "set-iteration-editor.zs", valueOffset);
  assert.equal(valueItems.find((item) => item.label === "byteLength")?.detail, "usize  // UTF-8 storage bytes");
});

test("freezes owned collections into type-position readonly storage without copying", () => {
  const directory = mkdtempSync("/tmp/z-readonly-collections-");
  const file = resolve(directory, "main.zs");
  try {
    const source = `
      import { Map, Set } from "std/collections";

      function keepRoutes(routes: Map<String, i32>): readonly Map<String, i32> {
        return routes.freeze();
      }

      function freezeValues<T>(values: Array<T>): readonly Array<T> {
        return values.freeze();
      }

      function main(): i32 {
        let routes = Map<String, i32>();
        routes.set("ready", 40);
        const frozenRoutes: readonly Map<String, i32> = keepRoutes(move routes);

        let names = Set<String>();
        names.add("ready");
        const frozenNames: readonly Set<String> = names.freeze();

        let values = Array<i32>(1, 2);
        const frozenValues: readonly Array<i32> = freezeValues(move values);
        return frozenRoutes.has("ready") && frozenNames.has("ready") && frozenValues.length == 2
          ? 0
          : 1;
      }
    `;
    writeFileSync(file, source);
    assert.equal(diagnostics(source, file).length, 0);

    const generated = compileToC(source, file);
    assert.doesNotMatch(generated, /__z_readonly/);
    assert.match(generated, /bool _z_live_frozenRoutes_\d+ = true/);
    assert.match(generated, /bool _z_live_frozenNames_\d+ = true/);
    assert.match(generated, /if \(_z_live_frozenRoutes_\d+\) Z___z_Map_6_Stringi32_deinit/);
    assert.match(generated, /if \(_z_live_frozenNames_\d+\) Z___z_Set_String_deinit/);
    const result = spawnSync(process.execPath, [cli, "run", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const frozenBinding = source.indexOf("frozenRoutes:") + 1;
    assert.match(
      hover(source, file, frozenBinding)?.contents.value ?? "",
      /frozenRoutes: readonly Map<String, i32>/,
    );
    const freezeOffset = source.indexOf("freeze()") + 2;
    assert.match(
      hover(source, file, freezeOffset)?.contents.value ?? "",
      /freeze\(\): readonly Map<String, i32>.*consumes without copying/,
    );
    const completionSource = source.replace(
      'return frozenRoutes.has("ready")',
      "frozenRoutes.;\n        return frozenRoutes.has(\"ready\")",
    );
    const completionOffset = completionSource.indexOf("frozenRoutes.;") + "frozenRoutes.".length;
    const frozenMembers = completions(completionSource, file, completionOffset).map((item) => item.label);
    assert.ok(frozenMembers.includes("length"));
    assert.ok(frozenMembers.includes("has"));
    assert.ok(frozenMembers.includes("get"));
    assert.ok(!frozenMembers.includes("set"));
    assert.ok(!frozenMembers.includes("clear"));
    assert.ok(!frozenMembers.includes("freeze"));

    const readonlyMutation = source.replace(
      "return frozenRoutes.has(\"ready\")",
      "frozenRoutes.clear();\n        return frozenRoutes.has(\"ready\")",
    );
    const mutation = diagnostics(readonlyMutation, file)[0];
    assert.equal(mutation?.code, "Z0207");
    assert.match(mutation?.message ?? "", /readonly Map has no mutating method "clear"/);

    const movedSource = source.replace(
      "const frozenNames: readonly Set<String> = names.freeze();",
      "const frozenNames: readonly Set<String> = names.freeze();\n        names.add(\"late\");",
    );
    assert.match(diagnostics(movedSource, file)[0]?.message ?? "", /use of moved value "names"/);

    const readonlyArrayMutation = source.replace(
      "return frozenRoutes.has(\"ready\")",
      "frozenValues.clear();\n        return frozenRoutes.has(\"ready\")",
    );
    assert.match(
      diagnostics(readonlyArrayMutation, file)[0]?.message ?? "",
      /readonly Array has no mutating method "clear"/,
    );

    const unsupported = `function inspect(value: readonly i32): i32 { return value; }`;
    const unsupportedDiagnostic = diagnostics(unsupported, "readonly-scalar.zs")[0];
    assert.equal(unsupportedDiagnostic?.code, "Z0207");
    assert.match(unsupportedDiagnostic?.message ?? "", /requires Array, Map, or Set/);

    const libraryFile = resolve(directory, "published-routes.zs");
    const consumerFile = resolve(directory, "consumer.zs");
    writeFileSync(libraryFile, `
      import { Map } from "std/collections";
      export type PublishedRoutes = readonly Map<String, i32>;
      export function publish(routes: Map<String, i32>): PublishedRoutes {
        return routes.freeze();
      }
    `);
    writeFileSync(consumerFile, `
      import { Map } from "std/collections";
      import { PublishedRoutes, publish } from "./published-routes.zs";
      function inspect(in routes: PublishedRoutes): boolean { return routes.has("ready"); }
      function main(): i32 {
        let routes = Map<String, i32>();
        routes.set("ready", 42);
        const published: PublishedRoutes = publish(move routes);
        return inspect(published) ? 0 : 1;
      }
    `);
    const moduleResult = spawnSync(process.execPath, [cli, "run", consumerFile], { encoding: "utf8" });
    assert.equal(moduleResult.status, 0, moduleResult.stderr);
    const moduleNativeCheck = spawnSync(
      process.execPath,
      [cli, "check", consumerFile, "--native-frontend"],
      { encoding: "utf8" },
    );
    assert.equal(moduleNativeCheck.status, 0, moduleNativeCheck.stderr);

    const threadFile = resolve(projectRoot, "examples/language/collections/readonly-collections.zs");
    const threadSource = readFileSync(threadFile, "utf8");
    assert.equal(diagnostics(threadSource, threadFile).length, 0);
    const threadResult = spawnSync(process.execPath, [cli, "run", threadFile], { encoding: "utf8" });
    assert.equal(threadResult.status, 0, threadResult.stderr);
    assert.equal(threadResult.stdout, "published route ready=true\n");

    const mutableStorage = threadSource.replace(
      "readonly handlers: readonly Map<String, i32>;",
      "readonly handlers: Map<String, i32>;",
    ).replace("handlers: handlers.freeze(),", "handlers,");
    const mutableStorageDiagnostic = diagnostics(mutableStorage, threadFile)[0];
    assert.equal(mutableStorageDiagnostic?.code, "Z0704");
    assert.match(mutableStorageDiagnostic?.message ?? "", /mutable Map<String, i32> storage/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
