import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  TypeReference,
} from "./ast.ts";
import {
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { isNullableObjCTypeName, nullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import {
  sourceStandardModuleRelativePath,
  type StandardModuleName,
} from "./standard-library.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";
import { parseReadonlyType, readonlyTypeName } from "./readonly-types.ts";
import { onceStateTypeName } from "./once-types.ts";
import {
  applyGeneratedCallAdaptersToProgram,
  type ValidatedGeneratedCallAdapter,
} from "./generated-call-adaptation.ts";

export type SourceModuleInfo = {
  readonly fileName: string;
  readonly packageId: string | null;
  readonly packageName: string | null;
  readonly program: Program;
  readonly exports: ReadonlyMap<string, { readonly linkedName: string; readonly location: SourceLocation }>;
  readonly internals: ReadonlyMap<string, { readonly linkedName: string; readonly location: SourceLocation }>;
};

export type ModuleLinkResult = {
  readonly program: Program;
  readonly modules: ReadonlyMap<string, SourceModuleInfo>;
  readonly sourceBatch: SourceModuleBatch;
  readonly includeDirectories: readonly string[];
  readonly typeDisplayNames: ReadonlyMap<string, string>;
};

export type SourceModuleBatchModule = {
  readonly fileName: string;
  readonly source: string;
  readonly program: Program;
  readonly dependencies: ReadonlyMap<number, string>;
  readonly packageSpecifiers: Set<string>;
  readonly packageId: string | null;
  readonly packageName: string | null;
};

export type SourceModuleBatch = {
  readonly entryFileName: string;
  readonly modules: readonly SourceModuleBatchModule[];
};

export type SourceModuleOptions = {
  readonly standardLibraryRoot?: string;
  readonly sourceImports?: Readonly<Record<string, string>>;
  readonly packages?: readonly {
    readonly id: string;
    readonly name: string;
    readonly rootDirectory: string;
  }[];
  readonly generatedModulePackages?: Readonly<Record<string, {
    readonly id: string;
    readonly name: string;
    readonly rootDirectory: string;
  }>>;
  readonly generatedCallAdapters?: readonly ValidatedGeneratedCallAdapter[];
};

type ModuleNode = {
  readonly id: number;
  readonly fileName: string;
  readonly program: Program;
  readonly dependencies: Map<number, ModuleNode>;
  readonly ownNames: Map<string, string>;
  readonly exports: Map<string, { readonly linkedName: string; readonly location: SourceLocation }>;
  readonly internals: Map<string, { readonly linkedName: string; readonly location: SourceLocation }>;
  readonly packageId: string | null;
  readonly packageName: string | null;
};

type ModuleScope = {
  readonly packageId: string | null;
  readonly globals: Map<string, string>;
  readonly namespaces: Map<string, ModuleNode>;
  readonly standardModules: Map<string, StandardModuleName>;
  readonly standardTypes: Map<string, "TextBuffer" | "Arena" | "Map" | "Set" | "Hashable" | "Hasher" | "Once" | "OnceLifetime" | "OnceState" | "Mutex" | "Channel" | "Sender" | "Receiver" | "SyncSender" | "SyncReceiver" | "ChannelClosed">;
};

export function isLocalSourceModuleSpecifier(specifier: string): boolean {
  return (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".zs");
}

export function loadSourceModuleBatch(
  entrySource: string,
  entryProgram: Program,
  entryFileName: string,
  options: SourceModuleOptions = {},
): SourceModuleBatch {
  const entryPath = resolve(entryFileName);
  const standardLibraryRoot = resolve(
    options.standardLibraryRoot
      ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../stdlib"),
  );
  const modules = new Map<string, SourceModuleBatchModule>();
  const packageForFile = (fileName: string) => {
    const matches = (options.packages ?? []).filter((candidate) => (
      fileName === candidate.rootDirectory || fileName.startsWith(`${candidate.rootDirectory}${sep}`)
    ));
    matches.sort((left, right) => right.rootDirectory.length - left.rootDirectory.length);
    return matches[0] ?? null;
  };

  const load = (
    fileName: string,
    suppliedSource: string | null,
    suppliedProgram: Program | null,
    stack: readonly string[],
    importDeclaration: ImportDeclaration | null,
  ): SourceModuleBatchModule => {
    const absolute = resolve(fileName);
    const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
    const cycleIndex = stack.indexOf(canonical);
    if (cycleIndex >= 0) {
      const cycle = [...stack.slice(cycleIndex), canonical].map((item) => basename(item)).join(" -> ");
      throw new DiagnosticError(
        importDeclaration?.location.fileName ?? entryPath,
        importDeclaration?.location ?? { offset: 0, line: 1, column: 1, fileName: entryPath },
        `circular Z module import: ${cycle}`,
        { code: "Z0601", helps: ["move shared declarations into a module that does not import either side"] },
      );
    }
    const cached = modules.get(canonical);
    if (cached) return cached;
    if (!suppliedProgram && !existsSync(canonical)) {
      throw new DiagnosticError(
        importDeclaration?.location.fileName ?? entryPath,
        importDeclaration?.location ?? { offset: 0, line: 1, column: 1, fileName: entryPath },
        `could not find Z module ${JSON.stringify(importDeclaration?.header ?? canonical)}`,
        { code: "Z0602", helps: ["use a relative path ending in `.zs`"] },
      );
    }
    const source = suppliedSource ?? readFileSync(canonical, "utf8");
    const parsedProgram = suppliedProgram ?? parse(lex(source, canonical), canonical);
    const program = applyGeneratedCallAdaptersToProgram(
      parsedProgram,
      source.length,
      (options.generatedCallAdapters ?? []).filter((adapter) => adapter.sourcePath === canonical),
    );
    const dependencies = new Map<number, string>();
    const packageSpecifiers = new Set<string>();
    for (const [specifier, configuredPath] of Object.entries(options.sourceImports ?? {})) {
      const absoluteConfigured = resolve(configuredPath);
      const canonicalConfigured = existsSync(absoluteConfigured)
        ? realpathSync(absoluteConfigured)
        : absoluteConfigured;
      if (canonicalConfigured === canonical) packageSpecifiers.add(specifier);
    }
    const generatedPackage = options.generatedModulePackages?.[canonical];
    const ownerPackage = generatedPackage ?? packageForFile(canonical);
    const module: SourceModuleBatchModule = {
      fileName: canonical,
      source,
      program,
      dependencies,
      packageSpecifiers,
      packageId: ownerPackage?.id ?? null,
      packageName: ownerPackage?.name ?? null,
    };
    modules.set(canonical, module);
    for (const declaration of program.imports) {
      const standardRelativePath = sourceStandardModuleRelativePath(declaration.header);
      const packageDependencyPath = options.sourceImports?.[declaration.header];
      const packageRoot = Object.keys(options.sourceImports ?? {}).find((specifier) => (
        !specifier.includes("/") && declaration.header.startsWith(`${specifier}/`)
      ));
      const dependencyPath = isLocalSourceModuleSpecifier(declaration.header)
        ? resolve(dirname(canonical), declaration.header)
        : standardRelativePath
        ? resolve(standardLibraryRoot, standardRelativePath)
        : packageDependencyPath
        ? resolve(packageDependencyPath)
        : null;
      if (!packageDependencyPath && packageRoot) {
        throw new DiagnosticError(
          declaration.location.fileName ?? canonical,
          declaration.location,
          `package ${JSON.stringify(packageRoot)} does not export subpath ${JSON.stringify(`./${declaration.header.slice(packageRoot.length + 1)}`)}`,
          {
            code: "Z0602",
            helps: [`add the exact subpath to ${packageRoot}'s z.json library.exports`],
          },
        );
      }
      if (!dependencyPath) continue;
      if (!existsSync(dependencyPath)) {
        if (isLocalSourceModuleSpecifier(declaration.header)) {
          throw new DiagnosticError(
            declaration.location.fileName ?? canonical,
            declaration.location,
            `could not find Z module ${JSON.stringify(declaration.header)}`,
            { code: "Z0602", helps: ["use a relative path ending in `.zs`"] },
          );
        }
        continue;
      }
      const dependency = load(dependencyPath, null, null, [...stack, canonical], declaration);
      if (packageDependencyPath) dependency.packageSpecifiers.add(declaration.header);
      dependencies.set(declaration.location.offset, dependency.fileName);
    }
    return module;
  };

  const entry = load(entryPath, entrySource, entryProgram, [], null);
  return { entryFileName: entry.fileName, modules: [...modules.values()] };
}

export function linkSourceModules(
  entrySource: string,
  entryProgram: Program,
  entryFileName: string,
  options: SourceModuleOptions = {},
): ModuleLinkResult {
  const sourceBatch = loadSourceModuleBatch(entrySource, entryProgram, entryFileName, options);
  const standardLibraryRoot = resolve(
    options.standardLibraryRoot
      ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../stdlib"),
  );
  const jsonStandardModuleCandidate = resolve(standardLibraryRoot, "json.zs");
  const jsonStandardModuleFileName = existsSync(jsonStandardModuleCandidate)
    ? realpathSync(jsonStandardModuleCandidate)
    : jsonStandardModuleCandidate;
  const modulesByPath = new Map(sourceBatch.modules.map((module) => [module.fileName, module] as const));
  const nodes = new Map<string, ModuleNode>();
  let nextId = 0;

  const build = (fileName: string): ModuleNode => {
    const cached = nodes.get(fileName);
    if (cached) return cached;
    const sourceModule = modulesByPath.get(fileName);
    if (!sourceModule) throw new Error(`source module batch is missing ${fileName}`);
    const node: ModuleNode = {
      id: nextId++,
      fileName,
      program: sourceModule.program,
      dependencies: new Map(),
      ownNames: new Map(),
      exports: new Map(),
      internals: new Map(),
      packageId: sourceModule.packageId,
      packageName: sourceModule.packageName,
    };
    nodes.set(fileName, node);
    collectOwnNames(node, fileName === sourceBatch.entryFileName);
    for (const declaration of sourceModule.program.imports) {
      const dependencyPath = sourceModule.dependencies.get(declaration.location.offset);
      if (!dependencyPath) continue;
      node.dependencies.set(declaration.location.offset, build(dependencyPath));
    }
    for (const declaration of sourceModule.program.exports) {
      const linkedName = node.ownNames.get(declaration.name);
      if (!linkedName) {
        throw new DiagnosticError(fileName, declaration.location, `cannot export unknown declaration ${JSON.stringify(declaration.name)}`, {
          code: "Z0602",
        });
      }
      if (node.exports.has(declaration.name)) {
        throw new DiagnosticError(fileName, declaration.location, `duplicate export ${JSON.stringify(declaration.name)}`, { code: "Z0603" });
      }
      node.exports.set(declaration.name, { linkedName, location: declaration.location });
    }
    for (const declaration of sourceModule.program.internals) {
      if (!node.packageId) {
        throw new DiagnosticError(fileName, declaration.location, `internal declaration ${JSON.stringify(declaration.name)} requires a manifest-defined package identity`, {
          code: "Z0605",
          helps: ["add package.name to the owning z.json, or keep the declaration private to this source module"],
        });
      }
      const linkedName = node.ownNames.get(declaration.name);
      if (!linkedName) {
        throw new DiagnosticError(fileName, declaration.location, `cannot expose unknown internal declaration ${JSON.stringify(declaration.name)}`, { code: "Z0602" });
      }
      if (node.internals.has(declaration.name)) {
        throw new DiagnosticError(fileName, declaration.location, `duplicate internal declaration ${JSON.stringify(declaration.name)}`, { code: "Z0603" });
      }
      node.internals.set(declaration.name, { linkedName, location: declaration.location });
    }
    return node;
  };

  const entry = build(sourceBatch.entryFileName);
  const ordered: ModuleNode[] = [];
  const visited = new Set<string>();
  const visit = (node: ModuleNode): void => {
    if (visited.has(node.fileName)) return;
    visited.add(node.fileName);
    for (const dependency of node.dependencies.values()) visit(dependency);
    ordered.push(node);
  };
  visit(entry);

  const nativeExports = new Map<string, FunctionDeclaration>();
  const nativeNames = new Map<string, {
    readonly location: SourceLocation;
    readonly kind: "function" | "type";
  }>();
  const registerNativeName = (
    name: string,
    location: SourceLocation,
    kind: "function" | "type",
    fileName: string,
  ): void => {
    const existing = nativeNames.get(name);
    if (existing) {
      throw new DiagnosticError(
        location.fileName ?? fileName,
        location,
        `duplicate public C ${kind === "type" ? "type" : "symbol"} name ${JSON.stringify(name)}`,
        {
          code: "Z0830",
          labels: [{
            location: existing.location,
            message: `first public C ${existing.kind} is declared here`,
            length: name.length,
          }],
          notes: ["C typedef names and function names share one public identifier namespace"],
        },
      );
    }
    nativeNames.set(name, { location, kind });
  };
  for (const node of ordered) {
    for (const declaration of [...node.program.structs, ...node.program.enums]) {
      if (!declaration.nativeLayout) continue;
      registerNativeName(
        declaration.nativeLayout.name,
        declaration.nativeLayout.location,
        "type",
        node.fileName,
      );
    }
    for (const declaration of node.program.functions) {
      if (!declaration.nativeExport) continue;
      const existing = nativeExports.get(declaration.nativeExport.name);
      if (existing) {
        throw new DiagnosticError(
          declaration.location.fileName ?? node.fileName,
          declaration.nativeExport.location,
          `duplicate C export symbol ${JSON.stringify(declaration.nativeExport.name)}`,
          {
            code: "Z0830",
            labels: [{
              location: existing.nativeExport!.location,
              message: "first C export is declared here",
              length: existing.nativeExport!.name.length,
            }],
            notes: ["C exports are external ABI contracts and are never module-mangled"],
          },
        );
      }
      nativeExports.set(declaration.nativeExport.name, declaration);
      registerNativeName(
        declaration.nativeExport.name,
        declaration.nativeExport.location,
        "function",
        node.fileName,
      );
    }
  }

  const imports: ImportDeclaration[] = [];
  const constants: Program["constants"] = [];
  const typeAliases: Program["typeAliases"] = [];
  const traits: Program["traits"] = [];
  const structs: Program["structs"] = [];
  const enums: Program["enums"] = [];
  const functions: Program["functions"] = [];
  for (const node of ordered) {
    const scope = buildScope(node);
    imports.push(...node.program.imports
      .filter((declaration) => !node.dependencies.has(declaration.location.offset))
      .map((declaration) => rewriteNativeImport(declaration, node, scope)));
    constants.push(...node.program.constants.map((declaration) => ({
      ...declaration,
      name: node.ownNames.get(declaration.name)!,
      type: declaration.type ? renameTypeReference(declaration.type, scope, new Set()) : null,
      initializer: transformExpression(declaration.initializer, scope, new Set(), new Set()),
    })));
    typeAliases.push(...node.program.typeAliases.map((declaration) => ({
      ...declaration,
      name: node.ownNames.get(declaration.name)!,
      target: renameTypeReference(declaration.target, scope, new Set()),
    })));
    traits.push(...node.program.traits.map((declaration) => transformTrait(declaration, node, scope)));
    structs.push(...node.program.structs.map((declaration) => transformStruct(declaration, node, scope)));
    enums.push(...node.program.enums.map((declaration) => ({
      ...declaration,
      name: node.ownNames.get(declaration.name)!,
      variants: declaration.variants.map((variant) => ({
        ...variant,
        payload: variant.payload ? renameTypeReference(variant.payload, scope, new Set()) : null,
      })),
    })));
    functions.push(...node.program.functions.map((declaration) => {
      const transformed = transformFunction(declaration, node, scope, null);
      if (
        node.fileName === jsonStandardModuleFileName
        && (declaration.name === "decode" || declaration.name === "encode")
      ) {
        return {
          ...transformed,
          compilerIntrinsic: {
            kind: declaration.name === "decode" ? "jsonDecode" as const : "jsonEncode" as const,
            requestLocation: declaration.location,
          },
        };
      }
      return transformed;
    }));
  }

  const linkedProgram: Program = {
    kind: "program",
    imports,
    exports: entry.program.exports,
    internals: entry.program.internals,
    constants,
    typeAliases,
    traits,
    structs,
    enums,
    functions,
  };
  const offsetBases = moduleOffsetBases([...nodes.values()], entry);
  return {
    program: rebaseLinkedLocations(linkedProgram, offsetBases),
    sourceBatch,
    modules: new Map(ordered.map((node) => [node.fileName, {
      fileName: node.fileName,
      packageId: node.packageId,
      packageName: node.packageName,
      program: node.program,
      exports: node.exports,
      internals: node.internals,
    }])),
    includeDirectories: [...new Set(ordered.filter((node) => node !== entry).map((node) => dirname(node.fileName)))],
    typeDisplayNames: new Map(ordered.flatMap((node) => [
      ...node.program.typeAliases,
      ...node.program.traits,
      ...node.program.structs,
      ...node.program.enums,
    ].map((declaration) => [node.ownNames.get(declaration.name)!, declaration.name] as const))),
  };
}

function moduleOffsetBases(nodes: readonly ModuleNode[], entry: ModuleNode): ReadonlyMap<string, number> {
  const maximumOffset = (value: unknown): number => {
    let maximum = 0;
    const visit = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) {
        for (const child of item) visit(child);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.offset === "number" && typeof record.line === "number" && typeof record.column === "number") {
        maximum = Math.max(maximum, record.offset);
        return;
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(value);
    return maximum;
  };
  const bases = new Map<string, number>([[entry.fileName, 0]]);
  let next = maximumOffset(entry.program) + 1;
  for (const node of [...nodes].sort((left, right) => left.id - right.id)) {
    if (node === entry) continue;
    bases.set(node.fileName, next);
    next += maximumOffset(node.program) + 1;
  }
  return bases;
}

function rebaseLinkedLocations<T>(value: T, bases: ReadonlyMap<string, number>): T {
  if (Array.isArray(value)) return value.map((item) => rebaseLinkedLocations(item, bases)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.offset === "number" && typeof record.line === "number" && typeof record.column === "number") {
    const base = typeof record.fileName === "string" ? bases.get(record.fileName) ?? 0 : 0;
    return { ...record, offset: record.offset + base } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, rebaseLinkedLocations(child, bases)]),
  ) as T;
}

