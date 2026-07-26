import type { Program, RawNativeBody, SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import type { ForeignModule } from "./foreign.ts";

type NativeIdentifier = {
  readonly name: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
};

export function hasRawNativeBodies(program: Program): boolean {
  return collectRawNativeBodies(program).length > 0;
}

export function validateRawNativeGeneratedSymbolAccess(
  program: Program,
  foreignModules: ReadonlyMap<string, ForeignModule>,
  generatedWithoutRawBodies: string,
  fallbackFileName: string,
): void {
  const nativeSymbols = collectForeignNativeSymbols(foreignModules);
  const sourceFunctionNames = new Set(program.functions.map((declaration) => declaration.name));
  const compilerSymbols = new Set(
    scanNativeIdentifiers(generatedWithoutRawBodies)
      .map((identifier) => identifier.name)
      .filter((name) => (
        !nativeSymbols.has(name)
        && (
          sourceFunctionNames.has(name)
          || name.startsWith("Z_")
          || name.startsWith("_z_")
          || name.startsWith("__z_")
          || name.startsWith("z_")
          || name.startsWith("ZObjC")
        )
      )),
  );
  if (compilerSymbols.size === 0) return;

  for (const body of collectRawNativeBodies(program)) {
    for (const identifier of scanNativeIdentifiers(body.source)) {
      if (!compilerSymbols.has(identifier.name)) continue;
      throw new DiagnosticError(
        body.location.fileName ?? fallbackFileName,
        rawIdentifierLocation(body.location, identifier),
        `raw native source cannot reference compiler-owned symbol ${JSON.stringify(identifier.name)}`,
        {
          code: "Z0820",
          length: identifier.name.length,
          notes: ["the name is emitted by this Z compilation and is not a stable foreign ABI"],
          helps: ["cross values through using, or call declarations supplied by an imported native header"],
        },
      );
    }
  }
}

function collectRawNativeBodies(program: Program): RawNativeBody[] {
  const bodies: RawNativeBody[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.source === "string"
      && (record.language === "c" || record.language === "cpp" || record.language === "objc")
      && record.location
    ) {
      bodies.push(record as unknown as RawNativeBody);
      return;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(program);
  return bodies;
}

function collectForeignNativeSymbols(
  foreignModules: ReadonlyMap<string, ForeignModule>,
): ReadonlySet<string> {
  const symbols = new Set<string>();
  const addSpelling = (spelling: string): void => {
    for (const identifier of scanNativeIdentifiers(spelling)) symbols.add(identifier.name);
  };
  for (const module of foreignModules.values()) {
    for (const declaration of module.functions.values()) {
      addSpelling(declaration.name);
      addSpelling(declaration.qualifiedName);
      for (const overload of declaration.overloads) addSpelling(overload.cName);
    }
    for (const constant of module.constants.values()) {
      addSpelling(constant.name);
      addSpelling(constant.cName);
    }
    for (const type of module.namedTypes.values()) {
      addSpelling(type.exportName);
      addSpelling(type.qualifiedName);
      addSpelling(type.cName);
    }
    for (const type of module.objectTypes.values()) addSpelling(type.cName);
    for (const declaration of module.interfaces.values()) {
      addSpelling(declaration.exportName);
      addSpelling(declaration.className);
    }
  }
  return symbols;
}

function rawIdentifierLocation(
  base: SourceLocation,
  identifier: NativeIdentifier,
): SourceLocation {
  return {
    fileName: base.fileName,
    offset: base.offset + identifier.offset,
    line: base.line + identifier.line,
    column: identifier.line === 0
      ? base.column + identifier.column
      : identifier.column + 1,
  };
}

function scanNativeIdentifiers(source: string): NativeIdentifier[] {
  const identifiers: NativeIdentifier[] = [];
  let offset = 0;
  let line = 0;
  let column = 0;
  const peek = (distance = 0): string => source[offset + distance] ?? "\0";
  const advance = (): string => {
    const character = peek();
    offset += 1;
    if (character === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
    return character;
  };

  while (offset < source.length) {
    const current = peek();
    if (current === '"' || current === "'") {
      const quote = advance();
      while (offset < source.length) {
        if (peek() === "\\") {
          advance();
          if (offset < source.length) advance();
          continue;
        }
        if (peek() === quote) {
          advance();
          break;
        }
        advance();
      }
      continue;
    }
    if (current === "/" && peek(1) === "/") {
      while (offset < source.length && peek() !== "\n") advance();
      continue;
    }
    if (current === "/" && peek(1) === "*") {
      advance();
      advance();
      while (offset < source.length && !(peek() === "*" && peek(1) === "/")) advance();
      if (offset < source.length) {
        advance();
        advance();
      }
      continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      const start = offset;
      const startLine = line;
      const startColumn = column;
      let name = "";
      while (/[A-Za-z0-9_]/.test(peek())) name += advance();
      identifiers.push({
        name,
        offset: start,
        line: startLine,
        column: startColumn,
      });
      continue;
    }
    advance();
  }
  return identifiers;
}
