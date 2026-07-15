import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { resultTypeName } from "./results.ts";
import { pointerTypeName, type ForeignConstant, type ForeignFunction, type ForeignModule, type ForeignNamedType, type ForeignPointerType } from "./foreign.ts";

type ValueType = string | "unknown" | "never";

export type SemanticInfo = {
  readonly movedExpressions: ReadonlySet<number>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: ReadonlyMap<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: ReadonlyMap<number, string>;
  readonly integerLiteralTypes: ReadonlyMap<number, string>;
  readonly foreignArgumentAccesses: ReadonlyMap<number, "in" | "out" | "inout">;
  readonly foreignFunctionNames: ReadonlyMap<number, string>;
};

type AnalysisState = {
  readonly movedExpressions: Set<number>;
  readonly foreignTypes: ReadonlyMap<string, ForeignPointerType>;
  readonly foreignCallTypes: Map<number, string>;
  readonly foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>;
  readonly foreignExpressionTypes: Map<number, string>;
  readonly integerLiteralTypes: Map<number, string>;
  readonly foreignArgumentAccesses: Map<number, "in" | "out" | "inout">;
  readonly foreignFunctionNames: Map<number, string>;
};

type SymbolValue =
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignFunction"; readonly declaration: ForeignFunction }
  | { readonly kind: "foreignModule"; readonly module: ForeignModule }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "enum"; readonly declaration: EnumDeclaration };

const integerTypes = new Set(["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "isize", "usize"]);
const primitiveTypes = new Set([...integerTypes, "void", "bool", "cstring"]);
const movedPrefix = "__z_moved:";
const maybeMovedPrefix = "__z_maybe_moved:";
const mutablePrefix = "__z_mutable:";

export function analyze(
  program: Program,
  fileName: string,
  foreignModules: ReadonlyMap<string, ForeignModule>,
): SemanticInfo {
  const foreignTypes = new Map<string, ForeignPointerType>();
  const foreignNamedTypes = new Map<string, ForeignNamedType>();
  for (const module of foreignModules.values()) {
    for (const [name, type] of module.types) foreignTypes.set(name, type);
    for (const type of module.namedTypes.values()) foreignNamedTypes.set(type.typeName, type);
  }
  const state: AnalysisState = {
    movedExpressions: new Set(),
    foreignTypes,
    foreignCallTypes: new Map(),
    foreignNamedTypes,
    foreignExpressionTypes: new Map(),
    integerLiteralTypes: new Map(),
    foreignArgumentAccesses: new Map(),
    foreignFunctionNames: new Map(),
  };
  const globals = new Map<string, SymbolValue>();
  const structs = new Map<string, StructDeclaration>();
  const enums = new Map<string, EnumDeclaration>();

  for (const declaration of program.imports) {
    const module = foreignModules.get(declaration.moduleName);
    if (!module) throw new DiagnosticError(fileName, declaration.location, `header ${JSON.stringify(declaration.header)} was not resolved`);
    if (!declaration.bindings) {
      declareGlobal(globals, declaration.moduleName, { kind: "foreignModule", module }, declaration.location, fileName);
      continue;
    }
    for (const binding of declaration.bindings) {
      validateUserName(binding.localName, binding.location, fileName);
      const foreignFunction = module.functions.get(binding.importedName);
      if (!foreignFunction) {
        const unsupportedKind = module.namedTypes.has(binding.importedName)
          ? "type"
          : module.constants.has(binding.importedName)
            ? "constant"
            : null;
        const message = unsupportedKind
          ? `selective ${unsupportedKind} imports are not implemented yet; import the header as a namespace`
          : `header ${JSON.stringify(declaration.header)} has no function ${JSON.stringify(binding.importedName)}`;
        throw new DiagnosticError(fileName, binding.location, message);
      }
      declareGlobal(
        globals,
        binding.localName,
        { kind: "foreignFunction", declaration: foreignFunction },
        binding.location,
        fileName,
      );
    }
  }

  for (const declaration of program.structs) {
    declareGlobal(globals, declaration.name, { kind: "struct", declaration }, declaration.location, fileName);
    structs.set(declaration.name, declaration);
  }
  for (const declaration of program.enums) {
    declareGlobal(globals, declaration.name, { kind: "enum", declaration }, declaration.location, fileName);
    enums.set(declaration.name, declaration);
  }

  for (const declaration of program.functions) {
    declareGlobal(globals, declaration.name, { kind: "function", declaration }, declaration.location, fileName);
  }

  for (const declaration of program.structs) {
    analyzeStructDeclaration(declaration, structs, enums, foreignNamedTypes, fileName);
  }
  for (const declaration of program.enums) {
    analyzeEnumDeclaration(declaration, structs, enums, foreignNamedTypes, fileName);
  }

  for (const declaration of program.functions) {
    validateFunctionSignature(declaration, structs, enums, foreignNamedTypes, fileName);
  }

  validateStructLayouts(program.structs, structs, fileName);

  const main = globals.get("main");
  if (!main || main.kind !== "function") {
    throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "program must declare `function main(): i32`");
  }
  if (main.declaration.parameters.length !== 0 || main.declaration.returnType.name !== "i32") {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` must have signature `function main(): i32`");
  }
  if (main.declaration.errorType) {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` cannot throw in the bootstrap runtime");
  }

  for (const declaration of program.structs) {
    for (const method of declaration.methods) {
      analyzeFunction(method, globals, structs, enums, fileName, declaration, state);
    }
    if (declaration.deinitializer) {
      validateDeinitControlFlow(declaration.deinitializer.body, fileName);
      analyzeFunction(
        {
          kind: "function",
          name: "deinit",
          parameters: [],
          returnType: { name: "void", location: declaration.deinitializer.location },
          errorType: null,
          body: declaration.deinitializer.body,
          location: declaration.deinitializer.location,
        },
        globals,
        structs,
        enums,
        fileName,
        declaration,
        state,
      );
    }
  }
  for (const declaration of program.functions) {
    analyzeFunction(declaration, globals, structs, enums, fileName, null, state);
  }
  return state;
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  const members = new Set<string>();
  for (const field of declaration.fields) {
    validateUserName(field.name, field.location, fileName);
    if (members.has(field.name)) {
      throw new DiagnosticError(fileName, field.location, `duplicate member ${JSON.stringify(field.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(field.name);
    validateType(field.type, structs, enums, foreignNamedTypes, fileName, false);
    if (enums.has(field.type.name)) {
      throw new DiagnosticError(fileName, field.location, "enum-valued struct fields are not implemented in this bootstrap stage");
    }
  }
  for (const method of declaration.methods) {
    validateUserName(method.name, method.location, fileName);
    if (members.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate member ${JSON.stringify(method.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(method.name);
    validateFunctionSignature(method, structs, enums, foreignNamedTypes, fileName);
  }
}

function analyzeEnumDeclaration(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  const names = new Set<string>();
  for (const variant of declaration.variants) {
    validateUserName(variant.name, variant.location, fileName);
    if (names.has(variant.name)) {
      throw new DiagnosticError(fileName, variant.location, `duplicate variant ${JSON.stringify(variant.name)}`);
    }
    names.add(variant.name);
    if (variant.payload) {
      validateType(variant.payload, structs, enums, foreignNamedTypes, fileName, false);
      if (variant.payload.name === declaration.name) {
        throw new DiagnosticError(fileName, variant.location, "an enum cannot contain itself directly by value");
      }
      if (enums.has(variant.payload.name) && !declaration.name.startsWith("__z_Result_")) {
        throw new DiagnosticError(fileName, variant.location, "nested enum payloads are not implemented in this bootstrap stage");
      }
      if (hasCleanupType(variant.payload.name, structs)) {
        throw new DiagnosticError(fileName, variant.location, "enum payloads with deterministic cleanup are not implemented in this bootstrap stage");
      }
    }
  }
  if (declaration.variants.length === 0) {
    throw new DiagnosticError(fileName, declaration.location, "an enum must declare at least one variant");
  }
}

function validateFunctionSignature(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
): void {
  validateType(declaration.returnType, structs, enums, foreignNamedTypes, fileName, true);
  if (declaration.errorType) validateType(declaration.errorType, structs, enums, foreignNamedTypes, fileName, false);
  if (declaration.errorType && hasCleanupType(declaration.errorType.name, structs)) {
    throw new DiagnosticError(fileName, declaration.errorType.location, "throwing cleanup-bearing error values is not implemented in this bootstrap stage");
  }
  if (declaration.errorType && declaration.returnType.name === "void") {
    throw new DiagnosticError(fileName, declaration.returnType.location, "void success results are not implemented in this bootstrap stage");
  }
  for (const parameter of declaration.parameters) {
    validateUserName(parameter.name, parameter.location, fileName);
    validateType(parameter.type, structs, enums, foreignNamedTypes, fileName, false);
  }
}

function validateStructLayouts(
  declarations: StructDeclaration[],
  structs: Map<string, StructDeclaration>,
  fileName: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (declaration: StructDeclaration): void => {
    if (visited.has(declaration.name)) return;
    if (visiting.has(declaration.name)) {
      throw new DiagnosticError(fileName, declaration.location, `struct ${JSON.stringify(declaration.name)} has a recursive value layout`);
    }
    visiting.add(declaration.name);
    for (const field of declaration.fields) {
      const nested = structs.get(field.type.name);
      if (nested) visit(nested);
    }
    visiting.delete(declaration.name);
    visited.add(declaration.name);
  };

  for (const declaration of declarations) visit(declaration);
}

function analyzeFunction(
  declaration: FunctionDeclaration,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  receiver: StructDeclaration | null,
  state: AnalysisState,
): void {
  const locals = new Map<string, ValueType>();
  if (receiver) locals.set("this", receiver.name);

  for (const parameter of declaration.parameters) {
    if (locals.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate parameter ${JSON.stringify(parameter.name)}`);
    }
    locals.set(parameter.name, parameter.type.name);
  }

  const returns = analyzeStatements(declaration.body, declaration, locals, globals, structs, enums, fileName, state);
  if (declaration.returnType.name !== "void" && !returns) {
    throw new DiagnosticError(fileName, declaration.location, `function ${JSON.stringify(declaration.name)} must end with a return value`);
  }
}

function analyzeStatements(
  statements: Statement[],
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): boolean {
  let returns = false;
  for (const statement of statements) {
    if (returns) throw new DiagnosticError(fileName, statement.location, "unreachable statement after guaranteed function exit");
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName, state);
    returns = statementReturns(statement);
  }
  return returns;
}

