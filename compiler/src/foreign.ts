import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type ForeignScalarTypeName =
  | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "isize" | "usize" | "f32" | "f64" | "bool";

export type ForeignType =
  | { readonly kind: "z"; readonly name: ForeignScalarTypeName | "cstring" | "void"; readonly cName: string }
  | { readonly kind: "named"; readonly type: ForeignNamedType; readonly cName: string }
  | ForeignObjectType
  | ForeignRecordPointerType
  | ForeignPointerType
  | { readonly kind: "unsupported"; readonly cName: string };

export type ForeignNamedType =
  | {
    readonly kind: "record";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly fields: readonly ForeignField[];
  }
  | {
    readonly kind: "enum";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly flags: boolean;
    readonly underlying: ForeignScalarTypeName;
  }
  | {
    readonly kind: "scalar";
    readonly exportName: string;
    readonly typeName: string;
    readonly cName: string;
    readonly underlying: ForeignScalarTypeName;
  };

export type ForeignField = {
  readonly name: string;
  readonly typeName: string;
};

export type ForeignConstant = {
  readonly name: string;
  readonly cName: string;
  readonly typeName: string;
};

export type ForeignObjectType = {
  readonly kind: "object";
  readonly typeName: string;
  readonly cName: string;
  readonly className: string | null;
  readonly nullable: boolean;
};

export type ForeignObjCMethod = {
  readonly selector: string;
  readonly baseName: string;
  readonly instance: boolean;
  readonly returnsInstanceType: boolean;
  readonly returnType: ForeignType;
  readonly parameters: readonly ForeignParameter[];
};

export type ForeignObjCProperty = {
  readonly name: string;
  readonly getter: string;
  readonly setter: string | null;
  readonly classProperty: boolean;
  readonly readonly: boolean;
  readonly type: ForeignType;
};

export type ForeignObjCInterface = {
  readonly exportName: string;
  readonly typeName: string;
  readonly className: string;
  readonly superName: string | null;
  readonly methods: readonly ForeignObjCMethod[];
  readonly properties: readonly ForeignObjCProperty[];
};

export type ForeignPointerType = {
  readonly kind: "pointer";
  readonly typeName: string;
  readonly cName: string;
  readonly identity: string;
  readonly ownership: "owned" | "borrowed" | "consuming";
  readonly nullable: boolean;
  readonly release: string | null;
};

export type ForeignRecordPointerType = {
  readonly kind: "recordPointer";
  readonly cName: string;
  readonly record: Extract<ForeignNamedType, { kind: "record" }>;
  readonly access: "in" | "out" | "inout";
  readonly nullable: boolean;
};

export type ForeignParameter = {
  readonly name: string | null;
  readonly type: ForeignType;
};

export type ForeignFunction = {
  readonly name: string;
  readonly cName: string;
  readonly alternatives: readonly { readonly cName: string; readonly cSignature: string }[];
  readonly returnType: ForeignType;
  readonly parameters: readonly ForeignParameter[];
  readonly variadic: boolean;
  readonly cSignature: string;
};

export type ForeignModule = {
  readonly declaration: ImportDeclaration;
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly types: ReadonlyMap<string, ForeignPointerType>;
  readonly namedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly constants: ReadonlyMap<string, ForeignConstant>;
  readonly objectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly interfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly framework: string | null;
  readonly cPlusPlus: boolean;
};

type HeaderInfo = {
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly types: ReadonlyMap<string, ForeignPointerType>;
  readonly namedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly constants: ReadonlyMap<string, ForeignConstant>;
  readonly objectTypes: ReadonlyMap<string, ForeignObjectType>;
  readonly interfaces: ReadonlyMap<string, ForeignObjCInterface>;
  readonly framework: string | null;
  readonly cPlusPlus: boolean;
};

type PointerNote = {
  readonly ownership?: "owned" | "borrowed" | "consuming";
  readonly access?: "in" | "out" | "inout";
  readonly nullable?: boolean;
  readonly release?: string;
};

