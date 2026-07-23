import type {
  EnumDeclaration,
  Expression,
  FunctionDeclaration,
  Program,
  SourceLocation,
  Statement,
  TypeReference,
} from "./ast.ts";
import { importedStandardFunctions, standardFunctionSignature } from "./standard-library.ts";
import type { ForeignModule } from "./foreign.ts";

export function resultTypeName(successType: string, errorType: string): string {
  return `__z_Result_${successType}_${errorType}`;
}

export function materializeResultTypes(
  program: Program,
  foreignModules: ReadonlyMap<string, ForeignModule> = new Map(),
): Program {
  const generated = new Map<string, EnumDeclaration>();
  const existing = new Set(program.enums.map((declaration) => declaration.name));
  const addResult = (success: TypeReference, error: TypeReference, location: SourceLocation): void => {
    const name = resultTypeName(success.name, error.name);
    if (existing.has(name) || generated.has(name)) return;
    generated.set(name, {
      kind: "enum",
      name,
      location,
      variants: [
        {
          name: "success",
          payload: success.name === "void" ? null : success,
          location,
        },
        { name: "failure", payload: error, location },
      ],
    });
  };
  const functions: FunctionDeclaration[] = [
    ...program.functions,
    ...program.structs.flatMap((declaration) => declaration.methods),
  ];

  for (const name of importedStandardFunctions(program.imports)) {
    const signature = standardFunctionSignature(name);
    if (!signature.errorType) continue;
    functions.push({
      kind: "function",
      name,
      receiverMode: null,
      parameters: signature.parameters.map((parameter) => ({
        name: parameter.name,
        mode: parameter.mode,
        type: { name: parameter.type, location: program.imports[0]?.location ?? { offset: 0, line: 1, column: 1 } },
        location: program.imports[0]?.location ?? { offset: 0, line: 1, column: 1 },
      })),
      returnType: {
        name: signature.returnType,
        location: program.imports[0]?.location ?? { offset: 0, line: 1, column: 1 },
      },
      errorType: {
        name: signature.errorType,
        location: program.imports[0]?.location ?? { offset: 0, line: 1, column: 1 },
      },
      body: [],
      location: program.imports[0]?.location ?? { offset: 0, line: 1, column: 1 },
    });
  }

  for (const module of foreignModules.values()) {
    for (const declaration of module.functions.values()) {
      for (const overload of declaration.overloads) {
        if (!overload.status || overload.returnType.kind !== "z") continue;
        addResult(
          { name: "void", location: module.declaration.location },
          { name: overload.returnType.name, location: module.declaration.location },
          module.declaration.location,
        );
      }
    }
  }

  for (const declaration of functions) {
    if (declaration.errorType) addResult(declaration.returnType, declaration.errorType, declaration.location);
    collectClosureResults(declaration.body, addResult);
  }

  for (const aggregate of program.structs) {
    const constructor = aggregate.constructor;
    if (constructor?.errorType) {
      addResult({ name: aggregate.name, location: constructor.location }, constructor.errorType, constructor.location);
    }
    if (constructor) collectClosureResults(constructor.body, addResult);
  }

  for (const aggregate of program.structs) {
    if (aggregate.deinitializer) collectClosureResults(aggregate.deinitializer.body, addResult);
  }

  return { ...program, enums: [...program.enums, ...generated.values()] };
}

function collectClosureResults(
  statements: readonly Statement[],
  addResult: (success: TypeReference, error: TypeReference, location: SourceLocation) => void,
): void {
  const visitStatements = (nested: readonly Statement[]): void => {
    for (const statement of nested) {
      switch (statement.kind) {
        case "variable":
          if (statement.initializer) visitExpression(statement.initializer);
          break;
        case "destructure":
          visitExpression(statement.initializer);
          break;
        case "assignment":
          visitExpression(statement.target);
          visitExpression(statement.expression);
          break;
        case "return":
          if (statement.expression) visitExpression(statement.expression);
          break;
        case "throw":
        case "select":
        case "expressionStatement":
          visitExpression(statement.expression);
          break;
        case "block":
          visitStatements(statement.statements);
          break;
        case "if":
          visitExpression(statement.condition);
          visitStatements(statement.thenBranch.statements);
          if (statement.elseBranch?.kind === "block") visitStatements(statement.elseBranch.statements);
          else if (statement.elseBranch) visitStatements([statement.elseBranch]);
          break;
        case "while":
          visitExpression(statement.condition);
          visitStatements(statement.body.statements);
          break;
        case "for":
          visitExpression(statement.iterable);
          visitStatements(statement.body.statements);
          break;
        case "asyncScope":
          visitStatements(statement.body.statements);
          break;
        case "match":
          visitExpression(statement.expression);
          for (const arm of statement.arms) visitStatements([arm.body]);
          break;
        case "break":
        case "continue":
          break;
      }
    }
  };

  const visitExpression = (expression: Expression): void => {
    switch (expression.kind) {
      case "closure":
        if (expression.errorType && expression.returnType) {
          addResult(expression.returnType, expression.errorType, expression.location);
        }
        if (expression.body.kind === "block") visitStatements(expression.body.statements);
        else visitExpression(expression.body);
        break;
      case "template":
        for (const part of expression.parts) if (part.kind === "value") visitExpression(part.expression);
        break;
      case "unary":
        visitExpression(expression.operand);
        break;
      case "weak":
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        visitExpression(expression.expression);
        break;
      case "executorPlacement":
        if (expression.errorType && expression.returnType) {
          addResult(expression.returnType, expression.errorType, expression.location);
        }
        visitExpression(expression.executor);
        visitStatements(expression.body.statements);
        break;
      case "binary":
        visitExpression(expression.left);
        visitExpression(expression.right);
        break;
      case "conditional":
        visitExpression(expression.condition);
        visitExpression(expression.thenExpression);
        visitExpression(expression.elseExpression);
        break;
      case "new":
        for (const argument of expression.arguments) visitExpression(argument);
        break;
      case "call":
        visitExpression(expression.callee);
        for (const argument of expression.arguments) visitExpression(argument);
        break;
      case "member":
        visitExpression(expression.object);
        break;
      case "index":
        visitExpression(expression.object);
        visitExpression(expression.index);
        break;
      case "arrayExpression":
        for (const element of expression.elements) visitExpression(element);
        break;
      case "structExpression":
      case "objectExpression":
        for (const field of expression.fields) visitExpression(field.expression);
        break;
      case "variantExpression":
        visitExpression(expression.payload);
        break;
      case "matchExpression":
        visitExpression(expression.expression);
        for (const arm of expression.arms) visitStatements([arm.body]);
        break;
      case "ifExpression":
        visitExpression(expression.condition);
        visitStatements(expression.thenBranch.statements);
        if (expression.elseBranch.kind === "ifExpression") visitExpression(expression.elseBranch);
        else visitStatements(expression.elseBranch.statements);
        break;
      case "whileExpression":
        visitExpression(expression.condition);
        visitStatements(expression.body.statements);
        visitStatements(expression.elseBranch.statements);
        break;
      case "forExpression":
        visitExpression(expression.iterable);
        visitStatements(expression.body.statements);
        visitStatements(expression.elseBranch.statements);
        break;
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "identifier":
      case "dynamicArrayExpression":
      case "argumentReference":
        break;
    }
  };

  visitStatements(statements);
}
