import type {
  Expression,
  EnumDeclaration,
  FunctionDeclaration,
  ImportDeclaration,
  Program,
  SourceLocation,
  Statement,
  StructDeclaration,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";
import { resultTypeName } from "./results.ts";

type ValueType = string | "unknown" | "never";

type SymbolValue =
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignModule"; readonly declaration: ImportDeclaration }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration }
  | { readonly kind: "enum"; readonly declaration: EnumDeclaration };

const primitiveTypes = new Set(["i32", "void", "bool", "cstring"]);

export function analyze(program: Program, fileName: string): void {
  const globals = new Map<string, SymbolValue>();
  const structs = new Map<string, StructDeclaration>();
  const enums = new Map<string, EnumDeclaration>();

  for (const declaration of program.imports) {
    declareGlobal(globals, declaration.moduleName, { kind: "foreignModule", declaration }, declaration.location, fileName);
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
    analyzeStructDeclaration(declaration, structs, enums, fileName);
  }
  for (const declaration of program.enums) {
    analyzeEnumDeclaration(declaration, structs, enums, fileName);
  }

  for (const declaration of program.functions) {
    validateFunctionSignature(declaration, structs, enums, fileName);
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
      analyzeFunction(method, globals, structs, enums, fileName, declaration);
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
      );
    }
  }
  for (const declaration of program.functions) {
    analyzeFunction(declaration, globals, structs, enums, fileName, null);
  }
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
): void {
  const members = new Set<string>();
  for (const field of declaration.fields) {
    if (members.has(field.name)) {
      throw new DiagnosticError(fileName, field.location, `duplicate member ${JSON.stringify(field.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(field.name);
    validateType(field.type, structs, enums, fileName, false);
    if (enums.has(field.type.name)) {
      throw new DiagnosticError(fileName, field.location, "enum-valued struct fields are not implemented in this bootstrap stage");
    }
  }
  for (const method of declaration.methods) {
    if (members.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate member ${JSON.stringify(method.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(method.name);
    validateFunctionSignature(method, structs, enums, fileName);
  }
}

function analyzeEnumDeclaration(
  declaration: EnumDeclaration,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
): void {
  const names = new Set<string>();
  for (const variant of declaration.variants) {
    if (names.has(variant.name)) {
      throw new DiagnosticError(fileName, variant.location, `duplicate variant ${JSON.stringify(variant.name)}`);
    }
    names.add(variant.name);
    if (variant.payload) {
      validateType(variant.payload, structs, enums, fileName, false);
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
  fileName: string,
): void {
  validateType(declaration.returnType, structs, enums, fileName, true);
  if (declaration.errorType) validateType(declaration.errorType, structs, enums, fileName, false);
  if (declaration.errorType && hasCleanupType(declaration.errorType.name, structs)) {
    throw new DiagnosticError(fileName, declaration.errorType.location, "throwing cleanup-bearing error values is not implemented in this bootstrap stage");
  }
  if (declaration.errorType && declaration.returnType.name === "void") {
    throw new DiagnosticError(fileName, declaration.returnType.location, "void success results are not implemented in this bootstrap stage");
  }
  for (const parameter of declaration.parameters) {
    validateType(parameter.type, structs, enums, fileName, false);
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
): void {
  const locals = new Map<string, ValueType>();
  if (receiver) locals.set("this", receiver.name);

  for (const parameter of declaration.parameters) {
    if (locals.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate parameter ${JSON.stringify(parameter.name)}`);
    }
    locals.set(parameter.name, parameter.type.name);
  }

  const returns = analyzeStatements(declaration.body, declaration, locals, globals, structs, enums, fileName);
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
): boolean {
  let returns = false;
  for (const statement of statements) {
    if (returns) throw new DiagnosticError(fileName, statement.location, "unreachable statement after guaranteed function exit");
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName);
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
): void {
  switch (statement.kind) {
    case "variable": {
      if (locals.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.location, `duplicate local ${JSON.stringify(statement.name)}`);
      }
      const initializerType = inferDirectValue(statement.initializer, owner, locals, globals, structs, enums, fileName);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, structs, enums, fileName, false);
        variableType = statement.type.name;
        requireAssignable(variableType, initializerType, statement.initializer, fileName);
      } else if (initializerType === "unknown") {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "cannot infer the result of an imported function until its header is typed; add a type annotation",
        );
      } else if (initializerType === "never") {
        throw new DiagnosticError(fileName, statement.initializer.location, "cannot bind a value from an expression that never produces one");
      }
      rejectNamedOwnedMove(statement.initializer, variableType, structs, fileName);
      locals.set(statement.name, variableType);
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
      const actual = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName);
      requireAssignable(expected, actual, statement.expression, fileName);
      rejectNamedOwnedMove(statement.expression, expected, structs, fileName);
      return;
    }
    case "throw": {
      if (!owner.errorType) {
        throw new DiagnosticError(fileName, statement.location, `function ${JSON.stringify(owner.name)} does not declare an error type`);
      }
      const actual = inferExpression(statement.expression, locals, globals, structs, enums, fileName);
      requireAssignable(owner.errorType.name, actual, statement.expression, fileName);
      return;
    }
    case "yield":
      throw new DiagnosticError(fileName, statement.location, "yield requires an enclosing value-producing block");
    case "block": {
      const blockLocals = new Map(locals);
      analyzeStatements(statement.statements, owner, blockLocals, globals, structs, enums, fileName);
      return;
    }
    case "if": {
      const conditionType = inferExpression(statement.condition, locals, globals, structs, enums, fileName);
      requireAssignable("bool", conditionType, statement.condition, fileName);
      analyzeStatement(statement.thenBranch, owner, locals, globals, structs, enums, fileName);
      if (statement.elseBranch) {
        analyzeStatement(statement.elseBranch, owner, locals, globals, structs, enums, fileName);
      }
      return;
    }
    case "expressionStatement":
      {
        const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName);
        if (hasCleanupType(type, structs)) {
          throw new DiagnosticError(fileName, statement.expression.location, "a cleanup-bearing value must be bound or transferred; it cannot be discarded");
        }
      }
      return;
    case "match": {
      const subjectType = inferExpression(statement.expression, locals, globals, structs, enums, fileName);
      const declaration = enums.get(subjectType);
      if (!declaration) {
        throw new DiagnosticError(fileName, statement.expression.location, `match requires an enum value, found ${subjectType}`);
      }
      const covered = new Set<string>();
      for (const arm of statement.arms) {
        const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
        if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
        if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
        covered.add(variant.name);
        if (Boolean(variant.payload) !== Boolean(arm.binding)) {
          throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
        }
        const armLocals = new Map(locals);
        if (variant.payload && arm.binding) armLocals.set(arm.binding, variant.payload.name);
        analyzeStatement(arm.body, owner, armLocals, globals, structs, enums, fileName);
      }
      const missing = declaration.variants.find((variant) => !covered.has(variant.name));
      if (missing) throw new DiagnosticError(fileName, statement.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
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
): ValueType {
  if (expression.kind === "try") {
    return inferTrySuccess(expression, owner, locals, globals, structs, enums, fileName);
  }
  if (expression.kind === "matchExpression") {
    return inferMatchExpression(expression, owner, locals, globals, structs, enums, fileName);
  }
  return inferExpression(expression, locals, globals, structs, enums, fileName);
}

function inferMatchExpression(
  expression: Extract<Expression, { kind: "matchExpression" }>,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
): ValueType {
  const subjectType = inferExpression(expression.expression, locals, globals, structs, enums, fileName);
  const declaration = enums.get(subjectType);
  if (!declaration) {
    throw new DiagnosticError(fileName, expression.expression.location, `match requires an enum value, found ${subjectType}`);
  }

  const covered = new Set<string>();
  let resultType: ValueType = "never";
  for (const arm of expression.arms) {
    const variant = declaration.variants.find((candidate) => candidate.name === arm.variantName);
    if (!variant) throw new DiagnosticError(fileName, arm.location, `unknown variant ${JSON.stringify(arm.variantName)}`);
    if (covered.has(variant.name)) throw new DiagnosticError(fileName, arm.location, `duplicate match arm ${JSON.stringify(variant.name)}`);
    covered.add(variant.name);
    if (Boolean(variant.payload) !== Boolean(arm.binding)) {
      throw new DiagnosticError(fileName, arm.location, variant.payload ? "payload variant requires a binding" : "payloadless variant cannot bind a value");
    }
    const armLocals = new Map(locals);
    if (variant.payload && arm.binding) armLocals.set(arm.binding, variant.payload.name);
    const armType = inferValueArm(arm.body, owner, armLocals, globals, structs, enums, fileName);
    if (armType !== "never") {
      if (resultType === "never" || resultType === "unknown") resultType = armType;
      else if (armType !== "unknown" && armType !== resultType) {
        throw new DiagnosticError(fileName, arm.location, `match arm produces ${armType}, but previous arms produce ${resultType}`);
      }
    }
  }
  const missing = declaration.variants.find((variant) => !covered.has(variant.name));
  if (missing) throw new DiagnosticError(fileName, expression.location, `non-exhaustive match; missing ${declaration.name}.${missing.name}`);
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
): ValueType {
  if (statement.kind === "expressionStatement" || statement.kind === "yield") {
    const type = inferDirectValue(statement.expression, owner, locals, globals, structs, enums, fileName);
    rejectNamedOwnedMove(statement.expression, type, structs, fileName);
    return type;
  }
  if (statement.kind === "return" || statement.kind === "throw") {
    analyzeStatement(statement, owner, locals, globals, structs, enums, fileName);
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
    );
    if (prefixReturns) {
      throw new DiagnosticError(fileName, statement.statements.at(-1)!.location, "unreachable statement after guaranteed function exit");
    }
    return inferValueArm(statement.statements.at(-1)!, owner, blockLocals, globals, structs, enums, fileName);
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
): ValueType {
  if (!owner.errorType) {
    throw new DiagnosticError(fileName, expression.location, "try requires an enclosing throwing function");
  }
  const resultType = inferExpression(expression.expression, locals, globals, structs, enums, fileName, true);
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
  allowThrowingCall = false,
): ValueType {
  switch (expression.kind) {
    case "number":
      return "i32";
    case "string":
      return "cstring";
    case "boolean":
      return "bool";
    case "unary": {
      const operand = inferExpression(expression.operand, locals, globals, structs, enums, fileName);
      if (expression.operator === "!" && operand === "bool") return "bool";
      throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires a bool operand`);
    }
    case "identifier": {
      const local = locals.get(expression.name);
      if (local) return local;
      const global = globals.get(expression.name);
      if (global?.kind === "function") {
        throw new DiagnosticError(fileName, expression.location, "function values are not implemented; call the function instead");
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
      const left = inferExpression(expression.left, locals, globals, structs, enums, fileName);
      const right = inferExpression(expression.right, locals, globals, structs, enums, fileName);
      if (["+", "-", "*", "/"].includes(expression.operator)) {
        if (left !== "i32" || right !== "i32") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires i32 operands`);
        }
        return "i32";
      }
      if (["<", "<=", ">", ">="].includes(expression.operator)) {
        if (left !== "i32" || right !== "i32") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires i32 operands`);
        }
        return "bool";
      }
      if (["==", "!="].includes(expression.operator)) {
        if (left !== right || (left !== "i32" && left !== "bool")) {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires matching i32 or bool operands`);
        }
        return "bool";
      }
      if (["&&", "||"].includes(expression.operator)) {
        if (left !== "bool" || right !== "bool") {
          throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires bool operands`);
        }
        return "bool";
      }
      throw new DiagnosticError(fileName, expression.location, `unsupported binary operator ${JSON.stringify(expression.operator)}`);
    }
    case "structExpression": {
      const declaration = structs.get(expression.typeName);
      if (!declaration) {
        throw new DiagnosticError(fileName, expression.location, `unknown struct ${JSON.stringify(expression.typeName)}`);
      }
      const provided = new Set<string>();
      for (const initializer of expression.fields) {
        if (provided.has(initializer.name)) {
          throw new DiagnosticError(fileName, initializer.location, `duplicate field initializer ${JSON.stringify(initializer.name)}`);
        }
        provided.add(initializer.name);
        const field = declaration.fields.find((candidate) => candidate.name === initializer.name);
        if (!field) {
          throw new DiagnosticError(fileName, initializer.location, `struct ${JSON.stringify(declaration.name)} has no field ${JSON.stringify(initializer.name)}`);
        }
        const actual = inferExpression(initializer.expression, locals, globals, structs, enums, fileName);
        requireAssignable(field.type.name, actual, initializer.expression, fileName);
        rejectNamedOwnedMove(initializer.expression, field.type.name, structs, fileName);
      }
      const missing = declaration.fields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(declaration.name)}`);
      }
      return declaration.name;
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
      const actual = inferExpression(expression.payload, locals, globals, structs, enums, fileName);
      requireAssignable(variant.payload.name, actual, expression.payload, fileName);
      return declaration.name;
    }
    case "attempt": {
      const result = inferExpression(expression.expression, locals, globals, structs, enums, fileName, true);
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
      if (isForeignMember(expression, globals)) return "unknown";
      if (expression.object.kind === "identifier") {
        const enumDeclaration = enums.get(expression.object.name);
        if (enumDeclaration) {
          const variant = enumDeclaration.variants.find((candidate) => candidate.name === expression.property);
          if (!variant) throw new DiagnosticError(fileName, expression.location, `enum ${JSON.stringify(enumDeclaration.name)} has no variant ${JSON.stringify(expression.property)}`);
          if (variant.payload) throw new DiagnosticError(fileName, expression.location, "payload variant must be called with a value");
          return enumDeclaration.name;
        }
      }
      const receiverType = inferExpression(expression.object, locals, globals, structs, enums, fileName);
      if (hasCleanupType(receiverType, structs) && !isNamedStorageExpression(expression.object)) {
        throw new DiagnosticError(fileName, expression.object.location, "a cleanup-bearing temporary must be bound before borrowing one of its members");
      }
      const declaration = structs.get(receiverType);
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
              const actual = inferExpression(expression.arguments[0], locals, globals, structs, enums, fileName);
              requireAssignable(variant.payload.name, actual, expression.arguments[0], fileName);
            }
            return enumDeclaration.name;
          }
        }
        if (isForeignMember(expression.callee, globals)) {
          for (const argument of expression.arguments) {
            const argumentType = inferExpression(argument, locals, globals, structs, enums, fileName);
            rejectNamedOwnedMove(argument, argumentType, structs, fileName);
          }
          return "unknown";
        }
        const receiverType = inferExpression(expression.callee.object, locals, globals, structs, enums, fileName);
        if (hasCleanupType(receiverType, structs) && !isNamedStorageExpression(expression.callee.object)) {
          throw new DiagnosticError(fileName, expression.callee.object.location, "a cleanup-bearing temporary must be bound before calling one of its methods");
        }
        const declaration = structs.get(receiverType);
        const method = declaration?.methods.find((candidate) => candidate.name === expression.callee.property);
        if (!declaration || !method) {
          throw new DiagnosticError(fileName, expression.callee.location, `type ${JSON.stringify(receiverType)} has no method ${JSON.stringify(expression.callee.property)}`);
        }
        checkArguments(method, expression.arguments, locals, globals, structs, enums, fileName, expression.location);
        if (method.errorType) {
          if (!allowThrowingCall) throw new DiagnosticError(fileName, expression.location, "throwing call requires `attempt` or `try`");
          return resultTypeName(method.returnType.name, method.errorType.name);
        }
        return method.returnType.name;
      }
      if (expression.callee.kind !== "identifier") {
        throw new DiagnosticError(fileName, expression.callee.location, "this expression is not callable");
      }
      const target = globals.get(expression.callee.name);
      if (target?.kind !== "function") {
        if (locals.has(expression.callee.name)) {
          throw new DiagnosticError(fileName, expression.callee.location, `${JSON.stringify(expression.callee.name)} is not callable`);
        }
        throw new DiagnosticError(fileName, expression.callee.location, `unknown function ${JSON.stringify(expression.callee.name)}`);
      }
      checkArguments(target.declaration, expression.arguments, locals, globals, structs, enums, fileName, expression.location);
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
): void {
  if (target.parameters.length !== args.length) {
    throw new DiagnosticError(
      fileName,
      location,
      `${JSON.stringify(target.name)} expects ${target.parameters.length} argument(s), received ${args.length}`,
    );
  }
  for (let index = 0; index < target.parameters.length; index += 1) {
    const actual = inferExpression(args[index], locals, globals, structs, enums, fileName);
    requireAssignable(target.parameters[index].type.name, actual, args[index], fileName);
    rejectNamedOwnedMove(args[index], target.parameters[index].type.name, structs, fileName);
  }
}

