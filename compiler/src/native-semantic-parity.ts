import { canonicalTypeName } from "./canonical-type-name.ts";
import type { FunctionDeclaration, StructDeclaration } from "./ast.ts";
import type { SourceModuleBatch, SourceModuleBatchModule } from "./modules.ts";
import { NativeSemanticIndex } from "./native-semantic-index.ts";
import type { Stage1ModuleFunctionSignature, Stage1ModuleGraph, Stage1ModuleSymbol } from "./self-hosting.ts";

export type NativeSemanticEvidence = {
  readonly stage0Graph: Stage1ModuleGraph;
  readonly index: NativeSemanticIndex;
  readonly queryCount: number;
};

export function stage0FunctionSignature(declaration: FunctionDeclaration): Stage1ModuleFunctionSignature {
  return {
    asynchronous: declaration.async ?? false,
    typeParameters: declaration.typeParameters ?? [],
    typeParameterConstraints: (declaration.typeParameterConstraints ?? []).flatMap((constraint) => (
      constraint.traits.map((trait) => ({
        parameter: constraint.parameter,
        traitName: canonicalTypeName(trait.name),
      }))
    )),
    parameterModes: declaration.parameters.map((parameter) => parameter.mode),
    parameterTypes: declaration.parameters.map((parameter) => canonicalTypeName(parameter.type.name)),
    returnType: canonicalTypeName(declaration.returnType.name),
    errorType: declaration.errorType ? canonicalTypeName(declaration.errorType.name) : null,
  };
}

export function stage0ConstructorSignature(declaration: StructDeclaration): Stage1ModuleFunctionSignature | null {
  if (!declaration.constructor) return null;
  return {
    asynchronous: false,
    typeParameters: [],
    typeParameterConstraints: [],
    parameterModes: declaration.constructor.parameters.map((parameter) => parameter.mode),
    parameterTypes: declaration.constructor.parameters.map((parameter) => canonicalTypeName(parameter.type.name)),
    returnType: canonicalTypeName(declaration.name),
    errorType: declaration.constructor.errorType
      ? canonicalTypeName(declaration.constructor.errorType.name)
      : null,
  };
}

export function validateNativeFrontendSemantics(
  sourceBatch: SourceModuleBatch,
  nativeGraph: Stage1ModuleGraph,
): NativeSemanticEvidence {
  const stage0Graph = buildStage0ModuleGraph(sourceBatch);
  if (!sameModuleGraph(stage0Graph, nativeGraph)) {
    throw new Error(
      `native frontend module graph mismatch: stage 0 produced ${JSON.stringify(stage0Graph)}, native frontend produced ${JSON.stringify(nativeGraph)}`,
    );
  }
  const index = new NativeSemanticIndex(nativeGraph, sourceBatch);
  const queryCount = assertNativeSemanticQueryParity(stage0Graph, index);
  return { stage0Graph, index, queryCount };
}

export function buildStage0ModuleGraph(sourceBatch: SourceModuleBatch): Stage1ModuleGraph {
  const indexByPath = new Map(sourceBatch.modules.map((module, index) => [module.fileName, index] as const));
  const modules = sourceBatch.modules.map((module) => {
    const dependencies = [...module.dependencies.values()].map((dependencyPath) => {
      const dependency = indexByPath.get(dependencyPath);
      if (dependency === undefined) throw new Error(`stage-0 parity batch is missing ${dependencyPath}`);
      return dependency;
    });
    return {
      path: module.fileName,
      dependencies,
      symbols: stage0ModuleSymbols(module, indexByPath),
      callResolutions: [],
      bindingResolutions: [],
      expressionResolutions: [],
    };
  });
  const entry = indexByPath.get(sourceBatch.entryFileName);
  if (entry === undefined) throw new Error(`stage-0 parity batch is missing its entry ${sourceBatch.entryFileName}`);
  const dependencyOrder: number[] = [];
  const visited = new Set<number>();
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    for (const dependency of modules[index].dependencies) visit(dependency);
    dependencyOrder.push(index);
  };
  visit(entry);
  return { modules, dependencyOrder, entry };
}

