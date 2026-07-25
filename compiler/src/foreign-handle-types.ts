import type {
  Expression,
  FunctionDeclaration,
  MatchArm,
  Program,
  Statement,
  StructDeclaration,
  TypeParameterConstraint,
  TypeReference,
} from "./ast.ts";
import {
  dynamicArrayTypeName,
  fixedArrayTypeName,
  parseDynamicArrayType,
  parseFixedArrayType,
  parseSliceType,
  sliceTypeName,
} from "./array-types.ts";
import type { ForeignModule } from "./foreign.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { isNullableObjCTypeName, nullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";

export type ForeignHandleTypeAliases = {
  readonly canonicalBySourceName: ReadonlyMap<string, string>;
  readonly displayByCanonicalName: ReadonlyMap<string, string>;
};

export function collectForeignHandleTypeAliases(
  modules: ReadonlyMap<string, ForeignModule>,
): ForeignHandleTypeAliases {
  const canonicalBySourceName = new Map<string, string>();
  const displayByCanonicalName = new Map<string, string>();
  for (const module of modules.values()) {
    const byIdentity = new Map<string, { nullable: string | null; nonnull: string | null }>();
    for (const pointer of module.types.values()) {
      if (pointer.ownership !== "owned" || !pointer.release) continue;
      const name = opaqueHandleName(pointer.cName);
      if (!name) continue;
      const pair = byIdentity.get(pointer.identity) ?? { nullable: null, nonnull: null };
      if (pointer.nullable) pair.nullable = pointer.typeName;
      else pair.nonnull = pointer.typeName;
      byIdentity.set(pointer.identity, pair);
    }
    for (const [identity, pair] of byIdentity) {
      const pointer = [...module.types.values()].find((candidate) => (
        candidate.identity === identity && candidate.ownership === "owned"
      ));
      if (!pointer) continue;
      const name = opaqueHandleName(pointer.cName);
      if (!name) continue;
      const sourceName = `${module.declaration.moduleName}.${name}`;
      if (pair.nonnull) {
        canonicalBySourceName.set(sourceName, pair.nonnull);
        displayByCanonicalName.set(pair.nonnull, sourceName);
      }
      if (pair.nullable) {
        canonicalBySourceName.set(nullableObjCTypeName(sourceName), pair.nullable);
        displayByCanonicalName.set(pair.nullable, `${sourceName} | null`);
      }
    }
  }
  return { canonicalBySourceName, displayByCanonicalName };
}

export function resolveForeignHandleTypeAnnotations(
  program: Program,
  aliases: ReadonlyMap<string, string>,
): Program {
  if (aliases.size === 0) return program;
  return transformProgramTypeNames(program, (name) => resolveForeignTypeName(name, aliases));
}

