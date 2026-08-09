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
  | "invalidMatch"
  | "unsupportedLowering";

export class NativeFrontendDiagnosticError extends Error {
  readonly kind: NativeFrontendDiagnosticKind;
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly summary: string;
  readonly code: `Z${number}` | null;
  readonly length: number;

  constructor(
    kind: NativeFrontendDiagnosticKind,
    fileName: string,
    line: number,
    column: number,
    summary: string,
    code: `Z${number}` | null = null,
    length = 1,
  ) {
    super(code
      ? `${fileName}:${line}:${column}: error[${code}]: ${summary}`
      : `${fileName}:${line}:${column}: ${summary}`);
    this.name = "NativeFrontendDiagnosticError";
    this.kind = kind;
    this.fileName = fileName;
    this.line = line;
    this.column = column;
    this.summary = summary;
    this.code = code;
    this.length = length;
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
    "unsupportedLowering",
  ].includes(value);
}
