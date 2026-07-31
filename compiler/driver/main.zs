import console from "std/console";
import { Set } from "std/collections";
import fs from "std/fs";
import process from "std/process";
import { TextBuffer } from "std/text";
import {
  emitLibraryModulesC,
  emitLibraryModulesCHeader,
  emitModulesC,
  emitTestModulesC,
} from "../frontend/c-emitter.zs";
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
  directoryName,
  isLocalModuleHeader,
  isStandardModuleHeader,
  normalizedModulePath,
} from "../frontend/module-paths.zs";
import {
  resolveParsedModulesWithForeignContracts,
} from "../frontend/module-resolver.zs";
import {
  appendProjectCompilerArguments,
  appendProjectCompileArguments,
  configuredProjectEntryPath,
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
import { sha256 } from "./content-hash.zs";

struct NativeProject {
  entryPath: String;
  config: NativeProjectConfig;
  modules: Array<ParsedModule>;
  foreignModules: Array<NativeForeignModuleContract>;
  graph: ModuleGraph;
}

struct RunCacheMetadata {
  value: String;
  reusable: boolean;
}

struct NativeCommandInput {
  entryPath: String;
  projectMode: boolean;
}

function hasPathSuffix(in path: String, in suffix: String): boolean {
  if (path.byteLength < suffix.byteLength) return false;
  return (
    path.copyBytes(path.byteLength - suffix.byteLength, path.byteLength)
    == suffix
  );
}

function isZSourceInput(in path: String): boolean {
  return hasPathSuffix(path, ".zs");
}

function isProjectManifestInput(in path: String): boolean {
  return (
    path == "z.json"
    || hasPathSuffix(path, "/z.json")
    || hasPathSuffix(path, "\\z.json")
  );
}

function isOptionArgument(in argument: String): boolean {
  return (
    argument.byteLength >= 2
    && argument.byteAt(0) == 45
    && argument.byteAt(1) == 45
  );
}

function resolveCommandInput(
  in suppliedPath: String
): NativeCommandInput throws String {
  let normalized = normalizedModulePath(suppliedPath);
  if (normalized.byteLength == 0 && suppliedPath == ".") normalized = ".";
  if (isZSourceInput(normalized)) {
    return NativeCommandInput({
      entryPath: normalized,
      projectMode: false,
    });
  }

  let probe = "";
  if (fs.isDirectory(normalized)) {
    probe = normalizedModulePath(`${normalized}/__z_project_probe.zs`);
  } else if (isProjectManifestInput(normalized)) {
    if (!fs.exists(normalized) || fs.isDirectory(normalized)) {
      throw `project manifest "${normalized}" does not exist`;
    }
    const manifestDirectory = directoryName(normalized);
    probe = normalizedModulePath(
      `${manifestDirectory}/__z_project_probe.zs`
    );
  } else {
    throw `expected a .zs source file, project directory, or z.json manifest, found "${suppliedPath}"`;
  }

  const config = try loadProjectConfig(probe);
  const entryPath = try configuredProjectEntryPath(config);
  return NativeCommandInput({
    entryPath: normalizedModulePath(entryPath),
    projectMode: true,
  });
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

function emitProject(
  in project: NativeProject,
  requireMain: boolean
): String throws String {
  try validateExecutableEntry(project, requireMain);
  return try emitModulesC(project.modules, project.graph);
}

function checkProject(in entryPath: String): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  const project = try loadProject(input.entryPath);
  try validateExecutableEntry(project, false);
  if (input.projectMode) {
    if (project.config.targetKind == "executable") {
      try validateExecutableEntry(project, true);
    } else if (
      (
        project.config.targetKind == "static-library"
        || project.config.targetKind == "shared-library"
      )
      && !hasNativeCExport(project)
    ) {
      throw `a ${project.config.targetKind} project must declare at least one \`export c function\``;
    }
  }
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
  if (!isZSourceInput(entryPath)) {
    throw "z emit currently requires an explicit .zs source file and output path";
  }
  const project = try loadProject(entryPath);
  const emitted = try emitProject(project, true);
  try fs.writeText(cPath, emitted);
  console.log(`emitted ${project.modules.length} Z modules to ${cPath}`);
  return 0;
}

function emitProjectStandardOutput(in entryPath: String): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  const project = try loadProject(input.entryPath);
  const emitted = try emitProject(
    project,
    project.config.targetKind == "executable"
  );
  console.write(emitted);
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
  return try process.run("clang", compilerArguments);
}

