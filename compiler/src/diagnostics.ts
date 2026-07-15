import type { SourceLocation } from "./ast.ts";

export class DiagnosticError extends Error {
  readonly fileName: string;
  readonly location: SourceLocation;

  constructor(fileName: string, location: SourceLocation, message: string) {
    super(`${fileName}:${location.line}:${location.column}: error: ${message}`);
    this.name = "DiagnosticError";
    this.fileName = fileName;
    this.location = location;
  }
}

