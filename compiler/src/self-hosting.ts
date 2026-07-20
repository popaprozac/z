import type { Token, TokenKind } from "./lexer.ts";

export type Stage1DeclarationKind = "import" | "function" | "struct" | "class" | "trait" | "enum";

export type Stage1Declaration = {
  readonly kind: Stage1DeclarationKind;
  readonly name: string;
  readonly exported: boolean;
  readonly asynchronous: boolean;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1FunctionSignature = {
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1TypeShapeKind = "struct" | "class" | "trait" | "enum";

export type Stage1TypeShape = {
  readonly kind: Stage1TypeShapeKind;
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1Program = {
  readonly declarations: readonly Stage1Declaration[];
  readonly functionSignatures: readonly Stage1FunctionSignature[];
  readonly typeShapes: readonly Stage1TypeShape[];
};

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
    const offset = parseProtocolHexInteger(offsetText, "token offset");
    const sourceLine = parseProtocolHexInteger(lineText, "token line");
    const column = parseProtocolHexInteger(columnText, "token column");
    return {
      kind: kind as TokenKind,
      text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
      location: { offset, line: sourceLine, column, fileName },
    };
  });
}

export function decodeStage1DeclarationStream(output: string, fileName: string): readonly Stage1Declaration[] {
  return decodeStage1ProgramStream(output, fileName).declarations;
}

export function decodeStage1ProgramStream(output: string, fileName: string): Stage1Program {
  const declarations: Stage1Declaration[] = [];
  const functionSignatures: Stage1FunctionSignature[] = [];
  const typeShapes: Stage1TypeShape[] = [];
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] === "signature") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 function signature line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 function signature text: ${hexadecimalText}`);
      }
      functionSignatures.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "function signature offset"),
          line: parseProtocolHexInteger(lineText, "function signature line"),
          column: parseProtocolHexInteger(columnText, "function signature column"),
          fileName,
        },
      });
      continue;
    }
    if (fields[0] === "shape") {
      if (fields.length !== 6) throw new Error(`malformed stage-1 type shape line: ${line}`);
      const [, kind, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!isStage1TypeShapeKind(kind)) throw new Error(`malformed stage-1 type shape kind: ${kind}`);
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 type shape text: ${hexadecimalText}`);
      }
      typeShapes.push({
        kind,
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "type shape offset"),
          line: parseProtocolHexInteger(lineText, "type shape line"),
          column: parseProtocolHexInteger(columnText, "type shape column"),
          fileName,
        },
      });
      continue;
    }
    if (fields.length !== 7) throw new Error(`malformed stage-1 declaration line: ${line}`);
    const [kind, exportedText, asynchronousText, offsetText, lineText, columnText, hexadecimalName] = fields;
    if (!isStage1DeclarationKind(kind)) throw new Error(`malformed stage-1 declaration kind: ${kind}`);
    if (exportedText !== "0" && exportedText !== "1") {
      throw new Error(`malformed stage-1 declaration export state: ${exportedText}`);
    }
    if (asynchronousText !== "0" && asynchronousText !== "1") {
      throw new Error(`malformed stage-1 declaration async state: ${asynchronousText}`);
    }
    if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalName)) {
      throw new Error(`malformed stage-1 declaration name: ${hexadecimalName}`);
    }
    declarations.push({
      kind,
      name: Buffer.from(hexadecimalName, "hex").toString("utf8"),
      exported: exportedText === "1",
      asynchronous: asynchronousText === "1",
      location: {
        offset: parseProtocolHexInteger(offsetText, "declaration offset"),
        line: parseProtocolHexInteger(lineText, "declaration line"),
        column: parseProtocolHexInteger(columnText, "declaration column"),
        fileName,
      },
    });
  }
  typeShapes.sort((left, right) => left.location.offset - right.location.offset);
  return { declarations, functionSignatures, typeShapes };
}

function isStage1TypeShapeKind(value: string): value is Stage1TypeShapeKind {
  return value === "struct" || value === "class" || value === "trait" || value === "enum";
}

function isStage1DeclarationKind(value: string): value is Stage1DeclarationKind {
  return value === "import"
    || value === "function"
    || value === "struct"
    || value === "class"
    || value === "trait"
    || value === "enum";
}

function parseProtocolHexInteger(text: string, field: string): number {
  if (!/^[0-9a-f]{16}$/.test(text)) {
    throw new Error(`malformed stage-1 ${field}: ${text}`);
  }
  const value = Number.parseInt(text, 16);
  if (!Number.isSafeInteger(value)) throw new Error(`stage-1 ${field} exceeds the stage-0 integer range`);
  return value;
}
