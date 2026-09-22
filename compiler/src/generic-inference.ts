import type {
  Expression,
  FunctionDeclaration,
  MatchArm,
  Program,
  Statement,
  StructDeclaration,
  TypeParameterConstraint,
} from "./ast.ts";
import {
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import { DiagnosticError } from "./diagnostics.ts";
import {
  parsePointerTypeName,
  pointerTypeName,
  type ForeignFunction,
  type ForeignModule,
  type ForeignObjCInterface,
  type ForeignType,
} from "./foreign.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { parseAsyncGeneratorType } from "./generator-types.ts";
import { isNullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { iteratorTraitDeclaration } from "./iterator-types.ts";
import { mapEntryTypeName, parseMapType } from "./map-types.ts";
import { parseSetType } from "./set-types.ts";
import { parseWeakType, weakResultTypeName, weakTypeName } from "./weak-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";
import { parseReadonlyType, readonlyTypeName } from "./readonly-types.ts";

type Environment = Map<string, string>;
type RewrittenExpression = { readonly expression: Expression; readonly type: string | null };
export type DeferredGenericMethodDemand = {
  readonly ownerName: string;
  readonly methodName: string;
  readonly arguments: readonly string[];
};

export type GenericInferenceResult = {
  readonly program: Program;
  readonly deferredGenericMethodDemands: ReadonlyMap<
    FunctionDeclaration["location"],
    readonly DeferredGenericMethodDemand[]
  >;
};
const attemptedInferencePrefix = "__z_inferred_attempt:";
const attemptedInferenceType = (success: string): string => `${attemptedInferencePrefix}${success}`;
const parseAttemptedInferenceType = (type: string | null): string | null => (
  type?.startsWith(attemptedInferencePrefix) ? type.slice(attemptedInferencePrefix.length) : null
);
const numericTypeConstructors = new Set([
  "i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize", "f32", "f64",
]);

export function inferGenericCalls(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule> = new Map(),
  typeDisplayNames: ReadonlyMap<string, string> = new Map(),
): GenericInferenceResult {
  const genericFunctions = new Map(
    program.functions.filter((item) => item.typeParameters?.length).map((item) => [item.name, item]),
  );
  const functions = new Map(program.functions.map((item) => [item.name, item]));
  const structs = new Map(program.structs.map((item) => [item.name, item]));
  const enums = new Map(program.enums.map((item) => [item.name, item]));
  const traits = new Map(program.traits.map((item) => [item.name, item]));
  for (const declaration of program.imports.filter((item) => item.header === "std/iteration")) {
    for (const binding of declaration.bindings ?? []) {
      if (binding.importedName !== "Iterator") continue;
      traits.set(binding.localName, iteratorTraitDeclaration(binding.localName, binding.location));
    }
  }
  const methodSpecializations = new Map<string, Map<string, string>>();
  const deferredGenericMethodDemands = new Map<
    FunctionDeclaration["location"],
    DeferredGenericMethodDemand[]
  >();
  let activeConstraints = new Map<string, string[]>();
  let activeTypeParameters = new Set<string>();
  let enclosingReturnType: string | null = null;
  const withReturnType = <T>(type: string | null, rewrite: () => T): T => {
    const previous = enclosingReturnType;
    enclosingReturnType = type;
    try { return rewrite(); } finally { enclosingReturnType = previous; }
  };
  let activeDeferredGenericMethodDemands: DeferredGenericMethodDemand[] | null = null;
  const closureReturns = new Map<string, string | null>();
  const objectFieldTypes = new Map<number, ReadonlyMap<string, string | null>>();
  const selectiveFunctions = new Map<string, string>();
  const selectiveValues = new Map<string, string>();
  const standardTypeConstructors = new Map(
    program.imports
      .filter((declaration) => (
        declaration.header === "std/text"
        || declaration.header === "std/memory"
        || declaration.header === "std/collections"
        || declaration.header === "std/sync"
      ) && declaration.bindings)
      .flatMap((declaration) => declaration.bindings!
        .filter((binding) => binding.importedName === "TextBuffer" || binding.importedName === "Arena" || binding.importedName === "Map" || binding.importedName === "Set" || binding.importedName === "Once" || binding.importedName === "Mutex")
        .map((binding) => [binding.localName, binding.importedName] as const)),
  );
  const selectiveNamespaces = new Map<string, { readonly module: ForeignModule; readonly namespacePath: readonly string[] }>();
  const foreignInterfaces = new Map<string, ForeignObjCInterface>();
  const resolveForeignFunction = (module: ForeignModule, path: readonly string[]): ForeignFunction | null => {
    const qualifiedName = path.join(".");
    const direct = module.functions.get(qualifiedName);
    if (direct) return direct;
    if (path.length !== 1) return null;
    const alias = module.functionAliases.get(path[0]);
    return alias ? module.functions.get(alias) ?? null : null;
  };
  const resolveForeignNamedType = (module: ForeignModule, path: readonly string[]) => {
    const qualifiedName = path.join(".");
    const direct = module.namedTypes.get(qualifiedName);
    if (direct) return direct;
    if (path.length !== 1) return null;
    const alias = module.namedTypeAliases.get(path[0]);
    return alias ? module.namedTypes.get(alias) ?? null : null;
  };
  const foreignMemberPath = (expression: Extract<Expression, { kind: "member" }>) => {
    const path = [expression.property];
    let object: Expression = expression.object;
    while (object.kind === "member") {
      path.unshift(object.property);
      object = object.object;
    }
    if (object.kind !== "identifier") return null;
    const module = foreignModules.get(object.name);
    if (module) return { module, path };
    const namespace = selectiveNamespaces.get(object.name);
    return namespace ? { module: namespace.module, path: [...namespace.namespacePath, ...path] } : null;
  };
  const foreignReturnType = (declaration: ForeignFunction): string | null => {
    const returns = new Set(declaration.overloads.map((overload) => inferenceTypeName(overload.returnType)));
    return returns.size === 1 ? [...returns][0] : null;
  };
  const foreignMember = (expression: Extract<Expression, { kind: "member" }>): ForeignFunction | null => {
    const target = foreignMemberPath(expression);
    return target ? resolveForeignFunction(target.module, target.path) : null;
  };
  const foreignCallReturnType = (
    declaration: ForeignFunction,
    args: readonly RewrittenExpression[],
  ): string | null => {
    const matches: { readonly returnType: string; readonly score: number }[] = [];
    for (const overload of declaration.overloads) {
      const parameters = overload.parameters.filter((parameter) => (
        parameter.type.kind !== "callbackContext" && parameter.type.kind !== "callbackRelease"
      ));
      if ((!overload.variadic && args.length !== parameters.length) || (overload.variadic && args.length < parameters.length)) continue;
      let score = overload.variadic ? 0 : 2;
      let viable = true;
      for (let index = 0; index < parameters.length; index += 1) {
        const expected = inferenceTypeName(parameters[index].type);
        const actual = args[index]?.type;
        const expression = args[index]?.expression;
        if (expression?.kind === "number" && /^(?:i|u|f)(?:8|16|32|64)$|^(?:isize|usize)$/.test(expected)) {
          const integer = !/[.eE]/.test(expression.value);
          if (!integer && !expected.startsWith("f")) {
            viable = false;
            break;
          }
          score += integer
            ? expected === "i32" ? 8 : expected.startsWith("i") || expected.startsWith("u") ? 5 : 1
            : expected === "f64" ? 8 : expected === "f32" ? 5 : 0;
          continue;
        }
        if (actual && actual !== expected) {
          const expectedPointer = parsePointerTypeName(expected);
          const actualPointer = parsePointerTypeName(actual);
          const compatibleBorrow = expectedPointer?.ownership === "borrowed"
            && !expectedPointer.nullable
            && actualPointer?.identity === expectedPointer.identity
            && !actualPointer.nullable;
          if (!compatibleBorrow) {
            viable = false;
            break;
          }
        }
        score += actual === expected ? 8 : 1;
      }
      if (viable) matches.push({ returnType: inferenceTypeName(overload.returnType), score });
    }
    if (matches.length === 0) return null;
    const bestScore = Math.max(...matches.map((match) => match.score));
    const bestReturns = new Set(matches.filter((match) => match.score === bestScore).map((match) => match.returnType));
    return bestReturns.size === 1 ? [...bestReturns][0] : null;
  };
  for (const module of foreignModules.values()) {
    for (const declaration of module.interfaces.values()) foreignInterfaces.set(declaration.typeName, declaration);
    for (const binding of module.declaration.bindings ?? []) {
      if (module.namespaces.has(binding.importedName)) {
        selectiveNamespaces.set(binding.localName, {
          module,
          namespacePath: binding.importedName.split("."),
        });
        continue;
      }
      const fn = resolveForeignFunction(module, [binding.importedName]);
      const returnType = fn ? foreignReturnType(fn) : null;
      if (returnType) selectiveFunctions.set(binding.localName, returnType);
      const constant = module.constants.get(binding.importedName);
      if (constant) selectiveValues.set(binding.localName, constant.typeName);
    }
  }

  const objcClassPrefix = "__z_objc_class:";
  const objcReceiver = (type: string | null): { readonly declaration: ForeignObjCInterface; readonly instance: boolean } | null => {
    if (!type) return null;
    if (type.startsWith(objcClassPrefix)) {
      const declaration = foreignInterfaces.get(type.slice(objcClassPrefix.length));
      return declaration ? { declaration, instance: false } : null;
    }
    const declaration = foreignInterfaces.get(publicObjCTypeName(type));
    return declaration ? { declaration, instance: true } : null;
  };
  const objcPropertyType = (type: string | null, name: string): string | null => {
    const receiver = objcReceiver(type);
    if (!receiver) return null;
    let declaration: ForeignObjCInterface | undefined = receiver.declaration;
    while (declaration) {
      const property = declaration.properties.find((candidate) => (
        candidate.classProperty === !receiver.instance && candidate.name === name
      ));
      if (property) return inferenceTypeName(property.type);
      if (!declaration.superName) break;
      const moduleName = declaration.typeName.slice(0, declaration.typeName.lastIndexOf("."));
      declaration = foreignInterfaces.get(`${moduleName}.${declaration.superName}`);
    }
    return null;
  };

  const substituteType = (type: string, substitutions: ReadonlyMap<string, string>): string => {
    const direct = substitutions.get(type);
    if (direct) return direct;
    const readonly = parseReadonlyType(type);
    if (readonly) return readonlyTypeName(substituteType(readonly.target, substitutions));
    const functionType = parseFunctionType(type);
    if (functionType) {
      return functionTypeName(
        functionType.parameters.map((parameter) => ({
          ...parameter,
          type: substituteType(parameter.type, substitutions),
        })),
        substituteType(functionType.returnType, substitutions),
        functionType.errorType ? substituteType(functionType.errorType, substitutions) : null,
        functionType.thread,
        functionType.async,
      );
    }
    const array = parseFixedArrayType(type);
    if (array) return fixedArrayTypeName(substituteType(array.elementType, substitutions), array.length);
    const slice = parseSliceType(type);
    if (slice) return sliceTypeName(substituteType(slice.elementType, substitutions));
    const dynamic = parseDynamicArrayType(type);
    if (dynamic) {
      const substituted = dynamicArrayTypeName(substituteType(dynamic.elementType, substitutions));
      return dynamic.readonly ? readonlyTypeName(substituted) : substituted;
    }
    const generic = parseGenericType(type);
    return generic
      ? genericTypeName(generic.base, generic.arguments.map((argument) => substituteType(argument, substitutions)))
      : type;
  };

  const typeMentionsParameter = (type: string, parameter: string): boolean => {
    if (type === parameter) return true;
    const functionType = parseFunctionType(type);
    if (functionType) {
      return functionType.parameters.some((item) => typeMentionsParameter(item.type, parameter))
        || typeMentionsParameter(functionType.returnType, parameter)
        || (functionType.errorType !== null && typeMentionsParameter(functionType.errorType, parameter));
    }
    const array = parseFixedArrayType(type);
    if (array) return typeMentionsParameter(array.elementType, parameter);
    const slice = parseSliceType(type);
    if (slice) return typeMentionsParameter(slice.elementType, parameter);
    const dynamic = parseDynamicArrayType(type);
    if (dynamic) return typeMentionsParameter(dynamic.elementType, parameter);
    const generic = parseGenericType(type);
    return generic?.arguments.some((argument) => typeMentionsParameter(argument, parameter)) ?? false;
  };

  const settledType = (
    pattern: string,
    parameters: readonly string[],
    substitutions: ReadonlyMap<string, string>,
  ): string | null => parameters.some((parameter) => (
    !substitutions.has(parameter) && typeMentionsParameter(pattern, parameter)
  )) ? null : substituteType(pattern, substitutions);

  const aggregate = (type: string): { declaration: StructDeclaration; substitutions: Map<string, string> } | null => {
    const generic = parseGenericType(type);
    const declaration = structs.get(generic?.base ?? type);
    if (!declaration) return null;
    return {
      declaration,
      substitutions: new Map(
        declaration.typeParameters?.map((parameter, index) => [parameter, generic?.arguments[index] ?? parameter]) ?? [],
      ),
    };
  };

  const unify = (
    pattern: string,
    actual: string | null,
    parameters: ReadonlySet<string>,
    inferred: Map<string, string>,
    functionName: string,
    location: Expression["location"],
  ): void => {
    if (!actual || actual === "null") return;
    if (parameters.has(pattern)) {
      const previous = inferred.get(pattern);
      if (previous && previous !== actual) {
        throw new DiagnosticError(
          fileName,
          location,
          `conflicting inferred types for ${pattern} in ${JSON.stringify(functionName)}: `
            + `${displayType(previous)} and ${displayType(actual)}`,
        );
      }
      inferred.set(pattern, actual);
      return;
    }
    const patternArray = parseFixedArrayType(pattern);
    const actualArray = parseFixedArrayType(actual);
    if (patternArray && actualArray && patternArray.length === actualArray.length) {
      unify(patternArray.elementType, actualArray.elementType, parameters, inferred, functionName, location);
      return;
    }
    const patternSlice = parseSliceType(pattern);
    const actualSlice = parseSliceType(actual);
    const actualDynamicForSlice = parseDynamicArrayType(actual);
    if (patternSlice && (actualSlice || actualArray || actualDynamicForSlice)) {
      unify(
        patternSlice.elementType,
        (actualSlice ?? actualArray ?? actualDynamicForSlice)!.elementType,
        parameters,
        inferred,
        functionName,
        location,
      );
      return;
    }
    const patternDynamic = parseDynamicArrayType(pattern);
    const actualDynamic = parseDynamicArrayType(actual);
    if (patternDynamic && actualDynamic) {
      unify(patternDynamic.elementType, actualDynamic.elementType, parameters, inferred, functionName, location);
      return;
    }
    const patternGeneric = parseGenericType(pattern);
    const actualGeneric = parseGenericType(actual);
    if (patternGeneric && actualGeneric && patternGeneric.base === actualGeneric.base
      && patternGeneric.arguments.length === actualGeneric.arguments.length) {
      for (let index = 0; index < patternGeneric.arguments.length; index += 1) {
        unify(patternGeneric.arguments[index], actualGeneric.arguments[index], parameters, inferred, functionName, location);
      }
    }
  };

  const requestMethodSpecialization = (
    owner: StructDeclaration,
    method: FunctionDeclaration,
    arguments_: readonly string[],
    ownerSubstitutions: ReadonlyMap<string, string>,
    location: Expression["location"],
  ): string => {
    const name = genericTypeName(method.name, [...arguments_]);
    const dependsOnActiveTypeParameter = (type: string): boolean => {
      if (activeTypeParameters.has(type)) return true;
      const generic = parseGenericType(type);
      if (generic) return generic.arguments.some(dependsOnActiveTypeParameter);
      const readonly = parseReadonlyType(type);
      if (readonly) return dependsOnActiveTypeParameter(readonly.target);
      const view = parseViewType(type);
      if (view) return dependsOnActiveTypeParameter(view.target);
      const fixed = parseFixedArrayType(type);
      if (fixed) return dependsOnActiveTypeParameter(fixed.elementType);
      const slice = parseSliceType(type);
      if (slice) return dependsOnActiveTypeParameter(slice.elementType);
      const dynamic = parseDynamicArrayType(type);
      if (dynamic) return dependsOnActiveTypeParameter(dynamic.elementType);
      const callable = parseFunctionType(type);
      return Boolean(
        callable
        && (
          callable.parameters.some((parameter) => dependsOnActiveTypeParameter(parameter.type))
          || dependsOnActiveTypeParameter(callable.returnType)
          || (callable.errorType && dependsOnActiveTypeParameter(callable.errorType))
        )
      );
    };
    if (arguments_.some(dependsOnActiveTypeParameter)) {
      const substitutions = new Map(ownerSubstitutions);
      (method.typeParameters ?? []).forEach((parameter, index) => {
        substitutions.set(parameter, arguments_[index]);
      });
      for (const constraint of method.typeParameterConstraints ?? []) {
        const argument = substitutions.get(constraint.parameter);
        if (!argument || !activeTypeParameters.has(argument)) continue;
        const available = activeConstraints.get(argument) ?? [];
        for (const trait of constraint.traits) {
          const required = substituteType(trait.name, substitutions);
          if (available.includes(required)) continue;
          throw new DiagnosticError(
            fileName,
            location,
            `${typeDisplayNames.get(argument) ?? displayType(argument)} does not satisfy `
              + `${typeDisplayNames.get(required) ?? displayType(required)} for ${constraint.parameter} `
              + `in ${JSON.stringify(`${typeDisplayNames.get(owner.name) ?? owner.name}.${method.name}`)}`,
          );
        }
      }
      activeDeferredGenericMethodDemands?.push({
        ownerName: owner.typeParameters?.length
          ? genericTypeName(
              owner.name,
              owner.typeParameters.map((parameter) => ownerSubstitutions.get(parameter) ?? parameter),
            )
          : owner.name,
        methodName: method.name,
        arguments: [...arguments_],
      });
      return name;
    }
    let ownerRequests = methodSpecializations.get(owner.name);
    if (!ownerRequests) {
      ownerRequests = new Map();
      methodSpecializations.set(owner.name, ownerRequests);
    }
    ownerRequests.set(name, method.name);
    return name;
  };

  const rewriteGenericArguments = (
    parameterTypes: readonly string[],
    typeParameters: readonly string[],
    initialSubstitutions: ReadonlyMap<string, string>,
    explicitArguments: readonly string[] | null,
    originalArguments: readonly Expression[],
    environment: Environment,
    returnPattern: string,
    expectedType: string | null,
    callName: string,
    location: Expression["location"],
  ): { readonly arguments: readonly RewrittenExpression[]; readonly substitutions: ReadonlyMap<string, string> } => {
    if (explicitArguments && explicitArguments.length !== typeParameters.length) {
      throw new DiagnosticError(
        fileName,
        location,
        `${callName} expects ${typeParameters.length} type argument(s), received ${explicitArguments.length}`,
      );
    }
    if (parameterTypes.length !== originalArguments.length) {
      throw new DiagnosticError(
        fileName,
        location,
        `${JSON.stringify(callName)} expects ${parameterTypes.length} argument(s), received ${originalArguments.length}`,
      );
    }
    const inferred = new Map<string, string>();
    if (explicitArguments) {
      typeParameters.forEach((parameter, index) => inferred.set(parameter, explicitArguments[index]));
    } else if (expectedType) {
      unify(
        substituteType(returnPattern, initialSubstitutions),
        expectedType,
        new Set(typeParameters),
        inferred,
        callName,
        location,
      );
    }
    const valueParameters = new Set(typeParameters.filter((parameter) => !inferred.has(parameter)));
    const arguments_: RewrittenExpression[] = [];
    for (let index = 0; index < originalArguments.length; index += 1) {
      const parameterPattern = substituteType(parameterTypes[index], initialSubstitutions);
      const substitutions = new Map([...initialSubstitutions, ...inferred]);
      const contextual = settledType(parameterPattern, typeParameters, substitutions);
      const argument = rewriteExpression(originalArguments[index], environment, contextual);
      arguments_.push(argument);
      if (!explicitArguments) {
        unify(
          parameterPattern,
          argument.type,
          valueParameters,
          inferred,
          callName,
          originalArguments[index].location,
        );
      }
    }
    const missing = typeParameters.find((parameter) => !inferred.has(parameter));
    if (missing) {
      throw new DiagnosticError(
        fileName,
        location,
        `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(callName)}; specify explicit type arguments`,
      );
    }
    return {
      arguments: arguments_,
      substitutions: new Map([...initialSubstitutions, ...inferred]),
    };
  };

  const inferMethodArguments = (
    owner: StructDeclaration,
    ownerSubstitutions: ReadonlyMap<string, string>,
    method: FunctionDeclaration,
    explicitArguments: readonly string[] | null,
    originalArguments: readonly Expression[],
    environment: Environment,
    expectedType: string | null,
    location: Expression["location"],
  ): { readonly name: string; readonly returnType: string; readonly arguments: readonly RewrittenExpression[] } => {
    const methodParameters = method.typeParameters ?? [];
    const callName = `${owner.name}.${method.name}`;
    const rewritten = rewriteGenericArguments(
      method.parameters.map((parameter) => parameter.type.name),
      methodParameters,
      ownerSubstitutions,
      explicitArguments,
      originalArguments,
      environment,
      method.returnType.name,
      expectedType,
      callName,
      location,
    );
    const methodArguments = methodParameters.map((parameter) => rewritten.substitutions.get(parameter)!);
    return {
      name: requestMethodSpecialization(
        owner,
        method,
        methodArguments,
        ownerSubstitutions,
        location,
      ),
      returnType: substituteType(method.returnType.name, rewritten.substitutions),
      arguments: rewritten.arguments,
    };
  };

  const inferAggregateArguments = (
    declaration: StructDeclaration,
    originalArguments: readonly Expression[],
    environment: Environment,
    expectedType: string | null,
    callName: string,
    location: Expression["location"],
  ): { readonly typeName: string; readonly arguments: readonly RewrittenExpression[] } => {
    const typeParameters = declaration.typeParameters ?? [];
    const parameters = new Set(typeParameters);
    const inferred = new Map<string, string>();
    if (expectedType) {
      unify(
        genericTypeName(declaration.name, declaration.typeParameters ?? []),
        expectedType,
        parameters,
        inferred,
        callName,
        location,
      );
    }
    const contextualParameters = new Set(inferred.keys());
    const valueParameters = new Set([...parameters].filter((parameter) => !contextualParameters.has(parameter)));
    let arguments_: readonly RewrittenExpression[];
    if (declaration.constructor) {
      const rewritten = rewriteGenericArguments(
        declaration.constructor.parameters.map((parameter) => parameter.type.name),
        typeParameters,
        new Map(),
        null,
        originalArguments,
        environment,
        genericTypeName(declaration.name, typeParameters),
        expectedType,
        callName,
        location,
      );
      arguments_ = rewritten.arguments;
      for (const parameter of typeParameters) {
        const argument = rewritten.substitutions.get(parameter);
        if (argument) inferred.set(parameter, argument);
      }
    } else if (originalArguments.length === 1 && originalArguments[0].kind === "objectExpression") {
      arguments_ = originalArguments.map((argument) => rewriteExpression(argument, environment, expectedType));
      const fieldTypes = objectFieldTypes.get(originalArguments[0].location.offset);
      if (originalArguments[0].spread) {
        const spreadType = rewriteExpression(
          originalArguments[0].spread.expression,
          environment,
        ).type;
        unify(
          genericTypeName(declaration.name, typeParameters),
          spreadType,
          valueParameters,
          inferred,
          callName,
          originalArguments[0].spread.location,
        );
      }
      for (const initializer of originalArguments[0].fields) {
        const field = declaration.fields.find((candidate) => candidate.name === initializer.name);
        if (!field) continue;
        const actual = fieldTypes?.get(initializer.name) ?? null;
        const declaredOption = field.optional ? parseGenericType(field.type.name) : null;
        const actualOption = actual ? parseGenericType(actual) : null;
        const pattern = declaredOption?.base === "Option" && actualOption?.base !== "Option"
          ? declaredOption.arguments[0]
          : field.type.name;
        unify(pattern, actual, valueParameters, inferred, callName, initializer.location);
      }
    } else {
      arguments_ = originalArguments.map((argument) => rewriteExpression(argument, environment));
    }
    const missing = declaration.typeParameters?.find((parameter) => !inferred.has(parameter));
    if (missing) {
      throw new DiagnosticError(
        fileName,
        location,
        `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(callName)}; specify explicit type arguments`,
      );
    }
    const typeName = genericTypeName(
      declaration.name,
      declaration.typeParameters!.map((parameter) => inferred.get(parameter)!),
    );
    if (!declaration.constructor && originalArguments.length === 1 && originalArguments[0].kind === "objectExpression") {
      arguments_ = [rewriteExpression(originalArguments[0], environment, typeName)];
    }
    return { typeName, arguments: arguments_ };
  };

  const rewriteExpression = (
    expression: Expression,
    environment: Environment,
    expectedType: string | null = null,
  ): RewrittenExpression => {
    switch (expression.kind) {
      case "number":
        return { expression, type: /^[0-9]+$/.test(expression.value) ? "i32" : "f64" };
      case "string":
        return { expression, type: "String" };
      case "template": {
        const parts = expression.parts.map((part) => part.kind === "text"
          ? part
          : { ...part, expression: rewriteExpression(part.expression, environment).expression });
        return { expression: { ...expression, parts }, type: "String" };
      }
      case "boolean":
        return { expression, type: "boolean" };
      case "null":
        return { expression, type: "null" };
      case "raw":
        return { expression, type: expression.returnType.name };
      case "identifier":
        const genericIdentifier = parseGenericType(expression.name);
        const localType = environment.get(expression.name) ?? null;
        return {
          expression,
          type: parseAttemptedInferenceType(localType)
            ?? localType
            ?? selectiveValues.get(expression.name)
            ?? standardTypeConstructors.get(genericIdentifier?.base ?? expression.name)
            ?? null,
        };
      case "argumentReference":
        const argumentType = environment.get(expression.name) ?? null;
        return { expression, type: parseAttemptedInferenceType(argumentType) ?? argumentType };
      case "unary": {
        const operand = rewriteExpression(expression.operand, environment);
        return { expression: { ...expression, operand: operand.expression }, type: expression.operator === "!" ? "boolean" : operand.type };
      }
      case "binary": {
        const left = rewriteExpression(expression.left, environment);
        const right = rewriteExpression(expression.right, environment);
        const comparison = ["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(expression.operator);
        return {
          expression: { ...expression, left: left.expression, right: right.expression },
          type: comparison ? "boolean" : left.type ?? right.type,
        };
      }
      case "conditional": {
        const condition = rewriteExpression(expression.condition, environment);
        const thenExpression = rewriteExpression(expression.thenExpression, new Map(environment), expectedType);
        const elseExpression = rewriteExpression(expression.elseExpression, new Map(environment), expectedType);
        return {
          expression: {
            ...expression,
            condition: condition.expression,
            thenExpression: thenExpression.expression,
            elseExpression: elseExpression.expression,
          },
          type: thenExpression.type ?? elseExpression.type,
        };
      }
      case "new": {
        const explicit = parseGenericType(expression.typeName);
        const declaration = structs.get(explicit?.base ?? expression.typeName);
        let inferred: { readonly typeName: string; readonly arguments: readonly RewrittenExpression[] } | null = null;
        let explicitArguments: readonly RewrittenExpression[] | null = null;
        if (declaration?.typeParameters?.length) {
          if (explicit && explicit.arguments.length !== declaration.typeParameters.length) {
            throw new DiagnosticError(
              fileName,
              expression.location,
              `${declaration.name} expects ${declaration.typeParameters.length} type argument(s), received ${explicit.arguments.length}`,
            );
          }
          if (!explicit) {
            inferred = inferAggregateArguments(
              declaration,
              expression.arguments,
              environment,
              expectedType,
              declaration.name,
              expression.location,
            );
          } else if (declaration.constructor) {
            explicitArguments = rewriteGenericArguments(
              declaration.constructor.parameters.map((parameter) => parameter.type.name),
              declaration.typeParameters,
              new Map(),
              explicit.arguments,
              expression.arguments,
              environment,
              genericTypeName(declaration.name, declaration.typeParameters),
              expression.typeName,
              declaration.name,
              expression.location,
            ).arguments;
          }
        }
        const arguments_ = inferred?.arguments
          ?? explicitArguments
          ?? expression.arguments.map((argument, index) => rewriteExpression(argument, environment,
            declaration?.constructor?.parameters[index]?.type.name
              ?? ((declaration && !declaration.constructor) || explicit ? expression.typeName : null)));
        const typeName = inferred?.typeName ?? expression.typeName;
        return {
          expression: { ...expression, typeName, arguments: arguments_.map((argument) => argument.expression) },
          type: typeName,
        };
      }
      case "weak": {
        const inner = rewriteExpression(expression.expression, environment);
        return {
          expression: { ...expression, expression: inner.expression },
          type: inner.type ? weakTypeName(inner.type) : null,
        };
      }
      case "closure": {
        const closureEnvironment = new Map(environment);
        for (const parameter of expression.parameters) {
          if (parameter.type) closureEnvironment.set(parameter.name, parameter.type.name);
        }
        const declaredReturn = expression.returnType?.name
          ?? (expectedType ? parseFunctionType(expectedType)?.returnType : null) ?? null;
        const rewrittenBody = withReturnType(declaredReturn, () => expression.body.kind === "block"
          ? {
            expression: rewriteStatement(expression.body, closureEnvironment, declaredReturn) as typeof expression.body,
            type: null,
          }
          : rewriteExpression(expression.body, closureEnvironment, declaredReturn));
        const body = rewrittenBody.expression;
        const type = `__z_closure_${expression.location.offset}`;
        const returnType = declaredReturn ?? rewrittenBody.type;
        closureReturns.set(type, returnType);
        return { expression: { ...expression, body }, type };
      }
      case "arrayExpression": {
        const elements = expression.elements.map((item) => rewriteExpression(item, environment));
        const elementType = elements.find((item) => item.type)?.type ?? null;
        return {
          expression: { ...expression, elements: elements.map((item) => item.expression) },
          type: elementType ? fixedArrayTypeName(elementType, elements.length) : null,
        };
      }
      case "dynamicArrayExpression":
        return {
          expression: {
            ...expression,
            elements: expression.elements.map((item) => rewriteExpression(item, environment).expression),
          },
          type: dynamicArrayTypeName(expression.elementType),
        };
      case "structExpression": {
        const fields = expression.fields.map((field) => {
          const value = rewriteExpression(field.expression, environment);
          return { ...field, expression: value.expression };
        });
        const spread = expression.spread
          ? {
              ...expression.spread,
              expression: rewriteExpression(expression.spread.expression, environment).expression,
            }
          : expression.spread;
        return { expression: { ...expression, fields, spread }, type: expression.typeName };
      }
      case "objectExpression": {
        const contextualOwner = expectedType ? aggregate(expectedType) : null;
        const fieldTypes = new Map<string, string | null>();
        const spread = expression.spread
          ? {
              ...expression.spread,
              expression: rewriteExpression(
                expression.spread.expression,
                environment,
                expectedType,
              ).expression,
            }
          : expression.spread;
        const fields = expression.fields.map((field) => {
          const declaration = contextualOwner?.declaration.fields.find((candidate) => candidate.name === field.name);
          const contextualFieldType = declaration
            ? substituteType(declaration.type.name, contextualOwner!.substitutions)
            : null;
          const option = declaration?.optional && contextualFieldType
            ? parseGenericType(contextualFieldType)
            : null;
          let value = rewriteExpression(field.expression, environment, contextualFieldType);
          if (option?.base === "Option" && value.type !== contextualFieldType) {
            if (field.expression.kind === "objectExpression" && value.type === null) {
              value = rewriteExpression(field.expression, environment, option.arguments[0]);
            }
            // Keep the compiler-created Option.some node distinct from its
            // payload. Statement-valued lowering keys temporary overrides by
            // source offset; sharing the payload offset would erase this wrapper.
            const wrapperLocation = {
              ...field.expression.location,
              offset: -Math.abs(field.expression.location.offset) - 1,
            };
            value = {
              expression: {
                kind: "call",
                callee: {
                  kind: "member",
                  object: {
                    kind: "identifier",
                    name: contextualFieldType!,
                    location: wrapperLocation,
                  },
                  property: "some",
                  location: wrapperLocation,
                },
                arguments: [value.expression],
                argumentLabels: [null],
                location: wrapperLocation,
              },
              type: contextualFieldType,
            };
          }
          fieldTypes.set(field.name, value.type);
          return { ...field, expression: value.expression };
        });
        objectFieldTypes.set(expression.location.offset, fieldTypes);
        return { expression: { ...expression, fields, spread }, type: null };
      }
      case "member": {
        const contextualOption = expectedType ? parseGenericType(expectedType) : null;
        if (
          expression.object.kind === "identifier"
          && expression.object.name === "Option"
          && expression.property === "none"
          && contextualOption?.base === "Option"
        ) {
          return {
            expression: { ...expression, object: { ...expression.object, name: expectedType! } },
            type: expectedType,
          };
        }
        const object = rewriteExpression(expression.object, environment);
        const importedFunction = foreignMember(expression);
        const importedReturn = importedFunction ? foreignReturnType(importedFunction) : null;
        if (importedReturn) return { expression: { ...expression, object: object.expression }, type: importedReturn };
        const importedTarget = foreignMemberPath(expression);
        const importedType = importedTarget ? resolveForeignNamedType(importedTarget.module, importedTarget.path) : null;
        if (importedType) return { expression: { ...expression, object: object.expression }, type: importedType.typeName };
        if (expression.object.kind === "identifier") {
          const owner = aggregate(expression.object.name);
          const staticMethod = owner?.declaration.methods.find((item) => item.static && item.name === expression.property);
          if (owner && staticMethod) {
            return {
              expression: { ...expression, object: object.expression },
              type: substituteType(staticMethod.returnType.name, owner.substitutions),
            };
          }
          const option = parseGenericType(expression.object.name);
          if (option?.base === "Option") {
            return { expression: { ...expression, object: object.expression }, type: expression.object.name };
          }
        }
        const weak = object.type ? parseWeakType(object.type) : null;
        if (weak && expression.property === "upgrade") {
          return { expression: { ...expression, object: object.expression }, type: weakResultTypeName(weak.target) };
        }
        const dynamicArray = object.type ? parseDynamicArrayType(object.type) : null;
        if (dynamicArray && (expression.property === "length" || expression.property === "capacity")) {
          return { expression: { ...expression, object: object.expression }, type: "usize" };
        }
        if (dynamicArray && (expression.property === "push" || expression.property === "clear")) {
          return { expression: { ...expression, object: object.expression }, type: "void" };
        }
        const map = object.type ? parseMapType(object.type) : null;
        if (map) {
          const type = expression.property === "length" ? "usize"
            : expression.property === "has" ? "boolean"
            : expression.property === "get" ? genericTypeName("Option", [
              parseFunctionType(map.valueType) ? map.valueType : viewTypeName(map.valueType),
            ])
            : expression.property === "remove" ? genericTypeName("Option", [map.valueType])
            : expression.property === "set" || expression.property === "clear" ? "void"
            : null;
          return { expression: { ...expression, object: object.expression }, type };
        }
        const set = object.type ? parseSetType(object.type) : null;
        if (set) {
          const type = expression.property === "length" ? "usize"
            : expression.property === "has" || expression.property === "add" ? "boolean"
            : expression.property === "remove" ? genericTypeName("Option", [set.elementType])
            : expression.property === "clear" ? "void"
            : null;
          return { expression: { ...expression, object: object.expression }, type };
        }
        if (object.type === "TextBuffer") {
          const type = expression.property === "byteLength" ? "usize"
            : expression.property === "isEmpty" ? "boolean"
            : expression.property === "finish" ? "String"
            : ["append", "appendBytes", "appendAscii"].includes(expression.property) ? "void"
            : null;
          return { expression: { ...expression, object: object.expression }, type };
        }
        if (expression.object.kind === "identifier") {
          const module = foreignModules.get(expression.object.name);
          const interface_ = module?.interfaces.get(expression.property);
          if (interface_) {
            return {
              expression: { ...expression, object: object.expression },
              type: `${objcClassPrefix}${interface_.typeName}`,
            };
          }
          const fn = module ? resolveForeignFunction(module, [expression.property]) : null;
          const constant = module?.constants.get(expression.property);
          const named = module ? resolveForeignNamedType(module, [expression.property]) : null;
          const foreignType = fn ? foreignReturnType(fn) : constant?.typeName ?? named?.typeName ?? null;
          if (foreignType) return { expression: { ...expression, object: object.expression }, type: foreignType };
        }
        const foreignPropertyType = objcPropertyType(object.type, expression.property);
        if (foreignPropertyType) return { expression: { ...expression, object: object.expression }, type: foreignPropertyType };
        const owner = object.type ? aggregate(object.type) : null;
        const field = owner?.declaration.fields.find((item) => item.name === expression.property);
        const method = owner?.declaration.methods.find((item) => item.name === expression.property);
        const constrainedMethod = object.type
          ? (activeConstraints.get(object.type) ?? []).flatMap((traitName) => {
            const generic = parseGenericType(traitName);
            const trait = traits.get(generic?.base ?? traitName);
            const method = trait?.methods.find((item) => item.name === expression.property);
            if (!trait || !method) return [];
            const substitutions = new Map(
              (trait.typeParameters ?? []).map((parameter, index) => [
                parameter,
                generic?.arguments[index] ?? parameter,
              ]),
            );
            return [{ method, substitutions }];
          }).at(0) ?? null
          : null;
        if (object.type && activeTypeParameters.has(object.type) && !constrainedMethod) {
          throw new DiagnosticError(
            fileName,
            expression.location,
            `member ${JSON.stringify(expression.property)} is not provided by the trait constraints on ${object.type}`,
          );
        }
        const type = field
          ? substituteType(field.type.name, owner!.substitutions)
          : method ? substituteType(method.returnType.name, owner!.substitutions)
          : constrainedMethod
            ? substituteType(constrainedMethod.method.returnType.name, constrainedMethod.substitutions)
            : null;
        return { expression: { ...expression, object: object.expression }, type };
      }
      case "index": {
        const object = rewriteExpression(expression.object, environment);
        const index = rewriteExpression(expression.index, environment);
        const objectType = object.type ? parseViewType(object.type)?.target ?? object.type : null;
        const indexed = objectType
          ? parseFixedArrayType(objectType) ?? parseSliceType(objectType) ?? parseDynamicArrayType(objectType)
          : null;
        return { expression: { ...expression, object: object.expression, index: index.expression }, type: indexed?.elementType ?? null };
      }
      case "variantExpression": {
        const payload = rewriteExpression(expression.payload, environment);
        return { expression: { ...expression, payload: payload.expression }, type: expression.enumName };
      }
      case "attempt":
      case "try":
      case "await":
      case "spawn": {
        const inner = rewriteExpression(expression.expression, environment);
        return { expression: { ...expression, expression: inner.expression }, type: inner.type };
      }
      case "executorPlacement": {
        const executor = rewriteExpression(expression.executor, environment);
        const body = rewriteStatement(expression.body, new Map(environment)) as typeof expression.body;
        const call = expression.call
          ? rewriteExpression(expression.call, environment).expression as typeof expression.call
          : null;
        return {
          expression: { ...expression, executor: executor.expression, body, call },
          type: expression.mode === "spawn" ? null : expression.returnType?.name ?? null,
        };
      }
      case "matchExpression": {
        const matched = rewriteExpression(expression.expression, environment);
        const attemptedSuccessType = expression.expression.kind === "attempt"
          ? matched.type
          : expression.expression.kind === "identifier"
            ? parseAttemptedInferenceType(environment.get(expression.expression.name) ?? null)
            : null;
        const arms = expression.arms.map((arm) => rewriteArm(
          arm,
          environment,
          matched.type,
          enclosingReturnType,
          expectedType,
          attemptedSuccessType,
        ));
        let type: string | null = null;
        for (const arm of arms) {
          type = armValueType(
            [arm],
            matchArmEnvironment(arm, environment, matched.type, attemptedSuccessType),
          );
          if (type !== null) break;
        }
        return { expression: { ...expression, expression: matched.expression, arms }, type };
      }
      case "ifExpression": {
        const condition = rewriteExpression(expression.condition, environment);
        const thenBranch = rewriteStatement(
          expression.thenBranch,
          new Map(environment),
          enclosingReturnType,
          expectedType,
        ) as typeof expression.thenBranch;
        const elseBranch = expression.elseBranch.kind === "ifExpression"
          ? rewriteExpression(expression.elseBranch, new Map(environment), expectedType).expression as typeof expression.elseBranch
          : rewriteStatement(expression.elseBranch, new Map(environment), enclosingReturnType, expectedType) as typeof expression.elseBranch;
        return {
          expression: { ...expression, condition: condition.expression, thenBranch, elseBranch },
          type: armValueType([{
            variantName: "",
            binding: null,
            body: thenBranch,
            location: thenBranch.location,
          }], environment),
        };
      }
      case "unsafeExpression": {
        const body = rewriteStatement(
          expression.body,
          new Map(environment),
          enclosingReturnType,
          expectedType,
        ) as typeof expression.body;
        return {
          expression: { ...expression, body },
          type: armValueType([{
            variantName: "",
            binding: null,
            body,
            location: body.location,
          }], environment),
        };
      }
      case "whileExpression": {
        const condition = rewriteExpression(expression.condition, environment);
        const body = rewriteStatement(
          expression.body,
          new Map(environment),
          enclosingReturnType,
          expectedType,
        ) as typeof expression.body;
        const elseBranch = rewriteStatement(
          expression.elseBranch,
          new Map(environment),
          enclosingReturnType,
          expectedType,
        ) as typeof expression.elseBranch;
        return {
          expression: { ...expression, condition: condition.expression, body, elseBranch },
          type: armValueType([{
            variantName: "",
            binding: null,
            body: elseBranch,
            location: elseBranch.location,
          }], environment),
        };
      }
      case "forExpression": {
        const iterable = rewriteExpression(expression.iterable, environment);
        const map = iterable.type ? parseMapType(iterable.type) : null;
        const set = iterable.type ? parseSetType(iterable.type) : null;
        const asyncGenerator = iterable.type ? parseAsyncGeneratorType(iterable.type) : null;
        const collection = iterable.type
          ? parseFixedArrayType(iterable.type)
            ?? parseSliceType(iterable.type)
            ?? parseDynamicArrayType(iterable.type)
            ?? (map ? { elementType: mapEntryTypeName(map.keyType, map.valueType) } : null)
            ?? (set ? { elementType: set.elementType } : null)
            ?? (asyncGenerator ? { elementType: asyncGenerator.elementType } : null)
          : null;
        const bodyEnvironment = new Map(environment);
        if (collection && expression.binding) bodyEnvironment.set(expression.binding, collection.elementType);
        const element = collection ? structs.get(collection.elementType) : null;
        if (element) {
          for (const binding of expression.objectBindings ?? []) {
            const field = element.fields.find((candidate) => candidate.name === binding.fieldName);
            if (field) bodyEnvironment.set(binding.bindingName, field.type.name);
          }
        }
        const body = rewriteStatement(expression.body, bodyEnvironment, enclosingReturnType, expectedType) as typeof expression.body;
        const elseBranch = rewriteStatement(
          expression.elseBranch,
          new Map(environment),
          enclosingReturnType,
          expectedType,
        ) as typeof expression.elseBranch;
        return {
          expression: { ...expression, iterable: iterable.expression, body, elseBranch },
          type: armValueType([{
            variantName: "",
            binding: null,
            body: elseBranch,
            location: elseBranch.location,
          }], environment),
        };
      }
      case "call": {
        if (
          expression.callee.kind === "identifier"
          && numericTypeConstructors.has(expression.callee.name)
        ) {
          return {
            expression: {
              ...expression,
              arguments: expression.arguments.map((argument) => rewriteExpression(argument, environment).expression),
            },
            type: expression.callee.name,
          };
        }
        if (expression.callee.kind === "identifier") {
          const explicit = parseGenericType(expression.callee.name);
          const template = genericFunctions.get(explicit?.base ?? expression.callee.name);
          if (template) {
            if (template.parameters.length !== expression.arguments.length) {
              throw new DiagnosticError(
                fileName,
                expression.location,
                `${JSON.stringify(template.name)} expects ${template.parameters.length} argument(s), received ${expression.arguments.length}`,
              );
            }
            if (explicit && explicit.arguments.length !== template.typeParameters!.length) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `${template.name} expects ${template.typeParameters!.length} type argument(s), received ${explicit.arguments.length}`,
              );
            }
            const parameters = template.typeParameters!;
            const inferred = new Map<string, string>();
            if (explicit) {
              parameters.forEach((parameter, index) => inferred.set(parameter, explicit.arguments[index]));
            } else if (expectedType) {
              unify(
                template.returnType.name,
                expectedType,
                new Set(parameters),
                inferred,
                template.name,
                expression.location,
              );
            }
            const valueParameters = new Set(parameters.filter((parameter) => !inferred.has(parameter)));
            const args: RewrittenExpression[] = [];
            for (let index = 0; index < expression.arguments.length; index += 1) {
              const contextual = settledType(template.parameters[index].type.name, parameters, inferred);
              const argument = rewriteExpression(expression.arguments[index], environment, contextual);
              args.push(argument);
              if (!explicit) {
                unify(
                  template.parameters[index].type.name,
                  argument.type,
                  valueParameters,
                  inferred,
                  template.name,
                  expression.arguments[index].location,
                );
              }
            }
            const missing = parameters.find((parameter) => !inferred.has(parameter));
            if (missing) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(template.name)}; `
                  + "specify explicit type arguments",
              );
            }
            const arguments_ = parameters.map((parameter) => inferred.get(parameter)!);
            return {
              expression: {
                ...expression,
                callee: { ...expression.callee, name: genericTypeName(template.name, arguments_) },
                arguments: args.map((item) => item.expression),
              },
              type: substituteType(template.returnType.name, inferred),
            };
          }
        }
        if (expression.callee.kind === "member" && expression.callee.object.kind === "identifier") {
          const explicitOwner = parseGenericType(expression.callee.object.name);
          const explicitMethod = parseGenericType(expression.callee.property);
          const owner = structs.get(explicitOwner?.base ?? expression.callee.object.name);
          const methodName = explicitMethod?.base ?? expression.callee.property;
          const method = owner?.methods.find((candidate) => candidate.static && candidate.name === methodName);
          if (owner && method?.typeParameters?.length && !owner.typeParameters?.length) {
            const specialized = inferMethodArguments(
              owner,
              new Map(),
              method,
              explicitMethod?.arguments ?? null,
              expression.arguments,
              environment,
              expectedType,
              expression.callee.location,
            );
            return {
              expression: {
                ...expression,
                callee: { ...expression.callee, property: specialized.name },
                arguments: specialized.arguments.map((item) => item.expression),
              },
              type: specialized.returnType,
            };
          }
          if (owner && method && owner.typeParameters?.length) {
            if (explicitOwner) {
              throw new DiagnosticError(
                fileName,
                expression.callee.object.location,
                `static generic arguments follow the method name; use ${owner.name}.${method.name}<...>()`,
              );
            }
            if (method.typeParameters?.length) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `static method ${JSON.stringify(`${owner.name}.${method.name}`)} has independent owner and method type parameters; `
                  + "their two-level specialization syntax is not designed yet",
              );
            }
            const rewritten = rewriteGenericArguments(
              method.parameters.map((parameter) => parameter.type.name),
              owner.typeParameters,
              new Map(),
              explicitMethod?.arguments ?? null,
              expression.arguments,
              environment,
              method.returnType.name,
              expectedType,
              `${owner.name}.${method.name}`,
              expression.callee.location,
            );
            const concreteOwner = genericTypeName(
              owner.name,
              owner.typeParameters.map((parameter) => rewritten.substitutions.get(parameter)!),
            );
            return {
              expression: {
                ...expression,
                callee: {
                  ...expression.callee,
                  object: { ...expression.callee.object, name: concreteOwner },
                  property: method.name,
                },
                arguments: rewritten.arguments.map((item) => item.expression),
              },
              type: substituteType(method.returnType.name, rewritten.substitutions),
            };
          }
        }
        if (expression.callee.kind === "member") {
          const receiver = rewriteExpression(expression.callee.object, environment);
          const owner = receiver.type ? aggregate(receiver.type) : null;
          const explicitMethod = parseGenericType(expression.callee.property);
          const methodName = explicitMethod?.base ?? expression.callee.property;
          const method = owner?.declaration.methods.find((candidate) => !candidate.static && candidate.name === methodName);
          if (owner && method?.typeParameters?.length) {
            const specialized = inferMethodArguments(
              owner.declaration,
              owner.substitutions,
              method,
              explicitMethod?.arguments ?? null,
              expression.arguments,
              environment,
              expectedType,
              expression.callee.location,
            );
            return {
              expression: {
                ...expression,
                callee: { ...expression.callee, object: receiver.expression, property: specialized.name },
                arguments: specialized.arguments.map((item) => item.expression),
              },
              type: specialized.returnType,
            };
          }
        }
        if (expression.callee.kind === "identifier") {
          const explicitAggregate = parseGenericType(expression.callee.name);
          const aggregateConstructor = aggregate(expression.callee.name);
          const declaration = aggregateConstructor?.declaration;
          if (declaration?.typeParameters?.length) {
            if (explicitAggregate && explicitAggregate.arguments.length !== declaration.typeParameters.length) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `${explicitAggregate.base} expects ${declaration.typeParameters.length} type argument(s), received ${explicitAggregate.arguments.length}`,
              );
            }
            if (!explicitAggregate) {
              const inferred = inferAggregateArguments(
                declaration,
                expression.arguments,
                environment,
                expectedType,
                declaration.name,
                expression.location,
              );
              return {
                expression: {
                  ...expression,
                  callee: { ...expression.callee, name: inferred.typeName },
                  arguments: inferred.arguments.map((item) => item.expression),
                },
                type: inferred.typeName,
              };
            }
            let rewrittenArguments: readonly RewrittenExpression[];
            if (declaration.constructor) {
              rewrittenArguments = rewriteGenericArguments(
                declaration.constructor.parameters.map((parameter) => parameter.type.name),
                declaration.typeParameters,
                new Map(),
                explicitAggregate.arguments,
                expression.arguments,
                environment,
                genericTypeName(declaration.name, declaration.typeParameters),
                expression.callee.name,
                declaration.name,
                expression.location,
              ).arguments;
            } else {
              rewrittenArguments = expression.arguments.map((argument) => (
                rewriteExpression(argument, environment, expression.callee.name)
              ));
            }
            return {
              expression: {
                ...expression,
                arguments: rewrittenArguments.map((item) => item.expression),
              },
              type: expression.callee.name,
            };
          }
          if (declaration && !declaration.constructor) {
            const rewrittenArguments = expression.arguments.map((argument) => (
              rewriteExpression(argument, environment, expression.callee.name)
            ));
            return {
              expression: {
                ...expression,
                arguments: rewrittenArguments.map((item) => item.expression),
              },
              type: expression.callee.name,
            };
          }
        }
        // Ordinary checked calls provide context before nested generic values
        // are rewritten. Otherwise Option.some(Option.none) is rejected before
        // semantic analysis can supply the parameter's concrete payload type.
        let argumentTypes: readonly (string | null)[] = [];
        if (expression.callee.kind === "identifier") {
          const local = environment.get(expression.callee.name);
          const callable = local ? parseFunctionType(local) : null;
          const target = local ? null : functions.get(expression.callee.name);
          argumentTypes = callable?.parameters.map((parameter) => parameter.type)
            ?? target?.parameters.map((parameter) => parameter.type.name) ?? [];
        } else if (expression.callee.kind === "member") {
          const member = expression.callee;
          const receiver = rewriteExpression(member.object, environment);
          const owner = receiver.type ? aggregate(receiver.type) : null;
          const method = owner?.declaration.methods.find((candidate) => (
            !candidate.static && candidate.name === member.property
          ));
          if (owner && method && !method.typeParameters?.length) {
            argumentTypes = method.parameters.map((parameter) => substituteType(parameter.type.name, owner.substitutions));
          }
          if (member.object.kind === "identifier") {
            const qualifier = parseGenericType(member.object.name);
            const contextual = expectedType ? parseGenericType(expectedType) : null;
            if ((qualifier?.base ?? member.object.name) === "Option"
                && member.property === "some") {
              argumentTypes = [qualifier?.arguments[0]
                ?? (contextual?.base === "Option" ? contextual.arguments[0] : null)];
            }
          }
        }
        const args = expression.arguments.map((item, index) => rewriteExpression(item, environment, argumentTypes[index] ?? null));
        const callee = rewriteExpression(expression.callee, environment);
        if (callee.expression.kind === "member") {
          const arenaReceiver = rewriteExpression(callee.expression.object, environment);
          if (arenaReceiver.type === "Arena") {
            const type = callee.expression.property === "create" && args[0]?.type
              ? viewTypeName(args[0].type)
              : callee.expression.property === "reset"
                ? "void"
                : null;
            return {
              expression: {
                ...expression,
                callee: { ...callee.expression, object: arenaReceiver.expression },
                arguments: args.map((item) => item.expression),
              },
              type,
            };
          }
        }
        if (callee.expression.kind === "member" && callee.expression.object.kind === "identifier") {
          const qualifier = parseGenericType(callee.expression.object.name);
          const contextualOption = expectedType ? parseGenericType(expectedType) : null;
          const optionBase = qualifier?.base ?? callee.expression.object.name;
          if (optionBase === "Option") {
            if (callee.expression.property === "fromNullable") {
              if (args.length !== 1) {
                throw new DiagnosticError(fileName, expression.location, `Option.fromNullable expects 1 argument, received ${args.length}`);
              }
              const sourceArgument = expression.arguments[0];
              const foreignReturn = sourceArgument.kind === "call"
                && sourceArgument.callee.kind === "member"
                ? foreignMember(sourceArgument.callee)?.overloads.find((overload) => (
                  overload.returnType.kind === "pointer"
                ))?.returnType ?? null
                : null;
              const pointer = args[0].type
                ? parsePointerTypeName(args[0].type)
                : foreignReturn?.kind === "pointer"
                  ? foreignReturn
                  : null;
              const inferredTarget = args[0].type && isNullableObjCTypeName(args[0].type)
                ? publicObjCTypeName(args[0].type)
                : pointer?.nullable
                  ? pointer.ownership === "borrowed"
                    ? viewTypeName(pointerTypeName(pointer.identity, pointer.ownership, false))
                    : pointerTypeName(pointer.identity, pointer.ownership, false)
                  : null;
              const target = qualifier?.arguments[0]
                ?? (contextualOption?.base === "Option" ? contextualOption.arguments[0] : null)
                ?? inferredTarget;
              if (!target) {
                throw new DiagnosticError(
                  fileName,
                  args[0].expression.location,
                  "Option.fromNullable requires a nullable imported reference or C handle",
                );
              }
              const optionType = genericTypeName("Option", [target]);
              return {
                expression: {
                  ...expression,
                  callee: {
                    ...callee.expression,
                    object: { ...callee.expression.object, name: optionType },
                  },
                  arguments: args.map((item) => item.expression),
                },
                type: optionType,
              };
            }
            if (callee.expression.property !== "some") {
              throw new DiagnosticError(fileName, expression.location, "Option.none is a value and must not be called");
            }
            if (args.length !== 1) {
              throw new DiagnosticError(fileName, expression.location, `Option.some expects 1 argument, received ${args.length}`);
            }
            const target = qualifier?.arguments[0]
              ?? (contextualOption?.base === "Option" ? contextualOption.arguments[0] : null)
              ?? args[0].type;
            if (!target) {
              throw new DiagnosticError(fileName, args[0].expression.location, "cannot infer Option payload type from this value");
            }
            const optionType = genericTypeName("Option", [target]);
            return {
              expression: {
                ...expression,
                callee: {
                  ...callee.expression,
                  object: { ...callee.expression.object, name: optionType },
                },
                arguments: args.map((item) => item.expression),
              },
              type: optionType,
            };
          }
        }
        let rewrittenCallee = callee.expression;
        let returnType = callee.type;
        if (rewrittenCallee.kind === "member") {
          const imported = foreignMember(rewrittenCallee);
          returnType = imported ? foreignCallReturnType(imported, args) : returnType;
          const adapterCall = parseGenericType(rewrittenCallee.property);
          const namespace = rewrittenCallee.object.kind === "identifier" ? rewrittenCallee.object.name : null;
          if (namespace
            && adapterCall?.base === "adapt" && adapterCall.arguments.length === 1
            && !environment.has(namespace)
            && program.imports.some((item) => item.header === "std/objc"
              && item.moduleName === namespace)) {
            // Preserve the declared adapter result while inferring a following
            // Option.some/collection use. Sema still validates conformance,
            // ownership, and executor placement at the adapt call itself.
            returnType = genericTypeName(`${namespace}.Adapter`, adapterCall.arguments);
          }
        }
        if (rewrittenCallee.kind === "identifier") {
          const explicitStandard = parseGenericType(rewrittenCallee.name);
          const standardType = standardTypeConstructors.get(explicitStandard?.base ?? rewrittenCallee.name);
          if (standardType === "TextBuffer" || standardType === "Arena") {
            return {
              expression: { ...expression, callee: rewrittenCallee, arguments: args.map((item) => item.expression) },
              type: standardType,
            };
          }
          if (standardType === "Map") {
            if (!explicitStandard || explicitStandard.arguments.length !== 2 || args.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, "Map<K, V>() expects two type arguments and no values");
            }
            const type = genericTypeName("Map", explicitStandard.arguments);
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: type },
                arguments: [],
              },
              type,
            };
          }
          if (standardType === "Set") {
            if (!explicitStandard || explicitStandard.arguments.length !== 1 || args.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, "Set<T>() expects one type argument and no values");
            }
            const type = genericTypeName("Set", explicitStandard.arguments);
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: type },
                arguments: [],
              },
              type,
            };
          }
          if (standardType === "Once") {
            if (!explicitStandard || explicitStandard.arguments.length !== 1 || args.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, "Once<T>() expects one type argument and no values");
            }
            const type = genericTypeName("Once", explicitStandard.arguments);
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: type },
                arguments: [],
              },
              type,
            };
          }
          if (standardType === "Mutex") {
            if (args.length !== 1) {
              throw new DiagnosticError(fileName, expression.location, "Mutex<T>(value) expects exactly one value");
            }
            const valueType = explicitStandard?.arguments[0] ?? args[0].type;
            if (
              (explicitStandard && explicitStandard.arguments.length !== 1)
              || !valueType
            ) {
              throw new DiagnosticError(fileName, expression.location, "cannot infer Mutex payload type from this value");
            }
            const type = genericTypeName("Mutex", [valueType]);
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: type },
                arguments: args.map((item) => item.expression),
              },
              type,
            };
          }
          const aggregateConstructor = aggregate(rewrittenCallee.name);
          if (aggregateConstructor) {
            const explicitAggregate = parseGenericType(rewrittenCallee.name);
            const expected = aggregateConstructor.declaration.typeParameters?.length ?? 0;
            if (explicitAggregate && explicitAggregate.arguments.length !== expected) {
              throw new DiagnosticError(
                fileName,
                rewrittenCallee.location,
                `${explicitAggregate.base} expects ${expected} type argument(s), received ${explicitAggregate.arguments.length}`,
              );
            }
            const inferred = aggregateConstructor.declaration.typeParameters?.length && !explicitAggregate
              ? inferAggregateArguments(
                aggregateConstructor.declaration,
                expression.arguments,
                environment,
                expectedType,
                aggregateConstructor.declaration.name,
                expression.location,
              )
              : null;
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: inferred?.typeName ?? rewrittenCallee.name },
                arguments: (inferred?.arguments ?? args).map((item) => item.expression),
              },
              type: inferred?.typeName ?? rewrittenCallee.name,
            };
          }
          const explicit = parseGenericType(rewrittenCallee.name);
          if (explicit?.base === "Array") {
            if (explicit.arguments.length !== 1) {
              throw new DiagnosticError(fileName, expression.location, "Array<T>(...) expects one type argument");
            }
            returnType = dynamicArrayTypeName(explicit.arguments[0]);
          } else if (callee.type && closureReturns.has(callee.type)) {
            returnType = closureReturns.get(callee.type) ?? returnType;
          } else {
            returnType = functions.get(rewrittenCallee.name)?.returnType.name
              ?? selectiveFunctions.get(rewrittenCallee.name)
              ?? returnType;
          }
        }
        return {
          expression: { ...expression, callee: rewrittenCallee, arguments: args.map((item) => item.expression) },
          type: returnType,
        };
      }
    }
  };

  const matchArmEnvironment = (
    arm: MatchArm,
    environment: Environment,
    matchedType: string | null,
    attemptedSuccessType: string | null = null,
  ): Environment => {
    const armEnvironment = new Map(environment);
    if (arm.binding && matchedType) {
      const variant = enums.get(matchedType)?.variants.find((item) => item.name === arm.variantName);
      const option = parseGenericType(matchedType);
      if (attemptedSuccessType && arm.variantName === "success") {
        armEnvironment.set(arm.binding, attemptedSuccessType);
      } else if (variant?.payload) armEnvironment.set(arm.binding, variant.payload.name);
      else if (option?.base === "Option" && arm.variantName === "some") armEnvironment.set(arm.binding, option.arguments[0]);
    }
    if (arm.objectBindings && matchedType) {
      const variant = enums.get(matchedType)?.variants.find((item) => item.name === arm.variantName);
      const payload = variant?.payload ? structs.get(variant.payload.name) : null;
      for (const fieldBinding of arm.objectBindings) {
        const field = payload?.fields.find((item) => item.name === fieldBinding.fieldName);
        if (field) armEnvironment.set(fieldBinding.bindingName, field.type.name);
      }
    }
    return armEnvironment;
  };

  const rewriteArm = (
    arm: MatchArm,
    environment: Environment,
    matchedType: string | null,
    returnType: string | null = null,
    selectedType: string | null = null,
    attemptedSuccessType: string | null = null,
  ): MatchArm => {
    const armEnvironment = matchArmEnvironment(arm, environment, matchedType, attemptedSuccessType);
    return { ...arm, body: rewriteStatement(arm.body, armEnvironment, returnType, selectedType) };
  };

  const rewriteStatement = (
    statement: Statement,
    environment: Environment,
    returnType: string | null = null,
    selectedType: string | null = null,
  ): Statement => {
    switch (statement.kind) {
      case "variable": {
        let initializer = statement.initializer
          ? rewriteExpression(statement.initializer, environment, statement.type?.name ?? null)
          : null;
        const type = statement.type?.name ?? initializer?.type;
        if (
          statement.type
          && parseGenericType(statement.type.name)?.base === "Option"
          && initializer?.expression.kind === "member"
          && initializer.expression.object.kind === "identifier"
          && initializer.expression.object.name === "Option"
          && initializer.expression.property === "none"
        ) {
          initializer = {
            ...initializer,
            expression: {
              ...initializer.expression,
              object: { ...initializer.expression.object, name: statement.type.name },
            },
          };
        }
        if (type) {
          environment.set(
            statement.name,
            !statement.type && initializer?.expression.kind === "attempt"
              ? attemptedInferenceType(type)
              : type,
          );
        }
        return { ...statement, initializer: initializer?.expression ?? null };
      }
      case "destructure": {
        const initializer = rewriteExpression(statement.initializer, environment, statement.type?.name ?? null);
        const type = statement.type?.name ?? initializer.type;
        const sourceType = type ? parseViewType(type)?.target ?? type : null;
        const declaration = sourceType ? structs.get(sourceType) : null;
        if (declaration && !statement.arrayBindings) {
          for (const binding of statement.objectBindings) {
            const field = declaration.fields.find((candidate) => candidate.name === binding.fieldName);
            if (field) environment.set(binding.bindingName, field.type.name);
          }
        }
        if (sourceType && statement.arrayBindings) {
          const collection = parseFixedArrayType(sourceType)
            ?? parseDynamicArrayType(sourceType)
            ?? parseSliceType(sourceType);
          if (collection) {
            for (const binding of statement.arrayBindings) {
              if (!binding.bindingName) continue;
              environment.set(
                binding.bindingName,
                binding.kind === "rest"
                  ? sliceTypeName(collection.elementType)
                  : collection.elementType,
              );
            }
          }
        }
        return { ...statement, initializer: initializer.expression };
      }
      case "assignment": {
        const target = rewriteExpression(statement.target, environment);
        const expression = rewriteExpression(statement.expression, environment, target.type);
        return { ...statement, target: target.expression as typeof statement.target, expression: expression.expression };
      }
      case "return":
        return statement.expression
          ? { ...statement, expression: rewriteExpression(statement.expression, environment, returnType).expression }
          : statement;
      case "select":
        return { ...statement, expression: rewriteExpression(statement.expression, environment, selectedType).expression };
      case "yield":
        return { ...statement, expression: rewriteExpression(statement.expression, environment).expression };
      case "throw":
      case "expressionStatement":
        return { ...statement, expression: rewriteExpression(statement.expression, environment, selectedType).expression };
      case "block":
        return { ...statement, statements: rewriteStatements(statement.statements, new Map(environment), returnType, selectedType) };
      case "unsafe":
        return {
          ...statement,
          body: rewriteStatement(statement.body, new Map(environment), returnType, selectedType) as typeof statement.body,
        };
      case "if": {
        const condition = rewriteExpression(statement.condition, environment);
        const thenBranch = rewriteStatement(
          statement.thenBranch,
          new Map(environment),
          returnType,
          selectedType,
        ) as typeof statement.thenBranch;
        const elseBranch = statement.elseBranch
          ? rewriteStatement(statement.elseBranch, new Map(environment), returnType, selectedType) as typeof statement.elseBranch
          : null;
        return { ...statement, condition: condition.expression, thenBranch, elseBranch };
      }
      case "while": {
        const condition = rewriteExpression(statement.condition, environment);
        const body = rewriteStatement(statement.body, new Map(environment), returnType) as typeof statement.body;
        return { ...statement, condition: condition.expression, body };
      }
      case "for": {
        const iterable = rewriteExpression(statement.iterable, environment);
        const map = iterable.type ? parseMapType(iterable.type) : null;
        const set = iterable.type ? parseSetType(iterable.type) : null;
        const collection = iterable.type
          ? parseFixedArrayType(iterable.type)
            ?? parseSliceType(iterable.type)
            ?? parseDynamicArrayType(iterable.type)
            ?? (map ? { elementType: mapEntryTypeName(map.keyType, map.valueType) } : null)
            ?? (set ? { elementType: set.elementType } : null)
          : null;
        const bodyEnvironment = new Map(environment);
        if (collection && statement.binding) bodyEnvironment.set(statement.binding, collection.elementType);
        const element = collection ? structs.get(collection.elementType) : null;
        if (element) {
          for (const binding of statement.objectBindings ?? []) {
            const field = element.fields.find((candidate) => candidate.name === binding.fieldName);
            if (field) bodyEnvironment.set(binding.bindingName, field.type.name);
          }
        }
        const body = rewriteStatement(statement.body, bodyEnvironment, returnType) as typeof statement.body;
        return { ...statement, iterable: iterable.expression, body };
      }
      case "match": {
        const matched = rewriteExpression(statement.expression, environment);
        const attemptedSuccessType = statement.expression.kind === "attempt"
          ? matched.type
          : statement.expression.kind === "identifier"
            ? parseAttemptedInferenceType(environment.get(statement.expression.name) ?? null)
            : null;
        return {
          ...statement,
          expression: matched.expression,
          arms: statement.arms.map((arm) => rewriteArm(
            arm,
            environment,
            matched.type,
            returnType,
            selectedType,
            attemptedSuccessType,
          )),
        };
      }
      case "asyncScope":
        return {
          ...statement,
          body: rewriteStatement(statement.body, new Map(environment), returnType) as typeof statement.body,
        };
      case "break":
      case "continue":
        return statement;
    }
  };

  const rewriteStatements = (
    statements: readonly Statement[],
    environment: Environment,
    returnType: string | null = null,
    selectedType: string | null = null,
  ): Statement[] => (
    statements.map((statement, index) => rewriteStatement(
      statement,
      environment,
      returnType,
      index + 1 === statements.length ? selectedType : null,
    ))
  );

  const armValueType = (arms: readonly MatchArm[], environment: Environment): string | null => {
    for (const arm of arms) {
      if (arm.body.kind === "expressionStatement") return rewriteExpression(arm.body.expression, environment).type;
      if (arm.body.kind === "select") return rewriteExpression(arm.body.expression, environment).type;
      if (arm.body.kind === "block") {
        const selected = arm.body.statements.find((statement) => statement.kind === "select");
        if (selected?.kind === "select") return rewriteExpression(selected.expression, environment).type;
      }
    }
    return null;
  };

  const rewriteConstrainedStatements = (
    statements: readonly Statement[],
    environment: Environment,
    typeParameters: readonly string[],
    constraints: readonly TypeParameterConstraint[],
    returnType: string | null = null,
  ): Statement[] => {
    const previousConstraints = activeConstraints;
    const previousTypeParameters = activeTypeParameters;
    activeConstraints = new Map();
    activeTypeParameters = new Set(typeParameters);
    for (const constraint of constraints) {
      activeConstraints.set(constraint.parameter, constraint.traits.map((trait) => trait.name));
    }
    const body = withReturnType(returnType, () => rewriteStatements(statements, environment, returnType));
    activeConstraints = previousConstraints;
    activeTypeParameters = previousTypeParameters;
    return body;
  };

  const rewriteFunction = (
    declaration: FunctionDeclaration,
    receiverType: string | null = null,
    inheritedTypeParameters: readonly string[] = [],
    inheritedConstraints: readonly TypeParameterConstraint[] = [],
  ): FunctionDeclaration => {
    const previousDeferredGenericMethodDemands = activeDeferredGenericMethodDemands;
    const deferredMethodDemands: DeferredGenericMethodDemand[] = [];
    activeDeferredGenericMethodDemands = deferredMethodDemands;
    const environment = new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.type.name]));
    if (receiverType && !declaration.static) environment.set("this", receiverType);
    const body = rewriteConstrainedStatements(
      declaration.body,
      environment,
      [...inheritedTypeParameters, ...(declaration.typeParameters ?? [])],
      [...inheritedConstraints, ...(declaration.typeParameterConstraints ?? [])],
      declaration.returnType.name,
    );
    activeDeferredGenericMethodDemands = previousDeferredGenericMethodDemands;
    if (deferredMethodDemands.length > 0) {
      deferredGenericMethodDemands.set(declaration.location, deferredMethodDemands);
    }
    return { ...declaration, body };
  };

  const rewrittenStructs = program.structs.map((declaration) => {
    const receiverType = declaration.typeParameters?.length
      ? genericTypeName(declaration.name, declaration.typeParameters)
      : declaration.name;
    return {
      ...declaration,
      constructor: declaration.constructor
        ? {
          ...declaration.constructor,
          body: rewriteConstrainedStatements(
            declaration.constructor.body,
            new Map([
              ["this", receiverType],
              ...declaration.constructor.parameters.map((parameter) => [parameter.name, parameter.type.name] as const),
            ]),
            declaration.typeParameters ?? [],
            declaration.typeParameterConstraints ?? [],
            receiverType,
          ),
        }
        : null,
      methods: declaration.methods.map((method) => (
        rewriteFunction(
          method,
          receiverType,
          declaration.typeParameters ?? [],
          declaration.typeParameterConstraints ?? [],
        )
      )),
      deinitializer: declaration.deinitializer
        ? {
          ...declaration.deinitializer,
          body: rewriteConstrainedStatements(
            declaration.deinitializer.body,
            new Map([["this", receiverType]]),
            declaration.typeParameters ?? [],
            declaration.typeParameterConstraints ?? [],
            "void",
          ),
        }
        : null,
    };
  });

  const rewrittenFunctions = program.functions.map((declaration) => rewriteFunction(declaration));
  const specializedStructs = rewrittenStructs.map((declaration) => {
    const requests = methodSpecializations.get(declaration.name);
    if (!requests?.size) return declaration;
    const methods = [...declaration.methods];
    for (const [name, methodName] of requests) {
      const template = declaration.methods.find((method) => method.name === methodName);
      if (template) methods.push({ ...template, name });
    }
    return { ...declaration, methods };
  });

  return {
    program: {
      ...program,
      structs: specializedStructs,
      functions: rewrittenFunctions,
    },
    deferredGenericMethodDemands,
  };
}

function displayType(type: string): string {
  const array = parseFixedArrayType(type);
  if (array) return `${displayType(array.elementType)}[${array.length}]`;
  const slice = parseSliceType(type);
  if (slice) return `Slice<${displayType(slice.elementType)}>`;
  const dynamic = parseDynamicArrayType(type);
  if (dynamic) return `Array<${displayType(dynamic.elementType)}>`;
  const generic = parseGenericType(type);
  return generic ? `${generic.base}<${generic.arguments.map(displayType).join(", ")}>` : type;
}

function inferenceTypeName(type: ForeignType | undefined): string | null {
  if (!type || type.kind === "unsupported" || type.kind === "recordPointer") return null;
  if (type.kind === "scalarPointer") return type.typeName;
  if (type.kind === "z") return type.name;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.kind === "scalar" ? type.type.underlying : type.type.typeName;
  if (type.kind === "callback" || type.kind === "block") return null;
  return type.typeName;
}
