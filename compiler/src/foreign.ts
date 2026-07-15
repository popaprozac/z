import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { ImportDeclaration } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type ForeignType =
  | { readonly kind: "z"; readonly name: "i32" | "bool" | "cstring" | "void"; readonly cName: string }
  | { readonly kind: "unsupported"; readonly cName: string };

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
};

type ClangNode = {
  readonly kind?: string;
  readonly name?: string;
  readonly type?: { readonly qualType?: string };
  readonly variadic?: boolean;
  readonly inner?: readonly ClangNode[];
};

const headerCache = new Map<string, ReadonlyMap<string, ForeignFunction>>();

export function resolveForeignModules(
  declarations: readonly ImportDeclaration[],
  fileName: string,
): ReadonlyMap<string, ForeignModule> {
  const modules = new Map<string, ForeignModule>();
  for (const declaration of declarations) {
    const includeDirectory = resolve(dirname(fileName));
    const cacheKey = `${includeDirectory}\0${declaration.header}`;
    let functions = headerCache.get(cacheKey);
    if (!functions) {
      functions = readHeader(declaration, fileName, includeDirectory);
      headerCache.set(cacheKey, functions);
    }
    modules.set(declaration.moduleName, { declaration, functions });
  }
  return modules;
}

function readHeader(
  declaration: ImportDeclaration,
  fileName: string,
  includeDirectory: string,
): ReadonlyMap<string, ForeignFunction> {
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

  const functions = new Map<string, ForeignFunction>();
  visit(root, (node) => {
    if (node.kind !== "FunctionDecl" || !node.name || !node.type?.qualType) return;
    const parameters = (node.inner ?? [])
      .filter((child) => child.kind === "ParmVarDecl" && child.type?.qualType)
      .map((child) => ({
        name: child.name ?? null,
        type: mapForeignType(child.type!.qualType!),
      }));
    const cSignature = node.type.qualType;
    functions.set(node.name, {
      name: node.name,
      returnType: mapForeignType(returnTypeOf(cSignature)),
      parameters,
      variadic: node.variadic === true,
      cSignature,
    });
  });
  return functions;
}

function visit(node: ClangNode, callback: (node: ClangNode) => void): void {
  callback(node);
  for (const child of node.inner ?? []) visit(child, callback);
}

function returnTypeOf(signature: string): string {
  const parameterList = signature.indexOf("(");
  return (parameterList === -1 ? signature : signature.slice(0, parameterList)).trim();
}

function mapForeignType(cName: string): ForeignType {
  const normalized = cName
    .replace(/\b(restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*/g, " *")
    .trim();
  if (normalized === "void") return { kind: "z", name: "void", cName };
  if (normalized === "int" || normalized === "signed int") return { kind: "z", name: "i32", cName };
  if (normalized === "_Bool" || normalized === "bool") return { kind: "z", name: "bool", cName };
  if (normalized === "const char *") {
    return { kind: "z", name: "cstring", cName };
  }
  return { kind: "unsupported", cName };
}