function collectOwnNames(node: ModuleNode, entry: boolean): void {
  const declarations = [
    ...node.program.constants,
    ...node.program.typeAliases,
    ...node.program.traits,
    ...node.program.structs,
    ...node.program.enums,
    ...node.program.functions,
  ];
  for (const declaration of declarations) {
    if (node.ownNames.has(declaration.name)) {
      throw new DiagnosticError(node.fileName, declaration.location, `duplicate top-level name ${JSON.stringify(declaration.name)}`, {
        code: "Z0603",
      });
    }
    const linkedName = declaration.kind === "type"
      ? `__z_alias_${node.id}_${declaration.name}`
      : declaration.kind === "function" && declaration.nativeExport
        ? `__z_c_impl_${node.id}_${declaration.name}`
      : entry
        ? declaration.name
        : `__z_module_${node.id}_${declaration.name}`;
    node.ownNames.set(declaration.name, linkedName);
  }
}

function buildScope(node: ModuleNode): ModuleScope {
  const hiddenTestNames = new Set(
    node.program.functions
      .filter((declaration) => declaration.testName)
      .map((declaration) => declaration.name),
  );
  const globals = new Map(
    [...node.ownNames].filter(([name]) => !hiddenTestNames.has(name)),
  );
  const namespaces = new Map<string, ModuleNode>();
  const standardModules = new Map<string, StandardModuleName>();
  const standardTypes = new Map<string, "TextBuffer" | "Arena" | "Map" | "Set" | "Hashable" | "Hasher" | "Once" | "OnceLifetime" | "OnceState" | "Mutex">();
  const occupied = new Map<string, SourceLocation>();
  for (const declaration of [
    ...node.program.constants,
    ...node.program.typeAliases,
    ...node.program.traits,
    ...node.program.structs,
    ...node.program.enums,
    ...node.program.functions.filter((declaration) => !declaration.testName),
  ]) occupied.set(declaration.name, declaration.location);

  const bind = (name: string, linkedName: string, location: SourceLocation): void => {
    if (occupied.has(name)) {
      throw new DiagnosticError(node.fileName, location, `duplicate module binding ${JSON.stringify(name)}`, { code: "Z0603" });
    }
    occupied.set(name, location);
    globals.set(name, linkedName);
  };

  for (const declaration of node.program.imports) {
    const dependency = node.dependencies.get(declaration.location.offset);
    if (dependency) {
      if (!declaration.bindings) {
        if (occupied.has(declaration.moduleName)) {
          throw new DiagnosticError(node.fileName, declaration.location, `duplicate module binding ${JSON.stringify(declaration.moduleName)}`, { code: "Z0603" });
        }
        occupied.set(declaration.moduleName, declaration.location);
        namespaces.set(declaration.moduleName, dependency);
        continue;
      }
      for (const binding of declaration.bindings) {
        const exported = dependency.exports.get(binding.importedName)
          ?? (node.packageId !== null && node.packageId === dependency.packageId
            ? dependency.internals.get(binding.importedName)
            : undefined);
        if (!exported) {
          const packageOnly = dependency.internals.has(binding.importedName);
          throw new DiagnosticError(node.fileName, binding.location, packageOnly
            ? `declaration ${JSON.stringify(binding.importedName)} is internal to package ${JSON.stringify(dependency.packageName)}`
            : `module ${JSON.stringify(declaration.header)} has no export ${JSON.stringify(binding.importedName)}`, {
            code: "Z0602",
            helps: packageOnly
              ? ["use a public exported API from the package instead"]
              : ["add `export` or package-scoped `internal` to the declaration in its defining module"],
          });
        }
        bind(binding.localName, exported.linkedName, binding.location);
      }
      continue;
    }
    if (!declaration.bindings) {
      if (declaration.header === "std/fs") {
        standardModules.set(declaration.moduleName, "fs");
      } else if (declaration.header === "std/process") {
        standardModules.set(declaration.moduleName, "process");
      } else if (declaration.header === "std/objc") {
        standardModules.set(declaration.moduleName, "objc");
      } else if (declaration.header === "std/embed") {
        standardModules.set(declaration.moduleName, "embed");
      } else if (declaration.header === "std/math") {
        standardModules.set(declaration.moduleName, "math");
      }
      bind(declaration.moduleName, linkedImportName(node, declaration.moduleName), declaration.location);
    } else {
      for (const binding of declaration.bindings) {
        if (declaration.header === "std/text" && binding.importedName === "TextBuffer") {
          standardTypes.set(binding.localName, "TextBuffer");
        } else if (declaration.header === "std/memory" && binding.importedName === "Arena") {
          standardTypes.set(binding.localName, "Arena");
        } else if (declaration.header === "std/collections" && binding.importedName === "Map") {
          standardTypes.set(binding.localName, "Map");
        } else if (declaration.header === "std/collections" && binding.importedName === "Set") {
          standardTypes.set(binding.localName, "Set");
        } else if (declaration.header === "std/hash" && binding.importedName === "Hashable") {
          standardTypes.set(binding.localName, "Hashable");
        } else if (declaration.header === "std/hash" && binding.importedName === "Hasher") {
          standardTypes.set(binding.localName, "Hasher");
        } else if (declaration.header === "std/sync" && binding.importedName === "Once") {
          standardTypes.set(binding.localName, "Once");
        } else if (declaration.header === "std/sync" && binding.importedName === "OnceLifetime") {
          standardTypes.set(binding.localName, "OnceLifetime");
        } else if (declaration.header === "std/sync" && binding.importedName === "OnceState") {
          standardTypes.set(binding.localName, "OnceState");
        } else if (declaration.header === "std/sync" && binding.importedName === "Mutex") {
          standardTypes.set(binding.localName, "Mutex");
        } else if (
          declaration.header === "std/channel"
          && (
            binding.importedName === "Channel"
            || binding.importedName === "Sender"
            || binding.importedName === "Receiver"
            || binding.importedName === "SyncSender"
            || binding.importedName === "SyncReceiver"
            || binding.importedName === "ChannelClosed"
          )
        ) {
          standardTypes.set(binding.localName, binding.importedName);
        } else if (declaration.header === "std/async" && binding.importedName === "TaskScope") {
          standardTypes.set(binding.localName, "TaskScope");
        } else if (declaration.header === "std/async" && binding.importedName === "TaskControl") {
          standardTypes.set(binding.localName, "TaskControl");
        }
        bind(binding.localName, linkedImportName(node, binding.localName), binding.location);
      }
    }
  }
  return { packageId: node.packageId, globals, namespaces, standardModules, standardTypes };
}

