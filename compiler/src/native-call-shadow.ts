import type { FunctionDeclaration } from "./ast.ts";
import type { SourceModuleBatch } from "./modules.ts";
import type { NativeSemanticIndex } from "./native-semantic-index.ts";
import { sameModuleFunctionSignature, stage0FunctionSignature } from "./native-semantic-parity.ts";
import type { SemanticObserver } from "./sema.ts";

export type NativeCallShadow = {
  readonly observer: SemanticObserver;
  readonly count: () => number;
};

export function createNativeCallShadow(
  sourceBatch: SourceModuleBatch,
  index: NativeSemanticIndex,
): NativeCallShadow {
  const sourceFunctions = new Map<string, { readonly modulePath: string; readonly declaration: FunctionDeclaration }>();
  const modulePaths = new Set<string>();
  for (const module of sourceBatch.modules) {
    modulePaths.add(module.fileName);
    for (const declaration of module.program.functions) {
      sourceFunctions.set(definitionKey(module.fileName, declaration), {
        modulePath: module.fileName,
        declaration,
      });
    }
  }

  let calls = 0;
  const observer: SemanticObserver = {
    onFunctionCall: ({ location, declaration }) => {
      const definitionPath = declaration.location.fileName;
      if (!definitionPath || !modulePaths.has(definitionPath)) return;
      const source = sourceFunctions.get(definitionKey(definitionPath, declaration));
      if (!source) return;
      const native = index.symbol(source.modulePath, source.declaration.name);
      if (native?.kind !== "function" || !native.functionSignature) {
        throw new Error(
          `native call shadow could not resolve function ${JSON.stringify(source.declaration.name)} in ${source.modulePath}`,
        );
      }
      const expected = stage0FunctionSignature(source.declaration);
      if (!sameModuleFunctionSignature(expected, native.functionSignature)) {
        throw new Error(
          `native call shadow signature mismatch for ${JSON.stringify(source.declaration.name)} called at ${location.fileName ?? sourceBatch.entryFileName}:${location.line}:${location.column}`,
        );
      }
      calls += 1;
    },
  };
  return { observer, count: () => calls };
}

function definitionKey(modulePath: string, declaration: FunctionDeclaration): string {
  return `${modulePath}\0${declaration.location.line}\0${declaration.location.column}`;
}
