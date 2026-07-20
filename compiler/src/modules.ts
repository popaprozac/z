import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
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
import { DiagnosticError } from "./diagnostics.ts";
import { genericTypeName, parseGenericType } from "./generic-types.ts";
import { functionTypeName, parseFunctionType } from "./function-types.ts";
import { isNullableObjCTypeName, nullableObjCTypeName, publicObjCTypeName } from "./objc-types.ts";
import { lex } from "./lexer.ts";
import { parse } from "./parser.ts";
import { parseViewType, viewTypeName } from "./view-types.ts";

export type SourceModuleInfo = {
  readonly fileName: string;
  readonly program: Program;
  readonly exports: ReadonlyMap<string, { readonly linkedName: string; readonly location: SourceLocation }>;
};

export type ModuleLinkResult = {
  readonly program: Program;
  readonly modules: ReadonlyMap<string, SourceModuleInfo>;
  readonly includeDirectories: readonly string[];
  readonly typeDisplayNames: ReadonlyMap<string, string>;
};

type ModuleNode = {
  readonly id: number;
  readonly fileName: string;
  readonly program: Program;
  readonly dependencies: Map<number, ModuleNode>;
  readonly ownNames: Map<string, string>;
  readonly exports: Map<string, { readonly linkedName: string; readonly location: SourceLocation }>;
};

type ModuleScope = {
  readonly globals: Map<string, string>;
  readonly namespaces: Map<string, ModuleNode>;
};

export function isLocalSourceModuleSpecifier(specifier: string): boolean {
  return (specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".z");
}

export function linkSourceModules(entryProgram: Program, entryFileName: string): ModuleLinkResult {
  const entryPath = resolve(entryFileName);
  const nodes = new Map<string, ModuleNode>();
  let nextId = 0;

  const load = (
    fileName: string,
    suppliedProgram: Program | null,
    stack: readonly string[],
    importDeclaration: ImportDeclaration | null,
  ): ModuleNode => {
    const absolute = resolve(fileName);
    const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
    const cycleIndex = stack.indexOf(canonical);
    if (cycleIndex >= 0) {
      const cycle = [...stack.slice(cycleIndex), canonical].map((item) => basename(item)).join(" -> ");
      throw new DiagnosticError(
        importDeclaration?.location.fileName ?? entryPath,
        importDeclaration?.location ?? { offset: 0, line: 1, column: 1, fileName: entryPath },
        `circular Z module import: ${cycle}`,
        { code: "Z0601", helps: ["move shared declarations into a module that does not import either side"] },
      );
    }
    const cached = nodes.get(canonical);
    if (cached) return cached;
    if (!suppliedProgram && !existsSync(canonical)) {
      throw new DiagnosticError(
        importDeclaration?.location.fileName ?? entryPath,
        importDeclaration?.location ?? { offset: 0, line: 1, column: 1, fileName: entryPath },
        `could not find Z module ${JSON.stringify(importDeclaration?.header ?? canonical)}`,
        { code: "Z0602", helps: ["use a relative path ending in `.z`"] },
      );
    }
    const program = suppliedProgram ?? parse(lex(readFileSync(canonical, "utf8"), canonical), canonical);
    const node: ModuleNode = {
      id: nextId++,
      fileName: canonical,
      program,
      dependencies: new Map(),
      ownNames: new Map(),
      exports: new Map(),
    };
    nodes.set(canonical, node);
    collectOwnNames(node, suppliedProgram !== null && stack.length === 0);
    for (const declaration of program.imports) {
      if (!isLocalSourceModuleSpecifier(declaration.header)) continue;
      const dependencyPath = resolve(dirname(canonical), declaration.header);
      const dependency = load(dependencyPath, null, [...stack, canonical], declaration);
      node.dependencies.set(declaration.location.offset, dependency);
    }
    for (const declaration of program.exports) {
      const linkedName = node.ownNames.get(declaration.name);
      if (!linkedName) {
        throw new DiagnosticError(canonical, declaration.location, `cannot export unknown declaration ${JSON.stringify(declaration.name)}`, {
          code: "Z0602",
        });
      }
      if (node.exports.has(declaration.name)) {
        throw new DiagnosticError(canonical, declaration.location, `duplicate export ${JSON.stringify(declaration.name)}`, { code: "Z0603" });
      }
      node.exports.set(declaration.name, { linkedName, location: declaration.location });
    }
    return node;
  };

  const entry = load(entryPath, entryProgram, [], null);
  const ordered: ModuleNode[] = [];
  const visited = new Set<string>();
  const visit = (node: ModuleNode): void => {
    if (visited.has(node.fileName)) return;
    visited.add(node.fileName);
    for (const dependency of node.dependencies.values()) visit(dependency);
    ordered.push(node);
  };
  visit(entry);

  const imports: ImportDeclaration[] = [];
  const traits: Program["traits"] = [];
  const structs: Program["structs"] = [];
  const enums: Program["enums"] = [];
  const functions: Program["functions"] = [];
  for (const node of ordered) {
    const scope = buildScope(node);
    imports.push(...node.program.imports
      .filter((declaration) => !isLocalSourceModuleSpecifier(declaration.header))
      .map((declaration) => rewriteNativeImport(declaration, node, scope)));
    traits.push(...node.program.traits.map((declaration) => transformTrait(declaration, node, scope)));
    structs.push(...node.program.structs.map((declaration) => transformStruct(declaration, node, scope)));
    enums.push(...node.program.enums.map((declaration) => ({
      ...declaration,
      name: node.ownNames.get(declaration.name)!,
      variants: declaration.variants.map((variant) => ({
        ...variant,
        payload: variant.payload ? renameTypeReference(variant.payload, scope, new Set()) : null,
      })),
    })));
    functions.push(...node.program.functions.map((declaration) => transformFunction(declaration, node, scope, null)));
  }

  const linkedProgram: Program = {
    kind: "program",
    imports,
    exports: entry.program.exports,
    traits,
    structs,
    enums,
    functions,
  };
  const offsetBases = moduleOffsetBases([...nodes.values()], entry);
  return {
    program: rebaseLinkedLocations(linkedProgram, offsetBases),
    modules: new Map(ordered.map((node) => [node.fileName, {
      fileName: node.fileName,
      program: node.program,
      exports: node.exports,
    }])),
    includeDirectories: [...new Set(ordered.filter((node) => node !== entry).map((node) => dirname(node.fileName)))],
    typeDisplayNames: new Map(ordered.flatMap((node) => [
      ...node.program.traits,
      ...node.program.structs,
      ...node.program.enums,
    ].map((declaration) => [node.ownNames.get(declaration.name)!, declaration.name] as const))),
  };
}

