import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { apiNotesFreshness, readApiNotes, type ApiNotes, type PointerNote } from "./foreign-api-notes.ts";
import { normalizeForeignContracts } from "./foreign-contracts.ts";
import { parseForeignDeclarationContracts, type ForeignValueContract } from "./foreign-declarations.ts";
import {
  callbackParameterSpellings,
  normalizeCallbackContextType,
  splitCParameters,
} from "./foreign-type-spelling.ts";
import { isStandardModuleSpecifier } from "./standard-library.ts";
import { sliceTypeName } from "./array-types.ts";
import { deploymentTargetFlags, type DeploymentTarget } from "./project.ts";
import { collectIntegerMacroConstants } from "./foreign-macros.ts";
import type {
  ForeignCallbackType,
  ForeignCallbackTypedef,
  ForeignAvailability,
  ForeignBlockType,
  ForeignConstant,
  ForeignCxxMethod,
  ForeignCxxMethodOverload,
  ForeignCxxStaticMethod,
  ForeignDeclarationMetadata,
  ForeignField,
  ForeignFunctionDeclaration,
  ForeignFunctionOverload,
  ForeignModuleIR,
  ForeignModuleDeclarations,
  ForeignNamedType,
  ForeignObjCInterface,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignObjCProtocol,
  ForeignObjCProtocolMethod,
  ForeignObjectType,
  ForeignPointerType,
  ForeignRecordPointerType,
  ForeignReferenceType,
  ForeignScalarTypeName,
  ForeignSourceLocation,
  ForeignType,
  ForeignValueLifecycle,
} from "./foreign-ir.ts";
export type * from "./foreign-ir.ts";

export type ForeignModule = ForeignModuleIR & {
  readonly declaration: ImportDeclaration;
};

type HeaderInfo = ForeignModuleIR;

type ClangNode = {
  readonly id?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly tagUsed?: string;
  readonly type?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly variadic?: boolean;
  readonly instance?: boolean;
  readonly readonly?: boolean;
  readonly weak?: boolean;
  readonly strong?: boolean;
  readonly retain?: boolean;
  readonly copy?: boolean;
  readonly assign?: boolean;
  readonly unsafe_unretained?: boolean;
  readonly class?: boolean;
  readonly getter?: { readonly name?: string };
  readonly setter?: { readonly name?: string };
  readonly storageClass?: string;
  readonly isImplicit?: boolean;
  readonly access?: string;
  readonly explicitlyDeleted?: boolean;
  readonly returnType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly super?: { readonly name?: string };
  readonly protocols?: readonly { readonly name?: string }[];
  readonly fixedUnderlyingType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly ownedTagDecl?: { readonly id?: string; readonly kind?: string; readonly name?: string };
  readonly loc?: ClangLocation;
  readonly range?: { readonly begin?: ClangLocation; readonly end?: ClangLocation };
  readonly inner?: readonly ClangNode[];
};

type ClangLocation = {
  readonly offset?: number;
  readonly tokLen?: number;
  readonly file?: string;
  readonly line?: number;
  readonly presumedLine?: number;
  readonly col?: number;
  readonly tokLen?: number;
  readonly spellingLoc?: ClangLocation;
  readonly expansionLoc?: ClangLocation;
};

function callbackTypedefParameterNames(node: ClangNode, parameterCount: number): readonly string[] {
  const file = explicitClangFile(node.loc) ?? explicitClangFile(node.range?.begin) ?? clangNodeSourceFiles.get(node);
  const start = node.range?.begin?.offset;
  const end = node.range?.end?.offset;
  if (!file || start === undefined || end === undefined) {
    return Array.from({ length: parameterCount }, (_, index) => `argument${index + 1}`);
  }
  try {
    const source = readFileSync(file, "utf8");
    const text = source.slice(start, end + (node.range?.end?.tokLen ?? 1));
    const match = /\(\s*\*\s*[A-Za-z_][A-Za-z0-9_]*\s*\)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text);
    if (!match) throw new Error("callback typedef source has no declarator");
    const names = splitCParameters(match[1]).map((parameter, index) => {
      const withoutAttributes = parameter.replace(/__attribute__\s*\(\([\s\S]*?\)\)/g, " ").trim();
      const name = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\])?\s*$/.exec(withoutAttributes)?.[1];
      return name ?? `argument${index + 1}`;
    });
    return names.length === parameterCount
      ? names
      : Array.from({ length: parameterCount }, (_, index) => `argument${index + 1}`);
  } catch {
    return Array.from({ length: parameterCount }, (_, index) => `argument${index + 1}`);
  }
}

const headerCache = new Map<string, HeaderInfo>();
const foreignSourceCache = new Map<string, { readonly freshness: string; readonly source: string }>();
const clangNodeSourceFiles = new WeakMap<ClangNode, string>();
let cachedSdkPath: string | null | undefined;

