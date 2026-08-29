import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DiagnosticError } from "./diagnostics.ts";
import type { ApiNotes } from "./foreign-api-notes.ts";
import {
  loadGeneratedBuildOverlay,
  type GeneratedBuildOverlay,
} from "./generated-build.ts";

export type ProjectBuild = {
  readonly manifestPath: string | null;
  readonly sourceImports: Readonly<Record<string, string>>;
  /** Manifest-established package identities used for package-only visibility. */
  readonly packages: readonly ProjectPackage[];
  readonly targetConfigured: boolean;
  readonly targetKind: "executable" | "static-library" | "shared-library";
  readonly targetName: string | null;
  readonly runtimeInitializer: string | null;
  readonly entryPath: string | null;
  readonly deploymentTarget: DeploymentTarget | null;
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
  readonly nativeLinkerArguments: readonly string[];
  readonly frameworks: readonly string[];
  readonly foreignApiNotes: Readonly<Record<string, ApiNotes>>;
  /** Tool-owned generated modules and checked call adaptations for this invocation. */
  readonly generatedBuild: GeneratedBuildOverlay | null;
  /** Exact generated source paths granted an existing package identity. */
  readonly generatedModulePackages: Readonly<Record<string, ProjectPackage>>;
};

export type ProjectPackage = {
  /** Canonical manifest path; stable for every local reference to this package. */
  readonly id: string;
  readonly name: string;
  readonly rootDirectory: string;
};

export type DeploymentTarget = {
  readonly platform: string;
  readonly minimumVersion: string;
};

type ProjectManifest = {
  readonly imports?: Readonly<Record<string, string>>;
  readonly package?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly library?: {
    readonly entry?: string;
    readonly exports?: Readonly<Record<string, string>>;
    readonly native?: {
      readonly includeDirectories?: readonly string[];
      readonly link?: {
        readonly directories?: readonly string[];
        readonly libraries?: readonly string[];
        readonly frameworks?: readonly string[];
      };
    };
  };
  readonly dependencies?: Readonly<Record<string, { readonly path?: string }>>;
  readonly target?: {
    readonly kind?: "executable" | "static-library" | "shared-library";
    readonly name?: string;
    readonly entry?: string;
    readonly platform?: string;
    readonly minimumVersion?: string;
    readonly includeDirectories?: readonly string[];
    readonly runtime?: {
      readonly initialize?: string;
    };
    readonly link?: {
      readonly directories?: readonly string[];
      readonly libraries?: readonly string[];
      readonly frameworks?: readonly string[];
    };
    readonly swift?: {
      readonly module?: string;
      readonly sources?: readonly string[];
      readonly frameworks?: readonly string[];
      readonly interop?: "objc" | "cxx";
    };
  };
};

const emptyBuild: ProjectBuild = {
  manifestPath: null,
  sourceImports: {},
  packages: [],
  targetConfigured: false,
  targetKind: "executable",
  targetName: null,
  runtimeInitializer: null,
  entryPath: null,
  deploymentTarget: null,
  includeDirectories: [],
  nativeLibraries: [],
  nativeLinkerArguments: [],
  frameworks: [],
  foreignApiNotes: {},
  generatedBuild: null,
  generatedModulePackages: {},
};

export function applyGeneratedBuildOverlay(
  project: ProjectBuild,
  overlayPath: string,
): ProjectBuild {
  if (project.manifestPath === null) {
    throw new Error("--generated requires a Z project with a z.json manifest");
  }
  const generatedBuild = loadGeneratedBuildOverlay(overlayPath);
  if (generatedBuild.callAdapters.length > 0) {
    throw new Error(
      `${generatedBuild.fileName}: generated call adaptations are declared but are not executable in this compiler tier yet`,
    );
  }
  const sourceImports = { ...project.sourceImports };
  const generatedModulePackages: Record<string, ProjectPackage> = {};
  for (const module of generatedBuild.modules) {
    const existing = sourceImports[module.specifier];
    if (existing !== undefined) {
      throw new Error(
        `${generatedBuild.fileName}: generated module ${JSON.stringify(module.specifier)} `
        + `collides with project source ${JSON.stringify(existing)}`,
      );
    }
    sourceImports[module.specifier] = module.sourcePath;
    if (module.packageName === null) continue;
    const owner = project.packages.find((candidate) => candidate.name === module.packageName);
    if (!owner) {
      throw new Error(
        `${generatedBuild.fileName}: generated module ${JSON.stringify(module.specifier)} `
        + `names unknown package ${JSON.stringify(module.packageName)}`,
      );
    }
    generatedModulePackages[module.sourcePath] = owner;
  }
  return {
    ...project,
    sourceImports,
    generatedBuild,
    generatedModulePackages,
  };
}
const buildCache = new Map<string, { readonly freshness: number; readonly build: ProjectBuild }>();