function visibleModuleDeclaration(
  scope: ModuleScope,
  dependency: ModuleNode,
  name: string,
): { readonly linkedName: string; readonly location: SourceLocation } | undefined {
  return dependency.exports.get(name)
    ?? (scope.packageId !== null && scope.packageId === dependency.packageId
      ? dependency.internals.get(name)
      : undefined);
}

function linkedImportName(node: ModuleNode, name: string): string {
  return node.id === 0 ? name : `__z_module_${node.id}_import_${name}`;
}

function rewriteNativeImport(declaration: ImportDeclaration, node: ModuleNode, scope: ModuleScope): ImportDeclaration {
  return {
    ...declaration,
    moduleName: declaration.bindings
      ? linkedImportName(node, declaration.moduleName)
      : scope.globals.get(declaration.moduleName) ?? declaration.moduleName,
    bindings: declaration.bindings?.map((binding) => ({
      ...binding,
      localName: scope.globals.get(binding.localName) ?? binding.localName,
    })) ?? null,
  };
}

function transformTrait(declaration: Program["traits"][number], node: ModuleNode, scope: ModuleScope): Program["traits"][number] {
  return {
    ...declaration,
    name: node.ownNames.get(declaration.name)!,
    methods: declaration.methods.map((method) => transformFunction(method, node, scope, null)),
  };
}

