import type { FunctionDeclaration, StructDeclaration } from "./ast.ts";
import type { SourceModuleBatch } from "./modules.ts";
import type { NativeSemanticIndex } from "./native-semantic-index.ts";
import {
  sameModuleFunctionSignature,
  stage0ConstructorSignature,
  stage0FunctionSignature,
} from "./native-semantic-parity.ts";
import type { SemanticObserver } from "./sema.ts";

export type NativeCallShadow = {
  readonly observer: SemanticObserver;
  readonly functionCount: () => number;
  readonly methodCount: () => number;
  readonly constructorCount: () => number;
};

export function createNativeCallShadow(
  sourceBatch: SourceModuleBatch,
  index: NativeSemanticIndex,
): NativeCallShadow {
  const sourceFunctions = new Map<string, { readonly modulePath: string; readonly declaration: FunctionDeclaration }>();
  const sourceAggregates = new Map<string, { readonly modulePath: string; readonly declaration: StructDeclaration }>();
  const modulePaths = new Set<string>();
  for (const module of sourceBatch.modules) {
    modulePaths.add(module.fileName);
    for (const declaration of module.program.functions) {
      sourceFunctions.set(definitionKey(module.fileName, declaration), {
        modulePath: module.fileName,
        declaration,
      });
    }
    for (const declaration of module.program.structs) {
      sourceAggregates.set(definitionKey(module.fileName, declaration), {
        modulePath: module.fileName,
        declaration,
      });
    }
  }

  let functions = 0;
  let methods = 0;
  let constructors = 0;
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
      functions += 1;
    },
    onMethodCall: ({ location, aggregate, declaration }) => {
      const source = sourceAggregate(sourceAggregates, modulePaths, aggregate);
      if (!source) return;
      const native = index.symbol(source.modulePath, source.declaration.name);
      const nativeMethod = native?.typeSignature?.methods.find((candidate) => candidate.name === declaration.name);
      const sourceMethod = source.declaration.methods.find((candidate) =>
        candidate.name === declaration.name && Boolean(candidate.static) === Boolean(declaration.static)
      );
      if (!native || (native.kind !== "struct" && native.kind !== "class") || !nativeMethod || !sourceMethod) {
        throw new Error(
          `native call shadow could not resolve method ${JSON.stringify(`${source.declaration.name}.${declaration.name}`)} in ${source.modulePath}`,
        );
      }
      if (
        nativeMethod.staticMethod !== Boolean(sourceMethod.static)
        || nativeMethod.visibility !== (sourceMethod.visibility ?? "public")
        || nativeMethod.receiverMode !== (sourceMethod.receiverMode ?? "in")
        || !sameModuleFunctionSignature(stage0FunctionSignature(sourceMethod), nativeMethod.signature)
      ) {
        throw new Error(
          `native call shadow signature mismatch for ${JSON.stringify(`${source.declaration.name}.${declaration.name}`)} called at ${callSite(location, sourceBatch)}`,
        );
      }
      methods += 1;
    },
    onConstructorCall: ({ location, aggregate }) => {
      const source = sourceAggregate(sourceAggregates, modulePaths, aggregate);
      if (!source) return;
      const native = index.symbol(source.modulePath, source.declaration.name);
      const expected = stage0ConstructorSignature(source.declaration);
      if (
        !native
        || native.kind !== "class"
        || !native.typeSignature
        || !expected
        || !sameModuleFunctionSignature(expected, native.typeSignature.constructorSignature)
      ) {
        throw new Error(
          `native call shadow constructor mismatch for ${JSON.stringify(source.declaration.name)} called at ${callSite(location, sourceBatch)}`,
        );
      }
      constructors += 1;
    },
  };
  return {
    observer,
    functionCount: () => functions,
    methodCount: () => methods,
    constructorCount: () => constructors,
  };
}

function sourceAggregate(
  sourceAggregates: ReadonlyMap<string, { readonly modulePath: string; readonly declaration: StructDeclaration }>,
  modulePaths: ReadonlySet<string>,
  declaration: StructDeclaration,
): { readonly modulePath: string; readonly declaration: StructDeclaration } | null {
  const definitionPath = declaration.location.fileName;
  if (!definitionPath || !modulePaths.has(definitionPath)) return null;
  return sourceAggregates.get(definitionKey(definitionPath, declaration)) ?? null;
}

function callSite(location: { readonly fileName?: string; readonly line: number; readonly column: number }, sourceBatch: SourceModuleBatch): string {
  return `${location.fileName ?? sourceBatch.entryFileName}:${location.line}:${location.column}`;
}

function definitionKey(modulePath: string, declaration: FunctionDeclaration | StructDeclaration): string {
  return `${modulePath}\0${declaration.location.line}\0${declaration.location.column}`;
}