export function transformProgramTypeNames(
  program: Program,
  transformName: (name: string) => string,
): Program {
  const type = (reference: TypeReference): TypeReference => ({
    ...reference,
    name: transformName(reference.name),
  });
  const constraints = (
    values: readonly TypeParameterConstraint[] | undefined,
  ): TypeParameterConstraint[] | undefined => values?.map((constraint) => ({
    ...constraint,
    traits: constraint.traits.map(type),
  }));
  const expression = (value: Expression): Expression => {
    switch (value.kind) {
      case "template":
        return {
          ...value,
          parts: value.parts.map((part) => (
            part.kind === "value" ? { ...part, expression: expression(part.expression) } : part
          )),
        };
      case "unary":
        return { ...value, operand: expression(value.operand) };
      case "weak":
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        return { ...value, expression: expression(value.expression) };
      case "binary":
        return { ...value, left: expression(value.left), right: expression(value.right) };
      case "conditional":
        return {
          ...value,
          condition: expression(value.condition),
          thenExpression: expression(value.thenExpression),
          elseExpression: expression(value.elseExpression),
        };
      case "new":
        return {
          ...value,
          typeName: transformName(value.typeName),
          arguments: value.arguments.map(expression),
        };
      case "closure":
        return {
          ...value,
          parameters: value.parameters.map((parameter) => ({
            ...parameter,
            type: parameter.type ? type(parameter.type) : null,
          })),
          returnType: value.returnType ? type(value.returnType) : null,
          errorType: value.errorType ? type(value.errorType) : null,
          body: value.body.kind === "block" ? statement(value.body) : expression(value.body),
        };
      case "call":
        return { ...value, callee: expression(value.callee), arguments: value.arguments.map(expression) };
      case "member":
        return { ...value, object: expression(value.object) };
      case "index":
        return { ...value, object: expression(value.object), index: expression(value.index) };
      case "arrayExpression":
        return { ...value, elements: value.elements.map(expression) };
      case "dynamicArrayExpression":
        return { ...value, elementType: transformName(value.elementType) };
      case "structExpression":
        return {
          ...value,
          typeName: transformName(value.typeName),
          fields: value.fields.map((field) => ({ ...field, expression: expression(field.expression) })),
        };
      case "objectExpression":
        return {
          ...value,
          fields: value.fields.map((field) => ({ ...field, expression: expression(field.expression) })),
        };
      case "variantExpression":
        return {
          ...value,
          enumName: transformName(value.enumName),
          payload: expression(value.payload),
        };
      case "executorPlacement":
        return {
          ...value,
          executor: expression(value.executor),
          returnType: value.returnType ? type(value.returnType) : null,
          errorType: value.errorType ? type(value.errorType) : null,
          body: statement(value.body),
          call: value.call ? expression(value.call) as typeof value.call : null,
        };
      case "matchExpression":
        return { ...value, expression: expression(value.expression), arms: value.arms.map(arm) };
      case "ifExpression":
        return {
          ...value,
          condition: expression(value.condition),
          thenBranch: statement(value.thenBranch),
          elseBranch: value.elseBranch.kind === "ifExpression"
            ? expression(value.elseBranch) as typeof value.elseBranch
            : statement(value.elseBranch),
        };
      case "unsafeExpression":
        return { ...value, body: statement(value.body) };
      case "whileExpression":
        return {
          ...value,
          condition: expression(value.condition),
          body: statement(value.body),
          elseBranch: statement(value.elseBranch),
        };
      case "forExpression":
        return {
          ...value,
          iterable: expression(value.iterable),
          body: statement(value.body),
          elseBranch: statement(value.elseBranch),
        };
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "argumentReference":
        return value;
      case "identifier":
        return { ...value, name: transformName(value.name) };
    }
  };
  const arm = (value: MatchArm): MatchArm => ({ ...value, body: statement(value.body) });
  const statement = <T extends Statement>(value: T): T => {
    switch (value.kind) {
      case "variable":
        return {
          ...value,
          type: value.type ? type(value.type) : null,
          initializer: value.initializer ? expression(value.initializer) : null,
        } as T;
      case "destructure":
        return {
          ...value,
          type: value.type ? type(value.type) : null,
          initializer: expression(value.initializer),
        } as T;
      case "assignment":
        return {
          ...value,
          target: expression(value.target) as typeof value.target,
          expression: expression(value.expression),
        } as T;
      case "return":
        return { ...value, expression: value.expression ? expression(value.expression) : null } as T;
      case "throw":
      case "yield":
      case "select":
      case "expressionStatement":
        return { ...value, expression: expression(value.expression) } as T;
      case "block":
        return { ...value, statements: value.statements.map(statement) } as T;
      case "unsafe":
        return { ...value, body: statement(value.body) } as T;
      case "if":
        return {
          ...value,
          condition: expression(value.condition),
          thenBranch: statement(value.thenBranch),
          elseBranch: value.elseBranch ? statement(value.elseBranch) : null,
        } as T;
      case "while":
        return { ...value, condition: expression(value.condition), body: statement(value.body) } as T;
      case "for":
        return { ...value, iterable: expression(value.iterable), body: statement(value.body) } as T;
      case "asyncScope":
        return { ...value, body: statement(value.body) } as T;
      case "match":
        return { ...value, expression: expression(value.expression), arms: value.arms.map(arm) } as T;
      case "break":
      case "continue":
        return value;
    }
  };
  const fn = (declaration: FunctionDeclaration): FunctionDeclaration => ({
    ...declaration,
    typeParameterConstraints: constraints(declaration.typeParameterConstraints),
    parameters: declaration.parameters.map((parameter) => ({ ...parameter, type: type(parameter.type) })),
    returnType: type(declaration.returnType),
    errorType: declaration.errorType ? type(declaration.errorType) : null,
    body: declaration.body.map(statement),
  });
  const aggregate = (declaration: StructDeclaration): StructDeclaration => ({
    ...declaration,
    typeParameterConstraints: constraints(declaration.typeParameterConstraints),
    implements: declaration.implements.map(type),
    fields: declaration.fields.map((field) => ({ ...field, type: type(field.type) })),
    constructor: declaration.constructor ? {
      ...declaration.constructor,
      parameters: declaration.constructor.parameters.map((parameter) => ({ ...parameter, type: type(parameter.type) })),
      errorType: declaration.constructor.errorType ? type(declaration.constructor.errorType) : null,
      body: declaration.constructor.body.map(statement),
    } : null,
    methods: declaration.methods.map(fn),
    deinitializer: declaration.deinitializer
      ? { ...declaration.deinitializer, body: declaration.deinitializer.body.map(statement) }
      : null,
  });
  return {
    ...program,
    typeAliases: program.typeAliases.map((declaration) => ({
      ...declaration,
      target: type(declaration.target),
    })),
    traits: program.traits.map((declaration) => ({ ...declaration, methods: declaration.methods.map(fn) })),
    structs: program.structs.map(aggregate),
    enums: program.enums.map((declaration) => ({
      ...declaration,
      variants: declaration.variants.map((variant) => ({
        ...variant,
        payload: variant.payload ? type(variant.payload) : null,
      })),
    })),
    functions: program.functions.map(fn),
  };
}