function statementReturns(statement: Statement | undefined): boolean {
  if (!statement) return false;
  if (statement.kind === "return" || statement.kind === "throw") return true;
  if (statement.kind === "block") return statementReturns(statement.statements.at(-1));
  if (statement.kind === "if") {
    return Boolean(statement.elseBranch)
      && statementReturns(statement.thenBranch)
      && statementReturns(statement.elseBranch!);
  }
  return statement.kind === "match" && statement.arms.length > 0
    && statement.arms.every((arm) => statementReturns(arm.body));
}

function analyzeStatement(
  statement: Statement,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  switch (statement.kind) {
    case "variable": {
      validateUserName(statement.name, statement.location, fileName);
      if (locals.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.location, `duplicate local ${JSON.stringify(statement.name)}`);
      }
      const initializerType = inferDirectValue(statement.initializer, owner, locals, globals, structs, enums, fileName, state);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, structs, enums, state.foreignNamedTypes, fileName, false);
        variableType = statement.type.name;
        requireAssignable(variableType, initializerType, statement.initializer, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      } else if (initializerType === "unknown") {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "cannot infer the result of an imported function until its header is typed; add a type annotation",
        );
      } else if (initializerType === "never") {
        throw new DiagnosticError(fileName, statement.initializer.location, "cannot bind a value from an expression that never produces one");
      } else if (!statement.type && statement.initializer.kind === "number" && !integerLiteralFits(statement.initializer.value, "i32")) {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          `integer literal ${statement.initializer.value} does not fit default i32; add an explicit integer type`,
        );
      }
      consumeOwnedValue(statement.initializer, variableType, locals, structs, fileName, state);
      locals.set(statement.name, statement.mutable ? `${mutablePrefix}${variableType}` : variableType);
      return;
    }
    case "assignment": {
      const root = assignmentRoot(statement.target);
      if (!root) {
        throw new DiagnosticError(fileName, statement.target.location, "assignment target must be a mutable binding or one of its fields");
      }
      const stored = locals.get(root.name);
      if (!stored) {
        inferExpression(statement.target, locals, globals, structs, enums, fileName, state);
        throw new DiagnosticError(fileName, statement.target.location, "assignment target must be local mutable storage");
      }
      if (!isMutableBinding(stored)) {
        const action = statement.target.kind === "identifier" ? "assign to" : "mutate a field through";
        throw new DiagnosticError(fileName, statement.target.location, `cannot ${action} immutable binding ${JSON.stringify(root.name)}`);
      }
      const expected = inferExpression(statement.target, locals, globals, structs, enums, fileName, state);
      if (hasCleanupType(expected, structs, state.foreignTypes)) {
        throw new DiagnosticError(
          fileName,
          statement.target.location,
          "replacing cleanup-bearing storage is not implemented yet; its previous value must be destroyed first",
        );
      }
      const actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      return;
    }
    case "return": {
      const expected = owner.returnType.name;
      if (!statement.expression) {
        if (expected !== "void") {
          throw new DiagnosticError(fileName, statement.location, `expected a ${expected} return value`);
        }
        return;
      }
      if (expected === "void") {
        throw new DiagnosticError(fileName, statement.location, "a void function cannot return a value");
      }
      const actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
      requireAssignable(expected, actual, statement.expression, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      consumeOwnedValue(statement.expression, expected, locals, structs, fileName, state);
      return;
    }
    case "throw": {
      if (!owner.errorType) {
        throw new DiagnosticError(fileName, statement.location, `function ${JSON.stringify(owner.name)} does not declare an error type`);
      }
      const actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
      requireAssignable(owner.errorType.name, actual, statement.expression, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      return;
    }
    case "yield":
      throw new DiagnosticError(fileName, statement.location, "yield requires an enclosing value-producing block");
    case "block": {
      const blockLocals = new Map(locals);
      analyzeStatements(statement.statements, owner, blockLocals, globals, structs, enums, fileName, state);
      propagateOuterOwnership(locals, blockLocals);
      return;
    }
    case "if": {
      const conditionType = inferExpression(statement.condition, locals, globals, structs, enums, fileName, state);
      if (conditionType !== "bool" && !foreignPointer(conditionType, state)?.nullable) {
        requireAssignable("bool", conditionType, statement.condition, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      }
      analyzeIfBranches(statement, owner, locals, globals, structs, enums, fileName, state);
      return;
    }
    case "expressionStatement":
      {
        if (statement.expression.kind === "number" && !integerLiteralFits(statement.expression.value, "i32")) {
          throw new DiagnosticError(fileName, statement.expression.location, `integer literal ${statement.expression.value} does not fit default i32`);
        }
        const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
        if (hasCleanupType(type, structs, state.foreignTypes)) {
          throw new DiagnosticError(fileName, statement.expression.location, "a cleanup-bearing value must be bound or transferred; it cannot be discarded");
        }
      }
      return;
    case "match": {
      const subjectType = inferExpression(statement.expression, locals, globals, structs, enums, fileName, state);
      const declaration = enums.get(subjectType);
      if (!declaration) {
        throw new DiagnosticError(fileName, statement.expression.location, `match requires an enum value, found ${subjectType}`);
      }
      const covered = new Set<string>();
      const continuing: Map<string, ValueType>[] = [];
      for (const arm of statement.arms) {
        const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
        if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
        if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
        covered.add(variant.name);
        if (Boolean(variant.payload) !== Boolean(arm.binding)) {
          throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
        }
        if (arm.binding) validateUserName(arm.binding, arm.location, fileName);
        const armLocals = new Map(locals);
        if (variant.payload && arm.binding) armLocals.set(arm.binding, variant.payload.name);
        analyzeStatement(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
        if (!statementReturns(arm.body)) continuing.push(armLocals);
      }
      const missing = declaration.variants.find((variant) => !covered.has(variant.name));
      if (missing) throw new DiagnosticError(fileName, statement.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
      mergeOwnershipStates(locals, continuing, state);
      return;
    }
  }
}

function inferDirectValue(
  expression: Expression,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (expression.kind === "try") {
    return inferTrySuccess(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  if (expression.kind === "matchExpression") {
    return inferMatchExpression(expression, owner, locals, globals, structs, enums, fileName, state);
  }
  return inferExpression(expression, locals, globals, structs, enums, fileName, state);
}

function inferMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  const subjectType = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state);
  const declaration = enums.get(subjectType);
  if (!declaration) {
    throw new DiagnosticError(fileName, expression.expression.location, `match requires an enum value, found ${subjectType}`);
  }

  const covered = new Set<string>();
  const continuing: Map<string, ValueType>[] = [];
  let resultType: ValueType = "never";
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
    if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
    if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
    covered.add(variant.name);
    if (Boolean(variant.payload) !== Boolean(arm.binding)) {
      throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
    }
    if (arm.binding) validateUserName(arm.binding, arm.location, fileName);
    const armLocals = new Map(locals);
    if (variant.payload && arm.binding) armLocals.set(arm.binding, variant.payload.name);
    const armType = inferValueArm(arm.body, owner, armLocals, globals, structs, enums, fileName, state);
    if (armType !== "never") {
      continuing.push(armLocals);
      if (resultType === "never" || resultType === "unknown") resultType = armType;
      else if (armType !== "unknown" && armType !== resultType) {
        throw new DiagnosticError(fileName, arm.location, `match arm produces ${armType}, but previous arms produce ${resultType}`);
      }
    }
  }
  const missing = declaration.variants.find((variant) => !covered.has(variant.name));
  if (missing) throw new DiagnosticError(fileName, expression.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
  mergeOwnershipStates(locals, continuing, state);
  return resultType;
}

function inferValueArm(
  statement: Statement,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (statement.kind === "expressionStatement" || statement.kind === "yield") {
    const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName, state);
    consumeOwnedValue(statement.expression, type, locals, structs, fileName, state);
    return type;
  }
  if (statement.kind === "return" || statement.kind === "throw") {
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName, state);
    return "never";
  }
  if (statement.kind === "block") {
    if (statement.statements.length === 0) {
      throw new DiagnosticError(fileName, statement.location, "a value-producing match arm cannot be empty");
    }
    const blockLocals = new Map(locals);
    const prefixReturns = analyzeStatements(
      statement.statements.slice(0, -1),
      owner,
      blockLocals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
    if (prefixReturns) {
      throw new DiagnosticError(fileName, statement.statements.at(-1)!.location, "unreachable statement after guaranteed function exit");
    }
    const type = inferValueArm(statement.statements.at(-1)!, owner, blockLocals, globals, structs, enums, fileName, state);
    propagateOuterOwnership(locals, blockLocals);
    return type;
  }
  if (statement.kind === "match") {
    return inferMatchExpression(
      { ...statement, kind: "matchExpression" },
      owner,
      locals,
      globals,
      structs,
      enums,
      fileName,
      state,
    );
  }
  throw new DiagnosticError(fileName, statement.location, "a value-producing match arm must produce a value with an expression or `yield`");
}

function inferTrySuccess(
  expression: Extract<Expression, { kind: "try" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): ValueType {
  if (!owner.errorType) {
    throw new DiagnosticError(fileName, expression.location, "try requires an enclosing throwing function");
  }
  const resultType = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, true);
  const result = enums.get(resultType);
  if (!result || !result.name.startsWith("__z_Result_")) {
    throw new DiagnosticError(fileName, expression.location, "try requires a throwing function call");
  }
  const success = result.variants.find((variant) => variant.name === "success")!.payload!;
  const failure = result.variants.find((variant) => variant.name === "failure")!.payload!;
  if (failure.name !== owner.errorType.name) {
    throw new DiagnosticError(fileName, expression.location, `cannot propagate ${failure.name} from a function throwing ${owner.errorType.name}`);
  }
  return success.name;
}

function inferExpression(
  expression: Expression,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
  allowThrowingCall = false,
): ValueType {
  switch (expression.kind) {
    case "number":
      return "i32";
    case "string":
      return "cstring";
    case "boolean":
      return "bool";
    case "argumentReference":
      throw new DiagnosticError(
        fileName,
        expression.location,
        `${expression.access} is only valid for a classified imported C record-pointer parameter`,
      );
    case "unary": {
      const operand = inferExpression(expression.operand, locals, globals, structs, enums, fileName, state);
      if (expression.operator === "!" && canonicalType(operand, state.foreignNamedTypes) === "bool") return "bool";
      if (expression.operator === "!" && foreignPointer(operand, state)?.nullable) return "bool";
      throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires a bool operand`);
    }
    case "identifier": {
      const local = locals.get(expression.name);
      if (local) {
        const ownership = ownershipState(local);
        if (ownership === "moved") {
          throw new DiagnosticError(fileName, expression.location, `use of moved value ${JSON.stringify(expression.name)}`);
        }
        if (ownership === "maybeMoved") {
          throw new DiagnosticError(fileName, expression.location, `value ${JSON.stringify(expression.name)} may have been moved on another control-flow path`);
        }
        return underlyingType(local);
      }
      const global = globals.get(expression.name);
      if (global?.kind === "function") {
        throw new DiagnosticError(fileName, expression.location, "function values are not implemented; call the function instead");
      }
      if (global?.kind === "foreignFunction") {
        throw new DiagnosticError(fileName, expression.location, "foreign function values are not implemented; call the function instead");
      }
      if (global?.kind === "foreignModule") {
        throw new DiagnosticError(fileName, expression.location, "an imported module must be followed by a member name");
      }
      if (global?.kind === "struct") {
        throw new DiagnosticError(fileName, expression.location, "a struct type must be followed by a field initializer");
      }
      if (global?.kind === "enum") {
        throw new DiagnosticError(fileName, expression.location, "an enum type must be followed by a variant name");
      }
      throw new DiagnosticError(fileName, expression.location, `unknown name ${JSON.stringify(expression.name)}`);
    }
    case "binary": {
      const left = inferExpression(expression.left, locals, globals, structs, enums, fileName, state);
      const right = inferExpression(expression.right, locals, globals, structs, enums, fileName, state);
      let canonicalLeft = canonicalType(left, state.foreignNamedTypes);
      let canonicalRight = canonicalType(right, state.foreignNamedTypes);
      if (expression.right.kind === "number" && isIntegerType(canonicalLeft)) {
        if (!integerLiteralFits(expression.right.value, canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.right.location, `integer literal ${expression.right.value} does not fit ${canonicalLeft}`);
        }
        state.integerLiteralTypes.set(expression.right.location.offset, canonicalLeft);
        canonicalRight = canonicalLeft;
      } else if (expression.left.kind === "number" && isIntegerType(canonicalRight)) {
        if (!integerLiteralFits(expression.left.value, canonicalRight)) {
          throw new DiagnosticError(fileName, expression.left.location, `integer literal ${expression.left.value} does not fit ${canonicalRight}`);
        }
        state.integerLiteralTypes.set(expression.left.location.offset, canonicalRight);
        canonicalLeft = canonicalRight;
      }
      if (["+", "-", "*", "/"].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isIntegerType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching integer operands`);
        }
        state.foreignExpressionTypes.set(expression.location.offset, canonicalLeft);
        return canonicalLeft;
      }
      if (["<", "<=", ">", ">="].includes(expression.operator)) {
        if (canonicalLeft !== canonicalRight || !isIntegerType(canonicalLeft)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching integer operands`);
        }
        return "bool";
      }
      if (["==", "!="].includes(expression.operator)) {
        const comparableNamed = left === right && state.foreignNamedTypes.get(String(left))?.kind === "enum";
        if (canonicalLeft !== canonicalRight || (!isIntegerType(canonicalLeft) && canonicalLeft !== "bool" && !comparableNamed)) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching integer, bool, or enum operands`);
        }
        return "bool";
      }
      if (["&&", "||"].includes(expression.operator)) {
        if (canonicalType(left, state.foreignNamedTypes) !== "bool" || canonicalType(right, state.foreignNamedTypes) !== "bool") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires bool operands`);
        }
        return "bool";
      }
      throw new DiagnosticError(fileName, expression.location, `unsupported binary operator ${JSON.stringify(expression.operator)}`);
    }
    case "structExpression": {
      const declaration = structs.get(expression.typeName);
      const foreignDeclaration = state.foreignNamedTypes.get(expression.typeName);
      if (!declaration && foreignDeclaration?.kind !== "record") {
        throw new DiagnosticError(fileName, expression.location, `unknown struct ${JSON.stringify(expression.typeName)}`);
      }
      const provided = new Set<string>();
      for (const initializer of expression.fields) {
        if (provided.has(initializer.name)) {
          throw new DiagnosticError(fileName, initializer.location, `duplicate field initializer ${JSON.stringify(initializer.name)}`);
        }
        provided.add(initializer.name);
        const field = declaration?.fields.find((candidate) => candidate.name === initializer.name)
          ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields.find((candidate) => candidate.name === initializer.name) : null);
        if (!field) {
          throw new DiagnosticError(fileName, initializer.location, `struct ${JSON.stringify(expression.typeName)} has no field ${JSON.stringify(initializer.name)}`);
        }
        const actual = inferExpression(initializer.expression, locals, globals, structs, enums, fileName, state);
        const fieldType = "type" in field ? field.type.name : field.typeName;
        requireAssignable(fieldType, actual, initializer.expression, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
        consumeOwnedValue(initializer.expression, fieldType, locals, structs, fileName, state);
      }
      const expectedFields = declaration?.fields ?? (foreignDeclaration?.kind === "record" ? foreignDeclaration.fields : []);
      const missing = expectedFields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(expression.typeName)}`);
      }
      if (foreignDeclaration?.kind === "record") state.foreignExpressionTypes.set(expression.location.offset, expression.typeName);
      return expression.typeName;
    }
    case "variantExpression": {
      const declaration = enums.get(expression.enumName);
      const variant = declaration?.variants.find((candidate) => candidate.name === expression.variantName);
      if (!declaration || !variant) {
        throw new DiagnosticError(fileName, expression.location, `unknown enum variant ${expression.enumName}.${expression.variantName}`);
      }
      if (!variant.payload) {
        throw new DiagnosticError(fileName, expression.location, "payloadless variant does not accept a value");
      }
      const actual = inferExpression(expression.payload, locals, globals, structs, enums, fileName, state);
      requireAssignable(variant.payload.name, actual, expression.payload, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
      return declaration.name;
    }
    case "attempt": {
      const result = inferExpression(expression.expression, locals, globals, structs, enums, fileName, state, true);
      if (!result.startsWith("__z_Result_")) {
        throw new DiagnosticError(fileName, expression.location, "attempt requires a throwing function call");
      }
      return result;
    }
    case "try":
      throw new DiagnosticError(fileName, expression.location, "try must be the direct value of a binding, return, or expression statement");
    case "matchExpression":
      throw new DiagnosticError(fileName, expression.location, "match must be the direct value of a binding, return, or expression statement");
    case "member": {
      const foreignConstant = getForeignConstant(expression, globals);
      if (foreignConstant) {
        state.foreignExpressionTypes.set(expression.location.offset, foreignConstant.typeName);
        return foreignConstant.typeName;
      }
      const foreignFunction = getForeignFunction(expression, globals, fileName);
      if (foreignFunction) {
        throw new DiagnosticError(fileName, expression.location, "foreign function values are not implemented; call the function instead");
      }
      if (expression.object.kind === "identifier") {
        const enumDeclaration = enums.get(expression.object.name);
        if (enumDeclaration) {
          const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.property);
          if (!variant) throw new DiagnosticError(fileName, expression.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.property)}`);
          if (variant.payload) throw new DiagnosticError(fileName, expression.location, "payload variant must be called with a value");
          return enumDeclaration.name;
        }
      }
      const receiverType = inferExpression(expression.object, locals, globals, structs, enums, fileName, state);
      if (hasCleanupType(receiverType, structs, state.foreignTypes) && !isNamedStorageExpression(expression.object)) {
        throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing temporary must be bound before borrowing one of its members");
      }
      const declaration = structs.get(receiverType);
      const foreignRecord = state.foreignNamedTypes.get(String(receiverType));
      if (foreignRecord?.kind === "record") {
        const field = foreignRecord.fields.find((candidate) => candidate.name === expression.property);
        if (field) {
          state.foreignExpressionTypes.set(expression.location.offset, field.typeName);
          return field.typeName;
        }
        throw new DiagnosticError(fileName, expression.location, `record ${JSON.stringify(foreignRecord.typeName)} has no field ${JSON.stringify(expression.property)}`);
      }
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `type ${JSON.stringify(receiverType)} has no members`);
      }
      const field = declaration.fields.find((candidate) => candidate.name === expression.property);
      if (field) return field.type.name;
      const method = declaration.methods.find((candidate) => candidate.name === expression.property);
      if (method) {
        throw new DiagnosticError(fileName, expression.location, "method values are not implemented; call the method instead");
      }
      throw new DiagnosticError(fileName, expression.location, `struct ${JSON.stringify(declaration.name)} has no member ${JSON.stringify(expression.property)}`);
    }
    case "call": {
      if (expression.callee.kind === "member") {
        if (expression.callee.object.kind === "identifier") {
          const enumDeclaration = enums.get(expression.callee.object.name);
          if (enumDeclaration) {
            const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.callee.property);
            if (!variant) throw new DiagnosticError(fileName, expression.callee.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.callee.property)}`);
            const expectedCount = variant.payload ? 1 : 0;
            if (expression.arguments.length !== expectedCount) throw new DiagnosticError(fileName, expression.location, `variant ${JSON.stringify(variant.name)} expects ${expectedCount} argument(s)`);
            if (variant.payload) {
              const actual = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName, state);
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName, state.foreignNamedTypes, state.integerLiteralTypes);
            }
            return enumDeclaration.name;
          }
        }
        if (isForeignMember(expression.callee, globals)) {
          const foreignFunction = getForeignFunction(expression.callee, globals, fileName)!;
          return checkForeignCall(foreignFunction, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
        }
        const receiverType = inferExpression(expression.callee.object, locals, globals, structs, enums, fileName, state);
        if (hasCleanupType(receiverType, structs, state.foreignTypes) && !isNamedStorageExpression(expression.callee.object)) {
          throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before calling one of its methods");
        }
        const declaration = structs.get(receiverType);
        const method = declaration?.methods.find((candidate) => candidate.name === expression.callee.property);
        if (!declaration || !method) {
          throw new DiagnosticError(fileName, expression.callee.location, `type ${JSON.stringify(receiverType)} has no method ${JSON.stringify(expression.callee.property)}`);
        }
        checkArguments(method, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
        if (method.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(method.returnType.name, method.errorType.name);
        }
        return method.returnType.name;
      }
      if (expression.callee.kind !== "identifier") {
        throw new DiagnosticError(fileName, expression.callee.location, "this expression is not callable");
      }
      if (locals.has(expression.callee.name)) {
        throw new DiagnosticError(fileName, expression.callee.location, `${JSON.stringify(expression.callee.name)} is not callable`);
      }
      const target = globals.get(expression.callee.name);
      if (target?.kind === "foreignFunction") {
        state.foreignFunctionNames.set(expression.callee.location.offset, target.declaration.name);
        return checkForeignCall(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      }
      if (target?.kind !== "function") {
        throw new DiagnosticError(fileName, expression.callee.location, `unknown function ${JSON.stringify(expression.callee.name)}`);
      }
      checkArguments(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location, state);
      if (target.declaration.errorType) {
        if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
        return resultTypeName(target.declaration.returnType.name, target.declaration.errorType.name);
      }
      return target.declaration.returnType.name;
    }
  }
}

