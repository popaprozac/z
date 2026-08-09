import { TextBuffer } from "std/text";
import {
  ModuleResolveError,
} from "../frontend/semantic-model.zs";

export function sourceDiagnostic(
  in path: String,
  lineNumber: usize,
  columnNumber: usize,
  in message: String,
  in source: String
): String {
  return sourceDiagnosticDetail(
    path,
    lineNumber,
    columnNumber,
    "",
    1,
    message,
    source
  );
}

function sourceDiagnosticDetail(
  in path: String,
  lineNumber: usize,
  columnNumber: usize,
  in code: String,
  requestedLength: usize,
  in message: String,
  in source: String
): String {
  let output = TextBuffer();
  if (code.byteLength > 0) {
    output.append(
      `${path}:${lineNumber}:${columnNumber}: error[${code}]: ${message}`
    );
  } else {
    output.append(
      `${path}:${lineNumber}:${columnNumber}: error: ${message}`
    );
  }
  let line: usize = 1;
  let lineStart: usize = 0;
  while (line < lineNumber && lineStart < source.byteLength) {
    if (source.byteAt(lineStart) == 10) line = line + 1;
    lineStart = lineStart + 1;
  }
  if (line != lineNumber) return output.finish();

  let lineEnd = lineStart;
  while (
    lineEnd < source.byteLength
    && source.byteAt(lineEnd) != 10
    && source.byteAt(lineEnd) != 13
  ) {
    lineEnd = lineEnd + 1;
  }
  output.append(`\n${lineNumber} | `);
  output.append(source.copyBytes(lineStart, lineEnd));
  output.append("\n  | ");
  let column: usize = 1;
  while (column < columnNumber) {
    output.append(" ");
    column = column + 1;
  }
  let length = requestedLength;
  if (length == 0) length = 1;
  let available: usize = 1;
  if (lineEnd > lineStart + columnNumber - 1) {
    available = lineEnd - (lineStart + columnNumber - 1);
  }
  if (length > available) length = available;
  let marker: usize = 0;
  while (marker < length) {
    output.append("^");
    marker = marker + 1;
  }
  if (code.byteLength > 0) output.append(` ${message}`);
  return output.finish();
}

export function diagnosticMessage(
  in error: ModuleResolveError,
  in source: String
): String {
  const path = copy error.path;
  const line = error.line;
  const column = error.column;
  const code = copy error.code;
  const length = error.length;
  const message = copy error.message;
  return sourceDiagnosticDetail(
    path,
    line,
    column,
    code,
    length,
    message,
    source
  );
}
