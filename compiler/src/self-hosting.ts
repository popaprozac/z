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

export type Stage1FunctionBody = {
  readonly text: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
    readonly fileName: string;
  };
};

export type Stage1ImportShape = {
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
  readonly importShapes: readonly Stage1ImportShape[];
  readonly functionSignatures: readonly Stage1FunctionSignature[];
  readonly functionBodies: readonly Stage1FunctionBody[];
  readonly typeShapes: readonly Stage1TypeShape[];
};

export type Stage1ProgramBatch = ReadonlyMap<string, Stage1Program>;

export type Stage1ModuleSource = {
  readonly path: string;
  readonly source: string;
};

export type Stage1ResolvedModule = {
  readonly path: string;
  readonly dependencies: readonly number[];
  readonly symbols: readonly Stage1ModuleSymbol[];
};

export type Stage1ModuleSymbolKind = "function" | "struct" | "class" | "trait" | "enum" | "namespace" | "imported";

export type Stage1ModuleSymbol = {
  readonly name: string;
  readonly kind: Stage1ModuleSymbolKind;
  readonly exported: boolean;
  readonly targetModule: number | null;
  readonly importedName: string;
  readonly location: {
    readonly offset: number;
    readonly line: number;
    readonly column: number;
  };
};

export type Stage1ModuleGraph = {
  readonly modules: readonly Stage1ResolvedModule[];
  readonly dependencyOrder: readonly number[];
  readonly entry: number;
};

export function encodeStage1ModuleBatch(sources: readonly Stage1ModuleSource[]): Buffer {
  const records: Buffer[] = [];
  for (const source of sources) {
    const path = Buffer.from(source.path, "utf8");
    const text = Buffer.from(source.source, "utf8");
    const header = Buffer.from(
      path.byteLength.toString(16).padStart(16, "0")
      + text.byteLength.toString(16).padStart(16, "0"),
      "ascii",
    );
    records.push(header, path, text);
  }
  return Buffer.concat(records);
}

export function decodeStage1ModuleGraphStream(output: string): Stage1ModuleGraph {
  let entry: number | null = null;
  let dependencyOrder: number[] | null = null;
  const modules: Stage1ResolvedModule[] = [];
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] === "entry") {
      if (entry !== null || fields.length !== 2) throw new Error(`malformed stage-1 module entry line: ${line}`);
      entry = parseProtocolHexInteger(fields[1], "module entry");
      continue;
    }
    if (fields[0] === "module") {
      if (fields.length < 2 || !/^(?:[0-9a-f]{2})*$/.test(fields[1])) {
        throw new Error(`malformed stage-1 module line: ${line}`);
      }
      modules.push({
        path: Buffer.from(fields[1], "hex").toString("utf8"),
        dependencies: fields.slice(2).map((field) => parseProtocolHexInteger(field, "module dependency")),
        symbols: [],
      });
      continue;
    }
    if (fields[0] === "symbol") {
      if (fields.length !== 10) throw new Error(`malformed stage-1 module symbol line: ${line}`);
      const [, moduleText, kind, nameText, exportedText, targetText, importedNameText, offsetText, lineText, columnText] = fields;
      const moduleIndex = parseProtocolHexInteger(moduleText, "symbol module");
      const module = modules[moduleIndex];
      if (!module) throw new Error("stage-1 module symbol appeared before its module");
      if (!isStage1ModuleSymbolKind(kind)) throw new Error(`malformed stage-1 module symbol kind: ${kind}`);
      if (!/^(?:[0-9a-f]{2})*$/.test(nameText) || !/^(?:[0-9a-f]{2})*$/.test(importedNameText)) {
        throw new Error(`malformed stage-1 module symbol text: ${line}`);
      }
      if (exportedText !== "0" && exportedText !== "1") {
        throw new Error(`malformed stage-1 module symbol export state: ${exportedText}`);
      }
      (module.symbols as Stage1ModuleSymbol[]).push({
        name: Buffer.from(nameText, "hex").toString("utf8"),
        kind,
        exported: exportedText === "1",
        targetModule: targetText === "-" ? null : parseProtocolHexInteger(targetText, "symbol target"),
        importedName: Buffer.from(importedNameText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "symbol offset"),
          line: parseProtocolHexInteger(lineText, "symbol line"),
          column: parseProtocolHexInteger(columnText, "symbol column"),
        },
      });
      continue;
    }
    if (fields[0] === "order") {
      if (dependencyOrder !== null) throw new Error("duplicate stage-1 module dependency order");
      dependencyOrder = fields.slice(1).map((field) => parseProtocolHexInteger(field, "module order"));
      continue;
    }
    throw new Error(`unknown stage-1 module graph record: ${line}`);
  }
  if (entry === null) throw new Error("stage-1 module graph did not contain an entry");
  if (dependencyOrder === null) throw new Error("stage-1 module graph did not contain a dependency order");
  if (entry >= modules.length) throw new Error("stage-1 module graph entry is outside the module batch");
  for (const module of modules) {
    if (module.dependencies.some((dependency) => dependency >= modules.length)) {
      throw new Error("stage-1 module dependency is outside the module batch");
    }
    if (module.symbols.some((symbol) => symbol.targetModule !== null && symbol.targetModule >= modules.length)) {
      throw new Error("stage-1 module symbol target is outside the module batch");
    }
  }
  if (dependencyOrder.some((index) => index >= modules.length)) {
    throw new Error("stage-1 module order is outside the module batch");
  }
  return { modules, dependencyOrder, entry };
}