function buildLoadedProject(
  in project: NativeProject,
  in outputPath: String,
  release: boolean
): i32 throws String {
  const emitted = try emitProject(project, true);
  const exitCode = try compileEmittedProject(
    project,
    emitted,
    outputPath,
    release
  );
  if (exitCode == 0) {
    console.log(`compiled ${project.modules.length} Z modules to ${outputPath}`);
  }
  return exitCode;
}

function buildProject(
  in entryPath: String,
  in outputPath: String,
  release: boolean
): i32 throws String {
  const project = try loadProject(entryPath);
  return try buildLoadedProject(project, outputPath, release);
}

function testProject(in entryPath: String): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  const project = try loadProject(input.entryPath);
  const emitted = try emitTestModulesC(project.modules, project.graph);
  const outputDirectory = `${project.config.directory}/.z-cache/test`;
  try fs.createDirectories(outputDirectory);
  const outputPath = `${outputDirectory}/tests`;
  const compilationExitCode = try compileEmittedProject(
    project,
    emitted,
    outputPath,
    false
  );
  if (compilationExitCode != 0) return compilationExitCode;
  const arguments = Array<String>();
  return try process.run(outputPath, arguments);
}

function hasNativeCExport(in project: NativeProject): boolean {
  for (const module of project.modules) {
    for (const declaration of module.program.functions) {
      if (declaration.nativeCExport) return true;
    }
  }
  return false;
}

function requiredProjectTargetName(
  in project: NativeProject
): String throws String {
  return match (in project.config.targetName) {
    some(name) => name.copyBytes(0, name.byteLength);
    none => throw `a ${project.config.targetKind} project requires target.name`;
  };
}

function embeddedRuntimeSymbolPart(in targetName: String): String {
  let output = TextBuffer();
  let index: usize = 0;
  while (index < targetName.byteLength) {
    const byte = targetName.byteAt(index);
    if (byte == 45) output.appendAscii(95);
    else output.appendAscii(byte);
    index = index + 1;
  }
  return output.finish();
}

function validateEmbeddedRuntimeNames(
  in project: NativeProject,
  in targetName: String
): void throws String {
  const prefix = embeddedRuntimeSymbolPart(targetName);
  const initialize = `${prefix}_runtime_initialize`;
  const shutdown = `${prefix}_runtime_shutdown`;
  const status = `${prefix}_runtime_status`;
  const config = `${prefix}_runtime_config`;
  const enqueue = `${prefix}_runtime_enqueue_release`;
  for (const module of project.modules) {
    for (const declaration of module.program.functions) {
      if (
        declaration.nativeCExport
        && (declaration.name == initialize || declaration.name == shutdown)
      ) {
        throw `C export name "${declaration.name}" collides with the generated runtime contract for target "${targetName}"`;
      }
    }
    for (const declaration of module.program.aggregates) {
      if (
        declaration.nativeCLayout
        && (
          declaration.name == status
          || declaration.name == config
          || declaration.name == enqueue
        )
      ) {
        throw `public C type name "${declaration.name}" collides with the generated runtime contract for target "${targetName}"`;
      }
    }
    for (const declaration of module.program.enums) {
      if (
        declaration.nativeCLayout
        && (
          declaration.name == status
          || declaration.name == config
          || declaration.name == enqueue
        )
      ) {
        throw `public C type name "${declaration.name}" collides with the generated runtime contract for target "${targetName}"`;
      }
    }
  }
}

