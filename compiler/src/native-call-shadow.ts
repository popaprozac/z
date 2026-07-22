import type { EnumDeclaration, FunctionDeclaration, StructDeclaration } from "./ast.ts";
import { canonicalTypeName } from "./canonical-type-name.ts";
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
  readonly aggregateCount: () => number;
  readonly fieldCount: () => number;
  readonly enumVariantCount: () => number;
};

export function createNativeCallShadow(
  sourceBatch: SourceModuleBatch,
  index: NativeSemanticIndex,
): NativeCallShadow {
  const sourceFunctions = new Map<string, { readonly modulePath: string; readonly declaration: FunctionDeclaration }>();
  const sourceAggregates = new Map<string, { readonly modulePath: string; readonly declaration: StructDeclaration }>();
  const sourceEnums = new Map<string, { readonly modulePath: string; readonly declaration: EnumDeclaration }>();
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
    for (const declaration of module.program.enums) {
      sourceEnums.set(definitionKey(module.fileName, declaration), {
        modulePath: module.fileName,
        declaration,
      });
    }
  }

  let functions = 0;
  let methods = 0;
  let constructors = 0;
  let aggregates = 0;
  let fields = 0;
  let enumVariants = 0;
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
    onAggregateConstruction: ({ location, declaration }) => {
      const source = sourceAggregate(sourceAggregates, modulePaths, declaration);
      if (!source) return;
      const native = index.symbol(source.modulePath, source.declaration.name);
      if (
        !native
        || native.kind !== source.declaration.kind
        || !native.typeSignature
        || native.typeSignature.customConstructor !== Boolean(source.declaration.constructor)
        || native.typeSignature.customDeinit !== Boolean(source.declaration.deinitializer)
      ) {
        throw new Error(
          `native semantic shadow aggregate mismatch for ${JSON.stringify(source.declaration.name)} constructed at ${callSite(location, sourceBatch)}`,
        );
      }
      aggregates += 1;
    },
    onFieldResolution: ({ location, aggregate, field }) => {
      const source = sourceAggregate(sourceAggregates, modulePaths, aggregate);
      if (!source) return;
      const sourceField = source.declaration.fields.find((candidate) => candidate.name === field.name);
      const native = index.symbol(source.modulePath, source.declaration.name);
      const nativeField = native?.typeSignature?.fields.find((candidate) => candidate.name === field.name);
      if (
        !native
        || (native.kind !== "struct" && native.kind !== "class")
        || !sourceField
        || !nativeField
        || nativeField.typeName !== canonicalTypeName(sourceField.type.name)
        || nativeField.visibility !== sourceField.visibility
        || nativeField.readonlyField !== sourceField.readonly
      ) {
        throw new Error(
          `native semantic shadow field mismatch for ${JSON.stringify(`${source.declaration.name}.${field.name}`)} resolved at ${callSite(location, sourceBatch)}`,
        );
      }
      fields += 1;
    },
    onEnumVariantResolution: ({ location, enumeration, variant }) => {
      const source = sourceEnum(sourceEnums, modulePaths, enumeration);
      if (!source) return;
      const sourceVariant = source.declaration.variants.find((candidate) => candidate.name === variant.name);
      const native = index.symbol(source.modulePath, source.declaration.name);
      const nativeVariant = native?.typeSignature?.variants.find((candidate) => candidate.name === variant.name);
      if (
        native?.kind !== "enum"
        || !sourceVariant
        || !nativeVariant
        || nativeVariant.payloadType !== (sourceVariant.payload ? canonicalTypeName(sourceVariant.payload.name) : null)
      ) {
        throw new Error(
          `native semantic shadow enum variant mismatch for ${JSON.stringify(`${source.declaration.name}.${variant.name}`)} resolved at ${callSite(location, sourceBatch)}`,
        );
      }
      enumVariants += 1;
    },
  };
  return {
    observer,
    functionCount: () => functions,
    methodCount: () => methods,
    constructorCount: () => constructors,
    aggregateCount: () => aggregates,
    fieldCount: () => fields,
    enumVariantCount: () => enumVariants,
  };
}

function sourceEnum(
  sourceEnums: ReadonlyMap<string, { readonly modulePath: string; readonly declaration: EnumDeclaration }>,
  modulePaths: ReadonlySet<string>,
  declaration: EnumDeclaration,
): { readonly modulePath: string; readonly declaration: EnumDeclaration } | null {
  const definitionPath = declaration.location.fileName;
  if (!definitionPath || !modulePaths.has(definitionPath)) return null;
  return sourceEnums.get(definitionKey(definitionPath, declaration)) ?? null;
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

function definitionKey(modulePath: string, declaration: FunctionDeclaration | StructDeclaration | EnumDeclaration): string {
  return `${modulePath}\0${declaration.location.line}\0${declaration.location.column}`;
}