function checkArguments(
  target: FunctionDeclaration,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  state: AnalysisState,
): void {
  if (target.parameters.length !== args.length) {
    throw new DiagnosticError(
      fileName,
      location,
      `${JSON.stringify(target.name)} expects ${target.parameters.length} argument(s), received ${args.length}`,
    );
  }
  for (let index = 0; index < target.parameters.length; index += 1) {
    const actual = inferExpression(args[index], locals, globals, structs, enums, fileName, state);
    requireAssignable(target.parameters[index].type.name, actual, args[index], fileName, state.foreignNamedTypes, state.integerLiteralTypes);
    consumeOwnedValue(args[index], target.parameters[index].type.name, locals, structs, fileName, state);
  }
}

function validateDeinitControlFlow(statements: Statement[], fileName: string): void {
  for (const statement of statements) {
    if (statement.kind === "return" || statement.kind === "throw" || statement.kind === "yield") {
      throw new DiagnosticError(fileName, statement.location, `deinit cannot contain ${JSON.stringify(statement.kind)}`);
    }
    if (statement.kind === "block") validateDeinitControlFlow(statement.statements, fileName);
    if (statement.kind === "variable") validateDeinitExpression(statement.initializer, fileName);
    if (statement.kind === "assignment") {
      validateDeinitExpression(statement.target, fileName);
      validateDeinitExpression(statement.expression, fileName);
    }
    if (statement.kind === "expressionStatement") validateDeinitExpression(statement.expression, fileName);
    if (statement.kind === "if") {
      validateDeinitExpression(statement.condition, fileName);
      validateDeinitControlFlow(statement.thenBranch.statements, fileName);
      if (statement.elseBranch?.kind === "block") validateDeinitControlFlow(statement.elseBranch.statements, fileName);
      if (statement.elseBranch?.kind === "if") validateDeinitControlFlow([statement.elseBranch], fileName);
    }
    if (statement.kind === "match") {
      validateDeinitExpression(statement.expression, fileName);
      for (const arm of statement.arms) validateDeinitControlFlow([arm.body], fileName);
    }
  }
}

