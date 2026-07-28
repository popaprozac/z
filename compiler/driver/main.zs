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
  normalizeForeignContracts,
  parseForeignContracts,
} from "../frontend/foreign-contracts.zs";
import {
  parseModule,
} from "../frontend/module-graph.zs";
import {
  importedModulePath,
  isLocalModuleHeader,
  isStandardModuleHeader,
  normalizedModulePath,
} from "../frontend/module-paths.zs";
import {
  resolveParsedModulesWithForeignContracts,
} from "../frontend/module-resolver.zs";
import {
  appendProjectCompilerArguments,
  loadProjectConfig,
  NativeProjectConfig,
} from "./project-manifest.zs";
import {
  ModuleGraph,
  ModuleSource,
} from "../frontend/semantic-model.zs";
import { ParsedModule } from "../frontend/module-symbols.zs";
import {
  NativeForeignModuleContract,
} from "../frontend/semantic-foreign.zs";
import {
  diagnosticMessage,
  sourceDiagnostic,
} from "./diagnostics.zs";
import {
  loadForeignModuleContract,
} from "./foreign-project.zs";

struct NativeProject {
  entryPath: String;
  config: NativeProjectConfig;
  modules: Array<ParsedModule>;
  foreignModules: Array<NativeForeignModuleContract>;
  graph: ModuleGraph;
}

function loadModule(
  in path: String,
  in config: NativeProjectConfig,
  inout loaded: Set<String>,
  inout loadedForeign: Set<String>,
  inout modules: Array<ParsedModule>,
  inout foreignModules: Array<NativeForeignModuleContract>
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
    const header = copy declaration.header;
    const line = declaration.line;
    const column = declaration.column;
    const foreignKey = `${canonical}\n${header}`;
    if (!loadedForeign.has(foreignKey)) {
      loadedForeign.add(copy foreignKey);
      const foreignModule = try loadForeignModuleContract(
        canonical,
        moduleSource.source,
        header,
        line,
        column,
        config
      );
      foreignModules.push(foreignModule);
    }
  }
  modules.push(parsed);
  for (const dependency of dependencies) {
    try loadModule(
      dependency,
      config,
      inout loaded,
      inout loadedForeign,
      inout modules,
      inout foreignModules
    );
  }
}

