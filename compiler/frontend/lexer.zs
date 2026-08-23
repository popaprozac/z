import { TextBuffer } from "std/text";

export enum TokenKind {
  identifier,
  number,
  string,
  rawBody,
  templateStart,
  templateText,
  templateExpressionStart,
  templateExpressionEnd,
  templateEnd,
  importKeyword,
  exportKeyword,
  fromKeyword,
  asKeyword,
  functionKeyword,
  asyncKeyword,
  awaitKeyword,
  onKeyword,
  scopeKeyword,
  structKeyword,
  classKeyword,
  traitKeyword,
  implementsKeyword,
  instanceofKeyword,
  enumKeyword,
  deinitKeyword,
  matchKeyword,
  ifKeyword,
  elseKeyword,
  whileKeyword,
  forKeyword,
  ofKeyword,
  breakKeyword,
  continueKeyword,
  trueKeyword,
  falseKeyword,
  nullKeyword,
  newKeyword,
  constructorKeyword,
  publicKeyword,
  privateKeyword,
  readonlyKeyword,
  staticKeyword,
  constKeyword,
  letKeyword,
  returnKeyword,
  throwsKeyword,
  throwKeyword,
  selectKeyword,
  yieldKeyword,
  attemptKeyword,
  tryKeyword,
  unsafeKeyword,
  weakKeyword,
  inKeyword,
  outKeyword,
  inoutKeyword,
  leftParen,
  rightParen,
  leftBrace,
  rightBrace,
  leftBracket,
  rightBracket,
  colon,
  question,
  comma,
  semicolon,
  dot,
  ellipsis,
  equal,
  equalEqual,
  bang,
  bangEqual,
  less,
  lessEqual,
  greater,
  greaterEqual,
  andAnd,
  orOr,
  bitAnd,
  bitOr,
  bitXor,
  shiftLeft,
  shiftRight,
  tilde,
  fatArrow,
  plus,
  minus,
  star,
  slash,
  percent,
  eof,
}

export struct Token {
  kind: TokenKind;
  text: String;
  offset: usize;
  line: usize;
  column: usize;
}

export struct LexerError {
  message: String;
  offset: usize;
  line: usize;
  column: usize;
}

enum RawHeaderState {
  none,
  language,
  bodyOrUsing,
  boundary,
}

function isIdentifierStart(byte: u8): boolean {
  return (byte >= 65 && byte <= 90)
    || (byte >= 97 && byte <= 122)
    || byte == 95;
}

function isIdentifierContinue(byte: u8): boolean {
  return isIdentifierStart(byte) || (byte >= 48 && byte <= 57);
}

function isDigit(byte: u8): boolean {
  return byte >= 48 && byte <= 57;
}

function isWhitespace(byte: u8): boolean {
  return byte == 9 || byte == 10 || byte == 11 || byte == 12 || byte == 13 || byte == 32;
}