function stage0ModuleSymbols(
  module: SourceModuleBatchModule,
  indexByPath: ReadonlyMap<string, number>,
): Stage1ModuleSymbol[] {
  const { program } = module;
  const exported = new Set(program.exports.map((declaration) => `${declaration.declarationKind}\0${declaration.name}`));
  const symbols: Stage1ModuleSymbol[] = [
    ...program.typeAliases,
    ...program.traits,
    ...program.structs,
    ...program.enums,
    ...program.functions,
  ].map((declaration) => ({
    name: declaration.name,
    kind: declaration.kind,
    exported: exported.has(`${declaration.kind}\0${declaration.name}`),
    targetModule: null,
    importedName: declaration.kind === "type" ? canonicalTypeName(declaration.target.name) : declaration.name,
    functionSignature: declaration.kind === "function" ? stage0FunctionSignature(declaration) : null,
    typeSignature: declaration.kind === "struct" || declaration.kind === "class" ? {
      typeParameters: declaration.typeParameters ?? [],
      typeParameterConstraints: (declaration.typeParameterConstraints ?? []).flatMap((constraint) => (
        constraint.traits.map((trait) => ({
          parameter: constraint.parameter,
          traitName: canonicalTypeName(trait.name),
        }))
      )),
      implementedTraits: declaration.implements.map((trait) => canonicalTypeName(trait.name)),
      fields: declaration.fields.map((field) => ({
        name: field.name,
        typeName: canonicalTypeName(field.type.name),
        visibility: field.visibility,
        readonlyField: field.readonly,
      })),
      methods: declaration.methods.map((method) => ({
        name: method.name,
        staticMethod: method.static ?? false,
        visibility: method.visibility ?? "public",
        receiverMode: method.receiverMode ?? "in",
        signature: {
          asynchronous: method.async ?? false,
          typeParameters: method.typeParameters ?? [],
          typeParameterConstraints: (method.typeParameterConstraints ?? []).flatMap((constraint) => (
            constraint.traits.map((trait) => ({
              parameter: constraint.parameter,
              traitName: canonicalTypeName(trait.name),
            }))
          )),
          parameterModes: method.parameters.map((parameter) => parameter.mode),
          parameterTypes: method.parameters.map((parameter) => canonicalTypeName(parameter.type.name)),
          returnType: canonicalTypeName(method.returnType.name),
          errorType: method.errorType ? canonicalTypeName(method.errorType.name) : null,
        },
      })),
      variants: [],
      customDeinit: Boolean(declaration.deinitializer),
      customConstructor: Boolean(declaration.constructor),
      constructorSignature: stage0ConstructorSignature(declaration),
    } : declaration.kind === "trait" ? {
      typeParameters: declaration.typeParameters ?? [],
      typeParameterConstraints: (declaration.typeParameterConstraints ?? []).flatMap((constraint) => (
        constraint.traits.map((trait) => ({
          parameter: constraint.parameter,
          traitName: canonicalTypeName(trait.name),
        }))
      )),
      implementedTraits: [],
      fields: [],
      methods: declaration.methods.map((method) => ({
        name: method.name,
        staticMethod: false,
        visibility: "public",
        receiverMode: method.receiverMode ?? "in",
        signature: stage0FunctionSignature(method),
      })),
      variants: [],
      customDeinit: false,
      customConstructor: false,
      constructorSignature: null,
    } : declaration.kind === "enum" ? {
      typeParameters: [],
      typeParameterConstraints: [],
      implementedTraits: [],
      fields: [],
      methods: [],
      variants: declaration.variants.map((variant) => ({
        name: variant.name,
        payloadType: variant.payload ? canonicalTypeName(variant.payload.name) : null,
      })),
      customDeinit: false,
      customConstructor: false,
      constructorSignature: null,
    } : null,
    location: {
      offset: declaration.location.offset,
      line: declaration.location.line,
      column: declaration.location.column,
    },
  })).sort((left, right) => left.location.offset - right.location.offset);
  for (const declaration of program.imports) {
    const dependencyPath = module.dependencies.get(declaration.location.offset);
    const targetModule = dependencyPath ? indexByPath.get(dependencyPath) ?? null : null;
    if (declaration.bindings) {
      for (const binding of declaration.bindings) {
        symbols.push({
          name: binding.localName,
          kind: "imported",
          exported: false,
          targetModule,
          importedName: binding.importedName,
          functionSignature: null,
          typeSignature: null,
          location: {
            offset: binding.location.offset,
            line: binding.location.line,
            column: binding.location.column,
          },
        });
      }
    } else {
      symbols.push({
        name: declaration.moduleName,
        kind: "namespace",
        exported: false,
        targetModule,
        importedName: declaration.header,
        functionSignature: null,
        typeSignature: null,
        location: {
          offset: declaration.location.offset,
          line: declaration.location.line,
          column: declaration.location.column,
        },
      });
    }
  }
  return symbols;
}

function assertNativeSemanticQueryParity(stage0Graph: Stage1ModuleGraph, index: NativeSemanticIndex): number {
  let queries = 0;
  for (const module of stage0Graph.modules) {
    for (const symbol of module.symbols) {
      const indexedBinding = index.symbol(module.path, symbol.name);
      queries += 1;
      if (!sameModuleSymbol(symbol, indexedBinding ?? undefined)) {
        throw new Error(
          `native semantic binding query mismatch for ${JSON.stringify(symbol.name)} in ${module.path}`,
        );
      }
      if (symbol.kind === "namespace" && symbol.targetModule !== null) {
        for (const exported of stage0Graph.modules[symbol.targetModule].symbols.filter((candidate) => candidate.exported)) {
          const resolved = index.resolveNamespaceMember(module.path, symbol.name, exported.name);
          queries += 1;
          if (!resolved || !sameModuleSymbol(exported, resolved.declaration)) {
            throw new Error(
              `native semantic namespace query mismatch for ${symbol.name}.${exported.name} in ${module.path}`,
            );
          }
        }
        continue;
      }
      const resolved = index.resolveSymbol(module.path, symbol.name);
      queries += 1;
      const expected = symbol.kind === "imported" && symbol.targetModule !== null
        ? stage0Graph.modules[symbol.targetModule].symbols.find((candidate) => (
          candidate.exported && candidate.name === symbol.importedName
        ))
        : symbol;
      if (!expected) {
        if (resolved !== null) {
          throw new Error(`native semantic query unexpectedly resolved ${JSON.stringify(symbol.name)} in ${module.path}`);
        }
      } else if (!resolved || !sameModuleSymbol(expected, resolved.declaration)) {
        throw new Error(`native semantic query mismatch for ${JSON.stringify(symbol.name)} in ${module.path}`);
      }
    }
  }
  return queries;
}