function validateDeinitExpression(expression: Expression, fileName: string): void {
  if (expression.kind === "unary") validateDeinitExpression(expression.operand, fileName);
  if (expression.kind === "binary") {
    validateDeinitExpression(expression.left, fileName);
    validateDeinitExpression(expression.right, fileName);
  }
  if (expression.kind === "call") {
    validateDeinitExpression(expression.callee, fileName);
    for (const argument of expression.arguments) validateDeinitExpression(argument, fileName);
  }
  if (expression.kind === "member") validateDeinitExpression(expression.object, fileName);
  if (expression.kind === "structExpression") {
    for (const field of expression.fields) validateDeinitExpression(field.expression, fileName);
  }
  if (expression.kind === "variantExpression") validateDeinitExpression(expression.payload, fileName);
  if (expression.kind === "attempt" || expression.kind === "try") {
    validateDeinitExpression(expression.expression, fileName);
  }
  if (expression.kind === "matchExpression") {
    validateDeinitExpression(expression.expression, fileName);
    for (const arm of expression.arms) validateDeinitControlFlow([arm.body], fileName);
  }
}

function consumeOwnedValue(
  expression: Expression,
  type: ValueType,
  locals: Map<string, ValueType>,
  structs: Map<string, StructDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, state.foreignTypes)) return;
  if (expression.kind === "member") {
    throw new DiagnosticError(fileName, expression.location, "moving a cleanup-bearing field out of its owner is not implemented yet");
  }
  if (expression.kind !== "identifier") return;
  if (expression.name === "this") {
    throw new DiagnosticError(fileName, expression.location, "cannot move the borrowed method receiver `this`");
  }
  const stored = locals.get(expression.name);
  if (!stored) return;
  locals.set(
    expression.name,
    `${movedPrefix}${isMutableBinding(stored) ? mutablePrefix : ""}${underlyingType(stored)}`,
  );
  state.movedExpressions.add(expression.location.offset);
}

