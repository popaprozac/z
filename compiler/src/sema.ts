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
import { DiagnosticError } from "./diagnostics.ts";

type ValueType = string | "unknown";

type SymbolValue =
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignModule"; readonly declaration: ImportDeclaration }
  | { readonly kind: "struct"; readonly declaration: StructDeclaration };

const primitiveTypes = new Set(["i32", "void", "bool", "cstring"]);

export function analyze(program: Program, fileName: string): void {
  const globals = new Map<string, SymbolValue>();
  const structs = new Map<string, StructDeclaration>();

  for (const declaration of program.imports) {
    declareGlobal(globals, declaration.moduleName, { kind: "foreignModule", declaration }, declaration.location, fileName);
  }

  for (const declaration of program.structs) {
    declareGlobal(globals, declaration.name, { kind: "struct", declaration }, declaration.location, fileName);
    structs.set(declaration.name, declaration);
  }

  for (const declaration of program.functions) {
    declareGlobal(globals, declaration.name, { kind: "function", declaration }, declaration.location, fileName);
  }

  for (const declaration of program.structs) {
    analyzeStructDeclaration(declaration, structs, fileName);
  }

  for (const declaration of program.functions) {
    validateFunctionSignature(declaration, structs, fileName);
  }

  validateStructLayouts(program.structs, structs, fileName);

  const main = globals.get("main");
  if (!main || main.kind !== "function") {
    throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "program must declare `function main(): i32`");
  }
  if (main.declaration.parameters.length !== 0 || main.declaration.returnType.name !== "i32") {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` must have signature `function main(): i32`");
  }

  for (const declaration of program.structs) {
    for (const method of declaration.methods) {
      analyzeFunction(method, globals, structs, fileName, declaration);
    }
  }
  for (const declaration of program.functions) {
    analyzeFunction(declaration, globals, structs, fileName, null);
  }
}

function analyzeStructDeclaration(
  declaration: StructDeclaration,
  structs: Map<string, StructDeclaration>,
  fileName: string,
): void {
  const members = new Set<string>();
  for (const field of declaration.fields) {
    if (members.has(field.name)) {
      throw new DiagnosticError(fileName, field.location, `duplicate member ${JSON.stringify(field.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(field.name);
    validateType(field.type, structs, fileName, false);
  }
  for (const method of declaration.methods) {
    if (members.has(method.name)) {
      throw new DiagnosticError(fileName, method.location, `duplicate member ${JSON.stringify(method.name)} in struct ${JSON.stringify(declaration.name)}`);
    }
    members.add(method.name);
    validateFunctionSignature(method, structs, fileName);
  }
}

function validateFunctionSignature(
  declaration: FunctionDeclaration,
  structs: Map<string, StructDeclaration>,
  fileName: string,
): void {
  validateType(declaration.returnType, structs, fileName, true);
  for (const parameter of declaration.parameters) {
    validateType(parameter.type, structs, fileName, false);
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

  for (const statement of declaration.body) {
    analyzeStatement(statement, declaration, locals, globals, structs, fileName);
  }

  if (declaration.returnType.name !== "void" && declaration.body.at(-1)?.kind !== "return") {
    throw new DiagnosticError(fileName, declaration.location, `function ${JSON.stringify(declaration.name)} must end with a return value`);
  }
}

function analyzeStatement(
  statement: Statement,
  owner: FunctionDeclaration,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  fileName: string,
): void {
  switch (statement.kind) {
    case "variable": {
      if (locals.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.location, `duplicate local ${JSON.stringify(statement.name)}`);
      }
      const initializerType = inferExpression(statement.initializer, locals, globals, structs, fileName);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, structs, fileName, false);
        variableType = statement.type.name;
        requireAssignable(variableType, initializerType, statement.initializer, fileName);
      } else if (initializerType === "unknown") {
        throw new DiagnosticError(
          fileName,
          statement.initializer.location,
          "cannot infer the result of an imported function until its header is typed; add a type annotation",
        );
      }
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
      const actual = inferExpression(statement.expression, locals, globals, structs, fileName);
      requireAssignable(expected, actual, statement.expression, fileName);
      return;
    }
    case "expressionStatement":
      inferExpression(statement.expression, locals, globals, structs, fileName);
      return;
  }
}

function inferExpression(
  expression: Expression,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
  structs: Map<string, StructDeclaration>,
  fileName: string,
): ValueType {
  switch (expression.kind) {
    case "number":
      return "i32";
    case "string":
      return "cstring";
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
      throw new DiagnosticError(fileName, expression.location, `unknown name ${JSON.stringify(expression.name)}`);
    }
    case "binary": {
      const left = inferExpression(expression.left, locals, globals, structs, fileName);
      const right = inferExpression(expression.right, locals, globals, structs, fileName);
      if (left !== "i32" || right !== "i32") {
        throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires i32 operands`);
      }
      return "i32";
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
        const actual = inferExpression(initializer.expression, locals, globals, structs, fileName);
        requireAssignable(field.type.name, actual, initializer.expression, fileName);
      }
      const missing = declaration.fields.find((field) => !provided.has(field.name));
      if (missing) {
        throw new DiagnosticError(fileName, expression.location, `missing field ${JSON.stringify(missing.name)} when constructing ${JSON.stringify(declaration.name)}`);
      }
      return declaration.name;
    }
    case "member": {
      if (isForeignMember(expression, globals)) return "unknown";
      const receiverType = inferExpression(expression.object, locals, globals, structs, fileName);
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
        if (isForeignMember(expression.callee, globals)) {
          for (const argument of expression.arguments) inferExpression(argument, locals, globals, structs, fileName);
          return "unknown";
        }
        const receiverType = inferExpression(expression.callee.object, locals, globals, structs, fileName);
        const declaration = structs.get(receiverType);
        const method = declaration?.methods.find((candidate) => candidate.name === expression.callee.property);
        if (!declaration || !method) {
          throw new DiagnosticError(fileName, expression.callee.location, `type ${JSON.stringify(receiverType)} has no method ${JSON.stringify(expression.callee.property)}`);
        }
        checkArguments(method, expression.arguments, locals, globals, structs, fileName, expression.location);
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
      checkArguments(target.declaration, expression.arguments, locals, globals, structs, fileName, expression.location);
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
    const actual = inferExpression(args[index], locals, globals, structs, fileName);
    requireAssignable(target.parameters[index].type.name, actual, args[index], fileName);
  }
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
  fileName: string,
  allowVoid: boolean,
): void {
  if (!primitiveTypes.has(type.name) && !structs.has(type.name)) {
    throw new DiagnosticError(fileName, type.location, `unknown type ${JSON.stringify(type.name)}`);
  }
  if (!allowVoid && type.name === "void") {
    throw new DiagnosticError(fileName, type.location, "void is not a value type");
  }
}

function requireAssignable(expected: ValueType, actual: ValueType, expression: Expression, fileName: string): void {
  if (actual !== "unknown" && expected !== actual) {
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