function projectObject(
  value: unknown,
  field: string,
  fileName: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw projectDiagnostic(fileName, `z.json ${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function rejectUnknownProjectFields(
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
  field: string,
  fileName: string,
): void {
  const unexpected = Object.keys(value).find((key) => !known.includes(key));
  if (unexpected) {
    throw projectDiagnostic(
      fileName,
      `z.json ${field} contains unknown field ${JSON.stringify(unexpected)}`,
    );
  }
}

function validateProjectManifestShape(value: unknown, fileName: string): void {
  const manifest = projectObject(value, "root", fileName);
  rejectUnknownProjectFields(
    manifest,
    ["imports", "package", "library", "dependencies", "target"],
    "root",
    fileName,
  );
  if (manifest.imports !== undefined) {
    const imports = projectObject(manifest.imports, "imports", fileName);
    for (const [specifier, target] of Object.entries(imports)) {
      const segments = specifier.split("/");
      if (
        specifier.length === 0
        || specifier.startsWith("/")
        || specifier.startsWith("./")
        || specifier.startsWith("../")
        || specifier.includes("\\")
        || specifier.includes("\n")
        || specifier.includes("\r")
        || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
        || specifier === "std"
        || specifier.startsWith("std/")
        || specifier.endsWith(".zs")
      ) {
        throw projectDiagnostic(
          fileName,
          `z.json imports key ${JSON.stringify(specifier)} must be a bare Z module specifier`,
        );
      }
      if (typeof target !== "string" || !target.endsWith(".zs")) {
        throw projectDiagnostic(
          fileName,
          `z.json imports.${specifier} must be a Z source path ending in .zs`,
        );
      }
    }
  }
  if (manifest.package !== undefined) {
    const packageDeclaration = projectObject(manifest.package, "package", fileName);
    rejectUnknownProjectFields(packageDeclaration, ["name", "version"], "package", fileName);
    if (
      typeof packageDeclaration.name !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(packageDeclaration.name)
    ) {
      throw projectDiagnostic(fileName, "z.json package.name must be a portable package name");
    }
    if (
      typeof packageDeclaration.version !== "string"
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(packageDeclaration.version)
    ) {
      throw projectDiagnostic(fileName, "z.json package.version must be a semantic version such as \"0.1.0\"");
    }
  }
  if (manifest.library !== undefined) {
    if (manifest.package === undefined) {
      throw projectDiagnostic(fileName, "z.json library requires package metadata");
    }
    const library = projectObject(manifest.library, "library", fileName);
    rejectUnknownProjectFields(library, ["entry", "exports", "native"], "library", fileName);
    if (typeof library.entry !== "string" || !library.entry.endsWith(".zs")) {
      throw projectDiagnostic(fileName, "z.json library.entry must be a Z source path ending in .zs");
    }
    if (library.exports !== undefined) {
      const exports = projectObject(library.exports, "library.exports", fileName);
      for (const [specifier, target] of Object.entries(exports)) {
        if (
          !specifier.startsWith("./")
          || specifier.length <= 2
          || specifier.includes("\\")
          || specifier.endsWith(".zs")
          || specifier.split("/").some((segment, index) => (
            index > 0 && (segment.length === 0 || segment === "." || segment === "..")
          ))
        ) {
          throw projectDiagnostic(
            fileName,
            `z.json library.exports key ${JSON.stringify(specifier)} must be a public subpath such as \"./window\"`,
          );
        }
        if (typeof target !== "string" || !target.endsWith(".zs")) {
          throw projectDiagnostic(
            fileName,
            `z.json library.exports.${specifier} must be a Z source path ending in .zs`,
          );
        }
      }
    }
    if (library.native !== undefined) {
      const native = projectObject(library.native, "library.native", fileName);
      rejectUnknownProjectFields(
        native,
        ["includeDirectories", "link"],
        "library.native",
        fileName,
      );
      if (native.link !== undefined) {
        const link = projectObject(native.link, "library.native.link", fileName);
        rejectUnknownProjectFields(
          link,
          ["directories", "libraries", "frameworks"],
          "library.native.link",
          fileName,
        );
      }
    }
  }
  if (manifest.dependencies !== undefined) {
    const dependencies = projectObject(manifest.dependencies, "dependencies", fileName);
    for (const [name, declaration] of Object.entries(dependencies)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
        throw projectDiagnostic(fileName, `z.json dependency name ${JSON.stringify(name)} must be portable`);
      }
      const dependency = projectObject(declaration, `dependencies.${name}`, fileName);
      rejectUnknownProjectFields(dependency, ["path"], `dependencies.${name}`, fileName);
      if (typeof dependency.path !== "string" || dependency.path.length === 0) {
        throw projectDiagnostic(fileName, `z.json dependencies.${name}.path must name a local package directory`);
      }
    }
  }
  if (manifest.target === undefined) {
    if (manifest.library === undefined) {
      throw projectDiagnostic(fileName, "z.json requires a target or library");
    }
    return;
  }
  const target = projectObject(manifest.target, "target", fileName);
  rejectUnknownProjectFields(
    target,
    [
      "kind",
      "name",
      "entry",
      "platform",
      "minimumVersion",
      "includeDirectories",
      "runtime",
      "link",
      "swift",
    ],
    "target",
    fileName,
  );
  if (target.runtime !== undefined) {
    const runtime = projectObject(target.runtime, "target.runtime", fileName);
    rejectUnknownProjectFields(
      runtime,
      ["initialize"],
      "target.runtime",
      fileName,
    );
  }
  if (target.link !== undefined) {
    const link = projectObject(target.link, "target.link", fileName);
    rejectUnknownProjectFields(
      link,
      ["directories", "libraries", "frameworks"],
      "target.link",
      fileName,
    );
  }
  if (target.swift !== undefined) {
    const swift = projectObject(target.swift, "target.swift", fileName);
    rejectUnknownProjectFields(
      swift,
      ["module", "sources", "frameworks", "interop"],
      "target.swift",
      fileName,
    );
  }
}

