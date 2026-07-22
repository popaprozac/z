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

export type NativeSemanticBridge = {
  readonly observer: SemanticObserver;
  readonly functionCount: () => number;
  readonly methodCount: () => number;
  readonly constructorCount: () => number;
  readonly aggregateCount: () => number;
  readonly fieldCount: () => number;
  readonly enumVariantCount: () => number;
  readonly typeCount: () => number;
  readonly authoritativeFunctionCount: () => number;
  readonly authoritativeMethodCount: () => number;
  readonly authoritativeConstructorCount: () => number;
  readonly authoritativeAggregateCount: () => number;
  readonly authoritativeFieldCount: () => number;
  readonly authoritativeEnumVariantCount: () => number;
  readonly authoritativeTypeCount: () => number;
};

export function createNativeSemanticBridge(
  sourceBatch: SourceModuleBatch,
  index: NativeSemanticIndex,
): NativeSemanticBridge {
  const sourceFunctions = new Map<string, { readonly modulePath: string; readonly declaration: FunctionDeclaration }>();
  const sourceAggregates = new Map<string, { readonly modulePath: string; readonly declaration: StructDeclaration }>();
  const sourceEnums = new Map<string, { readonly modulePath: string; readonly declaration: EnumDeclaration }>();
  const canonicalModulePathBySourcePath = new Map<string, string>();
  for (const module of sourceBatch.modules) {
    canonicalModulePathBySourcePath.set(module.fileName, module.fileName);
    for (const declaration of [
      ...module.program.imports,
      ...module.program.traits,
      ...module.program.structs,
      ...module.program.enums,
      ...module.program.functions,
    ]) {
      if (declaration.location.fileName) {
        canonicalModulePathBySourcePath.set(declaration.location.fileName, module.fileName);
      }
    }
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
  let types = 0;
  let authoritativeFunctions = 0;
  let authoritativeMethods = 0;
  let authoritativeConstructors = 0;
  let authoritativeAggregates = 0;
  let authoritativeFields = 0;
  let authoritativeEnumVariants = 0;
  let authoritativeTypes = 0;
  const nativeFunction = (location: FunctionDeclaration["location"], declaration: FunctionDeclaration) => {
    const definitionPath = declaration.location.fileName;
    const canonicalDefinitionPath = definitionPath
      ? canonicalModulePathBySourcePath.get(definitionPath)
      : null;
    if (!canonicalDefinitionPath) return null;
    const source = sourceFunctions.get(definitionKey(canonicalDefinitionPath, declaration));
    if (!source) return null;
    const native = index.symbol(source.modulePath, source.declaration.name);
    if (native?.kind !== "function" || !native.functionSignature) {
      throw new Error(
        `native semantic bridge could not resolve function ${JSON.stringify(source.declaration.name)} in ${source.modulePath}`,
      );
    }
    const expected = stage0FunctionSignature(source.declaration);
    if (!sameModuleFunctionSignature(expected, native.functionSignature)) {
      throw new Error(
        `native semantic bridge signature mismatch for ${JSON.stringify(source.declaration.name)} called at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, native };
  };
  const nativeMethod = (
    location: FunctionDeclaration["location"],
    aggregate: StructDeclaration,
    declaration: FunctionDeclaration,
  ) => {
    const source = sourceAggregate(sourceAggregates, canonicalModulePathBySourcePath, aggregate);
    if (!source) return null;
    const native = index.symbol(source.modulePath, source.declaration.name);
    const sourceMethod = source.declaration.methods.find((candidate) =>
      Boolean(candidate.static) === Boolean(declaration.static)
      && (
        candidate.name === declaration.name
        || (
          candidate.location.line === declaration.location.line
          && candidate.location.column === declaration.location.column
        )
      )
    );
    const method = native?.typeSignature?.methods.find((candidate) => candidate.name === sourceMethod?.name);
    if (!native || (native.kind !== "struct" && native.kind !== "class") || !method || !sourceMethod) {
      throw new Error(
        `native semantic bridge could not resolve method ${JSON.stringify(`${source.declaration.name}.${declaration.name}`)} in ${source.modulePath}`,
      );
    }
    if (
      method.staticMethod !== Boolean(sourceMethod.static)
      || method.visibility !== (sourceMethod.visibility ?? "public")
      || method.receiverMode !== (sourceMethod.receiverMode ?? "in")
      || !sameModuleFunctionSignature(stage0FunctionSignature(sourceMethod), method.signature)
    ) {
      throw new Error(
        `native semantic bridge signature mismatch for ${JSON.stringify(`${source.declaration.name}.${declaration.name}`)} called at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, sourceMethod, method };
  };
  const nativeConstructor = (location: FunctionDeclaration["location"], aggregate: StructDeclaration) => {
    const source = sourceAggregate(sourceAggregates, canonicalModulePathBySourcePath, aggregate);
    if (!source) return null;
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
        `native semantic bridge constructor mismatch for ${JSON.stringify(source.declaration.name)} called at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, signature: native.typeSignature.constructorSignature! };
  };
  const nativeAggregate = (location: StructDeclaration["location"], declaration: StructDeclaration) => {
    const source = sourceAggregate(sourceAggregates, canonicalModulePathBySourcePath, declaration);
    if (!source) return null;
    const native = index.symbol(source.modulePath, source.declaration.name);
    if (
      !native
      || (native.kind !== "struct" && native.kind !== "class")
      || native.kind !== source.declaration.kind
      || !native.typeSignature
      || native.typeSignature.customConstructor !== Boolean(source.declaration.constructor)
      || native.typeSignature.customDeinit !== Boolean(source.declaration.deinitializer)
    ) {
      throw new Error(
        `native semantic bridge aggregate mismatch for ${JSON.stringify(source.declaration.name)} constructed at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, native };
  };
  const nativeField = (
    location: StructDeclaration["location"],
    aggregate: StructDeclaration,
    field: StructDeclaration["fields"][number],
  ) => {
    const source = sourceAggregate(sourceAggregates, canonicalModulePathBySourcePath, aggregate);
    if (!source) return null;
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
        `native semantic bridge field mismatch for ${JSON.stringify(`${source.declaration.name}.${field.name}`)} resolved at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, sourceField, nativeField };
  };
  const nativeEnumVariant = (
    location: EnumDeclaration["location"],
    enumeration: EnumDeclaration,
    variant: EnumDeclaration["variants"][number],
  ) => {
    const source = sourceEnum(sourceEnums, canonicalModulePathBySourcePath, enumeration);
    if (!source) return null;
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
        `native semantic bridge enum variant mismatch for ${JSON.stringify(`${source.declaration.name}.${variant.name}`)} resolved at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, sourceVariant, nativeVariant };
  };
  const nativeType = (
    location: StructDeclaration["location"],
    declaration: StructDeclaration | EnumDeclaration,
  ) => {
    const source = declaration.kind === "enum"
      ? sourceEnum(sourceEnums, canonicalModulePathBySourcePath, declaration)
      : sourceAggregate(sourceAggregates, canonicalModulePathBySourcePath, declaration);
    if (!source) return null;
    const native = index.symbol(source.modulePath, source.declaration.name);
    if (native?.kind !== source.declaration.kind || !native.typeSignature) {
      throw new Error(
        `native semantic bridge type mismatch for ${JSON.stringify(source.declaration.name)} resolved at ${callSite(location, sourceBatch)}`,
      );
    }
    return { source, native };
  };
  const observer: SemanticObserver = {
    resolveFunctionCall: ({ location, declaration }) => {
      const resolved = nativeFunction(location, declaration);
      if (!resolved) return null;
      if ((resolved.source.declaration.typeParameters?.length ?? 0) > 0) {
        const callPath = canonicalModulePathBySourcePath.get(
          location.fileName ?? sourceBatch.entryFileName,
        );
        if (!callPath) return null;
        const resolution = index.callResolution(
          callPath,
          location.offset,
        );
        if (!resolution) return null;
        const targetModule = index.graph.modules[resolution.targetModule];
        const target = targetModule?.symbols[resolution.targetSymbol];
        const sourceTypeParameters = resolved.source.declaration.typeParameters ?? [];
        if (
          resolution.kind !== "function"
          || targetModule?.path !== resolved.source.modulePath
          || target?.kind !== "function"
          || target.name !== resolved.source.declaration.name
          || resolution.targetName !== resolved.source.declaration.name
          || resolution.typeParameters.length !== sourceTypeParameters.length
          || !resolution.typeParameters.every((parameter, index) => parameter === sourceTypeParameters[index])
          || resolution.typeArguments.some((argument) => argument.length === 0)
          || !sourceTypeParameters.every((parameter) => typeParameterAffectsCallableContract(
            resolved.source.declaration,
            parameter,
          ))
          || resolution.parameterModes.length !== declaration.parameters.length
          || resolution.parameterTypes.length !== declaration.parameters.length
          || !resolution.parameterModes.every((mode, index) => mode === resolved.native.functionSignature!.parameterModes[index])
          || resolution.asynchronous !== resolved.native.functionSignature.asynchronous
          || !resolution.parameterTypes.every((type, index) => concreteGenericTypeMatches(
            resolved.source.declaration.parameters[index].type.name,
            type,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
          || !concreteGenericTypeMatches(
            resolved.source.declaration.returnType.name,
            resolution.returnType,
            resolution.typeParameters,
            resolution.typeArguments,
          )
          || (resolution.errorType === null) !== (declaration.errorType === null)
          || (resolution.errorType !== null && !concreteGenericTypeMatches(
            resolved.source.declaration.errorType!.name,
            resolution.errorType,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
        ) return null;
        authoritativeFunctions += 1;
        return {
          ...declaration,
          async: resolution.asynchronous,
          typeParameters: [],
          parameters: declaration.parameters.map((parameter, index) => ({
            ...parameter,
            mode: resolution.parameterModes[index],
            type: {
              ...parameter.type,
              name: rebaseConcreteGenericType(
                resolved.source.declaration.parameters[index].type.name,
                resolution.parameterTypes[index],
                parameter.type.name,
                resolution.typeParameters,
                resolution.typeArguments,
              ),
            },
          })),
          returnType: {
            ...declaration.returnType,
            name: rebaseConcreteGenericType(
              resolved.source.declaration.returnType.name,
              resolution.returnType,
              declaration.returnType.name,
              resolution.typeParameters,
              resolution.typeArguments,
            ),
          },
          errorType: resolution.errorType === null ? null : {
            ...declaration.errorType!,
            name: rebaseConcreteGenericType(
              resolved.source.declaration.errorType!.name,
              resolution.errorType,
              declaration.errorType!.name,
              resolution.typeParameters,
              resolution.typeArguments,
            ),
          },
        };
      }
      const signature = resolved.native.functionSignature!;
      if (signature.parameterModes.length !== declaration.parameters.length) {
        throw new Error(
          `native semantic bridge cannot lower ${JSON.stringify(resolved.source.declaration.name)} into its linked stage-0 declaration`,
        );
      }
      if (signature.errorType !== null && !declaration.errorType) {
        throw new Error(
          `native semantic bridge cannot rebase the error type of ${JSON.stringify(resolved.source.declaration.name)}`,
        );
      }
      authoritativeFunctions += 1;
      return {
        ...declaration,
        async: signature.asynchronous,
        typeParameters: [],
        parameters: declaration.parameters.map((parameter, index) => ({
          ...parameter,
          mode: signature.parameterModes[index],
          type: {
            ...parameter.type,
            name: rebaseNativeType(
              signature.parameterTypes[index],
              resolved.source.declaration.parameters[index].type.name,
              parameter.type.name,
            ),
          },
        })),
        returnType: {
          ...declaration.returnType,
          name: rebaseNativeType(
            signature.returnType,
            resolved.source.declaration.returnType.name,
            declaration.returnType.name,
          ),
        },
        errorType: signature.errorType === null ? null : {
          ...declaration.errorType!,
          name: rebaseNativeType(
            signature.errorType,
            resolved.source.declaration.errorType!.name,
            declaration.errorType!.name,
          ),
        },
      };
    },
    resolveMethodCall: ({ location, aggregate, declaration }) => {
      const resolved = nativeMethod(location, aggregate, declaration);
      if (!resolved) return null;
      const ownerTypeParameters = resolved.source.declaration.typeParameters ?? [];
      const methodTypeParameters = resolved.sourceMethod.typeParameters ?? [];
      const typeParameters = [...ownerTypeParameters, ...methodTypeParameters];
      if (typeParameters.length > 0) {
        const callPath = canonicalModulePathBySourcePath.get(
          location.fileName ?? sourceBatch.entryFileName,
        );
        if (!callPath) return null;
        const resolution = index.callResolution(callPath, location.offset);
        if (!resolution) return null;
        const targetModule = index.graph.modules[resolution.targetModule];
        const target = targetModule?.symbols[resolution.targetSymbol];
        const expectedTargetName = `${resolved.source.declaration.name}.${resolved.sourceMethod.name}`;
        if (
          resolution.kind !== "method"
          || targetModule?.path !== resolved.source.modulePath
          || (target?.kind !== "struct" && target?.kind !== "class")
          || target.name !== resolved.source.declaration.name
          || resolution.targetName !== expectedTargetName
          || resolution.typeParameters.length !== typeParameters.length
          || !resolution.typeParameters.every((parameter, index) => parameter === typeParameters[index])
          || resolution.typeArguments.some((argument) => argument.length === 0)
          || resolution.parameterModes.length !== declaration.parameters.length
          || resolution.parameterTypes.length !== declaration.parameters.length
          || !resolution.parameterModes.every((mode, index) => mode === resolved.method.signature.parameterModes[index])
          || normalizeRecordedReceiverMode(resolution.receiverMode) !== resolved.method.receiverMode
          || resolution.asynchronous !== resolved.method.signature.asynchronous
          || !resolution.parameterTypes.every((type, index) => concreteGenericTypeMatches(
            resolved.sourceMethod.parameters[index].type.name,
            type,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
          || !concreteGenericTypeMatches(
            resolved.sourceMethod.returnType.name,
            resolution.returnType,
            resolution.typeParameters,
            resolution.typeArguments,
          )
          || (resolution.errorType === null) !== (resolved.sourceMethod.errorType === null)
          || (resolution.errorType === null) !== (declaration.errorType === null)
          || (resolution.errorType !== null && !concreteGenericTypeMatches(
            resolved.sourceMethod.errorType!.name,
            resolution.errorType,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
        ) return null;
        authoritativeMethods += 1;
        return {
          ...declaration,
          async: resolution.asynchronous,
          static: resolved.method.staticMethod,
          visibility: resolved.method.visibility,
          receiverMode: resolved.method.receiverMode === "in" ? null : resolved.method.receiverMode,
          typeParameters: [],
          parameters: declaration.parameters.map((parameter, index) => ({
            ...parameter,
            mode: resolution.parameterModes[index],
            type: {
              ...parameter.type,
              name: rebaseConcreteGenericType(
                resolved.sourceMethod.parameters[index].type.name,
                resolution.parameterTypes[index],
                parameter.type.name,
                resolution.typeParameters,
                resolution.typeArguments,
              ),
            },
          })),
          returnType: {
            ...declaration.returnType,
            name: rebaseConcreteGenericType(
              resolved.sourceMethod.returnType.name,
              resolution.returnType,
              declaration.returnType.name,
              resolution.typeParameters,
              resolution.typeArguments,
            ),
          },
          errorType: resolution.errorType === null ? null : {
            ...declaration.errorType!,
            name: rebaseConcreteGenericType(
              resolved.sourceMethod.errorType!.name,
              resolution.errorType,
              declaration.errorType!.name,
              resolution.typeParameters,
              resolution.typeArguments,
            ),
          },
        };
      }
      const signature = resolved.method.signature;
      if (signature.parameterModes.length !== declaration.parameters.length) {
        throw new Error(
          `native semantic bridge cannot lower ${JSON.stringify(`${resolved.source.declaration.name}.${resolved.sourceMethod.name}`)} into its linked stage-0 declaration`,
        );
      }
      if (signature.errorType !== null && !declaration.errorType) {
        throw new Error(
          `native semantic bridge cannot rebase the error type of ${JSON.stringify(`${resolved.source.declaration.name}.${resolved.sourceMethod.name}`)}`,
        );
      }
      authoritativeMethods += 1;
      return {
        ...declaration,
        async: signature.asynchronous,
        static: resolved.method.staticMethod,
        visibility: resolved.method.visibility,
        receiverMode: resolved.method.receiverMode === "in" ? null : resolved.method.receiverMode,
        typeParameters: [],
        parameters: declaration.parameters.map((parameter, index) => ({
          ...parameter,
          mode: signature.parameterModes[index],
          type: {
            ...parameter.type,
            name: rebaseNativeType(
              signature.parameterTypes[index],
              resolved.sourceMethod.parameters[index].type.name,
              parameter.type.name,
            ),
          },
        })),
        returnType: {
          ...declaration.returnType,
          name: rebaseNativeType(
            signature.returnType,
            resolved.sourceMethod.returnType.name,
            declaration.returnType.name,
          ),
        },
        errorType: signature.errorType === null ? null : {
          ...declaration.errorType!,
          name: rebaseNativeType(
            signature.errorType,
            resolved.sourceMethod.errorType!.name,
            declaration.errorType!.name,
          ),
        },
      };
    },
    resolveConstructorCall: ({ location, aggregate, declaration }) => {
      const resolved = nativeConstructor(location, aggregate);
      if (!resolved) return null;
      const sourceConstructor = resolved.source.declaration.constructor!;
      const typeParameters = resolved.source.declaration.typeParameters ?? [];
      if (typeParameters.length > 0) {
        const callPath = canonicalModulePathBySourcePath.get(
          location.fileName ?? sourceBatch.entryFileName,
        );
        if (!callPath) return null;
        const resolution = index.callResolution(callPath, location.offset);
        if (!resolution) return null;
        const targetModule = index.graph.modules[resolution.targetModule];
        const target = targetModule?.symbols[resolution.targetSymbol];
        if (
          resolution.kind !== "constructor"
          || targetModule?.path !== resolved.source.modulePath
          || target?.kind !== "class"
          || target.name !== resolved.source.declaration.name
          || resolution.targetName !== `${resolved.source.declaration.name}.constructor`
          || resolution.typeParameters.length !== typeParameters.length
          || !resolution.typeParameters.every((parameter, index) => parameter === typeParameters[index])
          || resolution.typeArguments.some((argument) => argument.length === 0)
          || resolution.parameterModes.length !== declaration.parameters.length
          || resolution.parameterTypes.length !== declaration.parameters.length
          || !resolution.parameterModes.every((mode, index) => mode === resolved.signature.parameterModes[index])
          || resolution.asynchronous !== resolved.signature.asynchronous
          || !resolution.parameterTypes.every((type, index) => concreteGenericTypeMatches(
            sourceConstructor.parameters[index].type.name,
            type,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
          || !concreteGenericOwnerMatches(
            index,
            callPath,
            resolution.returnType,
            resolved.source.modulePath,
            resolved.source.declaration.name,
            resolution.typeArguments,
          )
          || (resolution.errorType === null) !== (sourceConstructor.errorType === null)
          || (resolution.errorType === null) !== (declaration.errorType === null)
          || (resolution.errorType !== null && !concreteGenericTypeMatches(
            sourceConstructor.errorType!.name,
            resolution.errorType,
            resolution.typeParameters,
            resolution.typeArguments,
          ))
        ) return null;
        authoritativeConstructors += 1;
        return {
          ...declaration,
          async: resolution.asynchronous,
          typeParameters: [],
          parameters: declaration.parameters.map((parameter, index) => ({
            ...parameter,
            mode: resolution.parameterModes[index],
            type: {
              ...parameter.type,
              name: rebaseConcreteGenericType(
                sourceConstructor.parameters[index].type.name,
                resolution.parameterTypes[index],
                parameter.type.name,
                resolution.typeParameters,
                resolution.typeArguments,
              ),
            },
          })),
          returnType: {
            ...declaration.returnType,
            name: declaration.returnType.name,
          },
          errorType: resolution.errorType === null ? null : {
            ...declaration.errorType!,
            name: rebaseConcreteGenericType(
              sourceConstructor.errorType!.name,
              resolution.errorType,
              declaration.errorType!.name,
              resolution.typeParameters,
              resolution.typeArguments,
            ),
          },
        };
      }
      const signature = resolved.signature;
      if (signature.parameterModes.length !== declaration.parameters.length) {
        throw new Error(
          `native semantic bridge cannot lower the constructor for ${JSON.stringify(resolved.source.declaration.name)} into its linked stage-0 declaration`,
        );
      }
      if (signature.errorType !== null && !declaration.errorType) {
        throw new Error(
          `native semantic bridge cannot rebase the constructor error type of ${JSON.stringify(resolved.source.declaration.name)}`,
        );
      }
      authoritativeConstructors += 1;
      return {
        ...declaration,
        async: signature.asynchronous,
        typeParameters: [],
        parameters: declaration.parameters.map((parameter, index) => ({
          ...parameter,
          mode: signature.parameterModes[index],
          type: {
            ...parameter.type,
            name: rebaseNativeType(
              signature.parameterTypes[index],
              sourceConstructor.parameters[index].type.name,
              parameter.type.name,
            ),
          },
        })),
        returnType: {
          ...declaration.returnType,
          name: rebaseNativeType(
            signature.returnType,
            resolved.source.declaration.name,
            declaration.returnType.name,
          ),
        },
        errorType: signature.errorType === null ? null : {
          ...declaration.errorType!,
          name: rebaseNativeType(
            signature.errorType,
            sourceConstructor.errorType!.name,
            declaration.errorType!.name,
          ),
        },
      };
    },
    resolveAggregateConstruction: ({ location, declaration }) => {
      const resolved = nativeAggregate(location, declaration);
      if (!resolved) return null;
      authoritativeAggregates += 1;
      return {
        ...declaration,
        kind: resolved.native.kind,
        typeParameters: [],
        fields: declaration.fields.map((field) => {
          const sourceField = resolved.source.declaration.fields.find((candidate) => candidate.name === field.name);
          const nativeField = resolved.native.typeSignature!.fields.find((candidate) => candidate.name === field.name);
          if (!sourceField || !nativeField) {
            throw new Error(
              `native semantic bridge cannot lower field ${JSON.stringify(`${resolved.source.declaration.name}.${field.name}`)} into its linked stage-0 declaration`,
            );
          }
          return {
            ...field,
            visibility: nativeField.visibility,
            readonly: nativeField.readonlyField,
            type: {
              ...field.type,
              name: rebaseNativeType(nativeField.typeName, sourceField.type.name, field.type.name),
            },
          };
        }),
      };
    },
    resolveField: ({ location, aggregate, field }) => {
      const resolved = nativeField(location, aggregate, field);
      if (!resolved) return null;
      authoritativeFields += 1;
      return {
        ...field,
        visibility: resolved.nativeField.visibility,
        readonly: resolved.nativeField.readonlyField,
        type: {
          ...field.type,
          name: rebaseNativeType(
            resolved.nativeField.typeName,
            resolved.sourceField.type.name,
            field.type.name,
          ),
        },
      };
    },
    resolveEnumVariant: ({ location, enumeration, variant }) => {
      const resolved = nativeEnumVariant(location, enumeration, variant);
      if (!resolved) return null;
      authoritativeEnumVariants += 1;
      return {
        ...variant,
        payload: resolved.nativeVariant.payloadType === null ? null : {
          ...variant.payload!,
          name: rebaseNativeType(
            resolved.nativeVariant.payloadType,
            resolved.sourceVariant.payload!.name,
            variant.payload!.name,
          ),
        },
      };
    },
    resolveType: ({ location, declaration }) => {
      const resolved = nativeType(location, declaration);
      if (!resolved) return null;
      authoritativeTypes += 1;
      if (declaration.kind === "enum") return { ...declaration, kind: "enum" };
      return {
        ...declaration,
        kind: resolved.native.kind as "struct" | "class",
        typeParameters: [],
      };
    },
    onFunctionCall: ({ location, declaration }) => {
      if (!nativeFunction(location, declaration)) return;
      functions += 1;
    },
    onMethodCall: ({ location, aggregate, declaration }) => {
      if (!nativeMethod(location, aggregate, declaration)) return;
      methods += 1;
    },
    onConstructorCall: ({ location, aggregate }) => {
      if (!nativeConstructor(location, aggregate)) return;
      constructors += 1;
    },
    onAggregateConstruction: ({ location, declaration }) => {
      if (!nativeAggregate(location, declaration)) return;
      aggregates += 1;
    },
    onFieldResolution: ({ location, aggregate, field }) => {
      if (!nativeField(location, aggregate, field)) return;
      fields += 1;
    },
    onEnumVariantResolution: ({ location, enumeration, variant }) => {
      if (!nativeEnumVariant(location, enumeration, variant)) return;
      enumVariants += 1;
    },
    onTypeResolution: ({ location, declaration }) => {
      if (!nativeType(location, declaration)) return;
      types += 1;
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
    typeCount: () => types,
    authoritativeFunctionCount: () => authoritativeFunctions,
    authoritativeMethodCount: () => authoritativeMethods,
    authoritativeConstructorCount: () => authoritativeConstructors,
    authoritativeAggregateCount: () => authoritativeAggregates,
    authoritativeFieldCount: () => authoritativeFields,
    authoritativeEnumVariantCount: () => authoritativeEnumVariants,
    authoritativeTypeCount: () => authoritativeTypes,
  };
}

function sourceEnum(
  sourceEnums: ReadonlyMap<string, { readonly modulePath: string; readonly declaration: EnumDeclaration }>,
  canonicalModulePathBySourcePath: ReadonlyMap<string, string>,
  declaration: EnumDeclaration,
): { readonly modulePath: string; readonly declaration: EnumDeclaration } | null {
  const definitionPath = declaration.location.fileName;
  const canonicalDefinitionPath = definitionPath
    ? canonicalModulePathBySourcePath.get(definitionPath)
    : null;
  return canonicalDefinitionPath
    ? sourceEnums.get(definitionKey(canonicalDefinitionPath, declaration)) ?? null
    : null;
}

function sourceAggregate(
  sourceAggregates: ReadonlyMap<string, { readonly modulePath: string; readonly declaration: StructDeclaration }>,
  canonicalModulePathBySourcePath: ReadonlyMap<string, string>,
  declaration: StructDeclaration,
): { readonly modulePath: string; readonly declaration: StructDeclaration } | null {
  const definitionPath = declaration.location.fileName;
  const canonicalDefinitionPath = definitionPath
    ? canonicalModulePathBySourcePath.get(definitionPath)
    : null;
  return canonicalDefinitionPath
    ? sourceAggregates.get(definitionKey(canonicalDefinitionPath, declaration)) ?? null
    : null;
}

function callSite(location: { readonly fileName?: string; readonly line: number; readonly column: number }, sourceBatch: SourceModuleBatch): string {
  return `${location.fileName ?? sourceBatch.entryFileName}:${location.line}:${location.column}`;
}

function rebaseNativeType(nativeType: string, sourceType: string, linkedType: string): string {
  if (nativeType !== canonicalTypeName(sourceType)) {
    throw new Error(`native semantic bridge cannot rebase ${JSON.stringify(nativeType)} from ${JSON.stringify(sourceType)}`);
  }
  return linkedType;
}

function concreteNativeTypeMatches(nativeType: string, linkedType: string): boolean {
  return normalizeNativeType(nativeType) === normalizeNativeType(canonicalTypeName(linkedType));
}

function typeParameterAffectsCallableContract(declaration: FunctionDeclaration, parameter: string): boolean {
  const contractTypes = [
    ...declaration.parameters.map((item) => item.type.name),
    declaration.returnType.name,
    ...(declaration.errorType ? [declaration.errorType.name] : []),
  ];
  return contractTypes.some((typeName) => (
    typeName.match(/[A-Za-z_][A-Za-z0-9_]*/g)?.includes(parameter) ?? false
  ));
}

function rebaseConcreteNativeType(nativeType: string, linkedType: string): string {
  if (!concreteNativeTypeMatches(nativeType, linkedType)) {
    throw new Error(`native semantic bridge cannot rebase concrete ${JSON.stringify(nativeType)} onto ${JSON.stringify(linkedType)}`);
  }
  return linkedType;
}

function concreteGenericTypeMatches(
  sourceType: string,
  nativeType: string,
  typeParameters: readonly string[],
  typeArguments: readonly string[],
): boolean {
  return normalizeNativeType(nativeType) === normalizeNativeType(
    substituteCanonicalType(sourceType, typeParameters, typeArguments),
  );
}

function rebaseConcreteGenericType(
  sourceType: string,
  nativeType: string,
  linkedType: string,
  typeParameters: readonly string[],
  typeArguments: readonly string[],
): string {
  if (!concreteGenericTypeMatches(sourceType, nativeType, typeParameters, typeArguments)) {
    throw new Error(
      `native semantic bridge cannot rebase concrete generic ${JSON.stringify(nativeType)} from ${JSON.stringify(sourceType)}`,
    );
  }
  return linkedType;
}

function substituteCanonicalType(
  sourceType: string,
  typeParameters: readonly string[],
  typeArguments: readonly string[],
): string {
  let concrete = canonicalTypeName(sourceType);
  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index];
    const argument = typeArguments[index];
    concrete = concrete.replace(new RegExp(`\\b${escapeRegExp(parameter)}\\b`, "g"), argument);
  }
  return concrete;
}

function normalizeNativeType(typeName: string): string {
  return typeName
    .replace(/\b(inout|out|in)\s+[A-Za-z_][A-Za-z0-9_]*\s*:/g, "$1:")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*\s*:/g, ":")
    .replace(/\s+/g, "");
}

function normalizeRecordedReceiverMode(mode: string): "in" | "inout" | "move" | string {
  return mode.length === 0 ? "in" : mode;
}

function concreteGenericOwnerMatches(
  index: NativeSemanticIndex,
  callPath: string,
  concreteType: string,
  sourceModulePath: string,
  sourceName: string,
  typeArguments: readonly string[],
): boolean {
  const normalized = normalizeNativeType(concreteType);
  const opening = normalized.indexOf("<");
  if (opening <= 0 || !normalized.endsWith(">")) return false;
  const base = normalized.slice(0, opening);
  const expected = `${base}<${typeArguments.map(normalizeNativeType).join(",")}>`;
  if (normalized !== expected) return false;
  const separator = base.indexOf(".");
  const target = separator < 0
    ? index.resolveSymbol(callPath, base)
    : index.resolveNamespaceMember(callPath, base.slice(0, separator), base.slice(separator + 1));
  return target?.modulePath === sourceModulePath
    && target.declaration.name === sourceName
    && target.declaration.kind === "class";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionKey(modulePath: string, declaration: FunctionDeclaration | StructDeclaration | EnumDeclaration): string {
  return `${modulePath}\0${declaration.kind}\0${declaration.location.line}\0${declaration.location.column}`;
}