function resolveForeignTypeName(name: string, aliases: ReadonlyMap<string, string>): string {
  const direct = aliases.get(name);
  if (direct) return direct;
  if (isNullableObjCTypeName(name)) {
    const target = resolveForeignTypeName(publicObjCTypeName(name), aliases);
    return aliases.get(nullableObjCTypeName(publicObjCTypeName(name)))
      ?? (target === publicObjCTypeName(name) ? name : nullableObjCTypeName(target));
  }
  const functionType = parseFunctionType(name);
  if (functionType) {
    return functionTypeName(
      functionType.parameters.map((parameter) => ({
        ...parameter,
        type: resolveForeignTypeName(parameter.type, aliases),
      })),
      resolveForeignTypeName(functionType.returnType, aliases),
      functionType.errorType ? resolveForeignTypeName(functionType.errorType, aliases) : null,
    );
  }
  const view = parseViewType(name);
  if (view) return viewTypeName(resolveForeignTypeName(view.target, aliases));
  const array = parseFixedArrayType(name);
  if (array) return fixedArrayTypeName(resolveForeignTypeName(array.elementType, aliases), array.length);
  const slice = parseSliceType(name);
  if (slice) return sliceTypeName(resolveForeignTypeName(slice.elementType, aliases));
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return dynamicArrayTypeName(resolveForeignTypeName(dynamic.elementType, aliases));
  const generic = parseGenericType(name);
  return generic
    ? genericTypeName(generic.base, generic.arguments.map((argument) => resolveForeignTypeName(argument, aliases)))
    : name;
}

function opaqueHandleName(cName: string): string | null {
  const normalized = cName
    .replace(/\b(?:const|volatile|restrict|_Nonnull|_Nullable|_Null_unspecified)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(?:(?:struct|class|union)\s+)?([A-Za-z_]\w*)\s*\*$/.exec(normalized);
  return match?.[1] ?? null;
}
