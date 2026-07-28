import console from "std/console";
import { Set } from "std/collections";
import fs from "std/fs";
import process from "std/process";
import { TextBuffer } from "std/text";
import { emitModulesC } from "../frontend/c-emitter.zs";
import {
  decodeRawForeignDeclarations,
} from "../frontend/foreign-declaration-protocol.zs";
import {
  parseModule,
} from "../frontend/module-graph.zs";
import {
  importedModulePath,
  isLocalModuleHeader,
  isStandardModuleHeader,
  normalizedModulePath,
} from "../frontend/module-paths.zs";
import { resolveParsedModules } from "../frontend/module-resolver.zs";
import {
  appendProjectCompilerArguments,
  loadProjectConfig,
  NativeProjectConfig,
} from "./project-manifest.zs";
import {
  ModuleGraph,
  ModuleResolveError,
  ModuleSource,
} from "../frontend/semantic-model.zs";
import { ParsedModule } from "../frontend/module-symbols.zs";

struct NativeProject {
  entryPath: String;
  config: NativeProjectConfig;
  modules: Array<ParsedModule>;
  graph: ModuleGraph;
}

function sourceDiagnostic(
  in path: String,
  lineNumber: usize,
  columnNumber: usize,
  in message: String,
  in source: String
): String {
  let output = TextBuffer();
  output.append(
    `${path}:${lineNumber}:${columnNumber}: error: ${message}`
  );
  let line: usize = 1;
  let lineStart: usize = 0;
  while (line < lineNumber && lineStart < source.byteLength) {
    if (source.byteAt(lineStart) == 10) line = line + 1;
    lineStart = lineStart + 1;
  }
  if (line != lineNumber) return output.finish();

  let lineEnd = lineStart;
  while (
    lineEnd < source.byteLength
    && source.byteAt(lineEnd) != 10
    && source.byteAt(lineEnd) != 13
  ) {
    lineEnd = lineEnd + 1;
  }
  output.append(`\n${lineNumber} | `);
  output.append(source.copyBytes(lineStart, lineEnd));
  output.append("\n  | ");
  let column: usize = 1;
  while (column < columnNumber) {
    output.append(" ");
    column = column + 1;
  }
  output.append("^");
  return output.finish();
}

function diagnosticMessage(
  in error: ModuleResolveError,
  in source: String
): String {
  const path = copy error.path;
  const line = error.line;
  const column = error.column;
  const message = copy error.message;
  return sourceDiagnostic(
    path,
    line,
    column,
    message,
    source
  );
}

function loadModule(
  in path: String,
  inout loaded: Set<String>,
  inout modules: Array<ParsedModule>
): void throws String {
  const normalized = normalizedModulePath(path);
  const canonical = try fs.realPath(normalized);
  if (loaded.has(canonical)) return;
  loaded.add(copy canonical);

  const source = try fs.readText(canonical);
  const moduleSource = ModuleSource({
    path: copy canonical,
    source,
  });
  const parsedOutcome = attempt parseModule(moduleSource);
  const parsed = match (parsedOutcome) {
    success(parsed) => parsed;
    failure(error) => throw diagnosticMessage(error, moduleSource.source);
  };

  let dependencies = Array<String>();
  for (const declaration of parsed.program.imports) {
    if (isLocalModuleHeader(declaration.header)) {
      dependencies.push(importedModulePath(canonical, declaration.header));
      continue;
    }
    if (isStandardModuleHeader(declaration.header)) continue;
    throw sourceDiagnostic(
      canonical,
      declaration.line,
      declaration.column,
      `native foreign import checking is not implemented for "${declaration.header}"; use the Stage-0 z command until FIIR discovery moves into the native driver`,
      moduleSource.source
    );
  }
  modules.push(parsed);
  for (const dependency of dependencies) {
    try loadModule(dependency, inout loaded, inout modules);
  }
}

function loadProject(in entryPath: String): NativeProject throws String {
  const normalizedEntry = normalizedModulePath(entryPath);
  const canonicalEntry = try fs.realPath(normalizedEntry);
  const config = try loadProjectConfig(canonicalEntry);
  let loaded = Set<String>();
  let modules = Array<ParsedModule>();
  try loadModule(canonicalEntry, inout loaded, inout modules);

  const graphOutcome = attempt resolveParsedModules(modules, canonicalEntry);
  const graph = match (graphOutcome) {
    success(graph) => graph;
    failure(error) => {
      const sourceOutcome = attempt fs.readText(error.path);
      const message = match (sourceOutcome) {
        success(source) => diagnosticMessage(error, source);
        failure(_) => `${error.path}:${error.line}:${error.column}: error: ${error.message}`;
      };
      throw message;
    }
  };
  return NativeProject({
    entryPath: canonicalEntry,
    config,
    modules,
    graph,
  });
}

