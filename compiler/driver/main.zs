import console from "std/console";
import { compilerHostPlatform } from "./host-platform.zs";
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
import { lowerModules } from "../frontend/lowering-ir.zs";
import { emitProgramMetadata } from "../frontend/program-metadata.zs";
import { validateNativeLowerability } from "../frontend/native-lowerability.zs";
import { programPlacesWorkFromThreads } from "../frontend/async-yield-shape.zs";
import {
  decodeRawForeignDeclarations,
} from "../frontend/foreign-declaration-protocol.zs";
import {
  NativeForeignContractSet,
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
  sourceStandardModuleRelativePath,
} from "../frontend/module-paths.zs";
import {
  resolveParsedModulesWithForeignContracts,
} from "../frontend/module-resolver.zs";
import {
  applyGeneratedBuildOverlay,
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
import { applyGeneratedCallAdapters } from "./generated-call-adaptation.zs";

struct NativeProject {
  entryPath: String;
  config: NativeProjectConfig;
  modules: Array<ParsedModule>;
  foreignModules: Array<NativeForeignModuleContract>;
  graph: ModuleGraph;
}

struct RunCacheMetadata {
  value: String;
  inputs: String;
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

function validateGeneratedProjectInput(
  in input: NativeCommandInput,
  in generatedPath: Option<String>
): void throws String {
  match (in generatedPath) {
    some(_) => {
      if (!input.projectMode) {
        throw "--generated requires a Z project directory or z.json manifest";
      }
    }
    none => {}
  }
}

function sourceStandardModulePath(in header: String): Option<String> {
  const relative = match (sourceStandardModuleRelativePath(header)) {
    some(relative) => relative;
    none => return Option<String>.none;
  };
  const executablePath = match (attempt process.executablePath()) {
    success(path) => path;
    failure(_) => return Option<String>.none;
  };
  const executableDirectory = directoryName(executablePath);
  let roots = Array<String>();
  roots.push(normalizedModulePath(`${executableDirectory}/stdlib`));
  roots.push(normalizedModulePath(`${executableDirectory}/../stdlib`));
  for (const root of roots) {
    const candidate = normalizedModulePath(`${root}/${relative}`);
    if (fs.exists(candidate) && !fs.isDirectory(candidate)) {
      return Option.some(candidate);
    }
  }
  return Option<String>.none;
}

function sourcePackageModulePath(
  in config: NativeProjectConfig,
  in header: String
): Option<String> {
  for (const sourceImport of config.sourceImports) {
    if (sourceImport.specifier == header) return Option.some(copy sourceImport.path);
  }
  return Option<String>.none;
}

function sourcePackageRootForHeader(
  in config: NativeProjectConfig,
  in header: String
): Option<String> {
  for (const sourceImport of config.sourceImports) {
    let rootSpecifier = true;
    let index: usize = 0;
    while (index < sourceImport.specifier.byteLength) {
      if (sourceImport.specifier.byteAt(index) == 47) rootSpecifier = false;
      index = index + 1;
    }
    if (!rootSpecifier) continue;
    const prefix = `${sourceImport.specifier}/`;
    if (
      header.byteLength > prefix.byteLength
      && header.copyBytes(0, prefix.byteLength) == prefix
    ) return Option.some(copy sourceImport.specifier);
  }
  return Option<String>.none;
}

function sourcePackageIdentity(
  in config: NativeProjectConfig,
  in path: String
): String {
  for (const generated of config.generatedModulePackages) {
    if (generated.path == path) return copy generated.packageIdentity;
  }
  let selected = "";
  let selectedLength: usize = 0;
  for (const identity of config.packageIdentities) {
    const prefix = `${identity.rootDirectory}/`;
    const inside = (
      path == identity.rootDirectory
      || (
        path.byteLength > prefix.byteLength
        && path.copyBytes(0, prefix.byteLength) == prefix
      )
    );
    if (!inside || identity.rootDirectory.byteLength <= selectedLength) continue;
    selected = copy identity.id;
    selectedLength = identity.rootDirectory.byteLength;
  }
  return selected;
}

function loadModule(
  in path: String,
  in config: NativeProjectConfig,
  inout loaded: Set<String>,
  inout loadedForeign: Set<String>,
  inout modules: Array<ParsedModule>,
  inout foreignModules: Array<NativeForeignModuleContract>,
  inout sharedForeignContractKeys: Array<String>,
  inout sharedForeignContracts: Array<NativeForeignContractSet>
): void throws String {
  const normalized = normalizedModulePath(path);
  const canonical = try fs.realPath(normalized);
  if (loaded.has(canonical)) return;
  loaded.add(copy canonical);

  const source = try fs.readText(canonical);
  let packageSpecifiers = Array<String>();
  for (const sourceImport of config.sourceImports) {
    if (sourceImport.path == canonical) {
      packageSpecifiers.push(copy sourceImport.specifier);
    }
  }
  const targetPlatform = match (in config.platform) {
    some(value) => copy value;
    none => compilerHostPlatform();
  };
  const targetMinimumVersion = match (in config.minimumVersion) {
    some(value) => copy value;
    none => "";
  };
  const moduleSource = ModuleSource({
    path: copy canonical,
    source,
    packageIdentity: sourcePackageIdentity(config, canonical),
    targetPlatform,
    targetMinimumVersion,
    packageSpecifiers,
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
    if (isStandardModuleHeader(declaration.header)) {
      match (sourceStandardModulePath(declaration.header)) {
        some(path) => dependencies.push(path);
        none => {}
      }
      continue;
    }
    match (sourcePackageModulePath(config, declaration.header)) {
      some(path) => {
        dependencies.push(path);
        continue;
      }
      none => {}
    }
    match (sourcePackageRootForHeader(config, declaration.header)) {
      some(packageRoot) => {
        const subpath = declaration.header.copyBytes(
          packageRoot.byteLength + 1,
          declaration.header.byteLength
        );
        throw `${canonical}:${declaration.line}:${declaration.column}: package "${packageRoot}" does not export subpath "./${subpath}"`;
      }
      none => {}
    }
    const header = copy declaration.header;
    const line = declaration.line;
    const column = declaration.column;
    const foreignKey = `${canonical}\n${header}`;
    if (!loadedForeign.has(foreignKey)) {
      loadedForeign.add(copy foreignKey);
      const foreignModule = try loadForeignModuleContract(
        canonical,
        moduleSource.source,
        declaration.moduleName,
        header,
        line,
        column,
        config,
        inout sharedForeignContractKeys,
        inout sharedForeignContracts
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
      inout foreignModules,
      inout sharedForeignContractKeys,
      inout sharedForeignContracts
    );
  }
}

function loadProject(
  in entryPath: String,
  in generatedPath: Option<String>
): NativeProject throws String {
  const normalizedEntry = normalizedModulePath(entryPath);
  const canonicalEntry = try fs.realPath(normalizedEntry);
  let config = try loadProjectConfig(canonicalEntry);
  match (in generatedPath) {
    some(path) => try applyGeneratedBuildOverlay(inout config, path);
    none => {}
  }
  let loaded = Set<String>();
  let loadedForeign = Set<String>();
  let modules = Array<ParsedModule>();
  let foreignModules = Array<NativeForeignModuleContract>();
  let sharedForeignContractKeys = Array<String>();
  let sharedForeignContracts = Array<NativeForeignContractSet>();
  try loadModule(
    canonicalEntry,
    config,
    inout loaded,
    inout loadedForeign,
    inout modules,
    inout foreignModules,
    inout sharedForeignContractKeys,
    inout sharedForeignContracts
  );

  const baseGraphOutcome = attempt resolveParsedModulesWithForeignContracts(
    modules,
    canonicalEntry,
    foreignModules
  );
  let graph = match (baseGraphOutcome) {
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
  if (config.generatedCallAdapters.length > 0) {
    let generatedPaths = Array<String>();
    {
      // Adapter discovery needs the first checked graph, but rebuilding the
      // adapted graph does not. Release its SDK-sized semantic tables before
      // constructing their replacement instead of keeping both graphs alive.
      const initialGraph = move graph;
      generatedPaths = try applyGeneratedCallAdapters(
        inout modules,
        initialGraph,
        config
      );
    }
    for (const adapterModulePath of generatedPaths) {
      try loadModule(
        adapterModulePath,
        config,
        inout loaded,
        inout loadedForeign,
        inout modules,
        inout foreignModules,
        inout sharedForeignContractKeys,
        inout sharedForeignContracts
      );
    }
    const adaptedGraphOutcome = attempt resolveParsedModulesWithForeignContracts(
      modules,
      canonicalEntry,
      foreignModules
    );
    const adaptedGraph = match (adaptedGraphOutcome) {
      success(adapted) => adapted;
      failure(error) => {
        const sourceOutcome = attempt fs.readText(error.path);
        const message = match (sourceOutcome) {
          success(source) => diagnosticMessage(error, source);
          failure(_) => `${error.path}:${error.line}:${error.column}: error: ${error.message}`;
        };
        throw message;
      }
    };
    graph = adaptedGraph;
  }
  const lowerabilityOutcome = attempt validateNativeLowerability(modules, graph);
  match (lowerabilityOutcome) {
    success => {}
    failure(error) => {
      const sourceOutcome = attempt fs.readText(error.path);
      const message = match (sourceOutcome) {
        success(source) => diagnosticMessage(error, source);
        failure(_) => `${error.path}:${error.line}:${error.column}: error[${error.code}]: ${error.message}`;
      };
      throw message;
    }
  }
  // A framework header links its framework, as in Stage 0, so a single-file
  // program importing <AppKit/AppKit.h> needs no manifest entry.
  for (const foreignModule of foreignModules) {
    if (foreignModule.contracts.framework.byteLength == 0) continue;
    let listed = false;
    for (const existing of config.linkFrameworks) {
      if (existing == foreignModule.contracts.framework) listed = true;
    }
    if (!listed) config.linkFrameworks.push(copy foreignModule.contracts.framework);
  }
  // Threads that place work on main may run under the Darwin main run loop:
  // Stage 0 links CoreFoundation for such a program, so its headers may use
  // the run loop without a manifest entry.
  const frameworkPlatform = match (in config.platform) {
    some(value) => copy value;
    none => compilerHostPlatform();
  };
  if (frameworkPlatform == "macos") {
    let runLoopProgram = false;
    for (const module of modules) {
      if (programPlacesWorkFromThreads(module.program)) runLoopProgram = true;
    }
    let listed = false;
    for (const existing of config.linkFrameworks) {
      if (existing == "CoreFoundation") listed = true;
    }
    if (runLoopProgram && !listed) config.linkFrameworks.push("CoreFoundation");
  }
  // Foreign imports are resolved relative to their declaring source module.
  // The emitted translation unit lives elsewhere, so final compilation needs
  // those same directories, including generated modules and a nested entry.
  // Add them only after import resolution; this is an effective build setting,
  // not a change to which headers the foreign importer is allowed to discover.
  let includeDirectories = Set<String>();
  includeDirectories.add(copy config.directory);
  for (const directory of config.includeDirectories) {
    includeDirectories.add(copy directory);
  }
  const entryDirectory = directoryName(canonicalEntry);
  if (!includeDirectories.has(entryDirectory)) {
    includeDirectories.add(copy entryDirectory);
    config.includeDirectories.push(copy entryDirectory);
  }
  for (const moduleIndex of graph.dependencyOrder) {
    const directory = directoryName(graph.modules[moduleIndex].path);
    if (!includeDirectories.has(directory)) {
      includeDirectories.add(copy directory);
      config.includeDirectories.push(copy directory);
    }
  }
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

function checkProject(
  in entryPath: String,
  in generatedPath: Option<String>
): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  try validateGeneratedProjectInput(input, generatedPath);
  const project = try loadProject(input.entryPath, generatedPath);
  try validateExecutableEntry(project, false);
  if (input.projectMode && project.config.targetConfigured) {
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
  const checkedLowering = try lowerModules(project.modules, project.graph);
  console.log(`checked ${project.modules.length} Z modules`);
  return 0;
}

function metadataProject(
  in entryPath: String,
  in generatedPath: Option<String>
): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  try validateGeneratedProjectInput(input, generatedPath);
  const project = try loadProject(input.entryPath, generatedPath);
  try validateExecutableEntry(project, false);
  const metadata = try emitProgramMetadata(project.modules, project.graph);
  console.write(metadata);
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
  const project = try loadProject(entryPath, Option<String>.none);
  const emitted = try emitProject(project, true);
  try fs.writeText(cPath, emitted);
  console.log(`emitted ${project.modules.length} Z modules to ${cPath}`);
  return 0;
}

function emitProjectStandardOutput(
  in entryPath: String,
  in generatedPath: Option<String>
): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  try validateGeneratedProjectInput(input, generatedPath);
  const project = try loadProject(input.entryPath, generatedPath);
  const emitted = try emitProject(
    project,
    project.config.targetConfigured
    && project.config.targetKind == "executable"
  );
  console.write(emitted);
  return 0;
}

function projectUsesObjectiveC(in project: NativeProject): boolean {
  for (const module of project.graph.modules) {
    for (const resolution of module.semanticEvidence.callResolutions) {
      if (resolution.objectiveCSelector.byteLength > 0) return true;
    }
    for (const symbol of module.symbols) {
      match (in symbol.typeSignature) {
        some(signature) => {
          if (signature.foreignKind == "objcInterface") return true;
        }
        none => {}
      }
    }
  }
  return false;
}

// A C++ header import or a `raw cpp` body makes the program C++, as in
// Stage 0; the emitted translation unit is valid as both C11 and C++20.
function projectUsesCPlusPlus(in project: NativeProject): boolean {
  for (const foreignModule of project.foreignModules) {
    if (foreignModule.contracts.cPlusPlus) return true;
  }
  for (const module of project.modules) {
    for (const declaration of module.program.functions) {
      if (declaration.rawLanguage == "cpp") return true;
    }
    for (const aggregate of module.program.aggregates) {
      for (const method of aggregate.methods) {
        if (method.rawLanguage == "cpp") return true;
      }
    }
  }
  return false;
}

function projectNativeCompiler(in project: NativeProject): String {
  return projectUsesCPlusPlus(project) ? "clang++" : "clang";
}

function projectNativeSourceExtension(in project: NativeProject): String {
  if (projectUsesCPlusPlus(project)) return projectUsesObjectiveC(project) ? ".mm" : ".cc";
  return projectUsesObjectiveC(project) ? ".m" : ".c";
}

function appendProjectLanguageArguments(
  in project: NativeProject,
  inout arguments: Array<String>
): void {
  const cPlusPlus = projectUsesCPlusPlus(project);
  arguments.push("-x");
  if (projectUsesObjectiveC(project)) {
    arguments.push(cPlusPlus ? "objective-c++" : "objective-c");
    arguments.push("-fobjc-arc");
  } else arguments.push(cPlusPlus ? "c++" : "c");
  if (cPlusPlus) {
    arguments.push("-std=c++20");
    arguments.push("-Wc99-designator");
  } else arguments.push("-std=c11");
}

// Flags supplied after `--` on the command line reach the C compiler verbatim,
// so a sanitizer or coverage run can reuse this build.
function appendExtraCompilerArguments(
  in extraFlags: Array<String>,
  inout arguments: Array<String>
): void {
  for (const flag of extraFlags) {
    arguments.push(copy flag);
  }
}

function compileEmittedProject(
  in project: NativeProject,
  in emitted: String,
  in outputPath: String,
  release: boolean,
  in extraFlags: Array<String>
): i32 throws String {
  const extension = projectNativeSourceExtension(project);
  const cPath = `${outputPath}${extension}`;
  try fs.writeText(cPath, emitted);
  let compilerArguments = Array<String>();
  appendProjectLanguageArguments(project, inout compilerArguments);
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
  appendExtraCompilerArguments(extraFlags, inout compilerArguments);
  compilerArguments.push("-o");
  compilerArguments.push(copy outputPath);
  const compiler = projectNativeCompiler(project);
  return try process.run(compiler, compilerArguments);
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
    release,
    Array<String>()
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
  const project = try loadProject(entryPath, Option<String>.none);
  return try buildLoadedProject(project, outputPath, release);
}

function testProject(
  in entryPath: String,
  in generatedPath: Option<String>
): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  try validateGeneratedProjectInput(input, generatedPath);
  const project = try loadProject(input.entryPath, generatedPath);
  const emitted = try emitTestModulesC(project.modules, project.graph);
  const outputDirectory = `${project.config.directory}/.z-cache/test`;
  try fs.createDirectories(outputDirectory);
  const outputPath = `${outputDirectory}/tests`;
  const compilationExitCode = try compileEmittedProject(
    project,
    emitted,
    outputPath,
    false,
    Array<String>()
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
  const isMainThread = `${prefix}_runtime_is_main_thread`;
  for (const module of project.modules) {
    for (const declaration of module.program.functions) {
      if (
        declaration.nativeCExport
        && (
          declaration.name == initialize
          || declaration.name == shutdown
          || declaration.name == status
          || declaration.name == config
          || declaration.name == enqueue
          || declaration.name == isMainThread
        )
      ) {
        throw `C export name "${declaration.name}" collides with the generated runtime contract for target "${targetName}"`;
      }
    }
    for (const declaration of module.program.aggregates) {
      if (
        declaration.nativeCLayout
        && (
          declaration.name == initialize
          || declaration.name == shutdown
          || declaration.name == status
          || declaration.name == config
          || declaration.name == enqueue
          || declaration.name == isMainThread
        )
      ) {
        throw `public C type name "${declaration.name}" collides with the generated runtime contract for target "${targetName}"`;
      }
    }
    for (const declaration of module.program.enums) {
      if (
        declaration.nativeCLayout
        && (
          declaration.name == initialize
          || declaration.name == shutdown
          || declaration.name == status
          || declaration.name == config
          || declaration.name == enqueue
          || declaration.name == isMainThread
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
  release: boolean,
  in extraFlags: Array<String>
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
  const sourceExtension = projectNativeSourceExtension(project);
  const cPath = `${cacheDirectory}/${targetName}${sourceExtension}`;
  const objectPath = `${cacheDirectory}/${targetName}.o`;
  const libraryPath = `${outputDirectory}/lib${targetName}.a`;
  const headerPath = `${outputDirectory}/${targetName}.h`;
  try fs.writeText(cPath, emitted);

  let compilerArguments = Array<String>();
  appendProjectLanguageArguments(project, inout compilerArguments);
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
  appendExtraCompilerArguments(extraFlags, inout compilerArguments);
  compilerArguments.push("-c");
  compilerArguments.push(copy cPath);
  compilerArguments.push("-o");
  compilerArguments.push(copy objectPath);
  const compiler = projectNativeCompiler(project);
  const compilationExitCode = try process.run(compiler, compilerArguments);
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
  release: boolean,
  in extraFlags: Array<String>
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
  const sourceExtension = projectNativeSourceExtension(project);
  const cPath = `${cacheDirectory}/${targetName}${sourceExtension}`;
  const prefix = sharedLibraryPrefix(project.config);
  const extension = sharedLibraryExtension(project.config);
  const libraryPath = `${outputDirectory}/${prefix}${targetName}${extension}`;
  const headerPath = `${outputDirectory}/${targetName}.h`;
  try fs.writeText(cPath, emitted);

  let compilerArguments = Array<String>();
  appendProjectLanguageArguments(project, inout compilerArguments);
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
  appendExtraCompilerArguments(extraFlags, inout compilerArguments);
  compilerArguments.push("-o");
  compilerArguments.push(copy libraryPath);
  const compiler = projectNativeCompiler(project);
  const compilationExitCode = try process.run(compiler, compilerArguments);
  if (compilationExitCode != 0) return compilationExitCode;
  try fs.writeText(headerPath, header);
  console.log(`built ${libraryPath}`);
  console.log(`generated ${headerPath}`);
  return 0;
}

function buildExecutableTarget(
  in project: NativeProject,
  release: boolean,
  in extraFlags: Array<String>
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
    release,
    extraFlags
  );
  if (exitCode != 0) return exitCode;
  try fs.replace(cachedOutputPath, outputPath);
  console.log(`built ${outputPath}`);
  return 0;
}

function buildManifestProject(
  in projectPath: String,
  release: boolean,
  in generatedPath: Option<String>,
  in extraFlags: Array<String>
): i32 throws String {
  const input = try resolveCommandInput(projectPath);
  if (!input.projectMode) {
    throw "project build expects a directory or z.json manifest; use `z build <entry.zs> <output>` for the compatibility file build";
  }
  const canonicalEntry = try fs.realPath(input.entryPath);
  let preliminaryConfig = try loadProjectConfig(canonicalEntry);
  match (in generatedPath) {
    some(path) => try applyGeneratedBuildOverlay(inout preliminaryConfig, path);
    none => {}
  }
  if (!preliminaryConfig.targetConfigured) {
    throw "z build requires a configured target; this manifest declares only a source library";
  }
  const targetName = match (in preliminaryConfig.targetName) {
    some(name) => name.copyBytes(0, name.byteLength);
    none => throw "z build requires a named target";
  };
  const cacheDirectory = normalizedModulePath(
    `${preliminaryConfig.directory}/.z-cache/build`
  );
  try fs.createDirectories(cacheDirectory);
  const metadataPath = `${cacheDirectory}/${targetName}.build.meta`;
  const cacheLock = try fs.lock(`${cacheDirectory}/${targetName}.build.lock`);
  let toolchainIdentity = try loadToolchainIdentity(cacheDirectory);
  // Extra compiler flags change the artifact, so they belong in the cache key.
  // Folding them into the toolchain identity keeps the check and the recorded
  // metadata consistent without widening the cache record.
  for (const flag of extraFlags) {
    toolchainIdentity = `${toolchainIdentity} ${flag}`;
  }
  if (try buildCacheMatches(
    preliminaryConfig,
    canonicalEntry,
    targetName,
    generatedPath,
    release,
    toolchainIdentity,
    metadataPath
  )) {
    console.log(`cache hit: reused build/${targetName}`);
    cacheLock.unlock();
    return 0;
  }
  const project = try loadProject(input.entryPath, generatedPath);
  try validateExecutableEntry(project, false);
  const cacheMetadata = try runCacheMetadata(
    project,
    toolchainIdentity,
    release,
    generatedPath
  );
  if (!cacheMetadata.reusable) {
    console.log(
      "cache bypass: could not resolve every configured native library unambiguously"
    );
  }
  let exitCode = 0;
  if (project.config.targetKind == "executable") {
    exitCode = try buildExecutableTarget(project, release, extraFlags);
  } else if (project.config.targetKind == "static-library") {
    exitCode = try buildStaticLibrary(project, release, extraFlags);
  } else if (project.config.targetKind == "shared-library") {
    exitCode = try buildSharedLibrary(project, release, extraFlags);
  } else {
    throw `unsupported project target kind "${project.config.targetKind}"`;
  }
  if (exitCode == 0 && cacheMetadata.reusable) {
    try publishBuildCache(metadataPath, cacheMetadata.inputs);
  }
  cacheLock.unlock();
  return exitCode;
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

function appendCacheInput(
  inout output: TextBuffer,
  in path: String,
  in digest: String
): void {
  appendCacheField(inout output, "input", path);
  appendCacheField(inout output, "input-sha256", digest);
}

function appendFileCacheEvidence(
  inout metadata: TextBuffer,
  inout inputs: TextBuffer,
  inout recorded: Set<String>,
  in label: String,
  in path: String
): void throws String {
  if (recorded.has(path)) return;
  recorded.add(path.copyBytes(0, path.byteLength));
  const bytes = try fs.readBytes(path);
  const digest = sha256(bytes);
  appendCacheField(inout metadata, label, path);
  appendCacheField(inout metadata, `${label}-sha256`, digest);
  appendCacheInput(inout inputs, path, digest);
}

struct NativeLibraryResolution {
  path: String;
  ambiguous: boolean;
}

function resolvedNativeLibrary(
  in config: NativeProjectConfig,
  in library: String
): NativeLibraryResolution {
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
      if (selected.byteLength > 0) {
        return NativeLibraryResolution({ path: "", ambiguous: true });
      }
      selected = copy candidate;
    }
    if (selected.byteLength > 0) {
      return NativeLibraryResolution({ path: selected, ambiguous: false });
    }
  }
  return NativeLibraryResolution({ path: "", ambiguous: false });
}

function appendNativeLibraryEvidence(
  in project: NativeProject,
  inout output: TextBuffer,
  inout inputs: TextBuffer,
  inout recordedInputs: Set<String>
): boolean throws String {
  for (const library of project.config.linkLibraries) {
    const resolution = resolvedNativeLibrary(
      project.config,
      library
    );
    if (resolution.ambiguous) return false;
    if (resolution.path.byteLength == 0) {
      // Toolchain-search libraries such as macOS sqlite3 and compression do
      // not have a stable project-local path to hash. Their logical linker
      // name composes with the Clang fingerprint above. A missing library can
      // never publish a cache entry because the initial link still must pass.
      appendCacheField(
        inout output,
        "native-library-toolchain-search",
        library
      );
      continue;
    }
    const path = copy resolution.path;
    try appendFileCacheEvidence(
      inout output,
      inout inputs,
      inout recordedInputs,
      "native-library",
      path
    );
  }
  return true;
}

function appendForeignDependencyEvidence(
  in project: NativeProject,
  inout output: TextBuffer,
  inout inputs: TextBuffer,
  inout recordedInputs: Set<String>
): boolean throws String {
  for (const foreignModule of project.foreignModules) {
    if (
      foreignModule.dependencyPath.byteLength == 0
      || !fs.exists(foreignModule.dependencyPath)
    ) return false;
    const dependencies = try fs.readText(foreignModule.dependencyPath);
    let start: usize = 0;
    let index: usize = 0;
    while (index < dependencies.byteLength) {
      if (dependencies.byteAt(index) != 0) {
        index = index + 1;
        continue;
      }
      if (index > start) {
        const path = dependencies.copyBytes(start, index);
        if (!fs.exists(path) || fs.isDirectory(path)) return false;
        try appendFileCacheEvidence(
          inout output,
          inout inputs,
          inout recordedInputs,
          "foreign-dependency",
          path
        );
      }
      start = index + 1;
      index = index + 1;
    }
    if (start != dependencies.byteLength) return false;
  }
  return true;
}

function runCacheMetadata(
  in project: NativeProject,
  in toolchainIdentity: String,
  release: boolean,
  in generatedPath: Option<String>
): RunCacheMetadata throws String {
  let output = TextBuffer();
  let inputs = TextBuffer();
  let recordedInputs = Set<String>();
  appendCacheField(
    inout output,
    "schema",
    "z-native-project-cache-v3"
  );
  appendCacheField(inout inputs, "schema", "z-native-build-inputs-v3");
  if (release) {
    appendCacheField(inout output, "profile", "release");
    appendCacheField(inout inputs, "profile", "release");
  } else {
    appendCacheField(inout output, "profile", "debug");
    appendCacheField(inout inputs, "profile", "debug");
  }
  appendCacheField(inout output, "entry", project.entryPath);
  appendCacheField(inout output, "directory", project.config.directory);
  appendCacheField(inout output, "target-kind", project.config.targetKind);
  appendCacheField(inout inputs, "entry", project.entryPath);
  appendCacheField(inout inputs, "directory", project.config.directory);
  appendCacheField(inout inputs, "target-kind", project.config.targetKind);
  match (in project.config.targetName) {
    some(name) => {
      appendCacheField(inout output, "target-name", name);
      appendCacheField(inout inputs, "target-name", name);
    }
    none => {
      appendCacheField(inout output, "target-name", "");
      appendCacheField(inout inputs, "target-name", "");
    }
  }
  match (in project.config.runtimeInitializer) {
    some(name) => appendCacheField(inout output, "runtime-initialize", name);
    none => appendCacheField(inout output, "runtime-initialize", "");
  }
  appendCacheField(
    inout output,
    "toolchain",
    toolchainIdentity
  );
  appendCacheField(inout inputs, "toolchain", toolchainIdentity);
  match (in generatedPath) {
    some(path) => appendCacheField(
      inout inputs,
      "generated-overlay",
      try fs.realPath(path)
    );
    none => appendCacheField(inout inputs, "generated-overlay", "");
  }
  const compilerPath = try process.executablePath();
  appendCacheField(inout inputs, "compiler-path", compilerPath);
  try appendFileCacheEvidence(
    inout output,
    inout inputs,
    inout recordedInputs,
    "compiler",
    compilerPath
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
  for (const framework of project.config.linkFrameworks) {
    appendCacheField(inout output, "link-framework", framework);
  }
  match (in project.config.manifestPath) {
    some(path) => {
      try appendFileCacheEvidence(
        inout output,
        inout inputs,
        inout recordedInputs,
        "manifest",
        path
      );
    }
    none => {}
  }
  for (const identity of project.config.packageIdentities) {
    try appendFileCacheEvidence(
      inout output,
      inout inputs,
      inout recordedInputs,
      "manifest",
      identity.id
    );
  }
  match (in generatedPath) {
    some(path) => {
      const canonical = try fs.realPath(path);
      try appendFileCacheEvidence(
        inout output,
        inout inputs,
        inout recordedInputs,
        "generated-overlay",
        canonical
      );
    }
    none => {
      appendCacheField(inout output, "generated-overlay", "");
    }
  }
  for (const module of project.modules) {
    try appendFileCacheEvidence(
      inout output,
      inout inputs,
      inout recordedInputs,
      "module",
      module.path
    );
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
  const librariesReusable = try appendNativeLibraryEvidence(
    project,
    inout output,
    inout inputs,
    inout recordedInputs
  );
  const foreignReusable = try appendForeignDependencyEvidence(
    project,
    inout output,
    inout inputs,
    inout recordedInputs
  );
  return RunCacheMetadata({
    value: output.finish(),
    inputs: inputs.finish(),
    reusable: librariesReusable && foreignReusable,
  });
}

function buildArtifactsPresent(
  in config: NativeProjectConfig,
  in targetName: String
): boolean {
  const outputDirectory = normalizedModulePath(`${config.directory}/build`);
  if (config.targetKind == "executable") {
    return fs.exists(`${outputDirectory}/${targetName}`);
  }
  const headerPath = `${outputDirectory}/${targetName}.h`;
  if (!fs.exists(headerPath)) return false;
  if (config.targetKind == "static-library") {
    return fs.exists(`${outputDirectory}/lib${targetName}.a`);
  }
  if (config.targetKind == "shared-library") {
    const prefix = sharedLibraryPrefix(config);
    const extension = sharedLibraryExtension(config);
    return fs.exists(`${outputDirectory}/${prefix}${targetName}${extension}`);
  }
  return false;
}

function buildCacheToken(
  in source: String,
  inout offset: usize
): String throws String {
  if (offset >= source.byteLength) throw "truncated build cache metadata";
  const start = offset;
  while (offset < source.byteLength && source.byteAt(offset) != 0) {
    offset = offset + 1;
  }
  if (offset >= source.byteLength) throw "truncated build cache metadata";
  const token = source.copyBytes(start, offset);
  offset = offset + 1;
  return token;
}

function buildCacheField(
  in source: String,
  inout offset: usize,
  in expectedName: String
): String throws String {
  const name = try buildCacheToken(source, inout offset);
  if (name != expectedName) throw "unexpected build cache metadata field";
  return try buildCacheToken(source, inout offset);
}

function buildCacheInputsMatch(
  in source: String,
  in config: NativeProjectConfig,
  in entryPath: String,
  in targetName: String,
  in generatedPath: String,
  release: boolean,
  in toolchainIdentity: String
): boolean throws String {
  let offset: usize = 0;
  if (
    try buildCacheField(source, inout offset, "schema")
    != "z-native-build-inputs-v3"
  ) return false;
  const expectedProfile = release ? "release" : "debug";
  if (
    try buildCacheField(source, inout offset, "profile")
    != expectedProfile
  ) return false;
  if (
    try buildCacheField(source, inout offset, "entry") != entryPath
  ) return false;
  if (
    try buildCacheField(source, inout offset, "directory")
    != config.directory
  ) return false;
  if (
    try buildCacheField(source, inout offset, "target-kind")
    != config.targetKind
  ) return false;
  if (
    try buildCacheField(source, inout offset, "target-name")
    != targetName
  ) return false;
  if (
    try buildCacheField(source, inout offset, "toolchain")
    != toolchainIdentity
  ) return false;
  if (
    try buildCacheField(source, inout offset, "generated-overlay")
    != generatedPath
  ) return false;
  if (
    try buildCacheField(source, inout offset, "compiler-path")
    != try process.executablePath()
  ) return false;
  let inputCount: usize = 0;
  while (offset < source.byteLength) {
    const path = try buildCacheField(source, inout offset, "input");
    const expectedDigest = try buildCacheField(
      source,
      inout offset,
      "input-sha256"
    );
    if (!fs.exists(path) || fs.isDirectory(path)) return false;
    const bytes = try fs.readBytes(path);
    if (sha256(bytes) != expectedDigest) return false;
    inputCount = inputCount + 1;
  }
  return inputCount > 0;
}

function buildCacheMatches(
  in config: NativeProjectConfig,
  in entryPath: String,
  in targetName: String,
  in generatedPath: Option<String>,
  release: boolean,
  in toolchainIdentity: String,
  in metadataPath: String
): boolean throws String {
  if (
    !buildArtifactsPresent(config, targetName)
    || !fs.exists(metadataPath)
  ) return false;
  let canonicalGeneratedPath = "";
  match (in generatedPath) {
    some(path) => canonicalGeneratedPath = try fs.realPath(path);
    none => {}
  }
  const cached = attempt fs.readText(metadataPath);
  const source = match (cached) {
    success(found) => found;
    failure(_) => return false;
  };
  const matched = attempt buildCacheInputsMatch(
    source,
    config,
    entryPath,
    targetName,
    canonicalGeneratedPath,
    release,
    toolchainIdentity
  );
  return match (matched) {
    success(value) => value;
    failure(_) => false;
  };
}

function publishBuildCache(
  in metadataPath: String,
  in metadata: String
): void throws String {
  const pendingPath = `${metadataPath}.pending`;
  try fs.writeText(pendingPath, metadata);
  try fs.replace(pendingPath, metadataPath);
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
  release: boolean,
  in generatedPath: Option<String>
): i32 throws String {
  const input = try resolveCommandInput(entryPath);
  try validateGeneratedProjectInput(input, generatedPath);
  const project = try loadProject(input.entryPath, generatedPath);
  if (
    input.projectMode
    && !project.config.targetConfigured
  ) {
    throw "z run requires a configured executable target; this manifest declares only a source library";
  }
  if (
    input.projectMode
    && project.config.targetKind != "executable"
  ) {
    throw `z run requires an executable project, but target.kind is "${project.config.targetKind}"`;
  }
  const outputDirectory = `${project.config.directory}/.z-cache/run`;
  try fs.createDirectories(outputDirectory);
  const outputPath = `${outputDirectory}/program`;
  const sourceExtension = projectNativeSourceExtension(project);
  const cPath = `${outputPath}${sourceExtension}`;
  const metadataPath = `${outputPath}.meta`;
  const pendingOutputPath = `${outputPath}.pending`;
  const pendingCPath = `${pendingOutputPath}${sourceExtension}`;
  const pendingMetadataPath = `${metadataPath}.pending`;
  const cacheLock = try fs.lock(`${outputPath}.lock`);
  const emitted = try emitProject(project, true);
  const toolchainIdentity = try loadToolchainIdentity(outputDirectory);
  const cacheMetadata = try runCacheMetadata(
    project,
    toolchainIdentity,
    release,
    generatedPath
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
      release,
      Array<String>()
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

struct GeneratedInputArguments {
  inputPath: String;
  generatedPath: Option<String>;
}

function parseGeneratedInputArguments(
  in arguments: Array<String>,
  in command: String
): GeneratedInputArguments throws String {
  let inputPath = ".";
  let inputSeen = false;
  let generatedPath = Option<String>.none;
  let generatedSeen = false;
  let index: usize = 1;
  while (index < arguments.length) {
    const argument = copy arguments[index];
    if (argument == "--generated") {
      if (generatedSeen) throw "--generated may be supplied only once";
      if (index + 1 >= arguments.length) {
        throw "--generated requires a generated .zbuild.json path";
      }
      const path = copy arguments[index + 1];
      if (isOptionArgument(path)) {
        throw "--generated requires a generated .zbuild.json path";
      }
      generatedPath = Option.some(move path);
      generatedSeen = true;
      index = index + 2;
      continue;
    }
    if (isOptionArgument(argument)) {
      throw `unknown ${command} option ${argument}`;
    }
    if (inputSeen) throw `usage: z ${command} [entry.zs|project] [--generated file.zbuild.json]`;
    inputPath = move argument;
    inputSeen = true;
    index = index + 1;
  }
  return GeneratedInputArguments({ inputPath, generatedPath });
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
    console.error("usage: z <version|check|test|emit|metadata|build|run|foreign-inspect|foreign-contract-inspect> [input] [output] [--release] [-- args]");
    return 2;
  }

  const command = copy arguments[0];
  if (command == "version") {
    if (arguments.length != 1) {
      console.error("usage: z version");
      return 2;
    }
    console.log("z 0.1.0-dev revision 2026-08-31.1 compiler-api 2");
    return 0;
  }
  if (command == "check") {
    const parsed = attempt parseGeneratedInputArguments(arguments, "check");
    const options = match (parsed) {
      success(options) => options;
      failure(message) => {
        console.error(message);
        return 2;
      }
    };
    const outcome = attempt checkProject(
      options.inputPath,
      options.generatedPath
    );
    return reportOutcome(outcome);
  }
  if (command == "test") {
    const parsed = attempt parseGeneratedInputArguments(arguments, "test");
    const options = match (parsed) {
      success(options) => options;
      failure(message) => {
        console.error(message);
        return 2;
      }
    };
    const outcome = attempt testProject(
      options.inputPath,
      options.generatedPath
    );
    return reportOutcome(outcome);
  }
  if (command == "metadata") {
    const parsed = attempt parseGeneratedInputArguments(arguments, "metadata");
    const options = match (parsed) {
      success(options) => options;
      failure(message) => {
        console.error(message);
        return 2;
      }
    };
    const outcome = attempt metadataProject(
      options.inputPath,
      options.generatedPath
    );
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
    if (
      arguments.length == 3
      && !isOptionArgument(arguments[1])
      && !isOptionArgument(arguments[2])
    ) {
      const outcome = attempt emitProjectFile(
        arguments[1],
        arguments[2]
      );
      return reportOutcome(outcome);
    }
    const parsed = attempt parseGeneratedInputArguments(arguments, "emit");
    const options = match (parsed) {
      success(options) => options;
      failure(message) => {
        console.error(message);
        return 2;
      }
    };
    const outcome = attempt emitProjectStandardOutput(
      options.inputPath,
      options.generatedPath
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
    let extraFlags = Array<String>();
    let generatedPath = Option<String>.none;
    let generatedSeen = false;
    let projectSeen = false;
    let index: usize = 1;
    while (index < arguments.length) {
      const argument = copy arguments[index];
      if (argument == "--release") {
        if (release) {
          console.error("--release may be supplied only once");
          return 2;
        }
        release = true;
        index = index + 1;
        continue;
      }
      if (argument == "--generated") {
        if (generatedSeen) {
          console.error("--generated may be supplied only once");
          return 2;
        }
        if (index + 1 >= arguments.length) {
          console.error("--generated requires a generated .zbuild.json path");
          return 2;
        }
        const path = copy arguments[index + 1];
        if (isOptionArgument(path)) {
          console.error("--generated requires a generated .zbuild.json path");
          return 2;
        }
        generatedPath = Option.some(move path);
        generatedSeen = true;
        index = index + 2;
        continue;
      }
      if (argument == "--") {
        index = index + 1;
        while (index < arguments.length) {
          extraFlags.push(copy arguments[index]);
          index = index + 1;
        }
        break;
      }
      if (isOptionArgument(argument)) {
        console.error(`unknown build option ${argument}`);
        return 2;
      }
      if (projectSeen) {
        console.error(`unknown build option ${argument}`);
        return 2;
      }
      projectPath = move argument;
      projectSeen = true;
      index = index + 1;
    }
    const outcome = attempt buildManifestProject(
      projectPath,
      release,
      generatedPath,
      extraFlags
    );
    return reportOutcome(outcome);
  }
  if (command == "run") {
    let inputPath = ".";
    let childArguments = Array<String>();
    let release = false;
    let inputSeen = false;
    let generatedPath = Option<String>.none;
    let generatedSeen = false;
    let index: usize = 1;
    while (index < arguments.length && arguments[index] != "--") {
      const argument = copy arguments[index];
      if (argument == "--release") {
        if (release) {
          console.error("--release may be supplied only once");
          return 2;
        }
        release = true;
        index = index + 1;
        continue;
      }
      if (argument == "--generated") {
        if (generatedSeen) {
          console.error("--generated may be supplied only once");
          return 2;
        }
        if (index + 1 >= arguments.length || arguments[index + 1] == "--") {
          console.error("--generated requires a generated .zbuild.json path");
          return 2;
        }
        const path = copy arguments[index + 1];
        if (isOptionArgument(path)) {
          console.error("--generated requires a generated .zbuild.json path");
          return 2;
        }
        generatedPath = Option.some(move path);
        generatedSeen = true;
        index = index + 2;
        continue;
      }
      if (isOptionArgument(argument)) {
        console.error(`unknown run option ${argument}`);
        return 2;
      }
      if (inputSeen) {
        console.error(
          `unknown run option ${argument}; pass program arguments after --`
        );
        return 2;
      }
      inputPath = move argument;
      inputSeen = true;
      index = index + 1;
    }
    if (index < arguments.length && arguments[index] == "--") index = index + 1;
    while (index < arguments.length) {
      childArguments.push(copy arguments[index]);
      index = index + 1;
    }
    const outcome = attempt runProject(
      inputPath,
      childArguments,
      release,
      generatedPath
    );
    return reportOutcome(outcome);
  }
  console.error(`unknown z compiler command ${command}`);
  return 2;
}
