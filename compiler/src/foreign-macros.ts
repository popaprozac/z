import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ImportDeclaration } from "./ast.ts";
import type {
  ForeignConstant,
  ForeignScalarTypeName,
  ForeignSourceLocation,
} from "./foreign-ir.ts";

export function collectIntegerMacroConstants(
  declaration: ImportDeclaration,
  clangBaseArguments: readonly string[],
  headerDirectory: string,
  objectiveC: boolean,
  longWidth: number,
): ReadonlyMap<string, ForeignConstant> {
  const arguments_ = [
    ...clangBaseArguments,
    "-include", declaration.header,
    "-E",
    "-dD",
    "/dev/null",
  ];
  const result = spawnSync(
    objectiveC ? "xcrun" : "clang",
    objectiveC ? ["clang", ...arguments_] : arguments_,
    {
      encoding: "utf8",
      maxBuffer: objectiveC ? 256 * 1024 * 1024 : 64 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) return new Map();

  const localHeader = resolve(headerDirectory, declaration.header);
  const expectedFile = existsSync(localHeader) ? localHeader : null;
  const expectedBasename = basename(declaration.header);
  let primaryFile: string | null = null;
  let primarySource: readonly string[] | null = null;
  let currentFile: string | null = null;
  let currentLine = 1;
  const constants = new Map<string, ForeignConstant>();

  for (const line of result.stdout.split("\n")) {
    const marker = /^#\s+([0-9]+)\s+"([^"]+)"/.exec(line);
    if (marker) {
      currentLine = Number(marker[1]);
      const rawFile = marker[2];
      currentFile = rawFile.startsWith("<") ? null : resolve(rawFile);
      if (
        !primaryFile
        && currentFile
        && currentFile !== "/dev/null"
        && (
          (expectedFile !== null && currentFile === expectedFile)
          || basename(currentFile) === expectedBasename
        )
      ) {
        primaryFile = currentFile;
        primarySource = existsSync(primaryFile)
          ? readFileSync(primaryFile, "utf8").split(/\r?\n/)
          : null;
      }
      continue;
    }

    if (primaryFile && currentFile === primaryFile) {
      const definition = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (definition) {
        const name = definition[1];
        const remainder = line.slice(definition[0].length);
        if (!remainder.startsWith("(")) {
          const typeName = integerMacroLiteralType(remainder.trim(), longWidth);
          if (typeName) {
            constants.set(name, {
              name,
              cName: name,
              typeName,
              sourceKind: "macro",
              metadata: {
                source: macroSourceLocation(primaryFile, primarySource, currentLine, name),
                availability: [],
              },
            });
          }
        }
      }
    }
    currentLine += 1;
  }
  return constants;
}

function integerMacroLiteralType(
  expression: string,
  longWidth: number,
): ForeignScalarTypeName | null {
  let normalized = expression.trim();
  while (
    normalized.startsWith("(")
    && normalized.endsWith(")")
    && outerParenthesesEncloseExpression(normalized)
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.startsWith("+") || normalized.startsWith("-")) {
    normalized = normalized.slice(1).trim();
  }
  const match = /^(0[xX][0-9A-Fa-f]+|0[0-7]*|(?:0|[1-9][0-9]*))([uUlL]*)$/.exec(normalized);
  if (!match) return null;

  const suffix = match[2].toLowerCase();
  if (!["", "u", "l", "ul", "lu", "ll", "ull", "llu"].includes(suffix)) return null;
  const literal = match[1];
  const decimal = !/^0[xX]/.test(literal) && !(literal.length > 1 && literal.startsWith("0"));
  const value = /^0[xX]/.test(literal)
    ? BigInt(literal)
    : literal.length > 1 && literal.startsWith("0")
      ? BigInt(`0o${literal.slice(1)}`)
      : BigInt(literal);
  const longSigned = longWidth === 8 ? "i64" as const : "i32" as const;
  const longUnsigned = longWidth === 8 ? "u64" as const : "u32" as const;
  const candidates: readonly ForeignScalarTypeName[] = suffix === ""
    ? decimal
      ? ["i32", longSigned, "i64"]
      : ["i32", "u32", longSigned, longUnsigned, "i64", "u64"]
    : suffix === "u"
      ? ["u32", longUnsigned, "u64"]
      : suffix === "l"
        ? decimal ? [longSigned, "i64"] : [longSigned, longUnsigned, "i64", "u64"]
        : suffix === "ul" || suffix === "lu"
          ? [longUnsigned, "u64"]
          : suffix === "ll"
            ? decimal ? ["i64"] : ["i64", "u64"]
            : ["u64"];
  return candidates.find((candidate) => integerTypeContains(candidate, value)) ?? null;
}

function outerParenthesesEncloseExpression(expression: string): boolean {
  let depth = 0;
  for (let index = 0; index < expression.length; index += 1) {
    if (expression[index] === "(") depth += 1;
    else if (expression[index] === ")") {
      depth -= 1;
      if (depth === 0 && index !== expression.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function integerTypeContains(type: ForeignScalarTypeName, value: bigint): boolean {
  const width = Number(/\d+/.exec(type)?.[0] ?? 0);
  if (width === 0) return false;
  const unsigned = type.startsWith("u");
  const maximum = unsigned
    ? (1n << BigInt(width)) - 1n
    : (1n << BigInt(width - 1)) - 1n;
  return value <= maximum;
}

function macroSourceLocation(
  fileName: string,
  source: readonly string[] | null,
  suggestedLine: number,
  name: string,
): ForeignSourceLocation {
  let line = suggestedLine;
  let sourceLine = source?.[line - 1] ?? "";
  if (!sourceLine.includes(name) && source) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const definition = new RegExp(`^\\s*#\\s*define\\s+${escaped}\\b`);
    const index = source.findIndex((candidate) => definition.test(candidate));
    if (index >= 0) {
      line = index + 1;
      sourceLine = source[index];
    }
  }
  const offset = sourceLine.indexOf(name);
  return {
    fileName,
    line,
    column: offset >= 0 ? offset + 1 : 1,
    length: name.length,
  };
}