function validateRuntimeInitializer(
  in project: NativeProject,
  in name: String
): boolean throws String {
  const entry = project.graph.entry;
  for (const declaration of project.modules[entry].program.functions) {
    if (declaration.name != name) continue;
    const path = copy project.modules[entry].path;
    const prefix = `${path}:${declaration.line}:${declaration.column}: error:`;
    if (declaration.parameters.length != 0) {
      throw `${prefix} a runtime initializer cannot accept parameters in the first tier`;
    }
    if (declaration.asynchronous) {
      throw `${prefix} a runtime initializer cannot be async in the first tier`;
    }
    match (in declaration.errorType) {
      some(_) => throw `${prefix} a runtime initializer cannot throw in the first tier`;
      none => {}
    }
    if (declaration.typeParameters.length != 0) {
      throw `${prefix} a runtime initializer cannot be generic`;
    }
    if (declaration.nativeCExport) {
      throw `${prefix} a runtime initializer is selected by z.json and cannot also be a public C export`;
    }
    if (declaration.returnType.name == "void") {
      throw `${prefix} a runtime initializer must return one cleanup-bearing owner`;
    }
    return declaration.executorAffinity.byteLength > 0;
  }
  throw `${project.modules[entry].path}:1:1: error: runtime initializer "${name}" was not found in the target entry module`;
}

function configuredRuntimeInitializer(
  in project: NativeProject,
  inout name: String
): boolean throws String {
  return match (in project.config.runtimeInitializer) {
    some(configured) => {
      name = configured.copyBytes(0, configured.byteLength);
      return try validateRuntimeInitializer(project, configured);
    }
    none => false;
  };
}

function buildStaticLibrary(
  in project: NativeProject,
  release: boolean
): i32 throws String {
  if (!hasNativeCExport(project)) {
    throw "a static-library project must declare at least one `export c function`";
  }
  const targetName = try requiredProjectTargetName(project);
  try validateEmbeddedRuntimeNames(project, targetName);
  let runtimeInitializerName = "";
  const runtimeRequiresMain = try configuredRuntimeInitializer(
    project,
    inout runtimeInitializerName
  );
  const emitted = try emitLibraryModulesC(
    project.modules,
    project.graph,
    targetName,
    runtimeInitializerName,
    runtimeRequiresMain
  );
  const header = try emitLibraryModulesCHeader(
    project.modules,
    project.graph,
    targetName,
    runtimeRequiresMain
  );
  const outputDirectory = normalizedModulePath(
    `${project.config.directory}/build`
  );
  const cacheDirectory = normalizedModulePath(
    `${project.config.directory}/.z-cache/build`
  );
  try fs.createDirectories(outputDirectory);
  try fs.createDirectories(cacheDirectory);
  const cPath = `${cacheDirectory}/${targetName}.c`;
  const objectPath = `${cacheDirectory}/${targetName}.o`;
  const libraryPath = `${outputDirectory}/lib${targetName}.a`;
  const headerPath = `${outputDirectory}/${targetName}.h`;
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
  try appendProjectCompileArguments(
    project.config,
    inout compilerArguments
  );
  compilerArguments.push("-c");
  compilerArguments.push(copy cPath);
  compilerArguments.push("-o");
  compilerArguments.push(copy objectPath);
  const compilationExitCode = try process.run("clang", compilerArguments);
  if (compilationExitCode != 0) return compilationExitCode;

  let archiveArguments = Array<String>();
  archiveArguments.push("rcs");
  archiveArguments.push(copy libraryPath);
  archiveArguments.push(copy objectPath);
  const archiveExitCode = try process.run("ar", archiveArguments);
  if (archiveExitCode != 0) return archiveExitCode;
  try fs.writeText(headerPath, header);
  console.log(`built ${libraryPath}`);
  console.log(`generated ${headerPath}`);
  return 0;
}

function sharedLibraryExtension(
  in config: NativeProjectConfig
): String {
  let extension = ".dylib";
  match (in config.platform) {
    some(platform) => {
      if (platform == "windows") extension = ".dll";
      else if (platform != "macos") extension = ".so";
    }
    // The fixed-point bootstrap is currently proven on macOS. The future
    // std/target layer will make this host default intrinsic.
    none => {}
  }
  return extension;
}

function sharedLibraryPrefix(
  in config: NativeProjectConfig
): String {
  let prefix = "lib";
  match (in config.platform) {
    some(platform) => {
      if (platform == "windows") prefix = "";
    }
    none => {}
  }
  return prefix;
}

