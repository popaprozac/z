import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { basename, delimiter, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { test as bunTest } from "bun:test";
import {
  analyzeSource,
  check,
  compileTestsToNative,
  compileToC,
  compileToNative,
} from "../../compiler/src/compiler.ts";
import {
  DiagnosticError,
  formatDiagnostic,
} from "../../compiler/src/diagnostics.ts";
import {
  ApiNoteConflictError,
  mergeApiNotes,
} from "../../compiler/src/foreign-api-notes.ts";
import { normalizeForeignContracts } from "../../compiler/src/foreign-contracts.ts";
import { encodeForeignFunctionDeclarationStream } from "../../compiler/src/foreign-declaration-protocol.ts";
import { writeForeignDeclarationArtifact } from "../../compiler/src/foreign-adapter.ts";
import { resolveForeignFunctionDeclarationStreams } from "../../compiler/src/foreign.ts";
import { buildStage0ModuleGraph } from "../../compiler/src/native-semantic-parity.ts";
import { NativeFrontendDiagnosticError } from "../../compiler/src/native-frontend-diagnostics.ts";
import {
  isProcessOutputOverflowError,
  runWithBufferedStdoutOrSpill,
} from "../../compiler/src/process-output.ts";
import {
  decodeStage1DeclarationStream,
  decodeStage1ModuleGraphStream,
  decodeStage1ProgramBatchStream,
  decodeStage1ProgramStream,
  decodeStage1TokenStream,
  encodeStage1ModuleBatch,
} from "../../compiler/src/self-hosting.ts";
import {
  completions,
  definition,
  diagnostics,
  hover,
  semanticTokens,
  semanticTokenTypes,
} from "../../compiler/src/language-service.ts";

export type { ImportDeclaration } from "../../compiler/src/ast.ts";
export type {
  ForeignFunctionDeclaration,
  ForeignModuleDeclarations,
} from "../../compiler/src/foreign-ir.ts";

export {
  ApiNoteConflictError,
  DiagnosticError,
  NativeFrontendDiagnosticError,
  analyzeSource,
  assert,
  basename,
  buildStage0ModuleGraph,
  check,
  cli,
  compileTestsToNative,
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
  bindGeneratedNames,
  yieldFrameName,
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
  swiftModuleCacheArguments,
  test,
  utimesSync,
  writeFileSync,
  writeForeignDeclarationArtifact,
};

const projectRoot = resolve(dirnameFromImportMeta(), "../..");
const cli = resolve(projectRoot, "compiler/src/cli.ts");
if (process.platform === "darwin") {
  process.env.CLANG_MODULE_CACHE_PATH ??= resolve(
    projectRoot,
    ".z-cache/test-toolchain/clang",
  );
  process.env.SWIFT_MODULECACHE_PATH ??= resolve(
    projectRoot,
    ".z-cache/test-toolchain/swift",
  );
  mkdirSync(process.env.CLANG_MODULE_CACHE_PATH, { recursive: true });
  mkdirSync(process.env.SWIFT_MODULECACHE_PATH, { recursive: true });
}

// Generated function and yield-frame names are private identities, not a
// native ABI: a function is emitted as `_z_function_<name>` (Stage 0) or
// `_z_function_<index>_<name>` (native), and its yield frame is named after
// that identity (`_z_stage1_yield__z_function_0_listen`). Harness C written
// against source names is bound to the identities the generated C declares.
function yieldFrameName(source: string, name: string): string | undefined {
  const pattern = new RegExp(`typedef struct (_z_stage1_yield_(?:_?_z_(?:module|function)_\\d+_)*${name}) \\{`);
  return pattern.exec(source)?.[1];
}

// Frame references (`_z_stage1_yield_listen_start`, `_z_stage1_yield_listen *`)
// are bound anywhere. Calls of Z functions by source name (`launch()`) are
// bound only in the hand-written harness after the last `#undef main`.
function bindGeneratedNames(text: string): string {
  const frames = new Map<string, string>();
  for (const match of text.matchAll(/typedef struct (_z_stage1_yield_(?:_?_z_(?:module|function)_\d+_)*([A-Za-z][A-Za-z0-9]*)) \{/g)) {
    frames.set(match[2], match[1]);
  }
  const bound = text.replace(/\b_z_stage1_yield_([A-Za-z][A-Za-z0-9]*)/g, (whole, name: string) => frames.get(name) ?? whole);
  const split = bound.lastIndexOf("\n#undef main");
  if (split < 0) return bound;
  const functions = new Map<string, string>();
  for (const match of bound.slice(0, split).matchAll(/\b(_z_function_(?:\d+_)?([A-Za-z][A-Za-z0-9]*))\(/g)) {
    functions.set(match[2], match[1]);
  }
  const harness = bound.slice(split).replace(
    /(?<![\w.>])([A-Za-z][A-Za-z0-9]*)(?=\()/g,
    (whole, name: string) => functions.get(name) ?? whole,
  );
  return bound.slice(0, split) + harness;
}

function hostToolchainTest(
  name: string,
  callback: () => void | Promise<void>,
  timeout?: number,
): void {
  test(name, callback, timeout);
}

function test(
  name: string,
  callback: () => void | Promise<void>,
  timeout?: number,
): void {
  if (timeout === undefined) {
    bunTest(name, callback);
    return;
  }

  bunTest(name, callback, process.env.CI ? timeout * 4 : timeout);
}

function swiftModuleCacheArguments(): string[] {
  const path = process.env.SWIFT_MODULECACHE_PATH;
  return path ? ["-module-cache-path", path] : [];
}

function decodeSemanticTokens(data: readonly number[]): Array<{
  readonly line: number;
  readonly character: number;
  readonly length: number;
  readonly type: number;
  readonly modifiers: number;
}> {
  const decoded = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    line += data[index];
    character = data[index] === 0 ? character + data[index + 1] : data[index + 1];
    decoded.push({
      line,
      character,
      length: data[index + 2],
      type: data[index + 3],
      modifiers: data[index + 4],
    });
  }
  return decoded;
}

function positionForOffset(
  source: string,
  offset: number,
): { readonly line: number; readonly character: number } {
  const lines = source.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

function dirnameFromImportMeta(): string {
  return new URL(".", import.meta.url).pathname;
}
