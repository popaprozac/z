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
import { isNullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { parseWeakType, weakResultTypeName, weakTypeName } from "./weak-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";

type Environment = Map<string, string>;
type RewrittenExpression = { readonly expression: Expression; readonly type: string | null };

export function inferGenericCalls(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule> = new Map(),
): Program {
  const genericFunctions = new Map(
    program.functions.filter((item) => item.typeParameters?.length).map((item) => [item.name, item]),
  );
  const functions = new Map(program.functions.map((item) => [item.name, item]));
  const structs = new Map(program.structs.map((item) => [item.name, item]));
  const enums = new Map(program.enums.map((item) => [item.name, item]));
  const traits = new Map(program.traits.map((item) => [item.name, item]));
  const methodSpecializations = new Map<string, Map<string, string>>();
  let activeConstraints = new Map<string, string[]>();
  let activeTypeParameters = new Set<string>();
  const closureReturns = new Map<string, string | null>();
  const objectFieldTypes = new Map<number, ReadonlyMap<string, string | null>>();
  const selectiveFunctions = new Map<string, string>();
  const selectiveValues = new Map<string, string>();
  const standardTypeConstructors = new Map(
    program.imports
      .filter((declaration) => (declaration.header === "std/text" || declaration.header === "std/memory") && declaration.bindings)
      .flatMap((declaration) => declaration.bindings!
        .filter((binding) => binding.importedName === "TextBuffer" || binding.importedName === "Arena")
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
          viable = false;
          break;
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
    const functionType = parseFunctionType(type);
    if (functionType) {
      return functionTypeName(
        functionType.parameters.map((parameter) => ({
          ...parameter,
          type: substituteType(parameter.type, substitutions),
        })),
        substituteType(functionType.returnType, substitutions),
      );
    }
    const array = parseFixedArrayType(type);
    if (array) return fixedArrayTypeName(substituteType(array.elementType, substitutions), array.length);
    const slice = parseSliceType(type);
    if (slice) return sliceTypeName(substituteType(slice.elementType, substitutions));
    const dynamic = parseDynamicArrayType(type);
    if (dynamic) return dynamicArrayTypeName(substituteType(dynamic.elementType, substitutions));
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
        || typeMentionsParameter(functionType.returnType, parameter);
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
  ): string => {
    const name = genericTypeName(method.name, [...arguments_]);
    let ownerRequests = methodSpecializations.get(owner.name);
    if (!ownerRequests) {
      ownerRequests = new Map();
      methodSpecializations.set(owner.name, ownerRequests);
    }
    ownerRequests.set(name, method.name);
    return name;
  };

  const inferMethodArguments = (
    owner: StructDeclaration,
    ownerSubstitutions: ReadonlyMap<string, string>,
    method: FunctionDeclaration,
    explicitArguments: readonly string[] | null,
    arguments_: readonly RewrittenExpression[],
    originalArguments: readonly Expression[],
    expectedType: string | null,
    location: Expression["location"],
  ): { readonly name: string; readonly returnType: string } => {
    const methodParameters = method.typeParameters ?? [];
    const callName = `${owner.name}.${method.name}`;
    if (explicitArguments && explicitArguments.length !== methodParameters.length) {
      throw new DiagnosticError(
        fileName,
        location,
        `${callName} expects ${methodParameters.length} type argument(s), received ${explicitArguments.length}`,
      );
    }
    if (arguments_.length !== method.parameters.length) {
      throw new DiagnosticError(
        fileName,
        location,
        `${JSON.stringify(callName)} expects ${method.parameters.length} argument(s), received ${arguments_.length}`,
      );
    }
    const inferred = new Map<string, string>();
    if (explicitArguments) {
      methodParameters.forEach((parameter, index) => inferred.set(parameter, explicitArguments[index]));
    } else {
      const parameters = new Set(methodParameters);
      if (expectedType) {
        unify(
          substituteType(method.returnType.name, ownerSubstitutions),
          expectedType,
          parameters,
          inferred,
          callName,
          location,
        );
      }
      const contextualParameters = new Set(inferred.keys());
      const valueParameters = new Set([...parameters].filter((parameter) => !contextualParameters.has(parameter)));
      for (let index = 0; index < method.parameters.length; index += 1) {
        unify(
          substituteType(method.parameters[index].type.name, ownerSubstitutions),
          arguments_[index].type,
          valueParameters,
          inferred,
          callName,
          originalArguments[index].location,
        );
      }
    }
    const missing = methodParameters.find((parameter) => !inferred.has(parameter));
    if (missing) {
      throw new DiagnosticError(
        fileName,
        location,
        `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(callName)}; specify explicit type arguments`,
      );
    }
    const methodArguments = methodParameters.map((parameter) => inferred.get(parameter)!);
    const substitutions = new Map([...ownerSubstitutions, ...inferred]);
    return {
      name: requestMethodSpecialization(owner, method, methodArguments),
      returnType: substituteType(method.returnType.name, substitutions),
    };
  };

  const inferAggregateArguments = (
    declaration: StructDeclaration,
    arguments_: readonly RewrittenExpression[],
    originalArguments: readonly Expression[],
    expectedType: string | null,
    callName: string,
    location: Expression["location"],
  ): string => {
    const parameters = new Set(declaration.typeParameters ?? []);
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
    if (declaration.constructor) {
      for (let index = 0; index < Math.min(declaration.constructor.parameters.length, arguments_.length); index += 1) {
        unify(
          declaration.constructor.parameters[index].type.name,
          arguments_[index].type,
          valueParameters,
          inferred,
          callName,
          originalArguments[index].location,
        );
      }
    } else if (originalArguments.length === 1 && originalArguments[0].kind === "objectExpression") {
      const fieldTypes = objectFieldTypes.get(originalArguments[0].location.offset);
      for (const initializer of originalArguments[0].fields) {
        const field = declaration.fields.find((candidate) => candidate.name === initializer.name);
        if (!field) continue;
        unify(field.type.name, fieldTypes?.get(initializer.name) ?? null, valueParameters, inferred, callName, initializer.location);
      }
    }
    const missing = declaration.typeParameters?.find((parameter) => !inferred.has(parameter));
    if (missing) {
      throw new DiagnosticError(
        fileName,
        location,
        `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(callName)}; specify explicit type arguments`,
      );
    }
    return genericTypeName(declaration.name, declaration.typeParameters!.map((parameter) => inferred.get(parameter)!));
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
      case "identifier":
        return {
          expression,
          type: environment.get(expression.name)
            ?? selectiveValues.get(expression.name)
            ?? standardTypeConstructors.get(expression.name)
            ?? null,
        };
      case "argumentReference":
        return { expression, type: environment.get(expression.name) ?? null };
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
        const arguments_ = expression.arguments.map((argument) => rewriteExpression(argument, environment));
        const explicit = parseGenericType(expression.typeName);
        const declaration = structs.get(explicit?.base ?? expression.typeName);
        const typeName = declaration?.typeParameters?.length && !explicit
          ? inferAggregateArguments(declaration, arguments_, expression.arguments, expectedType, declaration.name, expression.location)
          : expression.typeName;
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
        const rewrittenBody = expression.body.kind === "block"
          ? {
            expression: rewriteStatement(expression.body, closureEnvironment, expression.returnType?.name ?? null) as typeof expression.body,
            type: null,
          }
          : rewriteExpression(expression.body, closureEnvironment, expression.returnType?.name ?? null);
        const body = rewrittenBody.expression;
        const type = `__z_closure_${expression.location.offset}`;
        const returnType = expression.returnType?.name ?? rewrittenBody.type;
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
        return { expression, type: dynamicArrayTypeName(expression.elementType) };
      case "structExpression": {
        const fields = expression.fields.map((field) => {
          const value = rewriteExpression(field.expression, environment);
          return { ...field, expression: value.expression };
        });
        return { expression: { ...expression, fields }, type: expression.typeName };
      }
      case "objectExpression": {
        const fieldTypes = new Map<string, string | null>();
        const fields = expression.fields.map((field) => {
          const value = rewriteExpression(field.expression, environment);
          fieldTypes.set(field.name, value.type);
          return { ...field, expression: value.expression };
        });
        objectFieldTypes.set(expression.location.offset, fieldTypes);
        return { expression: { ...expression, fields }, type: null };
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
        if (dynamicArray && expression.property === "push") {
          return { expression: { ...expression, object: object.expression }, type: "void" };
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
          ? (activeConstraints.get(object.type) ?? [])
            .flatMap((trait) => traits.get(trait)?.methods ?? [])
            .find((item) => item.name === expression.property)
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
          : method ? substituteType(method.returnType.name, owner!.substitutions) : constrainedMethod?.returnType.name ?? null;
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
        return {
          expression: { ...expression, executor: executor.expression, body },
          type: expression.mode === "spawn" ? null : expression.returnType?.name ?? null,
        };
      }
      case "matchExpression": {
        const matched = rewriteExpression(expression.expression, environment);
        const arms = expression.arms.map((arm) => rewriteArm(arm, environment, matched.type, null, expectedType));
        return { expression: { ...expression, expression: matched.expression, arms }, type: armValueType(arms, environment) };
      }
      case "ifExpression": {
        const condition = rewriteExpression(expression.condition, environment);
        const thenBranch = rewriteStatement(
          expression.thenBranch,
          new Map(environment),
          null,
          expectedType,
        ) as typeof expression.thenBranch;
        const elseBranch = expression.elseBranch.kind === "ifExpression"
          ? rewriteExpression(expression.elseBranch, new Map(environment), expectedType).expression as typeof expression.elseBranch
          : rewriteStatement(expression.elseBranch, new Map(environment), null, expectedType) as typeof expression.elseBranch;
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
      case "call": {
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
        const args = expression.arguments.map((item) => rewriteExpression(item, environment));
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
              args,
              expression.arguments,
              expectedType,
              expression.callee.location,
            );
            return {
              expression: {
                ...expression,
                callee: { ...expression.callee, property: specialized.name },
                arguments: args.map((item) => item.expression),
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
            const inferred = new Map<string, string>();
            const parameters = new Set(owner.typeParameters);
            if (explicitMethod) {
              if (explicitMethod.arguments.length !== owner.typeParameters.length) {
                throw new DiagnosticError(
                  fileName,
                  expression.callee.location,
                  `${owner.name}.${method.name} expects ${owner.typeParameters.length} type argument(s), received ${explicitMethod.arguments.length}`,
                );
              }
              owner.typeParameters.forEach((parameter, index) => inferred.set(parameter, explicitMethod.arguments[index]));
            } else {
              if (expectedType) {
                unify(method.returnType.name, expectedType, parameters, inferred, `${owner.name}.${method.name}`, expression.location);
              }
              const contextualParameters = new Set(inferred.keys());
              const valueParameters = new Set([...parameters].filter((parameter) => !contextualParameters.has(parameter)));
              for (let index = 0; index < Math.min(method.parameters.length, args.length); index += 1) {
                unify(
                  method.parameters[index].type.name,
                  args[index].type,
                  valueParameters,
                  inferred,
                  `${owner.name}.${method.name}`,
                  expression.arguments[index].location,
                );
              }
            }
            const missing = owner.typeParameters.find((parameter) => !inferred.has(parameter));
            if (missing) {
              throw new DiagnosticError(
                fileName,
                expression.callee.location,
                `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(`${owner.name}.${method.name}`)}; specify explicit type arguments`,
              );
            }
            const concreteOwner = genericTypeName(owner.name, owner.typeParameters.map((parameter) => inferred.get(parameter)!));
            return {
              expression: {
                ...expression,
                callee: {
                  ...expression.callee,
                  object: { ...expression.callee.object, name: concreteOwner },
                  property: method.name,
                },
                arguments: args.map((item) => item.expression),
              },
              type: substituteType(method.returnType.name, inferred),
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
              args,
              expression.arguments,
              expectedType,
              expression.callee.location,
            );
            return {
              expression: {
                ...expression,
                callee: { ...expression.callee, object: receiver.expression, property: specialized.name },
                arguments: args.map((item) => item.expression),
              },
              type: specialized.returnType,
            };
          }
        }
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
              const pointer = args[0].type ? parsePointerTypeName(args[0].type) : null;
              const inferredTarget = args[0].type && isNullableObjCTypeName(args[0].type)
                ? publicObjCTypeName(args[0].type)
                : pointer?.nullable
                  ? pointerTypeName(pointer.identity, pointer.ownership, false)
                  : null;
              const target = qualifier?.arguments[0] ?? inferredTarget;
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
        }
        if (rewrittenCallee.kind === "identifier") {
          const standardType = standardTypeConstructors.get(rewrittenCallee.name);
          if (standardType === "TextBuffer" || standardType === "Arena") {
            return {
              expression: { ...expression, callee: rewrittenCallee, arguments: args.map((item) => item.expression) },
              type: standardType,
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
            const inferredType = aggregateConstructor.declaration.typeParameters?.length && !explicitAggregate
              ? inferAggregateArguments(
                aggregateConstructor.declaration,
                args,
                expression.arguments,
                expectedType,
                aggregateConstructor.declaration.name,
                expression.location,
              )
              : rewrittenCallee.name;
            return {
              expression: {
                ...expression,
                callee: { ...rewrittenCallee, name: inferredType },
                arguments: args.map((item) => item.expression),
              },
              type: inferredType,
            };
          }
          const explicit = parseGenericType(rewrittenCallee.name);
          if (explicit?.base === "Array") {
            if (explicit.arguments.length !== 1 || args.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, "Array<T>() expects one type argument and no values");
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

  const rewriteArm = (
    arm: MatchArm,
    environment: Environment,
    matchedType: string | null,
    returnType: string | null = null,
    selectedType: string | null = null,
  ): MatchArm => {
    const armEnvironment = new Map(environment);
    if (arm.binding && matchedType) {
      const variant = enums.get(matchedType)?.variants.find((item) => item.name === arm.variantName);
      const option = parseGenericType(matchedType);
      if (variant?.payload) armEnvironment.set(arm.binding, variant.payload.name);
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
        if (type) environment.set(statement.name, type);
        return { ...statement, initializer: initializer?.expression ?? null };
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
      case "throw":
      case "expressionStatement":
        return { ...statement, expression: rewriteExpression(statement.expression, environment, selectedType).expression };
      case "block":
        return { ...statement, statements: rewriteStatements(statement.statements, new Map(environment), returnType, selectedType) };
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
        const collection = iterable.type
          ? parseFixedArrayType(iterable.type) ?? parseSliceType(iterable.type) ?? parseDynamicArrayType(iterable.type)
          : null;
        const bodyEnvironment = new Map(environment);
        if (collection) bodyEnvironment.set(statement.binding, collection.elementType);
        const body = rewriteStatement(statement.body, bodyEnvironment, returnType) as typeof statement.body;
        return { ...statement, iterable: iterable.expression, body };
      }
      case "match": {
        const matched = rewriteExpression(statement.expression, environment);
        return {
          ...statement,
          expression: matched.expression,
          arms: statement.arms.map((arm) => rewriteArm(arm, environment, matched.type, returnType, selectedType)),
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
    const body = rewriteStatements(statements, environment, returnType);
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
    const environment = new Map(declaration.parameters.map((parameter) => [parameter.name, parameter.type.name]));
    if (receiverType && !declaration.static) environment.set("this", receiverType);
    const body = rewriteConstrainedStatements(
      declaration.body,
      environment,
      [...inheritedTypeParameters, ...(declaration.typeParameters ?? [])],
      [...inheritedConstraints, ...(declaration.typeParameterConstraints ?? [])],
      declaration.returnType.name,
    );
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
    ...program,
    structs: specializedStructs,
    functions: rewrittenFunctions,
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
  if (type.kind === "z") return type.name;
  if (type.kind === "named") return type.type.typeName;
  if (type.kind === "reference") return type.type.kind === "scalar" ? type.type.underlying : type.type.typeName;
  if (type.kind === "callback" || type.kind === "block") return null;
  return type.typeName;
}
