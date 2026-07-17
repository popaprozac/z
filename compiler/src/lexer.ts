import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "templateStart"
  | "templateText"
  | "templateExpressionStart"
  | "templateExpressionEnd"
  | "templateEnd"
  | "import"
  | "export"
  | "from"
  | "as"
  | "function"
  | "struct"
  | "class"
  | "trait"
  | "implements"
  | "enum"
  | "deinit"
  | "match"
  | "if"
  | "else"
  | "while"
  | "for"
  | "of"
  | "break"
  | "continue"
  | "true"
  | "false"
  | "null"
  | "new"
  | "constructor"
  | "public"
  | "private"
  | "const"
  | "let"
  | "return"
  | "throws"
  | "throw"
  | "select"
  | "yield"
  | "attempt"
  | "try"
  | "weak"
  | "in"
  | "out"
  | "inout"
  | "leftParen"
  | "rightParen"
  | "leftBrace"
  | "rightBrace"
  | "leftBracket"
  | "rightBracket"
  | "colon"
  | "question"
  | "comma"
  | "semicolon"
  | "dot"
  | "equal"
  | "equalEqual"
  | "bang"
  | "bangEqual"
  | "less"
  | "lessEqual"
  | "greater"
  | "greaterEqual"
  | "andAnd"
  | "orOr"
  | "bitAnd"
  | "bitOr"
  | "bitXor"
  | "shiftLeft"
  | "shiftRight"
  | "tilde"
  | "fatArrow"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "percent"
  | "eof";

export type Token = {
  readonly kind: TokenKind;
  readonly text: string;
  readonly location: SourceLocation;
};

const keywords = new Map<string, TokenKind>([
  ["import", "import"],
  ["export", "export"],
  ["from", "from"],
  ["as", "as"],
  ["function", "function"],
  ["struct", "struct"],
  ["class", "class"],
  ["trait", "trait"],
  ["implements", "implements"],
  ["enum", "enum"],
  ["deinit", "deinit"],
  ["match", "match"],
  ["if", "if"],
  ["else", "else"],
  ["while", "while"],
  ["for", "for"],
  ["of", "of"],
  ["break", "break"],
  ["continue", "continue"],
  ["true", "true"],
  ["false", "false"],
  ["null", "null"],
  ["new", "new"],
  ["constructor", "constructor"],
  ["public", "public"],
  ["private", "private"],
  ["const", "const"],
  ["let", "let"],
  ["return", "return"],
  ["throws", "throws"],
  ["throw", "throw"],
  ["select", "select"],
  ["yield", "yield"],
  ["attempt", "attempt"],
  ["try", "try"],
  ["weak", "weak"],
  ["in", "in"],
  ["out", "out"],
  ["inout", "inout"],
]);

