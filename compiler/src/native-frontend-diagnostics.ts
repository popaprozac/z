export type NativeFrontendDiagnosticKind =
  | "lexer"
  | "parser"
  | "missingModule"
  | "circularImport"
  | "missingExport"
  | "duplicateBinding"
  | "unknownName"
  | "unknownType"
  | "unknownMember"
  | "typeMismatch"
  | "invalidOperator"
  | "invalidMatch";

export class NativeFrontendDiagnosticError extends Error {
  readonly kind: NativeFrontendDiagnosticKind;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly summary: string;

  constructor(kind: NativeFrontendDiagnosticKind, fileName: string, line: number, column: number, summary: string) {
    super(`${fileName}:${line}:${column}: ${summary}`);
    this.name = "NativeFrontendDiagnosticError";
    this.kind = kind;
    this.fileName = fileName;
    this.line = line;
    this.column = column;
    this.summary = summary;
  }
}

export function isNativeFrontendDiagnosticKind(value: string): value is NativeFrontendDiagnosticKind {
  return [
    "lexer",
    "parser",
    "missingModule",
    "circularImport",
    "missingExport",
    "duplicateBinding",
    "unknownName",
    "unknownType",
    "unknownMember",
    "typeMismatch",
    "invalidOperator",
    "invalidMatch",
  ].includes(value);
}
