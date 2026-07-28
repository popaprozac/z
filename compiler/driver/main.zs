import console from "std/console";
import { Set } from "std/collections";
import fs from "std/fs";
import process from "std/process";
import { emitModulesC } from "../frontend/c-emitter.zs";
import {
  parseModule,
} from "../frontend/module-graph.zs";
import {
  importedModulePath,
  isLocalModuleHeader,
  normalizedModulePath,
} from "../frontend/module-paths.zs";
import { resolveParsedModules } from "../frontend/module-resolver.zs";
import {
  ModuleGraph,
  ModuleResolveError,
  ModuleSource,
} from "../frontend/semantic-model.zs";
import { ParsedModule } from "../frontend/module-symbols.zs";

struct NativeProject {
  entryPath: String;
  modules: Array<ParsedModule>;
  graph: ModuleGraph;
}

function diagnosticMessage(in error: ModuleResolveError): String {
  return `${error.path}:${error.line}:${error.column}: ${error.message}`;
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
    failure(error) => throw diagnosticMessage(error);
  };

  for (const declaration of parsed.program.imports) {
    if (!isLocalModuleHeader(declaration.header)) continue;
    const dependency = importedModulePath(canonical, declaration.header);
    try loadModule(dependency, inout loaded, inout modules);
  }
  modules.push(parsed);
}

function loadProject(in entryPath: String): NativeProject throws String {
  const normalizedEntry = normalizedModulePath(entryPath);
  const canonicalEntry = try fs.realPath(normalizedEntry);
  let loaded = Set<String>();
  let modules = Array<ParsedModule>();
  try loadModule(canonicalEntry, inout loaded, inout modules);

  const graphOutcome = attempt resolveParsedModules(modules, canonicalEntry);
  const graph = match (graphOutcome) {
    success(graph) => graph;
    failure(error) => throw diagnosticMessage(error);
  };
  return NativeProject({
    entryPath: canonicalEntry,
    modules,
    graph,
  });
}

function emitProject(in project: NativeProject): String throws String {
  return try emitModulesC(project.modules, project.graph);
}

function checkProject(in entryPath: String): i32 throws String {
  const project = try loadProject(entryPath);
  console.log(`checked ${project.modules.length} Z modules`);
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
  in outputPath: String
): i32 throws String {
  const project = try loadProject(entryPath);
  const emitted = try emitProject(project);
  const cPath = `${outputPath}.c`;
  try fs.writeText(cPath, emitted);
  let compilerArguments = Array<String>();
  compilerArguments.push("-x");
  compilerArguments.push("c");
  compilerArguments.push("-std=c11");
  compilerArguments.push("-O0");
  compilerArguments.push("-Wall");
  compilerArguments.push("-Wextra");
  compilerArguments.push("-Werror");
  compilerArguments.push(copy cPath);
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
  in childArguments: Array<String>
): i32 throws String {
  const compilationExitCode = try buildProject(entryPath, outputPath);
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
    console.error("usage: z-native <check|emit|build|run> <entry.zs> [output] [-- args]");
    return 2;
  }

  const command = copy arguments[0];
  if (command == "check") {
    const outcome = attempt checkProject(arguments[1]);
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
    const outcome = attempt buildProject(arguments[1], arguments[2]);
    return reportOutcome(outcome);
  }
  if (command == "run") {
    if (arguments.length < 3) {
      console.error("usage: z-native run <entry.zs> <output> [-- args]");
      return 2;
    }
    let childArguments = Array<String>();
    let index: usize = 3;
    if (arguments.length > 3 && arguments[3] == "--") index = 4;
    while (index < arguments.length) {
      childArguments.push(copy arguments[index]);
      index = index + 1;
    }
    const outcome = attempt runProject(
      arguments[1],
      arguments[2],
      childArguments
    );
    return reportOutcome(outcome);
  }
  console.error(`unknown native compiler command ${command}`);
  return 2;
}