function readProjectManifest(manifestPath: string, diagnosticFileName: string): ProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw projectDiagnostic(
      diagnosticFileName,
      `could not read project manifest ${JSON.stringify(manifestPath)}: ${detail}`,
    );
  }
  validateProjectManifestShape(parsed, diagnosticFileName);
  return parsed as ProjectManifest;
}

function addPackageSourceImport(
  sourceImports: Record<string, string>,
  specifier: string,
  sourcePath: string,
  diagnosticFileName: string,
): void {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw projectDiagnostic(
      diagnosticFileName,
      `package export ${JSON.stringify(specifier)} source ${JSON.stringify(sourcePath)} does not exist`,
    );
  }
  const canonical = realpathSync(sourcePath);
  const existing = sourceImports[specifier];
  if (existing !== undefined && realpathSync(existing) !== canonical) {
    throw projectDiagnostic(
      diagnosticFileName,
      `package import ${JSON.stringify(specifier)} resolves to more than one source module`,
    );
  }
  sourceImports[specifier] = canonical;
}

function addLibraryExports(
  manifest: ProjectManifest,
  manifestPath: string,
  sourceImports: Record<string, string>,
  diagnosticFileName: string,
): void {
  const packageName = manifest.package?.name;
  const entry = manifest.library?.entry;
  if (packageName === undefined || entry === undefined) {
    throw projectDiagnostic(
      diagnosticFileName,
      `path dependency ${JSON.stringify(manifestPath)} must declare package metadata and library.entry`,
    );
  }
  const directory = dirname(manifestPath);
  addPackageSourceImport(
    sourceImports,
    packageName,
    resolve(directory, entry),
    diagnosticFileName,
  );
  for (const [subpath, sourcePath] of Object.entries(manifest.library?.exports ?? {})) {
    addPackageSourceImport(
      sourceImports,
      `${packageName}${subpath.slice(1)}`,
      resolve(directory, sourcePath),
      diagnosticFileName,
    );
  }
}

type MutableNativeRequirements = {
  readonly includeDirectories: string[];
  readonly linkDirectories: string[];
  readonly linkLibraries: string[];
  readonly frameworks: string[];
};

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function addLibraryNativeRequirements(
  manifest: ProjectManifest,
  manifestPath: string,
  requirements: MutableNativeRequirements,
  diagnosticFileName: string,
): void {
  const native = manifest.library?.native;
  if (native === undefined) return;
  const directory = dirname(manifestPath);
  appendUnique(
    requirements.includeDirectories,
    parseProjectDirectories(
      native.includeDirectories,
      "library.native.includeDirectories",
      directory,
      diagnosticFileName,
    ),
  );
  appendUnique(
    requirements.linkDirectories,
    parseProjectDirectories(
      native.link?.directories,
      "library.native.link.directories",
      directory,
      diagnosticFileName,
    ),
  );
  appendUnique(
    requirements.linkLibraries,
    parseLinkedLibraries(
      native.link?.libraries,
      "library.native.link.libraries",
      diagnosticFileName,
    ),
  );
  appendUnique(
    requirements.frameworks,
    parseLinkedFrameworks(
      native.link?.frameworks,
      "library.native.link.frameworks",
      diagnosticFileName,
    ),
  );
}