export function resolveForeignModules(
  declarations: readonly ImportDeclaration[],
  fileName: string,
  projectIncludeDirectories: readonly string[] = [],
  deploymentTarget: DeploymentTarget | null = null,
  projectApiNotes: Readonly<Record<string, ApiNotes>> = {},
  declarationOverrides: Readonly<Record<string, { readonly source: string; readonly fileName: string }>> = {},
): ReadonlyMap<string, ForeignModule> {
  const modules = new Map<string, ForeignModule>();
  const sourceDirectory = resolve(dirname(fileName));
  const includeDirectories = [...new Set([sourceDirectory, ...projectIncludeDirectories.map((directory) => resolve(directory))])];
  for (const declaration of declarations) {
    if (isStandardModuleSpecifier(declaration.header)) continue;
    const declarationDirectory = resolve(dirname(declaration.location.fileName ?? fileName));
    const declarationIncludeDirectories = [...new Set([declarationDirectory, ...includeDirectories])];
    const headerDirectory = declarationIncludeDirectories.find((directory) => existsSync(resolve(directory, declaration.header)))
      ?? declarationDirectory;
    const localHeader = resolve(headerDirectory, declaration.header);
    const headerStat = existsSync(localHeader) ? statSync(localHeader) : null;
    const headerFreshness = headerStat ? `${headerStat.mtimeMs}:${headerStat.size}` : "0";
    const framework = discoverFramework(declaration.header);
    const objectiveC = Boolean(framework)
      || isSwiftCompatibilityHeader(declaration.header)
      || (existsSync(localHeader) && /(?:^|\n)\s*(?:@interface|@protocol|@class|#import\b)/.test(readFileSync(localHeader, "utf8")));
    const cPlusPlus = isCPlusPlusHeader(declaration.header);
    const language = objectiveC ? cPlusPlus ? "objective-c++" : "objective-c" : cPlusPlus ? "c++" : "c";
    const generatedNotes = projectApiNotes[declaration.header] ?? null;
    const declarationOverride = declarationOverrides[declaration.header] ?? null;
    const notesFreshness = `${apiNotesFreshness(declaration, headerDirectory)}\0${JSON.stringify(generatedNotes)}\0${
      declarationOverride ? `${declarationOverride.fileName}:${declarationOverride.source}` : ""
    }`;
    const targetKey = deploymentTarget ? `${deploymentTarget.platform}:${deploymentTarget.minimumVersion}` : "host-default";
    const cacheKey = `${declarationIncludeDirectories.join("\0")}\0${declaration.header}\0${headerFreshness}\0${notesFreshness}\0${declaration.moduleName}\0${framework ?? language}\0${targetKey}`;
    let header = headerCache.get(cacheKey);
    if (!header) {
      header = readHeader(
        declaration,
        fileName,
        declarationIncludeDirectories,
        headerDirectory,
        framework,
        objectiveC,
        cPlusPlus,
        deploymentTarget,
        generatedNotes,
        declarationOverride,
      );
      headerCache.set(cacheKey, header);
    }
    modules.set(declaration.moduleName, { declaration, ...header });
  }
  return modules;
}

function readHeader(
  declaration: ImportDeclaration,
  fileName: string,
  includeDirectories: readonly string[],
  headerDirectory: string,
  framework: string | null,
  objectiveC: boolean,
  cPlusPlus: boolean,
  deploymentTarget: DeploymentTarget | null,
  generatedNotes: ApiNotes | null,
  declarationOverride: { readonly source: string; readonly fileName: string } | null,
): HeaderInfo {
  const clangLanguage = objectiveC ? cPlusPlus ? "objective-c++" : "objective-c" : cPlusPlus ? "c++" : "c";
  const swiftCxxNamespace = cPlusPlus ? swiftCompatibilityNamespace(declaration.header) : null;
  const clangBaseArguments = [
    "-x", clangLanguage,
    ...(cPlusPlus ? ["-std=c++20"] : []),
    ...(objectiveC ? ["-fobjc-arc"] : []),
    ...deploymentTargetFlags(deploymentTarget),
    ...includeDirectories.flatMap((directory) => ["-I", directory]),
  ];
  const clangArguments = [
    ...clangBaseArguments,
    "-include", declaration.header,
    "-Xclang", "-ast-dump=json",
    "-fsyntax-only",
    "/dev/null",
  ];
  const result = spawnSync(objectiveC ? "xcrun" : "clang", objectiveC ? ["clang", ...clangArguments] : clangArguments, {
    encoding: "utf8",
    maxBuffer: objectiveC || swiftCxxNamespace ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new DiagnosticError(fileName, declaration.location, `could not run Clang for header ${JSON.stringify(declaration.header)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const lines = result.stderr.trim().split("\n");
    const detail = lines.find((line) => line.includes("error:")) ?? lines[0] ?? "Clang could not parse the header";
    throw new DiagnosticError(fileName, declaration.location, `could not import header ${JSON.stringify(declaration.header)}: ${detail}`);
  }

  let root: ClangNode;
  try {
    root = JSON.parse(result.stdout) as ClangNode;
  } catch {
    throw new DiagnosticError(fileName, declaration.location, `Clang returned an invalid AST for header ${JSON.stringify(declaration.header)}`);
  }
  hydrateClangSourceFiles(root);
  const callbackTypedefs = new Map<string, ForeignCallbackTypedef>();
  visit(root, (node) => {
    if (node.kind !== "TypedefDecl" || !node.name || !node.type?.qualType) return;
    const signature = node.type.desugaredQualType ?? node.type.qualType;
    const parameterTypes = callbackParameterSpellings(signature);
    if (!parameterTypes) return;
    callbackTypedefs.set(node.name, {
      name: node.name,
      signature,
      parameterNames: callbackTypedefParameterNames(node, parameterTypes.length),
    });
  });

  const declarationDirectory = resolve(dirname(declaration.location.fileName ?? fileName));
  const declarationContractPath = [
    resolve(declarationDirectory, `${declaration.header}.zd`),
    resolve(declarationDirectory, `${basename(declaration.header)}.zd`),
    resolve(headerDirectory, `${declaration.header}.zd`),
    resolve(headerDirectory, `${basename(declaration.header)}.zd`),
  ].find((candidate, index, candidates) => (
    candidates.indexOf(candidate) === index && existsSync(candidate)
  )) ?? null;
  const declarationContracts = declarationOverride
    ? parseForeignDeclarationContracts(declarationOverride.source, declarationOverride.fileName)
    : declarationContractPath
    ? parseForeignDeclarationContracts(readFileSync(declarationContractPath, "utf8"), declarationContractPath)
    : null;
  const valueContracts = new Map(
    (declarationContracts?.types ?? [])
      .filter((contract) => contract.copy || contract.move || contract.deinit)
      .map((contract) => [contract.name, contract]),
  );
  const imported = collectNamedTypes(root, declaration.moduleName, cPlusPlus, swiftCxxNamespace, valueContracts, fileName);
  const constants = new Map(imported.constants);
  const objectTypes = new Map<string, ForeignObjectType>();
  const interfaces = objectiveC
    ? collectObjCInterfaces(root, declaration.moduleName, imported.byCName, objectTypes, constants)
    : new Map<string, ForeignObjCInterface>();
  const protocols = objectiveC
    ? collectObjCProtocols(root, declaration.moduleName, imported.byCName, objectTypes)
    : new Map<string, ForeignObjCProtocol>();
  for (const [name, constant] of collectIntegerMacroConstants(
    declaration,
    clangBaseArguments,
    headerDirectory,
    objectiveC,
    targetIntegerWidths().long,
  )) {
    if (!constants.has(name)) constants.set(name, constant);
  }
  const functionDeclarations = new Map<string, ForeignFunctionDeclaration>();
  visitWithNamespaces(root, (node, namespaces) => {
    if (node.kind !== "FunctionDecl" || !node.name || !node.type?.qualType) return;
    if (swiftCxxNamespace && namespaces[0] !== swiftCxxNamespace) return;
    const parameterNodes = (node.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType);
    const parameters = parameterNodes.map((child) => {
      const nativeName = qualifyNativeTypeSpelling(child.type!.qualType!, namespaces, imported.byCName);
      const canonicalNativeName = child.type!.desugaredQualType
        ? qualifyNativeTypeSpelling(child.type!.desugaredQualType, namespaces, imported.byCName)
        : undefined;
      return {
        name: child.name ?? null,
        type: { nativeName, canonicalNativeName },
      };
    });
    const cSignature = node.type.qualType;
    const cName = cPlusPlus && namespaces.length > 0 ? `${namespaces.join("::")}::${node.name}` : node.name;
    const namespacePath = cPlusPlus
      ? swiftCxxNamespace ? namespaces.slice(1) : namespaces
      : [];
    const qualifiedName = [...namespacePath, node.name].join(".");
    const overload = {
      name: node.name,
      nativeName: cName,
      returnType: { nativeName: qualifyNativeTypeSpelling(returnTypeOf(cSignature), namespaces, imported.byCName) },
      parameters,
      variadic: node.variadic === true,
      nativeSignature: cSignature,
      metadata: foreignDeclarationMetadata(node),
    };
    const existing = functionDeclarations.get(qualifiedName);
    if (!existing) {
      functionDeclarations.set(qualifiedName, {
        name: node.name,
        namespacePath,
        qualifiedName,
        overloads: [overload],
      });
      return;
    }
    const overloads = [...existing.overloads];
    if (!overloads.some((item) => item.nativeName === cName && item.nativeSignature === cSignature)) {
      overloads.push(overload);
    }
    functionDeclarations.set(qualifiedName, { ...existing, overloads });
  });
  const produced: ForeignModuleDeclarations = {
    producer: "clang",
    functions: functionDeclarations,
    nativeTypes: imported.byCName,
    namedTypes: imported.namedTypes,
    constants,
    objectTypes,
    interfaces,
    protocols,
    framework,
    objectiveC,
    cPlusPlus,
  };
  const notes = readApiNotes(
    declaration,
    fileName,
    headerDirectory,
    produced.functions,
    produced.namedTypes,
    produced.interfaces,
    produced.constants,
    callbackTypedefs,
    generatedNotes
      ? { name: `Swift module metadata for ${declaration.header}`, notes: generatedNotes }
      : null,
    declarationOverride,
  );
  validateForeignTypeApiNotes(notes, produced.namedTypes, produced.interfaces, fileName, declaration.location);
  const contracts = normalizeForeignContracts(
    produced.functions,
    produced.nativeTypes,
    notes,
    {
      mapType: (spelling, note, position, pointerTypes, namedTypes) => mapForeignType(
        spelling.nativeName,
        note,
        position,
        pointerTypes,
        namedTypes,
        spelling.canonicalNativeName,
      ),
      mapCallbackContext: mapCallbackContextType,
      mapCallbackRelease: mapCallbackReleaseType,
      mapVariadicType: (type) => type === "cstring"
        ? { kind: "z", name: "cstring", cName: "const char *" }
        : mapForeignType("long", undefined, "parameter", new Map(), produced.nativeTypes),
      mapVariadicCallback: (nativeType, nativeSignature, nativeParameterNames, bytes) => mapProjectedByteCallback(
        nativeType,
        nativeSignature,
        nativeParameterNames,
        bytes,
      ),
    },
    fileName,
    declaration.location,
  );
  return {
    producer: produced.producer,
    functions: contracts.functions,
    functionAliases: contracts.functionAliases,
    types: contracts.pointerTypes,
    namedTypes: applyForeignNamedTypeApiNotes(produced.namedTypes, notes),
    namedTypeAliases: imported.namedTypeAliases,
    namespaces: new Set([...contracts.namespaces, ...imported.namespaces]),
    constants: produced.constants,
    objectTypes: produced.objectTypes,
    interfaces: applyObjCMethodApiNotes(produced.interfaces, notes),
    protocols: produced.protocols,
    framework: produced.framework,
    objectiveC: produced.objectiveC,
    cPlusPlus: produced.cPlusPlus,
  };
}

function applyObjCMethodApiNotes(
  interfaces: ReadonlyMap<string, ForeignObjCInterface>,
  notes: ApiNotes,
): ReadonlyMap<string, ForeignObjCInterface> {
  if (
    (!notes.objcMethods || Object.keys(notes.objcMethods).length === 0)
    && (!notes.types || Object.keys(notes.types).length === 0)
  ) return interfaces;
  return new Map([...interfaces].map(([className, declaration]) => [
    className,
    {
      ...declaration,
      metadata: {
        ...declaration.metadata,
        executorAffinity: notes.types?.[className]?.executorAffinity ?? declaration.metadata.executorAffinity,
      },
      methods: declaration.methods.map((method) => {
        const note = notes.objcMethods?.[`${className}.${method.selector}`];
        if (!note) return method;
        return {
          ...method,
          metadata: {
            ...method.metadata,
            executorAffinity: note.executorAffinity ?? method.metadata.executorAffinity,
          },
          asyncCallbackParameter: note.async?.callbackParameter ?? method.asyncCallbackParameter,
          asyncResultParameter: note.async?.resultParameter ?? method.asyncResultParameter,
          asyncErrorParameter: note.async?.errorParameter ?? method.asyncErrorParameter,
          parameters: method.parameters.map((parameter, index) => {
            const parameterNote = note.parameters?.[String(index)];
            if (parameter.type.kind !== "block" || !parameterNote?.callback) return parameter;
            return {
              ...parameter,
              type: {
                ...parameter.type,
                thread: parameterNote.callback.thread ?? null,
                cardinality: parameterNote.callback.cardinality ?? null,
              },
            };
          }),
        };
      }),
    },
  ]));
}

function applyForeignNamedTypeApiNotes(
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  notes: ApiNotes,
): ReadonlyMap<string, ForeignNamedType> {
  if (!notes.types || Object.keys(notes.types).length === 0) return namedTypes;
  return new Map([...namedTypes].map(([qualifiedName, declaration]) => {
    const note = notes.types?.[qualifiedName];
    return [qualifiedName, note?.executorAffinity
      ? {
          ...declaration,
          metadata: {
            ...declaration.metadata,
            executorAffinity: note.executorAffinity,
          },
        }
      : declaration];
  }));
}

function validateForeignTypeApiNotes(
  notes: ApiNotes,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  interfaces: ReadonlyMap<string, ForeignObjCInterface>,
  fileName: string,
  location: ImportDeclaration["location"],
): void {
  for (const name of Object.keys(notes.types ?? {})) {
    if (namedTypes.has(name) || interfaces.has(name)) continue;
    throw new DiagnosticError(fileName, location, `API notes name unknown foreign type ${JSON.stringify(name)}`, {
      code: "Z0801",
    });
  }
}

function collectNamedTypes(
  root: ClangNode,
  moduleName: string,
  cPlusPlus: boolean,
  swiftCxxNamespace: string | null,
  valueContracts: ReadonlyMap<string, ForeignValueContract>,
  fileName: string,
): {
  namedTypes: ReadonlyMap<string, ForeignNamedType>;
  namedTypeAliases: ReadonlyMap<string, string>;
  namespaces: ReadonlySet<string>;
  constants: ReadonlyMap<string, ForeignConstant>;
  byCName: ReadonlyMap<string, ForeignNamedType>;
} {
  const nodes: ClangNode[] = [];
  visit(root, (node) => nodes.push(node));
  const nodesById = new Map<string, ClangNode>();
  for (const node of nodes) {
    if (!node.id) continue;
    const existing = nodesById.get(node.id);
    if (!existing || (node.inner?.length ?? 0) > (existing.inner?.length ?? 0)) {
      nodesById.set(node.id, node);
    }
  }
  const typedefEnumDeclarations = new Map<string, ClangNode>();
  for (const node of nodes) {
    if (node.kind !== "TypedefDecl" || !node.name) continue;
    const ownedTag = node.inner
      ?.map((child) => child.ownedTagDecl)
      .find((candidate) => candidate?.kind === "EnumDecl" && candidate.id);
    const declaration = ownedTag?.id ? nodesById.get(ownedTag.id) : undefined;
    if (!declaration?.inner?.some((child) => child.kind === "EnumConstantDecl")) continue;
    const existing = typedefEnumDeclarations.get(node.name);
    if (!existing || (declaration.inner?.length ?? 0) > (existing.inner?.length ?? 0)) {
      typedefEnumDeclarations.set(node.name, declaration);
    }
  }
  const records = new Map<string, ClangNode>();
  const enums = new Map<string, ClangNode>();
  for (const node of nodes) {
    if (!node.name || !node.inner?.length) continue;
    if (node.kind === "RecordDecl" && node.tagUsed === "struct" && node.inner.some((child) => child.kind === "FieldDecl")) records.set(node.name, node);
    if (node.kind === "EnumDecl" && node.inner.some((child) => child.kind === "EnumConstantDecl")) enums.set(node.name, node);
  }

  const cppRecords: {
    readonly exportName: string;
    readonly namespacePath: readonly string[];
    readonly qualifiedName: string;
    readonly cName: string;
    readonly declaration: ClangNode;
    readonly opaque: boolean;
    readonly lifecycle: ForeignValueLifecycle;
    readonly thread: ForeignValueContract["thread"];
  }[] = [];
  if (cPlusPlus) {
    visitWithNamespaces(root, (node, namespaces) => {
      if (
        node.kind !== "CXXRecordDecl"
        || !node.name
      ) return;
      if (swiftCxxNamespace && namespaces[0] !== swiftCxxNamespace) return;
      const fields = node.inner?.some((child) => child.kind === "FieldDecl") ?? false;
      const namespacePath = swiftCxxNamespace ? namespaces.slice(1) : namespaces;
      const qualifiedName = [...namespacePath, node.name].join(".");
      const contract = valueContracts.get(qualifiedName);
      const detectedLifecycle = cxxValueLifecycle(node);
      const definition = node.inner?.some((child) => (
        child.kind === "AccessSpecDecl"
        || child.kind === "FieldDecl"
        || child.kind === "CXXConstructorDecl"
        || child.kind === "CXXDestructorDecl"
      )) ?? false;
      const opaque = node.tagUsed === "class" && definition
        && ((swiftCxxNamespace !== null && detectedLifecycle.deinit) || Boolean(contract));
      if (!(node.tagUsed === "struct" && fields) && !opaque) return;
      if (contract) validateForeignValueLifecycle(contract, detectedLifecycle, fileName);
      cppRecords.push({
        exportName: node.name,
        namespacePath,
        qualifiedName,
        cName: [...namespaces, node.name].join("::"),
        declaration: node,
        opaque,
        lifecycle: contract
          ? { copy: contract.copy, move: contract.move, deinit: contract.deinit }
          : detectedLifecycle,
        thread: contract?.thread ?? { transfer: false, share: false, deinit: false },
      });
    });
  }

  type Seed = {
    kind: "record" | "value" | "enum" | "scalar";
    exportName: string;
    namespacePath: readonly string[];
    qualifiedName: string;
    typeName: string;
    cName: string;
    declaration?: ClangNode;
    sourceDeclaration?: ClangNode;
    underlying?: ForeignScalarTypeName;
    flags?: boolean;
    lifecycle?: ForeignValueLifecycle;
    thread?: ForeignValueContract["thread"];
  };
  const seeds = new Map<string, Seed>();
  for (const node of nodes) {
    if (node.kind !== "TypedefDecl" || !node.name || !node.type?.qualType) continue;
    const qualified = node.type.qualType;
    const desugared = node.type.desugaredQualType ?? qualified;
    const recordMatch = /^struct (.+)$/.exec(desugared);
    const enumMatch = /^enum (.+)$/.exec(desugared) ?? /^enum (.+)$/.exec(qualified);
    const underlying = mapTypedefType(node.name, desugared);
    const enumDeclaration = enumMatch
      ? enums.get(enumMatch[1]) ?? typedefEnumDeclarations.get(node.name)
      : undefined;
    const kind = recordMatch && records.has(recordMatch[1])
      ? "record"
      : enumMatch && enumDeclaration?.inner?.some((child) => child.kind === "EnumConstantDecl")
        ? "enum"
        : underlying && underlying !== "void"
          ? "scalar"
          : null;
    if (!kind) continue;
    const seed: Seed = {
      kind,
      exportName: node.name,
      namespacePath: [],
      qualifiedName: node.name,
      typeName: `${moduleName}.${node.name}`,
      cName: node.name,
      declaration: kind === "record" ? records.get(recordMatch![1]) : kind === "enum" ? enumDeclaration : undefined,
      sourceDeclaration: node,
      underlying: kind === "scalar"
        ? underlying as ForeignScalarTypeName
        : kind === "enum"
          ? mapBuiltinType(enumDeclaration?.fixedUnderlyingType?.desugaredQualType ?? enumDeclaration?.fixedUnderlyingType?.qualType ?? "int") ?? "i32"
          : undefined,
      flags: kind === "enum" && enumDeclaration?.inner?.some((child) => child.kind === "FlagEnumAttr"),
    };
    const existing = seeds.get(node.name);
    if (
      !existing
      || (seed.declaration?.inner?.length ?? 0) > (existing.declaration?.inner?.length ?? 0)
    ) {
      seeds.set(node.name, seed);
    }
  }
  for (const record of cppRecords) {
    if (seeds.has(record.qualifiedName)) continue;
    seeds.set(record.qualifiedName, {
      kind: record.opaque ? "value" : "record",
      exportName: record.exportName,
      namespacePath: record.namespacePath,
      qualifiedName: record.qualifiedName,
      typeName: `${moduleName}.${record.qualifiedName}`,
      cName: record.cName,
      declaration: record.declaration,
      sourceDeclaration: record.declaration,
      lifecycle: record.lifecycle,
      thread: record.thread,
    });
  }

  const potential = new Map<string, Seed>();
  const seedNames = new Map<string, Seed[]>();
  for (const seed of seeds.values()) {
    potential.set(seed.cName, seed);
    potential.set(seed.qualifiedName, seed);
    const matching = seedNames.get(seed.exportName) ?? [];
    matching.push(seed);
    seedNames.set(seed.exportName, matching);
  }
  for (const [name, matching] of seedNames) {
    if (matching.length === 1) potential.set(name, matching[0]);
  }
  const namedTypes = new Map<string, ForeignNamedType>();
  const byCName = new Map<string, ForeignNamedType>();
  for (const seed of seeds.values()) {
    let named: ForeignNamedType | null = null;
    const metadata = foreignDeclarationMetadata(seed.sourceDeclaration ?? seed.declaration);
    if (seed.kind === "scalar") {
      named = { kind: "scalar", exportName: seed.exportName, namespacePath: seed.namespacePath, qualifiedName: seed.qualifiedName, typeName: seed.typeName, cName: seed.cName, underlying: seed.underlying!, metadata };
    } else if (seed.kind === "enum") {
      named = {
        kind: "enum",
        exportName: seed.exportName,
        namespacePath: seed.namespacePath,
        qualifiedName: seed.qualifiedName,
        typeName: seed.typeName,
        cName: seed.cName,
        flags: seed.flags ?? false,
        underlying: seed.underlying ?? "i32",
        metadata,
      };
    } else if (seed.kind === "value") {
      named = {
        kind: "value",
        exportName: seed.exportName,
        namespacePath: seed.namespacePath,
        qualifiedName: seed.qualifiedName,
        typeName: seed.typeName,
        cName: seed.cName,
        lifecycle: seed.lifecycle!,
        thread: seed.thread ?? { transfer: false, share: false, deinit: false },
        constructors: [],
        staticMethods: [],
        methods: [],
        metadata,
      };
    } else {
      const fields = (seed.declaration!.inner ?? []).filter((child) => child.kind === "FieldDecl");
      const mapped = fields.map((field) => field.name && field.type?.qualType
        ? { name: field.name, typeName: mapRecordFieldType(field.type.qualType, seed.namespacePath, potential), metadata: foreignDeclarationMetadata(field) }
        : null);
      if (recordIsSupported(seed, potential, new Set()) && mapped.every((field): field is ForeignField => Boolean(field?.typeName))) {
        named = { kind: "record", exportName: seed.exportName, namespacePath: seed.namespacePath, qualifiedName: seed.qualifiedName, typeName: seed.typeName, cName: seed.cName, fields: mapped, metadata };
      }
    }
    if (!named) continue;
    namedTypes.set(named.qualifiedName, named);
    byCName.set(named.cName, named);
    byCName.set(named.qualifiedName, named);
  }

  for (const seed of seeds.values()) {
    const named = namedTypes.get(seed.qualifiedName);
    if (seed.kind !== "value" || named?.kind !== "value" || !seed.declaration) continue;
    const callables = collectCxxValueCallables(
      seed.declaration,
      seed.cName,
      byCName,
      swiftCxxNamespace !== null,
    );
    const updated: ForeignNamedType = { ...named, ...callables };
    namedTypes.set(seed.qualifiedName, updated);
    for (const [key, value] of byCName) {
      if (value.typeName === named.typeName) byCName.set(key, updated);
    }
  }

  const namedTypeAliases = new Map<string, string>();
  const namedByLeaf = new Map<string, ForeignNamedType[]>();
  for (const named of namedTypes.values()) {
    const matching = namedByLeaf.get(named.exportName) ?? [];
    matching.push(named);
    namedByLeaf.set(named.exportName, matching);
  }
  for (const [name, matching] of namedByLeaf) {
    if (matching.length !== 1) continue;
    namedTypeAliases.set(name, matching[0].qualifiedName);
    byCName.set(name, matching[0]);
  }
  for (const contract of valueContracts.values()) {
    if (!namedTypes.has(contract.name)) {
      throw new DiagnosticError(
        contract.nameLocation.fileName ?? fileName,
        contract.nameLocation,
        `declaration names unknown foreign value type ${JSON.stringify(contract.name)}`,
        { code: "Z0801" },
      );
    }
  }

  const constants = new Map<string, ForeignConstant>();
  for (const named of namedTypes.values()) {
    if (named.kind !== "enum") continue;
    const declaration = seeds.get(named.qualifiedName)?.declaration;
    for (const constant of declaration?.inner ?? []) {
      if (constant.kind !== "EnumConstantDecl" || !constant.name) continue;
      constants.set(constant.name, {
        name: constant.name,
        cName: constant.name,
        typeName: named.typeName,
        sourceKind: "enum",
        metadata: foreignDeclarationMetadata(constant),
      });
    }
  }
  const namespaces = new Set<string>();
  for (const named of namedTypes.values()) {
    for (let depth = 1; depth <= named.namespacePath.length; depth += 1) {
      namespaces.add(named.namespacePath.slice(0, depth).join("."));
    }
  }
  return { namedTypes, namedTypeAliases, namespaces, constants, byCName };
}

function collectCxxValueCallables(
  declaration: ClangNode,
  ownerCName: string,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  swiftGenerated: boolean,
): {
  readonly constructors: readonly ForeignFunctionOverload[];
  readonly staticMethods: readonly ForeignCxxStaticMethod[];
  readonly methods: readonly ForeignCxxMethod[];
} {
  const namespaces = ownerCName.split("::").slice(0, -1);
  const owner = namedTypes.get(ownerCName);
  const constructors: ForeignFunctionOverload[] = [];
  const staticMethods = new Map<string, ForeignFunctionOverload[]>();
  const methods = new Map<string, ForeignCxxMethodOverload[]>();
  const nestedRecords = new Map(
    (declaration.inner ?? [])
      .filter((member): member is ClangNode & { readonly name: string } => (
        member.kind === "CXXRecordDecl" && !member.isImplicit && Boolean(member.name)
      ))
      .map((member) => [member.name, member]),
  );
  let access = declaration.tagUsed === "class" ? "private" : "public";
  for (const member of declaration.inner ?? []) {
    if (member.kind === "AccessSpecDecl") {
      access = member.access ?? access;
      continue;
    }
    if (access !== "public" || member.isImplicit || member.explicitlyDeleted || !member.name || !member.type?.qualType) continue;
    if (swiftGenerated && member.kind === "VarDecl" && member.storageClass === "static") {
      const implementationName = /(?:^|::)(_impl_[A-Za-z0-9_]+)$/.exec(
        normalizeCType(member.type.desugaredQualType ?? member.type.qualType)
          .replace(/^const\s+/, "")
          .replace(/^(?:class|struct)\s+/, ""),
      )?.[1];
      const implementation = implementationName ? nestedRecords.get(implementationName) : undefined;
      const callOperator = implementation
        ? publicCxxMember(implementation, (candidate) => candidate.kind === "CXXMethodDecl" && candidate.name === "operator()")
        : undefined;
      if (callOperator?.type?.qualType) {
        const parameterNodes = (callOperator.inner ?? [])
          .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType);
        const returnType = mapForeignType(
          qualifyNativeTypeSpelling(returnTypeOf(callOperator.type.qualType), namespaces, namedTypes),
          undefined,
          "return",
          new Map(),
          namedTypes,
        );
        const parameters = parameterNodes.map((parameter) => {
          const spelling = qualifyNativeTypeSpelling(parameter.type!.qualType!, namespaces, namedTypes);
          const canonical = parameter.type!.desugaredQualType
            ? qualifyNativeTypeSpelling(parameter.type!.desugaredQualType, namespaces, namedTypes)
            : undefined;
          return {
            name: parameter.name ?? null,
            type: mapForeignType(spelling, undefined, "parameter", new Map(), namedTypes, canonical),
          };
        });
        if (returnType.kind !== "unsupported" && !parameters.some((parameter) => parameter.type.kind === "unsupported")) {
          const overload: ForeignFunctionOverload = {
            name: member.name,
            cName: `${ownerCName}::${member.name}`,
            returnType,
            status: null,
            parameters,
            variadic: false,
            cSignature: callOperator.type.qualType,
            metadata: foreignDeclarationMetadata(member),
          };
          const existing = staticMethods.get(member.name) ?? [];
          if (!existing.some((candidate) => candidate.cSignature === overload.cSignature)) {
            staticMethods.set(member.name, [...existing, overload]);
          }
        }
      }
      continue;
    }
    const constructor = member.kind === "CXXConstructorDecl";
    const method = member.kind === "CXXMethodDecl" && !member.name.startsWith("operator");
    if (!constructor && !method) continue;
    const parameterNodes = (member.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType);
    if (constructor && isCopyOrMoveConstructor(parameterNodes, ownerCName)) continue;
    const returnType = constructor && owner
      ? { kind: "named" as const, type: owner, cName: ownerCName }
      : mapForeignType(
        qualifyNativeTypeSpelling(returnTypeOf(member.type.qualType), namespaces, namedTypes),
        undefined,
        "return",
        new Map(),
        namedTypes,
      );
    const parameters = parameterNodes.map((parameter) => {
      const spelling = qualifyNativeTypeSpelling(parameter.type!.qualType!, namespaces, namedTypes);
      const canonical = parameter.type!.desugaredQualType
        ? qualifyNativeTypeSpelling(parameter.type!.desugaredQualType, namespaces, namedTypes)
        : undefined;
      return {
        name: parameter.name ?? null,
        type: mapForeignType(spelling, undefined, "parameter", new Map(), namedTypes, canonical),
      };
    });
    if (returnType.kind === "unsupported" || parameters.some((parameter) => parameter.type.kind === "unsupported")) continue;
    const base: ForeignFunctionOverload = {
      name: member.name,
      cName: constructor ? ownerCName : member.storageClass === "static" ? `${ownerCName}::${member.name}` : member.name,
      returnType,
      status: null,
      parameters,
      variadic: member.variadic === true,
      cSignature: member.type.qualType,
      metadata: foreignDeclarationMetadata(member),
    };
    if (constructor) {
      if (!constructors.some((candidate) => candidate.cSignature === base.cSignature)) constructors.push(base);
      continue;
    }
    if (member.storageClass === "static") {
      const existing = staticMethods.get(member.name) ?? [];
      if (!existing.some((candidate) => candidate.cSignature === base.cSignature)) {
        staticMethods.set(member.name, [...existing, base]);
      }
      continue;
    }
    const rvalueReceiver = /\)\s*(?:const\s+)?&&(?:\s|$)/.test(member.type.qualType);
    const overload: ForeignCxxMethodOverload = {
      ...base,
      receiverAccess: rvalueReceiver
        ? "move"
        : /\)\s*const(?:\s+&)?(?:\s|$)/.test(member.type.qualType) ? "in" : "inout",
    };
    const existing = methods.get(member.name) ?? [];
    if (!existing.some((candidate) => candidate.cSignature === overload.cSignature)) {
      methods.set(member.name, [...existing, overload]);
    }
  }
  return {
    constructors,
    staticMethods: [...staticMethods].map(([name, overloads]) => ({ name, overloads })),
    methods: [...methods].map(([name, overloads]) => ({ name, overloads })),
  };
}

function publicCxxMember(
  declaration: ClangNode,
  predicate: (member: ClangNode) => boolean,
): ClangNode | undefined {
  let access = declaration.tagUsed === "class" ? "private" : "public";
  for (const member of declaration.inner ?? []) {
    if (member.kind === "AccessSpecDecl") {
      access = member.access ?? access;
      continue;
    }
    if (access === "public" && !member.isImplicit && !member.explicitlyDeleted && predicate(member)) return member;
  }
  return undefined;
}

function isCopyOrMoveConstructor(parameters: readonly ClangNode[], ownerCName: string): boolean {
  if (parameters.length !== 1) return false;
  const spelling = normalizeCType(parameters[0].type?.qualType ?? "");
  if (!/\s&&?$/.test(spelling)) return false;
  const subject = spelling
    .replace(/^const\s+/, "")
    .replace(/\s&&?$/, "")
    .replace(/^(?:class|struct)\s+/, "")
    .trim();
  return subject === ownerCName || subject === ownerCName.split("::").at(-1);
}

function cxxValueLifecycle(declaration: ClangNode): ForeignValueLifecycle {
  let access = declaration.tagUsed === "class" ? "private" : "public";
  let copyConstructor = false;
  let copyAssignment = false;
  let moveConstructor = false;
  let moveAssignment = false;
  let deinit = false;
  for (const member of declaration.inner ?? []) {
    if (member.kind === "AccessSpecDecl") {
      access = member.access ?? access;
      continue;
    }
    if (access !== "public" || member.explicitlyDeleted === true) continue;
    if (member.kind === "CXXDestructorDecl") {
      deinit = true;
      continue;
    }
    if (member.kind !== "CXXConstructorDecl" && !(member.kind === "CXXMethodDecl" && member.name === "operator=")) continue;
    const parameters = (member.inner ?? []).filter((child) => child.kind === "ParmVarDecl");
    if (parameters.length !== 1) continue;
    const parameterType = normalizeCType(parameters[0].type?.qualType ?? "");
    const copy = parameterType.startsWith("const ") && parameterType.endsWith(" &") && !parameterType.endsWith(" &&");
    const move = parameterType.endsWith(" &&");
    if (member.kind === "CXXConstructorDecl") {
      copyConstructor ||= copy;
      moveConstructor ||= move;
    } else {
      copyAssignment ||= copy;
      moveAssignment ||= move;
    }
  }
  return {
    copy: copyConstructor && copyAssignment,
    move: moveConstructor && moveAssignment,
    deinit,
  };
}

function validateForeignValueLifecycle(
  contract: ForeignValueContract,
  detected: ForeignValueLifecycle,
  fallbackFileName: string,
): void {
  const fileName = contract.location.fileName ?? fallbackFileName;
  const requireCapability = (
    capability: keyof ForeignValueLifecycle,
    requested: boolean,
    location: ForeignValueContract["copyLocation"],
  ): void => {
    if (!requested || detected[capability]) return;
    throw new DiagnosticError(
      fileName,
      location ?? contract.location,
      `foreign type ${JSON.stringify(contract.name)} declares ${capability}, but Clang cannot prove that capability`,
      { code: "Z0801" },
    );
  };
  requireCapability("copy", contract.copy, contract.copyLocation);
  requireCapability("move", contract.move, contract.moveLocation);
  requireCapability("deinit", contract.deinit, contract.deinitLocation);
  if (!contract.copy && !contract.move) {
    throw new DiagnosticError(
      fileName,
      contract.location,
      `foreign value type ${JSON.stringify(contract.name)} is neither copyable nor movable`,
      {
        code: "Z0801",
        notes: ["an owning Z binding needs at least one Clang-proven transfer operation"],
        helps: ["expose an owned pointer contract, or make the native value copyable or movable"],
      },
    );
  }
}

function collectObjCInterfaces(
  root: ClangNode,
  moduleName: string,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  objectTypes: Map<string, ForeignObjectType>,
  constants: Map<string, ForeignConstant>,
): Map<string, ForeignObjCInterface> {
  const declarations = new Map<string, ClangNode>();
  visit(root, (node) => {
    if (node.kind !== "ObjCInterfaceDecl" || !node.name) return;
    const existing = declarations.get(node.name);
    if (!existing || (node.inner?.length ?? 0) > (existing.inner?.length ?? 0)) declarations.set(node.name, node);
  });

  const typeNames = new Map([...declarations.keys()].map((name) => [name, `${moduleName}.${name}`]));
  const objectType = (className: string | null, nullable: boolean): ForeignObjectType => {
    const baseName = className ? typeNames.get(className) ?? `${moduleName}.${className}` : "id";
    const typeName = nullable || !className ? `__z_objc:${nullable ? "nullable" : "nonnull"}:${baseName}` : baseName;
    const existing = objectTypes.get(typeName);
    if (existing) return existing;
    const created: ForeignObjectType = {
      kind: "object",
      typeName,
      cName: className ? `${className} *` : "id",
      className,
      nullable,
    };
    objectTypes.set(typeName, created);
    return created;
  };

  const interfaces = new Map<string, ForeignObjCInterface>();
  for (const [className, declaration] of declarations) {
    const methods = (declaration.inner ?? [])
      .filter((child) => child.kind === "ObjCMethodDecl" && child.name && child.returnType?.qualType)
      .map((method): ForeignObjCMethod => ({
        selector: method.name!,
        baseName: method.name!.split(":")[0],
        instance: method.instance === true,
        returnsInstanceType: /\binstancetype\b/.test(method.returnType!.qualType ?? ""),
        returnType: mapObjCType(method.returnType!, className, "return", namedTypes, typeNames, objectType),
        parameters: (method.inner ?? [])
          .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
          .map((parameter) => ({
            name: parameter.name ?? null,
            type: mapObjCType(parameter.type!, className, "parameter", namedTypes, typeNames, objectType),
          })),
        metadata: foreignDeclarationMetadata(method),
        asyncCallbackParameter: null,
        asyncResultParameter: null,
        asyncErrorParameter: null,
      }));
    const properties = (declaration.inner ?? [])
      .filter((child) => child.kind === "ObjCPropertyDecl" && child.name && child.type?.qualType)
      .map((property): ForeignObjCProperty => ({
        name: property.name!,
        getter: property.getter?.name ?? property.name!,
        setter: property.readonly === true
          ? null
          : property.setter?.name ?? `set${property.name![0].toUpperCase()}${property.name!.slice(1)}:`,
        classProperty: property.class === true,
        readonly: property.readonly === true,
        ownership: property.weak === true
          ? "weak"
          : property.copy === true
          ? "copy"
          : property.strong === true || property.retain === true
          ? "strong"
          : property.unsafe_unretained === true
          ? "unsafeUnretained"
          : property.assign === true
          ? "assign"
          : "unspecified",
        protocols: objcProtocolQualifiers(property.type!.qualType ?? ""),
        type: mapObjCType(property.type!, className, "return", namedTypes, typeNames, objectType),
        metadata: foreignDeclarationMetadata(property),
      }));
    interfaces.set(className, {
      exportName: className,
      typeName: typeNames.get(className)!,
      className,
      superName: declaration.super?.name ?? null,
      methods,
      properties,
      metadata: foreignDeclarationMetadata(declaration),
    });
    objectType(className, false);
    objectType(className, true);
  }
  visit(root, (node) => {
    if (node.kind !== "VarDecl" || node.storageClass !== "extern" || !node.name || !node.type?.qualType) return;
    const type = mapObjCType(node.type, "", "return", namedTypes, typeNames, objectType);
    if (type.kind !== "object") return;
    constants.set(node.name, {
      name: node.name,
      cName: node.name,
      typeName: type.typeName,
      sourceKind: "variable",
      metadata: foreignDeclarationMetadata(node),
    });
  });
  return interfaces;
}

function objcProtocolQualifiers(type: string): string[] {
  const match = /\bid\s*<([^>]+)>/.exec(type);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

function collectObjCProtocols(
  root: ClangNode,
  moduleName: string,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  objectTypes: Map<string, ForeignObjectType>,
): Map<string, ForeignObjCProtocol> {
  const declarations = new Map<string, ClangNode>();
  const interfaceNames = new Set<string>();
  visit(root, (node) => {
    if (node.kind === "ObjCInterfaceDecl" && node.name) interfaceNames.add(node.name);
    if (node.kind !== "ObjCProtocolDecl" || !node.name) return;
    const existing = declarations.get(node.name);
    if (!existing || (node.inner?.length ?? 0) > (existing.inner?.length ?? 0)) declarations.set(node.name, node);
  });
  const typeNames = new Map([...interfaceNames].map((name) => [name, `${moduleName}.${name}`]));
  const objectType = (className: string | null, nullable: boolean): ForeignObjectType => {
    const baseName = className ? typeNames.get(className) ?? `${moduleName}.${className}` : "id";
    const typeName = nullable || !className ? `__z_objc:${nullable ? "nullable" : "nonnull"}:${baseName}` : baseName;
    const existing = objectTypes.get(typeName);
    if (existing) return existing;
    const created: ForeignObjectType = {
      kind: "object",
      typeName,
      cName: className ? `${className} *` : "id",
      className,
      nullable,
    };
    objectTypes.set(typeName, created);
    return created;
  };
  const protocols = new Map<string, ForeignObjCProtocol>();
  for (const [protocolName, declaration] of declarations) {
    const methods = (declaration.inner ?? [])
      .filter((child) => child.kind === "ObjCMethodDecl" && child.name && child.returnType?.qualType)
      .map((method): ForeignObjCProtocolMethod => ({
        selector: method.name!,
        baseName: method.name!.split(":")[0],
        instance: method.instance === true,
        returnsInstanceType: /\binstancetype\b/.test(method.returnType!.qualType ?? ""),
        returnType: mapObjCType(method.returnType!, "", "return", namedTypes, typeNames, objectType),
        parameters: (method.inner ?? [])
          .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
          .map((parameter) => ({
            name: parameter.name ?? null,
            type: mapObjCType(parameter.type!, "", "parameter", namedTypes, typeNames, objectType),
          })),
        required: objcProtocolMethodRequired(declaration, method),
        metadata: foreignDeclarationMetadata(method),
        asyncCallbackParameter: null,
        asyncResultParameter: null,
        asyncErrorParameter: null,
      }));
    protocols.set(protocolName, {
      exportName: protocolName,
      typeName: `${moduleName}.${protocolName}`,
      protocolName,
      inherited: (declaration.protocols ?? []).flatMap((protocol) => protocol.name ? [protocol.name] : []),
      methods,
      metadata: foreignDeclarationMetadata(declaration),
    });
  }
  return protocols;
}

function objcProtocolMethodRequired(protocol: ClangNode, method: ClangNode): boolean {
  const protocolSource = foreignDeclarationMetadata(protocol).source;
  const methodSource = foreignDeclarationMetadata(method).source;
  if (
    !protocolSource
    || !methodSource
    || protocolSource.fileName !== methodSource.fileName
    || !existsSync(protocolSource.fileName)
  ) return true;
  const source = foreignSourceText(protocolSource.fileName);
  const protocolOffset = protocol.loc?.offset;
  const methodOffset = method.loc?.offset;
  if (protocolOffset === undefined || methodOffset === undefined || methodOffset < protocolOffset) return true;
  const prefix = source.slice(protocolOffset, methodOffset);
  const controls = [...prefix.matchAll(/@(required|optional)\b/g)];
  return controls.at(-1)?.[1] !== "optional";
}

function mapObjCType(
  type: { readonly qualType?: string; readonly desugaredQualType?: string },
  receiverClass: string,
  position: "return" | "parameter",
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  typeNames: ReadonlyMap<string, string>,
  objectType: (className: string | null, nullable: boolean) => ForeignObjectType,
): ForeignType {
  const qualified = type.qualType ?? "";
  const normalizedQualified = qualified
    .replace(/\b(?:const|volatile|__strong|__weak|__unsafe_unretained|__autoreleasing|_(?:Nullable|Nonnull|Null_unspecified))\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Clang reports Objective-C's typedef'd selector as either `SEL` or, for
  // some imported properties, `SEL *`. Both spellings represent the runtime
  // selector value rather than an ordinary user-visible pointer in Z.
  if (normalizedQualified === "SEL" || normalizedQualified === "SEL *") {
    return { kind: "selector", cName: "SEL" };
  }
  const nullable = /\b(?:_Nullable|_Null_unspecified)\b/.test(qualified);
  const block = mapObjCBlockType(
    qualified,
    receiverClass,
    namedTypes,
    typeNames,
    objectType,
  ) ?? (type.desugaredQualType && type.desugaredQualType !== qualified
    ? mapObjCBlockType(type.desugaredQualType, receiverClass, namedTypes, typeNames, objectType)
    : null);
  if (block) return block;
  const objectSpellings = [qualified, type.desugaredQualType]
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const spelling of objectSpellings) {
    if (/\binstancetype\b/.test(spelling)) return objectType(receiverClass, nullable);
    if (/^(?:__strong\s+)?id(?:\s|<|$)/.test(spelling.replace(/\b_(?:Nullable|Nonnull|Null_unspecified)\b/g, "").trim())) {
      return objectType(null, nullable);
    }
    const objectMatch = /(?:__kindof\s+)?([A-Za-z_]\w*)\s*\*/.exec(spelling);
    if (objectMatch && typeNames.has(objectMatch[1])) return objectType(objectMatch[1], nullable);
  }

  const pointerTypes = new Map<string, ForeignPointerType>();
  const mapped = mapForeignType(qualified, undefined, position, pointerTypes, namedTypes);
  if (mapped.kind !== "unsupported" || !type.desugaredQualType || type.desugaredQualType === qualified) return mapped;
  return mapForeignType(type.desugaredQualType, undefined, position, pointerTypes, namedTypes);
}

function mapObjCBlockType(
  cName: string,
  receiverClass: string,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  typeNames: ReadonlyMap<string, string>,
  objectType: (className: string | null, nullable: boolean) => ForeignObjectType,
): ForeignBlockType | null {
  const normalized = cName
    .replace(/__attribute__\s*\(\(noescape\)\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\^\s*(?:(?:__strong|__weak|__unsafe_unretained|__autoreleasing|_(?:Nonnull|Nullable|Null_unspecified))\s*)*\)\s*\((.*)\)$/.exec(normalized);
  if (!match) return null;
  const parameterSpellings = splitCParameters(match[2]);
  if (parameterSpellings.includes("...")) return null;
  const returnType = mapObjCType(
    { qualType: match[1].trim() },
    receiverClass,
    "return",
    namedTypes,
    typeNames,
    objectType,
  );
  const parameters = parameterSpellings
    .filter((parameter) => stripValueQualifiers(parameter) !== "void")
    .map((parameter) => mapObjCType(
      { qualType: parameter },
      receiverClass,
      "parameter",
      namedTypes,
      typeNames,
      objectType,
    ));
  if (returnType.kind === "unsupported" || parameters.some((parameter) => parameter.kind === "unsupported")) return null;
  return {
    kind: "block",
    cName,
    parameters,
    returnType,
    escaping: !/\bnoescape\b/.test(cName),
    nullable: /\b(?:_Nullable|_Null_unspecified)\b/.test(cName),
    thread: null,
    cardinality: null,
  };
}

function mapRecordFieldType(
  cName: string,
  namespacePath: readonly string[],
  named: ReadonlyMap<string, { typeName: string; kind: string; underlying?: ForeignScalarTypeName }>,
): string {
  const builtin = mapBuiltinType(cName);
  if (builtin && builtin !== "void") return builtin;
  const imported = resolvePotentialNamedType(cName, namespacePath, named);
  if (imported?.kind === "scalar") return imported.underlying!;
  if (imported?.kind === "enum" || imported?.kind === "record") return imported.typeName;
  return "";
}

function recordIsSupported(
  seed: { typeName: string; kind: string; namespacePath: readonly string[]; declaration?: ClangNode },
  named: ReadonlyMap<string, { typeName: string; kind: string; namespacePath: readonly string[]; declaration?: ClangNode }>,
  visiting: Set<string>,
): boolean {
  if (seed.kind !== "record" || !seed.declaration || visiting.has(seed.typeName)) return seed.kind !== "record";
  visiting.add(seed.typeName);
  const supported = (seed.declaration.inner ?? [])
    .filter((field) => field.kind === "FieldDecl")
    .every((field) => {
      if (!field.name || !field.type?.qualType) return false;
      const builtin = mapBuiltinType(field.type.qualType);
      if (builtin) return builtin !== "void";
      const nested = resolvePotentialNamedType(field.type.qualType, seed.namespacePath, named);
      if (!nested) return false;
      return nested.kind !== "record" || recordIsSupported(nested, named, visiting);
    });
  visiting.delete(seed.typeName);
  return supported;
}

function resolvePotentialNamedType<T>(
  cName: string,
  namespacePath: readonly string[],
  named: ReadonlyMap<string, T>,
): T | undefined {
  const normalized = stripValueQualifiers(cName);
  const direct = named.get(normalized);
  if (direct) return direct;
  for (let depth = namespacePath.length; depth > 0; depth -= 1) {
    const qualified = `${namespacePath.slice(0, depth).join("::")}::${normalized}`;
    const candidate = named.get(qualified);
    if (candidate) return candidate;
  }
  return undefined;
}

function foreignDeclarationMetadata(node: ClangNode | undefined): ForeignDeclarationMetadata {
  if (!node) return { source: null, availability: [], executorAffinity: null };
  const fallbackFile = clangNodeSourceFiles.get(node) ?? null;
  const source = foreignSourceLocation(node.loc ?? node.range?.begin, node.name?.length ?? 1, fallbackFile);
  const attributeAvailability = (node.inner ?? [])
    .filter((child) => child.kind === "AvailabilityAttr" || child.kind === "DeprecatedAttr" || child.kind === "UnavailableAttr")
    .map((attribute) => foreignAvailability(attribute, source?.fileName ?? null))
    .filter((item): item is ForeignAvailability => Boolean(item));
  const availability = attributeAvailability.length > 0
    ? attributeAvailability
    : sourceDeclarationAvailability(node, source);
  return {
    source,
    availability,
    executorAffinity: clangExecutorAffinity(node, source?.fileName ?? fallbackFile),
  };
}

function clangExecutorAffinity(node: ClangNode, fallbackFile: string | null): "main" | null {
  for (const attribute of node.inner ?? []) {
    if (attribute.kind !== "SwiftAttrAttr") continue;
    const text = attributeText(attribute, fallbackFile);
    if (text && /@(?:UIActor|MainActor)\b/.test(text)) return "main";
  }
  return null;
}

function sourceDeclarationAvailability(
  node: ClangNode,
  source: ForeignSourceLocation | null,
): readonly ForeignAvailability[] {
  if (!source || !existsSync(source.fileName)) return [];
  const text = foreignSourceText(source.fileName);
  const concrete = node.loc?.expansionLoc ?? node.loc?.spellingLoc ?? node.loc;
  const offset = concrete?.offset;
  if (offset === undefined) return [];
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const declarationEnd = text.indexOf(";", offset);
  if (declarationEnd === -1 || declarationEnd - lineStart > 4096) return [];
  const declaration = text.slice(lineStart, declarationEnd + 1);
  const result: ForeignAvailability[] = [];
  for (const match of declaration.matchAll(/\bAPI_AVAILABLE\s*\(([\s\S]*)\)\s*;/g)) {
    for (const platform of match[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([0-9]+(?:\.[0-9]+)*)\s*\)/g)) {
      result.push({
        platform: platform[1].toLowerCase(),
        introduced: platform[2],
        deprecated: false,
        deprecatedVersion: null,
        obsoleted: null,
        unavailable: false,
        message: null,
      });
    }
  }
  return result;
}

function foreignSourceLocation(
  location: ClangLocation | undefined,
  fallbackLength: number,
  fallbackFile: string | null,
): ForeignSourceLocation | null {
  const concrete = location?.expansionLoc ?? location?.spellingLoc ?? location;
  const fileName = concrete?.file && !concrete.file.startsWith("<") ? resolve(concrete.file) : fallbackFile;
  const line = concrete?.presumedLine ?? concrete?.line;
  const column = concrete?.col;
  if (!fileName || !line || !column) return null;
  return {
    fileName,
    line,
    column,
    length: concrete?.tokLen ?? fallbackLength,
  };
}

function hydrateClangSourceFiles(root: ClangNode): void {
  let currentFile: string | null = null;
  const walk = (node: ClangNode): void => {
    const explicit = explicitClangFile(node.loc) ?? explicitClangFile(node.range?.begin);
    if (explicit) currentFile = explicit;
    if (currentFile) clangNodeSourceFiles.set(node, currentFile);
    for (const child of node.inner ?? []) walk(child);
  };
  walk(root);
}

function explicitClangFile(location: ClangLocation | undefined): string | null {
  const candidates = [location?.expansionLoc?.file, location?.spellingLoc?.file, location?.file];
  const file = candidates.find((candidate) => candidate && !candidate.startsWith("<"));
  return file ? resolve(file) : null;
}

function foreignAvailability(attribute: ClangNode, fallbackFile: string | null): ForeignAvailability | null {
  if (attribute.kind === "UnavailableAttr") {
    return {
      platform: null,
      introduced: null,
      deprecated: false,
      deprecatedVersion: null,
      obsoleted: null,
      unavailable: true,
      message: attributeText(attribute, fallbackFile)?.match(/"((?:\\.|[^"\\])*)"/)?.[1] ?? null,
    };
  }
  if (attribute.kind === "DeprecatedAttr") {
    return {
      platform: null,
      introduced: null,
      deprecated: true,
      deprecatedVersion: null,
      obsoleted: null,
      unavailable: false,
      message: attributeText(attribute, fallbackFile)?.match(/"((?:\\.|[^"\\])*)"/)?.[1] ?? null,
    };
  }
  const text = attributeText(attribute, fallbackFile);
  const parsed = text?.match(/availability\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,([\s\S]*)\)/);
  if (!parsed) return null;
  const body = parsed[2];
  const introduced = body.match(/\bintroduced\s*=\s*([0-9]+(?:\.[0-9]+)*)/)?.[1] ?? null;
  const deprecatedVersion = body.match(/\bdeprecated\s*=\s*([0-9]+(?:\.[0-9]+)*)/)?.[1] ?? null;
  const obsoleted = body.match(/\bobsoleted\s*=\s*([0-9]+(?:\.[0-9]+)*)/)?.[1] ?? null;
  const message = body.match(/\bmessage\s*=\s*"((?:\\.|[^"\\])*)"/)?.[1] ?? null;
  return {
    platform: parsed[1].toLowerCase(),
    introduced,
    deprecated: deprecatedVersion !== null || /\bdeprecated\b/.test(body),
    deprecatedVersion,
    obsoleted,
    unavailable: /\bunavailable\b/.test(body),
    message,
  };
}

function attributeText(attribute: ClangNode, fallbackFile: string | null): string | null {
  const begin = attribute.range?.begin?.spellingLoc ?? attribute.range?.begin;
  const end = attribute.range?.end?.spellingLoc ?? attribute.range?.end;
  const rawFile = begin?.file && !begin.file.startsWith("<") ? begin.file : fallbackFile;
  if (!rawFile || begin?.offset === undefined || end?.offset === undefined) return null;
  const fileName = resolve(rawFile);
  if (!existsSync(fileName)) return null;
  const source = foreignSourceText(fileName);
  return source.slice(begin.offset, end.offset + (end.tokLen ?? 1));
}

function foreignSourceText(fileName: string): string {
  const stat = statSync(fileName);
  const freshness = `${stat.mtimeMs}:${stat.size}`;
  const cached = foreignSourceCache.get(fileName);
  if (cached?.freshness === freshness) return cached.source;
  const source = readFileSync(fileName, "utf8");
  foreignSourceCache.set(fileName, { freshness, source });
  return source;
}

function visit(node: ClangNode, callback: (node: ClangNode) => void): void {
  callback(node);
  for (const child of node.inner ?? []) visit(child, callback);
}

function visitWithNamespaces(
  node: ClangNode,
  callback: (node: ClangNode, namespaces: readonly string[]) => void,
  namespaces: readonly string[] = [],
): void {
  callback(node, namespaces);
  const nested = node.kind === "NamespaceDecl" && node.name ? [...namespaces, node.name] : namespaces;
  for (const child of node.inner ?? []) visitWithNamespaces(child, callback, nested);
}

function returnTypeOf(signature: string): string {
  const parameterList = signature.indexOf("(");
  return (parameterList === -1 ? signature : signature.slice(0, parameterList)).trim();
}

function qualifyNativeTypeSpelling(
  spelling: string,
  namespacePath: readonly string[],
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
): string {
  const normalized = normalizeCType(spelling);
  const reference = /^(?:const\s+)?(.+?)\s*&&?$/.exec(normalized);
  const pointer = /^(.+?)\s*\*$/.exec(normalized);
  const base = stripValueQualifiers(reference?.[1] ?? pointer?.[1] ?? normalized);
  if (namedTypes.has(base)) return normalized;
  for (let depth = namespacePath.length; depth > 0; depth -= 1) {
    const qualified = `${namespacePath.slice(0, depth).join("::")}::${base}`;
    if (!namedTypes.has(qualified)) continue;
    const offset = normalized.lastIndexOf(base);
    return offset < 0
      ? normalized
      : `${normalized.slice(0, offset)}${qualified}${normalized.slice(offset + base.length)}`;
  }
  return normalized;
}

function mapForeignType(
  cName: string,
  note: PointerNote | undefined,
  position: "return" | "parameter",
  types: Map<string, ForeignPointerType>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  desugaredCName?: string,
): ForeignType {
  if (position === "parameter" && (note?.callback?.lifetime === "call" || note?.callback?.lifetime === "escape")) {
    const callback = mapCallbackType(
      desugaredCName ?? cName,
      cName,
      types,
      namedTypes,
      note.callback,
    );
    if (callback) return callback;
  }
  const normalized = normalizeCType(cName);
  const stars = normalized.match(/\*/g)?.length ?? 0;
  if (note?.fixed) {
    return position === "parameter"
      ? { kind: "fixedNative", cName: normalized, expression: note.fixed }
      : { kind: "unsupported", cName };
  }
  if (note?.nullOnly) {
    return position === "parameter" && stars >= 1
      ? { kind: "nullPointer", cName: normalized }
      : { kind: "unsupported", cName };
  }
  if (note?.semanticType === "view-cstring") {
    const pointee = normalized.replace(/\s*\*\s*$/, "").trim();
    const characterPointer = stars === 1 && /^(?:const\s+)?(?:signed\s+|unsigned\s+)?char$/.test(pointee);
    if (position !== "return" || !characterPointer || note.ownership !== "borrowed" || note.nullable === undefined) {
      return { kind: "unsupported", cName };
    }
    const pointer: ForeignPointerType = {
      kind: "pointer",
      typeName: pointerTypeName(normalized, "borrowed", note.nullable),
      cName: normalized,
      identity: normalized,
      ownership: "borrowed",
      nullable: note.nullable,
      release: null,
      thread: { transfer: false, share: false, deinit: false },
      stringView: true,
    };
    types.set(pointer.typeName, pointer);
    const alternate: ForeignPointerType = {
      ...pointer,
      typeName: pointerTypeName(normalized, "borrowed", !note.nullable),
      nullable: !note.nullable,
    };
    types.set(alternate.typeName, alternate);
    return pointer;
  }
  if (normalized === "const char *") {
    return { kind: "z", name: "cstring", cName };
  }
  if (normalized === "swift::String") {
    return position === "return"
      ? { kind: "swiftString", cName: "swift::String" }
      : { kind: "unsupported", cName };
  }
  const reference = /^(const\s+)?(.+?)\s*(&&|&)$/.exec(normalized);
  if (reference) {
    if (position !== "parameter") return { kind: "unsupported", cName };
    const referenced = namedTypes.get(stripValueQualifiers(reference[2]));
    if (!referenced) return { kind: "unsupported", cName };
    const access: ForeignReferenceType["access"] = reference[3] === "&&"
      ? "move"
      : reference[1] ? "in" : "inout";
    if (access === "move" && !(referenced.kind === "value" && referenced.lifecycle.move && !referenced.lifecycle.copy)) {
      return { kind: "unsupported", cName };
    }
    return { kind: "reference", cName, type: referenced, access };
  }
  const valueName = stripValueQualifiers(normalized);
  const builtin = mapBuiltinType(valueName);
  if (builtin) return { kind: "z", name: builtin, cName };
  const named = namedTypes.get(valueName);
  if (named) {
    if (named.kind === "scalar") return { kind: "z", name: named.underlying, cName };
    return { kind: "named", type: named, cName };
  }
  if (
    stars === 2
    && position === "parameter"
    && note?.access === "out"
    && note.ownership === "owned"
    && note.release
  ) {
    const producedCName = normalized.replace(/\s*\*\s*$/, "").trim();
    const nullable = note.nullable ?? nullabilityFromClang(cName);
    if (nullable === null) return { kind: "unsupported", cName };
    const pointer: ForeignPointerType = {
      kind: "pointer",
      typeName: pointerTypeName(producedCName, "owned", nullable),
      cName: producedCName,
      identity: producedCName,
      ownership: "owned",
      nullable,
      release: note.release,
      thread: {
        transfer: note.thread?.transfer ?? false,
        share: note.thread?.share ?? false,
        deinit: note.thread?.deinit ?? false,
      },
    };
    types.set(pointer.typeName, pointer);
    types.set(pointerTypeName(producedCName, "owned", !nullable), { ...pointer, typeName: pointerTypeName(producedCName, "owned", !nullable), nullable: !nullable });
    return { kind: "pointerOut", cName: normalized, pointer };
  }
  if (stars === 1 && normalized.endsWith(" *")) {
    const pointeeSpelling = normalized.slice(0, -2).trim();
    const pointee = namedTypes.get(stripValueQualifiers(pointeeSpelling));
    if (pointee?.kind === "record" && note?.access) {
      const access = note?.access;
      const nullable = note?.nullable ?? nullabilityFromClang(cName);
      const constPointee = pointeeSpelling.split(/\s+/).includes("const");
      const validAccess = position === "parameter"
        && (access === "in" ? constPointee : (access === "out" || access === "inout") && !constPointee);
      if (!validAccess || nullable === null) return { kind: "unsupported", cName };
      return { kind: "recordPointer", cName: normalized, record: pointee, access, nullable };
    }
    const ownership = note?.ownership;
    const nullable = note?.nullable ?? nullabilityFromClang(cName);
    const validOwnership = position === "return"
      ? ownership === "owned"
      : ownership === "borrowed" || ownership === "consuming";
    if (!validOwnership || nullable === null || (ownership === "owned" && !note?.release)) {
      return { kind: "unsupported", cName };
    }
    const pointer: ForeignPointerType = {
      kind: "pointer",
      typeName: pointerTypeName(normalized, ownership, nullable),
      cName: normalized,
      identity: normalized,
      ownership,
      nullable,
      release: note?.release ?? null,
      thread: {
        transfer: note?.thread?.transfer ?? false,
        share: note?.thread?.share ?? false,
        deinit: note?.thread?.deinit ?? false,
      },
    };
    types.set(pointer.typeName, pointer);
    const alternate: ForeignPointerType = {
      ...pointer,
      typeName: pointerTypeName(normalized, ownership, !nullable),
      nullable: !nullable,
    };
    types.set(alternate.typeName, alternate);
    return pointer;
  }
  return { kind: "unsupported", cName };
}

function mapCallbackType(
  signature: string,
  cName: string,
  types: Map<string, ForeignPointerType>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  callbackNote: NonNullable<PointerNote["callback"]>,
): ForeignCallbackType | null {
  const normalized = signature
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\*\s*\)\s*\((.*)\)$/.exec(normalized);
  if (!match) return null;
  const parameterSpellings = splitCParameters(match[2]);
  if (parameterSpellings.includes("...")) return null;
  const contextParameter = callbackNote.context?.callbackParameter;
  if (
    callbackNote.context
    && (!Number.isInteger(contextParameter) || contextParameter! < 0 || contextParameter! >= parameterSpellings.length)
  ) return null;
  if (contextParameter !== undefined && normalizeCallbackContextType(parameterSpellings[contextParameter]) !== "void *") {
    return null;
  }
  const returnType = mapForeignType(match[1], undefined, "return", types, namedTypes);
  const parameters = parameterSpellings
    .filter((_, index) => index !== contextParameter)
    .map((parameter) => mapForeignType(parameter, undefined, "parameter", types, namedTypes));
  if (returnType.kind === "unsupported" || parameters.some((parameter) => parameter.kind === "unsupported")) {
    return null;
  }
  return {
    kind: "callback",
    cName,
    parameters,
    returnType,
    lifetime: callbackNote.lifetime!,
    context: callbackNote.context
      ? { parameter: callbackNote.context.parameter!, callbackParameter: contextParameter! }
      : null,
    release: callbackNote.release
      ? { parameter: callbackNote.release.parameter!, callbackParameter: callbackNote.release.callbackParameter! }
      : null,
    thread: callbackNote.thread ?? null,
    cardinality: callbackNote.cardinality ?? null,
  };
}

function mapProjectedByteCallback(
  nativeType: string,
  signature: string,
  nativeParameterNames: readonly string[],
  bytes: {
    readonly name: string;
    readonly access: "in" | "inout";
    readonly bufferParameter: number;
    readonly lengthParameters: readonly number[];
  },
): ForeignCallbackType {
  const normalized = signature
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\*\s*\)\s*\((.*)\)$/.exec(normalized);
  if (!match) throw new Error(`validated callback typedef ${nativeType} has no function-pointer signature`);
  const nativeParameters = splitCParameters(match[2]);
  const contextParameter = nativeParameters.findIndex((parameter) => (
    normalizeCallbackContextType(parameter) === "void *"
    && parameter !== nativeParameters[bytes.bufferParameter]
  ));
  return {
    kind: "callback",
    cName: nativeType,
    parameters: [{ kind: "z", name: sliceTypeName("u8"), cName: "Z_Slice_u8" }],
    returnType: { kind: "z", name: "usize", cName: "size_t" },
    lifetime: "escape",
    context: { parameter: -1, callbackParameter: contextParameter },
    release: null,
    thread: "caller",
    cardinality: "repeatedly",
    parameterNames: [bytes.name],
    parameterModes: [bytes.access === "inout" ? "inout" : "value"],
    nativeParameters,
    nativeParameterNames,
    bytesProjection: bytes,
  };
}

function mapCallbackContextType(cName: string, callbackParameter: number): ForeignType {
  if (normalizeCallbackContextType(cName) !== "void *") return { kind: "unsupported", cName };
  return { kind: "callbackContext", cName, callbackParameter };
}

function mapCallbackReleaseType(cName: string, callbackParameter: number, contextParameter: number): ForeignType {
  const normalized = cName
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(.+?)\s*\(\s*\*\s*\)\s*\((.*)\)$/.exec(normalized);
  const parameters = match ? splitCParameters(match[2]) : [];
  if (
    !match
    || stripValueQualifiers(match[1]) !== "void"
    || parameters.length !== 1
    || contextParameter !== 0
    || normalizeCallbackContextType(parameters[contextParameter]) !== "void *"
  ) return { kind: "unsupported", cName };
  return { kind: "callbackRelease", cName, callbackParameter };
}

function mapBuiltinType(cName: string): ForeignScalarTypeName | "void" | null {
  const normalized = stripValueQualifiers(cName);
  if (normalized === "void") return "void";
  if (normalized === "float") return "f32";
  if (normalized === "double") return "f64";
  if (normalized === "signed char") return "i8";
  if (normalized === "unsigned char") return "u8";
  if (normalized === "short" || normalized === "short int" || normalized === "signed short" || normalized === "signed short int") return "i16";
  if (normalized === "unsigned short" || normalized === "unsigned short int") return "u16";
  if (normalized === "int" || normalized === "signed int") return "i32";
  if (normalized === "unsigned" || normalized === "unsigned int") return "u32";
  if (normalized === "long" || normalized === "long int" || normalized === "signed long" || normalized === "signed long int") {
    return targetIntegerWidths().long === 8 ? "i64" : "i32";
  }
  if (normalized === "unsigned long" || normalized === "unsigned long int") {
    return targetIntegerWidths().long === 8 ? "u64" : "u32";
  }
  if (normalized === "long long" || normalized === "long long int" || normalized === "signed long long" || normalized === "signed long long int") return "i64";
  if (normalized === "unsigned long long" || normalized === "unsigned long long int") return "u64";
  if (normalized === "_Bool" || normalized === "bool") return "boolean";
  return null;
}

function mapTypedefType(name: string, cName: string): ForeignScalarTypeName | "void" | null {
  const exact: Readonly<Record<string, ForeignScalarTypeName>> = {
    int8_t: "i8",
    uint8_t: "u8",
    int16_t: "i16",
    uint16_t: "u16",
    int32_t: "i32",
    uint32_t: "u32",
    int64_t: "i64",
    uint64_t: "u64",
    intptr_t: "isize",
    uintptr_t: "usize",
    ptrdiff_t: "isize",
    size_t: "usize",
    NSInteger: "isize",
    NSUInteger: "usize",
  };
  const underlying = mapBuiltinType(cName);
  const intended = exact[name];
  if (!intended || !underlying || underlying === "void" || underlying === "boolean") return underlying;
  const widths = targetIntegerWidths();
  const widthOf = (type: ForeignScalarTypeName): number => {
    if (type === "isize" || type === "usize") return widths.pointer * 8;
    return Number(/\d+/.exec(type)?.[0] ?? 0);
  };
  const sameSignedness = intended.startsWith("i") === underlying.startsWith("i")
    || intended.startsWith("u") === underlying.startsWith("u");
  return widthOf(intended) === widthOf(underlying) && sameSignedness ? intended : underlying;
}

let cachedTargetWidths: { long: number; pointer: number } | null = null;

function targetIntegerWidths(): { long: number; pointer: number } {
  if (cachedTargetWidths) return cachedTargetWidths;
  const result = spawnSync("clang", ["-dM", "-E", "-x", "c", "/dev/null"], { encoding: "utf8" });
  const longMatch = result.status === 0 ? /^#define __SIZEOF_LONG__ (\d+)$/m.exec(result.stdout) : null;
  const pointerMatch = result.status === 0 ? /^#define __SIZEOF_POINTER__ (\d+)$/m.exec(result.stdout) : null;
  const fallbackPointer = process.arch.includes("64") ? 8 : 4;
  cachedTargetWidths = {
    long: longMatch ? Number(longMatch[1]) : process.platform === "win32" ? 4 : fallbackPointer,
    pointer: pointerMatch ? Number(pointerMatch[1]) : fallbackPointer,
  };
  return cachedTargetWidths;
}

function stripValueQualifiers(cName: string): string {
  return cName.replace(/^(?:(?:const|volatile)\s+)+/, "").trim();
}

function normalizeCType(cName: string): string {
  return cName
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*/g, " *")
    .trim();
}

function nullabilityFromClang(cName: string): boolean | null {
  if (/\b_Nullable\b/.test(cName)) return true;
  if (/\b_Nonnull\b/.test(cName)) return false;
  return null;
}

export function pointerTypeName(
  identity: string,
  ownership: ForeignPointerType["ownership"],
  nullable: boolean,
): string {
  return `__z_ffi:${ownership}:${nullable ? "nullable" : "nonnull"}:${identity}`;
}

export function parsePointerTypeName(name: string): {
  readonly identity: string;
  readonly ownership: ForeignPointerType["ownership"];
  readonly nullable: boolean;
} | null {
  const match = /^__z_ffi:(owned|borrowed|consuming):(nullable|nonnull):(.*)$/.exec(name);
  if (!match) return null;
  return {
    ownership: match[1] as ForeignPointerType["ownership"],
    nullable: match[2] === "nullable",
    identity: match[3],
  };
}

function discoverFramework(header: string): string | null {
  if (process.platform !== "darwin") return null;
  const match = /^([A-Za-z_]\w*)\//.exec(header);
  if (!match) return null;
  if (cachedSdkPath === undefined) {
    const result = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" });
    cachedSdkPath = result.status === 0 ? result.stdout.trim() : null;
  }
  if (!cachedSdkPath) return null;
  const frameworkPath = resolve(cachedSdkPath, "System/Library/Frameworks", `${match[1]}.framework`);
  return existsSync(frameworkPath) ? match[1] : null;
}

function isCPlusPlusHeader(header: string): boolean {
  return /\.(?:hh|hpp|hxx|h\+\+)$/i.test(header);
}

function isSwiftCompatibilityHeader(header: string): boolean {
  return /-Swift\.h$/i.test(header);
}

function swiftCompatibilityNamespace(header: string): string | null {
  return /^([A-Za-z_]\w*)-Swift\.(?:hh|hpp|hxx|h\+\+)$/i.exec(basename(header))?.[1] ?? null;
}
