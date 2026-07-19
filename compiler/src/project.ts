import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DiagnosticError } from "./diagnostics.ts";

export type ProjectBuild = {
  readonly manifestPath: string | null;
  readonly deploymentTarget: DeploymentTarget | null;
  readonly includeDirectories: readonly string[];
  readonly nativeLibraries: readonly string[];
  readonly nativeLinkerArguments: readonly string[];
  readonly frameworks: readonly string[];
};

export type DeploymentTarget = {
  readonly platform: string;
  readonly minimumVersion: string;
};

type ProjectManifest = {
  readonly target?: {
    readonly entry?: string;
    readonly platform?: string;
    readonly minimumVersion?: string;
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
  deploymentTarget: null,
  includeDirectories: [],
  nativeLibraries: [],
  nativeLinkerArguments: [],
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
  if (manifest.target?.entry !== undefined) {
    if (typeof manifest.target.entry !== "string" || !manifest.target.entry.endsWith(".z")) {
      throw projectDiagnostic(fileName, "z.json target.entry must be a Z source path");
    }
    const entry = resolve(directory, manifest.target.entry);
    if (!existsSync(entry)) throw projectDiagnostic(fileName, `Z entry ${JSON.stringify(entry)} does not exist`);
  }
  const deploymentTarget = parseDeploymentTarget(manifest.target, fileName);
  if (!swift) return { ...emptyBuild, manifestPath, deploymentTarget };
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
  }

  const build: ProjectBuild = {
    manifestPath,
    deploymentTarget,
    includeDirectories: [buildDirectory],
    nativeLibraries: [library],
    nativeLinkerArguments: cxxInterop ? swiftRuntimeLinkerArguments(fileName) : [],
    frameworks: [...(swift.frameworks ?? [])],
  };
  buildCache.set(manifestPath, { freshness, build });
  return build;
}

function swiftRuntimeLinkerArguments(fileName: string): string[] {
  const result = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" });
  if (result.error) {
    throw projectDiagnostic(fileName, `could not locate the macOS SDK for Swift C++ interop: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw projectDiagnostic(fileName, `could not locate the macOS SDK for Swift C++ interop: ${result.stderr.trim() || "xcrun failed"}`);
  }
  const runtimeLibraryDirectory = resolve(result.stdout.trim(), "usr/lib/swift");
  if (!existsSync(runtimeLibraryDirectory)) {
    throw projectDiagnostic(fileName, `Swift runtime link directory ${JSON.stringify(runtimeLibraryDirectory)} does not exist`);
  }
  return ["-L", runtimeLibraryDirectory, "-lswiftCore"];
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
