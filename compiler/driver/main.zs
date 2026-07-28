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
  ModuleResolveError,
  ModuleSource,
} from "../frontend/semantic-model.zs";
import { ParsedModule } from "../frontend/module-symbols.zs";

function diagnosticMessage(in error: ModuleResolveError): String {
  return `${error.path}:${error.line}:${error.column}: ${error.message}`;
}

function loadModule(
  in path: String,
  inout loaded: Set<String>,
  inout modules: Array<ParsedModule>
): void throws String {
  const normalized = normalizedModulePath(path);
  if (loaded.has(normalized)) return;
  loaded.add(copy normalized);

  const source = try fs.readText(normalized);
  const moduleSource = ModuleSource({
    path: copy normalized,
    source,
  });
  const parsedOutcome = attempt parseModule(moduleSource);
  const parsed = match (parsedOutcome) {
    success(parsed) => parsed;
    failure(error) => throw diagnosticMessage(error);
  };

  for (const declaration of parsed.program.imports) {
    if (!isLocalModuleHeader(declaration.header)) continue;
    const dependency = importedModulePath(normalized, declaration.header);
    try loadModule(dependency, inout loaded, inout modules);
  }
  modules.push(parsed);
}

function compileProject(
  in entryPath: String,
  in outputPath: String
): i32 throws String {
  const normalizedEntry = normalizedModulePath(entryPath);
  let loaded = Set<String>();
  let modules = Array<ParsedModule>();
  try loadModule(normalizedEntry, inout loaded, inout modules);

  const graphOutcome = attempt resolveParsedModules(modules, normalizedEntry);
  const graph = match (graphOutcome) {
    success(graph) => graph;
    failure(error) => throw diagnosticMessage(error);
  };
  const emitted = try emitModulesC(modules, graph);
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
    console.log(`compiled ${modules.length} Z modules to ${outputPath}`);
  }
  return exitCode;
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 2) {
    console.error("usage: z-native <entry.zs> <output>");
    return 2;
  }

  const outcome = attempt compileProject(arguments[0], arguments[1]);
  return match (outcome) {
    success(exitCode) => exitCode;
    failure(message) => {
      console.error(`${message}`);
      select 1;
    }
  };
}