function buildSharedLibrary(
  in project: NativeProject,
  release: boolean
): i32 throws String {
  if (!hasNativeCExport(project)) {
    throw "a shared-library project must declare at least one `export c function`";
  }
  const targetName = try requiredProjectTargetName(project);
  try validateEmbeddedRuntimeNames(project, targetName);
  let runtimeInitializerName = "";
  const runtimeRequiresMain = try configuredRuntimeInitializer(
    project,
    inout runtimeInitializerName
  );
  const emitted = try emitLibraryModulesC(
    project.modules,
    project.graph,
    targetName,
    runtimeInitializerName,
    runtimeRequiresMain
  );
  const header = try emitLibraryModulesCHeader(
    project.modules,
    project.graph,
    targetName,
    runtimeRequiresMain
  );
  const outputDirectory = normalizedModulePath(
    `${project.config.directory}/build`
  );
  const cacheDirectory = normalizedModulePath(
    `${project.config.directory}/.z-cache/build`
  );
  try fs.createDirectories(outputDirectory);
  try fs.createDirectories(cacheDirectory);
  const cPath = `${cacheDirectory}/${targetName}.c`;
  const prefix = sharedLibraryPrefix(project.config);
  const extension = sharedLibraryExtension(project.config);
  const libraryPath = `${outputDirectory}/${prefix}${targetName}${extension}`;
  const headerPath = `${outputDirectory}/${targetName}.h`;
  try fs.writeText(cPath, emitted);

  let compilerArguments = Array<String>();
  compilerArguments.push("-x");
  compilerArguments.push("c");
  compilerArguments.push("-std=c11");
  compilerArguments.push("-shared");
  compilerArguments.push("-fPIC");
  compilerArguments.push("-fvisibility=hidden");
  compilerArguments.push(
    "-DZ_API=__attribute__((visibility(\"default\")))"
  );
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
  compilerArguments.push(copy libraryPath);
  const compilationExitCode = try process.run("clang", compilerArguments);
  if (compilationExitCode != 0) return compilationExitCode;
  try fs.writeText(headerPath, header);
  console.log(`built ${libraryPath}`);
  console.log(`generated ${headerPath}`);
  return 0;
}

function buildExecutableTarget(
  in project: NativeProject,
  release: boolean
): i32 throws String {
  try validateExecutableEntry(project, true);
  const targetName = try requiredProjectTargetName(project);
  const emitted = try emitModulesC(project.modules, project.graph);
  const outputDirectory = normalizedModulePath(
    `${project.config.directory}/build`
  );
  const cacheDirectory = normalizedModulePath(
    `${project.config.directory}/.z-cache/build`
  );
  try fs.createDirectories(outputDirectory);
  try fs.createDirectories(cacheDirectory);
  const cachedOutputPath = `${cacheDirectory}/${targetName}`;
  const outputPath = `${outputDirectory}/${targetName}`;
  const exitCode = try compileEmittedProject(
    project,
    emitted,
    cachedOutputPath,
    release
  );
  if (exitCode != 0) return exitCode;
  try fs.replace(cachedOutputPath, outputPath);
  console.log(`built ${outputPath}`);
  return 0;
}

