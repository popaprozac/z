import assert from "node:assert/strict";
import test from "node:test";
import { lex } from "../compiler/src/lexer.ts";
import { parse } from "../compiler/src/parser.ts";
import {
  createZProgramMetadata,
  renderZProgramMetadata,
} from "../compiler/src/program-metadata.ts";
import type { SourceModuleBatch } from "../compiler/src/modules.ts";
import type { Stage1ModuleGraph } from "../compiler/src/self-hosting.ts";

test("exports checked public symbols and literal public-call arguments", () => {
  const path = "/tmp/program-metadata.zs";
  const source = `
export struct Service {}
function main(): i32 {
  register("notes", createService());
  hidden("ignored");
  return 0;
}
`;
  const program = parse(lex(source, path), path);
  const batch: SourceModuleBatch = {
    entryFileName: path,
    modules: [{
      fileName: path,
      source,
      program,
      dependencies: new Map(),
      packageSpecifiers: new Set(),
      packageId: null,
      packageName: null,
    }],
  };
  const callOffset = source.indexOf("(", source.indexOf("register"));
  const hiddenOffset = source.indexOf("(", source.indexOf("hidden"));
  const graph = {
    entry: 0,
    dependencyOrder: [0],
    modules: [{
      path,
      dependencies: [],
      symbols: [
        {
          name: "Service",
          kind: "struct",
          exported: true,
          nativeCExport: false,
          targetModule: null,
          importedName: "Service",
          functionSignature: null,
          typeSignature: null,
          location: { offset: 1, line: 2, column: 1 },
        },
        {
          name: "hidden",
          kind: "function",
          exported: false,
          nativeCExport: false,
          targetModule: null,
          importedName: "hidden",
          functionSignature: null,
          typeSignature: null,
          location: { offset: 0, line: 1, column: 1 },
        },
      ],
      callResolutions: [
        {
          offset: callOffset,
          line: 4,
          column: 11,
          targetModule: 0,
          targetSymbol: 0,
          kind: "method",
          targetName: "ServicesBuilder.register",
          asynchronous: false,
          receiverMode: "inout",
          callableTypeParameterCount: 0,
          typeParameters: [],
          typeArguments: [],
          parameterModes: ["value", "value"],
          parameterTypes: ["String", "Service"],
          returnType: "void",
          errorType: null,
        },
        {
          offset: hiddenOffset,
          line: 5,
          column: 9,
          targetModule: 0,
          targetSymbol: 1,
          kind: "function",
          targetName: "hidden",
          asynchronous: false,
          receiverMode: "",
          callableTypeParameterCount: 0,
          typeParameters: [],
          typeArguments: [],
          parameterModes: ["value"],
          parameterTypes: ["String"],
          returnType: "void",
          errorType: null,
        },
      ],
      bindingResolutions: [],
      expressionResolutions: [],
    }],
  } satisfies Stage1ModuleGraph;

  const metadata = createZProgramMetadata(graph, batch);
  assert.deepEqual(metadata.modules[0].symbols.map((symbol) => symbol.name), ["Service"]);
  assert.equal(metadata.modules[0].calls.length, 1);
  assert.deepEqual(metadata.modules[0].calls[0].target, {
    module: path,
    symbol: "Service",
    kind: "method",
    name: "ServicesBuilder.register",
  });
  assert.deepEqual(metadata.modules[0].calls[0].arguments, [
    { kind: "string", type: "String", value: "notes" },
    { kind: "other", type: "Service" },
  ]);
  assert.equal(JSON.parse(renderZProgramMetadata(metadata)).schemaVersion, 1);
});