function moduleOffsetBases(nodes: readonly ModuleNode[], entry: ModuleNode): ReadonlyMap<string, number> {
  const maximumOffset = (value: unknown): number => {
    let maximum = 0;
    const visit = (item: unknown): void => {
      if (!item || typeof item !== "object") return;
      if (Array.isArray(item)) {
        for (const child of item) visit(child);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.offset === "number" && typeof record.line === "number" && typeof record.column === "number") {
        maximum = Math.max(maximum, record.offset);
        return;
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(value);
    return maximum;
  };
  const bases = new Map<string, number>([[entry.fileName, 0]]);
  let next = maximumOffset(entry.program) + 1;
  for (const node of [...nodes].sort((left, right) => left.id - right.id)) {
    if (node === entry) continue;
    bases.set(node.fileName, next);
    next += maximumOffset(node.program) + 1;
  }
  return bases;
}

function rebaseLinkedLocations<T>(value: T, bases: ReadonlyMap<string, number>): T {
  if (Array.isArray(value)) return value.map((item) => rebaseLinkedLocations(item, bases)) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.offset === "number" && typeof record.line === "number" && typeof record.column === "number") {
    const base = typeof record.fileName === "string" ? bases.get(record.fileName) ?? 0 : 0;
    return { ...record, offset: record.offset + base } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, rebaseLinkedLocations(child, bases)]),
  ) as T;
}

function collectOwnNames(node: ModuleNode, entry: boolean): void {
  const declarations = [
    ...node.program.traits,
    ...node.program.structs,
    ...node.program.enums,
    ...node.program.functions,
  ];
  for (const declaration of declarations) {
    if (node.ownNames.has(declaration.name)) {
      throw new DiagnosticError(node.fileName, declaration.location, `duplicate top-level name ${JSON.stringify(declaration.name)}`, {
        code: "Z0603",
      });
    }
    node.ownNames.set(declaration.name, entry ? declaration.name : `__z_module_${node.id}_${declaration.name}`);
  }
}

