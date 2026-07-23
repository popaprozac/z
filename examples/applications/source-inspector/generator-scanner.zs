import { Generator } from "std/iteration";
import {
  LexerError,
  Token,
  TokenKind,
  tokenize,
} from "../../../compiler/frontend/lexer.zs";

export struct GeneratorScanSummary {
  byteCount: usize;
  lineCount: usize;
  tokenCount: usize;
  identifierCount: usize;
}

export function streamSource(
  source: String
): Generator<Token, GeneratorScanSummary> throws LexerError {
  const tokens = try tokenize(source);

  let lineCount: usize = 0;
  if (!source.isEmpty) lineCount = 1;
  let byteOffset: usize = 0;
  while (byteOffset < source.byteLength) {
    if (source.byteAt(byteOffset) == 10) lineCount = lineCount + 1;
    byteOffset = byteOffset + 1;
  }

  let index: usize = 0;
  let tokenCount: usize = 0;
  let identifierCount: usize = 0;

  while (index < tokens.length) {
    const token = copy tokens[index];
    index = index + 1;

    if (token.kind != TokenKind.eof) tokenCount = tokenCount + 1;
    if (token.kind == TokenKind.identifier) {
      identifierCount = identifierCount + 1;
    }

    yield token;
  }

  return GeneratorScanSummary({
    byteCount: source.byteLength,
    lineCount,
    tokenCount,
    identifierCount,
  });
}
