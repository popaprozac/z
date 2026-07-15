import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type ForeignScalarTypeName =
  | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "isize" | "usize" | "bool";

export type ForeignType =
  | { readonly kind: "z"; readonly name: ForeignScalarTypeName | "cstring" | "void"; readonly cName: string }
  | { readonly kind: "named"; readonly type: ForeignNamedType; readonly cName: string }
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
};

type HeaderInfo = {
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly types: ReadonlyMap<string, ForeignPointerType>;
  readonly namedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly constants: ReadonlyMap<string, ForeignConstant>;
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
  readonly inner?: readonly ClangNode[];
};

const headerCache = new Map<string, HeaderInfo>();

export function resolveForeignModules(
  declarations: readonly ImportDeclaration[],
  fileName: string,
): ReadonlyMap<string, ForeignModule> {
  const modules = new Map<string, ForeignModule>();
  for (const declaration of declarations) {
    const includeDirectory = resolve(dirname(fileName));
    const cacheKey = `${includeDirectory}\0${declaration.header}\0${declaration.moduleName}`;
    let header = headerCache.get(cacheKey);
    if (!header) {
      header = readHeader(declaration, fileName, includeDirectory);
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
): HeaderInfo {
  const result = spawnSync("clang", [
    "-x", "c",
    "-I", includeDirectory,
    "-include", declaration.header,
    "-Xclang", "-ast-dump=json",
    "-fsyntax-only",
    "/dev/null",
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
  const imported = collectNamedTypes(root, declaration.moduleName);
  const functions = new Map<string, ForeignFunction>();
  const types = new Map<string, ForeignPointerType>();
  visit(root, (node) => {
    if (node.kind !== "FunctionDecl" || !node.name || !node.type?.qualType) return;
    const functionNotes = notes.functions?.[node.name];
    const parameters = (node.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
      .map((child, index) => ({
        name: child.name ?? null,
        type: mapForeignType(child.type!.qualType!, functionNotes?.parameters?.[String(index)], "parameter", types, imported.byCName),
      }));
    const cSignature = node.type.qualType;
    functions.set(node.name, {
      name: node.name,
      returnType: mapForeignType(returnTypeOf(cSignature), functionNotes?.return, "return", types, imported.byCName),
      parameters,
      variadic: node.variadic === true,
      cSignature,
    });
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
  return { functions, types, namedTypes: imported.namedTypes, constants: imported.constants };
}

function collectNamedTypes(
  root: ClangNode,
  moduleName: string,
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

  type Seed = {
    kind: "record" | "enum" | "scalar";
    exportName: string;
    typeName: string;
    cName: string;
    declaration?: ClangNode;
    underlying?: ForeignScalarTypeName;
  };
  const seeds = new Map<string, Seed>();
  for (const node of nodes) {
    if (node.kind !== "TypedefDecl" || !node.name || !node.type?.qualType) continue;
    const qualified = node.type.qualType;
    const recordMatch = /^struct (.+)$/.exec(qualified);
    const enumMatch = /^enum (.+)$/.exec(qualified);
    const underlying = mapTypedefType(node.name, node.type.desugaredQualType ?? qualified);
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
      underlying: kind === "scalar" ? underlying as ForeignScalarTypeName : undefined,
    });
  }

  const potential = new Map<string, { typeName: string; kind: Seed["kind"]; underlying?: ForeignScalarTypeName; declaration?: ClangNode }>();
  for (const seed of seeds.values()) potential.set(seed.cName, seed);
  const namedTypes = new Map<string, ForeignNamedType>();
  const byCName = new Map<string, ForeignNamedType>();
  for (const seed of seeds.values()) {
    let named: ForeignNamedType | null = null;
    if (seed.kind === "scalar") {
      named = { kind: "scalar", exportName: seed.exportName, typeName: seed.typeName, cName: seed.cName, underlying: seed.underlying! };
    } else if (seed.kind === "enum") {
      named = { kind: "enum", exportName: seed.exportName, typeName: seed.typeName, cName: seed.cName };
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