function keywordKind(in text: String): Option<TokenKind> {
  if (text == "import") return Option.some(TokenKind.importKeyword);
  if (text == "export") return Option.some(TokenKind.exportKeyword);
  if (text == "from") return Option.some(TokenKind.fromKeyword);
  if (text == "as") return Option.some(TokenKind.asKeyword);
  if (text == "function") return Option.some(TokenKind.functionKeyword);
  if (text == "async") return Option.some(TokenKind.asyncKeyword);
  if (text == "await") return Option.some(TokenKind.awaitKeyword);
  if (text == "on") return Option.some(TokenKind.onKeyword);
  if (text == "scope") return Option.some(TokenKind.scopeKeyword);
  if (text == "struct") return Option.some(TokenKind.structKeyword);
  if (text == "class") return Option.some(TokenKind.classKeyword);
  if (text == "trait") return Option.some(TokenKind.traitKeyword);
  if (text == "implements") return Option.some(TokenKind.implementsKeyword);
  if (text == "instanceof") return Option.some(TokenKind.instanceofKeyword);
  if (text == "enum") return Option.some(TokenKind.enumKeyword);
  if (text == "deinit") return Option.some(TokenKind.deinitKeyword);
  if (text == "match") return Option.some(TokenKind.matchKeyword);
  if (text == "if") return Option.some(TokenKind.ifKeyword);
  if (text == "else") return Option.some(TokenKind.elseKeyword);
  if (text == "while") return Option.some(TokenKind.whileKeyword);
  if (text == "for") return Option.some(TokenKind.forKeyword);
  if (text == "of") return Option.some(TokenKind.ofKeyword);
  if (text == "break") return Option.some(TokenKind.breakKeyword);
  if (text == "continue") return Option.some(TokenKind.continueKeyword);
  if (text == "true") return Option.some(TokenKind.trueKeyword);
  if (text == "false") return Option.some(TokenKind.falseKeyword);
  if (text == "null") return Option.some(TokenKind.nullKeyword);
  if (text == "new") return Option.some(TokenKind.newKeyword);
  if (text == "constructor") return Option.some(TokenKind.constructorKeyword);
  if (text == "public") return Option.some(TokenKind.publicKeyword);
  if (text == "private") return Option.some(TokenKind.privateKeyword);
  if (text == "readonly") return Option.some(TokenKind.readonlyKeyword);
  if (text == "static") return Option.some(TokenKind.staticKeyword);
  if (text == "const") return Option.some(TokenKind.constKeyword);
  if (text == "let") return Option.some(TokenKind.letKeyword);
  if (text == "return") return Option.some(TokenKind.returnKeyword);
  if (text == "throws") return Option.some(TokenKind.throwsKeyword);
  if (text == "throw") return Option.some(TokenKind.throwKeyword);
  if (text == "select") return Option.some(TokenKind.selectKeyword);
  if (text == "yield") return Option.some(TokenKind.yieldKeyword);
  if (text == "attempt") return Option.some(TokenKind.attemptKeyword);
  if (text == "try") return Option.some(TokenKind.tryKeyword);
  if (text == "unsafe") return Option.some(TokenKind.unsafeKeyword);
  if (text == "weak") return Option.some(TokenKind.weakKeyword);
  if (text == "in") return Option.some(TokenKind.inKeyword);
  if (text == "out") return Option.some(TokenKind.outKeyword);
  if (text == "inout") return Option.some(TokenKind.inoutKeyword);
  return Option.none;
}

function pairedSymbolKind(first: u8, second: u8): Option<TokenKind> {
  if (first == 61 && second == 62) return Option.some(TokenKind.fatArrow);
  if (first == 61 && second == 61) return Option.some(TokenKind.equalEqual);
  if (first == 33 && second == 61) return Option.some(TokenKind.bangEqual);
  if (first == 60 && second == 61) return Option.some(TokenKind.lessEqual);
  if (first == 62 && second == 61) return Option.some(TokenKind.greaterEqual);
  if (first == 38 && second == 38) return Option.some(TokenKind.andAnd);
  if (first == 124 && second == 124) return Option.some(TokenKind.orOr);
  if (first == 60 && second == 60) return Option.some(TokenKind.shiftLeft);
  if (first == 62 && second == 62) return Option.some(TokenKind.shiftRight);
  return Option.none;
}