function transformStruct(declaration: StructDeclaration, node: ModuleNode, scope: ModuleScope): StructDeclaration {
  const typeParameters = new Set(declaration.typeParameters ?? []);
  return {
    ...declaration,
    name: node.ownNames.get(declaration.name)!,
    typeParameterConstraints: declaration.typeParameterConstraints?.map((constraint) => ({
      ...constraint,
      traits: constraint.traits.map((trait) => renameTypeReference(trait, scope, typeParameters)),
    })),
    implements: declaration.implements.map((item) => renameTypeReference(item, scope, typeParameters)),
    fields: declaration.fields.map((field) => ({
      ...field,
      type: renameTypeReference(field.type, scope, typeParameters),
      defaultValue: field.defaultValue
        ? transformExpression(field.defaultValue, scope, new Set(), typeParameters)
        : null,
    })),
    constructor: declaration.constructor
      ? {
        ...declaration.constructor,
        parameters: declaration.constructor.parameters.map((parameter) => ({
          ...parameter,
          type: renameTypeReference(parameter.type, scope, typeParameters),
        })),
        errorType: declaration.constructor.errorType
          ? renameTypeReference(declaration.constructor.errorType, scope, typeParameters)
          : null,
        body: transformStatements(
          declaration.constructor.body,
          scope,
          new Set(["this", ...declaration.constructor.parameters.map((parameter) => parameter.name)]),
          typeParameters,
        ),
      }
      : null,
    methods: declaration.methods.map((method) => transformFunction(method, node, scope, declaration.name)),
    deinitializer: declaration.deinitializer
      ? { ...declaration.deinitializer, body: transformStatements(declaration.deinitializer.body, scope, new Set(["this"]), typeParameters) }
      : null,
  };
}

