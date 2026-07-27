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
  if (type.kind == LoweredTypeKind.enumType) return `Z_${type.name}`;
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
    if (cleanups[remaining].guard.byteLength > 0) {
      output.append("if (");
      output.append(cleanups[remaining].guard);
      output.append(") ");
    }
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.receiverValue) {
    output.append("(*self)");
    return;
  }
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
    if (declaration.expressions[index].value.byteLength > 0) {
      output.append("(");
      output.append(declaration.expressions[index].value);
      output.append(" = false, ");
      try appendExpression(inout output, declaration, operand);
      output.append(")");
      return;
    }
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
    if (
      declaration.expressions[receiver].kind == LoweredExpressionKind.receiverValue
    ) {
      output.append("self->");
      output.append(declaration.expressions[index].value);
      return;
    }
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.enumValue) {
    if (
      declaration.expressions[index].labels.length < 1
      || declaration.expressions[index].labels.length > 2
    ) {
      throw "native C emission received a malformed enum value";
    }
    if (declaration.expressions[index].labels.length == 2) {
      output.append("(Z_");
      output.append(declaration.expressions[index].value);
      output.append("){.tag = Z_");
      output.append(declaration.expressions[index].value);
      output.append("Tag_");
      output.append(declaration.expressions[index].labels[0]);
      output.append("}");
      return;
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_");
    output.append(declaration.expressions[index].labels[0]);
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.enumPayloadValue
  ) {
    if (
      declaration.expressions[index].labels.length != 1
      || declaration.expressions[index].children.length != 1
    ) {
      throw "native C emission received a malformed enum payload value";
    }
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){.tag = Z_");
    output.append(declaration.expressions[index].value);
    output.append("Tag_");
    output.append(declaration.expressions[index].labels[0]);
    output.append(", .payload.");
    output.append(declaration.expressions[index].labels[0]);
    output.append(" = ");
    const payload = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, payload);
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
    appendCleanups(inout output, declaration.statements[index].cleanups, depth);
    return;
  }
  try appendStatement(inout output, declaration, index, depth);
}