type ApiNotes = {
  readonly functions?: Readonly<Record<string, {
    readonly return?: PointerNote;
    readonly parameters?: Readonly<Record<string, PointerNote>>;
  }>>;
};

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
  readonly isImplicit?: boolean;
  readonly returnType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly super?: { readonly name?: string };
  readonly fixedUnderlyingType?: { readonly qualType?: string; readonly desugaredQualType?: string };
  readonly inner?: readonly ClangNode[];
};

const headerCache = new Map<string, HeaderInfo>();
let cachedSdkPath: string | null | undefined;

export function resolveForeignModules(
  declarations: readonly ImportDeclaration[],
  fileName: string,
): ReadonlyMap<string, ForeignModule> {
  const modules = new Map<string, ForeignModule>();
  for (const declaration of declarations) {
    const includeDirectory = resolve(dirname(fileName));
    const framework = discoverFramework(declaration.header);
    const cPlusPlus = isCPlusPlusHeader(declaration.header);
    const cacheKey = `${includeDirectory}\0${declaration.header}\0${declaration.moduleName}\0${framework ?? (cPlusPlus ? "c++" : "c")}`;
    let header = headerCache.get(cacheKey);
    if (!header) {
      header = readHeader(declaration, fileName, includeDirectory, framework, cPlusPlus);
      headerCache.set(cacheKey, header);
    }
    modules.set(declaration.moduleName, { declaration, ...header });
  }
  return modules;
}