function rejectForeignOwnedMove(
  expression: Expression,
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  if (!hasCleanupType(type, structs, state.foreignTypes)) return;
  throw new DiagnosticError(
    fileName,
    expression.location,
    "passing an owned Z value to an untyped foreign function requires imported ownership metadata",
  );
}

function isNamedStorageExpression(expression: Expression): boolean {
  if (expression.kind === "identifier") return true;
  return expression.kind === "member" && isNamedStorageExpression(expression.object);
}

function assignmentRoot(
  expression: Extract<Statement, { kind: "assignment" }>["target"],
): Extract<Expression, { kind: "identifier" }> | null {
  let current: Expression = expression;
  while (current.kind === "member") current = current.object;
  return current.kind === "identifier" ? current : null;
}

function ownershipState(type: ValueType): "available" | "moved" | "maybeMoved" {
  if (type.startsWith(movedPrefix)) return "moved";
  if (type.startsWith(maybeMovedPrefix)) return "maybeMoved";
  return "available";
}

function underlyingType(type: ValueType): ValueType {
  if (type.startsWith(movedPrefix)) return underlyingType(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return underlyingType(type.slice(maybeMovedPrefix.length));
  if (type.startsWith(mutablePrefix)) return underlyingType(type.slice(mutablePrefix.length));
  return type;
}

function isMutableBinding(type: ValueType): boolean {
  if (type.startsWith(movedPrefix)) return isMutableBinding(type.slice(movedPrefix.length));
  if (type.startsWith(maybeMovedPrefix)) return isMutableBinding(type.slice(maybeMovedPrefix.length));
  return type.startsWith(mutablePrefix);
}

function propagateOuterOwnership(target: Map<string, ValueType>, source: Map<string, ValueType>): void {
  for (const name of target.keys()) {
    const value = source.get(name);
    if (value) target.set(name, value);
  }
}

function mergeOwnershipStates(
  target: Map<string, ValueType>,
  paths: Map<string, ValueType>[],
  state: AnalysisState,
): void {
  if (paths.length === 0) return;
  for (const name of target.keys()) {
    const values = paths.map((path) => path.get(name)).filter((value): value is ValueType => Boolean(value));
    if (values.length === 0) continue;
    let type = underlyingType(values[0]);
    const mutable = values.every(isMutableBinding);
    const pointerTypes = values.map((value) => foreignPointer(value, state));
    const firstPointer = pointerTypes[0];
    if (firstPointer && pointerTypes.every((pointer) => pointer?.identity === firstPointer.identity && pointer.ownership === firstPointer.ownership)) {
      const nullable = pointerTypes.some((pointer) => pointer!.nullable);
      type = pointerTypeName(firstPointer.identity, firstPointer.ownership, nullable);
    }
    const states = new Set(values.map(ownershipState));
    const storedType = `${mutable ? mutablePrefix : ""}${type}`;
    if (states.size === 1 && states.has("available")) target.set(name, storedType);
    else if (states.size === 1 && states.has("moved")) target.set(name, `${movedPrefix}${storedType}`);
    else target.set(name, `${maybeMovedPrefix}${storedType}`);
  }
}

function narrowedConditionLocals(
  locals: Map<string, ValueType>,
  condition: Expression,
  truthy: boolean,
  state: AnalysisState,
): Map<string, ValueType> {
  const narrowed = new Map(locals);
  let name: string | null = null;
  let nonnull = truthy;
  if (condition.kind === "identifier") {
    name = condition.name;
  } else if (condition.kind === "unary" && condition.operator === "!" && condition.operand.kind === "identifier") {
    name = condition.operand.name;
    nonnull = !truthy;
  }
  if (!name || !nonnull) return narrowed;
  const current = narrowed.get(name);
  const pointer = current ? foreignPointer(current, state) : null;
  if (pointer?.nullable) {
    narrowed.set(name, pointerTypeName(pointer.identity, pointer.ownership, false));
  }
  return narrowed;
}

function foreignPointer(type: ValueType, state: AnalysisState): ForeignPointerType | null {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never") return null;
  return state.foreignTypes.get(actual) ?? null;
}

function analyzeIfBranches(
  statement: Extract<Statement, { kind: "if" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  state: AnalysisState,
): void {
  const original = new Map(locals);
  const continuing: Map<string, ValueType>[] = [];
  const thenLocals = narrowedConditionLocals(original, statement.condition, true, state);
  analyzeStatement(statement.thenBranch, owner, thenLocals, globals, structs, enums, fileName, state);
  if (!statementReturns(statement.thenBranch)) continuing.push(thenLocals);

  if (statement.elseBranch) {
    const elseLocals = narrowedConditionLocals(original, statement.condition, false, state);
    analyzeStatement(statement.elseBranch, owner, elseLocals, globals, structs, enums, fileName, state);
    if (!statementReturns(statement.elseBranch)) continuing.push(elseLocals);
  } else {
    continuing.push(narrowedConditionLocals(original, statement.condition, false, state));
  }
  mergeOwnershipStates(locals, continuing, state);
}

function hasCleanupType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  foreignTypes: ReadonlyMap<string, ForeignPointerType> = new Map(),
  visiting = new Set<string>(),
): boolean {
  const actual = underlyingType(type);
  if (actual === "unknown" || actual === "never" || visiting.has(actual)) return false;
  if (foreignTypes.get(actual)?.ownership === "owned") return true;
  const declaration = structs.get(actual);
  if (!declaration) return false;
  if (declaration.deinitializer) return true;
  visiting.add(actual);
  const result = declaration.fields.some((field) => hasCleanupType(field.type.name, structs, foreignTypes, visiting));
  visiting.delete(actual);
  return result;
}

function isForeignMember(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): boolean {
  return expression.object.kind === "identifier"
    && globals.get(expression.object.name)?.kind === "foreignModule";
}

function getForeignFunction(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
  fileName: string,
): ForeignFunction | null {
  if (expression.object.kind !== "identifier") return null;
  const symbol = globals.get(expression.object.name);
  if (symbol?.kind !== "foreignModule") return null;
  const foreignFunction = symbol.module.functions.get(expression.property);
  if (!foreignFunction) {
    throw new DiagnosticError(
      fileName,
      expression.location,
      `header ${JSON.stringify(symbol.module.declaration.header)} has no function ${JSON.stringify(expression.property)}`,
    );
  }
  return foreignFunction;
}

function getForeignConstant(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): ForeignConstant | null {
  if (expression.object.kind !== "identifier") return null;
  const symbol = globals.get(expression.object.name);
  if (symbol?.kind !== "foreignModule") return null;
  return symbol.module.constants.get(expression.property) ?? null;
}

function checkForeignCall(
  target: ForeignFunction,
  args: Expression[],
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  location: SourceLocation,
  state: AnalysisState,
): ValueType {
  const unsupported = [target.returnType, ...target.parameters.map((parameter) => parameter.type)]
    .find((type) => type.kind === "unsupported");
  if (unsupported?.kind === "unsupported") {
    throw new DiagnosticError(
      fileName,
      location,
      `C function ${JSON.stringify(target.name)} uses unsupported type ${JSON.stringify(unsupported.cName)} in signature ${JSON.stringify(target.cSignature)}`,
    );
  }
  const expected = target.parameters.length;
  if ((!target.variadic && args.length !== expected) || (target.variadic && args.length < expected)) {
    const expectation = target.variadic ? `at least ${expected}` : String(expected);
    throw new DiagnosticError(fileName, location, `C function ${JSON.stringify(target.name)} expects ${expectation} argument(s), found ${args.length}`);
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const parameter = target.parameters[index];
    if (argument.kind === "argumentReference") {
      if (parameter?.type.kind !== "recordPointer") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `${argument.access} is only valid for a classified imported C record-pointer parameter`,
        );
      }
      if (parameter.type.access !== argument.access) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects ${parameter.type.access} ${argument.name}, found ${argument.access} ${argument.name}`,
        );
      }
      const stored = locals.get(argument.name);
      if (!stored) {
        throw new DiagnosticError(fileName, argument.location, `unknown name ${JSON.stringify(argument.name)}`);
      }
      if (ownershipState(stored) === "moved") {
        throw new DiagnosticError(fileName, argument.location, `use of moved value ${JSON.stringify(argument.name)}`);
      }
      if (ownershipState(stored) === "maybeMoved") {
        throw new DiagnosticError(fileName, argument.location, `value ${JSON.stringify(argument.name)} may have been moved on another control-flow path`);
      }
      if (!isMutableBinding(stored)) {
        throw new DiagnosticError(fileName, argument.location, `${argument.access} argument ${JSON.stringify(argument.name)} requires a mutable let binding`);
      }
      requireAssignable(
        parameter.type.record.typeName,
        underlyingType(stored),
        argument,
        fileName,
        state.foreignNamedTypes,
        state.integerLiteralTypes,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, argument.access);
      continue;
    }
    if (parameter?.type.kind === "recordPointer") {
      if (parameter.type.access !== "in") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} requires ${parameter.type.access} <mutable binding> for parameter ${index + 1}`,
        );
      }
      if (!isNamedStorageExpression(argument) && argument.kind !== "structExpression") {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `in record argument to C function ${JSON.stringify(target.name)} must be a stored value or struct literal`,
        );
      }
      const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
      requireAssignable(
        parameter.type.record.typeName,
        actual,
        argument,
        fileName,
        state.foreignNamedTypes,
        state.integerLiteralTypes,
      );
      state.foreignArgumentAccesses.set(argument.location.offset, "in");
      continue;
    }
    const actual = inferExpression(argument, locals, globals, structs, enums, fileName, state);
    if (parameter?.type.kind === "z") {
      rejectForeignOwnedMove(argument, actual, structs, fileName, state);
      requireAssignable(parameter.type.name, actual, argument, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
    }
    if (parameter?.type.kind === "named") {
      requireAssignable(parameter.type.type.typeName, actual, argument, fileName, state.foreignNamedTypes, state.integerLiteralTypes);
    }
    if (parameter?.type.kind === "pointer") {
      const actualPointer = foreignPointer(actual, state);
      if (!actualPointer || actualPointer.identity !== parameter.type.identity) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `C function ${JSON.stringify(target.name)} expects ${describePointer(parameter.type)}, found ${describeValueType(actual, state)}`,
        );
      }
      if (!parameter.type.nullable && actualPointer.nullable) {
        throw new DiagnosticError(
          fileName,
          argument.location,
          `nullable ${actualPointer.cName} must be checked before passing it to ${JSON.stringify(target.name)}`,
        );
      }
      if (parameter.type.ownership === "consuming") {
        if (actualPointer.ownership !== "owned") {
          throw new DiagnosticError(fileName, argument.location, `C function ${JSON.stringify(target.name)} can only consume an owned ${actualPointer.cName}`);
        }
        consumeOwnedValue(argument, actual, locals, structs, fileName, state);
      }
    }
    if (!parameter && !isIntegerType(canonicalType(actual, state.foreignNamedTypes)) && actual !== "bool" && actual !== "cstring") {
      throw new DiagnosticError(fileName, argument.location, `unsupported variadic argument type ${describeValueType(actual, state)} for C function ${JSON.stringify(target.name)}`);
    }
    if (!parameter && argument.kind === "number" && !integerLiteralFits(argument.value, "i32")) {
      throw new DiagnosticError(fileName, argument.location, `variadic integer literal ${argument.value} does not fit default i32; bind it to an explicit integer type first`);
    }
  }
  const result = target.returnType.kind === "z"
    ? target.returnType.name
    : target.returnType.kind === "named"
      ? target.returnType.type.typeName
    : target.returnType.kind === "pointer"
      ? target.returnType.typeName
      : "unknown";
  state.foreignCallTypes.set(location.offset, result);
  return result;
}

