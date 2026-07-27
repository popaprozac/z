// Typed, target-neutral lowering boundary between native semantics and C text.
//
// The parser AST preserves source structure. This IR instead records settled
// operations: checked arithmetic is no longer an operator string, and aggregate
// construction is no longer a call-shaped syntax node. Cleanup plans will join
// this representation when ownership-bearing aggregates land.

import {
  DeclarationKind,
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  Program,
  StatementArena,
  StatementKind,
  TypeReference,
} from "./parser.zs";

export enum LoweredTypeKind {
  voidType,
  booleanType,
  i32Type,
  structType,
}

export struct LoweredType {
  kind: LoweredTypeKind;
  name: String;
}

export struct LoweredField {
  name: String;
  type: LoweredType;
}

export struct LoweredStruct {
  name: String;
  fields: Array<LoweredField>;
}

export struct LoweredParameter {
  name: String;
  type: LoweredType;
}

export enum LoweredExpressionKind {
  localValue,
  integerValue,
  booleanValue,
  checkedAddI32,
  checkedSubtractI32,
  checkedMultiplyI32,
  checkedNegateI32,
  unaryOperation,
  binaryOperation,
  directCall,
  fieldValue,
  structValue,
}

export struct LoweredExpression {
  kind: LoweredExpressionKind;
  value: String;
  children: Array<usize>;
  labels: Array<String>;
}

export enum LoweredStatementKind {
  localStatement,
  assignmentStatement,
  returnStatement,
  expressionStatement,
  blockStatement,
  ifStatement,
  whileStatement,
  breakStatement,
  continueStatement,
}

export struct LoweredStatement {
  kind: LoweredStatementKind;
  mutableBinding: boolean;
  name: String;
  type: Option<LoweredType>;
  expression: Option<usize>;
  secondExpression: Option<usize>;
  children: Array<usize>;
}

export struct LoweredFunction {
  name: String;
  parameters: Array<LoweredParameter>;
  returnType: LoweredType;
  expressions: Array<LoweredExpression>;
  statements: Array<LoweredStatement>;
  roots: Array<usize>;
}

export struct LoweredProgram {
  structs: Array<LoweredStruct>;
  functions: Array<LoweredFunction>;
}