function validateDeinitControlFlow(statements: Statement[], fileName: string): void {
  for (const statement of statements) {
    if (statement.kind === "return" || statement.kind === "throw" || statement.kind === "yield") {
      throw new DiagnosticError(fileName, statement.location, `deinit cannot contain ${JSON.stringify(statement.kind)}`);
    }
    if (statement.kind === "block") validateDeinitControlFlow(statement.statements, fileName);
    if (statement.kind === "variable") validateDeinitExpression(statement.initializer, fileName);
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

function rejectNamedOwnedMove(
  expression: Expression,
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  fileName: string,
): void {
  if (!hasCleanupType(type, structs)) return;
  if (expression.kind !== "identifier" && expression.kind !== "member") return;
  throw new DiagnosticError(
    fileName,
    expression.location,
    "moving a cleanup-bearing value from named storage is not implemented yet; construct or return a fresh value",
  );
}

function isNamedStorageExpression(expression: Expression): boolean {
  if (expression.kind === "identifier") return true;
  return expression.kind === "member" && isNamedStorageExpression(expression.object);
}

function hasCleanupType(
  type: ValueType,
  structs: Map<string, StructDeclaration>,
  visiting = new Set<string>(),
): boolean {
  if (type === "unknown" || type === "never" || visiting.has(type)) return false;
  const declaration = structs.get(type);
  if (!declaration) return false;
  if (declaration.deinitializer) return true;
  visiting.add(type);
  const result = declaration.fields.some((field) => hasCleanupType(field.type.name, structs, visiting));
  visiting.delete(type);
  return result;
}

function isForeignMember(
  expression: Extract<Expression, { kind: "member" }>,
  globals: Map<string, SymbolValue>,
): boolean {
  return expression.object.kind === "identifier"
    && globals.get(expression.object.name)?.kind === "foreignModule";
}

function validateType(
  type: TypeReference,
  structs: Map<string, StructDeclaration>,
  enums: Map<string, EnumDeclaration>,
  fileName: string,
  allowVoid: boolean,
): void {
  if (!primitiveTypes.has(type.name) && !structs.has(type.name) && !enums.has(type.name)) {
    throw new DiagnosticError(fileName, type.location, `unknown type ${JSON.stringify(type.name)}`);
  }
  if (!allowVoid && type.name === "void") {
    throw new DiagnosticError(fileName, type.location, "void is not a value type");
  }
}

function requireAssignable(expected: ValueType, actual: ValueType, expression: Expression, fileName: string): void {
  if (actual !== "unknown" && actual !== "never" && expected !== actual) {
    throw new DiagnosticError(fileName, expression.location, `expected ${expected}, found ${actual}`);
  }
}

function declareGlobal(
  globals: Map<string, SymbolValue>,
  name: string,
  symbol: SymbolValue,
  location: SourceLocation,
  fileName: string,
): void {
  if (globals.has(name)) {
    throw new DiagnosticError(fileName, location, `duplicate top-level name ${JSON.stringify(name)}`);
  }
  globals.set(name, symbol);
}