function appendCondition(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize
): void throws String {
  const alreadyGrouped =
    declaration.expressions[index].kind == LoweredExpressionKind.unaryOperation
    || declaration.expressions[index].kind == LoweredExpressionKind.binaryOperation;
  if (!alreadyGrouped) output.append("(");
  try appendExpression(inout output, declaration, index);
  if (!alreadyGrouped) output.append(")");
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
    const constStorage = match (in declaration.statements[index].type) {
      some(storageType) => {
        select storageType.kind != LoweredTypeKind.structType
          && storageType.kind != LoweredTypeKind.enumType;
      }
      none => false;
    };
    const hasInitializer = match (in declaration.statements[index].expression) {
      some(_) => true;
      none => false;
    };
    appendIndent(inout output, depth);
    if (
      !declaration.statements[index].mutableBinding
      && constStorage
      && hasInitializer
    ) {
      output.append("const ");
    }
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
    if (declaration.statements[index].liveFlag.byteLength > 0) {
      appendIndent(inout output, depth);
      output.append("bool ");
      output.append(declaration.statements[index].liveFlag);
      output.append(" = true;\n");
    }
    for (const child of declaration.statements[index].children) {
      try appendStatement(inout output, declaration, child, depth);
    }
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
    if (declaration.statements[index].cleanups.length > 0) {
      if (declaration.statements[index].cleanups.length != 1) {
        throw "native C emission received ambiguous owned replacement cleanup";
      }
      appendIndent(inout output, depth);
      const replacementType = try cType(
        declaration.statements[index].cleanups[0].type
      );
      output.append(replacementType);
      output.append(` _z_stage1_assignment_${index} = `);
      match (in declaration.statements[index].secondExpression) {
        some(value) => try appendExpression(inout output, declaration, value);
        none => throw "native C emission received an assignment without a value";
      }
      output.append(";\n");
      appendCleanups(inout output, declaration.statements[index].cleanups, depth);
      appendIndent(inout output, depth);
      match (in declaration.statements[index].expression) {
        some(target) => try appendExpression(inout output, declaration, target);
        none => throw "native C emission received an assignment without a target";
      }
      output.append(` = _z_stage1_assignment_${index};\n`);
      if (declaration.statements[index].cleanups[0].guard.byteLength > 0) {
        appendIndent(inout output, depth);
        output.append(declaration.statements[index].cleanups[0].guard);
        output.append(" = true;\n");
      }
      return;
    }
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
  if (declaration.statements[index].kind == LoweredStatementKind.matchStatement) {
    if (
      declaration.statements[index].matchConsumesSubject
      && declaration.statements[index].liveFlag.byteLength > 0
    ) {
      appendIndent(inout output, depth);
      output.append(declaration.statements[index].liveFlag);
      output.append(" = false;\n");
    }
    const matchTemporary = `_z_stage1_match_${index}`;
    if (declaration.statements[index].matchConsumesSubject) {
      const subjectType = match (in declaration.statements[index].type) {
        some(type) => try cType(type);
        none => throw "native C emission received an untyped match subject";
      };
      appendIndent(inout output, depth);
      output.append(subjectType);
      output.append(" ");
      output.append(matchTemporary);
      output.append(" = ");
      match (in declaration.statements[index].expression) {
        some(subject) => try appendExpression(
          inout output,
          declaration,
          subject
        );
        none => throw "native C emission received a match without a subject";
      }
      output.append(";\n");
    }
    appendIndent(inout output, depth);
    output.append("switch (");
    if (declaration.statements[index].matchConsumesSubject) {
      output.append(matchTemporary);
    } else {
      match (in declaration.statements[index].expression) {
        some(subject) => {
          try appendExpression(inout output, declaration, subject);
        }
        none => throw "native C emission received a match without a subject";
      }
    }
    if (declaration.statements[index].labels.length > 0) output.append(".tag");
    output.append(") {\n");
    for (const arm of declaration.statements[index].children) {
      if (declaration.statements[arm].kind != LoweredStatementKind.matchArmStatement) {
        throw "native C emission received a malformed match arm";
      }
      appendIndent(inout output, depth + 1);
      output.append("case Z_");
      output.append(declaration.statements[index].name);
      if (declaration.statements[index].labels.length > 0) output.append("Tag");
      output.append("_");
      output.append(declaration.statements[arm].name);
      output.append(": {\n");
      match (in declaration.statements[arm].type) {
        some(type) => {
          if (declaration.statements[arm].labels.length != 1) {
            throw "native C emission received a payload arm without one binding";
          }
          appendIndent(inout output, depth + 2);
          if (!declaration.statements[arm].matchBindingNeedsCleanup) {
            output.append("const ");
          }
          const payloadType = try cType(type);
          output.append(payloadType);
          output.append(" ");
          output.append(declaration.statements[arm].labels[0]);
          output.append(" = ");
          if (declaration.statements[index].matchConsumesSubject) {
            output.append(matchTemporary);
          } else {
            match (in declaration.statements[index].expression) {
              some(subject) => try appendExpression(
                inout output,
                declaration,
                subject
              );
              none => throw "native C emission received a match without a subject";
            }
          }
          output.append(".payload.");
          output.append(declaration.statements[arm].name);
          output.append(";\n");
        }
        none => {}
      }
      for (const child of declaration.statements[arm].children) {
        try appendStatement(inout output, declaration, child, depth + 2);
      }
      appendCleanups(
        inout output,
        declaration.statements[arm].cleanups,
        depth + 2
      );
      appendIndent(inout output, depth + 2);
      output.append("break;\n");
      appendIndent(inout output, depth + 1);
      output.append("}\n");
    }
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.matchArmStatement) {
    throw "native C emission received a detached match arm";
  }
  if (declaration.statements[index].kind == LoweredStatementKind.blockStatement) {
    appendIndent(inout output, depth);
    output.append("{\n");
    for (const child of declaration.statements[index].children) {
      try appendStatement(inout output, declaration, child, depth + 1);
    }
    appendCleanups(
      inout output,
      declaration.statements[index].cleanups,
      depth + 1
    );
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.ifStatement) {
    appendIndent(inout output, depth);
    output.append("if ");
    match (in declaration.statements[index].expression) {
      some(condition) => try appendCondition(inout output, declaration, condition);
      none => throw "native C emission received an if without a condition";
    }
    output.append(" {\n");
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
    output.append("while ");
    match (in declaration.statements[index].expression) {
      some(condition) => try appendCondition(inout output, declaration, condition);
      none => throw "native C emission received a while without a condition";
    }
    output.append(" {\n");
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
    appendCleanups(inout output, declaration.statements[index].cleanups, depth);
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
  for (const flag of declaration.liveFlags) {
    if (flag.parameter) {
      appendIndent(inout output, 1);
      output.append("bool ");
      output.append(flag.name);
      output.append(" = true;\n");
    }
  }
  for (const root of declaration.roots) {
    try appendStatement(inout output, declaration, root, 1);
  }
  if (declaration.returnType.kind == LoweredTypeKind.voidType) {
    appendCleanups(inout output, declaration.fallthroughCleanups, 1);
  }
  output.append("}\n\n");
}

function loweredStructNeedsDeinit(
  in program: LoweredProgram,
  in name: String
): boolean {
  for (const aggregate of program.structs) {
    if (aggregate.name == name) return aggregate.needsDeinit;
  }
  return false;
}

function loweredEnumNeedsDeinit(
  in program: LoweredProgram,
  in name: String
): boolean {
  for (const declaration of program.enums) {
    if (declaration.name == name) return declaration.needsDeinit;
  }
  return false;
}

function loweredTypeNeedsDeinit(
  in program: LoweredProgram,
  in type: LoweredType
): boolean {
  if (type.kind == LoweredTypeKind.structType) {
    return loweredStructNeedsDeinit(program, type.name);
  }
  if (type.kind == LoweredTypeKind.enumType) {
    return loweredEnumNeedsDeinit(program, type.name);
  }
  return false;
}

function loweredStructIndex(
  in program: LoweredProgram,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < program.structs.length) {
    if (program.structs[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function loweredEnumIndex(
  in program: LoweredProgram,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < program.enums.length) {
    if (program.enums[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function appendEnumDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  index: usize,
  inout structStates: Array<u8>,
  inout enumStates: Array<u8>
): void throws String {
  if (enumStates[index] == 2) return;
  if (enumStates[index] == 1) {
    throw `native C emission found a by-value type cycle through ${program.enums[index].name}`;
  }
  enumStates[index] = 1;
  for (const item of program.enums[index].variants) {
    match (in item.payload) {
      some(type) => {
        match (loweredStructIndex(program, type.name)) {
          some(dependency) => try appendStructDefinition(
            inout output,
            program,
            dependency,
            inout structStates,
            inout enumStates
          );
          none => {}
        }
        match (loweredEnumIndex(program, type.name)) {
          some(dependency) => try appendEnumDefinition(
            inout output,
            program,
            dependency,
            inout structStates,
            inout enumStates
          );
          none => {}
        }
      }
      none => {}
    }
  }
  output.append("typedef enum Z_");
  output.append(program.enums[index].name);
  if (program.enums[index].payloadBearing) output.append("Tag");
  output.append(" {\n");
  let variant: usize = 0;
  while (variant < program.enums[index].variants.length) {
    output.append("  Z_");
    output.append(program.enums[index].name);
    if (program.enums[index].payloadBearing) output.append("Tag");
    output.append("_");
    output.append(program.enums[index].variants[variant].name);
    if (variant + 1 < program.enums[index].variants.length) output.append(",");
    output.append("\n");
    variant = variant + 1;
  }
  output.append("} Z_");
  output.append(program.enums[index].name);
  if (program.enums[index].payloadBearing) output.append("Tag");
  output.append(";\n\n");
  if (program.enums[index].payloadBearing) {
    output.append("typedef struct Z_");
    output.append(program.enums[index].name);
    output.append(" {\n  Z_");
    output.append(program.enums[index].name);
    output.append("Tag tag;\n  union {\n");
    for (const item of program.enums[index].variants) {
      match (in item.payload) {
        some(type) => {
          const payloadType = try cType(type);
          output.append("    ");
          output.append(payloadType);
          output.append(" ");
          output.append(item.name);
          output.append(";\n");
        }
        none => {}
      }
    }
    output.append("  } payload;\n} Z_");
    output.append(program.enums[index].name);
    output.append(";\n\n");
  }
  enumStates[index] = 2;
}

function appendStructDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  index: usize,
  inout structStates: Array<u8>,
  inout enumStates: Array<u8>
): void throws String {
  if (structStates[index] == 2) return;
  if (structStates[index] == 1) {
    throw `native C emission found a by-value type cycle through ${program.structs[index].name}`;
  }
  structStates[index] = 1;
  for (const field of program.structs[index].fields) {
    match (loweredStructIndex(program, field.type.name)) {
      some(dependency) => try appendStructDefinition(
        inout output,
        program,
        dependency,
        inout structStates,
        inout enumStates
      );
      none => {}
    }
    match (loweredEnumIndex(program, field.type.name)) {
      some(dependency) => try appendEnumDefinition(
        inout output,
        program,
        dependency,
        inout structStates,
        inout enumStates
      );
      none => {}
    }
  }
  output.append("typedef struct Z_");
  output.append(program.structs[index].name);
  output.append(" {\n");
  for (const field of program.structs[index].fields) {
    const fieldType = try cType(field.type);
    output.append("  ");
    output.append(fieldType);
    output.append(" ");
    output.append(field.name);
    output.append(";\n");
  }
  output.append("} Z_");
  output.append(program.structs[index].name);
  output.append(";\n\n");
  structStates[index] = 2;
}

function appendTypeDefinitions(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  let structStates = Array<u8>();
  let enumStates = Array<u8>();
  let stateIndex: usize = 0;
  while (stateIndex < program.structs.length) {
    structStates.push(0);
    stateIndex = stateIndex + 1;
  }
  stateIndex = 0;
  while (stateIndex < program.enums.length) {
    enumStates.push(0);
    stateIndex = stateIndex + 1;
  }
  let enumIndex: usize = 0;
  while (enumIndex < program.enums.length) {
    try appendEnumDefinition(
      inout output,
      program,
      enumIndex,
      inout structStates,
      inout enumStates
    );
    enumIndex = enumIndex + 1;
  }
  let structIndex: usize = 0;
  while (structIndex < program.structs.length) {
    try appendStructDefinition(
      inout output,
      program,
      structIndex,
      inout structStates,
      inout enumStates
    );
    structIndex = structIndex + 1;
  }
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
  try appendTypeDefinitions(inout output, program);
  for (const aggregate of program.structs) {
    if (aggregate.needsDeinit) {
      output.append("static void Z_");
      output.append(aggregate.name);
      output.append("_deinit(Z_");
      output.append(aggregate.name);
      output.append(" *self);\n");
    }
  }
  for (const declaration of program.enums) {
    if (declaration.needsDeinit) {
      output.append("static void Z_");
      output.append(declaration.name);
      output.append("_deinit(Z_");
      output.append(declaration.name);
      output.append(" *self);\n");
    }
  }
  for (const declaration of program.functions) {
    try appendFunctionSignature(inout output, declaration);
    output.append(";\n");
  }
  output.append("\n");
  for (const declaration of program.enums) {
    if (declaration.needsDeinit) {
      output.append("static void Z_");
      output.append(declaration.name);
      output.append("_deinit(Z_");
      output.append(declaration.name);
      output.append(" *self) {\n  switch (self->tag) {\n");
      for (const variant of declaration.variants) {
        output.append("    case Z_");
        output.append(declaration.name);
        output.append("Tag_");
        output.append(variant.name);
        output.append(":");
        match (in variant.payload) {
          some(type) => {
            if (loweredTypeNeedsDeinit(program, type)) {
              output.append("\n      Z_");
              output.append(type.name);
              output.append("_deinit(&self->payload.");
              output.append(variant.name);
              output.append(");\n      break;\n");
            } else output.append(" break;\n");
          }
          none => output.append(" break;\n");
        }
      }
      output.append("  }\n}\n\n");
    }
  }
  for (const aggregate of program.structs) {
    if (aggregate.needsDeinit) {
      output.append("static void Z_");
      output.append(aggregate.name);
      output.append("_deinit(Z_");
      output.append(aggregate.name);
      output.append(" *self) {\n  (void)self;\n");
      match (in aggregate.deinitializer) {
        some(deinitializer) => {
          for (const root of deinitializer.roots) {
            try appendStatement(inout output, deinitializer, root, 1);
          }
          appendCleanups(
            inout output,
            deinitializer.fallthroughCleanups,
            1
          );
        }
        none => {}
      }
      let fieldIndex = aggregate.fields.length;
      while (fieldIndex > 0) {
        fieldIndex = fieldIndex - 1;
        if (loweredTypeNeedsDeinit(program, aggregate.fields[fieldIndex].type)) {
          output.append("  Z_");
          output.append(aggregate.fields[fieldIndex].type.name);
          output.append("_deinit(&self->");
          output.append(aggregate.fields[fieldIndex].name);
          output.append(");\n");
        }
      }
      output.append("}\n\n");
    }
  }
  for (const declaration of program.functions) {
    try appendFunction(inout output, declaration);
  }
  return output.finish();
}

export function emitC(in program: Program): String throws String {
  const lowered = try lowerProgram(program);
  return try emitLoweredC(lowered);
}
