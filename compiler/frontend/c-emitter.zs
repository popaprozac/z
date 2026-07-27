// C-family text emission from the typed native lowering IR.

import { TextBuffer } from "std/text";
import {
  LoweredExpressionKind,
  LoweredFunction,
  LoweredCleanup,
  LoweredProgram,
  LoweredStatementKind,
  LoweredType,
  LoweredTypeKind,
  lowerProgram,
} from "./lowering-ir.zs";
import { Program } from "./parser.zs";

function cType(in type: LoweredType): String throws String {
  if (type.kind == LoweredTypeKind.i32Type) return "int32_t";
  if (type.kind == LoweredTypeKind.booleanType) return "bool";
  if (type.kind == LoweredTypeKind.voidType) return "void";
  if (type.kind == LoweredTypeKind.structType) return `Z_${type.name}`;
  throw "native C emission received an unsupported lowered type";
}

function appendIndent(inout output: TextBuffer, depth: usize): void {
  let current: usize = 0;
  while (current < depth) {
    output.append("  ");
    current = current + 1;
  }
}

function appendCleanups(
  inout output: TextBuffer,
  in cleanups: Array<LoweredCleanup>,
  depth: usize
): void {
  let remaining = cleanups.length;
  while (remaining > 0) {
    remaining = remaining - 1;
    appendIndent(inout output, depth);
    output.append("Z_");
    output.append(cleanups[remaining].type.name);
    output.append("_deinit(&");
    output.append(cleanups[remaining].name);
    output.append(");\n");
  }
}

function appendExpression(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize
): void throws String {
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.localValue
    || declaration.expressions[index].kind == LoweredExpressionKind.integerValue
    || declaration.expressions[index].kind == LoweredExpressionKind.booleanValue
  ) {
    output.append(declaration.expressions[index].value);
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.checkedAddI32
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedSubtractI32
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedMultiplyI32
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed checked binary expression";
    }
    if (declaration.expressions[index].kind == LoweredExpressionKind.checkedAddI32) {
      output.append("z_stage1_checked_add_i32(");
    } else if (
      declaration.expressions[index].kind == LoweredExpressionKind.checkedSubtractI32
    ) {
      output.append("z_stage1_checked_subtract_i32(");
    } else output.append("z_stage1_checked_multiply_i32(");
    const left = declaration.expressions[index].children[0];
    const right = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, left);
    output.append(", ");
    try appendExpression(inout output, declaration, right);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.checkedNegateI32) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed checked negate expression";
    }
    const operand = declaration.expressions[index].children[0];
    output.append("z_stage1_checked_negate_i32(");
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.moveValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed move expression";
    }
    const operand = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, operand);
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.unaryOperation
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed unary expression";
    }
    const operand = declaration.expressions[index].children[0];
    output.append("(");
    output.append(declaration.expressions[index].value);
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.binaryOperation
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed binary expression";
    }
    const left = declaration.expressions[index].children[0];
    const right = declaration.expressions[index].children[1];
    output.append("(");
    try appendExpression(inout output, declaration, left);
    output.append(" ");
    output.append(declaration.expressions[index].value);
    output.append(" ");
    try appendExpression(inout output, declaration, right);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.directCall) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received a malformed direct call";
    }
    const callee = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, callee);
    output.append("(");
    let argument: usize = 1;
    while (argument < declaration.expressions[index].children.length) {
      if (argument > 1) output.append(", ");
      const value = declaration.expressions[index].children[argument];
      try appendExpression(inout output, declaration, value);
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.fieldValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed field read";
    }
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append(".");
    output.append(declaration.expressions[index].value);
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.structValue) {
    if (
      declaration.expressions[index].children.length
      != declaration.expressions[index].labels.length
    ) {
      throw "native C emission received a malformed struct value";
    }
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){");
    let field: usize = 0;
    while (field < declaration.expressions[index].children.length) {
      if (field > 0) output.append(", ");
      output.append(".");
      output.append(declaration.expressions[index].labels[field]);
      output.append(" = ");
      const value = declaration.expressions[index].children[field];
      try appendExpression(inout output, declaration, value);
      field = field + 1;
    }
    output.append("}");
    return;
  }
  throw "native C emission does not support this lowered expression yet";
}

function appendBranch(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  if (declaration.statements[index].kind == LoweredStatementKind.blockStatement) {
    for (const child of declaration.statements[index].children) {
      try appendStatement(inout output, declaration, child, depth);
    }
    return;
  }
  try appendStatement(inout output, declaration, index, depth);
}