function readHeader(
  declaration: ImportDeclaration,
  fileName: string,
  includeDirectory: string,
  framework: string | null,
  cPlusPlus: boolean,
): HeaderInfo {
  const clangLanguage = framework ? "objective-c" : cPlusPlus ? "c++" : "c";
  const clangArguments = [
    "-x", clangLanguage,
    ...(cPlusPlus ? ["-std=c++20"] : []),
    ...(framework ? ["-fobjc-arc"] : []),
    "-I", includeDirectory,
    "-include", declaration.header,
    "-Xclang", "-ast-dump=json",
    "-fsyntax-only",
    "/dev/null",
  ];
  const result = spawnSync(framework ? "xcrun" : "clang", framework ? ["clang", ...clangArguments] : clangArguments, {
    encoding: "utf8",
    maxBuffer: framework ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
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

  const notes = readApiNotes(declaration, fileName, includeDirectory);
  const imported = collectNamedTypes(root, declaration.moduleName, cPlusPlus);
  const objectTypes = new Map<string, ForeignObjectType>();
  const interfaces = framework
    ? collectObjCInterfaces(root, declaration.moduleName, imported.byCName, objectTypes)
    : new Map<string, ForeignObjCInterface>();
  const functions = new Map<string, ForeignFunction>();
  const types = new Map<string, ForeignPointerType>();
  visitWithNamespaces(root, (node, namespaces) => {
    if (node.kind !== "FunctionDecl" || !node.name || !node.type?.qualType) return;
    const functionNotes = notes.functions?.[node.name];
    const parameters = (node.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
      .map((child, index) => ({
        name: child.name ?? null,
        type: mapForeignType(child.type!.qualType!, functionNotes?.parameters?.[String(index)], "parameter", types, imported.byCName),
      }));
    const cSignature = node.type.qualType;
    const cName = cPlusPlus && namespaces.length > 0 ? `${namespaces.join("::")}::${node.name}` : node.name;
    const candidate: ForeignFunction = {
      name: node.name,
      cName,
      alternatives: [{ cName, cSignature }],
      returnType: mapForeignType(returnTypeOf(cSignature), functionNotes?.return, "return", types, imported.byCName),
      parameters,
      variadic: node.variadic === true,
      cSignature,
    };
    const existing = functions.get(node.name);
    if (!existing) {
      functions.set(node.name, candidate);
      return;
    }
    const alternatives = [...existing.alternatives];
    if (!alternatives.some((item) => item.cName === cName && item.cSignature === cSignature)) {
      alternatives.push({ cName, cSignature });
    }
    functions.set(node.name, { ...existing, alternatives });
  });
  for (const target of functions.values()) {
    if (target.returnType.kind !== "pointer" || target.returnType.ownership !== "owned") continue;
    const release = target.returnType.release ? functions.get(target.returnType.release) : null;
    const released = release?.parameters[0]?.type;
    const validRelease = release
      && release.parameters.length === 1
      && released?.kind === "pointer"
      && released.ownership === "consuming"
      && released.identity === target.returnType.identity;
    if (!validRelease) {
      throw new DiagnosticError(
        fileName,
        declaration.location,
        `API notes for ${JSON.stringify(target.name)} require ${JSON.stringify(target.returnType.release)} to consume exactly one ${target.returnType.cName}`,
      );
    }
  }
  return { functions, types, namedTypes: imported.namedTypes, constants: imported.constants, objectTypes, interfaces, framework, cPlusPlus };
}

function collectNamedTypes(
  root: ClangNode,
  moduleName: string,
  cPlusPlus: boolean,
): {
  namedTypes: ReadonlyMap<string, ForeignNamedType>;
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

  const cppRecords: { readonly exportName: string; readonly cName: string; readonly declaration: ClangNode }[] = [];
  if (cPlusPlus) {
    visitWithNamespaces(root, (node, namespaces) => {
      if (
        node.kind !== "CXXRecordDecl"
        || node.tagUsed !== "struct"
        || !node.name
        || !node.inner?.some((child) => child.kind === "FieldDecl")
      ) return;
      cppRecords.push({
        exportName: node.name,
        cName: [...namespaces, node.name].join("::"),
        declaration: node,
      });
    });
  }

  type Seed = {
    kind: "record" | "enum" | "scalar";
    exportName: string;
    typeName: string;
    cName: string;
    declaration?: ClangNode;
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
      typeName: `${moduleName}.${node.name}`,
      cName: node.name,
      declaration: kind === "record" ? records.get(recordMatch![1]) : kind === "enum" ? enums.get(enumMatch![1]) : undefined,
      underlying: kind === "scalar"
        ? underlying as ForeignScalarTypeName
        : kind === "enum"
          ? mapBuiltinType(enumDeclaration?.fixedUnderlyingType?.desugaredQualType ?? enumDeclaration?.fixedUnderlyingType?.qualType ?? "int") ?? "i32"
          : undefined,
      flags: kind === "enum" && enumDeclaration?.inner?.some((child) => child.kind === "FlagEnumAttr"),
    });
  }
  for (const record of cppRecords) {
    if (seeds.has(record.exportName)) continue;
    seeds.set(record.exportName, {
      kind: "record",
      exportName: record.exportName,
      typeName: `${moduleName}.${record.exportName}`,
      cName: record.cName,
      declaration: record.declaration,
    });
  }

  const potential = new Map<string, { typeName: string; kind: Seed["kind"]; underlying?: ForeignScalarTypeName; declaration?: ClangNode }>();
  for (const seed of seeds.values()) {
    potential.set(seed.cName, seed);
    potential.set(seed.exportName, seed);
  }
  const namedTypes = new Map<string, ForeignNamedType>();
  const byCName = new Map<string, ForeignNamedType>();
  for (const seed of seeds.values()) {
    let named: ForeignNamedType | null = null;
    if (seed.kind === "scalar") {
      named = { kind: "scalar", exportName: seed.exportName, typeName: seed.typeName, cName: seed.cName, underlying: seed.underlying! };
    } else if (seed.kind === "enum") {
      named = {
        kind: "enum",
        exportName: seed.exportName,
        typeName: seed.typeName,
        cName: seed.cName,
        flags: seed.flags ?? false,
        underlying: seed.underlying ?? "i32",
      };
    } else {
      const fields = (seed.declaration!.inner ?? []).filter((child) => child.kind === "FieldDecl");
      const mapped = fields.map((field) => field.name && field.type?.qualType
        ? { name: field.name, typeName: mapRecordFieldType(field.type.qualType, potential) }
        : null);
      if (recordIsSupported(seed, potential, new Set()) && mapped.every((field): field is ForeignField => Boolean(field?.typeName))) {
        named = { kind: "record", exportName: seed.exportName, typeName: seed.typeName, cName: seed.cName, fields: mapped };
      }
    }
    if (!named) continue;
    namedTypes.set(named.exportName, named);
    byCName.set(named.cName, named);
    byCName.set(named.exportName, named);
  }

  const constants = new Map<string, ForeignConstant>();
  for (const named of namedTypes.values()) {
    if (named.kind !== "enum") continue;
    const declaration = seeds.get(named.exportName)?.declaration;
    for (const constant of declaration?.inner ?? []) {
      if (constant.kind !== "EnumConstantDecl" || !constant.name) continue;
      constants.set(constant.name, { name: constant.name, cName: constant.name, typeName: named.typeName });
    }
  }
  return { namedTypes, constants, byCName };
}

function collectObjCInterfaces(
  root: ClangNode,
  moduleName: string,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
  objectTypes: Map<string, ForeignObjectType>,
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
    const typeName = nullable ? `__z_objc:nullable:${baseName}` : `__z_objc:nonnull:${baseName}`;
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
      }));
    interfaces.set(className, {
      exportName: className,
      typeName: typeNames.get(className)!,
      className,
      superName: declaration.super?.name ?? null,
      methods,
      properties,
    });
    objectType(className, false);
    objectType(className, true);
  }
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
  if (/\binstancetype\b/.test(qualified)) return objectType(receiverClass, nullable);
  if (/^(?:__strong\s+)?id(?:\s|<|$)/.test(qualified.replace(/\b_(?:Nullable|Nonnull|Null_unspecified)\b/g, "").trim())) {
    return objectType(null, nullable);
  }
  const objectMatch = /(?:__kindof\s+)?([A-Za-z_]\w*)\s*\*/.exec(qualified);
  if (objectMatch && typeNames.has(objectMatch[1])) return objectType(objectMatch[1], nullable);

  const pointerTypes = new Map<string, ForeignPointerType>();
  const mapped = mapForeignType(qualified, undefined, position, pointerTypes, namedTypes);
  if (mapped.kind !== "unsupported" || !type.desugaredQualType || type.desugaredQualType === qualified) return mapped;
  return mapForeignType(type.desugaredQualType, undefined, position, pointerTypes, namedTypes);
}

