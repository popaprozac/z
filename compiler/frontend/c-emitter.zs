// C-family text emission from the typed native lowering IR.

import { TextBuffer } from "std/text";
import {
  LoweredExpressionKind,
  LoweredFunction,
  LoweredCleanup,
  LoweredParameterMode,
  LoweredProgram,
  LoweredStatementKind,
  LoweredType,
  LoweredTypeKind,
  lowerModules,
  lowerProgram,
} from "./lowering-ir.zs";
import { ParsedModule } from "./module-symbols.zs";
import { Program } from "./parser.zs";
import {
  ModuleGraph,
  ModuleSemanticEvidence,
} from "./semantic-model.zs";

function cType(in type: LoweredType): String throws String {
  if (type.kind == LoweredTypeKind.i8Type) return "int8_t";
  if (type.kind == LoweredTypeKind.i16Type) return "int16_t";
  if (type.kind == LoweredTypeKind.i32Type) return "int32_t";
  if (type.kind == LoweredTypeKind.i64Type) return "int64_t";
  if (type.kind == LoweredTypeKind.u8Type) return "uint8_t";
  if (type.kind == LoweredTypeKind.u16Type) return "uint16_t";
  if (type.kind == LoweredTypeKind.u32Type) return "uint32_t";
  if (type.kind == LoweredTypeKind.u64Type) return "uint64_t";
  if (type.kind == LoweredTypeKind.isizeType) return "intptr_t";
  if (type.kind == LoweredTypeKind.usizeType) return "size_t";
  if (type.kind == LoweredTypeKind.f32Type) return "float";
  if (type.kind == LoweredTypeKind.f64Type) return "double";
  if (type.kind == LoweredTypeKind.fsLockType) return "Z_FsLock";
  if (type.kind == LoweredTypeKind.stringType) return "Z_String";
  if (type.kind == LoweredTypeKind.arrayType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.mapType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.setType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.booleanType) return "bool";
  if (type.kind == LoweredTypeKind.voidType) return "void";
  if (type.kind == LoweredTypeKind.structType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.enumType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.foreignEnumType) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  throw "native C emission received an unsupported lowered type";
}

function nativeCExportType(
  in program: LoweredProgram,
  in type: LoweredType
): String throws String {
  if (type.kind == LoweredTypeKind.usizeType) return "uintptr_t";
  if (type.kind == LoweredTypeKind.structType) {
    for (const aggregate of program.structs) {
      if (aggregate.name != type.name) continue;
      if (aggregate.nativeCName.byteLength > 0) {
        return aggregate.nativeCName.copyBytes(0, aggregate.nativeCName.byteLength);
      }
    }
  }
  if (type.kind == LoweredTypeKind.enumType) {
    for (const enumeration of program.enums) {
      if (enumeration.name != type.name) continue;
      if (enumeration.nativeCName.byteLength > 0) {
        return enumeration.nativeCName.copyBytes(
          0,
          enumeration.nativeCName.byteLength
        );
      }
    }
  }
  return try cType(type);
}

function integerCType(in name: String): String throws String {
  if (name == "i8") return "int8_t";
  if (name == "i16") return "int16_t";
  if (name == "i32") return "int32_t";
  if (name == "i64") return "int64_t";
  if (name == "u8") return "uint8_t";
  if (name == "u16") return "uint16_t";
  if (name == "u32") return "uint32_t";
  if (name == "u64") return "uint64_t";
  if (name == "isize") return "intptr_t";
  if (name == "usize") return "size_t";
  throw `native C emission does not support integer type ${name}`;
}

function nativeCIntegerType(in name: String): String throws String {
  if (name == "usize") return "uintptr_t";
  return try integerCType(name);
}

function isCReservedWord(in name: String): boolean {
  return name == "alignas"
    || name == "alignof"
    || name == "auto"
    || name == "bool"
    || name == "break"
    || name == "case"
    || name == "char"
    || name == "const"
    || name == "continue"
    || name == "default"
    || name == "do"
    || name == "double"
    || name == "else"
    || name == "enum"
    || name == "extern"
    || name == "false"
    || name == "float"
    || name == "for"
    || name == "goto"
    || name == "if"
    || name == "inline"
    || name == "int"
    || name == "long"
    || name == "register"
    || name == "restrict"
    || name == "return"
    || name == "short"
    || name == "signed"
    || name == "sizeof"
    || name == "static"
    || name == "static_assert"
    || name == "struct"
    || name == "switch"
    || name == "thread_local"
    || name == "true"
    || name == "typedef"
    || name == "union"
    || name == "unsigned"
    || name == "void"
    || name == "volatile"
    || name == "while"
    || name == "_Alignas"
    || name == "_Alignof"
    || name == "_Atomic"
    || name == "_Bool"
    || name == "_Complex"
    || name == "_Generic"
    || name == "_Imaginary"
    || name == "_Noreturn"
    || name == "_Static_assert"
    || name == "_Thread_local";
}

function appendCBindingName(
  inout output: TextBuffer,
  in name: String
): void {
  if (isCReservedWord(name)) output.append("z_");
  output.append(name);
}

function appendIndent(inout output: TextBuffer, depth: usize): void {
  let current: usize = 0;
  while (current < depth) {
    output.append("  ");
    current = current + 1;
  }
}