function addPathDependencies(
  manifest: ProjectManifest,
  manifestPath: string,
  sourceImports: Record<string, string>,
  nativeRequirements: MutableNativeRequirements,
  packageIdentities: ProjectPackage[],
  diagnosticFileName: string,
): void {
  const packages = new Map<string, string>();
  const active = new Set<string>();

  const visit = (declaredName: string, declaredPath: string, ownerManifestPath: string): void => {
    const ownerDirectory = dirname(ownerManifestPath);
    const packageDirectory = resolve(ownerDirectory, declaredPath);
    const dependencyManifestPath = resolve(packageDirectory, "z.json");
    if (!existsSync(dependencyManifestPath) || !statSync(dependencyManifestPath).isFile()) {
      throw projectDiagnostic(
        diagnosticFileName,
        `z.json dependencies.${declaredName}.path must contain a z.json manifest: ${JSON.stringify(packageDirectory)}`,
      );
    }
    const canonicalManifestPath = realpathSync(dependencyManifestPath);
    if (active.has(canonicalManifestPath)) {
      throw projectDiagnostic(
        diagnosticFileName,
        `circular path dependency involving ${JSON.stringify(declaredName)}`,
      );
    }
    const existing = packages.get(declaredName);
    if (existing !== undefined) {
      if (existing !== canonicalManifestPath) {
        throw projectDiagnostic(
          diagnosticFileName,
          `path dependency ${JSON.stringify(declaredName)} resolves to both ${JSON.stringify(existing)} and ${JSON.stringify(canonicalManifestPath)}`,
        );
      }
      return;
    }
    active.add(canonicalManifestPath);
    const dependencyManifest = readProjectManifest(canonicalManifestPath, diagnosticFileName);
    if (dependencyManifest.package?.name !== declaredName) {
      throw projectDiagnostic(
        diagnosticFileName,
        `z.json dependency ${JSON.stringify(declaredName)} points to package ${JSON.stringify(dependencyManifest.package?.name ?? "<missing>")}`,
      );
    }
    packages.set(declaredName, canonicalManifestPath);
    packageIdentities.push({
      id: canonicalManifestPath,
      name: declaredName,
      rootDirectory: dirname(canonicalManifestPath),
    });
    for (const [specifier, sourcePath] of Object.entries(dependencyManifest.imports ?? {})) {
      addPackageSourceImport(
        sourceImports,
        specifier,
        resolve(dirname(canonicalManifestPath), sourcePath),
        diagnosticFileName,
      );
    }
    addLibraryExports(
      dependencyManifest,
      canonicalManifestPath,
      sourceImports,
      diagnosticFileName,
    );
    addLibraryNativeRequirements(
      dependencyManifest,
      canonicalManifestPath,
      nativeRequirements,
      diagnosticFileName,
    );
    for (const [name, declaration] of Object.entries(dependencyManifest.dependencies ?? {})) {
      visit(name, declaration.path!, canonicalManifestPath);
    }
    active.delete(canonicalManifestPath);
  };

  for (const [name, declaration] of Object.entries(manifest.dependencies ?? {})) {
    visit(name, declaration.path!, manifestPath);
  }
}

