import type {
  BlockStatement,
  Expression,
  SourceLocation,
  Statement,
} from "./ast.ts";

export type PlacementCaptureUse = {
  readonly name: string;
  readonly location: SourceLocation;
  mutated: boolean;
};

export function collectPlacementCaptures(
  body: BlockStatement,
  outerLocals: ReadonlySet<string>,
): readonly PlacementCaptureUse[] {
  const captures = new Map<string, PlacementCaptureUse>();
  const record = (
    name: string,
    location: SourceLocation,
    localNames: ReadonlySet<string>,
    mutated = false,
  ): void => {
    if (!outerLocals.has(name) || localNames.has(name)) return;
    const existing = captures.get(name);
    if (existing) existing.mutated ||= mutated;
    else captures.set(name, { name, location, mutated });
  };
  const visitExpression = (
    value: Expression,
    localNames: ReadonlySet<string>,
    mutated = false,
  ): void => {
    switch (value.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
        return;
      case "dynamicArrayExpression":
        for (const element of value.elements) visitExpression(element, localNames);
        return;
      case "identifier":
        record(value.name, value.location, localNames, mutated);
        return;
      case "argumentReference":
        record(value.name, value.location, localNames, true);
        return;
      case "template":
        for (const part of value.parts) {
          if (part.kind === "value") visitExpression(part.expression, localNames);
        }
        return;
      case "unary":
        visitExpression(value.operand, localNames);
        return;
      case "binary":
        visitExpression(value.left, localNames);
        visitExpression(value.right, localNames);
        return;
      case "conditional":
        visitExpression(value.condition, localNames);
        visitExpression(value.thenExpression, localNames);
        visitExpression(value.elseExpression, localNames);
        return;
      case "new":
        for (const argument of value.arguments) visitExpression(argument, localNames);
        return;
      case "weak":
      case "attempt":
      case "try":
      case "await":
      case "spawn":
        visitExpression(value.expression, localNames);
        return;
      case "closure":
        return;
      case "call":
        visitExpression(value.callee, localNames);
        for (const argument of value.arguments) visitExpression(argument, localNames);
        return;
      case "member":
        visitExpression(value.object, localNames, mutated);
        return;
      case "index":
        visitExpression(value.object, localNames, mutated);
        visitExpression(value.index, localNames);
        return;
      case "arrayExpression":
        for (const element of value.elements) visitExpression(element, localNames);
        return;
      case "structExpression":
      case "objectExpression":
        if (value.spread) visitExpression(value.spread.expression, localNames);
        for (const field of value.fields) visitExpression(field.expression, localNames);
        return;
      case "variantExpression":
        visitExpression(value.payload, localNames);
        return;
      case "executorPlacement":
        if (value.call) visitExpression(value.call, localNames);
        visitStatement(value.body, new Set(localNames));
        return;
      case "matchExpression":
        visitExpression(value.expression, localNames);
        for (const arm of value.arms) {
          const names = new Set(localNames);
          if (arm.binding) names.add(arm.binding);
          for (const field of arm.objectBindings ?? []) names.add(field.bindingName);
          visitStatement(arm.body, names);
        }
        return;
      case "ifExpression":
        visitExpression(value.condition, localNames);
        visitStatement(value.thenBranch, new Set(localNames));
        if (value.elseBranch.kind === "ifExpression") {
          visitExpression(value.elseBranch, new Set(localNames));
        } else {
          visitStatement(value.elseBranch, new Set(localNames));
        }
        return;
      case "unsafeExpression":
        visitStatement(value.body, new Set(localNames));
        return;
      case "whileExpression":
        visitExpression(value.condition, localNames);
        visitStatement(value.body, new Set(localNames));
        visitStatement(value.elseBranch, new Set(localNames));
        return;
      case "forExpression": {
        visitExpression(value.iterable, localNames);
        const names = new Set(localNames);
        if (value.binding) names.add(value.binding);
        for (const field of value.objectBindings ?? []) names.add(field.bindingName);
        visitStatement(value.body, names);
        visitStatement(value.elseBranch, new Set(localNames));
        return;
      }
    }
  };
  const visitStatements = (values: readonly Statement[], localNames: Set<string>): void => {
    for (const value of values) {
      if (value.kind === "variable") {
        if (value.initializer) visitExpression(value.initializer, localNames);
        localNames.add(value.name);
      } else if (value.kind === "destructure") {
        visitExpression(value.initializer, localNames);
        for (const field of value.objectBindings) localNames.add(field.bindingName);
      } else {
        visitStatement(value, localNames);
      }
    }
  };
  const visitStatement = (value: Statement, localNames: Set<string>): void => {
    switch (value.kind) {
      case "variable":
        if (value.initializer) visitExpression(value.initializer, localNames);
        localNames.add(value.name);
        return;
      case "destructure":
        visitExpression(value.initializer, localNames);
        for (const field of value.objectBindings) localNames.add(field.bindingName);
        return;
      case "assignment":
        visitExpression(value.target, localNames, true);
        visitExpression(value.expression, localNames);
        return;
      case "return":
        if (value.expression) visitExpression(value.expression, localNames);
        return;
      case "throw":
      case "yield":
      case "select":
      case "expressionStatement":
        visitExpression(value.expression, localNames);
        return;
      case "block":
        visitStatements(value.statements, new Set(localNames));
        return;
      case "if":
        visitExpression(value.condition, localNames);
        visitStatement(value.thenBranch, new Set(localNames));
        if (value.elseBranch) visitStatement(value.elseBranch, new Set(localNames));
        return;
      case "while":
        visitExpression(value.condition, localNames);
        visitStatement(value.body, new Set(localNames));
        return;
      case "for": {
        visitExpression(value.iterable, localNames);
        const names = new Set(localNames);
        if (value.binding) names.add(value.binding);
        for (const field of value.objectBindings ?? []) names.add(field.bindingName);
        visitStatement(value.body, names);
        return;
      }
      case "match":
        visitExpression(value.expression, localNames);
        for (const arm of value.arms) {
          const names = new Set(localNames);
          if (arm.binding) names.add(arm.binding);
          for (const field of arm.objectBindings ?? []) names.add(field.bindingName);
          visitStatement(arm.body, names);
        }
        return;
      case "asyncScope": {
        const names = new Set(localNames);
        if (value.name) names.add(value.name);
        visitStatement(value.body, names);
        return;
      }
      case "unsafe":
        visitStatement(value.body, new Set(localNames));
        return;
      case "break":
      case "continue":
        return;
    }
  };
  visitStatements(body.statements, new Set());
  return [...captures.values()];
}