function appendCStringLiteral(
  inout output: TextBuffer,
  in value: String
): void {
  output.append("\"");
  let index: usize = 0;
  while (index < value.byteLength) {
    const byte = value.byteAt(index);
    if (byte == 34) output.append("\\\"");
    else if (byte == 92) output.append("\\\\");
    else if (byte == 10) output.append("\\n");
    else if (byte == 13) output.append("\\r");
    else if (byte == 9) output.append("\\t");
    else if (byte >= 32 && byte <= 126) output.appendAscii(byte);
    else {
      output.append("\\");
      output.appendAscii(48 + ((byte / 64) % 8));
      output.appendAscii(48 + ((byte / 8) % 8));
      output.appendAscii(48 + (byte % 8));
    }
    index = index + 1;
  }
  output.append("\"");
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
    appendCBindingName(inout output, cleanups[remaining].name);
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.localValue) {
    appendCBindingName(inout output, declaration.expressions[index].value);
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.integerValue
    || declaration.expressions[index].kind == LoweredExpressionKind.booleanValue
  ) {
    output.append(declaration.expressions[index].value);
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.parameterValue
  ) {
    output.append("(*");
    appendCBindingName(inout output, declaration.expressions[index].value);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.stringValue
  ) {
    output.append("Z_STRING_LITERAL(");
    appendCStringLiteral(inout output, declaration.expressions[index].value);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.templateValue
  ) {
    if (
      declaration.expressions[index].children.length
        != declaration.expressions[index].labels.length
    ) {
      throw "native C emission received a malformed template expression";
    }
    output.append("z_string_template((Z_TemplatePart[]){");
    let part: usize = 0;
    while (part < declaration.expressions[index].children.length) {
      if (part > 0) output.append(", ");
      output.append("{ .kind = ");
      if (
        declaration.expressions[index].labels[part] == "text"
        || declaration.expressions[index].labels[part] == "String"
      ) {
        output.append("Z_TEMPLATE_STRING, .value.string_value = ");
      } else if (
        declaration.expressions[index].labels[part] == "boolean"
      ) {
        output.append("Z_TEMPLATE_BOOLEAN, .value.boolean_value = ");
      } else if (declaration.expressions[index].labels[part] == "i32") {
        output.append("Z_TEMPLATE_I32, .value.i32_value = ");
      } else if (declaration.expressions[index].labels[part] == "u8") {
        output.append("Z_TEMPLATE_U8, .value.u8_value = ");
      } else if (declaration.expressions[index].labels[part] == "usize") {
        output.append("Z_TEMPLATE_USIZE, .value.usize_value = ");
      } else {
        throw "native C emission cannot format this template value type";
      }
      const value = declaration.expressions[index].children[part];
      try appendExpression(inout output, declaration, value);
      output.append(" }");
      part = part + 1;
    }
    output.append("}, ");
    output.append(`${declaration.expressions[index].children.length}`);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arrayEmpty
  ) {
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){ NULL, 0, 0 }");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arrayLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Array.length";
    }
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arrayIndex
    || declaration.expressions[index].kind
      == LoweredExpressionKind.arrayMutableIndex
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed Array index";
    }
    output.append("(*Z_");
    output.append(declaration.expressions[index].value);
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.arrayMutableIndex
    ) output.append("_at_mut(&(");
    else output.append("_at(&(");
    const receiver = declaration.expressions[index].children[0];
    const offset = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, receiver);
    output.append("), ");
    try appendExpression(inout output, declaration, offset);
    output.append("))");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arrayPush
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed Array.push";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_push(&(");
    const receiver = declaration.expressions[index].children[0];
    const value = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, receiver);
    output.append("), ");
    try appendExpression(inout output, declaration, value);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.mapEmpty
  ) {
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){ NULL, 0, 0, NULL, 0, 0 }");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.mapLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Map.length";
    }
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.mapHas
    || declaration.expressions[index].kind == LoweredExpressionKind.mapGet
    || declaration.expressions[index].kind == LoweredExpressionKind.mapSet
  ) {
    let expected: usize = 2;
    if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapSet
    ) expected = 3;
    if (declaration.expressions[index].children.length != expected) {
      throw "native C emission received a malformed Map method call";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapHas
    ) output.append("_has");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapGet
    ) output.append("_get");
    else output.append("_set");
    output.append("(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append("), ");
    const key = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, key);
    if (expected == 3) {
      output.append(", ");
      const value = declaration.expressions[index].children[2];
      try appendExpression(inout output, declaration, value);
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.setEmpty
  ) {
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){ NULL, 0, 0, NULL, 0, 0 }");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.setLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Set.length";
    }
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.setHas
    || declaration.expressions[index].kind == LoweredExpressionKind.setAdd
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed Set method call";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    if (
      declaration.expressions[index].kind == LoweredExpressionKind.setAdd
    ) output.append("_add");
    else output.append("_has");
    output.append("(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append("), ");
    const value = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, value);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.textBufferEmpty
  ) {
    output.append("(Z_String){ NULL, 0, 0 }");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.checkedAddInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedSubtractInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedMultiplyInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedDivideInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedRemainderInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedShiftLeftInteger
    || declaration.expressions[index].kind == LoweredExpressionKind.checkedShiftRightInteger
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed checked binary expression";
    }
    output.append("z_stage1_checked_");
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedAddInteger
    ) {
      output.append("add_");
    } else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedSubtractInteger
    ) {
      output.append("subtract_");
    } else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedMultiplyInteger
    ) output.append("multiply_");
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedDivideInteger
    ) output.append("divide_");
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedRemainderInteger
    ) output.append("remainder_");
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.checkedShiftLeftInteger
    ) output.append("shift_left_");
    else output.append("shift_right_");
    output.append(declaration.expressions[index].value);
    output.append("(");
    const left = declaration.expressions[index].children[0];
    const right = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, left);
    output.append(", ");
    try appendExpression(inout output, declaration, right);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.checkedNegateInteger
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed checked negate expression";
    }
    const operand = declaration.expressions[index].children[0];
    output.append("z_stage1_checked_negate_");
    output.append(declaration.expressions[index].value);
    output.append("(");
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.integerConversion
  ) {
    if (
      declaration.expressions[index].children.length != 1
      || declaration.expressions[index].labels.length != 1
    ) {
      throw "native C emission received a malformed integer conversion";
    }
    const source = declaration.expressions[index].labels[0].copyBytes(
      0,
      declaration.expressions[index].labels[0].byteLength
    );
    const target = declaration.expressions[index].value.copyBytes(
      0,
      declaration.expressions[index].value.byteLength
    );
    const argument = declaration.expressions[index].children[0];
    if (
      source == target
      || source == "u8"
      || (source == "u32" && target == "u64")
      || (source == "usize" && target == "u64")
    ) {
      const targetCType = try integerCType(target);
      output.append("((");
      output.append(targetCType);
      output.append(")(");
      try appendExpression(inout output, declaration, argument);
      output.append("))");
    } else {
      output.append("z_stage1_checked_convert_");
      output.append(source);
      output.append("_to_");
      output.append(target);
      output.append("(");
      try appendExpression(inout output, declaration, argument);
      output.append(")");
    }
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.wrappingAddInteger
    || declaration.expressions[index].kind
      == LoweredExpressionKind.wrappingSubtractInteger
    || declaration.expressions[index].kind
      == LoweredExpressionKind.wrappingMultiplyInteger
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received malformed wrapping arithmetic";
    }
    output.append("z_stage1_wrapping_");
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.wrappingAddInteger
    ) output.append("add_");
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.wrappingSubtractInteger
    ) output.append("subtract_");
    else output.append("multiply_");
    output.append(declaration.expressions[index].value);
    output.append("(");
    const left = declaration.expressions[index].children[0];
    const right = declaration.expressions[index].children[1];
    try appendExpression(
      inout output,
      declaration,
      left
    );
    output.append(", ");
    try appendExpression(
      inout output,
      declaration,
      right
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.fsLockUnlock
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed fs.Lock.unlock";
    }
    const moved = declaration.expressions[index].children[0];
    if (
      declaration.expressions[moved].kind != LoweredExpressionKind.moveValue
      || declaration.expressions[moved].children.length != 1
    ) {
      throw "native C emission received a non-consuming fs.Lock.unlock";
    }
    if (declaration.expressions[moved].value.byteLength > 0) {
      output.append("(");
      output.append(declaration.expressions[moved].value);
      output.append(" = false, ");
    }
    output.append("Z_FsLock_deinit(&(");
    const operand = declaration.expressions[moved].children[0];
    try appendExpression(inout output, declaration, operand);
    output.append("))");
    if (declaration.expressions[moved].value.byteLength > 0) {
      output.append(")");
    }
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.copyValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed copy expression";
    }
    output.append("z_string_copy(");
    const operand = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.viewProjection
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed view projection";
    }
    output.append("&(");
    const operand = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.borrowedTemporary
  ) {
    output.append(`_z_stage1_borrow_${index}`);
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
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.conditionalValue
  ) {
    if (declaration.expressions[index].children.length != 3) {
      throw "native C emission received a malformed conditional expression";
    }
    output.append("(");
    const condition = declaration.expressions[index].children[0];
    const thenValue = declaration.expressions[index].children[1];
    const elseValue = declaration.expressions[index].children[2];
    try appendExpression(inout output, declaration, condition);
    output.append(" ? ");
    try appendExpression(inout output, declaration, thenValue);
    output.append(" : ");
    try appendExpression(inout output, declaration, elseValue);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.stringEqual) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed String comparison";
    }
    if (declaration.expressions[index].value == "!=") output.append("!");
    output.append("z_string_equal(");
    const left = declaration.expressions[index].children[0];
    const right = declaration.expressions[index].children[1];
    try appendExpression(
      inout output,
      declaration,
      left
    );
    output.append(", ");
    try appendExpression(
      inout output,
      declaration,
      right
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.stringLength
    || declaration.expressions[index].kind == LoweredExpressionKind.stringIsEmpty
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed String property";
    }
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.stringIsEmpty
    ) output.append("(");
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append(").length");
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.stringIsEmpty
    ) output.append(" == 0)");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.stringByteAt
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed String.byteAt call";
    }
    output.append("z_string_byte_at(");
    const receiver = declaration.expressions[index].children[0];
    const position = declaration.expressions[index].children[1];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append(", ");
    try appendExpression(
      inout output,
      declaration,
      position
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.stringCopyBytes
  ) {
    if (declaration.expressions[index].children.length != 3) {
      throw "native C emission received a malformed String.copyBytes call";
    }
    output.append("z_string_copy_bytes(");
    let child: usize = 0;
    while (child < declaration.expressions[index].children.length) {
      if (child > 0) output.append(", ");
      const value = declaration.expressions[index].children[child];
      try appendExpression(
        inout output,
        declaration,
        value
      );
      child = child + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.textBufferAppend
    || declaration.expressions[index].kind
      == LoweredExpressionKind.textBufferAppendBytes
    || declaration.expressions[index].kind
      == LoweredExpressionKind.textBufferAppendAscii
  ) {
    let expected: usize = 2;
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.textBufferAppendBytes
    ) expected = 4;
    if (declaration.expressions[index].children.length != expected) {
      throw "native C emission received a malformed TextBuffer call";
    }
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.textBufferAppend
    ) output.append("z_text_buffer_append(&(");
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.textBufferAppendBytes
    ) output.append("z_text_buffer_append_bytes(&(");
    else output.append("z_text_buffer_append_ascii(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append(")");
    let child: usize = 1;
    while (child < declaration.expressions[index].children.length) {
      output.append(", ");
      const value = declaration.expressions[index].children[child];
      try appendExpression(inout output, declaration, value);
      child = child + 1;
    }
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.directCall) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received a malformed direct call";
    }
    const callee = declaration.expressions[index].children[0];
    if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.lock"
    ) output.append("z_stage1_fs_lock");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.readBytes"
    ) output.append("z_stage1_fs_read_bytes");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.readText"
    ) output.append("z_stage1_fs_read_text");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.writeText"
    ) output.append("z_stage1_fs_write_text");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.replace"
    ) output.append("z_stage1_fs_replace");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.exists"
    ) output.append("z_stage1_fs_exists");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.isDirectory"
    ) output.append("z_stage1_fs_is_directory");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.createDirectories"
    ) output.append("z_stage1_fs_create_directories");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "fs.realPath"
    ) output.append("z_stage1_fs_real_path");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "process.args"
    ) output.append("z_stage1_process_args");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value
        == "process.executablePath"
    ) output.append("z_stage1_process_executable_path");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "process.run"
    ) output.append("z_stage1_process_run");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "console.log"
    ) output.append("z_stage1_console_log");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "console.write"
    ) output.append("z_stage1_console_write");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "console.error"
    ) output.append("z_stage1_console_error");
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "console.debug"
    ) output.append("z_stage1_console_debug");
    else try appendExpression(inout output, declaration, callee);
    output.append("(");
    let argument: usize = 1;
    while (argument < declaration.expressions[index].children.length) {
      if (argument > 1) output.append(", ");
      const value = declaration.expressions[index].children[argument];
      if (
        declaration.expressions[index].labels.length >= argument
        && (
          declaration.expressions[index].labels[argument - 1] == "in"
          || declaration.expressions[index].labels[argument - 1] == "inout"
          || declaration.expressions[index].labels[argument - 1] == "out"
        )
      ) output.append("&(");
      try appendExpression(inout output, declaration, value);
      if (
        declaration.expressions[index].labels.length >= argument
        && (
          declaration.expressions[index].labels[argument - 1] == "in"
          || declaration.expressions[index].labels[argument - 1] == "inout"
          || declaration.expressions[index].labels[argument - 1] == "out"
        )
      ) output.append(")");
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
    if (
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view"
    ) {
      try appendExpression(inout output, declaration, receiver);
      output.append("->");
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
    declaration.expressions[index].kind
      == LoweredExpressionKind.foreignValue
  ) {
    output.append(declaration.expressions[index].value);
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

function containsBorrowedTemporary(
  in declaration: LoweredFunction,
  index: usize
): boolean {
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.borrowedTemporary
  ) return true;
  for (const child of declaration.expressions[index].children) {
    if (containsBorrowedTemporary(declaration, child)) return true;
  }
  return false;
}

function appendBorrowedTemporaryInitializers(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  for (const child of declaration.expressions[index].children) {
    try appendBorrowedTemporaryInitializers(
      inout output,
      declaration,
      child,
      depth
    );
  }
  if (
    declaration.expressions[index].kind
      != LoweredExpressionKind.borrowedTemporary
  ) return;
  if (
    declaration.expressions[index].value != "String"
    || declaration.expressions[index].children.length != 1
  ) {
    throw "native C emission received an unsupported borrowed temporary";
  }
  appendIndent(inout output, depth);
  output.append("Z_String ");
  output.append(`_z_stage1_borrow_${index}`);
  output.append(" = ");
  const initializer = declaration.expressions[index].children[0];
  try appendExpression(
    inout output,
    declaration,
    initializer
  );
  output.append(";\n");
}

function appendBorrowedTemporaryCleanups(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void {
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.borrowedTemporary
  ) {
    appendIndent(inout output, depth);
    output.append("Z_String_deinit(&");
    output.append(`_z_stage1_borrow_${index}`);
    output.append(");\n");
  }
  let child = declaration.expressions[index].children.length;
  while (child > 0) {
    child = child - 1;
    const childExpression = declaration.expressions[index].children[child];
    appendBorrowedTemporaryCleanups(
      inout output,
      declaration,
      childExpression,
      depth
    );
  }
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
    || declaration.expressions[index].kind == LoweredExpressionKind.binaryOperation
    || declaration.expressions[index].kind == LoweredExpressionKind.stringIsEmpty;
  if (!alreadyGrouped) output.append("(");
  try appendExpression(inout output, declaration, index);
  if (!alreadyGrouped) output.append(")");
}

function localNameIsUsed(
  in declaration: LoweredFunction,
  in name: String
): boolean {
  for (const expression of declaration.expressions) {
    if (
      expression.kind == LoweredExpressionKind.localValue
      && expression.value == name
    ) return true;
  }
  return false;
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
          && storageType.kind != LoweredTypeKind.enumType
          && storageType.kind != LoweredTypeKind.arrayType
          && storageType.kind != LoweredTypeKind.mapType
          && storageType.kind != LoweredTypeKind.setType
          && storageType.kind != LoweredTypeKind.stringType;
      }
      none => false;
    };
    const hasInitializer = match (in declaration.statements[index].expression) {
      some(_) => true;
      none => false;
    };
    const viewStorage = match (in declaration.statements[index].expression) {
      some(initializer) => declaration.expressions[initializer].kind
        == LoweredExpressionKind.viewProjection;
      none => false;
    };
    match (in declaration.statements[index].expression) {
      some(initializer) => try appendBorrowedTemporaryInitializers(
        inout output,
        declaration,
        initializer,
        depth
      );
      none => {}
    }
    appendIndent(inout output, depth);
    if (viewStorage) {
      output.append("const ");
      output.append(type);
      output.append(" * const ");
    } else if (
      !declaration.statements[index].mutableBinding
      && constStorage
      && hasInitializer
    ) {
      output.append("const ");
      output.append(type);
      output.append(" ");
    } else {
      output.append(type);
      output.append(" ");
    }
    appendCBindingName(inout output, declaration.statements[index].name);
    if (
      !localNameIsUsed(
        declaration,
        declaration.statements[index].name
      )
    ) output.append(" __attribute__((unused))");
    match (in declaration.statements[index].expression) {
      some(expression) => {
        output.append(" = ");
        try appendExpression(inout output, declaration, expression);
      }
      none => {}
    }
    output.append(";\n");
    match (in declaration.statements[index].expression) {
      some(initializer) => appendBorrowedTemporaryCleanups(
        inout output,
        declaration,
        initializer,
        depth
      );
      none => {}
    }
    if (declaration.statements[index].liveFlag.byteLength > 0) {
      appendIndent(inout output, depth);
      output.append("bool ");
      appendCBindingName(inout output, declaration.statements[index].liveFlag);
      output.append(" = true;\n");
    }
    for (const child of declaration.statements[index].children) {
      try appendStatement(inout output, declaration, child, depth);
    }
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.returnStatement) {
    let returnExpression = Option<usize>.none;
    match (in declaration.statements[index].expression) {
      some(expression) => {
        returnExpression = Option.some(expression);
        try appendBorrowedTemporaryInitializers(
          inout output,
          declaration,
          expression,
          depth
        );
      }
      none => {}
    }
    const borrowsTemporary = match (in returnExpression) {
      some(expression) => containsBorrowedTemporary(declaration, expression);
      none => false;
    };
    if (declaration.statements[index].cleanups.length > 0) {
      match (in declaration.statements[index].expression) {
        some(expression) => {
          appendIndent(inout output, depth);
          const returnType = try cType(declaration.returnType);
          output.append(returnType);
          output.append(` _z_stage1_return_${index} = `);
          try appendExpression(inout output, declaration, expression);
          output.append(";\n");
          appendBorrowedTemporaryCleanups(
            inout output,
            declaration,
            expression,
            depth
          );
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
    if (borrowsTemporary) {
      const expression = match (in returnExpression) {
        some(value) => value;
        none => throw "native C emission lost a borrowed return temporary";
      };
      appendIndent(inout output, depth);
      const returnType = try cType(declaration.returnType);
      output.append(returnType);
      output.append(` _z_stage1_return_${index} = `);
      try appendExpression(inout output, declaration, expression);
      output.append(";\n");
      appendBorrowedTemporaryCleanups(
        inout output,
        declaration,
        expression,
        depth
      );
      appendIndent(inout output, depth);
      output.append(`return _z_stage1_return_${index};\n`);
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
    match (in declaration.statements[index].secondExpression) {
      some(value) => try appendBorrowedTemporaryInitializers(
        inout output,
        declaration,
        value,
        depth
      );
      none => {}
    }
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
      match (in declaration.statements[index].secondExpression) {
        some(value) => appendBorrowedTemporaryCleanups(
          inout output,
          declaration,
          value,
          depth
        );
        none => {}
      }
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
    match (in declaration.statements[index].secondExpression) {
      some(value) => appendBorrowedTemporaryCleanups(
        inout output,
        declaration,
        value,
        depth
      );
      none => {}
    }
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.expressionStatement) {
    match (in declaration.statements[index].expression) {
      some(expression) => try appendBorrowedTemporaryInitializers(
        inout output,
        declaration,
        expression,
        depth
      );
      none => {}
    }
    appendIndent(inout output, depth);
    match (in declaration.statements[index].expression) {
      some(expression) => try appendExpression(inout output, declaration, expression);
      none => throw "native C emission received an empty expression statement";
    }
    output.append(";\n");
    match (in declaration.statements[index].expression) {
      some(expression) => appendBorrowedTemporaryCleanups(
        inout output,
        declaration,
        expression,
        depth
      );
      none => {}
    }
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.tryStatement) {
    if (
      declaration.statements[index].labels.length < 2
      || declaration.statements[index].labels.length > 3
    ) {
      throw "native C emission received a malformed try statement";
    }
    const temporary = `_z_stage1_try_${index}`;
    const propagated = `_z_stage1_failure_${index}`;
    match (in declaration.statements[index].expression) {
      some(expression) => try appendBorrowedTemporaryInitializers(
        inout output,
        declaration,
        expression,
        depth
      );
      none => {}
    }
    appendIndent(inout output, depth);
    output.append("Z_");
    output.append(declaration.statements[index].name);
    output.append(" ");
    output.append(temporary);
    output.append(" = ");
    match (in declaration.statements[index].expression) {
      some(expression) => try appendExpression(
        inout output,
        declaration,
        expression
      );
      none => throw "native C emission received a try statement without a call";
    }
    output.append(";\n");
    match (in declaration.statements[index].expression) {
      some(expression) => appendBorrowedTemporaryCleanups(
        inout output,
        declaration,
        expression,
        depth
      );
      none => {}
    }
    appendIndent(inout output, depth);
    output.append("if (");
    output.append(temporary);
    output.append(".tag == Z_");
    output.append(declaration.statements[index].name);
    output.append("Tag_failure) {\n");
    appendIndent(inout output, depth + 1);
    output.append("Z_");
    output.append(declaration.statements[index].labels[1]);
    output.append(" ");
    output.append(propagated);
    output.append(" = (Z_");
    output.append(declaration.statements[index].labels[1]);
    output.append("){.tag = Z_");
    output.append(declaration.statements[index].labels[1]);
    output.append("Tag_failure, .payload.failure = ");
    output.append(temporary);
    output.append(".payload.failure};\n");
    appendCleanups(
      inout output,
      declaration.statements[index].cleanups,
      depth + 1
    );
    appendIndent(inout output, depth + 1);
    output.append("return ");
    output.append(propagated);
    output.append(";\n");
    appendIndent(inout output, depth);
    output.append("}\n");
    if (declaration.statements[index].labels[0].byteLength > 0) {
      if (
        declaration.statements[index].labels.length == 3
        && declaration.statements[index].labels[2] == "replace"
      ) {
        let replacementName = "";
        match (in declaration.statements[index].type) {
          some(type) => replacementName = type.name.copyBytes(
            0,
            type.name.byteLength
          );
          none => {}
        }
        if (replacementName.byteLength == 0) {
          throw "native C emission lost an owned try replacement type";
        }
        appendIndent(inout output, depth);
        output.append("Z_");
        output.append(replacementName);
        output.append("_deinit(&");
        match (in declaration.statements[index].secondExpression) {
          some(target) => try appendExpression(
            inout output,
            declaration,
            target
          );
          none => output.append(declaration.statements[index].labels[0]);
        }
        output.append(");\n");
      }
      appendIndent(inout output, depth);
      match (in declaration.statements[index].secondExpression) {
        some(target) => try appendExpression(
          inout output,
          declaration,
          target
        );
        none => output.append(declaration.statements[index].labels[0]);
      }
      output.append(" = ");
      output.append(temporary);
      output.append(".payload.success;\n");
    }
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
          output.append(" __attribute__((unused))");
          output.append(" ");
          appendCBindingName(
            inout output,
            declaration.statements[arm].labels[0]
          );
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
    appendIndent(inout output, depth + 1);
    output.append("default:\n");
    appendIndent(inout output, depth + 2);
    output.append("abort();\n");
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
  if (declaration.statements[index].kind == LoweredStatementKind.forStatement) {
    if (
      declaration.statements[index].children.length != 1
      || declaration.statements[index].labels.length != 1
    ) {
      throw "native C emission received a malformed for statement";
    }
    const elementType = match (in declaration.statements[index].type) {
      some(type) => try cType(type);
      none => throw "native C emission received an untyped for binding";
    };
    const position = `_z_stage1_for_${index}`;
    appendIndent(inout output, depth);
    output.append("for (size_t ");
    output.append(position);
    output.append(" = 0; ");
    output.append(position);
    output.append(" < (");
    match (in declaration.statements[index].expression) {
      some(iterable) => try appendExpression(
        inout output,
        declaration,
        iterable
      );
      none => throw "native C emission received a for without an iterable";
    }
    output.append(").length; ");
    output.append(position);
    output.append(" += 1) {\n");
    appendIndent(inout output, depth + 1);
    output.append("const ");
    output.append(elementType);
    output.append(" ");
    appendCBindingName(inout output, declaration.statements[index].name);
    output.append(" = *Z_");
    output.append(declaration.statements[index].labels[0]);
    output.append("_at(&(");
    match (in declaration.statements[index].expression) {
      some(iterable) => try appendExpression(
        inout output,
        declaration,
        iterable
      );
      none => throw "native C emission received a for without an iterable";
    }
    output.append("), ");
    output.append(position);
    output.append(");\n");
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
  in declaration: LoweredFunction,
  processArguments: boolean
): void throws String {
  const returnType = try cType(declaration.returnType);
  if (declaration.nativeCExportName.byteLength > 0) output.append("static ");
  output.append(returnType);
  output.append(" ");
  appendCBindingName(inout output, declaration.name);
  output.append("(");
  if (
    declaration.name == "main"
    && declaration.parameters.length == 0
    && processArguments
  ) {
    output.append("int argc, char **argv");
    output.append(")");
    return;
  }
  let first = true;
  for (const parameter of declaration.parameters) {
    if (!first) output.append(", ");
    first = false;
    const parameterType = try cType(parameter.type);
    if (parameter.mode == LoweredParameterMode.input) output.append("const ");
    output.append(parameterType);
    if (parameter.mode != LoweredParameterMode.value) output.append(" *");
    else output.append(" ");
    appendCBindingName(inout output, parameter.name);
  }
  if (first) output.append("void");
  output.append(")");
}

function appendFunction(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  processArguments: boolean
): void throws String {
  try appendFunctionSignature(
    inout output,
    declaration,
    processArguments
  );
  output.append(" {\n");
  if (
    declaration.name == "main"
    && declaration.parameters.length == 0
    && processArguments
  ) {
    output.append("  z_stage1_process_argc = argc;\n");
    output.append("  z_stage1_process_argv = argv;\n");
  }
  for (const flag of declaration.liveFlags) {
    if (flag.parameter) {
      appendIndent(inout output, 1);
      output.append("bool ");
      appendCBindingName(inout output, flag.name);
      output.append(" = true;\n");
    }
  }
  for (const root of declaration.roots) {
    try appendStatement(inout output, declaration, root, 1);
  }
  match (in declaration.fallthroughExpression) {
    some(expression) => {
      appendCleanups(inout output, declaration.fallthroughCleanups, 1);
      appendIndent(inout output, 1);
      output.append("return ");
      try appendExpression(inout output, declaration, expression);
      output.append(";\n");
    }
    none => {}
  }
  if (declaration.returnType.kind == LoweredTypeKind.voidType) {
    appendCleanups(inout output, declaration.fallthroughCleanups, 1);
  }
  output.append("}\n\n");
}

function appendNativeCExportSignature(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  in name: String
): void throws String {
  const returnType = try nativeCExportType(program, declaration.returnType);
  output.append("Z_API ");
  output.append(returnType);
  output.append(" ");
  output.append(name);
  output.append("(");
  let first = true;
  for (const parameter of declaration.parameters) {
    if (!first) output.append(", ");
    first = false;
    const parameterType = try nativeCExportType(program, parameter.type);
    output.append(parameterType);
    output.append(" ");
    appendCBindingName(inout output, parameter.name);
  }
  if (first) output.append("void");
  output.append(")");
}

function appendNativeCExportDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction
): void throws String {
  try appendNativeCExportSignature(
    inout output,
    program,
    declaration,
    declaration.nativeCExportName
  );
  output.append(" {\n");
  for (const parameter of declaration.parameters) {
    if (parameter.type.kind != LoweredTypeKind.enumType) continue;
    match (loweredEnumIndex(program, parameter.type.name)) {
      some(index) => {
        if (program.enums[index].nativeCName.byteLength == 0) continue;
        output.append("  switch (");
        appendCBindingName(inout output, parameter.name);
        output.append(") {\n");
        for (const variant of program.enums[index].variants) {
          output.append("    case ");
          output.append(program.enums[index].nativeCName);
          output.append("_");
          output.append(variant.name);
          output.append(":\n      break;\n");
        }
        output.append("    default:\n      abort();\n  }\n");
      }
      none => {}
    }
  }
  output.append("  ");
  if (declaration.returnType.kind != LoweredTypeKind.voidType) {
    output.append("return ");
  }
  appendCBindingName(inout output, declaration.name);
  output.append("(");
  let first = true;
  for (const parameter of declaration.parameters) {
    if (!first) output.append(", ");
    first = false;
    appendCBindingName(inout output, parameter.name);
  }
  output.append(");\n}\n\n");
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
  if (
    type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.mapType
    || type.kind == LoweredTypeKind.setType
    || type.kind == LoweredTypeKind.stringType
    || type.kind == LoweredTypeKind.fsLockType
  ) return true;
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
  if (program.enums[index].nativeCName.byteLength > 0) {
    const underlying = try nativeCIntegerType(
      program.enums[index].nativeCUnderlyingType
    );
    output.append("typedef ");
    output.append(underlying);
    output.append(" ");
    output.append(program.enums[index].nativeCName);
    output.append(";\ntypedef ");
    output.append(program.enums[index].nativeCName);
    output.append(" Z_");
    output.append(program.enums[index].name);
    output.append(";\n");
    let nativeVariant: usize = 0;
    while (nativeVariant < program.enums[index].variants.length) {
      output.append("#define Z_");
      output.append(program.enums[index].name);
      output.append("_");
      output.append(program.enums[index].variants[nativeVariant].name);
      output.append(" ((Z_");
      output.append(program.enums[index].name);
      output.append(")");
      output.append(`${nativeVariant}`);
      output.append(")\n#define ");
      output.append(program.enums[index].nativeCName);
      output.append("_");
      output.append(program.enums[index].variants[nativeVariant].name);
      output.append(" ((");
      output.append(program.enums[index].nativeCName);
      output.append(")");
      output.append(`${nativeVariant}`);
      output.append(")\n");
      nativeVariant = nativeVariant + 1;
    }
    output.append("\n");
    enumStates[index] = 2;
    return;
  }
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
  const nativeCName = program.structs[index].nativeCName.copyBytes(
    0,
    program.structs[index].nativeCName.byteLength
  );
  if (nativeCName.byteLength > 0) {
    output.append("typedef struct ");
    output.append(nativeCName);
  } else {
    output.append("typedef struct Z_");
    output.append(program.structs[index].name);
  }
  output.append(" {\n");
  for (const field of program.structs[index].fields) {
    const fieldType = try cType(field.type);
    output.append("  ");
    output.append(fieldType);
    output.append(" ");
    output.append(field.name);
    output.append(";\n");
  }
  if (nativeCName.byteLength > 0) {
    output.append("} ");
    output.append(nativeCName);
    output.append(";\ntypedef ");
    output.append(nativeCName);
    output.append(" Z_");
    output.append(program.structs[index].name);
    output.append(";\n\n");
  } else {
    output.append("} Z_");
    output.append(program.structs[index].name);
    output.append(";\n\n");
  }
  structStates[index] = 2;
}

function appendTypeDefinitions(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.arrays) {
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" {\n");
    output.append("  void *data;\n");
    output.append("  size_t length;\n");
    output.append("  size_t capacity;\n");
    output.append("} Z_");
    output.append(declaration.name);
    output.append(";\n\n");
  }
  for (const declaration of program.maps) {
    if (
      declaration.keyType.kind == LoweredTypeKind.structType
      || declaration.keyType.kind == LoweredTypeKind.enumType
      || declaration.keyType.kind == LoweredTypeKind.arrayType
      || declaration.keyType.kind == LoweredTypeKind.mapType
      || declaration.valueType.kind == LoweredTypeKind.structType
      || declaration.valueType.kind == LoweredTypeKind.enumType
      || declaration.valueType.kind == LoweredTypeKind.arrayType
      || declaration.valueType.kind == LoweredTypeKind.mapType
      || declaration.valueType.kind == LoweredTypeKind.stringType
    ) {
      throw "native C emission only supports String-to-scalar Map storage in the first self-hosting tier";
    }
    if (declaration.keyType.kind != LoweredTypeKind.stringType) {
      throw "native C emission only supports String Map keys in the first self-hosting tier";
    }
    const keyType = try cType(declaration.keyType);
    const valueType = try cType(declaration.valueType);
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append("_Entry {\n  ");
    output.append(keyType);
    output.append(" key;\n  ");
    output.append(valueType);
    output.append(" value;\n} Z_");
    output.append(declaration.name);
    output.append("_Entry;\n\n");
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" {\n  Z_");
    output.append(declaration.name);
    output.append("_Entry *entries;\n");
    output.append("  size_t length;\n");
    output.append("  size_t capacity;\n");
    output.append("  size_t *buckets;\n");
    output.append("  size_t bucketCount;\n");
    output.append("  size_t tombstones;\n");
    output.append("} Z_");
    output.append(declaration.name);
    output.append(";\n\n");
  }
  for (const declaration of program.sets) {
    if (declaration.elementType.kind != LoweredTypeKind.stringType) {
      throw "native C emission only supports String Set elements in the first self-hosting tier";
    }
    const elementType = try cType(declaration.elementType);
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" {\n  ");
    output.append(elementType);
    output.append(" *values;\n");
    output.append("  size_t length;\n");
    output.append("  size_t capacity;\n");
    output.append("  size_t *buckets;\n");
    output.append("  size_t bucketCount;\n");
    output.append("  size_t tombstones;\n");
    output.append("} Z_");
    output.append(declaration.name);
    output.append(";\n\n");
  }
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

function loweredIntrinsicIdentity(in type: LoweredType): String throws String {
  if (type.kind == LoweredTypeKind.booleanType) return "boolean";
  if (type.kind == LoweredTypeKind.i8Type) return "i8";
  if (type.kind == LoweredTypeKind.i16Type) return "i16";
  if (type.kind == LoweredTypeKind.i32Type) return "i32";
  if (type.kind == LoweredTypeKind.i64Type) return "i64";
  if (type.kind == LoweredTypeKind.u8Type) return "u8";
  if (type.kind == LoweredTypeKind.u16Type) return "u16";
  if (type.kind == LoweredTypeKind.u32Type) return "u32";
  if (type.kind == LoweredTypeKind.u64Type) return "u64";
  if (type.kind == LoweredTypeKind.isizeType) return "isize";
  if (type.kind == LoweredTypeKind.usizeType) return "usize";
  if (type.kind == LoweredTypeKind.f32Type) return "f32";
  if (type.kind == LoweredTypeKind.f64Type) return "f64";
  throw "native C emission cannot form an intrinsic identity for this type";
}

function appendMapRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.maps) {
    const valueType = try cType(declaration.valueType);
    const valueIdentity = try loweredIntrinsicIdentity(declaration.valueType);
    const optionName = `__z_Option_${valueIdentity}`;
    output.append("static inline __attribute__((unused)) size_t Z_");
    output.append(declaration.name);
    output.append("_hash(Z_String value) {\n");
    output.append("  uint64_t hash = UINT64_C(14695981039346656037);\n");
    output.append("  for (size_t index = 0; index < value.length; index += 1) {\n");
    output.append("    hash ^= (unsigned char)value.data[index];\n");
    output.append("    hash *= UINT64_C(1099511628211);\n");
    output.append("  }\n");
    output.append("  return (size_t)hash;\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_rehash(Z_");
    output.append(declaration.name);
    output.append(" *self, size_t capacity) {\n");
    output.append("  if (capacity < 8) capacity = 8;\n");
    output.append("  if (capacity > SIZE_MAX / sizeof(size_t)) abort();\n");
    output.append("  size_t *buckets = (size_t *)calloc(capacity, sizeof(size_t));\n");
    output.append("  if (buckets == NULL) abort();\n");
    output.append("  for (size_t index = 0; index < self->length; index += 1) {\n");
    output.append("    size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(self->entries[index].key) & (capacity - 1);\n");
    output.append("    while (buckets[slot] != 0) slot = (slot + 1) & (capacity - 1);\n");
    output.append("    buckets[slot] = index + 1;\n");
    output.append("  }\n");
    output.append("  free(self->buckets);\n");
    output.append("  self->buckets = buckets;\n");
    output.append("  self->bucketCount = capacity;\n");
    output.append("  self->tombstones = 0;\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_ensure_capacity(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  if (self->bucketCount == 0) {\n    Z_");
    output.append(declaration.name);
    output.append("_rehash(self, 8);\n    return;\n  }\n");
    output.append("  if (self->length + self->tombstones < self->bucketCount - self->bucketCount / 4) return;\n");
    output.append("  if (self->bucketCount > SIZE_MAX / 2) abort();\n");
    output.append("  Z_");
    output.append(declaration.name);
    output.append("_rehash(self, self->bucketCount * 2);\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_has(const Z_");
    output.append(declaration.name);
    output.append(" *self, Z_String key) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && z_string_equal(self->entries[stored - 1].key, key)) return true;\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return false;\n}\n\n");
    output.append("static inline __attribute__((unused)) Z_");
    output.append(optionName);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_get(const Z_");
    output.append(declaration.name);
    output.append(" *self, Z_String key) {\n");
    output.append("  if (self->bucketCount == 0) return (Z_");
    output.append(optionName);
    output.append("){ .tag = Z_");
    output.append(optionName);
    output.append("Tag_none };\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return (Z_");
    output.append(optionName);
    output.append("){ .tag = Z_");
    output.append(optionName);
    output.append("Tag_none };\n");
    output.append("    if (stored != SIZE_MAX && z_string_equal(self->entries[stored - 1].key, key)) return (Z_");
    output.append(optionName);
    output.append("){ .tag = Z_");
    output.append(optionName);
    output.append("Tag_some, .payload.some = self->entries[stored - 1].value };\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return (Z_");
    output.append(optionName);
    output.append("){ .tag = Z_");
    output.append(optionName);
    output.append("Tag_none };\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_set(Z_");
    output.append(declaration.name);
    output.append(" *self, Z_String key, ");
    output.append(valueType);
    output.append(" value) {\n");
    output.append("  Z_");
    output.append(declaration.name);
    output.append("_ensure_capacity(self);\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  size_t available = SIZE_MAX;\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) break;\n");
    output.append("    if (stored == SIZE_MAX) {\n");
    output.append("      if (available == SIZE_MAX) available = slot;\n");
    output.append("    } else if (z_string_equal(self->entries[stored - 1].key, key)) {\n");
    output.append("      Z_String_deinit(&key);\n");
    output.append("      self->entries[stored - 1].value = value;\n");
    output.append("      return;\n    }\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n");
    output.append("  if (available != SIZE_MAX) {\n");
    output.append("    slot = available;\n");
    output.append("    self->tombstones -= 1;\n");
    output.append("  }\n");
    output.append("  if (self->length == self->capacity) {\n");
    output.append("    size_t next = self->capacity == 0 ? 8 : self->capacity;\n");
    output.append("    if (self->capacity != 0) {\n");
    output.append("      if (next > SIZE_MAX / 2) abort();\n");
    output.append("      next *= 2;\n");
    output.append("    }\n");
    output.append("    if (next > SIZE_MAX / sizeof(Z_");
    output.append(declaration.name);
    output.append("_Entry)) abort();\n");
    output.append("    void *storage = realloc(self->entries, next * sizeof(Z_");
    output.append(declaration.name);
    output.append("_Entry));\n");
    output.append("    if (storage == NULL) abort();\n");
    output.append("    self->entries = (Z_");
    output.append(declaration.name);
    output.append("_Entry *)storage;\n");
    output.append("    self->capacity = next;\n");
    output.append("  }\n");
    output.append("  self->entries[self->length] = (Z_");
    output.append(declaration.name);
    output.append("_Entry){ .key = key, .value = value };\n");
    output.append("  self->length += 1;\n");
    output.append("  self->buckets[slot] = self->length;\n");
    output.append("}\n\n");
  }
}

function appendSetRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void {
  for (const declaration of program.sets) {
    output.append("static inline __attribute__((unused)) size_t Z_");
    output.append(declaration.name);
    output.append("_hash(Z_String value) {\n");
    output.append("  uint64_t hash = UINT64_C(14695981039346656037);\n");
    output.append("  for (size_t index = 0; index < value.length; index += 1) {\n");
    output.append("    hash ^= (unsigned char)value.data[index];\n");
    output.append("    hash *= UINT64_C(1099511628211);\n");
    output.append("  }\n  return (size_t)hash;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_rehash(Z_");
    output.append(declaration.name);
    output.append(" *self, size_t capacity) {\n");
    output.append("  if (capacity < 8) capacity = 8;\n");
    output.append("  if (capacity > SIZE_MAX / sizeof(size_t)) abort();\n");
    output.append("  size_t *buckets = (size_t *)calloc(capacity, sizeof(size_t));\n");
    output.append("  if (buckets == NULL) abort();\n");
    output.append("  for (size_t index = 0; index < self->length; index += 1) {\n");
    output.append("    size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(self->values[index]) & (capacity - 1);\n");
    output.append("    while (buckets[slot] != 0) slot = (slot + 1) & (capacity - 1);\n");
    output.append("    buckets[slot] = index + 1;\n");
    output.append("  }\n");
    output.append("  free(self->buckets);\n");
    output.append("  self->buckets = buckets;\n");
    output.append("  self->bucketCount = capacity;\n");
    output.append("  self->tombstones = 0;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_ensure_capacity(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  if (self->bucketCount == 0) {\n    Z_");
    output.append(declaration.name);
    output.append("_rehash(self, 8);\n    return;\n  }\n");
    output.append("  if (self->length + self->tombstones < self->bucketCount - self->bucketCount / 4) return;\n");
    output.append("  if (self->bucketCount > SIZE_MAX / 2) abort();\n");
    output.append("  Z_");
    output.append(declaration.name);
    output.append("_rehash(self, self->bucketCount * 2);\n}\n\n");
    output.append("static inline __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_has(const Z_");
    output.append(declaration.name);
    output.append(" *self, Z_String value) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(value) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && z_string_equal(self->values[stored - 1], value)) return true;\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return false;\n}\n\n");
    output.append("static __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_add(Z_");
    output.append(declaration.name);
    output.append(" *self, Z_String value) {\n");
    output.append("  Z_");
    output.append(declaration.name);
    output.append("_ensure_capacity(self);\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(value) & (self->bucketCount - 1);\n");
    output.append("  size_t available = SIZE_MAX;\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) break;\n");
    output.append("    if (stored == SIZE_MAX) {\n");
    output.append("      if (available == SIZE_MAX) available = slot;\n");
    output.append("    } else if (z_string_equal(self->values[stored - 1], value)) {\n");
    output.append("      Z_String_deinit(&value);\n");
    output.append("      return false;\n    }\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n");
    output.append("  if (available != SIZE_MAX) {\n");
    output.append("    slot = available;\n");
    output.append("    self->tombstones -= 1;\n  }\n");
    output.append("  if (self->length == self->capacity) {\n");
    output.append("    size_t next = self->capacity == 0 ? 8 : self->capacity;\n");
    output.append("    if (self->capacity != 0) {\n");
    output.append("      if (next > SIZE_MAX / 2) abort();\n");
    output.append("      next *= 2;\n    }\n");
    output.append("    if (next > SIZE_MAX / sizeof(Z_String)) abort();\n");
    output.append("    void *storage = realloc(self->values, next * sizeof(Z_String));\n");
    output.append("    if (storage == NULL) abort();\n");
    output.append("    self->values = (Z_String *)storage;\n");
    output.append("    self->capacity = next;\n  }\n");
    output.append("  self->values[self->length] = value;\n");
    output.append("  self->length += 1;\n");
    output.append("  self->buckets[slot] = self->length;\n");
    output.append("  return true;\n}\n\n");
  }
}