function singleSymbolKind(byte: u8): Option<TokenKind> {
  if (byte == 40) return Option.some(TokenKind.leftParen);
  if (byte == 41) return Option.some(TokenKind.rightParen);
  if (byte == 123) return Option.some(TokenKind.leftBrace);
  if (byte == 125) return Option.some(TokenKind.rightBrace);
  if (byte == 91) return Option.some(TokenKind.leftBracket);
  if (byte == 93) return Option.some(TokenKind.rightBracket);
  if (byte == 58) return Option.some(TokenKind.colon);
  if (byte == 63) return Option.some(TokenKind.question);
  if (byte == 44) return Option.some(TokenKind.comma);
  if (byte == 59) return Option.some(TokenKind.semicolon);
  if (byte == 46) return Option.some(TokenKind.dot);
  if (byte == 61) return Option.some(TokenKind.equal);
  if (byte == 33) return Option.some(TokenKind.bang);
  if (byte == 60) return Option.some(TokenKind.less);
  if (byte == 62) return Option.some(TokenKind.greater);
  if (byte == 43) return Option.some(TokenKind.plus);
  if (byte == 45) return Option.some(TokenKind.minus);
  if (byte == 42) return Option.some(TokenKind.star);
  if (byte == 47) return Option.some(TokenKind.slash);
  if (byte == 37) return Option.some(TokenKind.percent);
  if (byte == 38) return Option.some(TokenKind.bitAnd);
  if (byte == 124) return Option.some(TokenKind.bitOr);
  if (byte == 94) return Option.some(TokenKind.bitXor);
  if (byte == 126) return Option.some(TokenKind.tilde);
  return Option.none;
}

function pushToken(
  inout tokens: Array<Token>,
  kind: TokenKind,
  text: String,
  offset: usize,
  line: usize,
  column: usize
): void {
  tokens.push(Token({ kind, text, offset, line, column }));
}

function advanceSource(
  in source: String,
  inout offset: usize,
  inout byteSurplus: usize,
  inout line: usize,
  inout column: usize
): void {
  // Native slices use `offset` bytes. Public locations subtract the accumulated
  // UTF-8-byte/UTF-16-unit difference stored in `byteSurplus`.
  const byte = source.byteAt(offset);
  if (byte == 10) {
    offset = offset + 1;
    line = line + 1;
    column = 1;
    return;
  }
  let byteWidth: usize = 1;
  let utf16Width: usize = 1;
  if (byte >= 240) {
    byteWidth = 4;
    utf16Width = 2;
  } else if (byte >= 224) byteWidth = 3;
  else if (byte >= 192) byteWidth = 2;
  offset = offset + byteWidth;
  byteSurplus = byteSurplus + byteWidth - utf16Width;
  column = column + utf16Width;
}

function skipBlockComment(
  in source: String,
  baseOffset: usize,
  inout offset: usize,
  inout byteSurplus: usize,
  inout line: usize,
  inout column: usize
): void throws LexerError {
  const commentOffset = offset - byteSurplus;
  const commentLine = line;
  const commentColumn = column;
  offset = offset + 2;
  column = column + 2;
  while (offset < source.byteLength) {
    if (
      source.byteAt(offset) == 42
      && offset + 1 < source.byteLength
      && source.byteAt(offset + 1) == 47
    ) {
      offset = offset + 2;
      column = column + 2;
      return;
    }
    advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
  }
  throw LexerError({
    message: "unterminated block comment",
    offset: baseOffset + commentOffset,
    line: commentLine,
    column: commentColumn,
  });
}

