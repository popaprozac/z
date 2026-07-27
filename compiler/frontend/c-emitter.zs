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
  if (type.name == "boolean") return "bool";
  if (type.name == "void") return "void";
  throw `native emission does not support type ${type.name} yet`;
}

function appendIndent(inout output: TextBuffer, depth: usize): void {
  let current: usize = 0;
  while (current < depth) {
    output.append("  ");
    current = current + 1;
  }
}

function appendExpression(
  inout output: TextBuffer,
  in tree: ExpressionTree,
  index: usize
): void throws String {
  if (
    tree.nodes[index].kind == ExpressionKind.identifierExpression
    || tree.nodes[index].kind == ExpressionKind.numberExpression
    || tree.nodes[index].kind == ExpressionKind.booleanExpression
  ) {
    output.append(tree.nodes[index].value);
    return;
  }
  if (tree.nodes[index].kind == ExpressionKind.unaryExpression) {
    if (tree.nodes[index].children.length != 1) {
      throw "native emission received a malformed unary expression";
    }
    const operand = tree.nodes[index].children[0];
    if (tree.nodes[index].value == "-") {
      output.append("z_stage1_checked_negate_i32(");
      try appendExpression(inout output, tree, operand);
      output.append(")");
      return;
    }
    if (
      tree.nodes[index].value != "!"
      && tree.nodes[index].value != "+"
      && tree.nodes[index].value != "~"
    ) {
      throw `native emission does not support unary operator ${tree.nodes[index].value} yet`;
    }
    output.append("(");
    output.append(tree.nodes[index].value);
    try appendExpression(inout output, tree, operand);
    output.append(")");
    return;
  }
  if (tree.nodes[index].kind == ExpressionKind.binaryExpression) {
    if (tree.nodes[index].children.length != 2) {
      throw "native emission received a malformed binary expression";
    }
    const left = tree.nodes[index].children[0];
    const right = tree.nodes[index].children[1];
    if (
      tree.nodes[index].value == "+"
      || tree.nodes[index].value == "-"
      || tree.nodes[index].value == "*"
    ) {
      if (tree.nodes[index].value == "+") output.append("z_stage1_checked_add_i32(");
      else if (tree.nodes[index].value == "-") output.append("z_stage1_checked_subtract_i32(");
      else output.append("z_stage1_checked_multiply_i32(");
      try appendExpression(inout output, tree, left);
      output.append(", ");
      try appendExpression(inout output, tree, right);
      output.append(")");
      return;
    }
    if (
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
      throw `native emission does not support binary operator ${tree.nodes[index].value} yet`;
    }
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

function appendBranch(
  inout output: TextBuffer,
  in arena: StatementArena,
  index: usize,
  depth: usize
): void throws String {
  if (arena.nodes[index].kind == StatementKind.blockStatement) {
    for (const child of arena.nodes[index].children) {
      try appendStatement(inout output, arena, arena.nodes[child], depth);
    }
    return;
  }
  try appendStatement(inout output, arena, arena.nodes[index], depth);
}

function appendStatement(
  inout output: TextBuffer,
  in arena: StatementArena,
  in statement: Statement,
  depth: usize
): void throws String {
  if (statement.kind == StatementKind.variableStatement) {
    const type = match (in statement.typeAnnotation) {
      some(annotation) => try cType(annotation);
      none => throw `native emission requires an explicit type for local ${statement.name} in its first slice`;
    };
    appendIndent(inout output, depth);
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
    appendIndent(inout output, depth);
    output.append("return");
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
  if (statement.kind == StatementKind.assignmentStatement) {
    appendIndent(inout output, depth);
    match (in statement.expression) {
      some(target) => try appendExpressionSyntax(inout output, target);
      none => throw "native emission received an assignment without a target";
    }
    output.append(" = ");
    match (in statement.secondExpression) {
      some(value) => try appendExpressionSyntax(inout output, value);
      none => throw "native emission received an assignment without a value";
    }
    output.append(";\n");
    return;
  }
  if (statement.kind == StatementKind.expressionStatement) {
    appendIndent(inout output, depth);
    match (in statement.expression) {
      some(expression) => try appendExpressionSyntax(inout output, expression);
      none => throw "native emission received an empty expression statement";
    }
    output.append(";\n");
    return;
  }
  if (statement.kind == StatementKind.blockStatement) {
    appendIndent(inout output, depth);
    output.append("{\n");
    for (const child of statement.children) {
      try appendStatement(inout output, arena, arena.nodes[child], depth + 1);
    }
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (statement.kind == StatementKind.ifStatement) {
    appendIndent(inout output, depth);
    output.append("if (");
    match (in statement.expression) {
      some(condition) => try appendExpressionSyntax(inout output, condition);
      none => throw "native emission received an if statement without a condition";
    }
    output.append(") {\n");
    if (statement.children.length == 0) {
      throw "native emission received an if statement without a branch";
    }
    const thenBranch = statement.children[0];
    try appendBranch(inout output, arena, thenBranch, depth + 1);
    appendIndent(inout output, depth);
    if (statement.children.length > 1) {
      output.append("} else {\n");
      const elseBranch = statement.children[1];
      try appendBranch(inout output, arena, elseBranch, depth + 1);
      appendIndent(inout output, depth);
    }
    output.append("}\n");
    return;
  }
  if (statement.kind == StatementKind.whileStatement) {
    appendIndent(inout output, depth);
    output.append("while (");
    match (in statement.expression) {
      some(condition) => try appendExpressionSyntax(inout output, condition);
      none => throw "native emission received a while statement without a condition";
    }
    output.append(") {\n");
    if (statement.children.length != 1) {
      throw "native emission received a while statement without one body";
    }
    const body = statement.children[0];
    try appendBranch(inout output, arena, body, depth + 1);
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (
    statement.kind == StatementKind.breakStatement
    || statement.kind == StatementKind.continueStatement
  ) {
    appendIndent(inout output, depth);
    if (statement.kind == StatementKind.breakStatement) output.append("break;\n");
    else output.append("continue;\n");
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
    try appendStatement(inout output, declaration.body, declaration.body.nodes[root], 1);
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
  output.append("#include <stdbool.h>\n#include <stdint.h>\n#include <stdlib.h>\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_add_i32(int32_t left, int32_t right) {\n");
  output.append("  int32_t result;\n");
  output.append("  if (__builtin_add_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_subtract_i32(int32_t left, int32_t right) {\n");
  output.append("  int32_t result;\n");
  output.append("  if (__builtin_sub_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_multiply_i32(int32_t left, int32_t right) {\n");
  output.append("  int32_t result;\n");
  output.append("  if (__builtin_mul_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_negate_i32(int32_t value) {\n");
  output.append("  int32_t result;\n");
  output.append("  if (__builtin_sub_overflow(0, value, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
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
