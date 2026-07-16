import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DiagnosticError } from "./diagnostics.ts";

export type ProjectBuild = {
  readonly manifestPath: string | null;
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
  readonly frameworks: readonly string[];
};

type ProjectManifest = {
  readonly target?: {
    readonly entry?: string;
    readonly swift?: {
      readonly module?: string;
      readonly sources?: readonly string[];
      readonly frameworks?: readonly string[];
    };
  };
};

const emptyBuild: ProjectBuild = {
  manifestPath: null,
  includeDirectories: [],
  nativeLibraries: [],
  frameworks: [],
};
const buildCache = new Map<string, { readonly freshness: number; readonly build: ProjectBuild }>();

export function prepareProject(fileName: string): ProjectBuild {
  const manifestPath = findManifest(fileName);
  if (!manifestPath) return emptyBuild;
  const directory = dirname(manifestPath);
  let manifest: ProjectManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProjectManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw projectDiagnostic(fileName, `could not read project manifest ${JSON.stringify(manifestPath)}: ${detail}`);
  }

  const swift = manifest.target?.swift;
  if (!swift) return { ...emptyBuild, manifestPath };
  if (manifest.target?.entry !== undefined) {
    if (typeof manifest.target.entry !== "string" || !manifest.target.entry.endsWith(".z")) {
      throw projectDiagnostic(fileName, "z.json target.entry must be a Z source path");
    }
    const entry = resolve(directory, manifest.target.entry);
    if (!existsSync(entry)) throw projectDiagnostic(fileName, `Z entry ${JSON.stringify(entry)} does not exist`);
  }
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
  if (process.platform !== "darwin") {
    throw projectDiagnostic(fileName, "Swift Objective-C compatibility targets currently require macOS");
  }

  const sources = swift.sources.map((source) => resolve(directory, source));
  for (const source of sources) {
    if (!existsSync(source)) throw projectDiagnostic(fileName, `Swift source ${JSON.stringify(source)} does not exist`);
  }
  const buildDirectory = resolve(directory, ".z-cache", "swift", moduleName);
  const header = resolve(buildDirectory, `${moduleName}-Swift.h`);
  const library = resolve(buildDirectory, `lib${moduleName}.dylib`);
  const freshness = Math.max(statSync(manifestPath).mtimeMs, ...sources.map((source) => statSync(source).mtimeMs));
  const cached = buildCache.get(manifestPath);
  const outputsFresh = existsSync(header)
    && existsSync(library)
    && Math.min(statSync(header).mtimeMs, statSync(library).mtimeMs) >= freshness;
  if (cached?.freshness === freshness && outputsFresh) return cached.build;
  if (!outputsFresh) {
    mkdirSync(buildDirectory, { recursive: true });
    const result = spawnSync("xcrun", [
      "swiftc",
      "-emit-library",
      "-emit-module",
      "-module-name", moduleName,
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
  }

  const build: ProjectBuild = {
    manifestPath,
    includeDirectories: [buildDirectory],
    nativeLibraries: [library],
    frameworks: [...(swift.frameworks ?? [])],
  };
  buildCache.set(manifestPath, { freshness, build });
  return build;
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