function buildScope(node: ModuleNode): ModuleScope {
  const globals = new Map(node.ownNames);
  const namespaces = new Map<string, ModuleNode>();
  const occupied = new Map<string, SourceLocation>();
  for (const declaration of [
    ...node.program.traits,
    ...node.program.structs,
    ...node.program.enums,
    ...node.program.functions,
  ]) occupied.set(declaration.name, declaration.location);

  const bind = (name: string, linkedName: string, location: SourceLocation): void => {
    if (occupied.has(name)) {
      throw new DiagnosticError(node.fileName, location, `duplicate module binding ${JSON.stringify(name)}`, { code: "Z0603" });
    }
    occupied.set(name, location);
    globals.set(name, linkedName);
  };

  for (const declaration of node.program.imports) {
    const dependency = node.dependencies.get(declaration.location.offset);
    if (dependency) {
      if (!declaration.bindings) {
        if (occupied.has(declaration.moduleName)) {
          throw new DiagnosticError(node.fileName, declaration.location, `duplicate module binding ${JSON.stringify(declaration.moduleName)}`, { code: "Z0603" });
        }
        occupied.set(declaration.moduleName, declaration.location);
        namespaces.set(declaration.moduleName, dependency);
        continue;
      }
      for (const binding of declaration.bindings) {
        const exported = dependency.exports.get(binding.importedName);
        if (!exported) {
          throw new DiagnosticError(node.fileName, binding.location, `module ${JSON.stringify(declaration.header)} has no export ${JSON.stringify(binding.importedName)}`, {
            code: "Z0602",
            helps: ["add `export` to the declaration in its defining module"],
          });
        }
        bind(binding.localName, exported.linkedName, binding.location);
      }
      continue;
    }
    if (!declaration.bindings) {
      bind(declaration.moduleName, linkedImportName(node, declaration.moduleName), declaration.location);
    } else {
      for (const binding of declaration.bindings) {
        bind(binding.localName, linkedImportName(node, binding.localName), binding.location);
      }
    }
  }
  return { globals, namespaces };
}

function linkedImportName(node: ModuleNode, name: string): string {
  return node.id === 0 ? name : `__z_module_${node.id}_import_${name}`;
}

function rewriteNativeImport(declaration: ImportDeclaration, node: ModuleNode, scope: ModuleScope): ImportDeclaration {
  return {
    ...declaration,
    moduleName: declaration.bindings
      ? linkedImportName(node, declaration.moduleName)
      : scope.globals.get(declaration.moduleName) ?? declaration.moduleName,
    bindings: declaration.bindings?.map((binding) => ({
      ...binding,
      localName: scope.globals.get(binding.localName) ?? binding.localName,
    })) ?? null,
  };
}

function transformTrait(declaration: Program["traits"][number], node: ModuleNode, scope: ModuleScope): Program["traits"][number] {
  return {
    ...declaration,
    name: node.ownNames.get(declaration.name)!,
    methods: declaration.methods.map((method) => transformFunction(method, node, scope, null)),
  };
}

function transformStruct(declaration: StructDeclaration, node: ModuleNode, scope: ModuleScope): StructDeclaration {
  const typeParameters = new Set(declaration.typeParameters ?? []);
  return {
    ...declaration,
    name: node.ownNames.get(declaration.name)!,
    typeParameterConstraints: declaration.typeParameterConstraints?.map((constraint) => ({
      ...constraint,
      traits: constraint.traits.map((trait) => renameTypeReference(trait, scope, typeParameters)),
    })),
    implements: declaration.implements.map((item) => renameTypeReference(item, scope, typeParameters)),
    fields: declaration.fields.map((field) => ({ ...field, type: renameTypeReference(field.type, scope, typeParameters) })),
    constructor: declaration.constructor
      ? {
        ...declaration.constructor,
        parameters: declaration.constructor.parameters.map((parameter) => ({
          ...parameter,
          type: renameTypeReference(parameter.type, scope, typeParameters),
        })),
        errorType: declaration.constructor.errorType
          ? renameTypeReference(declaration.constructor.errorType, scope, typeParameters)
          : null,
        body: transformStatements(
          declaration.constructor.body,
          scope,
          new Set(["this", ...declaration.constructor.parameters.map((parameter) => parameter.name)]),
          typeParameters,
        ),
      }
      : null,
    methods: declaration.methods.map((method) => transformFunction(method, node, scope, declaration.name)),
    deinitializer: declaration.deinitializer
      ? { ...declaration.deinitializer, body: transformStatements(declaration.deinitializer.body, scope, new Set(["this"]), typeParameters) }
      : null,
  };
}