function structIndex(in program: Program, in name: String): Option<usize> {
  let index: usize = 0;
  while (index < program.aggregates.length) {
    if (
      program.aggregates[index].kind == DeclarationKind.structDeclaration
      && program.aggregates[index].name == name
    ) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function lowerType(in program: Program, in type: TypeReference): LoweredType throws String {
  if (type.name == "void") return LoweredType({ kind: LoweredTypeKind.voidType, name: "" });
  if (type.name == "boolean") {
    return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  }
  if (type.name == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  match (structIndex(program, type.name)) {
    some(_) => return LoweredType({
      kind: LoweredTypeKind.structType,
      name: type.name.copyBytes(0, type.name.byteLength),
    });
    none => {}
  }
  throw `native lowering does not support type ${type.name} yet`;
}

function pushExpression(
  inout output: Array<LoweredExpression>,
  kind: LoweredExpressionKind,
  in value: String,
  children: Array<usize>,
  labels: Array<String>
): usize {
  const index = output.length;
  output.push(LoweredExpression({
    kind,
    value: value.copyBytes(0, value.byteLength),
    children,
    labels,
  }));
  return index;
}

function lowerExpression(
  in program: Program,
  in tree: ExpressionTree,
  index: usize,
  inout output: Array<LoweredExpression>
): usize throws String {
  if (tree.nodes[index].kind == ExpressionKind.identifierExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.localValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.numberExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.integerValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.booleanExpression) {
    return pushExpression(
      inout output,
      LoweredExpressionKind.booleanValue,
      tree.nodes[index].value,
      Array<usize>(),
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.unaryExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed unary expression";
    }
    const operandInput = tree.nodes[index].children[0];
    const operand = try lowerExpression(program, tree, operandInput, inout output);
    let kind = LoweredExpressionKind.unaryOperation;
    if (tree.nodes[index].value == "-") kind = LoweredExpressionKind.checkedNegateI32;
    else if (
      tree.nodes[index].value != "!"
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "~"
    ) {
      throw `native lowering does not support unary operator ${tree.nodes[index].value} yet`;
    }
    let children = Array<usize>();
    children.push(operand);
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.binaryExpression) {
    if (tree.nodes[index].children.length != 2) {
      throw "native lowering received a malformed binary expression";
    }
    const leftInput = tree.nodes[index].children[0];
    const rightInput = tree.nodes[index].children[1];
    const left = try lowerExpression(program, tree, leftInput, inout output);
    const right = try lowerExpression(program, tree, rightInput, inout output);
    let kind = LoweredExpressionKind.binaryOperation;
    if (tree.nodes[index].value == "+") kind = LoweredExpressionKind.checkedAddI32;
    else if (tree.nodes[index].value == "-") kind = LoweredExpressionKind.checkedSubtractI32;
    else if (tree.nodes[index].value == "*") kind = LoweredExpressionKind.checkedMultiplyI32;
    else if (
      tree.nodes[index].value != "=="
      && tree.nodes[index].value != "!="
      && tree.nodes[index].value != "<"
      && tree.nodes[index].value != "<="
      && tree.nodes[index].value != ">"
      && tree.nodes[index].value != ">="
      && tree.nodes[index].value != "&&"
      && tree.nodes[index].value != "||"
      && tree.nodes[index].value != "&"
      && tree.nodes[index].value != "|"
      && tree.nodes[index].value != "^"
    ) {
      throw `native lowering does not support binary operator ${tree.nodes[index].value} yet`;
    }
    let children = Array<usize>();
    children.push(left);
    children.push(right);
    return pushExpression(
      inout output,
      kind,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) {
      throw "native lowering received a malformed call expression";
    }
    const calleeInput = tree.nodes[index].children[0];
    if (
      tree.nodes[calleeInput].kind == ExpressionKind.identifierExpression
      && tree.nodes[index].children.length == 2
    ) {
      match (structIndex(program, tree.nodes[calleeInput].value)) {
        some(_) => {
          const objectInput = tree.nodes[index].children[1];
          if (tree.nodes[objectInput].kind != ExpressionKind.objectExpression) {
            throw "native struct construction requires an object initializer";
          }
          if (
            tree.nodes[objectInput].children.length
            != tree.nodes[objectInput].labels.length
          ) {
            throw "native lowering received a malformed object initializer";
          }
          let children = Array<usize>();
          let labels = Array<String>();
          let field: usize = 0;
          while (field < tree.nodes[objectInput].children.length) {
            const valueInput = tree.nodes[objectInput].children[field];
            const value = try lowerExpression(program, tree, valueInput, inout output);
            children.push(value);
            labels.push(tree.nodes[objectInput].labels[field].copyBytes(
              0,
              tree.nodes[objectInput].labels[field].byteLength
            ));
            field = field + 1;
          }
          return pushExpression(
            inout output,
            LoweredExpressionKind.structValue,
            tree.nodes[calleeInput].value,
            children,
            labels
          );
        }
        none => {}
      }
    }
    const callee = try lowerExpression(program, tree, calleeInput, inout output);
    let children = Array<usize>();
    children.push(callee);
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      const argumentInput = tree.nodes[index].children[argument];
      const value = try lowerExpression(program, tree, argumentInput, inout output);
      children.push(value);
      argument = argument + 1;
    }
    return pushExpression(
      inout output,
      LoweredExpressionKind.directCall,
      "",
      children,
      Array<String>()
    );
  }
  if (tree.nodes[index].kind == ExpressionKind.memberExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native lowering received a malformed member expression";
    }
    const receiverInput = tree.nodes[index].children[0];
    const receiver = try lowerExpression(program, tree, receiverInput, inout output);
    let children = Array<usize>();
    children.push(receiver);
    return pushExpression(
      inout output,
      LoweredExpressionKind.fieldValue,
      tree.nodes[index].value,
      children,
      Array<String>()
    );
  }
  throw "native lowering does not support this expression shape yet";
}

function lowerExpressionSyntax(
  in program: Program,
  in expression: ExpressionSyntax,
  inout output: Array<LoweredExpression>
): usize throws String {
  return match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      select try lowerExpression(program, tree, root, inout output);
    }
    none => throw "native lowering cannot lower an opaque expression";
  };
}