function validateExecutableEntry(
  in project: NativeProject,
  required: boolean
): void throws String {
  const entry = project.graph.entry;
  for (const declaration of project.modules[entry].program.functions) {
    if (declaration.name != "main") continue;
    if (
      declaration.parameters.length != 0
      || declaration.returnType.name != "i32"
    ) {
      throw `${project.modules[entry].path}:${declaration.line}:${declaration.column}: \`main\` must have signature \`function main(): i32\``;
    }
    match (in declaration.errorType) {
      some(_) => {
        if (!declaration.asynchronous) {
          throw `${project.modules[entry].path}:${declaration.line}:${declaration.column}: \`main\` cannot throw in the bootstrap runtime`;
        }
      }
      none => {}
    }
    return;
  }
  if (required) {
    throw `${project.modules[entry].path}:1:1: program must declare \`function main(): i32\``;
  }
}

function emitProject(in project: NativeProject): String throws String {
  try validateExecutableEntry(project, true);
  return try emitModulesC(project.modules, project.graph);
}

function checkProject(in entryPath: String): i32 throws String {
  const project = try loadProject(entryPath);
  try validateExecutableEntry(project, false);
  console.log(`checked ${project.modules.length} Z modules`);
  return 0;
}

function inspectForeignDeclarations(in streamPath: String): i32 throws String {
  const source = try fs.readText(streamPath);
  const declarations = try decodeRawForeignDeclarations(source);
  console.log(
    `decoded ${declarations.functions.length} foreign functions from ${declarations.producer}`
  );
  return 0;
}

function emitProjectFile(
  in entryPath: String,
  in cPath: String
): i32 throws String {
  const project = try loadProject(entryPath);
  const emitted = try emitProject(project);
  try fs.writeText(cPath, emitted);
  console.log(`emitted ${project.modules.length} Z modules to ${cPath}`);
  return 0;
}

function buildProject(
  in entryPath: String,
  in outputPath: String,
  release: boolean
): i32 throws String {
  const project = try loadProject(entryPath);
  const emitted = try emitProject(project);
  const cPath = `${outputPath}.c`;
  try fs.writeText(cPath, emitted);
  let compilerArguments = Array<String>();
  compilerArguments.push("-x");
  compilerArguments.push("c");
  compilerArguments.push("-std=c11");
  if (release) {
    compilerArguments.push("-O2");
    compilerArguments.push("-DNDEBUG");
  } else {
    compilerArguments.push("-O0");
  }
  compilerArguments.push("-Wall");
  compilerArguments.push("-Wextra");
  compilerArguments.push("-Werror");
  compilerArguments.push(copy cPath);
  try appendProjectCompilerArguments(
    project.config,
    inout compilerArguments
  );
  compilerArguments.push("-o");
  compilerArguments.push(copy outputPath);
  const exitCode = try process.run("clang", compilerArguments);
  if (exitCode == 0) {
    console.log(`compiled ${project.modules.length} Z modules to ${outputPath}`);
  }
  return exitCode;
}

function runProject(
  in entryPath: String,
  in outputPath: String,
  in childArguments: Array<String>,
  release: boolean
): i32 throws String {
  const compilationExitCode = try buildProject(entryPath, outputPath, release);
  if (compilationExitCode != 0) return compilationExitCode;
  return try process.run(outputPath, childArguments);
}

function reportOutcome(outcome: Result<i32, String>): i32 {
  return match (outcome) {
    success(exitCode) => exitCode;
    failure(message) => {
      console.error(`${message}`);
      select 1;
    }
  };
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 2) {
    console.error("usage: z-native <check|emit|build|run|foreign-inspect> <input> [output] [--release] [-- args]");
    return 2;
  }

  const command = copy arguments[0];
  if (command == "check") {
    const outcome = attempt checkProject(arguments[1]);
    return reportOutcome(outcome);
  }
  if (command == "foreign-inspect") {
    const outcome = attempt inspectForeignDeclarations(arguments[1]);
    return reportOutcome(outcome);
  }
  if (command == "emit") {
    if (arguments.length < 3) {
      console.error("usage: z-native emit <entry.zs> <output.c>");
      return 2;
    }
    const outcome = attempt emitProjectFile(arguments[1], arguments[2]);
    return reportOutcome(outcome);
  }
  if (command == "build") {
    if (arguments.length < 3) {
      console.error("usage: z-native build <entry.zs> <output>");
      return 2;
    }
    const release = arguments.length > 3 && arguments[3] == "--release";
    const outcome = attempt buildProject(
      arguments[1],
      arguments[2],
      release
    );
    return reportOutcome(outcome);
  }
  if (command == "run") {
    if (arguments.length < 3) {
      console.error("usage: z-native run <entry.zs> <output> [-- args]");
      return 2;
    }
    let childArguments = Array<String>();
    const release = arguments.length > 3 && arguments[3] == "--release";
    let index: usize = 3;
    if (release) index = 4;
    if (index < arguments.length && arguments[index] == "--") {
      index = index + 1;
    }
    while (index < arguments.length) {
      childArguments.push(copy arguments[index]);
      index = index + 1;
    }
    const outcome = attempt runProject(
      arguments[1],
      arguments[2],
      childArguments,
      release
    );
    return reportOutcome(outcome);
  }
  console.error(`unknown native compiler command ${command}`);
  return 2;
}
