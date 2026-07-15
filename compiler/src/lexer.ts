import type { SourceLocation } from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

export type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "import"
  | "from"
  | "as"
  | "function"
  | "struct"
  | "enum"
  | "deinit"
  | "match"
  | "if"
  | "else"
  | "true"
  | "false"
  | "const"
  | "let"
  | "return"
  | "throws"
  | "throw"
  | "yield"
  | "attempt"
  | "try"
  | "out"
  | "inout"
  | "leftParen"
  | "rightParen"
  | "leftBrace"
  | "rightBrace"
  | "colon"
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
  | "fatArrow"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "eof";

export type Token = {
  readonly kind: TokenKind;
  readonly text: string;
  readonly location: SourceLocation;
};

const keywords = new Map<string, TokenKind>([
  ["import", "import"],
  ["from", "from"],
  ["as", "as"],
  ["function", "function"],
  ["struct", "struct"],
  ["enum", "enum"],
  ["deinit", "deinit"],
  ["match", "match"],
  ["if", "if"],
  ["else", "else"],
  ["true", "true"],
  ["false", "false"],
  ["const", "const"],
  ["let", "let"],
  ["return", "return"],
  ["throws", "throws"],
  ["throw", "throw"],
  ["yield", "yield"],
  ["attempt", "attempt"],
  ["try", "try"],
  ["out", "out"],
  ["inout", "inout"],
]);

export function lex(source: string, fileName: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const location = (): SourceLocation => ({ offset, line, column });
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

    if (/[A-Za-z_]/.test(character)) {
      let text = "";
      while (/[A-Za-z0-9_]/.test(peek())) text += advance();
      tokens.push({ kind: keywords.get(text) ?? "identifier", text, location: start });
      continue;
    }

    if (/[0-9]/.test(character)) {
      let text = "";
      while (/[0-9]/.test(peek())) text += advance();
      tokens.push({ kind: "number", text, location: start });
      continue;
    }

    if (character === '"') {
      advance();
      let value = "";
      while (peek() !== '"' && peek() !== "\0") {
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
          };
          if (!(escaped in escapes)) {
            throw new DiagnosticError(fileName, escapeLocation, `unknown escape sequence \\${escaped}`);
          }
          value += escapes[escaped];
        } else {
          value += advance();
        }
      }
      if (peek() !== '"') {
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
      ":": "colon",
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
    };
    const pairedPunctuation: Record<string, TokenKind> = {
      "=>": "fatArrow",
      "==": "equalEqual",
      "!=": "bangEqual",
      "<=": "lessEqual",
      ">=": "greaterEqual",
      "&&": "andAnd",
      "||": "orOr",
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
