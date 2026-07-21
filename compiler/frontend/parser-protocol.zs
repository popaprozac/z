// Shared stage-one parser framing used by executable and in-process clients.

import { TextBuffer } from "std/text";
import { tokenize } from "./lexer.zs";
import {
  aggregateShapeText,
  declarationKindName,
  enumShapeText,
  functionBodyText,
  functionSignatureText,
  importShapeText,
  parseProgram,
  traitShapeText,
} from "./parser.zs";

function hexDigit(value: u8): u8 {
  return value < 10 ? value + 48 : value + 87;
}

function appendHexDigit(inout output: TextBuffer, value: usize): void {
  if (value == 0) output.appendAscii(48);
  else if (value == 1) output.appendAscii(49);
  else if (value == 2) output.appendAscii(50);
  else if (value == 3) output.appendAscii(51);
  else if (value == 4) output.appendAscii(52);
  else if (value == 5) output.appendAscii(53);
  else if (value == 6) output.appendAscii(54);
  else if (value == 7) output.appendAscii(55);
  else if (value == 8) output.appendAscii(56);
  else if (value == 9) output.appendAscii(57);
  else if (value == 10) output.appendAscii(97);
  else if (value == 11) output.appendAscii(98);
  else if (value == 12) output.appendAscii(99);
  else if (value == 13) output.appendAscii(100);
  else if (value == 14) output.appendAscii(101);
  else output.appendAscii(102);
}

function appendHexUsize(inout output: TextBuffer, value: usize): void {
  let shift: usize = 60;
  while (true) {
    appendHexDigit(inout output, (value >> shift) & 15);
    if (shift == 0) break;
    shift = shift - 4;
  }
}

function appendHexText(inout output: TextBuffer, in text: String): void {
  let offset: usize = 0;
  while (offset < text.byteLength) {
    const byte = text.byteAt(offset);
    output.appendAscii(hexDigit(byte >> 4));
    output.appendAscii(hexDigit(byte & 15));
    offset = offset + 1;
  }
}

function appendShape(
  inout output: TextBuffer,
  in kind: String,
  offset: usize,
  line: usize,
  column: usize,
  in shape: String
): void {
  output.append("shape");
  output.appendAscii(9);
  output.append(kind);
  output.appendAscii(9);
  appendHexUsize(inout output, offset);
  output.appendAscii(9);
  appendHexUsize(inout output, line);
  output.appendAscii(9);
  appendHexUsize(inout output, column);
  output.appendAscii(9);
  appendHexText(inout output, shape);
  output.appendAscii(10);
}

function appendImportShape(
  inout output: TextBuffer,
  offset: usize,
  line: usize,
  column: usize,
  in shape: String
): void {
  output.append("importShape");
  output.appendAscii(9);
  appendHexUsize(inout output, offset);
  output.appendAscii(9);
  appendHexUsize(inout output, line);
  output.appendAscii(9);
  appendHexUsize(inout output, column);
  output.appendAscii(9);
  appendHexText(inout output, shape);
  output.appendAscii(10);
}

export function renderProgram(in path: String, in source: String): String throws String {
  const tokenOutcome = attempt tokenize(source);
  const tokens = match (tokenOutcome) {
    success(tokens) => tokens;
    failure(error) => throw `lexer error at ${error.line}:${error.column}: ${error.message}`;
  };
  const parseOutcome = attempt parseProgram(tokens);
  const program = match (parseOutcome) {
    success(program) => program;
    failure(error) => throw `parser error at ${error.line}:${error.column}: ${error.message}`;
  };

  let output = TextBuffer();
  output.append("file");
  output.appendAscii(9);
  appendHexText(inout output, path);
  output.appendAscii(10);
  for (const declaration of program.declarations) {
    output.append(declarationKindName(declaration.kind));
    output.appendAscii(9);
    if (declaration.exported) output.appendAscii(49);
    else output.appendAscii(48);
    output.appendAscii(9);
    if (declaration.asynchronous) output.appendAscii(49);
    else output.appendAscii(48);
    output.appendAscii(9);
    appendHexUsize(inout output, declaration.offset);
    output.appendAscii(9);
    appendHexUsize(inout output, declaration.line);
    output.appendAscii(9);
    appendHexUsize(inout output, declaration.column);
    output.appendAscii(9);
    appendHexText(inout output, declaration.name);
    output.appendAscii(10);
  }
  for (const importDeclaration of program.imports) {
    const shape = importShapeText(importDeclaration);
    appendImportShape(
      inout output,
      importDeclaration.offset,
      importDeclaration.line,
      importDeclaration.column,
      shape
    );
  }
  for (const functionDeclaration of program.functions) {
    const signature = functionSignatureText(functionDeclaration);
    output.append("signature");
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.offset);
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.line);
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.column);
    output.appendAscii(9);
    appendHexText(inout output, signature);
    output.appendAscii(10);
    const body = functionBodyText(functionDeclaration);
    output.append("body");
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.offset);
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.line);
    output.appendAscii(9);
    appendHexUsize(inout output, functionDeclaration.column);
    output.appendAscii(9);
    appendHexText(inout output, body);
    output.appendAscii(10);
  }
  for (const aggregate of program.aggregates) {
    const shape = aggregateShapeText(aggregate);
    const kind = declarationKindName(aggregate.kind);
    appendShape(
      inout output,
      kind,
      aggregate.offset,
      aggregate.line,
      aggregate.column,
      shape
    );
  }
  for (const traitDeclaration of program.traits) {
    const shape = traitShapeText(traitDeclaration);
    appendShape(inout output, "trait", traitDeclaration.offset, traitDeclaration.line, traitDeclaration.column, shape);
  }
  for (const enumDeclaration of program.enums) {
    const shape = enumShapeText(enumDeclaration);
    appendShape(inout output, "enum", enumDeclaration.offset, enumDeclaration.line, enumDeclaration.column, shape);
  }
  return output.finish();
}