function mapRecordFieldType(
  cName: string,
  named: ReadonlyMap<string, { typeName: string; kind: string; underlying?: ForeignScalarTypeName }>,
): string {
  const builtin = mapBuiltinType(cName);
  if (builtin && builtin !== "void") return builtin;
  const imported = named.get(stripValueQualifiers(cName));
  if (imported?.kind === "scalar") return imported.underlying!;
  if (imported?.kind === "enum" || imported?.kind === "record") return imported.typeName;
  return "";
}

function recordIsSupported(
  seed: { typeName: string; kind: string; declaration?: ClangNode },
  named: ReadonlyMap<string, { typeName: string; kind: string; declaration?: ClangNode }>,
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
      const nested = named.get(stripValueQualifiers(field.type.qualType));
      if (!nested) return false;
      return nested.kind !== "record" || recordIsSupported(nested, named, visiting);
    });
  visiting.delete(seed.typeName);
  return supported;
}

function readApiNotes(
  declaration: ImportDeclaration,
  fileName: string,
  includeDirectory: string,
): ApiNotes {
  const localPath = resolve(includeDirectory, `${declaration.header}.zapi.json`);
  const localHeader = resolve(includeDirectory, declaration.header);
  const builtInPath = resolve(dirname(fileURLToPath(import.meta.url)), "../api-notes", `${basename(declaration.header)}.json`);
  const canUseBuiltIn = declaration.header === basename(declaration.header) && !existsSync(localHeader);
  const notesPath = existsSync(localPath)
    ? localPath
    : canUseBuiltIn && existsSync(builtInPath)
      ? builtInPath
      : null;
  if (!notesPath) return {};
  try {
    return JSON.parse(readFileSync(notesPath, "utf8")) as ApiNotes;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DiagnosticError(fileName, declaration.location, `could not read API notes ${JSON.stringify(notesPath)}: ${detail}`);
  }
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

function mapForeignType(
  cName: string,
  note: PointerNote | undefined,
  position: "return" | "parameter",
  types: Map<string, ForeignPointerType>,
  namedTypes: ReadonlyMap<string, ForeignNamedType>,
): ForeignType {
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