function lowerStatement(
  in program: Program,
  in arena: StatementArena,
  index: usize,
  inout expressions: Array<LoweredExpression>,
  inout statements: Array<LoweredStatement>
): usize throws String {
  let kind = LoweredStatementKind.expressionStatement;
  if (arena.nodes[index].kind == StatementKind.variableStatement) {
    kind = LoweredStatementKind.localStatement;
  } else if (arena.nodes[index].kind == StatementKind.assignmentStatement) {
    kind = LoweredStatementKind.assignmentStatement;
  } else if (arena.nodes[index].kind == StatementKind.returnStatement) {
    kind = LoweredStatementKind.returnStatement;
  } else if (arena.nodes[index].kind == StatementKind.expressionStatement) {
    kind = LoweredStatementKind.expressionStatement;
  } else if (arena.nodes[index].kind == StatementKind.blockStatement) {
    kind = LoweredStatementKind.blockStatement;
  } else if (arena.nodes[index].kind == StatementKind.ifStatement) {
    kind = LoweredStatementKind.ifStatement;
  } else if (arena.nodes[index].kind == StatementKind.whileStatement) {
    kind = LoweredStatementKind.whileStatement;
  } else if (arena.nodes[index].kind == StatementKind.breakStatement) {
    kind = LoweredStatementKind.breakStatement;
  } else if (arena.nodes[index].kind == StatementKind.continueStatement) {
    kind = LoweredStatementKind.continueStatement;
  } else {
    throw "native lowering does not support this statement shape yet";
  }

  let type = Option<LoweredType>.none;
  match (in arena.nodes[index].typeAnnotation) {
    some(annotation) => {
      const loweredType = try lowerType(program, annotation);
      type = Option.some(move loweredType);
    }
    none => {
      if (arena.nodes[index].kind == StatementKind.variableStatement) {
        throw `native lowering requires an explicit type for local ${arena.nodes[index].name} in its first slice`;
      }
    }
  }
  let expression = Option<usize>.none;
  match (in arena.nodes[index].expression) {
    some(source) => {
      const loweredExpression = try lowerExpressionSyntax(program, source, inout expressions);
      expression = Option.some(loweredExpression);
    }
    none => {}
  }
  let secondExpression = Option<usize>.none;
  match (in arena.nodes[index].secondExpression) {
    some(source) => {
      const loweredExpression = try lowerExpressionSyntax(
        program,
        source,
        inout expressions
      );
      secondExpression = Option.some(loweredExpression);
    }
    none => {}
  }
  let children = Array<usize>();
  for (const child of arena.nodes[index].children) {
    const loweredChild = try lowerStatement(
      program,
      arena,
      child,
      inout expressions,
      inout statements
    );
    children.push(loweredChild);
  }
  const outputIndex = statements.length;
  statements.push(LoweredStatement({
    kind,
    mutableBinding: arena.nodes[index].mutableBinding,
    name: arena.nodes[index].name.copyBytes(0, arena.nodes[index].name.byteLength),
    type,
    expression,
    secondExpression,
    children,
  }));
  return outputIndex;
}

function lowerFunction(
  in program: Program,
  in declaration: FunctionDeclaration
): LoweredFunction throws String {
  if (declaration.asynchronous) {
    throw `native lowering does not support async function ${declaration.name} yet`;
  }
  let parameters = Array<LoweredParameter>();
  for (const parameter of declaration.parameters) {
    if (parameter.mode != ParameterMode.value) {
      throw `native lowering only supports value parameters in ${declaration.name} yet`;
    }
    const parameterType = try lowerType(program, parameter.type);
    parameters.push(LoweredParameter({
      name: parameter.name.copyBytes(0, parameter.name.byteLength),
      type: move parameterType,
    }));
  }
  let expressions = Array<LoweredExpression>();
  let statements = Array<LoweredStatement>();
  let roots = Array<usize>();
  for (const root of declaration.body.roots) {
    const loweredRoot = try lowerStatement(
      program,
      declaration.body,
      root,
      inout expressions,
      inout statements
    );
    roots.push(loweredRoot);
  }
  const returnType = try lowerType(program, declaration.returnType);
  return LoweredFunction({
    name: declaration.name.copyBytes(0, declaration.name.byteLength),
    parameters,
    returnType: move returnType,
    expressions,
    statements,
    roots,
  });
}

export function lowerProgram(in program: Program): LoweredProgram throws String {
  if (program.imports.length > 0) {
    throw "native lowering does not support imports in its first slice";
  }
  if (
    program.traits.length > 0
    || program.enums.length > 0
    || program.typeAliases.length > 0
  ) {
    throw "native lowering does not support traits, enums, or type aliases yet";
  }

  let structs = Array<LoweredStruct>();
  for (const aggregate of program.aggregates) {
    if (
      aggregate.kind != DeclarationKind.structDeclaration
      || aggregate.typeParameters.length > 0
      || aggregate.methods.length > 0
    ) {
      throw "native lowering only supports non-generic data-only structs yet";
    }
    match (in aggregate.constructorDeclaration) {
      some(_) => throw `native lowering does not support constructor on ${aggregate.name} yet`;
      none => {}
    }
    match (in aggregate.deinitializer) {
      some(_) => throw `native lowering does not support deinit on ${aggregate.name} yet`;
      none => {}
    }
    let fields = Array<LoweredField>();
    for (const field of aggregate.fields) {
      const fieldType = try lowerType(program, field.type);
      fields.push(LoweredField({
        name: field.name.copyBytes(0, field.name.byteLength),
        type: move fieldType,
      }));
    }
    structs.push(LoweredStruct({
      name: aggregate.name.copyBytes(0, aggregate.name.byteLength),
      fields,
    }));
  }

  let functions = Array<LoweredFunction>();
  for (const declaration of program.functions) {
    const loweredFunction = try lowerFunction(program, declaration);
    functions.push(move loweredFunction);
  }
  return LoweredProgram({ structs, functions });
}