function describePointer(type: ForeignPointerType): string {
  const ownership = type.ownership === "consuming" ? "owned" : type.ownership;
  return `${ownership} ${type.nullable ? "nullable " : ""}${type.cName}`;
}

function describeValueType(type: ValueType, state: AnalysisState): string {
  const pointer = foreignPointer(type, state);
  return pointer ? describePointer(pointer) : String(underlyingType(type));
}

function validateType(
  type: TypeReference,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  fileName: string,
  allowVoid: boolean,
): void {
  if (!primitiveTypes.has(type.name) && !structs.has(type.name) && !enums.has(type.name) && !foreignNamedTypes.has(type.name)) {
    throw new DiagnosticError(fileName, type.location, `unknown type ${JSON.stringify(type.name)}`);
  }
  if (!allowVoid && type.name === "void") {
    throw new DiagnosticError(fileName, type.location, "void is not a value type");
  }
}

function requireAssignable(
  expected: ValueType,
  actual: ValueType,
  expression: Expression,
  fileName: string,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
  integerLiteralTypes: Map<number, string>,
): void {
  const expectedType = canonicalType(expected, foreignNamedTypes);
  if (expression.kind === "number" && isIntegerType(expectedType)) {
    if (!integerLiteralFits(expression.value, expectedType)) {
      throw new DiagnosticError(fileName, expression.location, `integer literal ${expression.value} does not fit ${expectedType}`);
    }
    integerLiteralTypes.set(expression.location.offset, expectedType);
    return;
  }
  if (
    actual !== "unknown"
    && actual !== "never"
    && expectedType !== canonicalType(actual, foreignNamedTypes)
    && !sameForeignNamedType(expected, actual, foreignNamedTypes)
  ) {
    throw new DiagnosticError(fileName, expression.location, `expected ${expected}, found ${actual}`);
  }
}