function isStage1ModuleSymbolKind(value: string): value is Stage1ModuleSymbolKind {
  return value === "function"
    || value === "struct"
    || value === "class"
    || value === "trait"
    || value === "enum"
    || value === "namespace"
    || value === "imported";
}

// Token parity still crosses a subprocess boundary. Keep that bootstrap protocol
// isolated here so the parser-facing Token shape does not learn about transport;
// parser parity reuses the decoders through its in-process native-library bridge.
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
  const importShapes: Stage1ImportShape[] = [];
  const functionSignatures: Stage1FunctionSignature[] = [];
  const functionBodies: Stage1FunctionBody[] = [];
  const typeShapes: Stage1TypeShape[] = [];
  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] === "importShape") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 import shape line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 import shape text: ${hexadecimalText}`);
      }
      importShapes.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "import shape offset"),
          line: parseProtocolHexInteger(lineText, "import shape line"),
          column: parseProtocolHexInteger(columnText, "import shape column"),
          fileName,
        },
      });
      continue;
    }
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
    if (fields[0] === "body") {
      if (fields.length !== 5) throw new Error(`malformed stage-1 function body line: ${line}`);
      const [, offsetText, lineText, columnText, hexadecimalText] = fields;
      if (!/^(?:[0-9a-f]{2})*$/.test(hexadecimalText)) {
        throw new Error(`malformed stage-1 function body text: ${hexadecimalText}`);
      }
      functionBodies.push({
        text: Buffer.from(hexadecimalText, "hex").toString("utf8"),
        location: {
          offset: parseProtocolHexInteger(offsetText, "function body offset"),
          line: parseProtocolHexInteger(lineText, "function body line"),
          column: parseProtocolHexInteger(columnText, "function body column"),
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
  importShapes.sort((left, right) => left.location.offset - right.location.offset);
  return { declarations, importShapes, functionSignatures, functionBodies, typeShapes };
}

export function decodeStage1ProgramBatchStream(output: string): Stage1ProgramBatch {
  const programs = new Map<string, Stage1Program>();
  let fileName: string | null = null;
  let records: string[] = [];

  const finishProgram = (): void => {
    if (fileName === null) return;
    programs.set(fileName, decodeStage1ProgramStream(records.join("\n"), fileName));
  };

  for (const line of output.split("\n").filter((candidate) => candidate.length > 0)) {
    const fields = line.split("\t");
    if (fields[0] !== "file") {
      if (fileName === null) throw new Error("stage-1 program record appeared before its file header");
      records.push(line);
      continue;
    }
    if (fields.length !== 2 || !/^(?:[0-9a-f]{2})*$/.test(fields[1])) {
      throw new Error(`malformed stage-1 file header: ${line}`);
    }
    finishProgram();
    fileName = Buffer.from(fields[1], "hex").toString("utf8");
    if (programs.has(fileName)) throw new Error(`duplicate stage-1 program for ${fileName}`);
    records = [];
  }
  finishProgram();
  if (fileName === null) throw new Error("stage-1 program stream did not contain a file header");
  return programs;
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