function sameModuleGraph(left: Stage1ModuleGraph, right: Stage1ModuleGraph): boolean {
  return left.entry === right.entry
    && left.dependencyOrder.length === right.dependencyOrder.length
    && left.dependencyOrder.every((value, index) => value === right.dependencyOrder[index])
    && left.modules.length === right.modules.length
    && left.modules.every((module, index) => {
      const other = right.modules[index];
      return other !== undefined
        && module.path === other.path
        && module.dependencies.length === other.dependencies.length
        && module.dependencies.every((value, dependencyIndex) => value === other.dependencies[dependencyIndex])
        && module.symbols.length === other.symbols.length
        && module.symbols.every((symbol, symbolIndex) => sameModuleSymbol(symbol, other.symbols[symbolIndex]));
    });
}

function sameModuleSymbol(left: Stage1ModuleSymbol, right: Stage1ModuleSymbol | undefined): boolean {
  return right !== undefined
    && left.name === right.name
    && left.kind === right.kind
    && left.exported === right.exported
    && left.targetModule === right.targetModule
    && left.importedName === right.importedName
    && sameModuleFunctionSignature(left.functionSignature, right.functionSignature)
    && sameModuleTypeSignature(left.typeSignature, right.typeSignature)
    && left.location.offset === right.location.offset
    && left.location.line === right.location.line
    && left.location.column === right.location.column;
}

function sameModuleTypeSignature(
  left: Stage1ModuleSymbol["typeSignature"],
  right: Stage1ModuleSymbol["typeSignature"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.customDeinit === right.customDeinit
    && left.customConstructor === right.customConstructor
    && sameModuleFunctionSignature(left.constructorSignature, right.constructorSignature)
    && left.typeParameters.length === right.typeParameters.length
    && left.typeParameters.every((value, index) => value === right.typeParameters[index])
    && sameTypeParameterConstraints(left.typeParameterConstraints, right.typeParameterConstraints)
    && left.implementedTraits.length === right.implementedTraits.length
    && left.implementedTraits.every((value, index) => value === right.implementedTraits[index])
    && left.fields.length === right.fields.length
    && left.fields.every((field, index) => {
      const other = right.fields[index];
      return other !== undefined
        && field.name === other.name
        && field.typeName === other.typeName
        && field.visibility === other.visibility
        && field.readonlyField === other.readonlyField;
    })
    && left.methods.length === right.methods.length
    && left.methods.every((method, index) => {
      const other = right.methods[index];
      return other !== undefined
        && method.name === other.name
        && method.staticMethod === other.staticMethod
        && method.visibility === other.visibility
        && method.receiverMode === other.receiverMode
        && sameModuleFunctionSignature(method.signature, other.signature);
    })
    && left.variants.length === right.variants.length
    && left.variants.every((variant, index) => {
      const other = right.variants[index];
      return other !== undefined
        && variant.name === other.name
        && variant.payloadType === other.payloadType;
    });
}

export function sameModuleFunctionSignature(
  left: Stage1ModuleSymbol["functionSignature"],
  right: Stage1ModuleSymbol["functionSignature"],
): boolean {
  if (left === null || right === null) return left === right;
  return left.asynchronous === right.asynchronous
    && left.returnType === right.returnType
    && left.errorType === right.errorType
    && left.typeParameters.length === right.typeParameters.length
    && left.typeParameters.every((value, index) => value === right.typeParameters[index])
    && sameTypeParameterConstraints(left.typeParameterConstraints, right.typeParameterConstraints)
    && left.parameterModes.length === right.parameterModes.length
    && left.parameterModes.every((value, index) => value === right.parameterModes[index])
    && left.parameterTypes.length === right.parameterTypes.length
    && left.parameterTypes.every((value, index) => value === right.parameterTypes[index]);
}

function sameTypeParameterConstraints(
  left: Stage1ModuleFunctionSignature["typeParameterConstraints"],
  right: Stage1ModuleFunctionSignature["typeParameterConstraints"],
): boolean {
  return left.length === right.length
    && left.every((constraint, index) => (
      constraint.parameter === right[index]?.parameter
      && constraint.traitName === right[index]?.traitName
    ));
}