function buildManifestProject(
  in projectPath: String,
  release: boolean
): i32 throws String {
  const input = try resolveCommandInput(projectPath);
  if (!input.projectMode) {
    throw "project build expects a directory or z.json manifest; use `z build <entry.zs> <output>` for the compatibility file build";
  }
  const project = try loadProject(input.entryPath);
  try validateExecutableEntry(project, false);
  if (project.config.targetKind == "executable") {
    return try buildExecutableTarget(project, release);
  }
  if (project.config.targetKind == "static-library") {
    return try buildStaticLibrary(project, release);
  }
  if (project.config.targetKind == "shared-library") {
    return try buildSharedLibrary(project, release);
  }
  throw `unsupported project target kind "${project.config.targetKind}"`;
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

function resolvedNativeLibrary(
  in config: NativeProjectConfig,
  in library: String
): Option<String> {
  for (const directory of config.linkDirectories) {
    let candidates = Array<String>();
    candidates.push(`${directory}/lib${library}.tbd`);
    candidates.push(`${directory}/lib${library}.dylib`);
    candidates.push(`${directory}/lib${library}.so`);
    candidates.push(`${directory}/lib${library}.a`);
    candidates.push(`${directory}/${library}.lib`);
    candidates.push(`${directory}/lib${library}.lib`);
    candidates.push(`${directory}/lib${library}.dll.a`);
    let selected = "";
    for (const candidate of candidates) {
      if (!fs.exists(candidate) || fs.isDirectory(candidate)) continue;
      if (selected.byteLength > 0) return Option<String>.none;
      selected = copy candidate;
    }
    if (selected.byteLength > 0) return Option.some(selected);
  }
  return Option<String>.none;
}

function appendNativeLibraryEvidence(
  in project: NativeProject,
  inout output: TextBuffer
): boolean throws String {
  for (const library of project.config.linkLibraries) {
    const path = match (resolvedNativeLibrary(
      project.config,
      library
    )) {
      some(path) => path;
      none => return false;
    };
    const bytes = try fs.readBytes(path);
    const digest = sha256(bytes);
    appendCacheField(inout output, "native-library", path);
    appendCacheField(
      inout output,
      "native-library-sha256",
      digest
    );
  }
  return true;
}

function runCacheMetadata(
  in project: NativeProject,
  in toolchainIdentity: String,
  release: boolean
): RunCacheMetadata throws String {
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
  const reusable = try appendNativeLibraryEvidence(
    project,
    inout output
  );
  return RunCacheMetadata({
    value: output.finish(),
    reusable,
  });
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
  const input = try resolveCommandInput(entryPath);
  const project = try loadProject(input.entryPath);
  if (
    input.projectMode
    && project.config.targetKind != "executable"
  ) {
    throw `z run requires an executable project, but target.kind is "${project.config.targetKind}"`;
  }
  const outputDirectory = `${project.config.directory}/.z-cache/run`;
  try fs.createDirectories(outputDirectory);
  const outputPath = `${outputDirectory}/program`;
  const cPath = `${outputPath}.c`;
  const metadataPath = `${outputPath}.meta`;
  const pendingOutputPath = `${outputPath}.pending`;
  const pendingCPath = `${pendingOutputPath}.c`;
  const pendingMetadataPath = `${metadataPath}.pending`;
  const cacheLock = try fs.lock(`${outputPath}.lock`);
  const emitted = try emitProject(project, true);
  const toolchainIdentity = try loadToolchainIdentity(outputDirectory);
  const cacheMetadata = try runCacheMetadata(
    project,
    toolchainIdentity,
    release
  );
  const cacheSupported = cacheMetadata.reusable;
  const metadata = copy cacheMetadata.value;
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
        "cache bypass: could not resolve every configured native library unambiguously"
      );
    }
    // Invalidate the cache record before replacing either stable artifact.
    // Publishing the complete metadata record last is the commit point.
    try fs.writeText(pendingMetadataPath, "incomplete\n");
    try fs.replace(pendingMetadataPath, metadataPath);
    const compilationExitCode = try compileEmittedProject(
      project,
      emitted,
      pendingOutputPath,
      release
    );
    if (compilationExitCode != 0) return compilationExitCode;
    try fs.replace(pendingCPath, cPath);
    try fs.replace(pendingOutputPath, outputPath);
    try fs.writeText(pendingMetadataPath, metadata);
    try fs.replace(pendingMetadataPath, metadataPath);
    console.log(`compiled ${project.modules.length} Z modules to ${outputPath}`);
  }
  cacheLock.unlock();
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
  if (arguments.length < 1) {
    console.error("usage: z <check|test|emit|build|run|foreign-inspect|foreign-contract-inspect> [input] [output] [--release] [-- args]");
    return 2;
  }

  const command = copy arguments[0];
  if (command == "check") {
    if (arguments.length > 2) {
      console.error("usage: z check [entry.zs|project]");
      return 2;
    }
    if (arguments.length == 2 && isOptionArgument(arguments[1])) {
      console.error(`unknown check option ${arguments[1]}`);
      return 2;
    }
    let inputPath = ".";
    if (arguments.length == 2) inputPath = copy arguments[1];
    const outcome = attempt checkProject(inputPath);
    return reportOutcome(outcome);
  }
  if (command == "test") {
    if (arguments.length > 2) {
      console.error("usage: z test [entry.zs|project]");
      return 2;
    }
    if (arguments.length == 2 && isOptionArgument(arguments[1])) {
      console.error(`unknown test option ${arguments[1]}`);
      return 2;
    }
    let inputPath = ".";
    if (arguments.length == 2) inputPath = copy arguments[1];
    const outcome = attempt testProject(inputPath);
    return reportOutcome(outcome);
  }
  if (command == "foreign-inspect") {
    if (arguments.length != 2) {
      console.error("usage: z foreign-inspect <declarations.zfdcl>");
      return 2;
    }
    const outcome = attempt inspectForeignDeclarations(arguments[1]);
    return reportOutcome(outcome);
  }
  if (command == "foreign-contract-inspect") {
    if (arguments.length != 4) {
      console.error("usage: z foreign-contract-inspect <declarations.zfdcl> <header> <contract.zd>");
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
    if (arguments.length < 1 || arguments.length > 3) {
      console.error("usage: z emit [entry.zs | project-directory | z.json]");
      console.error("       z emit <entry.zs> <output.c>");
      return 2;
    }
    if (arguments.length == 1) {
      const outcome = attempt emitProjectStandardOutput(".");
      return reportOutcome(outcome);
    }
    if (arguments.length == 2) {
      const outcome = attempt emitProjectStandardOutput(arguments[1]);
      return reportOutcome(outcome);
    }
    const outcome = attempt emitProjectFile(
      arguments[1],
      arguments[2]
    );
    return reportOutcome(outcome);
  }
  if (command == "build") {
    const compatibilityFileBuild = (
      arguments.length > 1
      && isZSourceInput(arguments[1])
    );
    if (compatibilityFileBuild) {
      if (
        (arguments.length != 3 && arguments.length != 4)
        || arguments[2] == "--release"
      ) {
        console.error("usage: z build <entry.zs> <output> [--release]");
        return 2;
      }
      if (arguments.length == 4 && arguments[3] != "--release") {
        console.error(`unknown build option ${arguments[3]}`);
        return 2;
      }
      const release = arguments.length == 4;
      const outcome = attempt buildProject(
        arguments[1],
        arguments[2],
        release
      );
      return reportOutcome(outcome);
    }
    let projectPath = ".";
    let release = false;
    let index: usize = 1;
    if (index < arguments.length && arguments[index] != "--release") {
      if (isOptionArgument(arguments[index])) {
        console.error(`unknown build option ${arguments[index]}`);
        return 2;
      }
      projectPath = copy arguments[1];
      index = index + 1;
    }
    if (index < arguments.length) {
      if (arguments[index] != "--release") {
        console.error(`unknown build option ${arguments[index]}`);
        return 2;
      }
      release = true;
      index = index + 1;
    }
    if (index != arguments.length) {
      console.error(`unknown build option ${arguments[index]}`);
      return 2;
    }
    const outcome = attempt buildManifestProject(
      projectPath,
      release
    );
    return reportOutcome(outcome);
  }
  if (command == "run") {
    let inputPath = ".";
    let childArguments = Array<String>();
    let release = false;
    let index: usize = 1;
    if (
      index < arguments.length
      && arguments[index] != "--release"
      && arguments[index] != "--"
    ) {
      if (isOptionArgument(arguments[index])) {
        console.error(`unknown run option ${arguments[index]}`);
        return 2;
      }
      inputPath = copy arguments[index];
      index = index + 1;
    }
    if (index < arguments.length && arguments[index] == "--release") {
      release = true;
      index = index + 1;
    }
    if (index < arguments.length) {
      if (arguments[index] != "--") {
        console.error(
          `unknown run option ${arguments[index]}; pass program arguments after --`
        );
        return 2;
      }
      index = index + 1;
    }
    while (index < arguments.length) {
      childArguments.push(copy arguments[index]);
      index = index + 1;
    }
    const outcome = attempt runProject(
      inputPath,
      childArguments,
      release
    );
    return reportOutcome(outcome);
  }
  console.error(`unknown z compiler command ${command}`);
  return 2;
}