function appendStatement(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  if (declaration.statements[index].kind == LoweredStatementKind.localStatement) {
    const type = match (in declaration.statements[index].type) {
      some(type) => try cType(type);
      none => throw "native C emission received an untyped local";
    };
    appendIndent(inout output, depth);
    if (!declaration.statements[index].mutableBinding) output.append("const ");
    output.append(type);
    output.append(" ");
    output.append(declaration.statements[index].name);
    match (in declaration.statements[index].expression) {
      some(expression) => {
        output.append(" = ");
        try appendExpression(inout output, declaration, expression);
      }
      none => {}
    }
    output.append(";\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.returnStatement) {
    if (declaration.statements[index].cleanups.length > 0) {
      match (in declaration.statements[index].expression) {
        some(expression) => {
          appendIndent(inout output, depth);
          const returnType = try cType(declaration.returnType);
          output.append(returnType);
          output.append(` _z_stage1_return_${index} = `);
          try appendExpression(inout output, declaration, expression);
          output.append(";\n");
          appendCleanups(inout output, declaration.statements[index].cleanups, depth);
          appendIndent(inout output, depth);
          output.append(`return _z_stage1_return_${index};\n`);
        }
        none => {
          appendCleanups(inout output, declaration.statements[index].cleanups, depth);
          appendIndent(inout output, depth);
          output.append("return;\n");
        }
      }
      return;
    }
    appendIndent(inout output, depth);
    output.append("return");
    match (in declaration.statements[index].expression) {
      some(expression) => {
        output.append(" ");
        try appendExpression(inout output, declaration, expression);
      }
      none => {}
    }
    output.append(";\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.assignmentStatement) {
    appendIndent(inout output, depth);
    match (in declaration.statements[index].expression) {
      some(target) => try appendExpression(inout output, declaration, target);
      none => throw "native C emission received an assignment without a target";
    }
    output.append(" = ");
    match (in declaration.statements[index].secondExpression) {
      some(value) => try appendExpression(inout output, declaration, value);
      none => throw "native C emission received an assignment without a value";
    }
    output.append(";\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.expressionStatement) {
    appendIndent(inout output, depth);
    match (in declaration.statements[index].expression) {
      some(expression) => try appendExpression(inout output, declaration, expression);
      none => throw "native C emission received an empty expression statement";
    }
    output.append(";\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.blockStatement) {
    appendIndent(inout output, depth);
    output.append("{\n");
    for (const child of declaration.statements[index].children) {
      try appendStatement(inout output, declaration, child, depth + 1);
    }
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.ifStatement) {
    appendIndent(inout output, depth);
    output.append("if (");
    match (in declaration.statements[index].expression) {
      some(condition) => try appendExpression(inout output, declaration, condition);
      none => throw "native C emission received an if without a condition";
    }
    output.append(") {\n");
    if (declaration.statements[index].children.length == 0) {
      throw "native C emission received an if without a branch";
    }
    const thenBranch = declaration.statements[index].children[0];
    try appendBranch(inout output, declaration, thenBranch, depth + 1);
    appendIndent(inout output, depth);
    if (declaration.statements[index].children.length > 1) {
      output.append("} else {\n");
      const elseBranch = declaration.statements[index].children[1];
      try appendBranch(inout output, declaration, elseBranch, depth + 1);
      appendIndent(inout output, depth);
    }
    output.append("}\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.whileStatement) {
    appendIndent(inout output, depth);
    output.append("while (");
    match (in declaration.statements[index].expression) {
      some(condition) => try appendExpression(inout output, declaration, condition);
      none => throw "native C emission received a while without a condition";
    }
    output.append(") {\n");
    if (declaration.statements[index].children.length != 1) {
      throw "native C emission received a while without one body";
    }
    const body = declaration.statements[index].children[0];
    try appendBranch(inout output, declaration, body, depth + 1);
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (
    declaration.statements[index].kind == LoweredStatementKind.breakStatement
    || declaration.statements[index].kind == LoweredStatementKind.continueStatement
  ) {
    appendIndent(inout output, depth);
    if (declaration.statements[index].kind == LoweredStatementKind.breakStatement) {
      output.append("break;\n");
    } else output.append("continue;\n");
    return;
  }
  throw "native C emission does not support this lowered statement yet";
}

function appendFunctionSignature(
  inout output: TextBuffer,
  in declaration: LoweredFunction
): void throws String {
  const returnType = try cType(declaration.returnType);
  output.append(returnType);
  output.append(" ");
  output.append(declaration.name);
  output.append("(");
  let first = true;
  for (const parameter of declaration.parameters) {
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
  in declaration: LoweredFunction
): void throws String {
  try appendFunctionSignature(inout output, declaration);
  output.append(" {\n");
  for (const root of declaration.roots) {
    try appendStatement(inout output, declaration, root, 1);
  }
  if (declaration.returnType.kind == LoweredTypeKind.voidType) {
    appendCleanups(inout output, declaration.fallthroughCleanups, 1);
  }
  output.append("}\n\n");
}

function emitLoweredC(in program: LoweredProgram): String throws String {
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
  for (const aggregate of program.structs) {
    output.append("typedef struct Z_");
    output.append(aggregate.name);
    output.append(" {\n");
    for (const field of aggregate.fields) {
      const fieldType = try cType(field.type);
      output.append("  ");
      output.append(fieldType);
      output.append(" ");
      output.append(field.name);
      output.append(";\n");
    }
    output.append("} Z_");
    output.append(aggregate.name);
    output.append(";\n\n");
    if (aggregate.customDeinit) {
      output.append("static void Z_");
      output.append(aggregate.name);
      output.append("_deinit(Z_");
      output.append(aggregate.name);
      output.append(" *self) {\n  (void)self;\n}\n\n");
    }
  }
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

export function emitC(in program: Program): String throws String {
  const lowered = try lowerProgram(program);
  return try emitLoweredC(lowered);
}
