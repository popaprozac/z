import type { SourceLocation } from "./ast.ts";

export type DiagnosticLabel = {
  readonly location: SourceLocation;
  readonly message: string;
  readonly length?: number;
};

export type DiagnosticDetails = {
  readonly code?: `Z${number}`;
  readonly length?: number;
  readonly labels?: readonly DiagnosticLabel[];
  readonly notes?: readonly string[];
  readonly helps?: readonly string[];
};

export class DiagnosticError extends Error {
  readonly fileName: string;
  readonly location: SourceLocation;
  readonly summary: string;
  readonly code: `Z${number}` | null;
  readonly length: number;
  readonly labels: readonly DiagnosticLabel[];
  readonly notes: readonly string[];
  readonly helps: readonly string[];

  constructor(fileName: string, location: SourceLocation, message: string, details: DiagnosticDetails = {}) {
    const resolvedFileName = location.fileName ?? fileName;
    super(`${resolvedFileName}:${location.line}:${location.column}: error: ${message}`);
    this.name = "DiagnosticError";
    this.fileName = resolvedFileName;
    this.location = location;
    this.summary = message;
    this.code = details.code ?? null;
    this.length = details.length ?? 1;
    this.labels = details.labels ?? [];
    this.notes = details.notes ?? [];
    this.helps = details.helps ?? [];
  }
}

export function formatDiagnostic(error: DiagnosticError, source?: string): string {
  const code = error.code ? `[${error.code}]` : "";
  const lines = [`${error.fileName}:${error.location.line}:${error.location.column}: error${code}: ${error.summary}`];
  if (source) lines.push(...formatSourceLabel(source, error.location, error.length, error.summary));
  for (const label of error.labels) {
    lines.push(`  ::: ${error.fileName}:${label.location.line}:${label.location.column}`);
    if (source) lines.push(...formatSourceLabel(source, label.location, label.length ?? 1, label.message));
    else lines.push(`  = ${label.message}`);
  }
  for (const note of error.notes) lines.push(`  note: ${note}`);
  for (const help of error.helps) lines.push(`  help: ${help}`);
  return lines.join("\n");
}

function formatSourceLabel(
  source: string,
  location: SourceLocation,
  requestedLength: number,
  message: string,
): string[] {
  const text = source.split(/\r?\n/)[location.line - 1];
  if (text === undefined) return [];
  const lineNumber = String(location.line);
  const gutter = " ".repeat(lineNumber.length);
  const column = Math.max(0, Math.min(location.column - 1, text.length));
  const length = Math.max(1, Math.min(requestedLength, Math.max(1, text.length - column)));
  return [
    `${gutter} |`,
    `${lineNumber} | ${text}`,
    `${gutter} | ${" ".repeat(column)}${"^".repeat(length)} ${message}`,
  ];
}
