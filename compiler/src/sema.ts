import type {
  Expression,
  FunctionDeclaration,
  ImportDeclaration,
  Program,
  Statement,
  TypeReference,
} from "./ast.ts";
import { DiagnosticError } from "./diagnostics.ts";

type PrimitiveType = "i32" | "void" | "bool" | "cstring";
type ValueType = PrimitiveType | "unknown";

type SymbolValue =
  | { readonly kind: "local"; readonly type: ValueType }
  | { readonly kind: "function"; readonly declaration: FunctionDeclaration }
  | { readonly kind: "foreignModule"; readonly declaration: ImportDeclaration };

const primitiveTypes = new Set<PrimitiveType>(["i32", "void", "bool", "cstring"]);

export function analyze(program: Program, fileName: string): void {
  const globals = new Map<string, SymbolValue>();

  for (const declaration of program.imports) {
    declareGlobal(globals, declaration.moduleName, {
      kind: "foreignModule",
      declaration,
    }, declaration.location, fileName);
  }

  for (const declaration of program.functions) {
    validateType(declaration.returnType, fileName, true);
    for (const parameter of declaration.parameters) {
      validateType(parameter.type, fileName, false);
    }
    declareGlobal(globals, declaration.name, {
      kind: "function",
      declaration,
    }, declaration.location, fileName);
  }

  const main = globals.get("main");
  if (!main || main.kind !== "function") {
    throw new DiagnosticError(fileName, { offset: 0, line: 1, column: 1 }, "program must declare `function main(): i32`");
  }
  if (main.declaration.parameters.length !== 0 || main.declaration.returnType.name !== "i32") {
    throw new DiagnosticError(fileName, main.declaration.location, "`main` must have signature `function main(): i32`");
  }

  for (const declaration of program.functions) {
    analyzeFunction(declaration, globals, fileName);
  }
}

function analyzeFunction(
  declaration: FunctionDeclaration,
  globals: Map<string, SymbolValue>,
  fileName: string,
): void {
  const locals = new Map<string, ValueType>();
  for (const parameter of declaration.parameters) {
    if (locals.has(parameter.name)) {
      throw new DiagnosticError(fileName, parameter.location, `duplicate parameter ${JSON.stringify(parameter.name)}`);
    }
    locals.set(parameter.name, parameter.type.name as PrimitiveType);
  }

  for (const statement of declaration.body) {
    analyzeStatement(statement, declaration, locals, globals, fileName);
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
  fileName: string,
): void {
  switch (statement.kind) {
    case "variable": {
      if (locals.has(statement.name)) {
        throw new DiagnosticError(fileName, statement.location, `duplicate local ${JSON.stringify(statement.name)}`);
      }
      const initializerType = inferExpression(statement.initializer, locals, globals, fileName);
      let variableType = initializerType;
      if (statement.type) {
        validateType(statement.type, fileName, false);
        variableType = statement.type.name as PrimitiveType;
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
      const expected = owner.returnType.name as PrimitiveType;
      if (!statement.expression) {
        if (expected !== "void") {
          throw new DiagnosticError(fileName, statement.location, `expected a ${expected} return value`);
        }
        return;
      }
      if (expected === "void") {
        throw new DiagnosticError(fileName, statement.location, "a void function cannot return a value");
      }
      const actual = inferExpression(statement.expression, locals, globals, fileName);
      requireAssignable(expected, actual, statement.expression, fileName);
      return;
    }
    case "expressionStatement":
      inferExpression(statement.expression, locals, globals, fileName);
      return;
  }
}

function inferExpression(
  expression: Expression,
  locals: Map<string, ValueType>,
  globals: Map<string, SymbolValue>,
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
      throw new DiagnosticError(fileName, expression.location, `unknown name ${JSON.stringify(expression.name)}`);
    }
    case "binary": {
      const left = inferExpression(expression.left, locals, globals, fileName);
      const right = inferExpression(expression.right, locals, globals, fileName);
      if (left !== "i32" || right !== "i32") {
        throw new DiagnosticError(fileName, expression.location, `operator ${JSON.stringify(expression.operator)} requires i32 operands`);
      }
      return "i32";
    }
    case "member": {
      if (expression.object.kind !== "identifier") {
        throw new DiagnosticError(fileName, expression.location, "nested member access is not implemented in the bootstrap compiler");
      }
      const symbol = globals.get(expression.object.name);
      if (symbol?.kind !== "foreignModule") {
        throw new DiagnosticError(fileName, expression.object.location, `${JSON.stringify(expression.object.name)} is not an imported module`);
      }
      return "unknown";
    }
    case "call": {
      if (expression.callee.kind === "member") {
        inferExpression(expression.callee, locals, globals, fileName);
        for (const argument of expression.arguments) {
          inferExpression(argument, locals, globals, fileName);
        }
        return "unknown";
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
      const parameters = target.declaration.parameters;
      if (parameters.length !== expression.arguments.length) {
        throw new DiagnosticError(
          fileName,
          expression.location,
          `${JSON.stringify(target.declaration.name)} expects ${parameters.length} argument(s), received ${expression.arguments.length}`,
        );
      }
      for (let index = 0; index < parameters.length; index += 1) {
        const actual = inferExpression(expression.arguments[index], locals, globals, fileName);
        requireAssignable(parameters[index].type.name as PrimitiveType, actual, expression.arguments[index], fileName);
      }
      return target.declaration.returnType.name as PrimitiveType;
    }
  }
}

function validateType(type: TypeReference, fileName: string, allowVoid: boolean): void {
  if (!primitiveTypes.has(type.name as PrimitiveType)) {
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
): void {
  if (actual !== "unknown" && expected !== actual) {
    throw new DiagnosticError(fileName, expression.location, `expected ${expected}, found ${actual}`);
  }
}

function declareGlobal(
  globals: Map<string, SymbolValue>,
  name: string,
  symbol: SymbolValue,
  location: ImportDeclaration["location"],
  fileName: string,
): void {
  if (globals.has(name)) {
    throw new DiagnosticError(fileName, location, `duplicate top-level name ${JSON.stringify(name)}`);
  }
  globals.set(name, symbol);
}