function sameForeignNamedType(
  expected: ValueType,
  actual: ValueType,
  foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>,
): boolean {
  if (expected === "unknown" || expected === "never" || actual === "unknown" || actual === "never") return false;
  const expectedNamed = foreignNamedTypes.get(String(underlyingType(expected)));
  const actualNamed = foreignNamedTypes.get(String(underlyingType(actual)));
  return Boolean(
    expectedNamed
    && actualNamed
    && expectedNamed.kind === actualNamed.kind
    && expectedNamed.cName === actualNamed.cName,
  );
}

function isIntegerType(type: ValueType): type is string {
  return type !== "unknown" && type !== "never" && integerTypes.has(type);
}

function integerLiteralFits(value: string, type: string): boolean {
  const bits: Readonly<Record<string, number>> = {
    i8: 8,
    u8: 8,
    i16: 16,
    u16: 16,
    i32: 32,
    u32: 32,
    i64: 64,
    u64: 64,
    isize: process.arch.includes("64") ? 64 : 32,
    usize: process.arch.includes("64") ? 64 : 32,
  };
  const width = bits[type];
  if (!width) return false;
  const literal = BigInt(value);
  const unsigned = type.startsWith("u");
  const maximum = unsigned ? (1n << BigInt(width)) - 1n : (1n << BigInt(width - 1)) - 1n;
  return literal <= maximum;
}

function canonicalType(type: ValueType, foreignNamedTypes: ReadonlyMap<string, ForeignNamedType>): ValueType {
  if (type === "unknown" || type === "never") return type;
  const named = foreignNamedTypes.get(String(underlyingType(type)));
  return named?.kind === "scalar" ? named.underlying : type;
}

function declareGlobal(
  globals: Map<string, SymbolValue>,
  name: string,
  symbol: SymbolValue,
  location: SourceLocation,
  fileName: string,
): void {
  validateUserName(name, location, fileName);
  if (globals.has(name)) {
    throw new DiagnosticError(fileName, location, `duplicate top-level name ${JSON.stringify(name)}`);
  }
  globals.set(name, symbol);
}

function validateUserName(name: string, location: SourceLocation, fileName: string): void {
  if (name.startsWith("_z_")) {
    throw new DiagnosticError(fileName, location, "names beginning with `_z_` are reserved for compiler-generated storage");
  }
}