function programUsesStandardCall(
  in program: LoweredProgram,
  in name: String
): boolean {
  for (const declaration of program.functions) {
    for (const expression of declaration.expressions) {
      if (
        expression.kind == LoweredExpressionKind.localValue
        && expression.value == name
      ) return true;
    }
  }
  return false;
}

function appendSystemStandardRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void {
  const usesLock = programUsesStandardCall(program, "fs.lock");
  const usesReadBytes = programUsesStandardCall(program, "fs.readBytes");
  const usesReadText = programUsesStandardCall(program, "fs.readText");
  const usesWriteText = programUsesStandardCall(program, "fs.writeText");
  const usesReplace = programUsesStandardCall(program, "fs.replace");
  const usesExists = programUsesStandardCall(program, "fs.exists");
  const usesIsDirectory = programUsesStandardCall(program, "fs.isDirectory");
  const usesCreateDirectories = programUsesStandardCall(
    program,
    "fs.createDirectories"
  );
  const usesRealPath = programUsesStandardCall(program, "fs.realPath");
  const usesProcessArgs = programUsesStandardCall(program, "process.args");
  const usesProcessExecutablePath = programUsesStandardCall(
    program,
    "process.executablePath"
  );
  const usesProcessRun = programUsesStandardCall(program, "process.run");
  const usesConsoleLog = programUsesStandardCall(program, "console.log");
  const usesConsoleWrite = programUsesStandardCall(program, "console.write");
  const usesConsoleError = programUsesStandardCall(program, "console.error");
  const usesConsoleDebug = programUsesStandardCall(program, "console.debug");
  if (
    usesLock
    || usesReadBytes
    || usesReadText
    || usesWriteText
    || usesReplace
    || usesExists
    || usesIsDirectory
    || usesCreateDirectories
    || usesRealPath
    || usesProcessArgs
    || usesProcessExecutablePath
    || usesProcessRun
  ) {
    output.append("static __attribute__((unused)) bool z_stage1_string_is_valid_utf8(const char *data, size_t length) {\n");
    output.append("  size_t index = 0;\n");
    output.append("  while (index < length) {\n");
    output.append("    const uint8_t first = (uint8_t)data[index];\n");
    output.append("    if (first <= 0x7Fu) { index += 1; continue; }\n");
    output.append("    if (first >= 0xC2u && first <= 0xDFu) {\n");
    output.append("      if (index + 1 >= length || ((uint8_t)data[index + 1] & 0xC0u) != 0x80u) return false;\n");
    output.append("      index += 2; continue;\n");
    output.append("    }\n");
    output.append("    if (first >= 0xE0u && first <= 0xEFu) {\n");
    output.append("      if (index + 2 >= length) return false;\n");
    output.append("      const uint8_t second = (uint8_t)data[index + 1];\n");
    output.append("      const uint8_t third = (uint8_t)data[index + 2];\n");
    output.append("      if ((third & 0xC0u) != 0x80u) return false;\n");
    output.append("      if (first == 0xE0u ? second < 0xA0u || second > 0xBFu : first == 0xEDu ? second < 0x80u || second > 0x9Fu : (second & 0xC0u) != 0x80u) return false;\n");
    output.append("      index += 3; continue;\n");
    output.append("    }\n");
    output.append("    if (first >= 0xF0u && first <= 0xF4u) {\n");
    output.append("      if (index + 3 >= length) return false;\n");
    output.append("      const uint8_t second = (uint8_t)data[index + 1];\n");
    output.append("      const uint8_t third = (uint8_t)data[index + 2];\n");
    output.append("      const uint8_t fourth = (uint8_t)data[index + 3];\n");
    output.append("      if ((third & 0xC0u) != 0x80u || (fourth & 0xC0u) != 0x80u) return false;\n");
    output.append("      if (first == 0xF0u ? second < 0x90u || second > 0xBFu : first == 0xF4u ? second < 0x80u || second > 0x8Fu : (second & 0xC0u) != 0x80u) return false;\n");
    output.append("      index += 4; continue;\n");
    output.append("    }\n");
    output.append("    return false;\n");
    output.append("  }\n");
    output.append("  return true;\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) Z_String z_stage1_string_from_cstring(const char *value) {\n");
    output.append("  if (value == NULL) abort();\n");
    output.append("  if (!z_stage1_string_is_valid_utf8(value, strlen(value))) abort();\n");
    output.append("  Z_String result = { NULL, 0, 0 };\n");
    output.append("  z_string_append_bytes(&result, value, strlen(value));\n");
    output.append("  return result;\n");
    output.append("}\n\n");
  }
  if (usesLock) {
    output.append("static __attribute__((unused)) void Z_FsLock_deinit(Z_FsLock *lock) {\n");
    output.append("  if (lock == NULL) return;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  HANDLE handle = (HANDLE)lock->native;\n");
    output.append("  if (handle == NULL || handle == INVALID_HANDLE_VALUE) return;\n");
    output.append("  OVERLAPPED range = {0};\n");
    output.append("  (void)UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &range);\n");
    output.append("  (void)CloseHandle(handle);\n");
    output.append("  lock->native = 0;\n");
    output.append("#else\n");
    output.append("  const int descriptor = (int)lock->native;\n");
    output.append("  if (descriptor < 0) return;\n");
    output.append("  while (flock(descriptor, LOCK_UN) != 0 && errno == EINTR) {}\n");
    output.append("  (void)close(descriptor);\n");
    output.append("  lock->native = -1;\n");
    output.append("#endif\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) Z___z_Result_FsLock_String z_stage1_fs_lock(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  const char *native_path = path->data != NULL ? path->data : \"\";\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  HANDLE handle = CreateFileA(native_path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);\n");
    output.append("  if (handle == INVALID_HANDLE_VALUE) return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not open filesystem lock\") };\n");
    output.append("  OVERLAPPED range = {0};\n");
    output.append("  if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &range)) {\n");
    output.append("    (void)CloseHandle(handle);\n");
    output.append("    return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not acquire filesystem lock\") };\n");
    output.append("  }\n");
    output.append("  return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_success, .payload.success = (Z_FsLock){ .native = (intptr_t)handle } };\n");
    output.append("#else\n");
    output.append("  const int descriptor = open(native_path, O_CREAT | O_RDWR, 0666);\n");
    output.append("  if (descriptor < 0) return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  int status;\n");
    output.append("  do { status = flock(descriptor, LOCK_EX); } while (status != 0 && errno == EINTR);\n");
    output.append("  if (status != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    (void)close(descriptor);\n");
    output.append("    return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  return (Z___z_Result_FsLock_String){ .tag = Z___z_Result_FsLock_StringTag_success, .payload.success = (Z_FsLock){ .native = (intptr_t)descriptor } };\n");
    output.append("#endif\n");
    output.append("}\n\n");
  }
  if (usesReadBytes) {
    output.append("static __attribute__((unused)) Z___z_Result___z_Array_u8_String z_stage1_fs_read_bytes(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  const char *native_path = path->data != NULL ? path->data : \"\";\n");
    output.append("  FILE *file = fopen(native_path, \"rb\");\n");
    output.append("  if (file == NULL) return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  if (fseek(file, 0, SEEK_END) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    fclose(file);\n");
    output.append("    return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  const long measured = ftell(file);\n");
    output.append("  if (measured < 0 || fseek(file, 0, SEEK_SET) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    fclose(file);\n");
    output.append("    return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  Z___z_Array_u8 contents = { NULL, 0, 0 };\n");
    output.append("  if (measured > 0) {\n");
    output.append("    contents.data = malloc((size_t)measured);\n");
    output.append("    if (contents.data == NULL) abort();\n");
    output.append("    contents.length = (size_t)measured;\n");
    output.append("    contents.capacity = contents.length;\n");
    output.append("    if (fread(contents.data, 1, (size_t)measured, file) != (size_t)measured) {\n");
    output.append("      const int code = ferror(file) ? errno : EIO;\n");
    output.append("      fclose(file);\n");
    output.append("      free(contents.data);\n");
    output.append("      return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("    }\n");
    output.append("  }\n");
    output.append("  if (fclose(file) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    free(contents.data);\n");
    output.append("    return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  return (Z___z_Result___z_Array_u8_String){ .tag = Z___z_Result___z_Array_u8_StringTag_success, .payload.success = contents };\n");
    output.append("}\n\n");
  }
  if (usesReadText) {
    output.append("static __attribute__((unused)) Z___z_Result_String_String z_stage1_fs_read_text(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  const char *native_path = path->data != NULL ? path->data : \"\";\n");
    output.append("  FILE *file = fopen(native_path, \"rb\");\n");
    output.append("  if (file == NULL) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  if (fseek(file, 0, SEEK_END) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    fclose(file);\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  const long measured = ftell(file);\n");
    output.append("  if (measured < 0 || fseek(file, 0, SEEK_SET) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    fclose(file);\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  Z_String contents = { NULL, 0, 0 };\n");
    output.append("  if (measured > 0) {\n");
    output.append("    z_string_reserve(&contents, (size_t)measured);\n");
    output.append("    const size_t count = fread((void *)contents.data, 1, (size_t)measured, file);\n");
    output.append("    if (count != (size_t)measured) {\n");
    output.append("      const int code = ferror(file) ? errno : EIO;\n");
    output.append("      fclose(file);\n");
    output.append("      Z_String_deinit(&contents);\n");
    output.append("      return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("    }\n");
    output.append("    contents.length = count;\n");
    output.append("    ((char *)contents.data)[contents.length] = '\\0';\n");
    output.append("  }\n");
    output.append("  if (fclose(file) != 0) {\n");
    output.append("    const int code = errno;\n");
    output.append("    Z_String_deinit(&contents);\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  if (!z_stage1_string_is_valid_utf8(contents.data != NULL ? contents.data : \"\", contents.length)) {\n");
    output.append("    Z_String_deinit(&contents);\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"file is not valid UTF-8\") };\n");
    output.append("  }\n");
    output.append("  return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_success, .payload.success = contents };\n");
    output.append("}\n\n");
  }
  if (usesWriteText) {
    output.append("static __attribute__((unused)) Z___z_Result_void_String z_stage1_fs_write_text(const Z_String *path, const Z_String *contents) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  const char *native_path = path->data != NULL ? path->data : \"\";\n");
    output.append("  FILE *file = fopen(native_path, \"wb\");\n");
    output.append("  if (file == NULL) return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  const char *data = contents != NULL && contents->data != NULL ? contents->data : \"\";\n");
    output.append("  const size_t length = contents != NULL ? contents->length : 0;\n");
    output.append("  if (length > 0 && fwrite(data, 1, length, file) != length) {\n");
    output.append("    const int code = errno;\n");
    output.append("    fclose(file);\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  if (fclose(file) != 0) return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_success };\n");
    output.append("}\n\n");
  }
  if (usesReplace) {
    output.append("static __attribute__((unused)) Z___z_Result_void_String z_stage1_fs_replace(const Z_String *source, const Z_String *destination) {\n");
    output.append("  if (source == NULL || (source->length > 0 && memchr(source->data, '\\0', source->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"source path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  if (destination == NULL || (destination->length > 0 && memchr(destination->data, '\\0', destination->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"destination path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  const char *native_source = source->data != NULL ? source->data : \"\";\n");
    output.append("  const char *native_destination = destination->data != NULL ? destination->data : \"\";\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  if (!MoveFileExA(native_source, native_destination, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not atomically replace filesystem path\") };\n");
    output.append("  }\n");
    output.append("#else\n");
    output.append("  if (rename(native_source, native_destination) != 0) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  }\n");
    output.append("#endif\n");
    output.append("  return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_success };\n");
    output.append("}\n\n");
  }
  if (usesExists) {
    output.append("static __attribute__((unused)) bool z_stage1_fs_exists(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) return false;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  return _access(path->data != NULL ? path->data : \"\", 0) == 0;\n");
    output.append("#else\n");
    output.append("  return access(path->data != NULL ? path->data : \"\", F_OK) == 0;\n");
    output.append("#endif\n");
    output.append("}\n\n");
  }
  if (usesIsDirectory) {
    output.append("static __attribute__((unused)) bool z_stage1_fs_is_directory(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) return false;\n");
    output.append("  struct stat status;\n");
    output.append("  if (stat(path->data != NULL ? path->data : \"\", &status) != 0) return false;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  return (status.st_mode & _S_IFDIR) != 0;\n");
    output.append("#else\n");
    output.append("  return S_ISDIR(status.st_mode);\n");
    output.append("#endif\n");
    output.append("}\n\n");
  }
  if (usesCreateDirectories) {
    output.append("static __attribute__((unused)) bool z_stage1_fs_is_path_separator(char value) {\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  return value == '/' || value == '\\\\';\n");
    output.append("#else\n");
    output.append("  return value == '/';\n");
    output.append("#endif\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) int z_stage1_fs_create_one_directory(const char *path) {\n");
    output.append("  if (path == NULL || path[0] == '\\0') return 0;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  if (_mkdir(path) == 0) return 0;\n");
    output.append("#else\n");
    output.append("  if (mkdir(path, 0777) == 0) return 0;\n");
    output.append("#endif\n");
    output.append("  const int code = errno;\n");
    output.append("  if (code != EEXIST) return code;\n");
    output.append("  struct stat status;\n");
    output.append("  if (stat(path, &status) != 0) return errno;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  return (status.st_mode & _S_IFDIR) != 0 ? 0 : ENOTDIR;\n");
    output.append("#else\n");
    output.append("  return S_ISDIR(status.st_mode) ? 0 : ENOTDIR;\n");
    output.append("#endif\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) Z___z_Result_void_String z_stage1_fs_create_directories(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  if (path->length == 0) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"directory path cannot be empty\") };\n");
    output.append("  }\n");
    output.append("  char *buffer = malloc(path->length + 1);\n");
    output.append("  if (buffer == NULL) abort();\n");
    output.append("  memcpy(buffer, path->data, path->length);\n");
    output.append("  buffer[path->length] = '\\0';\n");
    output.append("  size_t start = 0;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  if (path->length >= 2 && buffer[1] == ':') {\n");
    output.append("    start = path->length >= 3 && z_stage1_fs_is_path_separator(buffer[2]) ? 3 : 2;\n");
    output.append("  } else if (path->length >= 2 && z_stage1_fs_is_path_separator(buffer[0]) && z_stage1_fs_is_path_separator(buffer[1])) {\n");
    output.append("    size_t cursor = 2;\n");
    output.append("    while (cursor < path->length && !z_stage1_fs_is_path_separator(buffer[cursor])) cursor += 1;\n");
    output.append("    while (cursor < path->length && z_stage1_fs_is_path_separator(buffer[cursor])) cursor += 1;\n");
    output.append("    while (cursor < path->length && !z_stage1_fs_is_path_separator(buffer[cursor])) cursor += 1;\n");
    output.append("    start = cursor < path->length ? cursor + 1 : cursor;\n");
    output.append("  }\n");
    output.append("#else\n");
    output.append("  if (z_stage1_fs_is_path_separator(buffer[0])) start = 1;\n");
    output.append("#endif\n");
    output.append("  int code = 0;\n");
    output.append("  for (size_t index = start; index < path->length; index += 1) {\n");
    output.append("    if (!z_stage1_fs_is_path_separator(buffer[index])) continue;\n");
    output.append("    const char separator = buffer[index];\n");
    output.append("    buffer[index] = '\\0';\n");
    output.append("    code = z_stage1_fs_create_one_directory(buffer);\n");
    output.append("    buffer[index] = separator;\n");
    output.append("    if (code != 0) break;\n");
    output.append("    while (index + 1 < path->length && z_stage1_fs_is_path_separator(buffer[index + 1])) index += 1;\n");
    output.append("  }\n");
    output.append("  if (code == 0) code = z_stage1_fs_create_one_directory(buffer);\n");
    output.append("  free(buffer);\n");
    output.append("  if (code != 0) {\n");
    output.append("    return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  return (Z___z_Result_void_String){ .tag = Z___z_Result_void_StringTag_success };\n");
    output.append("}\n\n");
  }
  if (usesRealPath) {
    output.append("static __attribute__((unused)) Z___z_Result_String_String z_stage1_fs_real_path(const Z_String *path) {\n");
    output.append("  if (path == NULL || (path->length > 0 && memchr(path->data, '\\0', path->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"path contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  char *resolved = _fullpath(NULL, path->data != NULL ? path->data : \"\", 0);\n");
    output.append("#else\n");
    output.append("  char *resolved = realpath(path->data != NULL ? path->data : \"\", NULL);\n");
    output.append("#endif\n");
    output.append("  if (resolved == NULL) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  const size_t length = strlen(resolved);\n");
    output.append("  if (!z_stage1_string_is_valid_utf8(resolved, length)) {\n");
    output.append("    free(resolved);\n");
    output.append("    return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"canonical path is not valid UTF-8\") };\n");
    output.append("  }\n");
    output.append("  Z_String result = z_stage1_string_from_cstring(resolved);\n");
    output.append("  free(resolved);\n");
    output.append("  return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_success, .payload.success = result };\n");
    output.append("}\n\n");
  }
  if (usesProcessArgs) {
    output.append("static __attribute__((unused)) Z___z_Array_String z_stage1_process_args(void) {\n");
    output.append("  Z___z_Array_String result = { NULL, 0, 0 };\n");
    output.append("  if (z_stage1_process_argc <= 1 || z_stage1_process_argv == NULL) return result;\n");
    output.append("  result.length = (size_t)(z_stage1_process_argc - 1);\n");
    output.append("  result.capacity = result.length;\n");
    output.append("  result.data = calloc(result.capacity, sizeof(Z_String));\n");
    output.append("  if (result.data == NULL) abort();\n");
    output.append("  Z_String *items = (Z_String *)result.data;\n");
    output.append("  for (size_t index = 0; index < result.length; index += 1) items[index] = z_stage1_string_from_cstring(z_stage1_process_argv[index + 1]);\n");
    output.append("  return result;\n");
    output.append("}\n\n");
  }
  if (usesProcessExecutablePath) {
    output.append("static __attribute__((unused)) Z___z_Result_String_String z_stage1_process_executable_path(void) {\n");
    output.append("  char *resolved = NULL;\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  DWORD capacity = 256;\n");
    output.append("  wchar_t *wide = NULL;\n");
    output.append("  DWORD length = 0;\n");
    output.append("  for (;;) {\n");
    output.append("    wide = malloc((size_t)capacity * sizeof(wchar_t));\n");
    output.append("    if (wide == NULL) abort();\n");
    output.append("    length = GetModuleFileNameW(NULL, wide, capacity);\n");
    output.append("    if (length == 0) { free(wide); return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not locate the current executable\") }; }\n");
    output.append("    if (length < capacity) break;\n");
    output.append("    free(wide); wide = NULL;\n");
    output.append("    if (capacity > UINT32_MAX / 2) abort();\n");
    output.append("    capacity *= 2;\n");
    output.append("  }\n");
    output.append("  const int utf8_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, NULL, 0, NULL, NULL);\n");
    output.append("  if (utf8_length <= 0) { free(wide); return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"the current executable path is not valid UTF-8\") }; }\n");
    output.append("  resolved = malloc((size_t)utf8_length + 1);\n");
    output.append("  if (resolved == NULL) abort();\n");
    output.append("  (void)WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide, (int)length, resolved, utf8_length, NULL, NULL);\n");
    output.append("  resolved[utf8_length] = '\\0';\n");
    output.append("  free(wide);\n");
    output.append("#elif defined(__APPLE__)\n");
    output.append("  uint32_t capacity = 0;\n");
    output.append("  (void)_NSGetExecutablePath(NULL, &capacity);\n");
    output.append("  if (capacity == 0) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not locate the current executable\") };\n");
    output.append("  char *candidate = malloc((size_t)capacity);\n");
    output.append("  if (candidate == NULL) abort();\n");
    output.append("  if (_NSGetExecutablePath(candidate, &capacity) != 0) { free(candidate); return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not locate the current executable\") }; }\n");
    output.append("  resolved = realpath(candidate, NULL);\n");
    output.append("  free(candidate);\n");
    output.append("  if (resolved == NULL) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("#elif defined(__linux__)\n");
    output.append("  size_t capacity = 256;\n");
    output.append("  for (;;) {\n");
    output.append("    resolved = malloc(capacity);\n");
    output.append("    if (resolved == NULL) abort();\n");
    output.append("    const ssize_t length = readlink(\"/proc/self/exe\", resolved, capacity - 1);\n");
    output.append("    if (length < 0) { const int code = errno; free(resolved); return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) }; }\n");
    output.append("    if ((size_t)length < capacity - 1) { resolved[length] = '\\0'; break; }\n");
    output.append("    free(resolved); resolved = NULL;\n");
    output.append("    if (capacity > SIZE_MAX / 2) abort();\n");
    output.append("    capacity *= 2;\n");
    output.append("  }\n");
    output.append("#else\n");
    output.append("  if (z_stage1_process_argc <= 0 || z_stage1_process_argv == NULL) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"could not locate the current executable\") };\n");
    output.append("  resolved = realpath(z_stage1_process_argv[0], NULL);\n");
    output.append("  if (resolved == NULL) return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("#endif\n");
    output.append("  const size_t length = strlen(resolved);\n");
    output.append("  if (!z_stage1_string_is_valid_utf8(resolved, length)) { free(resolved); return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"the current executable path is not valid UTF-8\") }; }\n");
    output.append("  Z_String result = z_stage1_string_from_cstring(resolved);\n");
    output.append("  free(resolved);\n");
    output.append("  return (Z___z_Result_String_String){ .tag = Z___z_Result_String_StringTag_success, .payload.success = result };\n");
    output.append("}\n\n");
  }
  if (usesProcessRun) {
    output.append("static __attribute__((unused)) Z___z_Result_i32_String z_stage1_process_run(const Z_String *program, Z___z_Array_String arguments) {\n");
    output.append("  if (program == NULL || (program->length > 0 && memchr(program->data, '\\0', program->length) != NULL)) {\n");
    output.append("    return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"program contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  Z_String *items = (Z_String *)arguments.data;\n");
    output.append("  for (size_t index = 0; index < arguments.length; index += 1) {\n");
    output.append("    if (items[index].length > 0 && memchr(items[index].data, '\\0', items[index].length) != NULL) return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(\"process argument contains an embedded null byte\") };\n");
    output.append("  }\n");
    output.append("  char **native_argv = calloc(arguments.length + 2, sizeof(char *));\n");
    output.append("  if (native_argv == NULL) abort();\n");
    output.append("  native_argv[0] = (char *)(program->data != NULL ? program->data : \"\");\n");
    output.append("  for (size_t index = 0; index < arguments.length; index += 1) native_argv[index + 1] = (char *)(items[index].data != NULL ? items[index].data : \"\");\n");
    output.append("#if defined(_WIN32)\n");
    output.append("  const intptr_t status = _spawnvp(_P_WAIT, native_argv[0], (const char * const *)native_argv);\n");
    output.append("  if (status == -1) {\n");
    output.append("    const int code = errno; free(native_argv);\n");
    output.append("    return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  free(native_argv);\n");
    output.append("  return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_success, .payload.success = (int32_t)status };\n");
    output.append("#else\n");
    output.append("  int error_pipe[2];\n");
    output.append("  if (pipe(error_pipe) != 0) {\n");
    output.append("    const int code = errno; free(native_argv);\n");
    output.append("    return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  if (fcntl(error_pipe[1], F_SETFD, FD_CLOEXEC) == -1) {\n");
    output.append("    const int code = errno; close(error_pipe[0]); close(error_pipe[1]); free(native_argv);\n");
    output.append("    return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  const pid_t child = fork();\n");
    output.append("  if (child < 0) {\n");
    output.append("    const int code = errno; close(error_pipe[0]); close(error_pipe[1]); free(native_argv);\n");
    output.append("    return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(code)) };\n");
    output.append("  }\n");
    output.append("  if (child == 0) {\n");
    output.append("    close(error_pipe[0]); execvp(native_argv[0], native_argv);\n");
    output.append("    const int code = errno; (void)write(error_pipe[1], &code, sizeof(code)); close(error_pipe[1]); _exit(127);\n");
    output.append("  }\n");
    output.append("  close(error_pipe[1]);\n");
    output.append("  int exec_error = 0; ssize_t error_bytes;\n");
    output.append("  do { error_bytes = read(error_pipe[0], &exec_error, sizeof(exec_error)); } while (error_bytes < 0 && errno == EINTR);\n");
    output.append("  const int pipe_error = error_bytes < 0 ? errno : 0; close(error_pipe[0]);\n");
    output.append("  int status = 0; pid_t waited;\n");
    output.append("  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);\n");
    output.append("  free(native_argv);\n");
    output.append("  if (waited < 0) return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(errno)) };\n");
    output.append("  if (pipe_error != 0) return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(pipe_error)) };\n");
    output.append("  if (error_bytes == (ssize_t)sizeof(exec_error)) return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_failure, .payload.failure = z_stage1_string_from_cstring(strerror(exec_error)) };\n");
    output.append("  const int32_t exit_code = WIFEXITED(status) ? (int32_t)WEXITSTATUS(status) : WIFSIGNALED(status) ? (int32_t)(128 + WTERMSIG(status)) : 1;\n");
    output.append("  return (Z___z_Result_i32_String){ .tag = Z___z_Result_i32_StringTag_success, .payload.success = exit_code };\n");
    output.append("#endif\n");
    output.append("}\n\n");
  }
  if (
    usesConsoleLog
    || usesConsoleWrite
    || usesConsoleError
    || usesConsoleDebug
  ) {
    output.append("static __attribute__((unused)) void z_stage1_console_emit(const Z_String *value, FILE *stream, bool newline) {\n");
    output.append("  if (value != NULL && value->length > 0) (void)fwrite(value->data, 1, value->length, stream);\n");
    output.append("  if (newline) fputc('\\n', stream);\n");
    output.append("  fflush(stream);\n");
    output.append("}\n\n");
  }
  if (usesConsoleLog) {
    output.append("static __attribute__((unused)) void z_stage1_console_log(const Z_String *value) { z_stage1_console_emit(value, stdout, true); }\n\n");
  }
  if (usesConsoleWrite) {
    output.append("static __attribute__((unused)) void z_stage1_console_write(const Z_String *value) { z_stage1_console_emit(value, stdout, false); }\n\n");
  }
  if (usesConsoleError) {
    output.append("static __attribute__((unused)) void z_stage1_console_error(const Z_String *value) { z_stage1_console_emit(value, stderr, true); }\n\n");
  }
  if (usesConsoleDebug) {
    output.append("static __attribute__((unused)) void z_stage1_console_debug(const Z_String *value) { z_stage1_console_emit(value, stderr, true); }\n\n");
  }
}

function appendCheckedUnsignedIntegerRuntime(
  inout output: TextBuffer,
  in name: String,
  in nativeType: String,
  in maximum: String,
  in bitWidth: String
): void {
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_add_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  if (__builtin_add_overflow(left, right, &result)) abort();\n  return result;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_subtract_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  if (__builtin_sub_overflow(left, right, &result)) abort();\n  return result;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_multiply_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  if (__builtin_mul_overflow(left, right, &result)) abort();\n  return result;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_divide_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  if (right == 0) abort();\n  return left / right;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_remainder_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  if (right == 0) abort();\n  return left % right;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_shift_left_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  if (right >= ");
  output.append(bitWidth);
  output.append(" || left > (");
  output.append(maximum);
  output.append(" >> right)) abort();\n  return left << right;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_checked_shift_right_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  if (right >= ");
  output.append(bitWidth);
  output.append(") abort();\n  return left >> right;\n}\n\n");
}

function appendWrappingIntegerRuntime(
  inout output: TextBuffer,
  in name: String,
  in nativeType: String
): void {
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_wrapping_add_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  (void)__builtin_add_overflow(left, right, &result);\n  return result;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_wrapping_subtract_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  (void)__builtin_sub_overflow(left, right, &result);\n  return result;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  output.append(nativeType);
  output.append(" z_stage1_wrapping_multiply_");
  output.append(name);
  output.append("(");
  output.append(nativeType);
  output.append(" left, ");
  output.append(nativeType);
  output.append(" right) {\n  ");
  output.append(nativeType);
  output.append(" result;\n  (void)__builtin_mul_overflow(left, right, &result);\n  return result;\n}\n\n");
}

function emitLoweredC(in program: LoweredProgram): String throws String {
  let output = TextBuffer();
  const usesProcessArguments = programUsesStandardCall(
    program,
    "process.args"
  ) || programUsesStandardCall(program, "process.executablePath");
  const usesLock = programUsesStandardCall(program, "fs.lock");
  const usesReadBytes = programUsesStandardCall(program, "fs.readBytes");
  const usesReadText = programUsesStandardCall(program, "fs.readText");
  const usesWriteText = programUsesStandardCall(program, "fs.writeText");
  const usesReplace = programUsesStandardCall(program, "fs.replace");
  const usesExists = programUsesStandardCall(program, "fs.exists");
  const usesIsDirectory = programUsesStandardCall(program, "fs.isDirectory");
  const usesCreateDirectories = programUsesStandardCall(
    program,
    "fs.createDirectories"
  );
  const usesRealPath = programUsesStandardCall(program, "fs.realPath");
  const usesProcessRun = programUsesStandardCall(program, "process.run");
  const usesProcessExecutablePath = programUsesStandardCall(
    program,
    "process.executablePath"
  );
  const usesConsole =
    programUsesStandardCall(program, "console.log")
    || programUsesStandardCall(program, "console.write")
    || programUsesStandardCall(program, "console.error")
    || programUsesStandardCall(program, "console.debug");
  if (usesRealPath || usesCreateDirectories || usesProcessExecutablePath) {
    output.append("#if !defined(_WIN32) && !defined(__APPLE__) && !defined(_POSIX_C_SOURCE)\n#define _POSIX_C_SOURCE 200809L\n#endif\n");
  }
  output.append("#include <stdbool.h>\n#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n");
  output.append("#ifndef Z_API\n#define Z_API\n#endif\n");
  for (const header of program.foreignHeaders) {
    output.append("#include \"");
    output.append(header);
    output.append("\"\n");
  }
  if (
    usesLock
    || usesReadBytes
    || usesReadText
    || usesWriteText
    || usesReplace
    || usesCreateDirectories
    || usesRealPath
    || usesProcessExecutablePath
    || usesProcessRun
  ) {
    output.append("#include <errno.h>\n");
  }
  if (
    usesReadBytes
    || usesReadText
    || usesWriteText
    || usesReplace
    || usesConsole
  ) {
    output.append("#include <stdio.h>\n");
  }
  if (
    usesExists
    || usesIsDirectory
    || usesCreateDirectories
    || usesRealPath
    || usesProcessExecutablePath
    || usesProcessRun
  ) {
    output.append("#if defined(_WIN32)\n#include <io.h>\n#include <process.h>\n#else\n#include <fcntl.h>\n#include <sys/types.h>\n#include <sys/wait.h>\n#include <unistd.h>\n#endif\n");
  }
  if (usesLock) {
    output.append("#if defined(_WIN32)\n#include <windows.h>\n#else\n#include <fcntl.h>\n#include <sys/file.h>\n#include <unistd.h>\n#endif\n");
  }
  if (usesReplace) {
    output.append("#if defined(_WIN32)\n#include <windows.h>\n#endif\n");
  }
  if (usesProcessExecutablePath) {
    output.append("#if defined(_WIN32)\n#include <windows.h>\n#elif defined(__APPLE__)\n#include <mach-o/dyld.h>\n#endif\n");
  }
  if (usesIsDirectory || usesCreateDirectories) {
    output.append("#include <sys/stat.h>\n");
  }
  if (usesCreateDirectories) {
    output.append("#if defined(_WIN32)\n#include <direct.h>\n#endif\n");
  }
  output.append("\n");
  if (usesProcessArguments) {
    output.append("static int z_stage1_process_argc = 0;\n");
    output.append("static char **z_stage1_process_argv = NULL;\n\n");
  }
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
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_divide_i32(int32_t left, int32_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  if (left == INT32_MIN && right == -1) abort();\n");
  output.append("  return left / right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_remainder_i32(int32_t left, int32_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  if (left == INT32_MIN && right == -1) abort();\n");
  output.append("  return left % right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_negate_i32(int32_t value) {\n");
  output.append("  int32_t result;\n");
  output.append("  if (__builtin_sub_overflow(0, value, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_add_u8(uint8_t left, uint8_t right) {\n");
  output.append("  uint8_t result;\n");
  output.append("  if (__builtin_add_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_subtract_u8(uint8_t left, uint8_t right) {\n");
  output.append("  uint8_t result;\n");
  output.append("  if (__builtin_sub_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_multiply_u8(uint8_t left, uint8_t right) {\n");
  output.append("  uint8_t result;\n");
  output.append("  if (__builtin_mul_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_divide_u8(uint8_t left, uint8_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  return (uint8_t)(left / right);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_remainder_u8(uint8_t left, uint8_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  return (uint8_t)(left % right);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_add_usize(size_t left, size_t right) {\n");
  output.append("  size_t result;\n");
  output.append("  if (__builtin_add_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_subtract_usize(size_t left, size_t right) {\n");
  output.append("  size_t result;\n");
  output.append("  if (__builtin_sub_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_multiply_usize(size_t left, size_t right) {\n");
  output.append("  size_t result;\n");
  output.append("  if (__builtin_mul_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_divide_usize(size_t left, size_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  return left / right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_remainder_usize(size_t left, size_t right) {\n");
  output.append("  if (right == 0) abort();\n");
  output.append("  return left % right;\n");
  output.append("}\n\n");
  appendCheckedUnsignedIntegerRuntime(
    inout output,
    "u32",
    "uint32_t",
    "UINT32_MAX",
    "32"
  );
  appendCheckedUnsignedIntegerRuntime(
    inout output,
    "u64",
    "uint64_t",
    "UINT64_MAX",
    "64"
  );
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_shift_left_u8(uint8_t left, uint8_t right) {\n");
  output.append("  if (right >= 8 || left > (uint8_t)(UINT8_MAX >> right)) abort();\n");
  output.append("  return (uint8_t)(left << right);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_shift_right_u8(uint8_t left, uint8_t right) {\n");
  output.append("  if (right >= 8) abort();\n");
  output.append("  return (uint8_t)(left >> right);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_shift_left_usize(size_t left, size_t right) {\n");
  output.append("  if (right >= sizeof(size_t) * 8 || left > (SIZE_MAX >> right)) abort();\n");
  output.append("  return left << right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_shift_right_usize(size_t left, size_t right) {\n");
  output.append("  if (right >= sizeof(size_t) * 8) abort();\n");
  output.append("  return left >> right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_shift_left_i32(int32_t left, int32_t right) {\n");
  output.append("  if (right < 0 || right >= 32) abort();\n");
  output.append("  const int64_t factor = ((int64_t)1) << right;\n");
  output.append("  const int64_t result = (int64_t)left * factor;\n");
  output.append("  if (result < INT32_MIN || result > INT32_MAX) abort();\n");
  output.append("  return (int32_t)result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_shift_right_i32(int32_t left, int32_t right) {\n");
  output.append("  if (right < 0 || right >= 32) abort();\n");
  output.append("  const int64_t divisor = ((int64_t)1) << right;\n");
  output.append("  if (left >= 0) return (int32_t)((int64_t)left / divisor);\n");
  output.append("  const int64_t magnitude = -(int64_t)left;\n");
  output.append("  return (int32_t)(-((magnitude + divisor - 1) / divisor));\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_convert_i32_to_u8(int32_t value) {\n");
  output.append("  if (value < 0 || value > UINT8_MAX) abort();\n");
  output.append("  return (uint8_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_convert_usize_to_u8(size_t value) {\n");
  output.append("  if (value > UINT8_MAX) abort();\n");
  output.append("  return (uint8_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_convert_u32_to_u8(uint32_t value) {\n");
  output.append("  if (value > UINT8_MAX) abort();\n");
  output.append("  return (uint8_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_stage1_checked_convert_u64_to_u8(uint64_t value) {\n");
  output.append("  if (value > UINT8_MAX) abort();\n");
  output.append("  return (uint8_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint32_t z_stage1_checked_convert_i32_to_u32(int32_t value) {\n");
  output.append("  if (value < 0) abort();\n");
  output.append("  return (uint32_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int32_t z_stage1_checked_convert_usize_to_i32(size_t value) {\n");
  output.append("  if (value > INT32_MAX) abort();\n");
  output.append("  return (int32_t)value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_stage1_checked_convert_i32_to_usize(int32_t value) {\n");
  output.append("  if (value < 0) abort();\n");
  output.append("  return (size_t)value;\n");
  output.append("}\n\n");
  appendWrappingIntegerRuntime(inout output, "i32", "int32_t");
  appendWrappingIntegerRuntime(inout output, "u8", "uint8_t");
  appendWrappingIntegerRuntime(inout output, "u32", "uint32_t");
  appendWrappingIntegerRuntime(inout output, "u64", "uint64_t");
  appendWrappingIntegerRuntime(inout output, "usize", "size_t");
  output.append("typedef struct Z_String {\n");
  output.append("  const char *data;\n");
  output.append("  size_t length;\n");
  output.append("  size_t capacity;\n");
  output.append("} Z_String;\n\n");
  output.append("typedef enum Z_TemplatePartKind {\n");
  output.append("  Z_TEMPLATE_STRING,\n");
  output.append("  Z_TEMPLATE_BOOLEAN,\n");
  output.append("  Z_TEMPLATE_I32,\n");
  output.append("  Z_TEMPLATE_U8,\n");
  output.append("  Z_TEMPLATE_USIZE\n");
  output.append("} Z_TemplatePartKind;\n\n");
  output.append("typedef struct Z_TemplatePart {\n");
  output.append("  Z_TemplatePartKind kind;\n");
  output.append("  union {\n");
  output.append("    Z_String string_value;\n");
  output.append("    bool boolean_value;\n");
  output.append("    int32_t i32_value;\n");
  output.append("    uint8_t u8_value;\n");
  output.append("    size_t usize_value;\n");
  output.append("  } value;\n");
  output.append("} Z_TemplatePart;\n\n");
  output.append("#define Z_STRING_LITERAL(value) ((Z_String){ .data = (value), .length = sizeof(value) - 1, .capacity = 0 })\n\n");
  output.append("static inline __attribute__((unused)) void Z_String_deinit(Z_String *self) {\n");
  output.append("  if (self->capacity > 0) free((void *)self->data);\n");
  output.append("  self->data = NULL;\n");
  output.append("  self->length = 0;\n");
  output.append("  self->capacity = 0;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) bool z_string_equal(Z_String left, Z_String right) {\n");
  output.append("  if (left.length != right.length) return false;\n");
  output.append("  if (left.length == 0) return true;\n");
  output.append("  return memcmp(left.data, right.data, left.length) == 0;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_string_reserve(Z_String *self, size_t additional) {\n");
  output.append("  if (additional > SIZE_MAX - self->length - 1) abort();\n");
  output.append("  const size_t required = self->length + additional + 1;\n");
  output.append("  if (required <= self->capacity) return;\n");
  output.append("  size_t next = self->capacity == 0 ? 32 : self->capacity;\n");
  output.append("  while (next < required) {\n");
  output.append("    if (next > SIZE_MAX / 2) { next = required; break; }\n");
  output.append("    next *= 2;\n");
  output.append("  }\n");
  output.append("  void *storage;\n");
  output.append("  if (self->capacity == 0 && self->data != NULL) {\n");
  output.append("    storage = malloc(next);\n");
  output.append("    if (storage != NULL) memcpy(storage, self->data, self->length);\n");
  output.append("  } else storage = realloc((void *)self->data, next);\n");
  output.append("  if (storage == NULL) abort();\n");
  output.append("  self->data = (const char *)storage;\n");
  output.append("  self->capacity = next;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_string_append_bytes(Z_String *self, const char *data, size_t length) {\n");
  output.append("  if (length == 0) return;\n");
  output.append("  z_string_reserve(self, length);\n");
  output.append("  memcpy((char *)self->data + self->length, data, length);\n");
  output.append("  self->length += length;\n");
  output.append("  ((char *)self->data)[self->length] = '\\0';\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) uint8_t z_string_byte_at(Z_String value, size_t index) {\n");
  output.append("  if (index >= value.length) abort();\n");
  output.append("  return (uint8_t)value.data[index];\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) bool z_string_is_utf8_boundary(Z_String value, size_t index) {\n");
  output.append("  return index == 0 || index == value.length || (((uint8_t)value.data[index] & 0xC0u) != 0x80u);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) Z_String z_string_copy_bytes(Z_String value, size_t start, size_t end) {\n");
  output.append("  if (start > end || end > value.length) abort();\n");
  output.append("  if (!z_string_is_utf8_boundary(value, start) || !z_string_is_utf8_boundary(value, end)) abort();\n");
  output.append("  Z_String result = { NULL, 0, 0 };\n");
  output.append("  const char *bytes = value.data != NULL ? value.data + start : \"\";\n");
  output.append("  z_string_append_bytes(&result, bytes, end - start);\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) Z_String z_string_copy(Z_String value) {\n");
  output.append("  return z_string_copy_bytes(value, 0, value.length);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_text_buffer_append(Z_String *self, Z_String value) {\n");
  output.append("  z_string_append_bytes(self, value.data != NULL ? value.data : \"\", value.length);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_text_buffer_append_bytes(Z_String *self, Z_String value, size_t start, size_t end) {\n");
  output.append("  if (start > end || end > value.length) abort();\n");
  output.append("  if (!z_string_is_utf8_boundary(value, start) || !z_string_is_utf8_boundary(value, end)) abort();\n");
  output.append("  z_string_append_bytes(self, value.data != NULL ? value.data + start : \"\", end - start);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_text_buffer_append_ascii(Z_String *self, uint8_t byte) {\n");
  output.append("  if (byte > 0x7Fu) abort();\n");
  output.append("  const char value = (char)byte;\n");
  output.append("  z_string_append_bytes(self, &value, 1);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_string_append_unsigned_decimal(Z_String *self, uint64_t value) {\n");
  output.append("  char digits[20];\n");
  output.append("  size_t length = 0;\n");
  output.append("  do {\n");
  output.append("    digits[length++] = (char)('0' + (value % 10));\n");
  output.append("    value /= 10;\n");
  output.append("  } while (value > 0);\n");
  output.append("  while (length > 0) {\n");
  output.append("    length -= 1;\n");
  output.append("    z_string_append_bytes(self, &digits[length], 1);\n");
  output.append("  }\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) Z_String z_string_template(const Z_TemplatePart *parts, size_t count) {\n");
  output.append("  Z_String result = { NULL, 0, 0 };\n");
  output.append("  for (size_t index = 0; index < count; index += 1) {\n");
  output.append("    const Z_TemplatePart part = parts[index];\n");
  output.append("    if (part.kind == Z_TEMPLATE_STRING) {\n");
  output.append("      z_string_append_bytes(&result, part.value.string_value.data != NULL ? part.value.string_value.data : \"\", part.value.string_value.length);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_BOOLEAN) {\n");
  output.append("      if (part.value.boolean_value) z_string_append_bytes(&result, \"true\", 4);\n");
  output.append("      else z_string_append_bytes(&result, \"false\", 5);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_I32) {\n");
  output.append("      const int32_t value = part.value.i32_value;\n");
  output.append("      if (value < 0) {\n");
  output.append("        z_string_append_bytes(&result, \"-\", 1);\n");
  output.append("        z_string_append_unsigned_decimal(&result, (uint64_t)(-(int64_t)value));\n");
  output.append("      } else z_string_append_unsigned_decimal(&result, (uint64_t)value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_U8) {\n");
  output.append("      z_string_append_unsigned_decimal(&result, (uint64_t)part.value.u8_value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_USIZE) {\n");
  output.append("      z_string_append_unsigned_decimal(&result, (uint64_t)part.value.usize_value);\n");
  output.append("    }\n");
  output.append("  }\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("typedef struct Z_FsLock {\n  intptr_t native;\n} Z_FsLock;\n\n");
  try appendTypeDefinitions(inout output, program);
  for (const foreign of program.foreignFunctions) {
    const errorType = try cType(foreign.errorType);
    output.append("static __attribute__((unused)) Z_");
    output.append(foreign.resultType);
    output.append(" ");
    output.append(foreign.wrapperName);
    output.append("(");
    let parameterIndex: usize = 0;
    while (parameterIndex < foreign.parameterTypes.length) {
      if (parameterIndex > 0) output.append(", ");
      const parameterType = try cType(
        foreign.parameterTypes[parameterIndex]
      );
      output.append(parameterType);
      output.append(" parameter_");
      output.append(`${parameterIndex}`);
      parameterIndex = parameterIndex + 1;
    }
    if (foreign.parameterTypes.length == 0) output.append("void");
    output.append(") {\n  ");
    output.append(errorType);
    output.append(" status = ");
    output.append(foreign.nativeName);
    output.append("(");
    parameterIndex = 0;
    while (parameterIndex < foreign.parameterTypes.length) {
      if (parameterIndex > 0) output.append(", ");
      output.append("parameter_");
      output.append(`${parameterIndex}`);
      parameterIndex = parameterIndex + 1;
    }
    output.append(");\n  if (");
    let successIndex: usize = 0;
    while (successIndex < foreign.successValues.length) {
      if (successIndex > 0) output.append(" || ");
      output.append("status == ");
      output.append(foreign.successValues[successIndex]);
      successIndex = successIndex + 1;
    }
    output.append(") return (Z_");
    output.append(foreign.resultType);
    output.append("){ .tag = Z_");
    output.append(foreign.resultType);
    output.append("Tag_success };\n  return (Z_");
    output.append(foreign.resultType);
    output.append("){ .tag = Z_");
    output.append(foreign.resultType);
    output.append("Tag_failure, .payload.failure = status };\n}\n\n");
  }
  appendSystemStandardRuntime(inout output, program);
  for (const declaration of program.arrays) {
    const elementType = try cType(declaration.elementType);
    output.append("static inline __attribute__((unused)) const ");
    output.append(elementType);
    output.append(" *Z_");
    output.append(declaration.name);
    output.append("_at(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  if (index >= self->length) abort();\n");
    output.append("  return &((");
    output.append(elementType);
    output.append(" *)self->data)[index];\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" *Z_");
    output.append(declaration.name);
    output.append("_at_mut(Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  if (index >= self->length) abort();\n");
    output.append("  return &((");
    output.append(elementType);
    output.append(" *)self->data)[index];\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_push(Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(elementType);
    output.append(" value) {\n");
    output.append("  if (self->length == self->capacity) {\n");
    output.append("    size_t next = self->capacity == 0 ? 8 : self->capacity;\n");
    output.append("    if (self->capacity != 0) {\n");
    output.append("      if (next > SIZE_MAX / 2) abort();\n");
    output.append("      next *= 2;\n");
    output.append("    }\n");
    output.append("    if (next > SIZE_MAX / sizeof(");
    output.append(elementType);
    output.append(")) abort();\n");
    output.append("    void *storage = realloc(self->data, next * sizeof(");
    output.append(elementType);
    output.append("));\n");
    output.append("    if (storage == NULL) abort();\n");
    output.append("    self->data = storage;\n");
    output.append("    self->capacity = next;\n");
    output.append("  }\n");
    output.append("  ((");
    output.append(elementType);
    output.append(" *)self->data)[self->length] = value;\n");
    output.append("  self->length += 1;\n");
    output.append("}\n\n");
  }
  try appendMapRuntime(inout output, program);
  appendSetRuntime(inout output, program);
  for (const declaration of program.arrays) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self);\n");
  }
  for (const declaration of program.maps) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self);\n");
  }
  for (const declaration of program.sets) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self);\n");
  }
  for (const aggregate of program.structs) {
    if (aggregate.needsDeinit) {
      output.append("static __attribute__((unused)) void Z_");
      output.append(aggregate.name);
      output.append("_deinit(Z_");
      output.append(aggregate.name);
      output.append(" *self);\n");
    }
  }
  for (const declaration of program.enums) {
    if (declaration.needsDeinit) {
      output.append("static __attribute__((unused)) void Z_");
      output.append(declaration.name);
      output.append("_deinit(Z_");
      output.append(declaration.name);
      output.append(" *self);\n");
    }
  }
  for (const declaration of program.functions) {
    try appendFunctionSignature(
      inout output,
      declaration,
      usesProcessArguments
    );
    output.append(";\n");
  }
  output.append("\n");
  for (const declaration of program.arrays) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    if (loweredTypeNeedsDeinit(program, declaration.elementType)) {
      const elementType = try cType(declaration.elementType);
      output.append("  ");
      output.append(elementType);
      output.append(" *items = (");
      output.append(elementType);
      output.append(" *)self->data;\n");
      output.append("  while (self->length > 0) {\n");
      output.append("    self->length -= 1;\n");
      output.append("    Z_");
      output.append(declaration.elementType.name);
      output.append("_deinit(&items[self->length]);\n");
      output.append("  }\n");
    }
    output.append("  free(self->data);\n");
    output.append("  self->data = NULL;\n");
    output.append("  self->length = 0;\n");
    output.append("  self->capacity = 0;\n");
    output.append("}\n\n");
  }
  for (const declaration of program.maps) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  while (self->length > 0) {\n");
    output.append("    self->length -= 1;\n");
    output.append("    Z_String_deinit(&self->entries[self->length].key);\n");
    output.append("  }\n");
    output.append("  free(self->entries);\n");
    output.append("  free(self->buckets);\n");
    output.append("  self->entries = NULL;\n");
    output.append("  self->capacity = 0;\n");
    output.append("  self->buckets = NULL;\n");
    output.append("  self->bucketCount = 0;\n");
    output.append("  self->tombstones = 0;\n");
    output.append("}\n\n");
  }
  for (const declaration of program.sets) {
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  while (self->length > 0) {\n");
    output.append("    self->length -= 1;\n");
    output.append("    Z_String_deinit(&self->values[self->length]);\n");
    output.append("  }\n");
    output.append("  free(self->values);\n");
    output.append("  free(self->buckets);\n");
    output.append("  self->values = NULL;\n");
    output.append("  self->capacity = 0;\n");
    output.append("  self->buckets = NULL;\n");
    output.append("  self->bucketCount = 0;\n");
    output.append("  self->tombstones = 0;\n");
    output.append("}\n\n");
  }
  for (const declaration of program.enums) {
    if (declaration.needsDeinit) {
      output.append("static __attribute__((unused)) void Z_");
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
      output.append("static __attribute__((unused)) void Z_");
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
    try appendFunction(
      inout output,
      declaration,
      usesProcessArguments
    );
  }
  let hasNativeCExports = false;
  for (const declaration of program.functions) {
    if (declaration.nativeCExportName.byteLength > 0) {
      hasNativeCExports = true;
    }
  }
  if (hasNativeCExports) {
    output.append("#if defined(__cplusplus)\nextern \"C\" {\n#endif\n\n");
    for (const declaration of program.functions) {
      if (declaration.nativeCExportName.byteLength == 0) continue;
      try appendNativeCExportDefinition(inout output, program, declaration);
    }
    output.append("#if defined(__cplusplus)\n}\n#endif\n");
  }
  return output.finish();
}

function emitLoweredCHeader(in program: LoweredProgram): String throws String {
  let output = TextBuffer();
  output.append("#pragma once\n\n");
  output.append("#include <stdbool.h>\n#include <stdint.h>\n\n");
  output.append("#ifndef Z_API\n#define Z_API\n#endif\n\n");
  let emittedTypes = Array<String>();
  let visitingTypes = Array<String>();
  for (const declaration of program.functions) {
    if (declaration.nativeCExportName.byteLength == 0) continue;
    for (const parameter of declaration.parameters) {
      try appendNativeCHeaderType(
        inout output,
        program,
        parameter.type,
        inout emittedTypes,
        inout visitingTypes
      );
    }
    try appendNativeCHeaderType(
      inout output,
      program,
      declaration.returnType,
      inout emittedTypes,
      inout visitingTypes
    );
  }
  output.append("#if defined(__cplusplus)\nextern \"C\" {\n#endif\n\n");
  for (const declaration of program.functions) {
    if (declaration.nativeCExportName.byteLength == 0) continue;
    try appendNativeCExportSignature(
      inout output,
      program,
      declaration,
      declaration.nativeCExportName
    );
    output.append(";\n");
  }
  output.append("\n#if defined(__cplusplus)\n}\n#endif\n");
  return output.finish();
}

function stringArrayContains(in values: Array<String>, in target: String): boolean {
  for (const value of values) {
    if (value == target) return true;
  }
  return false;
}

function appendNativeCHeaderType(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in type: LoweredType,
  inout emitted: Array<String>,
  inout visiting: Array<String>
): void throws String {
  if (type.kind == LoweredTypeKind.enumType) {
    if (stringArrayContains(emitted, type.name)) return;
    for (const enumeration of program.enums) {
      if (enumeration.name != type.name) continue;
      if (enumeration.nativeCName.byteLength == 0) return;
      const underlying = try nativeCIntegerType(
        enumeration.nativeCUnderlyingType
      );
      output.append("typedef ");
      output.append(underlying);
      output.append(" ");
      output.append(enumeration.nativeCName);
      output.append(";\n");
      let variant: usize = 0;
      while (variant < enumeration.variants.length) {
        output.append("#define ");
        output.append(enumeration.nativeCName);
        output.append("_");
        output.append(enumeration.variants[variant].name);
        output.append(" ((");
        output.append(enumeration.nativeCName);
        output.append(")");
        output.append(`${variant}`);
        output.append(")\n");
        variant = variant + 1;
      }
      output.append("\n");
      emitted.push(type.name.copyBytes(0, type.name.byteLength));
      return;
    }
    return;
  }
  if (type.kind != LoweredTypeKind.structType) return;
  if (stringArrayContains(emitted, type.name)) return;
  if (stringArrayContains(visiting, type.name)) {
    throw `C-layout struct ${type.name} contains itself by value`;
  }
  for (const aggregate of program.structs) {
    if (aggregate.name != type.name) continue;
    if (aggregate.nativeCName.byteLength == 0) return;
    visiting.push(type.name.copyBytes(0, type.name.byteLength));
    for (const field of aggregate.fields) {
      try appendNativeCHeaderType(
        inout output,
        program,
        field.type,
        inout emitted,
        inout visiting
      );
    }
    output.append("typedef struct ");
    output.append(aggregate.nativeCName);
    output.append(" {\n");
    for (const field of aggregate.fields) {
      output.append("  ");
      const fieldType = try nativeCExportType(program, field.type);
      output.append(fieldType);
      output.append(" ");
      output.append(field.name);
      output.append(";\n");
    }
    output.append("} ");
    output.append(aggregate.nativeCName);
    output.append(";\n\n");
    emitted.push(type.name.copyBytes(0, type.name.byteLength));
    return;
  }
}

export function emitC(
  in program: Program,
  in evidence: ModuleSemanticEvidence
): String throws String {
  const lowered = try lowerProgram(program, evidence);
  return try emitLoweredC(lowered);
}

export function emitModulesC(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  return try emitLoweredC(lowered);
}

export function emitModulesCHeader(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  return try emitLoweredCHeader(lowered);
}
