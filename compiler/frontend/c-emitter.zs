// First native code-generation slice.
//
// This intentionally emits only the closed, ordinary subset needed to prove
// that Stage 1 can carry a parsed Z program all the way to executable C. Stage
// 0 remains authoritative for the rest of the language while this grows.

import { TextBuffer } from "std/text";
import {
  ExpressionKind,
  ExpressionSyntax,
  ExpressionTree,
  FunctionDeclaration,
  ParameterMode,
  Program,
  Statement,
  StatementArena,
  StatementKind,
  TypeReference,
} from "./parser.zs";

function cType(in type: TypeReference): String throws String {
  if (type.name == "i32") return "int32_t";
  if (type.name == "void") return "void";
  throw `native emission does not support type ${type.name} yet`;
}

function appendExpression(
  inout output: TextBuffer,
  in tree: ExpressionTree,
  index: usize
): void throws String {
  if (
    tree.nodes[index].kind == ExpressionKind.identifierExpression
    || tree.nodes[index].kind == ExpressionKind.numberExpression
  ) {
    output.append(tree.nodes[index].value);
    return;
  }
  if (tree.nodes[index].kind == ExpressionKind.binaryExpression) {
    if (tree.nodes[index].children.length != 2) {
      throw "native emission received a malformed binary expression";
    }
    const left = tree.nodes[index].children[0];
    const right = tree.nodes[index].children[1];
    output.append("(");
    try appendExpression(inout output, tree, left);
    output.append(" ");
    output.append(tree.nodes[index].value);
    output.append(" ");
    try appendExpression(inout output, tree, right);
    output.append(")");
    return;
  }
  if (tree.nodes[index].kind == ExpressionKind.callExpression) {
    if (tree.nodes[index].children.length == 0) {
      throw "native emission received a malformed call expression";
    }
    const callee = tree.nodes[index].children[0];
    try appendExpression(inout output, tree, callee);
    output.append("(");
    let argument: usize = 1;
    while (argument < tree.nodes[index].children.length) {
      if (argument > 1) output.append(", ");
      const argumentNode = tree.nodes[index].children[argument];
      try appendExpression(inout output, tree, argumentNode);
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  throw "native emission does not support this expression shape yet";
}

function appendExpressionSyntax(
  inout output: TextBuffer,
  in expression: ExpressionSyntax
): void throws String {
  match (in expression.tree) {
    some(tree) => {
      const root = tree.root;
      try appendExpression(inout output, tree, root);
    }
    none => throw "native emission cannot lower an opaque expression";
  }
}

function appendStatement(
  inout output: TextBuffer,
  in arena: StatementArena,
  in statement: Statement
): void throws String {
  if (statement.kind == StatementKind.variableStatement) {
    const type = match (in statement.typeAnnotation) {
      some(annotation) => try cType(annotation);
      none => throw `native emission requires an explicit type for local ${statement.name} in its first slice`;
    };
    output.append("  ");
    if (!statement.mutableBinding) output.append("const ");
    output.append(type);
    output.append(" ");
    output.append(statement.name);
    match (in statement.expression) {
      some(expression) => {
        output.append(" = ");
        try appendExpressionSyntax(inout output, expression);
      }
      none => {}
    }
    output.append(";\n");
    return;
  }
  if (statement.kind == StatementKind.returnStatement) {
    output.append("  return");
    match (in statement.expression) {
      some(expression) => {
        output.append(" ");
        try appendExpressionSyntax(inout output, expression);
      }
      none => {}
    }
    output.append(";\n");
    return;
  }
  throw "native emission does not support this statement shape yet";
}

function appendFunctionSignature(
  inout output: TextBuffer,
  in declaration: FunctionDeclaration
): void throws String {
  if (declaration.asynchronous) {
    throw `native emission does not support async function ${declaration.name} yet`;
  }
  const returnType = try cType(declaration.returnType);
  output.append(returnType);
  output.append(" ");
  output.append(declaration.name);
  output.append("(");
  let first = true;
  for (const parameter of declaration.parameters) {
    if (parameter.mode != ParameterMode.value) {
      throw `native emission only supports value parameters in ${declaration.name} yet`;
    }
    if (!first) output.append(", ");
    first = false;
    const parameterType = try cType(parameter.type);
    output.append(parameterType);
    output.append(" ");
    output.append(parameter.name);
  }
  if (first) output.append("void");
  output.append(")");
}

function appendFunction(
  inout output: TextBuffer,
  in declaration: FunctionDeclaration
): void throws String {
  try appendFunctionSignature(inout output, declaration);
  output.append(" {\n");
  for (const root of declaration.body.roots) {
    try appendStatement(inout output, declaration.body, declaration.body.nodes[root]);
  }
  output.append("}\n\n");
}

export function emitC(in program: Program): String throws String {
  if (program.imports.length > 0) {
    throw "native emission does not support imports in its first slice";
  }
  if (
    program.aggregates.length > 0
    || program.traits.length > 0
    || program.enums.length > 0
    || program.typeAliases.length > 0
  ) {
    throw "native emission only supports ordinary functions in its first slice";
  }

  let output = TextBuffer();
  output.append("#include <stdint.h>\n\n");
  for (const declaration of program.functions) {
    try appendFunctionSignature(inout output, declaration);
    output.append(";\n");
  }
  output.append("\n");
  for (const declaration of program.functions) {
    try appendFunction(inout output, declaration);
  }
  return output.finish();
}