export function prepareProject(fileName: string): ProjectBuild {
  const discoveredManifestPath = findManifest(fileName);
  if (!discoveredManifestPath) return emptyBuild;
  const manifestPath = realpathSync(discoveredManifestPath);
  const directory = dirname(manifestPath);
  const manifest = readProjectManifest(manifestPath, fileName);

  const sourceImports: Record<string, string> = {};
  const packages: ProjectPackage[] = [];
  if (manifest.package?.name !== undefined) {
    packages.push({
      id: manifestPath,
      name: manifest.package.name,
      rootDirectory: directory,
    });
  }
  for (const [specifier, sourcePath] of Object.entries(manifest.imports ?? {})) {
    const resolvedSourcePath = resolve(directory, sourcePath);
    if (!existsSync(resolvedSourcePath)) {
      throw projectDiagnostic(
        fileName,
        `z.json imports.${specifier} source ${JSON.stringify(resolvedSourcePath)} does not exist`,
      );
    }
    sourceImports[specifier] = resolvedSourcePath;
  }
  if (manifest.package !== undefined && manifest.library !== undefined) {
    addLibraryExports(manifest, manifestPath, sourceImports, fileName);
  }
  const nativeRequirements: MutableNativeRequirements = {
    includeDirectories: [],
    linkDirectories: [],
    linkLibraries: [],
    frameworks: [],
  };
  addLibraryNativeRequirements(manifest, manifestPath, nativeRequirements, fileName);
  addPathDependencies(
    manifest,
    manifestPath,
    sourceImports,
    nativeRequirements,
    packages,
    fileName,
  );

  const swift = manifest.target?.swift;
  const targetKind = manifest.target?.kind ?? "executable";
  if (
    targetKind !== "executable"
    && targetKind !== "static-library"
    && targetKind !== "shared-library"
  ) {
    throw projectDiagnostic(
      fileName,
      'z.json target.kind must be "executable", "static-library", or "shared-library"',
    );
  }
  const targetName = manifest.target?.name ?? null;
  if (manifest.target !== undefined && targetName === null) {
    throw projectDiagnostic(fileName, "z.json targets require target.name");
  }
  if (targetName !== null && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(targetName)) {
    throw projectDiagnostic(fileName, "z.json target.name must be a portable artifact name");
  }
  const runtimeInitializer = manifest.target?.runtime?.initialize ?? null;
  if (manifest.target?.runtime !== undefined && runtimeInitializer === null) {
    throw projectDiagnostic(
      fileName,
      "z.json target.runtime requires initialize",
    );
  }
  if (
    runtimeInitializer !== null
    && (
      typeof runtimeInitializer !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeInitializer)
    )
  ) {
    throw projectDiagnostic(
      fileName,
      "z.json target.runtime.initialize must name a Z function in the target entry module",
    );
  }
  if (runtimeInitializer !== null && targetKind === "executable") {
    throw projectDiagnostic(
      fileName,
      "z.json target.runtime.initialize is only valid for static-library and shared-library targets",
    );
  }
  let entryPath: string | null = null;
  if (manifest.target?.entry !== undefined) {
    if (typeof manifest.target.entry !== "string" || !manifest.target.entry.endsWith(".zs")) {
      throw projectDiagnostic(fileName, "z.json target.entry must be a Z source path");
    }
    entryPath = resolve(directory, manifest.target.entry);
    if (!existsSync(entryPath)) throw projectDiagnostic(fileName, `Z entry ${JSON.stringify(entryPath)} does not exist`);
  } else if (manifest.target !== undefined) {
    throw projectDiagnostic(fileName, "z.json targets require target.entry");
  } else if (manifest.library?.entry !== undefined) {
    entryPath = resolve(directory, manifest.library.entry);
    if (!existsSync(entryPath)) {
      throw projectDiagnostic(fileName, `Z library entry ${JSON.stringify(entryPath)} does not exist`);
    }
  }
  const deploymentTarget = manifest.target === undefined
    ? null
    : parseDeploymentTarget(manifest.target, fileName);
  const targetIncludeDirectories = parseProjectDirectories(
    manifest.target?.includeDirectories,
    "target.includeDirectories",
    directory,
    fileName,
  );
  const targetLinkedDirectories = parseProjectDirectories(
    manifest.target?.link?.directories,
    "target.link.directories",
    directory,
    fileName,
  );
  const targetLinkedLibraries = parseLinkedLibraries(
    manifest.target?.link?.libraries,
    "target.link.libraries",
    fileName,
  );
  const targetLinkedFrameworks = parseLinkedFrameworks(
    manifest.target?.link?.frameworks,
    "target.link.frameworks",
    fileName,
  );
  const includeDirectories = [...new Set([
    ...targetIncludeDirectories,
    ...nativeRequirements.includeDirectories,
  ])];
  const linkedDirectories = [...new Set([
    ...targetLinkedDirectories,
    ...nativeRequirements.linkDirectories,
  ])];
  const linkedLibraries = [...new Set([
    ...targetLinkedLibraries,
    ...nativeRequirements.linkLibraries,
  ])];
  const linkedFrameworks = [...new Set([
    ...targetLinkedFrameworks,
    ...nativeRequirements.frameworks,
  ])];
  const baseBuild: ProjectBuild = {
    ...emptyBuild,
    manifestPath,
    sourceImports,
    packages,
    targetConfigured: manifest.target !== undefined,
    targetKind,
    targetName,
    runtimeInitializer,
    entryPath,
    deploymentTarget,
    includeDirectories,
    nativeLinkerArguments: [
      ...linkedDirectories.map((linkedDirectory) => `-L${linkedDirectory}`),
      ...linkedLibraries.map((library) => `-l${library}`),
    ],
    frameworks: linkedFrameworks,
  };
  if (!swift) return baseBuild;
  const moduleName = swift.module;
  if (!moduleName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(moduleName)) {
    throw projectDiagnostic(fileName, "z.json target.swift.module must be a valid module name");
  }
  if (!Array.isArray(swift.sources) || swift.sources.length === 0 || swift.sources.some((source) => typeof source !== "string" || !source.endsWith(".swift"))) {
    throw projectDiagnostic(fileName, "z.json target.swift.sources must contain at least one Swift source path");
  }
  if (swift.frameworks && (!Array.isArray(swift.frameworks) || swift.frameworks.some((framework) => typeof framework !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(framework)))) {
    throw projectDiagnostic(fileName, "z.json target.swift.frameworks must contain framework names");
  }
  if (swift.interop !== undefined && swift.interop !== "objc" && swift.interop !== "cxx") {
    throw projectDiagnostic(fileName, "z.json target.swift.interop must be either \"objc\" or \"cxx\"");
  }
  if (process.platform !== "darwin") {
    throw projectDiagnostic(fileName, "Swift targets currently require macOS");
  }

  const sources = swift.sources.map((source) => resolve(directory, source));
  for (const source of sources) {
    if (!existsSync(source)) throw projectDiagnostic(fileName, `Swift source ${JSON.stringify(source)} does not exist`);
  }
  const buildDirectory = resolve(directory, ".z-cache", "swift", moduleName);
  const cxxInterop = swift.interop === "cxx";
  const header = resolve(buildDirectory, `${moduleName}-Swift.${cxxInterop ? "hpp" : "h"}`);
  const library = resolve(buildDirectory, `lib${moduleName}.dylib`);
  const symbolGraphDirectory = resolve(buildDirectory, "symbol-graphs");
  const symbolGraph = resolve(symbolGraphDirectory, `${moduleName}.symbols.json`);
  const freshness = Math.max(statSync(manifestPath).mtimeMs, ...sources.map((source) => statSync(source).mtimeMs));
  const cached = buildCache.get(manifestPath);
  const outputsFresh = existsSync(header)
    && existsSync(library)
    && statSync(library).mtimeMs >= freshness
    && (cxxInterop || (existsSync(symbolGraph) && statSync(symbolGraph).mtimeMs >= freshness));
  if (cached?.freshness === freshness && outputsFresh) return cached.build;
  if (!outputsFresh) {
    mkdirSync(buildDirectory, { recursive: true });
    const result = spawnSync("xcrun", [
      "swiftc",
      ...(process.env.SWIFT_MODULECACHE_PATH
        ? ["-module-cache-path", process.env.SWIFT_MODULECACHE_PATH]
        : []),
      ...(deploymentTarget ? ["-target", deploymentTargetTriple(deploymentTarget)] : []),
      "-emit-library",
      "-emit-module",
      "-module-name", moduleName,
      ...(cxxInterop ? ["-cxx-interoperability-mode=default"] : []),
      "-emit-objc-header-path", header,
      ...sources,
      "-o", library,
    ], { encoding: "utf8" });
    if (result.error) {
      throw projectDiagnostic(fileName, `could not run swiftc for ${JSON.stringify(moduleName)}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim().split("\n").find((line) => line.includes("error:"))
        ?? result.stderr.trim().split("\n")[0]
        ?? "swiftc failed";
      throw projectDiagnostic(fileName, `could not build Swift module ${JSON.stringify(moduleName)}: ${detail}`);
    }
    if (!cxxInterop) {
      mkdirSync(symbolGraphDirectory, { recursive: true });
      if (existsSync(symbolGraph)) unlinkSync(symbolGraph);
      const graphResult = spawnSync("xcrun", [
        "swift-symbolgraph-extract",
        "-module-name", moduleName,
        "-I", buildDirectory,
        "-target", deploymentTarget
          ? deploymentTargetTriple(deploymentTarget)
          : swiftHostTargetTriple(fileName),
        "-sdk", macosSdkPath(fileName),
        "-output-dir", symbolGraphDirectory,
      ], { encoding: "utf8" });
      if (graphResult.error) {
        throw projectDiagnostic(fileName, `could not inspect Swift module ${JSON.stringify(moduleName)} for executor metadata: ${graphResult.error.message}`);
      }
      if (graphResult.status !== 0) {
        const detail = graphResult.stderr.trim().split("\n").find((line) => line.includes("error:"))
          ?? graphResult.stderr.trim().split("\n")[0]
          ?? "swift-symbolgraph-extract failed";
        throw projectDiagnostic(fileName, `could not inspect Swift module ${JSON.stringify(moduleName)} for executor metadata: ${detail}`);
      }
    }
  }

  const compatibilityHeader = `${moduleName}-Swift.${cxxInterop ? "hpp" : "h"}`;
  const build: ProjectBuild = {
    ...baseBuild,
    includeDirectories: [...baseBuild.includeDirectories, buildDirectory],
    nativeLibraries: [library],
    nativeLinkerArguments: [
      ...baseBuild.nativeLinkerArguments,
      ...(cxxInterop ? swiftRuntimeLinkerArguments(fileName) : []),
    ],
    frameworks: [...new Set([
      ...baseBuild.frameworks,
      ...(swift.frameworks ?? []),
    ])],
    foreignApiNotes: cxxInterop
      ? {}
      : { [compatibilityHeader]: swiftExecutorApiNotes(symbolGraph, fileName) },
  };
  buildCache.set(manifestPath, { freshness, build });
  return build;
}

function parseProjectDirectories(
  directories: readonly string[] | undefined,
  field: string,
  manifestDirectory: string,
  fileName: string,
): string[] {
  if (directories === undefined) return [];
  if (
    !Array.isArray(directories)
    || directories.some((directory) => typeof directory !== "string" || directory.length === 0)
  ) {
    throw projectDiagnostic(fileName, `z.json ${field} must contain directory paths`);
  }
  const resolvedDirectories = [...new Set(directories.map((directory) => resolve(manifestDirectory, directory)))];
  for (const directory of resolvedDirectories) {
    if (!existsSync(directory)) {
      throw projectDiagnostic(fileName, `z.json ${field} directory ${JSON.stringify(directory)} does not exist`);
    }
    if (!statSync(directory).isDirectory()) {
      throw projectDiagnostic(fileName, `z.json ${field} path ${JSON.stringify(directory)} is not a directory`);
    }
  }
  return [...new Set(resolvedDirectories.map((directory) => realpathSync(directory)))];
}

function parseLinkedLibraries(
  libraries: readonly string[] | undefined,
  field: string,
  fileName: string,
): string[] {
  if (libraries === undefined) return [];
  if (
    !Array.isArray(libraries)
    || libraries.some((library) => (
      typeof library !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(library)
    ))
  ) {
    throw projectDiagnostic(fileName, `z.json ${field} must contain native library names such as "sqlite3"`);
  }
  return [...new Set(libraries)];
}

function parseLinkedFrameworks(
  frameworks: readonly string[] | undefined,
  field: string,
  fileName: string,
): string[] {
  if (frameworks === undefined) return [];
  if (
    !Array.isArray(frameworks)
    || frameworks.some((framework) => (
      typeof framework !== "string"
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(framework)
    ))
  ) {
    throw projectDiagnostic(fileName, `z.json ${field} must contain Apple framework names such as "AppKit"`);
  }
  return [...new Set(frameworks)];
}

function swiftRuntimeLinkerArguments(fileName: string): string[] {
  const runtimeLibraryDirectory = resolve(macosSdkPath(fileName), "usr/lib/swift");
  if (!existsSync(runtimeLibraryDirectory)) {
    throw projectDiagnostic(fileName, `Swift runtime link directory ${JSON.stringify(runtimeLibraryDirectory)} does not exist`);
  }
  return ["-L", runtimeLibraryDirectory, "-lswiftCore"];
}

function macosSdkPath(fileName: string): string {
  const result = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
  if (result.error) {
    throw projectDiagnostic(fileName, `could not locate the macOS SDK for Swift interop: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw projectDiagnostic(fileName, `could not locate the macOS SDK for Swift interop: ${result.stderr.trim() || "xcrun failed"}`);
  }
  return result.stdout.trim();
}

function swiftHostTargetTriple(fileName: string): string {
  const result = spawnSync("xcrun", ["swiftc", "-print-target-info"], { encoding: "utf8" });
  if (result.error) {
    throw projectDiagnostic(fileName, `could not inspect the Swift compiler target: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw projectDiagnostic(fileName, `could not inspect the Swift compiler target: ${result.stderr.trim() || "swiftc failed"}`);
  }
  try {
    const parsed = JSON.parse(result.stdout) as { readonly target?: { readonly triple?: unknown } };
    if (typeof parsed.target?.triple === "string" && parsed.target.triple.length > 0) {
      return parsed.target.triple;
    }
  } catch {
    // The diagnostic below describes the stable contract Z needs from swiftc.
  }
  throw projectDiagnostic(fileName, "Swift compiler target information did not contain a target triple");
}

function swiftExecutorApiNotes(symbolGraphPath: string, fileName: string): ApiNotes {
  let graph: {
    readonly symbols?: readonly {
      readonly identifier?: { readonly precise?: unknown };
      readonly declarationFragments?: readonly {
        readonly spelling?: unknown;
        readonly preciseIdentifier?: unknown;
      }[];
    }[];
  };
  try {
    graph = JSON.parse(readFileSync(symbolGraphPath, "utf8")) as typeof graph;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw projectDiagnostic(fileName, `could not read Swift executor metadata ${JSON.stringify(symbolGraphPath)}: ${detail}`);
  }
  const types: Record<string, { executorAffinity: "main" }> = {};
  const objcMethods: Record<string, { executorAffinity: "main" }> = {};
  for (const symbol of graph.symbols ?? []) {
    const mainActor = symbol.declarationFragments?.some((fragment) => (
      fragment.preciseIdentifier === "s:ScM"
      || fragment.spelling === "MainActor"
    )) ?? false;
    if (!mainActor || typeof symbol.identifier?.precise !== "string") continue;
    const precise = symbol.identifier.precise;
    const method = precise.match(/@objc\(cs\)([^@()]+)\((?:cm|im)\)(.+)$/);
    if (method) {
      objcMethods[`${method[1]}.${method[2]}`] = { executorAffinity: "main" };
      continue;
    }
    const type = precise.match(/@objc\(cs\)([^@()]+)$/);
    if (type) types[type[1]] = { executorAffinity: "main" };
  }
  return {
    ...(Object.keys(types).length > 0 ? { types } : {}),
    ...(Object.keys(objcMethods).length > 0 ? { objcMethods } : {}),
  };
}

function parseDeploymentTarget(target: ProjectManifest["target"], fileName: string): DeploymentTarget | null {
  const platform = target?.platform;
  const minimumVersion = target?.minimumVersion;
  if (platform === undefined && minimumVersion === undefined) return null;
  if (typeof platform !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(platform)) {
    throw projectDiagnostic(fileName, "z.json target.platform must be a platform name when target.minimumVersion is set");
  }
  if (typeof minimumVersion !== "string" || !/^[0-9]+(?:\.[0-9]+){0,3}$/.test(minimumVersion)) {
    throw projectDiagnostic(fileName, "z.json target.minimumVersion must be a numeric version such as \"13.0\"");
  }
  const normalized = normalizeTargetPlatform(platform);
  const host = hostTargetPlatform();
  if (normalized !== host) {
    throw projectDiagnostic(fileName, `cross-compilation is not implemented; target.platform is ${JSON.stringify(normalized)}, but this compiler host is ${JSON.stringify(host)}`);
  }
  return { platform: normalized, minimumVersion: normalizeTargetVersion(minimumVersion) };
}

export function normalizeTargetPlatform(platform: string): string {
  const normalized = platform.toLowerCase().replace(/[_-]/g, "");
  if (normalized === "macos" || normalized === "macosx" || normalized === "darwin") return "macos";
  if (normalized === "win32" || normalized === "windows") return "windows";
  return platform.toLowerCase();
}

export function hostTargetPlatform(): string {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return process.platform;
}

export function normalizeTargetVersion(version: string): string {
  return version.split(".").map((part) => String(Number(part))).join(".");
}

export function compareTargetVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function deploymentTargetFlags(target: DeploymentTarget | null): string[] {
  if (!target) return [];
  if (target.platform === "macos") return [`-mmacosx-version-min=${target.minimumVersion}`];
  return [];
}

export function deploymentTargetTriple(target: DeploymentTarget): string {
  if (target.platform === "macos") {
    const architecture = process.arch === "x64" ? "x86_64" : process.arch;
    return `${architecture}-apple-macosx${target.minimumVersion}`;
  }
  throw new Error(`deployment target triple is not implemented for ${target.platform}`);
}

export function displayTargetPlatform(platform: string): string {
  if (platform === "macos") return "macOS";
  if (platform === "ios") return "iOS";
  if (platform === "windows") return "Windows";
  return platform;
}

function findManifest(fileName: string): string | null {
  let directory = resolve(dirname(fileName));
  while (true) {
    const candidate = resolve(directory, "z.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function projectDiagnostic(fileName: string, message: string): DiagnosticError {
  return new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, message);
}
