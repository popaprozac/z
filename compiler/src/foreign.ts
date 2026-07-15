import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type ForeignType =
  | { readonly kind: "z"; readonly name: "i32" | "bool" | "cstring" | "void"; readonly cName: string }
  | ForeignPointerType
  | { readonly kind: "unsupported"; readonly cName: string };

export type ForeignPointerType = {
  readonly kind: "pointer";
  readonly typeName: string;
  readonly cName: string;
  readonly identity: string;
  readonly ownership: "owned" | "borrowed" | "consuming";
  readonly nullable: boolean;
  readonly release: string | null;
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
};

type HeaderInfo = {
  readonly functions: ReadonlyMap<string, ForeignFunction>;
  readonly types: ReadonlyMap<string, ForeignPointerType>;
};

type PointerNote = {
  readonly ownership?: "owned" | "borrowed" | "consuming";
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
  readonly kind?: string;
  readonly name?: string;
  readonly type?: { readonly qualType?: string };
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
    const cacheKey = `${includeDirectory}\0${declaration.header}`;
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
  const functions = new Map<string, ForeignFunction>();
  const types = new Map<string, ForeignPointerType>();
  visit(root, (node) => {
    if (node.kind !== "FunctionDecl" || !node.name || !node.type?.qualType) return;
    const functionNotes = notes.functions?.[node.name];
    const parameters = (node.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
      .map((child, index) => ({
        name: child.name ?? null,
        type: mapForeignType(child.type!.qualType!, functionNotes?.parameters?.[String(index)], "parameter", types),
      }));
    const cSignature = node.type.qualType;
    functions.set(node.name, {
      name: node.name,
      returnType: mapForeignType(returnTypeOf(cSignature), functionNotes?.return, "return", types),
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
  return { functions, types };
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
): ForeignType {
  const normalized = normalizeCType(cName);
  if (normalized === "void") return { kind: "z", name: "void", cName };
  if (normalized === "int" || normalized === "signed int") return { kind: "z", name: "i32", cName };
  if (normalized === "_Bool" || normalized === "bool") return { kind: "z", name: "bool", cName };
  if (normalized === "const char *") {
    return { kind: "z", name: "cstring", cName };
  }
  const stars = normalized.match(/\*/g)?.length ?? 0;
  if (stars === 1 && normalized.endsWith(" *")) {
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