function tokenizeInto(
  inout tokens: Array<Token>,
  in source: String,
  baseOffset: usize,
  baseLine: usize,
  baseColumn: usize,
  emitEof: boolean
): void throws LexerError {
  let offset: usize = 0;
  let byteSurplus: usize = 0;
  let line = baseLine;
  let column = baseColumn;
  let rawHeaderState = RawHeaderState.none;

  while (offset < source.byteLength) {
    const byte = source.byteAt(offset);

    if (isWhitespace(byte)) {
      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      continue;
    }

    const tokenOffset = offset;
    const tokenCoordinateOffset = offset - byteSurplus;
    const tokenLine = line;
    const tokenColumn = column;

    if (byte == 47 && offset + 1 < source.byteLength && source.byteAt(offset + 1) == 47) {
      offset = offset + 2;
      column = column + 2;
      while (offset < source.byteLength && source.byteAt(offset) != 10) {
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      }
      continue;
    }

    if (byte == 47 && offset + 1 < source.byteLength && source.byteAt(offset + 1) == 42) {
      try skipBlockComment(source, baseOffset, inout offset, inout byteSurplus, inout line, inout column);
      continue;
    }

    if (byte == 96) {
      pushToken(inout tokens, TokenKind.templateStart, "`", baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
      offset = offset + 1;
      column = column + 1;
      let textCoordinateOffset = offset - byteSurplus;
      let textLine = line;
      let textColumn = column;
      let chunkStart = offset;
      let decoded = TextBuffer();

      while (offset < source.byteLength && source.byteAt(offset) != 96) {
        const templateByte = source.byteAt(offset);
        if (templateByte == 92) {
          const escapeCoordinateOffset = offset - byteSurplus;
          const escapeLine = line;
          const escapeColumn = column;
          decoded.appendBytes(source, chunkStart, offset);
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
          if (offset >= source.byteLength) {
            throw LexerError({ message: "unterminated template escape", offset: baseOffset + escapeCoordinateOffset, line: escapeLine, column: escapeColumn });
          }
          const escaped = source.byteAt(offset);
          if (escaped == 110) decoded.appendAscii(10);
          else if (escaped == 114) decoded.appendAscii(13);
          else if (escaped == 116) decoded.appendAscii(9);
          else if (escaped == 92 || escaped == 96 || escaped == 36) decoded.appendAscii(escaped);
          else {
            throw LexerError({ message: "unknown template escape", offset: baseOffset + escapeCoordinateOffset, line: escapeLine, column: escapeColumn });
          }
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
          chunkStart = offset;
          continue;
        }

        if (templateByte == 36 && offset + 1 < source.byteLength && source.byteAt(offset + 1) == 123) {
          decoded.appendBytes(source, chunkStart, offset);
          const text = decoded.finish();
          if (!text.isEmpty) {
            pushToken(inout tokens, TokenKind.templateText, text, baseOffset + textCoordinateOffset, textLine, textColumn);
          }
          pushToken(inout tokens, TokenKind.templateExpressionStart, "${", baseOffset + offset - byteSurplus, line, column);
          offset = offset + 2;
          column = column + 2;
          const expressionOffset = offset;
          const expressionCoordinateOffset = offset - byteSurplus;
          const expressionLine = line;
          const expressionColumn = column;
          let depth: usize = 0;
          let quote: u8 = 0;

          while (offset < source.byteLength) {
            const expressionByte = source.byteAt(offset);
            if (quote != 0) {
              if (expressionByte == 92) {
                advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                if (offset < source.byteLength) {
                  advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                }
                continue;
              }
              if (expressionByte == quote) quote = 0;
              advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              continue;
            }
            if (expressionByte == 34 || expressionByte == 39 || expressionByte == 96) {
              quote = expressionByte;
              advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              continue;
            }
            if (expressionByte == 47 && offset + 1 < source.byteLength && source.byteAt(offset + 1) == 47) {
              while (offset < source.byteLength && source.byteAt(offset) != 10) {
                advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              }
              continue;
            }
            if (expressionByte == 47 && offset + 1 < source.byteLength && source.byteAt(offset + 1) == 42) {
              try skipBlockComment(source, baseOffset, inout offset, inout byteSurplus, inout line, inout column);
              continue;
            }
            if (expressionByte == 123) {
              depth = depth + 1;
              offset = offset + 1;
              column = column + 1;
              continue;
            }
            if (expressionByte == 125) {
              if (depth == 0) break;
              depth = depth - 1;
              offset = offset + 1;
              column = column + 1;
              continue;
            }
            advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
          }

          if (offset >= source.byteLength) {
            throw LexerError({ message: "unterminated template interpolation", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
          }
          const expressionSource = source.copyBytes(expressionOffset, offset);
          try tokenizeInto(inout tokens, expressionSource, baseOffset + expressionCoordinateOffset, expressionLine, expressionColumn, false);
          pushToken(inout tokens, TokenKind.templateExpressionEnd, "}", baseOffset + offset - byteSurplus, line, column);
          offset = offset + 1;
          column = column + 1;
          textCoordinateOffset = offset - byteSurplus;
          textLine = line;
          textColumn = column;
          chunkStart = offset;
          decoded = TextBuffer();
          continue;
        }

        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      }

      if (offset >= source.byteLength) {
        throw LexerError({ message: "unterminated template literal", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
      }
      decoded.appendBytes(source, chunkStart, offset);
      const text = decoded.finish();
      if (!text.isEmpty) {
        pushToken(inout tokens, TokenKind.templateText, text, baseOffset + textCoordinateOffset, textLine, textColumn);
      }
      pushToken(inout tokens, TokenKind.templateEnd, "`", baseOffset + offset - byteSurplus, line, column);
      offset = offset + 1;
      column = column + 1;
      continue;
    }

    if (isIdentifierStart(byte)) {
      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      while (offset < source.byteLength && isIdentifierContinue(source.byteAt(offset))) {
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      }
      const text = source.copyBytes(tokenOffset, offset);
      const keyword = keywordKind(text);
      if (rawHeaderState == RawHeaderState.none && text == "raw") {
        rawHeaderState = RawHeaderState.language;
      } else if (rawHeaderState == RawHeaderState.language) {
        if (text == "c" || text == "cpp" || text == "objc") {
          rawHeaderState = RawHeaderState.bodyOrUsing;
        } else {
          rawHeaderState = RawHeaderState.none;
        }
      } else if (rawHeaderState == RawHeaderState.bodyOrUsing) {
        if (text == "using") {
          rawHeaderState = RawHeaderState.boundary;
        } else {
          rawHeaderState = RawHeaderState.none;
        }
      }
      match (keyword) {
        some(kind) => pushToken(inout tokens, kind, text, baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
        none => pushToken(inout tokens, TokenKind.identifier, text, baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
      }
      continue;
    }

    if (isDigit(byte)) {
      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      while (offset < source.byteLength && isDigit(source.byteAt(offset))) {
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      }
      if (offset + 1 < source.byteLength && source.byteAt(offset) == 46 && isDigit(source.byteAt(offset + 1))) {
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        while (offset < source.byteLength && isDigit(source.byteAt(offset))) {
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        }
      }
      if (offset < source.byteLength && (source.byteAt(offset) == 101 || source.byteAt(offset) == 69)) {
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        if (offset < source.byteLength && (source.byteAt(offset) == 43 || source.byteAt(offset) == 45)) {
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        }
        if (offset >= source.byteLength || !isDigit(source.byteAt(offset))) {
          throw LexerError({ message: "a numeric exponent requires at least one digit", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
        }
        while (offset < source.byteLength && isDigit(source.byteAt(offset))) {
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        }
      }
      pushToken(inout tokens, TokenKind.number, source.copyBytes(tokenOffset, offset), baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
      continue;
    }

    if (byte == 34 || byte == 39) {
      const quote = byte;
      let decoded = TextBuffer();
      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      let chunkStart = offset;

      while (offset < source.byteLength && source.byteAt(offset) != quote) {
        const quotedByte = source.byteAt(offset);
        if (quotedByte == 10) {
          throw LexerError({ message: "unterminated string literal", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
        }
        if (quotedByte != 92) {
          advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
          continue;
        }

        decoded.appendBytes(source, chunkStart, offset);
        const escapeCoordinateOffset = offset - byteSurplus;
        const escapeLine = line;
        const escapeColumn = column;
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        if (offset >= source.byteLength) {
          throw LexerError({ message: "unterminated string escape", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
        }
        const escaped = source.byteAt(offset);
        if (escaped == 110) decoded.appendAscii(10);
        else if (escaped == 114) decoded.appendAscii(13);
        else if (escaped == 116) decoded.appendAscii(9);
        else if (escaped == 92 || escaped == 34 || escaped == 39) decoded.appendAscii(escaped);
        else {
          throw LexerError({ message: "unknown string escape", offset: baseOffset + escapeCoordinateOffset, line: escapeLine, column: escapeColumn });
        }
        advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
        chunkStart = offset;
      }

      if (offset >= source.byteLength) {
        throw LexerError({ message: "unterminated string literal", offset: baseOffset + tokenCoordinateOffset, line: tokenLine, column: tokenColumn });
      }
      decoded.appendBytes(source, chunkStart, offset);
      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
      pushToken(inout tokens, TokenKind.string, decoded.finish(), baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
      continue;
    }

    if (
      byte == 46
      && offset + 2 < source.byteLength
      && source.byteAt(offset + 1) == 46
      && source.byteAt(offset + 2) == 46
    ) {
      offset = offset + 3;
      column = column + 3;
      pushToken(
        inout tokens,
        TokenKind.ellipsis,
        "...",
        baseOffset + tokenCoordinateOffset,
        tokenLine,
        tokenColumn
      );
      continue;
    }

    const paired: Option<TokenKind> = offset + 1 < source.byteLength
      ? pairedSymbolKind(byte, source.byteAt(offset + 1))
      : Option<TokenKind>.none;
    match (paired) {
      some(kind) => {
        offset = offset + 2;
        column = column + 2;
        pushToken(inout tokens, kind, source.copyBytes(tokenOffset, offset), baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
        if (
          rawHeaderState == RawHeaderState.language
          || rawHeaderState == RawHeaderState.bodyOrUsing
        ) rawHeaderState = RawHeaderState.none;
      }
      none => {
        const single = singleSymbolKind(byte);
        match (single) {
          some(kind) => {
            if (
              kind == TokenKind.leftBrace
              && (
                rawHeaderState == RawHeaderState.bodyOrUsing
                || rawHeaderState == RawHeaderState.boundary
              )
            ) {
              advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              pushToken(
                inout tokens,
                TokenKind.leftBrace,
                "{",
                baseOffset + tokenCoordinateOffset,
                tokenLine,
                tokenColumn
              );
              const bodyOffset = offset;
              const bodyCoordinateOffset = offset - byteSurplus;
              const bodyLine = line;
              const bodyColumn = column;
              let depth: usize = 0;
              let quote: u8 = 0;
              while (true) {
                if (offset >= source.byteLength) {
                  throw LexerError({
                    message: "unterminated raw native body",
                    offset: baseOffset + tokenCoordinateOffset,
                    line: tokenLine,
                    column: tokenColumn,
                  });
                }
                const bodyByte = source.byteAt(offset);
                if (quote != 0) {
                  if (bodyByte == 92) {
                    advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                    if (offset < source.byteLength) {
                      advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                    }
                    continue;
                  }
                  if (bodyByte == quote) quote = 0;
                  advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                  continue;
                }
                if (bodyByte == 34 || bodyByte == 39) {
                  quote = bodyByte;
                  advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                  continue;
                }
                if (
                  bodyByte == 47
                  && offset + 1 < source.byteLength
                  && source.byteAt(offset + 1) == 47
                ) {
                  while (offset < source.byteLength && source.byteAt(offset) != 10) {
                    advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                  }
                  continue;
                }
                if (
                  bodyByte == 47
                  && offset + 1 < source.byteLength
                  && source.byteAt(offset + 1) == 42
                ) {
                  try skipBlockComment(
                    source,
                    baseOffset,
                    inout offset,
                    inout byteSurplus,
                    inout line,
                    inout column
                  );
                  continue;
                }
                if (bodyByte == 123) {
                  depth = depth + 1;
                  advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                  continue;
                }
                if (bodyByte == 125) {
                  if (depth == 0) break;
                  depth = depth - 1;
                  advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
                  continue;
                }
                advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              }
              pushToken(
                inout tokens,
                TokenKind.rawBody,
                source.copyBytes(bodyOffset, offset),
                baseOffset + bodyCoordinateOffset,
                bodyLine,
                bodyColumn
              );
              const endCoordinateOffset = offset - byteSurplus;
              const endLine = line;
              const endColumn = column;
              advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
              pushToken(
                inout tokens,
                TokenKind.rightBrace,
                "}",
                baseOffset + endCoordinateOffset,
                endLine,
                endColumn
              );
              rawHeaderState = RawHeaderState.none;
              continue;
            }
            advanceSource(source, inout offset, inout byteSurplus, inout line, inout column);
            pushToken(inout tokens, kind, source.copyBytes(tokenOffset, offset), baseOffset + tokenCoordinateOffset, tokenLine, tokenColumn);
            if (
              kind == TokenKind.semicolon
              || rawHeaderState == RawHeaderState.language
              || rawHeaderState == RawHeaderState.bodyOrUsing
            ) rawHeaderState = RawHeaderState.none;
          }
          none => throw LexerError({
            message: `unexpected source byte ${byte}`,
            offset: baseOffset + tokenCoordinateOffset,
            line: tokenLine,
            column: tokenColumn,
          });
        }
      }
    }
  }

  if (emitEof) {
    pushToken(inout tokens, TokenKind.eof, "", baseOffset + offset - byteSurplus, line, column);
  }
}

export function tokenize(in source: String): Array<Token> throws LexerError {
  let tokens = Array<Token>();
  try tokenizeInto(inout tokens, source, 0, 1, 1, true);
  return tokens;
}

export function tokenKindName(kind: TokenKind): String {
  return match (kind) {
    identifier => "identifier";
    number => "number";
    string => "string";
    rawBody => "rawBody";
    templateStart => "templateStart";
    templateText => "templateText";
    templateExpressionStart => "templateExpressionStart";
    templateExpressionEnd => "templateExpressionEnd";
    templateEnd => "templateEnd";
    importKeyword => "import";
    exportKeyword => "export";
    fromKeyword => "from";
    asKeyword => "as";
    functionKeyword => "function";
    asyncKeyword => "async";
    awaitKeyword => "await";
    onKeyword => "on";
    scopeKeyword => "scope";
    structKeyword => "struct";
    classKeyword => "class";
    traitKeyword => "trait";
    implementsKeyword => "implements";
    enumKeyword => "enum";
    deinitKeyword => "deinit";
    matchKeyword => "match";
    ifKeyword => "if";
    elseKeyword => "else";
    whileKeyword => "while";
    forKeyword => "for";
    ofKeyword => "of";
    breakKeyword => "break";
    continueKeyword => "continue";
    trueKeyword => "true";
    falseKeyword => "false";
    nullKeyword => "null";
    newKeyword => "new";
    constructorKeyword => "constructor";
    publicKeyword => "public";
    privateKeyword => "private";
    readonlyKeyword => "readonly";
    staticKeyword => "static";
    constKeyword => "const";
    letKeyword => "let";
    returnKeyword => "return";
    throwsKeyword => "throws";
    throwKeyword => "throw";
    selectKeyword => "select";
    yieldKeyword => "yield";
    attemptKeyword => "attempt";
    tryKeyword => "try";
    unsafeKeyword => "unsafe";
    weakKeyword => "weak";
    inKeyword => "in";
    instanceofKeyword => "instanceof";
    outKeyword => "out";
    inoutKeyword => "inout";
    leftParen => "leftParen";
    rightParen => "rightParen";
    leftBrace => "leftBrace";
    rightBrace => "rightBrace";
    leftBracket => "leftBracket";
    rightBracket => "rightBracket";
    colon => "colon";
    question => "question";
    comma => "comma";
    semicolon => "semicolon";
    dot => "dot";
    ellipsis => "ellipsis";
    equal => "equal";
    equalEqual => "equalEqual";
    bang => "bang";
    bangEqual => "bangEqual";
    less => "less";
    lessEqual => "lessEqual";
    greater => "greater";
    greaterEqual => "greaterEqual";
    andAnd => "andAnd";
    orOr => "orOr";
    bitAnd => "bitAnd";
    bitOr => "bitOr";
    bitXor => "bitXor";
    shiftLeft => "shiftLeft";
    shiftRight => "shiftRight";
    tilde => "tilde";
    fatArrow => "fatArrow";
    plus => "plus";
    minus => "minus";
    star => "star";
    slash => "slash";
    percent => "percent";
    eof => "eof";
  };
}