function transformFunction(
  declaration: FunctionDeclaration,
  node: ModuleNode,
  scope: ModuleScope,
  receiver: string | null,
): FunctionDeclaration {
  const typeParameters = new Set(declaration.typeParameters ?? []);
  const locals = new Set(declaration.parameters.map((parameter) => parameter.name));
  if (receiver && !declaration.static) locals.add("this");
  return {
    ...declaration,
    name: receiver ? declaration.name : node.ownNames.get(declaration.name) ?? declaration.name,
    typeParameterConstraints: declaration.typeParameterConstraints?.map((constraint) => ({
      ...constraint,
      traits: constraint.traits.map((trait) => renameTypeReference(trait, scope, typeParameters)),
    })),
    parameters: declaration.parameters.map((parameter) => ({
      ...parameter,
      type: renameTypeReference(parameter.type, scope, typeParameters),
    })),
    returnType: renameTypeReference(declaration.returnType, scope, typeParameters),
    errorType: declaration.errorType ? renameTypeReference(declaration.errorType, scope, typeParameters) : null,
    body: transformStatements(declaration.body, scope, locals, typeParameters),
  };
}

function transformStatements(
  statements: readonly Statement[],
  scope: ModuleScope,
  initialLocals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Statement[] {
  const locals = new Set(initialLocals);
  const transformed: Statement[] = [];
  for (const statement of statements) {
    transformed.push(transformStatement(statement, scope, locals, typeParameters));
    if (statement.kind === "variable") locals.add(statement.name);
  }
  return transformed;
}

function transformStatement(
  statement: Statement,
  scope: ModuleScope,
  locals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Statement {
  switch (statement.kind) {
    case "variable":
      return {
        ...statement,
        type: statement.type ? renameTypeReference(statement.type, scope, typeParameters) : null,
        initializer: statement.initializer ? transformExpression(statement.initializer, scope, locals, typeParameters) : null,
      };
    case "assignment":
      return {
        ...statement,
        target: transformExpression(statement.target, scope, locals, typeParameters) as typeof statement.target,
        expression: transformExpression(statement.expression, scope, locals, typeParameters),
      };
    case "return":
      return { ...statement, expression: statement.expression ? transformExpression(statement.expression, scope, locals, typeParameters) : null };
    case "throw":
    case "select":
    case "expressionStatement":
      return { ...statement, expression: transformExpression(statement.expression, scope, locals, typeParameters) };
    case "block":
      return { ...statement, statements: transformStatements(statement.statements, scope, new Set(locals), typeParameters) };
    case "if":
      return {
        ...statement,
        condition: transformExpression(statement.condition, scope, locals, typeParameters),
        thenBranch: {
          ...statement.thenBranch,
          statements: transformStatements(statement.thenBranch.statements, scope, new Set(locals), typeParameters),
        },
        elseBranch: statement.elseBranch
          ? transformStatement(statement.elseBranch, scope, new Set(locals), typeParameters) as typeof statement.elseBranch
          : null,
      };
    case "while":
      return {
        ...statement,
        condition: transformExpression(statement.condition, scope, locals, typeParameters),
        body: { ...statement.body, statements: transformStatements(statement.body.statements, scope, new Set(locals), typeParameters) },
      };
    case "for": {
      const bodyLocals = new Set(locals);
      bodyLocals.add(statement.binding);
      return {
        ...statement,
        iterable: transformExpression(statement.iterable, scope, locals, typeParameters),
        body: { ...statement.body, statements: transformStatements(statement.body.statements, scope, bodyLocals, typeParameters) },
      };
    }
    case "match":
      return {
        ...statement,
        expression: transformExpression(statement.expression, scope, locals, typeParameters),
        arms: statement.arms.map((arm) => {
          const armLocals = new Set(locals);
          if (arm.binding) armLocals.add(arm.binding);
          for (const field of arm.objectBindings ?? []) armLocals.add(field.bindingName);
          return { ...arm, body: transformStatement(arm.body, scope, armLocals, typeParameters) };
        }),
      };
    case "asyncScope":
      return {
        ...statement,
        body: {
          ...statement.body,
          statements: transformStatements(statement.body.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "break":
    case "continue":
      return statement;
  }
}

function transformExpression(
  expression: Expression,
  scope: ModuleScope,
  locals: ReadonlySet<string>,
  typeParameters: ReadonlySet<string>,
): Expression {
  switch (expression.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
      return expression;
    case "identifier": {
      if (locals.has(expression.name)) return expression;
      if (scope.namespaces.has(expression.name)) {
        throw new DiagnosticError(expression.location.fileName ?? "<module>", expression.location, `module ${JSON.stringify(expression.name)} must be followed by an exported member`, { code: "Z0602" });
      }
      return { ...expression, name: renameExpressionName(expression.name, scope, typeParameters) };
    }
    case "unary":
      return { ...expression, operand: transformExpression(expression.operand, scope, locals, typeParameters) };
    case "binary":
      return {
        ...expression,
        left: transformExpression(expression.left, scope, locals, typeParameters),
        right: transformExpression(expression.right, scope, locals, typeParameters),
      };
    case "conditional":
      return {
        ...expression,
        condition: transformExpression(expression.condition, scope, locals, typeParameters),
        thenExpression: transformExpression(expression.thenExpression, scope, locals, typeParameters),
        elseExpression: transformExpression(expression.elseExpression, scope, locals, typeParameters),
      };
    case "new":
      return {
        ...expression,
        typeName: renameTypeName(expression.typeName, scope, typeParameters),
        arguments: expression.arguments.map((argument) => transformExpression(argument, scope, locals, typeParameters)),
      };
    case "template":
      return {
        ...expression,
        parts: expression.parts.map((part) => part.kind === "value"
          ? { ...part, expression: transformExpression(part.expression, scope, locals, typeParameters) }
          : part),
      };
    case "closure": {
      const closureLocals = new Set(locals);
      for (const parameter of expression.parameters) closureLocals.add(parameter.name);
      return {
        ...expression,
        parameters: expression.parameters.map((parameter) => ({
          ...parameter,
          type: parameter.type ? renameTypeReference(parameter.type, scope, typeParameters) : null,
        })),
        returnType: expression.returnType ? renameTypeReference(expression.returnType, scope, typeParameters) : null,
        body: expression.body.kind === "block"
          ? { ...expression.body, statements: transformStatements(expression.body.statements, scope, closureLocals, typeParameters) }
          : transformExpression(expression.body, scope, closureLocals, typeParameters),
      };
    }
    case "call":
      return {
        ...expression,
        callee: transformExpression(expression.callee, scope, locals, typeParameters),
        arguments: expression.arguments.map((argument) => transformExpression(argument, scope, locals, typeParameters)),
      };
    case "member": {
      if (expression.object.kind === "identifier" && !locals.has(expression.object.name)) {
        const dependency = scope.namespaces.get(expression.object.name);
        if (dependency) {
          const generic = parseGenericType(expression.property);
          const exported = dependency.exports.get(generic?.base ?? expression.property);
          if (!exported) {
            throw new DiagnosticError(expression.location.fileName ?? dependency.fileName, expression.location, `module ${JSON.stringify(expression.object.name)} has no export ${JSON.stringify(generic?.base ?? expression.property)}`, {
              code: "Z0602",
              helps: ["export the declaration or import an existing exported name"],
            });
          }
          return {
            kind: "identifier",
            name: generic
              ? genericTypeName(exported.linkedName, generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)))
              : exported.linkedName,
            location: expression.location,
          };
        }
      }
      return { ...expression, object: transformExpression(expression.object, scope, locals, typeParameters) };
    }
    case "index":
      return {
        ...expression,
        object: transformExpression(expression.object, scope, locals, typeParameters),
        index: transformExpression(expression.index, scope, locals, typeParameters),
      };
    case "arrayExpression":
      return { ...expression, elements: expression.elements.map((item) => transformExpression(item, scope, locals, typeParameters)) };
    case "dynamicArrayExpression":
      return { ...expression, elementType: renameTypeName(expression.elementType, scope, typeParameters) };
    case "structExpression":
      return {
        ...expression,
        typeName: renameTypeName(expression.typeName, scope, typeParameters),
        fields: expression.fields.map((field) => ({
          ...field,
          expression: transformExpression(field.expression, scope, locals, typeParameters),
        })),
      };
    case "objectExpression":
      return {
        ...expression,
        fields: expression.fields.map((field) => ({
          ...field,
          expression: transformExpression(field.expression, scope, locals, typeParameters),
        })),
      };
    case "variantExpression":
      return {
        ...expression,
        enumName: renameTypeName(expression.enumName, scope, typeParameters),
        payload: transformExpression(expression.payload, scope, locals, typeParameters),
      };
    case "attempt":
    case "try":
    case "await":
    case "spawn":
    case "weak":
      return { ...expression, expression: transformExpression(expression.expression, scope, locals, typeParameters) };
    case "executorPlacement":
      return {
        ...expression,
        executor: transformExpression(expression.executor, scope, locals, typeParameters),
        returnType: expression.returnType ? renameTypeReference(expression.returnType, scope, typeParameters) : null,
        errorType: expression.errorType ? renameTypeReference(expression.errorType, scope, typeParameters) : null,
        body: {
          ...expression.body,
          statements: transformStatements(expression.body.statements, scope, new Set(locals), typeParameters),
        },
      };
    case "matchExpression":
      return {
        ...expression,
        expression: transformExpression(expression.expression, scope, locals, typeParameters),
        arms: expression.arms.map((arm) => {
          const armLocals = new Set(locals);
          if (arm.binding) armLocals.add(arm.binding);
          for (const field of arm.objectBindings ?? []) armLocals.add(field.bindingName);
          return { ...arm, body: transformStatement(arm.body, scope, armLocals, typeParameters) };
        }),
      };
    case "ifExpression":
      return {
        ...expression,
        condition: transformExpression(expression.condition, scope, locals, typeParameters),
        thenBranch: {
          ...expression.thenBranch,
          statements: transformStatements(expression.thenBranch.statements, scope, new Set(locals), typeParameters),
        },
        elseBranch: expression.elseBranch.kind === "ifExpression"
          ? transformExpression(expression.elseBranch, scope, locals, typeParameters) as typeof expression.elseBranch
          : { ...expression.elseBranch, statements: transformStatements(expression.elseBranch.statements, scope, new Set(locals), typeParameters) },
      };
    case "argumentReference":
      return locals.has(expression.name)
        ? expression
        : { ...expression, name: scope.globals.get(expression.name) ?? expression.name };
  }
}

function renameTypeReference(reference: TypeReference, scope: ModuleScope, typeParameters: ReadonlySet<string>): TypeReference {
  return { ...reference, name: renameTypeName(reference.name, scope, typeParameters) };
}

function renameTypeName(name: string, scope: ModuleScope, typeParameters: ReadonlySet<string>): string {
  const view = parseViewType(name);
  if (view) return viewTypeName(renameTypeName(view.target, scope, typeParameters));
  if (isNullableObjCTypeName(name)) {
    return nullableObjCTypeName(renameTypeName(publicObjCTypeName(name), scope, typeParameters));
  }
  if (typeParameters.has(name)) return name;
  const functionType = parseFunctionType(name);
  if (functionType) {
    return functionTypeName(
      functionType.parameters.map((parameter) => ({
        ...parameter,
        type: renameTypeName(parameter.type, scope, typeParameters),
      })),
      renameTypeName(functionType.returnType, scope, typeParameters),
    );
  }
  const fixed = parseFixedArrayType(name);
  if (fixed) return fixedArrayTypeName(renameTypeName(fixed.elementType, scope, typeParameters), fixed.length);
  const slice = parseSliceType(name);
  if (slice) return sliceTypeName(renameTypeName(slice.elementType, scope, typeParameters));
  const dynamic = parseDynamicArrayType(name);
  if (dynamic) return dynamicArrayTypeName(renameTypeName(dynamic.elementType, scope, typeParameters));
  const generic = parseGenericType(name);
  if (generic) {
    const base = renameSimpleType(generic.base, scope);
    return genericTypeName(base, generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)));
  }
  return renameSimpleType(name, scope);
}

function renameSimpleType(name: string, scope: ModuleScope): string {
  const separator = name.indexOf(".");
  if (separator >= 0) {
    const namespace = name.slice(0, separator);
    const member = name.slice(separator + 1);
    const dependency = scope.namespaces.get(namespace);
    if (dependency) {
      const exported = dependency.exports.get(member);
      if (!exported) throw new DiagnosticError(dependency.fileName, { offset: 0, line: 1, column: 1, fileName: dependency.fileName }, `module ${JSON.stringify(namespace)} has no export ${JSON.stringify(member)}`, { code: "Z0602" });
      return exported.linkedName;
    }
    const renamedNamespace = scope.globals.get(namespace);
    return renamedNamespace ? `${renamedNamespace}.${member}` : name;
  }
  return scope.globals.get(name) ?? name;
}

function renameExpressionName(name: string, scope: ModuleScope, typeParameters: ReadonlySet<string>): string {
  const generic = parseGenericType(name);
  if (!generic) return scope.globals.get(name) ?? name;
  return genericTypeName(
    scope.globals.get(generic.base) ?? generic.base,
    generic.arguments.map((argument) => renameTypeName(argument, scope, typeParameters)),
  );
}
