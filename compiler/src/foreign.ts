import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { apiNotesFreshness, readApiNotes, type PointerNote } from "./foreign-api-notes.ts";
import { normalizeForeignContracts } from "./foreign-contracts.ts";
import {
  normalizeCallbackContextType,
  splitCParameters,
} from "./foreign-type-spelling.ts";
import { isStandardModuleSpecifier } from "./standard-library.ts";
import type {
  ForeignCallbackType,
  ForeignAvailability,
  ForeignBlockType,
  ForeignConstant,
  ForeignDeclarationMetadata,
  ForeignField,
  ForeignFunctionDeclaration,
  ForeignModuleIR,
  ForeignModuleDeclarations,
  ForeignNamedType,
  ForeignObjCInterface,
  ForeignObjCMethod,
  ForeignObjCProperty,
  ForeignObjectType,
  ForeignPointerType,
  ForeignRecordPointerType,
  ForeignScalarTypeName,
  ForeignSourceLocation,
  ForeignType,
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
  readonly class?: boolean;
  readonly getter?: { readonly name?: string };
  readonly setter?: { readonly name?: string };
  readonly storageClass?: string;
  readonly isImplicit?: boolean;
  readonly returnType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly super?: { readonly name?: string };
  readonly fixedUnderlyingType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly loc?: ClangLocation;
  readonly range?: { readonly begin?: ClangLocation; readonly end?: ClangLocation };
  readonly inner?: readonly ClangNode[];
};

type ClangLocation = {
  readonly offset?: number;
  readonly file?: string;
  readonly line?: number;
  readonly presumedLine?: number;
  readonly col?: number;
  readonly tokLen?: number;
  readonly spellingLoc?: ClangLocation;
  readonly expansionLoc?: ClangLocation;
};

const headerCache = new Map<string, HeaderInfo>();
const foreignSourceCache = new Map<string, { readonly freshness: string; readonly source: string }>();
const clangNodeSourceFiles = new WeakMap<ClangNode, string>();
let cachedSdkPath: string | null | undefined;

export function resolveForeignModules(
  declarations: readonly ImportDeclaration[],
  fileName: string,
  projectIncludeDirectories: readonly string[] = [],
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
    const notesFreshness = apiNotesFreshness(declaration, headerDirectory);
    const cacheKey = `${declarationIncludeDirectories.join("\0")}\0${declaration.header}\0${headerFreshness}\0${notesFreshness}\0${declaration.moduleName}\0${framework ?? language}`;
    let header = headerCache.get(cacheKey);
    if (!header) {
      header = readHeader(declaration, fileName, declarationIncludeDirectories, headerDirectory, framework, objectiveC, cPlusPlus);
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
): HeaderInfo {
  const clangLanguage = objectiveC ? cPlusPlus ? "objective-c++" : "objective-c" : cPlusPlus ? "c++" : "c";
  const swiftCxxNamespace = cPlusPlus ? swiftCompatibilityNamespace(declaration.header) : null;
  const clangArguments = [
    "-x", clangLanguage,
    ...(cPlusPlus ? ["-std=c++20"] : []),
    ...(objectiveC ? ["-fobjc-arc"] : []),
    ...includeDirectories.flatMap((directory) => ["-I", directory]),
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

  const imported = collectNamedTypes(root, declaration.moduleName, cPlusPlus, swiftCxxNamespace);
  const constants = new Map(imported.constants);
  const objectTypes = new Map<string, ForeignObjectType>();
  const interfaces = objectiveC
    ? collectObjCInterfaces(root, declaration.moduleName, imported.byCName, objectTypes, constants)
    : new Map<string, ForeignObjCInterface>();
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
    framework,
    objectiveC,
    cPlusPlus,
  };
  const notes = readApiNotes(declaration, fileName, headerDirectory, produced.functions);
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
    },
    fileName,
    declaration.location,
  );
  return {
    producer: produced.producer,
    functions: contracts.functions,
    functionAliases: contracts.functionAliases,
    types: contracts.pointerTypes,
    namedTypes: produced.namedTypes,
    namedTypeAliases: imported.namedTypeAliases,
    namespaces: new Set([...contracts.namespaces, ...imported.namespaces]),
    constants: produced.constants,
    objectTypes: produced.objectTypes,
    interfaces: produced.interfaces,
    framework: produced.framework,
    objectiveC: produced.objectiveC,
    cPlusPlus: produced.cPlusPlus,
  };
}

