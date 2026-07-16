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
import type { ForeignModule, ForeignType } from "./foreign.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";

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
  let activeConstraints = new Map<string, string[]>();
  let activeTypeParameters = new Set<string>();
  const closureReturns = new Map<string, string | null>();
  const selectiveFunctions = new Map<string, ForeignType>();
  const selectiveValues = new Map<string, string>();
  for (const module of foreignModules.values()) {
    for (const binding of module.declaration.bindings ?? []) {
      const fn = module.functions.get(binding.importedName);
      if (fn) selectiveFunctions.set(binding.localName, fn.returnType);
      const constant = module.constants.get(binding.importedName);
      if (constant) selectiveValues.set(binding.localName, constant.typeName);
    }
  }

  const substituteType = (type: string, substitutions: ReadonlyMap<string, string>): string => {
    const direct = substitutions.get(type);
    if (direct) return direct;
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

  const rewriteExpression = (expression: Expression, environment: Environment): RewrittenExpression => {
    switch (expression.kind) {
      case "number":
        return { expression, type: /^[0-9]+$/.test(expression.value) ? "i32" : "f64" };
      case "string":
        return { expression, type: "cstring" };
      case "template": {
        const parts = expression.parts.map((part) => part.kind === "text"
          ? part
          : { ...part, expression: rewriteExpression(part.expression, environment).expression });
        return { expression: { ...expression, parts }, type: "__z_template" };
      }
      case "boolean":
        return { expression, type: "bool" };
      case "null":
        return { expression, type: "null" };
      case "identifier":
        return { expression, type: environment.get(expression.name) ?? selectiveValues.get(expression.name) ?? null };
      case "argumentReference":
        return { expression, type: environment.get(expression.name) ?? null };
      case "unary": {
        const operand = rewriteExpression(expression.operand, environment);
        return { expression: { ...expression, operand: operand.expression }, type: expression.operator === "!" ? "bool" : operand.type };
      }
      case "binary": {
        const left = rewriteExpression(expression.left, environment);
        const right = rewriteExpression(expression.right, environment);
        const comparison = ["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(expression.operator);
        return {
          expression: { ...expression, left: left.expression, right: right.expression },
          type: comparison ? "bool" : left.type ?? right.type,
        };
      }
      case "conditional": {
        const condition = rewriteExpression(expression.condition, environment);
        const thenExpression = rewriteExpression(expression.thenExpression, new Map(environment));
        const elseExpression = rewriteExpression(expression.elseExpression, new Map(environment));
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
      case "closure": {
        const closureEnvironment = new Map(environment);
        for (const parameter of expression.parameters) closureEnvironment.set(parameter.name, parameter.type.name);
        const rewrittenBody = expression.body.kind === "block"
          ? { expression: rewriteStatement(expression.body, closureEnvironment) as typeof expression.body, type: null }
          : rewriteExpression(expression.body, closureEnvironment);
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
      case "member": {
        const object = rewriteExpression(expression.object, environment);
        const dynamicArray = object.type ? parseDynamicArrayType(object.type) : null;
        if (dynamicArray && (expression.property === "length" || expression.property === "capacity")) {
          return { expression: { ...expression, object: object.expression }, type: "usize" };
        }
        if (dynamicArray && expression.property === "push") {
          return { expression: { ...expression, object: object.expression }, type: "void" };
        }
        if (expression.object.kind === "identifier") {
          const module = foreignModules.get(expression.object.name);
          const fn = module?.functions.get(expression.property);
          const constant = module?.constants.get(expression.property);
          const named = module?.namedTypes.get(expression.property);
          const foreignType = fn ? inferenceTypeName(fn.returnType) : constant?.typeName ?? named?.typeName ?? null;
          if (foreignType) return { expression: { ...expression, object: object.expression }, type: foreignType };
        }
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
        const indexed = object.type
          ? parseFixedArrayType(object.type) ?? parseSliceType(object.type) ?? parseDynamicArrayType(object.type)
          : null;
        return { expression: { ...expression, object: object.expression, index: index.expression }, type: indexed?.elementType ?? null };
      }
      case "variantExpression": {
        const payload = rewriteExpression(expression.payload, environment);
        return { expression: { ...expression, payload: payload.expression }, type: expression.enumName };
      }
      case "attempt":
      case "try": {
        const inner = rewriteExpression(expression.expression, environment);
        return { expression: { ...expression, expression: inner.expression }, type: inner.type };
      }
      case "matchExpression": {
        const matched = rewriteExpression(expression.expression, environment);
        const arms = expression.arms.map((arm) => rewriteArm(arm, environment, matched.type));
        return { expression: { ...expression, expression: matched.expression, arms }, type: armValueType(arms, environment) };
      }
      case "ifExpression": {
        const condition = rewriteExpression(expression.condition, environment);
        const thenBranch = rewriteStatement(expression.thenBranch, new Map(environment)) as typeof expression.thenBranch;
        const elseBranch = expression.elseBranch.kind === "ifExpression"
          ? rewriteExpression(expression.elseBranch, new Map(environment)).expression as typeof expression.elseBranch
          : rewriteStatement(expression.elseBranch, new Map(environment)) as typeof expression.elseBranch;
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
        const callee = rewriteExpression(expression.callee, environment);
        const args = expression.arguments.map((item) => rewriteExpression(item, environment));
        let rewrittenCallee = callee.expression;
        let returnType = callee.type;
        if (rewrittenCallee.kind === "identifier") {
          const explicit = parseGenericType(rewrittenCallee.name);
          const template = genericFunctions.get(explicit?.base ?? rewrittenCallee.name);
          if (explicit && template) {
            const substitutions = new Map(template.typeParameters!.map((parameter, index) => [parameter, explicit.arguments[index]]));
            returnType = substituteType(template.returnType.name, substitutions);
          } else if (explicit?.base === "Array") {
            if (explicit.arguments.length !== 1 || args.length !== 0) {
              throw new DiagnosticError(fileName, expression.location, "Array<T>() expects one type argument and no values");
            }
            returnType = dynamicArrayTypeName(explicit.arguments[0]);
          } else if (!explicit && template) {
            if (template.parameters.length !== args.length) {
              throw new DiagnosticError(
                fileName,
                expression.location,
                `${JSON.stringify(template.name)} expects ${template.parameters.length} argument(s), received ${args.length}`,
              );
            }
            const inferred = new Map<string, string>();
            const parameters = new Set(template.typeParameters!);
            for (let index = 0; index < template.parameters.length; index += 1) {
              unify(
                template.parameters[index].type.name,
                args[index].type,
                parameters,
                inferred,
                template.name,
                args[index].expression.location,
              );
            }
            const missing = template.typeParameters!.find((parameter) => !inferred.has(parameter));
            if (missing) {
              throw new DiagnosticError(
                fileName,
                rewrittenCallee.location,
                `cannot infer type parameter ${JSON.stringify(missing)} for ${JSON.stringify(template.name)}; `
                  + "specify explicit type arguments",
              );
            }
            const arguments_ = template.typeParameters!.map((parameter) => inferred.get(parameter)!);
            rewrittenCallee = { ...rewrittenCallee, name: genericTypeName(template.name, arguments_) };
            returnType = substituteType(template.returnType.name, inferred);
          } else if (callee.type && closureReturns.has(callee.type)) {
            returnType = closureReturns.get(callee.type) ?? returnType;
          } else {
            returnType = functions.get(rewrittenCallee.name)?.returnType.name
              ?? inferenceTypeName(selectiveFunctions.get(rewrittenCallee.name))
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

  const rewriteArm = (arm: MatchArm, environment: Environment, matchedType: string | null): MatchArm => {
    const armEnvironment = new Map(environment);
    if (arm.binding && matchedType) {
      const variant = enums.get(matchedType)?.variants.find((item) => item.name === arm.variantName);
      if (variant?.payload) armEnvironment.set(arm.binding, variant.payload.name);
    }
    return { ...arm, body: rewriteStatement(arm.body, armEnvironment) };
  };

  const rewriteStatement = (statement: Statement, environment: Environment): Statement => {
    switch (statement.kind) {
      case "variable": {
        const initializer = statement.initializer ? rewriteExpression(statement.initializer, environment) : null;
        const type = statement.type?.name ?? initializer?.type;
        if (type) environment.set(statement.name, type);
        return { ...statement, initializer: initializer?.expression ?? null };
      }
      case "assignment": {
        const target = rewriteExpression(statement.target, environment);
        const expression = rewriteExpression(statement.expression, environment);
        return { ...statement, target: target.expression as typeof statement.target, expression: expression.expression };
      }
      case "return":
        return statement.expression
          ? { ...statement, expression: rewriteExpression(statement.expression, environment).expression }
          : statement;
      case "throw":
      case "select":
      case "expressionStatement":
        return { ...statement, expression: rewriteExpression(statement.expression, environment).expression };
      case "block":
        return { ...statement, statements: rewriteStatements(statement.statements, new Map(environment)) };
      case "if": {
        const condition = rewriteExpression(statement.condition, environment);
        const thenBranch = rewriteStatement(statement.thenBranch, new Map(environment)) as typeof statement.thenBranch;
        const elseBranch = statement.elseBranch
          ? rewriteStatement(statement.elseBranch, new Map(environment)) as typeof statement.elseBranch
          : null;
        return { ...statement, condition: condition.expression, thenBranch, elseBranch };
      }
      case "while": {
        const condition = rewriteExpression(statement.condition, environment);
        const body = rewriteStatement(statement.body, new Map(environment)) as typeof statement.body;
        return { ...statement, condition: condition.expression, body };
      }
      case "for": {
        const iterable = rewriteExpression(statement.iterable, environment);
        const collection = iterable.type
          ? parseFixedArrayType(iterable.type) ?? parseSliceType(iterable.type) ?? parseDynamicArrayType(iterable.type)
          : null;
        const bodyEnvironment = new Map(environment);
        if (collection) bodyEnvironment.set(statement.binding, collection.elementType);
        const body = rewriteStatement(statement.body, bodyEnvironment) as typeof statement.body;
        return { ...statement, iterable: iterable.expression, body };
      }
      case "match": {
        const matched = rewriteExpression(statement.expression, environment);
        return {
          ...statement,
          expression: matched.expression,
          arms: statement.arms.map((arm) => rewriteArm(arm, environment, matched.type)),
        };
      }
      case "break":
      case "continue":
        return statement;
    }
  };

  const rewriteStatements = (statements: readonly Statement[], environment: Environment): Statement[] => (
    statements.map((statement) => rewriteStatement(statement, environment))
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
  ): Statement[] => {
    const previousConstraints = activeConstraints;
    const previousTypeParameters = activeTypeParameters;
    activeConstraints = new Map();
    activeTypeParameters = new Set(typeParameters);
    for (const constraint of constraints) {
      activeConstraints.set(constraint.parameter, constraint.traits.map((trait) => trait.name));
    }
    const body = rewriteStatements(statements, environment);
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
    if (receiverType) environment.set("this", receiverType);
    const body = rewriteConstrainedStatements(
      declaration.body,
      environment,
      [...inheritedTypeParameters, ...(declaration.typeParameters ?? [])],
      [...inheritedConstraints, ...(declaration.typeParameterConstraints ?? [])],
    );
    return { ...declaration, body };
  };

  const rewrittenStructs = program.structs.map((declaration) => {
    const receiverType = declaration.typeParameters?.length
      ? genericTypeName(declaration.name, declaration.typeParameters)
      : declaration.name;
    return {
      ...declaration,
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
          ),
        }
        : null,
    };
  });

  return {
    ...program,
    structs: rewrittenStructs,
    functions: program.functions.map((declaration) => rewriteFunction(declaration)),
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
  return type.typeName;
}