export function lex(
  source: string,
  fileName: string,
  base: SourceLocation = { offset: 0, line: 1, column: 1 },
): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = base.line;
  let column = base.column;

  const location = (): SourceLocation => ({ offset: base.offset + offset, line, column, fileName });
  const peek = (distance = 0): string => source[offset + distance] ?? "\0";
  const advance = (): string => {
    const character = peek();
    offset += 1;
    if (character === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return character;
  };

  while (offset < source.length) {
    const character = peek();

    if (/\s/.test(character)) {
      advance();
      continue;
    }

    if (character === "/" && peek(1) === "/") {
      while (peek() !== "\n" && peek() !== "\0") advance();
      continue;
    }

    const start = location();

    if (character === "`") {
      advance();
      tokens.push({ kind: "templateStart", text: "`", location: start });
      let text = "";
      let textStart = location();
      const flushText = (): void => {
        if (!text) return;
        tokens.push({ kind: "templateText", text, location: textStart });
        text = "";
      };
      while (peek() !== "`") {
        if (peek() === "\0") throw new DiagnosticError(fileName, start, "unterminated template literal");
        if (peek() === "\\") {
          const escapeLocation = location();
          advance();
          const escaped = advance();
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            "`": "`",
            "$": "$",
          };
          if (!(escaped in escapes)) {
            throw new DiagnosticError(fileName, escapeLocation, `unknown template escape sequence \\${escaped}`);
          }
          text += escapes[escaped];
          continue;
        }
        if (peek() === "$" && peek(1) === "{") {
          flushText();
          const marker = location();
          advance();
          advance();
          tokens.push({ kind: "templateExpressionStart", text: "${", location: marker });
          const expressionStartOffset = offset;
          const expressionStart = location();
          let depth = 0;
          let quote: string | null = null;
          while (true) {
            const current = peek();
            if (current === "\0") throw new DiagnosticError(fileName, marker, "unterminated template interpolation");
            if (quote) {
              if (current === "\\") {
                advance();
                if (peek() !== "\0") advance();
                continue;
              }
              if (current === quote) quote = null;
              advance();
              continue;
            }
            if (current === '"' || current === "'" || current === "`") {
              quote = current;
              advance();
              continue;
            }
            if (current === "/" && peek(1) === "/") {
              while (peek() !== "\n" && peek() !== "\0") advance();
              continue;
            }
            if (current === "{") {
              depth += 1;
              advance();
              continue;
            }
            if (current === "}") {
              if (depth === 0) break;
              depth -= 1;
              advance();
              continue;
            }
            advance();
          }
          const nestedSource = source.slice(expressionStartOffset, offset);
          tokens.push(...lex(nestedSource, fileName, expressionStart).filter((token) => token.kind !== "eof"));
          const end = location();
          advance();
          tokens.push({ kind: "templateExpressionEnd", text: "}", location: end });
          textStart = location();
          continue;
        }
        text += advance();
      }
      flushText();
      const end = location();
      advance();
      tokens.push({ kind: "templateEnd", text: "`", location: end });
      continue;
    }

    if (/[A-Za-z_]/.test(character)) {
      let text = "";
      while (/[A-Za-z0-9_]/.test(peek())) text += advance();
      tokens.push({ kind: keywords.get(text) ?? "identifier", text, location: start });
      continue;
    }

    if (/[0-9]/.test(character)) {
      let text = "";
      while (/[0-9]/.test(peek())) text += advance();
      if (peek() === "." && /[0-9]/.test(peek(1))) {
        text += advance();
        while (/[0-9]/.test(peek())) text += advance();
      }
      if (peek() === "e" || peek() === "E") {
        text += advance();
        if (peek() === "+" || peek() === "-") text += advance();
        if (!/[0-9]/.test(peek())) {
          throw new DiagnosticError(fileName, start, "a numeric exponent requires at least one digit");
        }
        while (/[0-9]/.test(peek())) text += advance();
      }
      tokens.push({ kind: "number", text, location: start });
      continue;
    }

    if (character === '"' || character === "'") {
      const quote = character;
      advance();
      let value = "";
      while (peek() !== quote && peek() !== "\0") {
        if (peek() === "\n") {
          throw new DiagnosticError(fileName, start, "unterminated string literal");
        }
        if (peek() === "\\") {
          const escapeLocation = location();
          advance();
          const escaped = advance();
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
            "'": "'",
          };
          if (!(escaped in escapes)) {
            throw new DiagnosticError(fileName, escapeLocation, `unknown escape sequence \\${escaped}`);
          }
          value += escapes[escaped];
        } else {
          value += advance();
        }
      }
      if (peek() !== quote) {
        throw new DiagnosticError(fileName, start, "unterminated string literal");
      }
      advance();
      tokens.push({ kind: "string", text: value, location: start });
      continue;
    }

    const punctuation: Record<string, TokenKind> = {
      "(": "leftParen",
      ")": "rightParen",
      "{": "leftBrace",
      "}": "rightBrace",
      "[": "leftBracket",
      "]": "rightBracket",
      ":": "colon",
      "?": "question",
      ",": "comma",
      ";": "semicolon",
      ".": "dot",
      "=": "equal",
      "!": "bang",
      "<": "less",
      ">": "greater",
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "%": "percent",
      "&": "bitAnd",
      "|": "bitOr",
      "^": "bitXor",
      "~": "tilde",
    };
    const pairedPunctuation: Record<string, TokenKind> = {
      "=>": "fatArrow",
      "==": "equalEqual",
      "!=": "bangEqual",
      "<=": "lessEqual",
      ">=": "greaterEqual",
      "&&": "andAnd",
      "||": "orOr",
      "<<": "shiftLeft",
      ">>": "shiftRight",
    };
    const pair = character + peek(1);
    const pairedKind = pairedPunctuation[pair];
    if (pairedKind) {
      advance();
      advance();
      tokens.push({ kind: pairedKind, text: pair, location: start });
      continue;
    }
    const kind = punctuation[character];
    if (kind) {
      advance();
      tokens.push({ kind, text: character, location: start });
      continue;
    }

    throw new DiagnosticError(fileName, start, `unexpected character ${JSON.stringify(character)}`);
  }

  tokens.push({ kind: "eof", text: "", location: location() });
  return tokens;
}