function collectNamedTypes(
  root: ClangNode,
  moduleName: string,
  cPlusPlus: boolean,
  swiftCxxNamespace: string | null,
): {
  namedTypes: ReadonlyMap<string, ForeignNamedType>;
  namedTypeAliases: ReadonlyMap<string, string>;
  namespaces: ReadonlySet<string>;
  constants: ReadonlyMap<string, ForeignConstant>;
  byCName: ReadonlyMap<string, ForeignNamedType>;
} {
  const nodes: ClangNode[] = [];
  visit(root, (node) => nodes.push(node));
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
  }[] = [];
  if (cPlusPlus) {
    visitWithNamespaces(root, (node, namespaces) => {
      if (
        node.kind !== "CXXRecordDecl"
        || !node.name
      ) return;
      if (swiftCxxNamespace && namespaces[0] !== swiftCxxNamespace) return;
      const fields = node.inner?.some((child) => child.kind === "FieldDecl") ?? false;
      const opaque = swiftCxxNamespace !== null
        && node.tagUsed === "class"
        && (node.inner?.some((child) => child.kind === "CXXDestructorDecl") ?? false);
      if (!(node.tagUsed === "struct" && fields) && !opaque) return;
      const namespacePath = swiftCxxNamespace ? namespaces.slice(1) : namespaces;
      cppRecords.push({
        exportName: node.name,
        namespacePath,
        qualifiedName: [...namespacePath, node.name].join("."),
        cName: [...namespaces, node.name].join("::"),
        declaration: node,
        opaque,
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
  };
  const seeds = new Map<string, Seed>();
  for (const node of nodes) {
    if (node.kind !== "TypedefDecl" || !node.name || !node.type?.qualType) continue;
    const qualified = node.type.qualType;
    const desugared = node.type.desugaredQualType ?? qualified;
    const recordMatch = /^struct (.+)$/.exec(desugared);
    const enumMatch = /^enum (.+)$/.exec(desugared) ?? /^enum (.+)$/.exec(qualified);
    const underlying = mapTypedefType(node.name, desugared);
    const enumDeclaration = enumMatch ? enums.get(enumMatch[1]) : undefined;
    const kind = recordMatch && records.has(recordMatch[1])
      ? "record"
      : enumMatch && enums.has(enumMatch[1])
        ? "enum"
        : underlying && underlying !== "void"
          ? "scalar"
          : null;
    if (!kind) continue;
    seeds.set(node.name, {
      kind,
      exportName: node.name,
      namespacePath: [],
      qualifiedName: node.name,
      typeName: `${moduleName}.${node.name}`,
      cName: node.name,
      declaration: kind === "record" ? records.get(recordMatch![1]) : kind === "enum" ? enums.get(enumMatch![1]) : undefined,
      sourceDeclaration: node,
      underlying: kind === "scalar"
        ? underlying as ForeignScalarTypeName
        : kind === "enum"
          ? mapBuiltinType(enumDeclaration?.fixedUnderlyingType?.desugaredQualType ?? enumDeclaration?.fixedUnderlyingType?.qualType ?? "int") ?? "i32"
          : undefined,
      flags: kind === "enum" && enumDeclaration?.inner?.some((child) => child.kind === "FlagEnumAttr"),
    });
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
      named = { kind: "value", exportName: seed.exportName, namespacePath: seed.namespacePath, qualifiedName: seed.qualifiedName, typeName: seed.typeName, cName: seed.cName, metadata };
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

  const constants = new Map<string, ForeignConstant>();
  for (const named of namedTypes.values()) {
    if (named.kind !== "enum") continue;
    const declaration = seeds.get(named.qualifiedName)?.declaration;
    for (const constant of declaration?.inner ?? []) {
      if (constant.kind !== "EnumConstantDecl" || !constant.name) continue;
      constants.set(constant.name, { name: constant.name, cName: constant.name, typeName: named.typeName, metadata: foreignDeclarationMetadata(constant) });
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
    constants.set(node.name, { name: node.name, cName: node.name, typeName: type.typeName, metadata: foreignDeclarationMetadata(node) });
  });
  return interfaces;
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
  if (!node) return { source: null, availability: [] };
  const fallbackFile = clangNodeSourceFiles.get(node) ?? null;
  const source = foreignSourceLocation(node.loc ?? node.range?.begin, node.name?.length ?? 1, fallbackFile);
  const availability = (node.inner ?? [])
    .filter((child) => child.kind === "AvailabilityAttr" || child.kind === "DeprecatedAttr" || child.kind === "UnavailableAttr")
    .map((attribute) => foreignAvailability(attribute, source?.fileName ?? null))
    .filter((item): item is ForeignAvailability => Boolean(item));
  return { source, availability };
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
  const stat = statSync(fileName);
  const freshness = `${stat.mtimeMs}:${stat.size}`;
  const cached = foreignSourceCache.get(fileName);
  const source = cached?.freshness === freshness ? cached.source : readFileSync(fileName, "utf8");
  if (cached?.freshness !== freshness) foreignSourceCache.set(fileName, { freshness, source });
  return source.slice(begin.offset, end.offset + (end.tokLen ?? 1));
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
  const reference = /^(?:const\s+)?(.+?)\s*&$/.exec(normalized);
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
  if (normalized === "const char *") {
    return { kind: "z", name: "cstring", cName };
  }
  const valueName = stripValueQualifiers(normalized);
  const builtin = mapBuiltinType(valueName);
  if (builtin) return { kind: "z", name: builtin, cName };
  const named = namedTypes.get(valueName);
  if (named) {
    if (named.kind === "scalar") return { kind: "z", name: named.underlying, cName };
    return { kind: "named", type: named, cName };
  }
  const reference = /^const\s+(.+?)\s*&$/.exec(normalized);
  if (reference) {
    const referenced = namedTypes.get(stripValueQualifiers(reference[1]));
    if (referenced) {
      if (referenced.kind === "scalar") return { kind: "z", name: referenced.underlying, cName };
      return { kind: "named", type: referenced, cName };
    }
  }
  const stars = normalized.match(/\*/g)?.length ?? 0;
  if (stars === 1 && normalized.endsWith(" *")) {
    const pointeeSpelling = normalized.slice(0, -2).trim();
    const pointee = namedTypes.get(stripValueQualifiers(pointeeSpelling));
    if (pointee?.kind === "record") {
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
  if (normalized === "_Bool" || normalized === "bool") return "bool";
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
  if (!intended || !underlying || underlying === "void" || underlying === "bool") return underlying;
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
