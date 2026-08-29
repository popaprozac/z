import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type GeneratedModule = {
  readonly specifier: string;
  readonly sourcePath: string;
  readonly packageName: string | null;
};

export type GeneratedCallAdapter = {
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly offset: number;
  readonly target: string;
  readonly replacement: string;
  readonly argument: number;
  readonly adapterModule: string;
  readonly adapterExport: string;
};

export type GeneratedBuildOverlay = {
  readonly schemaVersion: 1;
  readonly fileName: string;
  readonly modules: readonly GeneratedModule[];
  readonly callAdapters: readonly GeneratedCallAdapter[];
};

type ObjectValue = Readonly<Record<string, unknown>>;

function fail(fileName: string, message: string): never {
  throw new Error(`${fileName}: generated build overlay ${message}`);
}

function objectValue(value: unknown, field: string, fileName: string): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(fileName, `${field} must be an object`);
  }
  return value as ObjectValue;
}

function rejectUnknown(
  value: ObjectValue,
  known: readonly string[],
  field: string,
  fileName: string,
): void {
  const unknown = Object.keys(value).find((key) => !known.includes(key));
  if (unknown) fail(fileName, `${field} contains unknown field ${JSON.stringify(unknown)}`);
}

function sourceSpecifier(value: unknown, field: string, fileName: string): string {
  if (typeof value !== "string") fail(fileName, `${field} must be a string`);
  const segments = value.split("/");
  if (
    value.length === 0
    || value.startsWith("/")
    || value.startsWith("./")
    || value.startsWith("../")
    || value.includes("\\")
    || value.includes("\n")
    || value.includes("\r")
    || value.endsWith(".zs")
    || value === "std"
    || value.startsWith("std/")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail(fileName, `${field} must be a bare non-std Z module specifier`);
  }
  return value;
}

function identifier(value: unknown, field: string, fileName: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    fail(fileName, `${field} must be a Z identifier`);
  }
  return value;
}

function qualifiedSymbol(value: unknown, field: string, fileName: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/.test(value)
  ) {
    fail(fileName, `${field} must be a qualified Z symbol such as Type.method`);
  }
  return value;
}

function resolveSourcePath(
  value: unknown,
  field: string,
  overlayPath: string,
  fileName: string,
): string {
  if (typeof value !== "string" || !value.endsWith(".zs")) {
    fail(fileName, `${field} must be a .zs source path`);
  }
  const path = resolve(dirname(overlayPath), value);
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(fileName, `${field} source ${JSON.stringify(path)} does not exist`);
  }
  return realpathSync(path);
}

function parseModules(
  value: unknown,
  overlayPath: string,
  fileName: string,
): GeneratedModule[] {
  const declarations = objectValue(value, "modules", fileName);
  const modules: GeneratedModule[] = [];
  for (const [rawSpecifier, rawDeclaration] of Object.entries(declarations)) {
    const specifier = sourceSpecifier(rawSpecifier, `modules key ${JSON.stringify(rawSpecifier)}`, fileName);
    const declaration = objectValue(rawDeclaration, `modules.${specifier}`, fileName);
    rejectUnknown(declaration, ["source", "package"], `modules.${specifier}`, fileName);
    const packageName = declaration.package === undefined
      ? null
      : identifier(declaration.package, `modules.${specifier}.package`, fileName);
    modules.push({
      specifier,
      sourcePath: resolveSourcePath(
        declaration.source,
        `modules.${specifier}.source`,
        overlayPath,
        fileName,
      ),
      packageName,
    });
  }
  return modules;
}

function parseCallAdapters(
  value: unknown,
  overlayPath: string,
  fileName: string,
  modules: readonly GeneratedModule[],
): GeneratedCallAdapter[] {
  if (!Array.isArray(value)) fail(fileName, "callAdapters must be an array");
  return value.map((rawAdapter, index) => {
    const field = `callAdapters[${index}]`;
    const adapter = objectValue(rawAdapter, field, fileName);
    rejectUnknown(
      adapter,
      ["source", "sourceHash", "offset", "target", "replacement", "argument", "adapter"],
      field,
      fileName,
    );
    const adapterDeclaration = objectValue(adapter.adapter, `${field}.adapter`, fileName);
    rejectUnknown(adapterDeclaration, ["module", "export"], `${field}.adapter`, fileName);
    const adapterModule = sourceSpecifier(
      adapterDeclaration.module,
      `${field}.adapter.module`,
      fileName,
    );
    if (!modules.some((module) => module.specifier === adapterModule)) {
      fail(fileName, `${field}.adapter.module must name a module declared by this overlay`);
    }
    if (typeof adapter.sourceHash !== "string" || !/^[0-9a-f]{64}$/.test(adapter.sourceHash)) {
      fail(fileName, `${field}.sourceHash must be a lowercase SHA-256 digest`);
    }
    if (!Number.isSafeInteger(adapter.offset) || (adapter.offset as number) < 0) {
      fail(fileName, `${field}.offset must be a non-negative integer`);
    }
    if (!Number.isSafeInteger(adapter.argument) || (adapter.argument as number) < 0) {
      fail(fileName, `${field}.argument must be a non-negative integer`);
    }
    return {
      sourcePath: resolveSourcePath(adapter.source, `${field}.source`, overlayPath, fileName),
      sourceHash: adapter.sourceHash,
      offset: adapter.offset as number,
      target: qualifiedSymbol(adapter.target, `${field}.target`, fileName),
      replacement: qualifiedSymbol(adapter.replacement, `${field}.replacement`, fileName),
      argument: adapter.argument as number,
      adapterModule,
      adapterExport: identifier(adapterDeclaration.export, `${field}.adapter.export`, fileName),
    };
  });
}

export function loadGeneratedBuildOverlay(path: string): GeneratedBuildOverlay {
  const requestedPath = resolve(path);
  if (!requestedPath.endsWith(".zbuild.json")) {
    throw new Error("generated build overlays must use the .zbuild.json extension");
  }
  if (!existsSync(requestedPath) || !statSync(requestedPath).isFile()) {
    throw new Error(`generated build overlay ${JSON.stringify(requestedPath)} does not exist`);
  }
  const overlayPath = realpathSync(requestedPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(overlayPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${overlayPath}: could not parse generated build overlay: ${detail}`);
  }
  const root = objectValue(parsed, "root", overlayPath);
  rejectUnknown(root, ["schemaVersion", "modules", "callAdapters"], "root", overlayPath);
  if (root.schemaVersion !== 1) fail(overlayPath, "schemaVersion must be 1");
  const modules = parseModules(root.modules, overlayPath, overlayPath);
  const callAdapters = root.callAdapters === undefined
    ? []
    : parseCallAdapters(root.callAdapters, overlayPath, overlayPath, modules);
  return {
    schemaVersion: 1,
    fileName: overlayPath,
    modules,
    callAdapters,
  };
}