function loadProject(in entryPath: String): NativeProject throws String {
  const normalizedEntry = normalizedModulePath(entryPath);
  const canonicalEntry = try fs.realPath(normalizedEntry);
  const config = try loadProjectConfig(canonicalEntry);
  let loaded = Set<String>();
  let loadedForeign = Set<String>();
  let modules = Array<ParsedModule>();
  let foreignModules = Array<NativeForeignModuleContract>();
  try loadModule(
    canonicalEntry,
    config,
    inout loaded,
    inout loadedForeign,
    inout modules,
    inout foreignModules
  );

  const graphOutcome = attempt resolveParsedModulesWithForeignContracts(
    modules,
    canonicalEntry,
    foreignModules
  );
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
    foreignModules,
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

function inspectForeignContracts(
  in streamPath: String,
  in header: String,
  in contractPath: String
): i32 throws String {
  const declarationSource = try fs.readText(streamPath);
  const declarations = try decodeRawForeignDeclarations(declarationSource);
  const contractSource = try fs.readText(contractPath);
  const contracts = try parseForeignContracts(contractSource, contractPath);
  const normalized = try normalizeForeignContracts(
    contracts,
    declarations,
    header
  );
  console.log(
    `normalized ${normalized.functions.length} foreign function contracts for ${normalized.moduleSpecifier}`
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

function compileEmittedProject(
  in project: NativeProject,
  in emitted: String,
  in outputPath: String,
  release: boolean
): i32 throws String {
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

function buildLoadedProject(
  in project: NativeProject,
  in outputPath: String,
  release: boolean
): i32 throws String {
  const emitted = try emitProject(project);
  return try compileEmittedProject(
    project,
    emitted,
    outputPath,
    release
  );
}

function buildProject(
  in entryPath: String,
  in outputPath: String,
  release: boolean
): i32 throws String {
  const project = try loadProject(entryPath);
  return try buildLoadedProject(project, outputPath, release);
}

function appendCacheField(
  inout output: TextBuffer,
  in name: String,
  in value: String
): void {
  output.append(name);
  output.appendAscii(0);
  output.append(value);
  output.appendAscii(0);
}

function runCacheMetadata(
  in project: NativeProject,
  in toolchainIdentity: String,
  release: boolean
): String {
  let output = TextBuffer();
  appendCacheField(
    inout output,
    "schema",
    "z-native-run-cache-v1"
  );
  if (release) {
    appendCacheField(inout output, "profile", "release");
  } else {
    appendCacheField(inout output, "profile", "debug");
  }
  appendCacheField(inout output, "entry", project.entryPath);
  appendCacheField(inout output, "directory", project.config.directory);
  appendCacheField(
    inout output,
    "toolchain",
    toolchainIdentity
  );
  match (in project.config.platform) {
    some(platform) => appendCacheField(
      inout output,
      "platform",
      platform
    );
    none => appendCacheField(
      inout output,
      "platform",
      "host-default"
    );
  }
  match (in project.config.minimumVersion) {
    some(version) => appendCacheField(
      inout output,
      "minimum-version",
      version
    );
    none => appendCacheField(
      inout output,
      "minimum-version",
      ""
    );
  }
  for (const directory of project.config.includeDirectories) {
    appendCacheField(inout output, "include", directory);
  }
  for (const directory of project.config.linkDirectories) {
    appendCacheField(inout output, "link-directory", directory);
  }
  for (const library of project.config.linkLibraries) {
    appendCacheField(inout output, "link-library", library);
  }
  for (const foreignModule of project.foreignModules) {
    appendCacheField(
      inout output,
      "foreign-module",
      foreignModule.modulePath
    );
    appendCacheField(
      inout output,
      "foreign-evidence",
      foreignModule.cacheKey
    );
  }
  return output.finish();
}

function loadToolchainIdentity(
  in outputDirectory: String
): String throws String {
  const inputPath = `${outputDirectory}/toolchain-input.c`;
  const outputPath = `${outputDirectory}/toolchain.txt`;
  try fs.writeText(inputPath, "");
  let arguments = Array<String>();
  arguments.push("-dM");
  arguments.push("-E");
  arguments.push("-x");
  arguments.push("c");
  arguments.push(copy inputPath);
  arguments.push("-o");
  arguments.push(copy outputPath);
  const exitCode = try process.run("clang", arguments);
  if (exitCode != 0) {
    throw `could not fingerprint Clang; preprocessor exited with status ${exitCode}`;
  }
  return try fs.readText(outputPath);
}

function runCacheSupported(in project: NativeProject): boolean {
  return project.config.linkLibraries.length == 0;
}

function runCacheMatches(
  in cPath: String,
  in outputPath: String,
  in metadataPath: String,
  in emitted: String,
  in metadata: String
): boolean {
  if (
    !fs.exists(cPath)
    || !fs.exists(outputPath)
    || !fs.exists(metadataPath)
  ) return false;
  const cachedSource = attempt fs.readText(cPath);
  const sourceMatches = match (cachedSource) {
    success(source) => source == emitted;
    failure(_) => false;
  };
  if (!sourceMatches) return false;
  const cachedMetadata = attempt fs.readText(metadataPath);
  return match (cachedMetadata) {
    success(found) => found == metadata;
    failure(_) => false;
  };
}

function runProject(
  in entryPath: String,
  in childArguments: Array<String>,
  release: boolean
): i32 throws String {
  const project = try loadProject(entryPath);
  const outputDirectory = `${project.config.directory}/.z-cache/run`;
  try fs.createDirectories(outputDirectory);
  const outputPath = `${outputDirectory}/program`;
  const cPath = `${outputPath}.c`;
  const metadataPath = `${outputPath}.meta`;
  const emitted = try emitProject(project);
  const toolchainIdentity = try loadToolchainIdentity(outputDirectory);
  const metadata = runCacheMetadata(
    project,
    toolchainIdentity,
    release
  );
  const cacheSupported = runCacheSupported(project);
  if (
    cacheSupported
    && runCacheMatches(
      cPath,
      outputPath,
      metadataPath,
      emitted,
      metadata
    )
  ) {
    console.log(`cache hit: reused ${outputPath}`);
  } else {
    if (!cacheSupported) {
      console.log(
        "cache bypass: configured native libraries are not fingerprinted yet"
      );
    }
    try fs.writeText(metadataPath, "incomplete\n");
    const compilationExitCode = try compileEmittedProject(
      project,
      emitted,
      outputPath,
      release
    );
    if (compilationExitCode != 0) return compilationExitCode;
    try fs.writeText(metadataPath, metadata);
  }
  return try process.run(outputPath, childArguments);
}

function reportOutcome(outcome: Result<i32, String>): i32 {
  return match (outcome) {
    success(exitCode) => exitCode;
    failure(message) => {
      console.error(message);
      select 1;
    }
  };
}

function main(): i32 {
  const arguments = process.args();
  if (arguments.length < 2) {
    console.error("usage: z-native <check|emit|build|run|foreign-inspect|foreign-contract-inspect> <input> [output] [--release] [-- args]");
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
  if (command == "foreign-contract-inspect") {
    if (arguments.length != 4) {
      console.error("usage: z-native foreign-contract-inspect <declarations.zfdcl> <header> <contract.zd>");
      return 2;
    }
    const outcome = attempt inspectForeignContracts(
      arguments[1],
      arguments[2],
      arguments[3]
    );
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
    if (arguments.length < 2) {
      console.error("usage: z-native run <entry.zs> [--release] [-- args]");
      return 2;
    }
    let childArguments = Array<String>();
    const release = arguments.length > 2 && arguments[2] == "--release";
    let index: usize = 2;
    if (release) index = 3;
    if (index < arguments.length && arguments[index] == "--") {
      index = index + 1;
    }
    while (index < arguments.length) {
      childArguments.push(copy arguments[index]);
      index = index + 1;
    }
    const outcome = attempt runProject(
      arguments[1],
      childArguments,
      release
    );
    return reportOutcome(outcome);
  }
  console.error(`unknown native compiler command ${command}`);
  return 2;
}
