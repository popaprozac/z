import type { Token, TokenKind } from "./lexer.ts";

// Stage 1 currently crosses a subprocess boundary. Keep that bootstrap protocol
// isolated here so the parser-facing Token shape does not learn about transport.
export function decodeStage1TokenStream(output: string, fileName: string): readonly Token[] {
  return output.split("\n").filter((line) => line.length > 0).map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 5) throw new Error(`malformed stage-1 token line: ${line}`);
    const [kind, offsetText, lineText, columnText, hexadecimalText] = fields;
    if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
      throw new Error(`malformed stage-1 token text: ${hexadecimalText}`);
    }
    const offset = parseProtocolHexInteger(offsetText, "offset");
    const sourceLine = parseProtocolHexInteger(lineText, "line");
    const column = parseProtocolHexInteger(columnText, "column");
    return {
      kind: kind as TokenKind,
      text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
      location: { offset, line: sourceLine, column, fileName },
    };
  });
}

function parseProtocolHexInteger(text: string, field: string): number {
  if (!/^[0-9a-f]{16}$/.test(text)) {
    throw new Error(`malformed stage-1 token ${field}: ${text}`);
  }
  const value = Number.parseInt(text, 16);
  if (!Number.isSafeInteger(value)) throw new Error(`stage-1 token ${field} exceeds the stage-0 integer range`);
  return value;
}