function transformFunction(
  declaration: FunctionDeclaration,
  node: ModuleNode,
  scope: ModuleScope,
  receiver: string | null,
): FunctionDeclaration {
  const typeParameters = new Set(declaration.typeParameters ?? []);
  const locals = new Set(declaration.parameters.map((parameter) => parameter.name));
  if (receiver && !declaration.static) locals.add("this");
  return {
    ...declaration,
    name: receiver ? declaration.name : node.ownNames.get(declaration.name) ?? declaration.name,
    typeParameterConstraints: declaration.typeParameterConstraints?.map((constraint) => ({
      ...constraint,
      traits: constraint.traits.map((trait) => renameTypeReference(trait, scope, typeParameters)),
    })),
    parameters: declaration.parameters.map((parameter) => ({
      ...parameter,
      type: renameTypeReference(parameter.type, scope, typeParameters),
    })),
    returnType: renameTypeReference(declaration.returnType, scope, typeParameters),
    errorType: declaration.errorType ? renameTypeReference(declaration.errorType, scope, typeParameters) : null,
    body: transformStatements(declaration.body, scope, locals, typeParameters),
  };
}

function transformStatements(
  statements: readonly Statement[],
  scope: ModuleScope,
  initialLocals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Statement[] {
  const locals = new Set(initialLocals);
  const transformed: Statement[] = [];
  for (const statement of statements) {
    transformed.push(transformStatement(statement, scope, locals, typeParameters));
    if (statement.kind === "variable") locals.add(statement.name);
    if (statement.kind === "destructure") {
      for (const binding of statement.objectBindings) locals.add(binding.bindingName);
      for (const binding of statement.arrayBindings ?? []) {
        if (binding.bindingName) locals.add(binding.bindingName);
      }
    }
  }
  return transformed;
}

function transformStatement(
  statement: Statement,
  scope: ModuleScope,
  locals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Statement {
  switch (statement.kind) {
    case "variable":
      return {
        ...statement,
        type: statement.type ? renameTypeReference(statement.type, scope, typeParameters) : null,
        initializer: statement.initializer ? transformExpression(statement.initializer, scope, locals, typeParameters) : null,
      };
    case "destructure":
      return {
        ...statement,
        type: statement.type ? renameTypeReference(statement.type, scope, typeParameters) : null,
        initializer: transformExpression(statement.initializer, scope, locals, typeParameters),
      };
    case "assignment":
      return {
        ...statement,
        target: transformExpression(statement.target, scope, locals, typeParameters) as typeof statement.target,
        expression: transformExpression(statement.expression, scope, locals, typeParameters),
      };
    case "return":
      return { ...statement, expression: statement.expression ? transformExpression(statement.expression, scope, locals, typeParameters) : null };
    case "throw":
    case "yield":
    case "select":
    case "expressionStatement":
      return { ...statement, expression: transformExpression(statement.expression, scope, locals, typeParameters) };
    case "block":
      return { ...statement, statements: transformStatements(statement.statements, scope, new Set(locals), typeParameters) };
    case "unsafe":
      return {
        ...statement,
        body: {
          ...statement.body,
          statements: transformStatements(statement.body.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "if":
      return {
        ...statement,
        condition: transformExpression(statement.condition, scope, locals, typeParameters),
        thenBranch: {
          ...statement.thenBranch,
          statements: transformStatements(statement.thenBranch.statements, scope, new Set(locals), typeParameters),
        },
        elseBranch: statement.elseBranch
          ? transformStatement(statement.elseBranch, scope, new Set(locals), typeParameters) as typeof statement.elseBranch
          : null,
      };
    case "while":
      return {
        ...statement,
        condition: transformExpression(statement.condition, scope, locals, typeParameters),
        body: { ...statement.body, statements: transformStatements(statement.body.statements, scope, new Set(locals), typeParameters) },
      };
    case "for": {
      const bodyLocals = new Set(locals);
      if (statement.binding) bodyLocals.add(statement.binding);
      for (const binding of statement.objectBindings ?? []) bodyLocals.add(binding.bindingName);
      return {
        ...statement,
        iterable: transformExpression(statement.iterable, scope, locals, typeParameters),
        body: { ...statement.body, statements: transformStatements(statement.body.statements, scope, bodyLocals, typeParameters) },
      };
    }
    case "match":
      return {
        ...statement,
        expression: transformExpression(statement.expression, scope, locals, typeParameters),
        arms: statement.arms.map((arm) => {
          const armLocals = new Set(locals);
          if (arm.binding) armLocals.add(arm.binding);
          for (const field of arm.objectBindings ?? []) armLocals.add(field.bindingName);
          return { ...arm, body: transformStatement(arm.body, scope, armLocals, typeParameters) };
        }),
      };
    case "asyncScope":
      return {
        ...statement,
        body: {
          ...statement.body,
          statements: transformStatements(statement.body.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "break":
    case "continue":
      return statement;
  }
}

function transformExpression(
  expression: Expression,
  scope: ModuleScope,
  locals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Expression {
  switch (expression.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
      return expression;
    case "raw":
      return {
        ...expression,
        returnType: renameTypeReference(expression.returnType, scope, typeParameters),
      };
    case "identifier": {
      if (locals.has(expression.name)) return expression;
      if (scope.namespaces.has(expression.name)) {
        throw new DiagnosticError(expression.location.fileName ?? "<module>", expression.location, `module ${JSON.stringify(expression.name)} must be followed by an exported member`, { code: "Z0602" });
      }
      return { ...expression, name: renameExpressionName(expression.name, scope, typeParameters) };
    }
    case "unary":
      return { ...expression, operand: transformExpression(expression.operand, scope, locals, typeParameters) };
    case "binary":
      return {
        ...expression,
        left: transformExpression(expression.left, scope, locals, typeParameters),
        right: transformExpression(expression.right, scope, locals, typeParameters),
      };
    case "conditional":
      return {
        ...expression,
        condition: transformExpression(expression.condition, scope, locals, typeParameters),
        thenExpression: transformExpression(expression.thenExpression, scope, locals, typeParameters),
        elseExpression: transformExpression(expression.elseExpression, scope, locals, typeParameters),
      };
    case "new":
      return {
        ...expression,
        typeName: renameTypeName(expression.typeName, scope, typeParameters),
        arguments: expression.arguments.map((argument) => transformExpression(argument, scope, locals, typeParameters)),
      };
    case "template":
      return {
        ...expression,
        parts: expression.parts.map((part) => part.kind === "value"
          ? { ...part, expression: transformExpression(part.expression, scope, locals, typeParameters) }
          : part),
      };
    case "closure": {
      const closureLocals = new Set(locals);
      for (const parameter of expression.parameters) closureLocals.add(parameter.name);
      return {
        ...expression,
        parameters: expression.parameters.map((parameter) => ({
          ...parameter,
          type: parameter.type ? renameTypeReference(parameter.type, scope, typeParameters) : null,
        })),
        returnType: expression.returnType ? renameTypeReference(expression.returnType, scope, typeParameters) : null,
        body: expression.body.kind === "block"
          ? { ...expression.body, statements: transformStatements(expression.body.statements, scope, closureLocals, typeParameters) }
          : transformExpression(expression.body, scope, closureLocals, typeParameters),
      };
    }
    case "call":
      return {
        ...expression,
        callee: transformExpression(expression.callee, scope, locals, typeParameters),
        arguments: expression.arguments.map((argument) => transformExpression(argument, scope, locals, typeParameters)),
      };
    case "member": {
      if (expression.object.kind === "identifier" && !locals.has(expression.object.name)) {
        const dependency = scope.namespaces.get(expression.object.name);
        if (dependency) {
          const generic = parseGenericType(expression.property);
          const member = generic?.base ?? expression.property;
          const exported = visibleModuleDeclaration(scope, dependency, member);
          if (!exported) {
            const packageOnly = dependency.internals.has(member);
            throw new DiagnosticError(expression.location.fileName ?? dependency.fileName, expression.location, packageOnly
              ? `declaration ${JSON.stringify(member)} is internal to package ${JSON.stringify(dependency.packageName)}`
              : `module ${JSON.stringify(expression.object.name)} has no export ${JSON.stringify(member)}`, {
              code: "Z0602",
              helps: packageOnly
                ? ["use a public exported API from the package instead"]
                : ["export the declaration or import an existing exported name"],
            });
          }
          return {
            kind: "identifier",
            name: generic
              ? genericTypeName(exported.linkedName, generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)))
              : exported.linkedName,
            location: expression.location,
          };
        }
      }
      return { ...expression, object: transformExpression(expression.object, scope, locals, typeParameters) };
    }
    case "index":
      return {
        ...expression,
        object: transformExpression(expression.object, scope, locals, typeParameters),
        index: transformExpression(expression.index, scope, locals, typeParameters),
      };
    case "arrayExpression":
      return { ...expression, elements: expression.elements.map((item) => transformExpression(item, scope, locals, typeParameters)) };
    case "dynamicArrayExpression":
      return {
        ...expression,
        elementType: renameTypeName(expression.elementType, scope, typeParameters),
        elements: expression.elements.map((item) => transformExpression(item, scope, locals, typeParameters)),
      };
    case "structExpression":
      return {
        ...expression,
        typeName: renameTypeName(expression.typeName, scope, typeParameters),
        spread: expression.spread
          ? {
              ...expression.spread,
              expression: transformExpression(expression.spread.expression, scope, locals, typeParameters),
            }
          : expression.spread,
        fields: expression.fields.map((field) => ({
          ...field,
          expression: transformExpression(field.expression, scope, locals, typeParameters),
        })),
      };
    case "objectExpression":
      return {
        ...expression,
        spread: expression.spread
          ? {
              ...expression.spread,
              expression: transformExpression(expression.spread.expression, scope, locals, typeParameters),
            }
          : expression.spread,
        fields: expression.fields.map((field) => ({
          ...field,
          expression: transformExpression(field.expression, scope, locals, typeParameters),
        })),
      };
    case "variantExpression":
      return {
        ...expression,
        enumName: renameTypeName(expression.enumName, scope, typeParameters),
        payload: transformExpression(expression.payload, scope, locals, typeParameters),
      };
    case "attempt":
    case "try":
    case "await":
    case "spawn":
    case "weak":
      return { ...expression, expression: transformExpression(expression.expression, scope, locals, typeParameters) };
    case "executorPlacement":
      return {
        ...expression,
        executor: transformExpression(expression.executor, scope, locals, typeParameters),
        returnType: expression.returnType ? renameTypeReference(expression.returnType, scope, typeParameters) : null,
        errorType: expression.errorType ? renameTypeReference(expression.errorType, scope, typeParameters) : null,
        body: {
          ...expression.body,
          statements: transformStatements(expression.body.statements, scope, new Set(locals), typeParameters),
        },
        call: expression.call
          ? transformExpression(expression.call, scope, locals, typeParameters) as typeof expression.call
          : null,
      };
    case "matchExpression":
      return {
        ...expression,
        expression: transformExpression(expression.expression, scope, locals, typeParameters),
        arms: expression.arms.map((arm) => {
          const armLocals = new Set(locals);
          if (arm.binding) armLocals.add(arm.binding);
          for (const field of arm.objectBindings ?? []) armLocals.add(field.bindingName);
          return { ...arm, body: transformStatement(arm.body, scope, armLocals, typeParameters) };
        }),
      };
    case "ifExpression":
      return {
        ...expression,
        condition: transformExpression(expression.condition, scope, locals, typeParameters),
        thenBranch: {
          ...expression.thenBranch,
          statements: transformStatements(expression.thenBranch.statements, scope, new Set(locals), typeParameters),
        },
        elseBranch: expression.elseBranch.kind === "ifExpression"
          ? transformExpression(expression.elseBranch, scope, locals, typeParameters) as typeof expression.elseBranch
          : { ...expression.elseBranch, statements: transformStatements(expression.elseBranch.statements, scope, new Set(locals), typeParameters) },
      };
    case "unsafeExpression":
      return {
        ...expression,
        body: {
          ...expression.body,
          statements: transformStatements(expression.body.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "whileExpression":
      return {
        ...expression,
        condition: transformExpression(expression.condition, scope, locals, typeParameters),
        body: {
          ...expression.body,
          statements: transformStatements(expression.body.statements, scope, new Set(locals), typeParameters),
        },
        elseBranch: {
          ...expression.elseBranch,
          statements: transformStatements(expression.elseBranch.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "forExpression": {
      const bodyLocals = new Set(locals);
      if (expression.binding) bodyLocals.add(expression.binding);
      for (const binding of expression.objectBindings ?? []) bodyLocals.add(binding.bindingName);
      return {
        ...expression,
        iterable: transformExpression(expression.iterable, scope, locals, typeParameters),
        body: {
          ...expression.body,
          statements: transformStatements(expression.body.statements, scope, bodyLocals, typeParameters),
        },
        elseBranch: {
          ...expression.elseBranch,
          statements: transformStatements(expression.elseBranch.statements, scope, new Set(locals), typeParameters),
        },
      };
    }
    case "argumentReference":
      return locals.has(expression.name)
        ? expression
        : { ...expression, name: scope.globals.get(expression.name) ?? expression.name };
  }
}

function renameTypeReference(reference: TypeReference, scope: ModuleScope, typeParameters: ReadonlySet<string>): TypeReference {
  return { ...reference, name: renameTypeName(reference.name, scope, typeParameters) };
}

function renameTypeName(name: string, scope: ModuleScope, typeParameters: ReadonlySet<string>): string {
  const readonly = parseReadonlyType(name);
  if (readonly) return readonlyTypeName(renameTypeName(readonly.target, scope, typeParameters));
  const view = parseViewType(name);
  if (view) return viewTypeName(renameTypeName(view.target, scope, typeParameters));
  if (isNullableObjCTypeName(name)) {
    return nullableObjCTypeName(renameTypeName(publicObjCTypeName(name), scope, typeParameters));
  }
  if (typeParameters.has(name)) return name;
  const functionType = parseFunctionType(name);
  if (functionType) {
    return functionTypeName(
      functionType.parameters.map((parameter) => ({
        ...parameter,
        type: renameTypeName(parameter.type, scope, typeParameters),
      })),
      renameTypeName(functionType.returnType, scope, typeParameters),
      functionType.errorType ? renameTypeName(functionType.errorType, scope, typeParameters) : null,
      functionType.thread,
      functionType.async,
    );
  }
  const fixed = parseFixedArrayType(name);
  if (fixed) return fixedArrayTypeName(renameTypeName(fixed.elementType, scope, typeParameters), fixed.length);
  const slice = parseSliceType(name);
  if (slice) return sliceTypeName(renameTypeName(slice.elementType, scope, typeParameters));
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) {
    const renamed = dynamicArrayTypeName(renameTypeName(dynamic.elementType, scope, typeParameters));
    return dynamic.readonly ? readonlyTypeName(renamed) : renamed;
  }
  const generic = parseGenericType(name);
  if (generic) {
    const base = renameSimpleType(generic.base, scope);
    return genericTypeName(base, generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)));
  }
  return renameSimpleType(name, scope);
}

function renameSimpleType(name: string, scope: ModuleScope): string {
  const standardType = scope.standardTypes.get(name);
  if (standardType === "OnceState") return onceStateTypeName;
  if (standardType) return standardType;
  const separator = name.indexOf(".");
  if (separator >= 0) {
    const namespace = name.slice(0, separator);
    const member = name.slice(separator + 1);
    const standardModule = scope.standardModules.get(namespace);
    if (standardModule) return `${standardModule}.${member}`;
    const dependency = scope.namespaces.get(namespace);
    if (dependency) {
      const exported = visibleModuleDeclaration(scope, dependency, member);
      if (!exported) {
        const packageOnly = dependency.internals.has(member);
        throw new DiagnosticError(dependency.fileName, { offset: 0, line: 1, column: 1, fileName: dependency.fileName }, packageOnly
          ? `declaration ${JSON.stringify(member)} is internal to package ${JSON.stringify(dependency.packageName)}`
          : `module ${JSON.stringify(namespace)} has no export ${JSON.stringify(member)}`, { code: "Z0602" });
      }
      return exported.linkedName;
    }
    const renamedNamespace = scope.globals.get(namespace);
    return renamedNamespace ? `${renamedNamespace}.${member}` : name;
  }
  return scope.globals.get(name) ?? name;
}

function renameExpressionName(name: string, scope: ModuleScope, typeParameters: ReadonlySet<string>): string {
  const generic = parseGenericType(name);
  if (!generic) return scope.globals.get(name) ?? name;
  return genericTypeName(
    scope.standardTypes.get(generic.base) ?? scope.globals.get(generic.base) ?? generic.base,
    generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)),
  );
}
