// C-family text emission from the typed native lowering IR.

import { TextBuffer } from "std/text";
import {
  LoweredExpression,
  LoweredExpressionKind,
  LoweredEnum,
  LoweredFunction,
  LoweredFunctionType,
  LoweredObjCProtocolAdapter,
  LoweredObjCRegistration,
  LoweredCleanup,
  LoweredMainDelayLoop,
  LoweredMainDelaySegment,
  LoweredParameter,
  LoweredParameterMode,
  LoweredProgram,
  LoweredStatementKind,
  LoweredStruct,
  LoweredType,
  LoweredTypeKind,
  lowerModules,
  lowerProgram,
  lowerTestModules,
} from "./lowering-ir.zs";
import { ParsedModule } from "./module-symbols.zs";
import { Program } from "./parser.zs";
import {
  ModuleGraph,
  ModuleSemanticEvidence,
} from "./semantic-model.zs";
import { stringStartsWith } from "./semantic-type-shapes.zs";
import { internalBackendFailure } from "./native-backend-errors.zs";

function labelsContain(in labels: Array<String>, in candidate: String): boolean {
  for (const label of labels) {
    if (label == candidate) return true;
  }
  return false;
}

function isNicheViewOption(in name: String): boolean {
  return stringStartsWith(name, "__z_NicheViewOption_");
}

function viewPayloadLoadsAsValue(in type: LoweredType): boolean {
  return type.kind == LoweredTypeKind.booleanType
    || type.kind == LoweredTypeKind.i8Type
    || type.kind == LoweredTypeKind.i16Type
    || type.kind == LoweredTypeKind.i32Type
    || type.kind == LoweredTypeKind.i64Type
    || type.kind == LoweredTypeKind.u8Type
    || type.kind == LoweredTypeKind.u16Type
    || type.kind == LoweredTypeKind.u32Type
    || type.kind == LoweredTypeKind.u64Type
    || type.kind == LoweredTypeKind.isizeType
    || type.kind == LoweredTypeKind.usizeType
    || type.kind == LoweredTypeKind.f32Type
    || type.kind == LoweredTypeKind.f64Type
    || type.kind == LoweredTypeKind.foreignEnumType;
}

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
  if (type.kind == LoweredTypeKind.arenaType) return "Z_Arena";
  if (type.kind == LoweredTypeKind.hasherType) return "Z_Hasher";
  if (type.kind == LoweredTypeKind.stringType) return "Z_String";
  if (type.kind == LoweredTypeKind.cstringType) return "const char *";
  if (type.kind == LoweredTypeKind.fixedArrayType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.arrayType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.sliceType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.mapType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.setType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.functionType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.booleanType) return "bool";
  if (type.kind == LoweredTypeKind.voidType) return "void";
  if (type.kind == LoweredTypeKind.structType) return `Z_${type.name}`;
  if (type.kind == LoweredTypeKind.foreignStructType) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  if (type.kind == LoweredTypeKind.foreignHandleType) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  if (type.kind == LoweredTypeKind.foreignObjCType) {
    if (type.name == "id") return "id";
    return `${type.name} *`;
  }
  if (type.kind == LoweredTypeKind.classType) return `Z_${type.name} *`;
  if (type.kind == LoweredTypeKind.weakType) return "Z_Weak";
  if (
    type.kind == LoweredTypeKind.onceType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
  ) return `Z_${type.name}`;
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
  if (type.kind == LoweredTypeKind.stringType) return "const char *";
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

function appendMutexWithLockHelperName(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("z_stage1_mutex_with_lock_");
  appendCBindingName(inout output, declaration.name);
  output.append("_");
  output.append(`${expressionIndex}`);
}

function appendCallableHelperName(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("z_stage1_callable_");
  appendCBindingName(inout output, declaration.name);
  output.append("_");
  output.append(`${expressionIndex}`);
}

function appendAsyncCallableAwaitHelperName(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("z_stage1_async_callable_await_");
  appendCBindingName(inout output, declaration.name);
  output.append("_");
  output.append(`${expressionIndex}`);
}

function appendPersistentAsyncParentName(
  inout output: TextBuffer,
  in declaration: LoweredFunction
): void {
  output.append("z_stage1_async_parent_");
  appendCBindingName(inout output, declaration.name);
}

struct PersistentAsyncParentShape {
  localStatement: usize;
  localInitializer: usize;
  returnExpression: usize;
}

function appendCallableParameterDeclaration(
  inout output: TextBuffer,
  in parameter: LoweredParameter,
  in name: String
): void throws String {
  const type = try cType(parameter.type);
  if (
    parameter.mode == LoweredParameterMode.input
    && parameter.type.kind != LoweredTypeKind.classType
  ) output.append("const ");
  output.append(type);
  if (
    parameter.mode == LoweredParameterMode.input
    && parameter.type.kind == LoweredTypeKind.classType
  ) output.append(" const *");
  else if (parameter.mode != LoweredParameterMode.value) output.append(" *");
  else output.append(" ");
  appendCBindingName(inout output, name);
}

function callableContextParameterName(
  in functionType: LoweredFunctionType,
  in expression: LoweredExpression,
  parameterLabelStart: usize
): String {
  let candidate = "context";
  let occupied = true;
  while (occupied) {
    occupied = false;
    let parameter: usize = 0;
    while (parameter < functionType.parameters.length) {
      if (
        expression.kind == LoweredExpressionKind.closureValue
        && expression.labels[parameterLabelStart + parameter] == candidate
      ) occupied = true;
      else if (
        expression.kind != LoweredExpressionKind.closureValue
        && functionType.parameters[parameter].name == candidate
      ) occupied = true;
      parameter = parameter + 1;
    }
    if (occupied) candidate = `_${candidate}`;
  }
  return candidate;
}

function appendThreadSpawnHelperName(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("z_stage1_thread_spawn_");
  appendCBindingName(inout output, declaration.name);
  output.append("_");
  output.append(`${expressionIndex}`);
}

function appendThreadMainCallHelperName(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("z_stage1_thread_main_call_");
  appendCBindingName(inout output, declaration.name);
  output.append("_");
  output.append(`${expressionIndex}`);
}

function appendOnceTypeName(
  inout names: Array<String>,
  in type: LoweredType
): void {
  let name = "";
  if (type.kind == LoweredTypeKind.onceType) {
    name = type.name.copyBytes(0, type.name.byteLength);
  } else if (type.kind == LoweredTypeKind.onceLifetimeType) {
    const prefix = "OnceLifetime_";
    const valueName = type.name.copyBytes(
      prefix.byteLength,
      type.name.byteLength
    );
    name = `Once_${valueName}`;
  }
  if (name.byteLength == 0) return;
  for (const existing of names) {
    if (existing == name) return;
  }
  names.push(move name);
}

function programOnceTypeNames(
  in program: LoweredProgram
): Array<String> {
  let names = Array<String>();
  for (const constant of program.constants) {
    appendOnceTypeName(inout names, constant.type);
  }
  for (const aggregate of program.structs) {
    for (const field of aggregate.fields) {
      appendOnceTypeName(inout names, field.type);
    }
  }
  for (const declaration of program.functions) {
    appendOnceTypeName(inout names, declaration.returnType);
    for (const parameter of declaration.parameters) {
      appendOnceTypeName(inout names, parameter.type);
    }
    for (const statement of declaration.statements) {
      match (in statement.type) {
        some(type) => appendOnceTypeName(inout names, type);
        none => {}
      }
    }
  }
  return names;
}

function programUsesExecutorBoundClasses(
  in program: LoweredProgram
): boolean {
  for (const aggregate of program.structs) {
    if (aggregate.referenceType && aggregate.executorBound) return true;
  }
  return false;
}

function appendMutexTypeName(
  inout names: Array<String>,
  in type: LoweredType
): void {
  if (type.kind != LoweredTypeKind.mutexType) return;
  for (const existing of names) {
    if (existing == type.name) return;
  }
  names.push(type.name.copyBytes(0, type.name.byteLength));
}

function programMutexTypeNames(
  in program: LoweredProgram
): Array<String> {
  let names = Array<String>();
  for (const constant of program.constants) {
    appendMutexTypeName(inout names, constant.type);
  }
  for (const aggregate of program.structs) {
    for (const field of aggregate.fields) {
      appendMutexTypeName(inout names, field.type);
    }
  }
  for (const declaration of program.functions) {
    appendMutexTypeName(inout names, declaration.returnType);
    for (const parameter of declaration.parameters) {
      appendMutexTypeName(inout names, parameter.type);
    }
    for (const statement of declaration.statements) {
      match (in statement.type) {
        some(type) => appendMutexTypeName(inout names, type);
        none => {}
      }
    }
  }
  return names;
}

function appendTaskTypeName(
  inout names: Array<String>,
  in type: LoweredType
): void {
  if (type.kind != LoweredTypeKind.taskType) return;
  for (const existing of names) {
    if (existing == type.name) return;
  }
  names.push(type.name.copyBytes(0, type.name.byteLength));
}

function programTaskTypeNames(
  in program: LoweredProgram
): Array<String> {
  let names = Array<String>();
  for (const constant of program.constants) {
    appendTaskTypeName(inout names, constant.type);
  }
  for (const aggregate of program.structs) {
    for (const field of aggregate.fields) {
      appendTaskTypeName(inout names, field.type);
    }
  }
  for (const declaration of program.functions) {
    appendTaskTypeName(inout names, declaration.returnType);
    for (const parameter of declaration.parameters) {
      appendTaskTypeName(inout names, parameter.type);
    }
    for (const statement of declaration.statements) {
      match (in statement.type) {
        some(type) => appendTaskTypeName(inout names, type);
        none => {}
      }
    }
  }
  return names;
}

function loweredTypeForIdentity(
  in program: LoweredProgram,
  in identity: String
): LoweredType throws String {
  if (identity == "void") return LoweredType({ kind: LoweredTypeKind.voidType, name: "" });
  if (identity == "boolean") return LoweredType({ kind: LoweredTypeKind.booleanType, name: "" });
  if (identity == "i8") return LoweredType({ kind: LoweredTypeKind.i8Type, name: "" });
  if (identity == "i16") return LoweredType({ kind: LoweredTypeKind.i16Type, name: "" });
  if (identity == "i32") return LoweredType({ kind: LoweredTypeKind.i32Type, name: "" });
  if (identity == "i64") return LoweredType({ kind: LoweredTypeKind.i64Type, name: "" });
  if (identity == "u8") return LoweredType({ kind: LoweredTypeKind.u8Type, name: "" });
  if (identity == "u16") return LoweredType({ kind: LoweredTypeKind.u16Type, name: "" });
  if (identity == "u32") return LoweredType({ kind: LoweredTypeKind.u32Type, name: "" });
  if (identity == "u64") return LoweredType({ kind: LoweredTypeKind.u64Type, name: "" });
  if (identity == "isize") return LoweredType({ kind: LoweredTypeKind.isizeType, name: "" });
  if (identity == "usize") return LoweredType({ kind: LoweredTypeKind.usizeType, name: "" });
  if (identity == "f32") return LoweredType({ kind: LoweredTypeKind.f32Type, name: "" });
  if (identity == "f64") return LoweredType({ kind: LoweredTypeKind.f64Type, name: "" });
  if (identity == "String") return LoweredType({ kind: LoweredTypeKind.stringType, name: "String" });
  if (identity == "Arena") return LoweredType({ kind: LoweredTypeKind.arenaType, name: "Arena" });
  if (identity == "cstring") return LoweredType({ kind: LoweredTypeKind.cstringType, name: "cstring" });
  if (
    identity.byteLength > 5
    && identity.copyBytes(identity.byteLength - 5, identity.byteLength)
      == "_weak"
  ) return LoweredType({
    kind: LoweredTypeKind.weakType,
    name: identity.copyBytes(0, identity.byteLength),
  });
  for (const declaration of program.fixedArrays) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.fixedArrayType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.arrays) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.arrayType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.slices) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.sliceType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.maps) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.mapType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.sets) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.setType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.structs) {
    if (declaration.name == identity) return LoweredType({
      kind: declaration.referenceType
        ? LoweredTypeKind.classType
        : LoweredTypeKind.structType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  for (const declaration of program.enums) {
    if (declaration.name == identity) return LoweredType({
      kind: LoweredTypeKind.enumType,
      name: identity.copyBytes(0, identity.byteLength),
    });
  }
  throw `native C emission cannot resolve intrinsic type identity ${identity}`;
}

function arenaTypeSymbol(in identity: String): String {
  let output = TextBuffer();
  output.append(`${identity.byteLength}_`);
  let index: usize = 0;
  while (index < identity.byteLength) {
    const byte = identity.byteAt(index);
    if (
      (byte >= 48 && byte <= 57)
      || (byte >= 65 && byte <= 90)
      || (byte >= 97 && byte <= 122)
      || byte == 95
    ) output.appendAscii(byte);
    else output.append(`_${byte}_`);
    index = index + 1;
  }
  return output.finish();
}

function collectArenaValueTypes(
  in program: LoweredProgram,
  in expressions: Array<LoweredExpression>,
  inout values: Array<LoweredType>
): void throws String {
  for (const expression of expressions) {
    if (expression.kind != LoweredExpressionKind.arenaCreate) continue;
    const type = try loweredTypeForIdentity(program, expression.value);
    let present = false;
    for (const candidate of values) {
      if (candidate.kind == type.kind && candidate.name == type.name) {
        present = true;
      }
    }
    if (!present) values.push(type);
  }
}

function programArenaValueTypes(
  in program: LoweredProgram
): Array<LoweredType> throws String {
  let values = Array<LoweredType>();
  for (const declaration of program.functions) {
    try collectArenaValueTypes(
      program,
      declaration.expressions,
      inout values
    );
  }
  for (const aggregate of program.structs) {
    match (in aggregate.deinitializer) {
      some(deinitializer) => try collectArenaValueTypes(
        program,
        deinitializer.expressions,
        inout values
      );
      none => {}
    }
  }
  return values;
}

function expressionsUseArena(
  in expressions: Array<LoweredExpression>
): boolean {
  for (const expression of expressions) {
    if (
      expression.kind == LoweredExpressionKind.arenaNew
      || expression.kind == LoweredExpressionKind.arenaCreate
      || expression.kind == LoweredExpressionKind.arenaReset
    ) return true;
  }
  return false;
}

function programUsesArena(in program: LoweredProgram): boolean {
  for (const constant of program.constants) {
    if (constant.type.kind == LoweredTypeKind.arenaType) return true;
  }
  for (const aggregate of program.structs) {
    for (const field of aggregate.fields) {
      if (field.type.kind == LoweredTypeKind.arenaType) return true;
    }
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        if (expressionsUseArena(deinitializer.expressions)) return true;
      }
      none => {}
    }
  }
  for (const declaration of program.functions) {
    if (declaration.returnType.kind == LoweredTypeKind.arenaType) return true;
    for (const parameter of declaration.parameters) {
      if (parameter.type.kind == LoweredTypeKind.arenaType) return true;
    }
    for (const statement of declaration.statements) {
      match (in statement.type) {
        some(type) => {
          if (type.kind == LoweredTypeKind.arenaType) return true;
        }
        none => {}
      }
    }
    if (expressionsUseArena(declaration.expressions)) return true;
  }
  return false;
}

function mutexValueType(
  in program: LoweredProgram,
  in mutexName: String
): LoweredType throws String {
  const prefix = "Mutex_";
  if (!stringStartsWith(mutexName, prefix)) {
    throw `native C emission received malformed Mutex identity ${mutexName}`;
  }
  const identity = mutexName.copyBytes(prefix.byteLength, mutexName.byteLength);
  return try loweredTypeForIdentity(program, identity);
}

function taskResultType(
  in program: LoweredProgram,
  in taskName: String
): LoweredType throws String {
  const prefix = "Task_";
  if (!stringStartsWith(taskName, prefix)) {
    throw `native C emission received malformed Task identity ${taskName}`;
  }
  const identity = taskName.copyBytes(
    prefix.byteLength,
    taskName.byteLength
  );
  return try loweredTypeForIdentity(program, identity);
}

function awaitedTaskName(
  in declaration: LoweredFunction,
  index: usize
): String throws String {
  if (declaration.expressions[index].value.byteLength > 0) {
    return declaration.expressions[index].value.copyBytes(
      0,
      declaration.expressions[index].value.byteLength
    );
  }
  if (declaration.expressions[index].children.length != 1) {
    throw "native C emission received malformed thread await";
  }
  const taskExpression = declaration.expressions[index].children[0];
  if (
    declaration.expressions[taskExpression].kind
      != LoweredExpressionKind.localValue
  ) throw "native thread await currently requires a named Task<T> binding";
  const bindingName = view declaration.expressions[taskExpression].value;
  for (const statement of declaration.statements) {
    if (
      statement.kind != LoweredStatementKind.localStatement
      || statement.name != bindingName
    ) continue;
    match (in statement.type) {
      some(type) => {
        if (type.kind == LoweredTypeKind.taskType) {
          return type.name.copyBytes(0, type.name.byteLength);
        }
      }
      none => {}
    }
  }
  throw `native thread await could not resolve Task<T> binding ${bindingName}`;
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

function appendModuleConstants(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.constants) {
    if (declaration.type.kind == LoweredTypeKind.stringType) {
      output.append("static __attribute__((unused)) const Z_String ");
      appendCBindingName(inout output, declaration.name);
      output.append(" = { .data = ");
      appendCStringLiteral(inout output, declaration.value);
      output.append(", .length = sizeof(");
      appendCStringLiteral(inout output, declaration.value);
      output.append(") - 1, .capacity = 0 };\n");
      continue;
    }
    if (declaration.type.kind == LoweredTypeKind.cstringType) {
      output.append("static __attribute__((unused)) const char * const ");
      appendCBindingName(inout output, declaration.name);
      output.append(" = ");
      appendCStringLiteral(inout output, declaration.value);
      output.append(";\n");
      continue;
    }
    if (declaration.type.kind == LoweredTypeKind.onceType) {
      output.append("#if defined(_WIN32)\nstatic __attribute__((unused)) Z_");
      output.append(declaration.type.name);
      output.append(" ");
      appendCBindingName(inout output, declaration.name);
      output.append(" = { .native = SRWLOCK_INIT, .value = NULL, .state = 0 };\n#else\nstatic __attribute__((unused)) Z_");
      output.append(declaration.type.name);
      output.append(" ");
      appendCBindingName(inout output, declaration.name);
      output.append(" = { .native = PTHREAD_MUTEX_INITIALIZER, .value = NULL, .state = 0 };\n#endif\n");
      continue;
    }
    output.append("static __attribute__((unused)) const ");
    const nativeType = try cType(declaration.type);
    output.append(nativeType);
    output.append(" ");
    appendCBindingName(inout output, declaration.name);
    output.append(" = ");
    output.append(declaration.value);
    output.append(";\n");
  }
  if (program.constants.length > 0) output.append("\n");
}

function appendWeakRuntime(inout output: TextBuffer): void {
  output.append("typedef struct Z_WeakControl {\n");
  output.append("  void *value;\n");
  output.append("  size_t weak_count;\n");
  output.append("} Z_WeakControl;\n\n");
  output.append("typedef struct Z_Weak {\n");
  output.append("  Z_WeakControl *control;\n");
  output.append("} Z_Weak;\n\n");
  output.append("typedef struct Z_WeakExpired {\n");
  output.append("  unsigned char _z_empty;\n");
  output.append("} Z_WeakExpired;\n\n");
  output.append("static inline __attribute__((unused)) Z_Weak z_weak_retain(Z_Weak value) {\n");
  output.append("  if (value.control != NULL) value.control->weak_count += 1;\n");
  output.append("  return value;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_weak_release(Z_Weak value) {\n");
  output.append("  if (value.control == NULL) return;\n");
  output.append("  value.control->weak_count -= 1;\n");
  output.append("  if (value.control->weak_count == 0) free(value.control);\n");
  output.append("}\n\n");
}

function appendClassFinalizationBody(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in aggregate: LoweredStruct,
  depth: usize
): void throws String {
  appendIndent(inout output, depth);
  output.append("Z_WeakControl *_z_stage1_weak_control = self->_z_weak;\n");
  appendIndent(inout output, depth);
  output.append("if (_z_stage1_weak_control != NULL) _z_stage1_weak_control->value = NULL;\n");
  match (in aggregate.deinitializer) {
    some(deinitializer) => {
      for (const root of deinitializer.roots) {
        try appendStatement(inout output, deinitializer, root, depth);
      }
      appendCleanups(
        inout output,
        deinitializer.fallthroughCleanups,
        depth
      );
    }
    none => {}
  }
  let cleanup = aggregate.fields.length;
  while (cleanup > 0) {
    cleanup = cleanup - 1;
    if (aggregate.fields[cleanup].borrowedView) continue;
    if (
      aggregate.fields[cleanup].type.kind
        == LoweredTypeKind.foreignObjCType
    ) {
      appendIndent(inout output, depth);
      output.append("self->");
      output.append(aggregate.fields[cleanup].name);
      output.append(" = nil;\n");
      continue;
    }
    if (!loweredTypeNeedsDeinit(program, aggregate.fields[cleanup].type)) {
      continue;
    }
    appendIndent(inout output, depth);
    output.append("Z_");
    output.append(aggregate.fields[cleanup].type.name);
    if (aggregate.fields[cleanup].type.kind == LoweredTypeKind.classType) {
      output.append("_release(self->");
      output.append(aggregate.fields[cleanup].name);
      output.append(");\n");
    } else {
      output.append("_deinit(&self->");
      output.append(aggregate.fields[cleanup].name);
      output.append(");\n");
    }
  }
  appendIndent(inout output, depth);
  output.append("if (_z_stage1_weak_control != NULL) {\n");
  appendIndent(inout output, depth + 1);
  output.append("_z_stage1_weak_control->weak_count -= 1;\n");
  appendIndent(inout output, depth + 1);
  output.append("if (_z_stage1_weak_control->weak_count == 0) free(_z_stage1_weak_control);\n");
  appendIndent(inout output, depth);
  output.append("}\n");
  appendIndent(inout output, depth);
  output.append("free(self);\n");
}

function appendClassAndOnceRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  const mutexNames = programMutexTypeNames(program);
  for (const mutexName of mutexNames) {
    const valueType = try mutexValueType(program, mutexName);
    const nativeValueType = try cType(valueType);
    output.append("static __attribute__((unused)) Z_");
    output.append(mutexName);
    output.append(" Z_");
    output.append(mutexName);
    output.append("_new(");
    output.append(nativeValueType);
    output.append(" value);\n");
    output.append("static __attribute__((unused)) Z_");
    output.append(mutexName);
    output.append(" Z_");
    output.append(mutexName);
    output.append("_retain(Z_");
    output.append(mutexName);
    output.append(" mutex);\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(mutexName);
    output.append("_deinit(Z_");
    output.append(mutexName);
    output.append(" *mutex);\n");
  }
  if (mutexNames.length > 0) output.append("\n");
  for (const aggregate of program.structs) {
    if (!aggregate.referenceType) continue;
    output.append("static __attribute__((unused)) Z_");
    output.append(aggregate.name);
    output.append(" *Z_");
    output.append(aggregate.name);
    output.append("_new(");
    let field: usize = 0;
    while (field < aggregate.fields.length) {
      if (field > 0) output.append(", ");
      const fieldType = try cType(aggregate.fields[field].type);
      output.append(fieldType);
      output.append(" ");
      appendCBindingName(inout output, aggregate.fields[field].name);
      field = field + 1;
    }
    if (aggregate.fields.length == 0) output.append("void");
    output.append(") {\n  Z_");
    output.append(aggregate.name);
    output.append(" *_z_stage1_instance = (Z_");
    output.append(aggregate.name);
    output.append(" *)calloc(1, sizeof(Z_");
    output.append(aggregate.name);
    output.append("));\n  if (_z_stage1_instance == NULL) abort();\n");
    output.append("  _z_stage1_instance->_z_refcount = 1;\n");
    output.append("  _z_stage1_instance->_z_weak = NULL;\n");
    for (const item of aggregate.fields) {
      output.append("  _z_stage1_instance->");
      output.append(item.name);
      output.append(" = ");
      appendCBindingName(inout output, item.name);
      output.append(";\n");
    }
    output.append("  return _z_stage1_instance;\n}\n\n");
    output.append("static inline __attribute__((unused)) Z_");
    output.append(aggregate.name);
    output.append(" *Z_");
    output.append(aggregate.name);
    output.append("_retain(const Z_");
    output.append(aggregate.name);
    output.append(" *borrowed) {\n  Z_");
    output.append(aggregate.name);
    output.append(" *value = (Z_");
    output.append(aggregate.name);
    output.append(" *)borrowed;\n  if (value != NULL) (void)__atomic_add_fetch(&value->_z_refcount, 1, __ATOMIC_RELAXED);\n  return value;\n}\n\n");
    output.append("static inline __attribute__((unused)) Z_Weak Z_");
    output.append(aggregate.name);
    output.append("_weak_retain(Z_Weak value) {\n  return z_weak_retain(value);\n}\n\n");
    output.append("static inline __attribute__((unused)) void Z_");
    output.append(aggregate.name);
    output.append("_weak_deinit(const Z_Weak *value) {\n  if (value == NULL) return;\n  z_weak_release(*value);\n}\n\n");
    output.append("static __attribute__((unused)) Z_Weak Z_");
    output.append(aggregate.name);
    output.append("_weak(Z_");
    output.append(aggregate.name);
    output.append(" *value) {\n  if (value == NULL) abort();\n  if (value->_z_weak == NULL) {\n    value->_z_weak = (Z_WeakControl *)malloc(sizeof(Z_WeakControl));\n    if (value->_z_weak == NULL) abort();\n    value->_z_weak->value = value;\n    value->_z_weak->weak_count = 1;\n  }\n  Z_Weak weak = { .control = value->_z_weak };\n  weak.control->weak_count += 1;\n  return weak;\n}\n\n");
    const weakResultName = `__z_Result_${aggregate.name}_WeakExpired`;
    let emitsWeakUpgrade = false;
    for (const enumeration of program.enums) {
      if (enumeration.name == weakResultName) emitsWeakUpgrade = true;
    }
    if (emitsWeakUpgrade) {
      output.append("static __attribute__((unused)) Z_");
      output.append(weakResultName);
      output.append(" Z_");
      output.append(aggregate.name);
      output.append("_weak_upgrade(Z_Weak weak) {\n  if (weak.control == NULL || weak.control->value == NULL) {\n    return (Z_");
      output.append(weakResultName);
      output.append("){ .tag = Z_");
      output.append(weakResultName);
      output.append("Tag_failure, .payload.failure = (Z_WeakExpired){0} };\n  }\n  Z_");
      output.append(aggregate.name);
      output.append(" *value = (Z_");
      output.append(aggregate.name);
      output.append(" *)weak.control->value;\n  return (Z_");
      output.append(weakResultName);
      output.append("){ .tag = Z_");
      output.append(weakResultName);
      output.append("Tag_success, .payload.success = Z_");
      output.append(aggregate.name);
      output.append("_retain(value) };\n}\n\n");
    }
    if (aggregate.executorBound) {
      output.append("static void Z_");
      output.append(aggregate.name);
      output.append("_finalize_executor_bound(void *opaque) {\n  Z_");
      output.append(aggregate.name);
      output.append(" *self = (Z_");
      output.append(aggregate.name);
      output.append(" *)opaque;\n");
      try appendClassFinalizationBody(inout output, program, aggregate, 1);
      output.append("}\n\n");
    }
    output.append("static __attribute__((unused)) void Z_");
    output.append(aggregate.name);
    output.append("_release(Z_");
    output.append(aggregate.name);
    output.append(" *self) {\n  if (self == NULL) return;\n");
    output.append("  const size_t previous = __atomic_fetch_sub(&self->_z_refcount, 1, __ATOMIC_ACQ_REL);\n");
    output.append("  if (previous == 0) abort();\n");
    output.append("  if (previous != 1) return;\n");
    if (aggregate.executorBound) {
      output.append("  if (z_executor_bound_release_enqueue != NULL) {\n");
      output.append("    z_executor_bound_release_enqueue(\n");
      output.append("      z_executor_bound_release_context,\n");
      output.append("      self,\n      Z_");
      output.append(aggregate.name);
      output.append("_finalize_executor_bound\n    );\n    return;\n  }\n  Z_");
      output.append(aggregate.name);
      output.append("_finalize_executor_bound(self);\n");
    } else {
      try appendClassFinalizationBody(inout output, program, aggregate, 1);
    }
    output.append("}\n\n");
  }
  const onceNames = programOnceTypeNames(program);
  for (const onceName of onceNames) {
    const prefix = "Once_";
    const valueName = onceName.copyBytes(
      prefix.byteLength,
      onceName.byteLength
    );
    output.append("static __attribute__((unused)) Z_OnceLifetime_");
    output.append(valueName);
    output.append(" Z_");
    output.append(onceName);
    output.append("_initialize(Z_");
    output.append(onceName);
    output.append(" *cell, Z_");
    output.append(valueName);
    output.append(" *value) {\n");
    output.append("  if (cell == NULL || value == NULL) { fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> cannot initialize an invalid value\\n\"); abort(); }\n");
    output.append("#if defined(_WIN32)\n  AcquireSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_lock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  if (cell->state != 0) {\n");
    output.append("    if (cell->state == 2) fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> lifetime has already closed and cannot reinitialize\\n\");\n");
    output.append("    else fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> is already initialized and cannot reinitialize\\n\");\n");
    output.append("    abort();\n  }\n");
    output.append("  cell->value = value;\n  cell->state = 1;\n");
    output.append("#if defined(_WIN32)\n  ReleaseSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_unlock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  return (Z_OnceLifetime_");
    output.append(valueName);
    output.append("){ .cell = cell };\n}\n\n");
    output.append("static __attribute__((unused)) Z_");
    output.append(valueName);
    output.append(" *Z_");
    output.append(onceName);
    output.append("_get(Z_");
    output.append(onceName);
    output.append(" *cell) {\n");
    output.append("  if (cell == NULL) { fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> received an invalid cell\\n\"); abort(); }\n");
    output.append("#if defined(_WIN32)\n  AcquireSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_lock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  if (cell->state != 1 || cell->value == NULL) {\n");
    output.append("    if (cell->state == 0) fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> has not been initialized\\n\");\n");
    output.append("    else if (cell->state == 2) fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> lifetime has already closed\\n\");\n");
    output.append("    else fprintf(stderr, \"Once<");
    output.append(valueName);
    output.append("> has invalid runtime state\\n\");\n");
    output.append("    abort();\n  }\n");
    output.append("  Z_");
    output.append(valueName);
    output.append(" *value = cell->value;\n  Z_");
    output.append(valueName);
    output.append("_retain(value);\n");
    output.append("#if defined(_WIN32)\n  ReleaseSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_unlock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  return value;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_OnceLifetime_");
    output.append(valueName);
    output.append("_deinit(Z_OnceLifetime_");
    output.append(valueName);
    output.append(" *lifetime) {\n");
    output.append("  if (lifetime == NULL || lifetime->cell == NULL) return;\n");
    output.append("  Z_");
    output.append(onceName);
    output.append(" *cell = lifetime->cell;\n  lifetime->cell = NULL;\n");
    output.append("#if defined(_WIN32)\n  AcquireSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_lock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  if (cell->state != 1 || cell->value == NULL) abort();\n");
    output.append("  Z_");
    output.append(valueName);
    output.append(" *value = cell->value;\n");
    output.append("  cell->value = NULL;\n  cell->state = 2;\n");
    output.append("#if defined(_WIN32)\n  ReleaseSRWLockExclusive(&cell->native);\n#else\n  if (pthread_mutex_unlock(&cell->native) != 0) abort();\n#endif\n");
    output.append("  Z_");
    output.append(valueName);
    output.append("_release(value);\n}\n\n");
  }
  for (const mutexName of mutexNames) {
    const valueType = try mutexValueType(program, mutexName);
    const nativeValueType = try cType(valueType);
    output.append("static __attribute__((unused)) Z_");
    output.append(mutexName);
    output.append(" Z_");
    output.append(mutexName);
    output.append("_new(");
    output.append(nativeValueType);
    output.append(" value) {\n  Z_");
    output.append(mutexName);
    output.append("Storage *storage = (Z_");
    output.append(mutexName);
    output.append("Storage *)calloc(1, sizeof(Z_");
    output.append(mutexName);
    output.append("Storage));\n  if (storage == NULL) abort();\n");
    output.append("#if defined(_WIN32)\n  InitializeSRWLock(&storage->native);\n#else\n");
    output.append("  if (pthread_mutex_init(&storage->native, NULL) != 0) { free(storage); abort(); }\n#endif\n");
    output.append("  storage->refcount = 1;\n  storage->value = value;\n  return (Z_");
    output.append(mutexName);
    output.append("){ .storage = storage };\n}\n\n");
    output.append("static __attribute__((unused)) Z_");
    output.append(mutexName);
    output.append(" Z_");
    output.append(mutexName);
    output.append("_retain(Z_");
    output.append(mutexName);
    output.append(" mutex) {\n  if (mutex.storage == NULL) abort();\n");
    output.append("  __atomic_add_fetch(&mutex.storage->refcount, 1, __ATOMIC_RELAXED);\n  return mutex;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(mutexName);
    output.append("_deinit(Z_");
    output.append(mutexName);
    output.append(" *mutex) {\n  if (mutex == NULL || mutex->storage == NULL) return;\n  Z_");
    output.append(mutexName);
    output.append("Storage *storage = mutex->storage;\n  mutex->storage = NULL;\n");
    output.append("  if (__atomic_sub_fetch(&storage->refcount, 1, __ATOMIC_ACQ_REL) != 0) return;\n");
    output.append("#if !defined(_WIN32)\n  if (pthread_mutex_destroy(&storage->native) != 0) abort();\n#endif\n");
    if (loweredTypeNeedsDeinit(program, valueType)) {
      if (valueType.kind == LoweredTypeKind.classType) {
        output.append("  Z_");
        output.append(valueType.name);
        output.append("_release(storage->value);\n");
      } else {
        output.append("  Z_");
        output.append(valueType.name);
        output.append("_deinit(&storage->value);\n");
      }
    }
    output.append("  free(storage);\n}\n\n");
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
    if (cleanups[remaining].type.kind == LoweredTypeKind.classType) {
      output.append("Z_");
      output.append(cleanups[remaining].type.name);
      output.append("_release(");
      appendCBindingName(inout output, cleanups[remaining].name);
      output.append(");\n");
      continue;
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
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.foreignCallbackValue
  ) {
    if (declaration.expressions[index].labels.length < 2) {
      throw "native C callback lowering lost its ABI role";
    }
    const role = declaration.expressions[index].labels[0].copyBytes(
      0,
      declaration.expressions[index].labels[0].byteLength
    );
    const lifetime = declaration.expressions[index].labels[1].copyBytes(
      0,
      declaration.expressions[index].labels[1].byteLength
    );
    if (role == "callbackAdapter") {
      output.append("z_stage1_c_callback_Z_");
      output.append(declaration.expressions[index].value);
      return;
    }
    if (role == "callbackRelease") {
      output.append("Z_");
      output.append(declaration.expressions[index].value);
      output.append("_c_escape_box_release");
      return;
    }
    if (role == "callbackContext") {
      if (declaration.expressions[index].children.length != 1) {
        throw "native C callback context lost its Z closure value";
      }
      const callbackValue = declaration.expressions[index].children[0];
      if (lifetime == "escaping") {
        output.append("Z_");
        output.append(declaration.expressions[index].value);
        output.append("_c_escape_box(");
        try appendExpression(
          inout output,
          declaration,
          callbackValue
        );
        output.append(")");
        return;
      }
      throw "native fixed-point C emission does not execute call-scoped callback contexts yet";
    }
    if (role == "callbackDirect") {
      throw "native fixed-point C emission does not execute context-free callbacks yet";
    }
    throw `native C callback lowering has unknown ABI role "${role}"`;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.receiverValue) {
    let classReceiver = false;
    let valueReceiver = false;
    match (in declaration.receiverType) {
      some(type) => {
        classReceiver = type.kind == LoweredTypeKind.classType;
        valueReceiver = declaration.receiverMode == LoweredParameterMode.value;
      }
      none => {}
    }
    if (classReceiver) output.append("self");
    else if (valueReceiver) output.append("self");
    else output.append("(*self)");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.localValue) {
    appendCBindingName(inout output, declaration.expressions[index].value);
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.directFunctionValue
    || declaration.expressions[index].kind
      == LoweredExpressionKind.closureValue
  ) {
    output.append("z_stage1_callable_");
    appendCBindingName(inout output, declaration.name);
    output.append("_");
    output.append(`${index}`);
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.closureValue
      && declaration.expressions[index].captureTypes.length > 0
    ) {
      output.append("_make(");
      let capture: usize = 1;
      while (capture < declaration.expressions[index].children.length) {
        if (capture > 1) output.append(", ");
        const value = declaration.expressions[index].children[capture];
        try appendExpression(inout output, declaration, value);
        capture = capture + 1;
      }
      output.append(")");
    } else output.append("_value");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.integerValue) {
    if (
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "u64"
    ) {
      output.append("UINT64_C(");
      output.append(declaration.expressions[index].value);
      output.append(")");
      return;
    }
    output.append(declaration.expressions[index].value);
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.booleanValue) {
    output.append(declaration.expressions[index].value);
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.nullValue) {
    output.append("NULL");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.parameterValue
  ) {
    let foreignObjCParameter =
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "foreignObjC";
    for (const parameter of declaration.parameters) {
      if (
        parameter.name == declaration.expressions[index].value
        && parameter.mode == LoweredParameterMode.input
        && parameter.type.kind == LoweredTypeKind.foreignObjCType
      ) foreignObjCParameter = true;
    }
    if (foreignObjCParameter) {
      appendCBindingName(inout output, declaration.expressions[index].value);
      return;
    }
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
    declaration.expressions[index].kind
      == LoweredExpressionKind.cstringProjection
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed cstring projection";
    }
    output.append("z_stage1_string_cstring(");
    const value = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, value);
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
        || declaration.expressions[index].labels[part] == "view String"
      ) {
        output.append("Z_TEMPLATE_STRING, .value.string_value = ");
      } else if (
        declaration.expressions[index].labels[part] == "boolean"
      ) {
        output.append("Z_TEMPLATE_BOOLEAN, .value.boolean_value = ");
      } else if (declaration.expressions[index].labels[part] == "i32") {
        output.append("Z_TEMPLATE_I32, .value.i32_value = ");
      } else if (declaration.expressions[index].labels[part] == "i64") {
        output.append("Z_TEMPLATE_I64, .value.i64_value = ");
      } else if (declaration.expressions[index].labels[part] == "u8") {
        output.append("Z_TEMPLATE_U8, .value.u8_value = ");
      } else if (declaration.expressions[index].labels[part] == "u64") {
        output.append("Z_TEMPLATE_U64, .value.u64_value = ");
      } else if (declaration.expressions[index].labels[part] == "usize") {
        output.append("Z_TEMPLATE_USIZE, .value.usize_value = ");
      } else if (declaration.expressions[index].labels[part] == "f64") {
        output.append("Z_TEMPLATE_F64, .value.f64_value = ");
      } else {
        throw "native C emission cannot format this template value type";
      }
      const value = declaration.expressions[index].children[part];
      const viewString =
        declaration.expressions[index].labels[part] == "view String";
      if (viewString) output.append("(*(");
      try appendExpression(inout output, declaration, value);
      if (viewString) output.append("))");
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
    declaration.expressions[index].kind == LoweredExpressionKind.arrayValue
  ) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received an empty populated Array";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_from((__typeof__(");
    const first = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, first);
    output.append(")[]){");
    let childIndex: usize = 0;
    while (childIndex < declaration.expressions[index].children.length) {
      if (childIndex > 0) output.append(", ");
      const child = declaration.expressions[index].children[childIndex];
      try appendExpression(
        inout output,
        declaration,
        child
      );
      childIndex = childIndex + 1;
    }
    output.append("}, ");
    output.append(`${declaration.expressions[index].children.length}`);
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.fixedArrayValue
  ) {
    output.append("(Z_");
    output.append(declaration.expressions[index].value);
    output.append("){ .data = {");
    let childIndex: usize = 0;
    while (childIndex < declaration.expressions[index].children.length) {
      if (childIndex > 0) output.append(", ");
      const child = declaration.expressions[index].children[childIndex];
      try appendExpression(inout output, declaration, child);
      childIndex = childIndex + 1;
    }
    output.append("} }");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.arrayRequireLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Array length requirement";
    }
    const receiver = declaration.expressions[index].children[0];
    output.append("((");
    try appendExpression(inout output, declaration, receiver);
    output.append(")->length < ");
    output.append(declaration.expressions[index].value);
    output.append(" ? abort() : (void)0)");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arraySlice
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed Array Slice projection";
    }
    const receiver = declaration.expressions[index].children[0];
    const offset = declaration.expressions[index].children[1];
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_slice_unchecked(");
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append(", ");
    try appendExpression(
      inout output,
      declaration,
      offset
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.arrayLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Array.length";
    }
    const receiver = declaration.expressions[index].children[0];
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    output.append("(");
    try appendExpression(inout output, declaration, receiver);
    if (viewReceiver) output.append(")->length");
    else output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.fixedArrayLength
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed fixed-array length";
    }
    output.append("((void)(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append("), (size_t)");
    output.append(declaration.expressions[index].value);
    output.append(")");
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
    const receiver = declaration.expressions[index].children[0];
    const offset = declaration.expressions[index].children[1];
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    const boundsProven = labelsContain(
      declaration.expressions[index].labels,
      "bounds-proven"
    );
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.arrayMutableIndex
    ) {
      if (viewReceiver) {
        throw "native C emission cannot mutate through a view Array";
      }
      output.append("_at_mut(&(");
    } else {
      if (viewReceiver) {
        if (boundsProven) output.append("_at_unchecked(");
        else output.append("_at(");
      }
      else output.append("_at(&(");
    }
    try appendExpression(inout output, declaration, receiver);
    if (viewReceiver) output.append(", ");
    else output.append("), ");
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
    if (
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view"
    ) {
      output.append(")->length");
    } else output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.mapHas
    || declaration.expressions[index].kind == LoweredExpressionKind.mapGet
    || declaration.expressions[index].kind == LoweredExpressionKind.mapSet
    || declaration.expressions[index].kind == LoweredExpressionKind.mapRemove
    || declaration.expressions[index].kind == LoweredExpressionKind.mapDelete
    || declaration.expressions[index].kind == LoweredExpressionKind.mapClear
  ) {
    let expected: usize = 2;
    if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapSet
    ) expected = 3;
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapClear
    ) expected = 1;
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
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapRemove
    ) output.append("_remove");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapDelete
    ) output.append("_delete");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.mapClear
    ) output.append("_clear");
    else output.append("_set");
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    if (viewReceiver) output.append("(");
    else output.append("(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    if (expected > 1) {
      if (viewReceiver) output.append(", ");
      else output.append("), ");
      const key = declaration.expressions[index].children[1];
      try appendExpression(inout output, declaration, key);
    } else {
      if (viewReceiver) output.append(")");
      else output.append("))");
      return;
    }
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
    if (
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view"
    ) {
      output.append(")->length");
    } else output.append(").length");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.setHas
    || declaration.expressions[index].kind == LoweredExpressionKind.setAdd
    || declaration.expressions[index].kind == LoweredExpressionKind.setRemove
    || declaration.expressions[index].kind == LoweredExpressionKind.setDelete
    || declaration.expressions[index].kind == LoweredExpressionKind.setClear
  ) {
    const expected = declaration.expressions[index].kind
      == LoweredExpressionKind.setClear ? usize(1) : usize(2);
    if (declaration.expressions[index].children.length != expected) {
      throw "native C emission received a malformed Set method call";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    if (
      declaration.expressions[index].kind == LoweredExpressionKind.setAdd
    ) output.append("_add");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.setRemove
    ) output.append("_remove");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.setDelete
    ) output.append("_delete");
    else if (
      declaration.expressions[index].kind == LoweredExpressionKind.setClear
    ) output.append("_clear");
    else output.append("_has");
    const receiver = declaration.expressions[index].children[0];
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    if (viewReceiver) output.append("(");
    else output.append("(&(");
    try appendExpression(inout output, declaration, receiver);
    if (expected > 1) {
      if (viewReceiver) output.append(", ");
      else output.append("), ");
      const value = declaration.expressions[index].children[1];
      try appendExpression(inout output, declaration, value);
    } else {
      if (viewReceiver) output.append(")");
      else output.append("))");
      return;
    }
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
    declaration.expressions[index].kind == LoweredExpressionKind.hasherAdd
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed Hasher.add";
    }
    const receiver = declaration.expressions[index].children[0];
    const value = declaration.expressions[index].children[1];
    const customHashable = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "hashable";
    if (customHashable) {
      output.append("Z_");
      output.append(declaration.expressions[index].value);
      output.append("_hash(&(");
      try appendExpression(inout output, declaration, value);
      output.append("), &(");
      try appendExpression(inout output, declaration, receiver);
      output.append("))");
      return;
    }
    if (declaration.expressions[index].value == "String") {
      output.append("z_hasher_add_string(&(");
      try appendExpression(inout output, declaration, receiver);
      output.append("), ");
      try appendExpression(inout output, declaration, value);
      output.append(")");
      return;
    }
    output.append("z_hasher_add_u64(&(");
    try appendExpression(inout output, declaration, receiver);
    output.append("), (uint64_t)(");
    try appendExpression(inout output, declaration, value);
    output.append("))");
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
    if (
      declaration.expressions[index].value.byteLength == 0
      || declaration.expressions[index].value == "String"
      || declaration.expressions[index].value == "copy"
    ) output.append("z_string_copy(");
    else {
      output.append("z_stage1_copy_");
      output.append(declaration.expressions[index].value);
      output.append("(");
    }
    const operand = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.emptyValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed empty value";
    }
    output.append("(__typeof__(");
    const storage = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, storage);
    output.append(")){0}");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.retainValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed retain expression";
    }
    const operand = declaration.expressions[index].children[0];
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_retain(");
    try appendExpression(inout output, declaration, operand);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.weakValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed weak expression";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_weak(");
    const targetExpressionIndex: usize =
      declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      targetExpressionIndex
    );
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.weakUpgrade) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed weak upgrade";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_weak_upgrade(");
    const observerExpressionIndex: usize =
      declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      observerExpressionIndex
    );
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
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.optionalFieldValue
  ) {
    if (
      declaration.expressions[index].children.length != 1
      || declaration.expressions[index].labels.length != 3
    ) {
      throw "native C emission received a malformed optional field projection";
    }
    const optionalSource = declaration.expressions[index].children[0];
    output.append("((");
    try appendExpression(inout output, declaration, optionalSource);
    output.append(").tag == Z_");
    output.append(declaration.expressions[index].labels[0]);
    output.append("Tag_some ? ");
    if (declaration.expressions[index].labels[2] == "wrap") {
      output.append("(Z_");
      output.append(declaration.expressions[index].value);
      output.append("){.tag = Z_");
      output.append(declaration.expressions[index].value);
      output.append("Tag_some, .payload.some = ");
    } else if (
      declaration.expressions[index].labels[2] != "flatten"
    ) {
      throw "native C emission received an unknown optional field mode";
    }
    output.append("(");
    try appendExpression(inout output, declaration, optionalSource);
    output.append(").payload.some.");
    output.append(declaration.expressions[index].labels[1]);
    if (declaration.expressions[index].labels[2] == "wrap") {
      output.append("}");
    }
    output.append(" : (Z_");
    output.append(declaration.expressions[index].value);
    output.append("){.tag = Z_");
    output.append(declaration.expressions[index].value);
    output.append("Tag_none})");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.optionFromNullable
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received a malformed Option.fromNullable expression";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_from_nullable(");
    const nullableValue = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      nullableValue
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.optionalCallValue
  ) {
    if (
      declaration.expressions[index].children.length != 2
      || declaration.expressions[index].labels.length != 3
      || declaration.expressions[index].labels[1] != "String.byteAt"
      || declaration.expressions[index].labels[2] != "wrap"
    ) {
      throw "native C emission received a malformed optional call";
    }
    const optionalCallSource = declaration.expressions[index].children[0];
    const optionalCallArgument = declaration.expressions[index].children[1];
    output.append("((");
    try appendExpression(inout output, declaration, optionalCallSource);
    output.append(").tag == Z_");
    output.append(declaration.expressions[index].labels[0]);
    output.append("Tag_some ? (Z_");
    output.append(declaration.expressions[index].value);
    output.append("){.tag = Z_");
    output.append(declaration.expressions[index].value);
    output.append("Tag_some, .payload.some = z_string_byte_at((");
    try appendExpression(inout output, declaration, optionalCallSource);
    output.append(").payload.some, ");
    try appendExpression(inout output, declaration, optionalCallArgument);
    output.append(")} : (Z_");
    output.append(declaration.expressions[index].value);
    output.append("){.tag = Z_");
    output.append(declaration.expressions[index].value);
    output.append("Tag_none})");
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
    const leftView = declaration.expressions[index].labels.length == 2
      && declaration.expressions[index].labels[0] == "view";
    const rightView = declaration.expressions[index].labels.length == 2
      && declaration.expressions[index].labels[1] == "view";
    if (leftView) output.append("(*(");
    try appendExpression(
      inout output,
      declaration,
      left
    );
    if (leftView) output.append("))");
    output.append(", ");
    if (rightView) output.append("(*(");
    try appendExpression(
      inout output,
      declaration,
      right
    );
    if (rightView) output.append("))");
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
    const receiver = declaration.expressions[index].children[0];
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    output.append("(");
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    if (viewReceiver) output.append(")->length");
    else output.append(").length");
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
    const viewReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "view";
    if (viewReceiver) output.append("(*(");
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    if (viewReceiver) output.append("))");
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
      const viewReceiver =
        child == 0
        && declaration.expressions[index].labels.length > 0
        && declaration.expressions[index].labels[0] == "view";
      if (viewReceiver) output.append("(*(");
      try appendExpression(
        inout output,
        declaration,
        value
      );
      if (viewReceiver) output.append("))");
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
    || declaration.expressions[index].kind
      == LoweredExpressionKind.textBufferAppendCodePoint
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
    else if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.textBufferAppendAscii
    ) output.append("z_text_buffer_append_ascii(&(");
    else output.append("z_text_buffer_append_code_point(&(");
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.methodCall) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received a malformed method call";
    }
    output.append(declaration.expressions[index].value);
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    const classReceiver = declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "class";
    const moveReceiver = declaration.expressions[index].labels.length > 1
      && declaration.expressions[index].labels[1] == "move";
    if (!classReceiver && !moveReceiver) output.append("&(");
    try appendExpression(inout output, declaration, receiver);
    if (!classReceiver && !moveReceiver) output.append(")");
    let argument: usize = 1;
    while (argument < declaration.expressions[index].children.length) {
      output.append(", ");
      const value = declaration.expressions[index].children[argument];
      const labelIndex = argument + 1;
      const borrowed = declaration.expressions[index].labels.length > labelIndex
        && (
          declaration.expressions[index].labels[labelIndex] == "in"
          || declaration.expressions[index].labels[labelIndex] == "inout"
          || declaration.expressions[index].labels[labelIndex] == "out"
        );
      if (borrowed) output.append("&(");
      try appendExpression(inout output, declaration, value);
      if (borrowed) output.append(")");
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.objectiveCRegistration
  ) {
    output.append(declaration.expressions[index].value);
    output.append("(");
    let argument: usize = 0;
    while (argument < declaration.expressions[index].children.length) {
      if (argument > 0) output.append(", ");
      const value = declaration.expressions[index].children[argument];
      try appendExpression(
        inout output,
        declaration,
        value
      );
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.objectiveCMessageCall
  ) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native Objective-C emission received a malformed message send";
    }
    output.append("[");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    const selector = declaration.expressions[index].value.copyBytes(
      0,
      declaration.expressions[index].value.byteLength
    );
    if (declaration.expressions[index].children.length == 1) {
      output.append(" ");
      output.append(selector);
    } else {
      let selectorStart: usize = 0;
      let argument: usize = 1;
      while (argument < declaration.expressions[index].children.length) {
        let separator = selectorStart;
        while (
          separator < selector.byteLength
          && selector.byteAt(separator) != 58
        ) {
          separator = separator + 1;
        }
        if (separator >= selector.byteLength) {
          throw "native Objective-C emission received a selector with too few parameters";
        }
        output.append(" ");
        output.append(selector.copyBytes(selectorStart, separator));
        output.append(": ");
        const value = declaration.expressions[index].children[argument];
        try appendExpression(
          inout output,
          declaration,
          value
        );
        selectorStart = separator + 1;
        argument = argument + 1;
      }
      if (selectorStart != selector.byteLength) {
        throw "native Objective-C emission received a selector with too many parameters";
      }
    }
    output.append("]");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.objectiveCInstanceOf
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native Objective-C emission received a malformed instanceof expression";
    }
    output.append("[");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append(" isKindOfClass:[");
    output.append(declaration.expressions[index].value);
    output.append(" class]]");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.objectiveCStringFromZ
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native Objective-C emission received a malformed String conversion";
    }
    output.append("z_stage1_nsstring_from_string(");
    const value = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      value
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.objectiveCStringToZ
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native Objective-C emission received a malformed NSString conversion";
    }
    output.append("z_stage1_string_from_nsstring(");
    const value = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      value
    );
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
    else if (
      declaration.expressions[callee].kind
        == LoweredExpressionKind.localValue
      && declaration.expressions[callee].value == "time.sleep"
    ) output.append("z_stage1_sleep");
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
  if (declaration.expressions[index].kind == LoweredExpressionKind.functionCall) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received a malformed function-value call";
    }
    const callee = declaration.expressions[index].children[0];
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_call(");
    try appendExpression(inout output, declaration, callee);
    let argument: usize = 1;
    while (argument < declaration.expressions[index].children.length) {
      output.append(", ");
      const borrowed = declaration.expressions[index].labels.length >= argument
        && (
          declaration.expressions[index].labels[argument - 1] == "in"
          || declaration.expressions[index].labels[argument - 1] == "inout"
          || declaration.expressions[index].labels[argument - 1] == "out"
        );
      if (borrowed) output.append("&(");
      const value = declaration.expressions[index].children[argument];
      try appendExpression(inout output, declaration, value);
      if (borrowed) output.append(")");
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.asyncFunctionAwait
  ) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received a malformed async function-value await";
    }
    appendAsyncCallableAwaitHelperName(
      inout output,
      declaration,
      index
    );
    output.append("(");
    let argument: usize = 0;
    while (argument < declaration.expressions[index].children.length) {
      if (argument > 0) output.append(", ");
      const borrowed = argument > 0
        && declaration.expressions[index].labels.length >= argument
        && (
          declaration.expressions[index].labels[argument - 1] == "in"
          || declaration.expressions[index].labels[argument - 1] == "inout"
          || declaration.expressions[index].labels[argument - 1] == "out"
      );
      if (borrowed) output.append("&(");
      const value = declaration.expressions[index].children[argument];
      try appendExpression(
        inout output,
        declaration,
        value
      );
      if (borrowed) output.append(")");
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.classValue) {
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_new(");
    let field: usize = 0;
    while (field < declaration.expressions[index].children.length) {
      if (field > 0) output.append(", ");
      const value = declaration.expressions[index].children[field];
      try appendExpression(
        inout output,
        declaration,
        value
      );
      field = field + 1;
    }
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.arenaNew) {
    if (declaration.expressions[index].children.length > 1) {
      throw "native C emission received malformed Arena construction";
    }
    output.append("z_stage1_arena_new(");
    if (declaration.expressions[index].children.length == 1) {
      const capacity = declaration.expressions[index].children[0];
      try appendExpression(inout output, declaration, capacity);
    } else output.append("0");
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.arenaCreate) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received malformed Arena.create";
    }
    output.append("z_stage1_arena_create_");
    output.append(arenaTypeSymbol(declaration.expressions[index].value));
    output.append("(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append("), ");
    const value = declaration.expressions[index].children[1];
    try appendExpression(inout output, declaration, value);
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.arenaReset) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received malformed Arena.reset";
    }
    output.append("z_stage1_arena_reset(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, receiver);
    output.append("))");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.mutexValue) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received malformed Mutex construction";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_new(");
    const value = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      value
    );
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.mutexWithLock
  ) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received malformed Mutex.withLock";
    }
    appendMutexWithLockHelperName(inout output, declaration, index);
    output.append("(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    const blockBody = declaration.expressions[index].labels.length >= 4
      && declaration.expressions[index].labels[3] == "lowered-block";
    let captureChild: usize = 2;
    if (blockBody) captureChild = 1;
    while (
      captureChild < declaration.expressions[index].children.length
    ) {
      output.append(", &(");
      const capture = declaration.expressions[index].children[captureChild];
      try appendExpression(inout output, declaration, capture);
      output.append(")");
      captureChild = captureChild + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.threadMainCall
  ) {
    if (declaration.expressions[index].children.length == 0) {
      throw "native C emission received malformed thread.main call evidence";
    }
    appendThreadMainCallHelperName(inout output, declaration, index);
    output.append("(_z_stage1_task_storage");
    let argument: usize = 1;
    while (argument < declaration.expressions[index].children.length) {
      output.append(", ");
      const value = declaration.expressions[index].children[argument];
      try appendExpression(inout output, declaration, value);
      argument = argument + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.threadSpawn
  ) {
    appendThreadSpawnHelperName(inout output, declaration, index);
    output.append("(");
    let bodyOffset: usize = 0;
    if (
      declaration.expressions[index].labels.length > 0
      && declaration.expressions[index].labels[0] == "expression"
    ) bodyOffset = 1;
    let capture = bodyOffset;
    while (capture < declaration.expressions[index].children.length) {
      if (capture > bodyOffset) output.append(", ");
      const captureValue = declaration.expressions[index].children[capture];
      try appendExpression(inout output, declaration, captureValue);
      capture = capture + 1;
    }
    output.append(")");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.threadAwait
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received malformed thread await";
    }
    const taskName = try awaitedTaskName(declaration, index);
    output.append("Z_");
    output.append(taskName);
    output.append("_await(&(");
    const task = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, task);
    output.append("))");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.threadCancel
  ) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received malformed thread cancellation";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_cancel(&(");
    const task = declaration.expressions[index].children[0];
    try appendExpression(inout output, declaration, task);
    output.append("))");
    return;
  }
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.onceInitialize
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received malformed Once.initialize";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_initialize(&(");
    const receiver = declaration.expressions[index].children[0];
    const value = declaration.expressions[index].children[1];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append("), ");
    try appendExpression(
      inout output,
      declaration,
      value
    );
    output.append(")");
    return;
  }
  if (declaration.expressions[index].kind == LoweredExpressionKind.onceGet) {
    if (declaration.expressions[index].children.length != 1) {
      throw "native C emission received malformed Once.get";
    }
    output.append("Z_");
    output.append(declaration.expressions[index].value);
    output.append("_get(&(");
    const receiver = declaration.expressions[index].children[0];
    try appendExpression(
      inout output,
      declaration,
      receiver
    );
    output.append("))");
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
      let valueReceiver = false;
      match (in declaration.receiverType) {
        some(_) => valueReceiver = declaration.receiverMode
          == LoweredParameterMode.value;
        none => {}
      }
      if (valueReceiver) output.append("self.");
      else output.append("self->");
      output.append(declaration.expressions[index].value);
      return;
    }
    if (
      declaration.expressions[index].labels.length > 0
      && (
        declaration.expressions[index].labels[0] == "view"
        || declaration.expressions[index].labels[0] == "class"
      )
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
  if (
    declaration.expressions[index].kind
      == LoweredExpressionKind.moveStructSpreadValue
  ) {
    if (declaration.expressions[index].children.length != 2) {
      throw "native C emission received a malformed moved struct spread";
    }
    const constructed = declaration.expressions[index].children[0];
    const movedSource = declaration.expressions[index].children[1];
    if (
      declaration.expressions[movedSource].kind
        != LoweredExpressionKind.moveValue
      || declaration.expressions[movedSource].children.length != 1
    ) {
      throw "native C emission lost the moved struct-spread source";
    }
    const spreadSourceExpression = declaration.expressions[movedSource]
      .children[0];
    const temporary = `_z_stage1_spread_${index}`;
    output.append("({ Z_");
    output.append(declaration.expressions[index].value);
    output.append(" ");
    output.append(temporary);
    output.append(" = ");
    try appendExpression(inout output, declaration, constructed);
    output.append("; ");
    let overrideIndex = declaration.expressions[index].moveSpreadOverrides.length;
    while (overrideIndex > 0) {
      overrideIndex = overrideIndex - 1;
      const override = view declaration.expressions[index]
        .moveSpreadOverrides[overrideIndex];
      if (override.type.kind == LoweredTypeKind.classType) {
        output.append("Z_");
        output.append(override.type.name);
        output.append("_release(");
        try appendExpression(
          inout output,
          declaration,
          spreadSourceExpression
        );
        output.append(".");
        output.append(override.name);
        output.append("); ");
      } else {
        output.append("Z_");
        output.append(override.type.name);
        output.append("_deinit(&(");
        try appendExpression(
          inout output,
          declaration,
          spreadSourceExpression
        );
        output.append(".");
        output.append(override.name);
        output.append(")); ");
      }
    }
    if (declaration.expressions[movedSource].value.byteLength > 0) {
      output.append(declaration.expressions[movedSource].value);
      output.append(" = false; ");
    }
    output.append(temporary);
    output.append("; })");
    return;
  }
  if (
    declaration.expressions[index].kind == LoweredExpressionKind.structValue
    || declaration.expressions[index].kind
      == LoweredExpressionKind.foreignStructValue
  ) {
    if (
      declaration.expressions[index].children.length
      != declaration.expressions[index].labels.length
    ) {
      throw "native C emission received a malformed struct value";
    }
    output.append("(");
    if (
      declaration.expressions[index].kind
        == LoweredExpressionKind.structValue
    ) output.append("Z_");
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
    if (isNicheViewOption(declaration.expressions[index].value)) {
      if (declaration.expressions[index].labels[0] != "none") {
        throw "native C emission received a payload-free niche Option.some";
      }
      output.append("NULL");
      return;
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
    if (isNicheViewOption(declaration.expressions[index].value)) {
      if (declaration.expressions[index].labels[0] != "some") {
        throw "native C emission received a payload-bearing niche Option.none";
      }
      const payload = declaration.expressions[index].children[0];
      try appendExpression(inout output, declaration, payload);
      return;
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

function testValueTargetType(in typeName: String): String {
  if (stringStartsWith(typeName, "view ") && typeName.byteLength > 5) {
    return typeName.copyBytes(5, typeName.byteLength);
  }
  return typeName.copyBytes(0, typeName.byteLength);
}

function testValueIsView(in typeName: String): boolean {
  return stringStartsWith(typeName, "view ") && typeName.byteLength > 5;
}

function testValueCType(
  in typeName: String,
  in comparison: String
): String throws String {
  const target = testValueTargetType(typeName);
  let type = "";
  if (target == "String") type = "Z_String";
  else if (target == "boolean") type = "bool";
  else if (target == "i8") type = "int8_t";
  else if (target == "i16") type = "int16_t";
  else if (target == "i32") type = "int32_t";
  else if (target == "i64") type = "int64_t";
  else if (target == "isize") type = "intptr_t";
  else if (target == "u8") type = "uint8_t";
  else if (target == "u16") type = "uint16_t";
  else if (target == "u32") type = "uint32_t";
  else if (target == "u64") type = "uint64_t";
  else if (target == "usize") type = "size_t";
  else if (target == "f32") type = "float";
  else if (target == "f64") type = "double";
  else if (comparison == "foreignEnum") type = target;
  else if (comparison == "enum") type = `Z_${target}`;
  else throw `native C emission cannot store test value type ${target}`;
  if (testValueIsView(typeName)) return `const ${type} *`;
  return type;
}

function appendTestStoredValue(
  inout output: TextBuffer,
  in name: String,
  in typeName: String
): void {
  if (testValueIsView(typeName)) {
    output.append("(*(");
    output.append(name);
    output.append("))");
  } else output.append(name);
}

function appendTestFailureLiteral(
  inout output: TextBuffer,
  in failure: String,
  in value: String,
  depth: usize
): void {
  appendIndent(inout output, depth);
  output.append("z_string_append_bytes(&");
  output.append(failure);
  output.append(", ");
  appendCStringLiteral(inout output, value);
  output.append(", ");
  output.append(`${value.byteLength}`);
  output.append(");\n");
}

function appendTestFormattedValue(
  inout output: TextBuffer,
  in failure: String,
  in value: String,
  in typeName: String,
  in comparison: String,
  depth: usize
): void throws String {
  const target = testValueTargetType(typeName);
  if (target == "String") {
    appendIndent(inout output, depth);
    output.append("z_text_buffer_append(&");
    output.append(failure);
    output.append(", ");
    appendTestStoredValue(inout output, value, typeName);
    output.append(");\n");
    return;
  }
  if (target == "boolean") {
    appendIndent(inout output, depth);
    output.append("if (");
    appendTestStoredValue(inout output, value, typeName);
    output.append(") z_string_append_bytes(&");
    output.append(failure);
    output.append(", \"true\", 4); else z_string_append_bytes(&");
    output.append(failure);
    output.append(", \"false\", 5);\n");
    return;
  }
  if (
    target == "i8"
    || target == "i16"
    || target == "i32"
    || target == "i64"
    || target == "isize"
  ) {
    appendIndent(inout output, depth);
    output.append("char _z_test_format_");
    output.append(value);
    output.append("[32];\n");
    appendIndent(inout output, depth);
    output.append("int _z_test_format_length_");
    output.append(value);
    output.append(" = snprintf(_z_test_format_");
    output.append(value);
    output.append(", sizeof(_z_test_format_");
    output.append(value);
    output.append("), \"%lld\", (long long)");
    appendTestStoredValue(inout output, value, typeName);
    output.append(");\n");
    appendIndent(inout output, depth);
    output.append("if (_z_test_format_length_");
    output.append(value);
    output.append(" < 0) abort();\n");
    appendIndent(inout output, depth);
    output.append("z_string_append_bytes(&");
    output.append(failure);
    output.append(", _z_test_format_");
    output.append(value);
    output.append(", (size_t)_z_test_format_length_");
    output.append(value);
    output.append(");\n");
    return;
  }
  if (
    target == "u8"
    || target == "u16"
    || target == "u32"
    || target == "u64"
    || target == "usize"
    || comparison == "foreignEnum"
  ) {
    appendIndent(inout output, depth);
    output.append("char _z_test_format_");
    output.append(value);
    output.append("[32];\n");
    appendIndent(inout output, depth);
    output.append("int _z_test_format_length_");
    output.append(value);
    output.append(" = snprintf(_z_test_format_");
    output.append(value);
    output.append(", sizeof(_z_test_format_");
    output.append(value);
    output.append("), \"%llu\", (unsigned long long)");
    appendTestStoredValue(inout output, value, typeName);
    output.append(");\n");
    appendIndent(inout output, depth);
    output.append("if (_z_test_format_length_");
    output.append(value);
    output.append(" < 0) abort();\n");
    appendIndent(inout output, depth);
    output.append("z_string_append_bytes(&");
    output.append(failure);
    output.append(", _z_test_format_");
    output.append(value);
    output.append(", (size_t)_z_test_format_length_");
    output.append(value);
    output.append(");\n");
    return;
  }
  if (target == "f32" || target == "f64") {
    appendIndent(inout output, depth);
    output.append("char _z_test_format_");
    output.append(value);
    output.append("[64];\n");
    appendIndent(inout output, depth);
    output.append("int _z_test_format_length_");
    output.append(value);
    output.append(" = snprintf(_z_test_format_");
    output.append(value);
    output.append(", sizeof(_z_test_format_");
    output.append(value);
    output.append("), \"%g\", (double)");
    appendTestStoredValue(inout output, value, typeName);
    output.append(");\n");
    appendIndent(inout output, depth);
    output.append("if (_z_test_format_length_");
    output.append(value);
    output.append(" < 0) abort();\n");
    appendIndent(inout output, depth);
    output.append("z_string_append_bytes(&");
    output.append(failure);
    output.append(", _z_test_format_");
    output.append(value);
    output.append(", (size_t)_z_test_format_length_");
    output.append(value);
    output.append(");\n");
    return;
  }
  if (comparison == "enum") {
    appendIndent(inout output, depth);
    output.append("z_string_append_unsigned_decimal(&");
    output.append(failure);
    output.append(", (uint64_t)");
    appendTestStoredValue(inout output, value, typeName);
    output.append(".tag);\n");
    return;
  }
  throw `native C emission cannot format test value type ${target}`;
}

function appendLocalStatementStorage(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  const type = match (in declaration.statements[index].type) {
    some(type) => try cType(type);
    none => throw "native C emission received an untyped local";
  };
  const constStorage = match (in declaration.statements[index].type) {
    some(storageType) => {
      select storageType.kind != LoweredTypeKind.structType
        && storageType.kind != LoweredTypeKind.enumType
        && storageType.kind != LoweredTypeKind.arrayType
        && storageType.kind != LoweredTypeKind.fixedArrayType
        && storageType.kind != LoweredTypeKind.mapType
        && storageType.kind != LoweredTypeKind.setType
        && storageType.kind != LoweredTypeKind.stringType
        && storageType.kind != LoweredTypeKind.classType
        && storageType.kind != LoweredTypeKind.foreignObjCType
        && storageType.kind != LoweredTypeKind.onceLifetimeType
        && storageType.kind != LoweredTypeKind.mutexType
        && storageType.kind != LoweredTypeKind.taskType
        && storageType.kind != LoweredTypeKind.functionType;
    }
    none => false;
  };
  const hasInitializer = match (in declaration.statements[index].expression) {
    some(_) => true;
    none => false;
  };
  const viewStorage = match (in declaration.statements[index].expression) {
    some(initializer) => declaration.expressions[initializer].kind
      == LoweredExpressionKind.viewProjection
      || declaration.expressions[initializer].kind
        == LoweredExpressionKind.arenaCreate
      || (
        declaration.expressions[initializer].kind
          == LoweredExpressionKind.fieldValue
        && labelsContain(
          declaration.expressions[initializer].labels,
          "resultView"
        )
      );
    none => false;
  };
  const classStorage = match (in declaration.statements[index].type) {
    some(storageType) => storageType.kind == LoweredTypeKind.classType
      || storageType.kind == LoweredTypeKind.foreignObjCType;
    none => false;
  };
  const cstringStorage = match (in declaration.statements[index].type) {
    some(storageType) => storageType.kind == LoweredTypeKind.cstringType;
    none => false;
  };
  const preciseObjCRegistration = match (in declaration.statements[index].type) {
    some(storageType) => storageType.kind == LoweredTypeKind.foreignObjCType
      && storageType.name == "ZObjCRegistration";
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
    && hasInitializer
    && (classStorage || cstringStorage)
  ) {
    output.append(type);
    output.append(" const ");
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
  const unusedLocal = !localNameIsUsed(
    declaration,
    declaration.statements[index].name
  );
  if (preciseObjCRegistration) {
    output.append(" __attribute__((objc_precise_lifetime");
    if (unusedLocal) output.append(", unused");
    output.append("))");
  } else if (unusedLocal) output.append(" __attribute__((unused))");
  match (in declaration.statements[index].expression) {
    some(expression) => {
      output.append(" = ");
      try appendExpression(inout output, declaration, expression);
    }
    none => match (in declaration.statements[index].type) {
      some(storageType) => {
        if (storageType.kind == LoweredTypeKind.foreignHandleType) {
          output.append(" = NULL");
        }
      }
      none => {}
    }
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
}

function appendTryStatement(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize,
  in loopDoneLabel: String
): void throws String {
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
  if (loopDoneLabel.byteLength > 0) {
    output.append("context->result = ");
    output.append(propagated);
    output.append(";\n");
    appendIndent(inout output, depth + 1);
    output.append("context->loop_control = 3; goto ");
    output.append(loopDoneLabel);
    output.append(";\n");
  } else {
    output.append("return ");
    output.append(propagated);
    output.append(";\n");
  }
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
}

function appendForeignUnionMatchStatement(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  const statement = view declaration.statements[index];
  if (statement.matchConsumesSubject) {
    throw "native C emission cannot consume a discriminated native union";
  }
  const unionType = match (in statement.type) {
    some(type) => try cType(type);
    none => throw "native C emission lost the discriminated union type";
  };
  const temporary = `_z_stage1_native_match_${index}`;
  appendIndent(inout output, depth);
  output.append("const ");
  output.append(unionType);
  output.append(" * const ");
  output.append(temporary);
  output.append(" = &(");
  match (in statement.expression) {
    some(subject) => try appendExpression(
      inout output,
      declaration,
      subject
    );
    none => throw "native C emission received a native union match without a subject";
  }
  output.append(");\n");
  appendIndent(inout output, depth);
  output.append("switch (");
  output.append(temporary);
  output.append("->");
  output.append(statement.foreignMatchDiscriminant);
  output.append(") {\n");
  for (const armIndex of statement.children) {
    const arm = view declaration.statements[armIndex];
    if (arm.kind != LoweredStatementKind.matchArmStatement) {
      throw "native C emission received a malformed native union match arm";
    }
    if (arm.foreignMatchFallback) {
      appendIndent(inout output, depth + 1);
      output.append("default: {\n");
    } else {
      if (arm.foreignMatchValues.length == 0) {
        throw "native C emission received a native union variant without tag values";
      }
      for (const value of arm.foreignMatchValues) {
        appendIndent(inout output, depth + 1);
        output.append("case ");
        output.append(value);
        output.append(":\n");
      }
      appendIndent(inout output, depth + 1);
      output.append("{\n");
    }
    match (in arm.type) {
      some(type) => {
        if (arm.labels.length != 1) {
          throw "native C emission received a native union payload arm without one binding";
        }
        appendIndent(inout output, depth + 2);
        output.append("const ");
        const payloadType = try cType(type);
        output.append(payloadType);
        if (arm.foreignMatchMember.byteLength > 0) {
          output.append(" * const ");
        } else {
          output.append(" ");
        }
        appendCBindingName(inout output, arm.labels[0]);
        output.append(" = ");
        if (arm.foreignMatchMember.byteLength > 0) output.append("&(");
        output.append(temporary);
        output.append("->");
        if (arm.foreignMatchMember.byteLength > 0) {
          output.append(arm.foreignMatchMember);
          output.append(")");
        } else {
          output.append(statement.foreignMatchDiscriminant);
        }
        output.append(";\n");
      }
      none => {}
    }
    for (const child of arm.children) {
      try appendStatement(inout output, declaration, child, depth + 2);
    }
    appendCleanups(inout output, arm.cleanups, depth + 2);
    appendIndent(inout output, depth + 2);
    output.append("break;\n");
    appendIndent(inout output, depth + 1);
    output.append("}\n");
  }
  appendIndent(inout output, depth);
  output.append("}\n");
}

function appendStatement(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize
): void throws String {
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.testExpectationStatement
  ) {
    if (declaration.statements[index].labels.length != 5) {
      throw "native C emission received a malformed test expectation";
    }
    const actualType = view declaration.statements[index].labels[0];
    const expectedType = view declaration.statements[index].labels[1];
    const comparison = view declaration.statements[index].labels[2];
    const actualName = `_z_test_actual_${index}`;
    const expectedName = `_z_test_expected_${index}`;
    const failureName = `_z_test_failure_${index}`;
    appendIndent(inout output, depth);
    const actualCType = try testValueCType(actualType, comparison);
    output.append(actualCType);
    output.append(" ");
    output.append(actualName);
    output.append(" = ");
    match (in declaration.statements[index].expression) {
      some(actual) => try appendExpression(
        inout output,
        declaration,
        actual
      );
      none => throw "native C emission lost a test actual value";
    }
    output.append(";\n");
    appendIndent(inout output, depth);
    const expectedCType = try testValueCType(expectedType, comparison);
    output.append(expectedCType);
    output.append(" ");
    output.append(expectedName);
    output.append(" = ");
    match (in declaration.statements[index].secondExpression) {
      some(expected) => try appendExpression(
        inout output,
        declaration,
        expected
      );
      none => throw "native C emission lost a test expected value";
    }
    output.append(";\n");
    appendIndent(inout output, depth);
    output.append("if (!(");
    if (comparison == "string") {
      output.append("z_string_equal(");
      appendTestStoredValue(inout output, actualName, actualType);
      output.append(", ");
      appendTestStoredValue(inout output, expectedName, expectedType);
      output.append(")");
    } else if (comparison == "enum") {
      appendTestStoredValue(inout output, actualName, actualType);
      output.append(".tag == ");
      appendTestStoredValue(inout output, expectedName, expectedType);
      output.append(".tag");
    } else {
      appendTestStoredValue(inout output, actualName, actualType);
      output.append(" == ");
      appendTestStoredValue(inout output, expectedName, expectedType);
    }
    output.append(")) {\n");
    appendIndent(inout output, depth + 1);
    output.append("Z_String ");
    output.append(failureName);
    output.append(" = (Z_String){ NULL, 0, 0 };\n");
    const location = `${declaration.sourcePath}:${declaration.statements[index].labels[3]}:${declaration.statements[index].labels[4]}: expected `;
    appendTestFailureLiteral(
      inout output,
      failureName,
      location,
      depth + 1
    );
    try appendTestFormattedValue(
      inout output,
      failureName,
      actualName,
      actualType,
      comparison,
      depth + 1
    );
    appendTestFailureLiteral(
      inout output,
      failureName,
      " to equal ",
      depth + 1
    );
    try appendTestFormattedValue(
      inout output,
      failureName,
      expectedName,
      expectedType,
      comparison,
      depth + 1
    );
    appendCleanups(
      inout output,
      declaration.statements[index].cleanups,
      depth + 1
    );
    appendIndent(inout output, depth + 1);
    output.append("return (Z_");
    output.append(declaration.returnType.name);
    output.append("){ .tag = Z_");
    output.append(declaration.returnType.name);
    output.append("Tag_failure, .payload.failure = ");
    output.append(failureName);
    output.append(" };\n");
    appendIndent(inout output, depth);
    output.append("}\n");
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.localStatement) {
    try appendLocalStatementStorage(
      inout output,
      declaration,
      index,
      depth
    );
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
          let returnType = "";
          match (in declaration.statements[index].type) {
            some(type) => returnType = try cType(type);
            none => returnType = try cType(declaration.returnType);
          }
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
      let returnType = "";
      match (in declaration.statements[index].type) {
        some(type) => returnType = try cType(type);
        none => returnType = try cType(declaration.returnType);
      }
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
      appendIndent(inout output, depth);
      if (declaration.statements[index].cleanups[0].guard.byteLength > 0) {
        output.append("if (");
        output.append(declaration.statements[index].cleanups[0].guard);
        output.append(") ");
      }
      if (
        declaration.statements[index].cleanups[0].type.kind
          == LoweredTypeKind.classType
      ) {
        output.append("Z_");
        output.append(declaration.statements[index].cleanups[0].type.name);
        output.append("_release(");
        match (in declaration.statements[index].expression) {
          some(target) => try appendExpression(
            inout output,
            declaration,
            target
          );
          none => throw "native C emission received an assignment without a target";
        }
        output.append(");\n");
      } else {
        output.append("Z_");
        output.append(declaration.statements[index].cleanups[0].type.name);
        output.append("_deinit(&");
        match (in declaration.statements[index].expression) {
          some(target) => try appendExpression(
            inout output,
            declaration,
            target
          );
          none => throw "native C emission received an assignment without a target";
        }
        output.append(");\n");
      }
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
    try appendTryStatement(
      inout output,
      declaration,
      index,
      depth,
      ""
    );
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.matchStatement) {
    if (declaration.statements[index].foreignMatchDiscriminant.byteLength > 0) {
      try appendForeignUnionMatchStatement(
        inout output,
        declaration,
        index,
        depth
      );
      return;
    }
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
    const nicheViewOption = labelsContain(
      declaration.statements[index].labels,
      "niche-view-option"
    );
    if (nicheViewOption) output.append(" != NULL ? 1 : 0");
    else if (labelsContain(declaration.statements[index].labels, "tagged")) {
      if (labelsContain(declaration.statements[index].labels, "view-subject")) {
        output.append("->tag");
      } else {
        output.append(".tag");
      }
    }
    output.append(") {\n");
    for (const arm of declaration.statements[index].children) {
      if (declaration.statements[arm].kind != LoweredStatementKind.matchArmStatement) {
        throw "native C emission received a malformed match arm";
      }
      appendIndent(inout output, depth + 1);
      if (nicheViewOption) {
        output.append(declaration.statements[arm].name == "some"
          ? "case 1"
          : "case 0");
      } else {
        output.append("case Z_");
        output.append(declaration.statements[index].name);
        if (labelsContain(declaration.statements[index].labels, "tagged")) {
          output.append("Tag");
        }
        output.append("_");
        output.append(declaration.statements[arm].name);
      }
      output.append(": {\n");
      match (in declaration.statements[arm].type) {
        some(type) => {
          if (declaration.statements[arm].labels.length != 1) {
            throw "native C emission received a payload arm without one binding";
          }
          appendIndent(inout output, depth + 2);
          const loadViewValue = nicheViewOption
            && viewPayloadLoadsAsValue(type);
          if (
            !declaration.statements[arm].matchBindingNeedsCleanup
            && !nicheViewOption
          ) {
            output.append("const ");
          }
          const payloadType = try cType(type);
          output.append(payloadType);
          if (
            nicheViewOption
            && !loadViewValue
            && type.kind != LoweredTypeKind.cstringType
            && type.kind != LoweredTypeKind.foreignHandleType
          ) output.append(" const *");
          output.append(" __attribute__((unused))");
          output.append(" ");
          appendCBindingName(
            inout output,
            declaration.statements[arm].labels[0]
          );
          output.append(" = ");
          if (loadViewValue) output.append("*(");
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
          if (loadViewValue) output.append(")");
          if (nicheViewOption) {
            // The nullable pointer is the payload; no tag or union survives.
          } else if (labelsContain(declaration.statements[index].labels, "view-subject")) {
            output.append("->payload.");
          } else {
            output.append(".payload.");
          }
          if (!nicheViewOption) {
            output.append(declaration.statements[arm].name);
          }
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
    if (
      declaration.statements[index].labels.length == 1
      && (
        declaration.statements[index].labels[0] == "nested-try-normalized"
        || declaration.statements[index].labels[0] == "destructure-normalized"
      )
    ) {
      for (const child of declaration.statements[index].children) {
        try appendStatement(inout output, declaration, child, depth);
      }
      appendCleanups(
        inout output,
        declaration.statements[index].cleanups,
        depth
      );
      return;
    }
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
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.delayStatement
  ) {
    throw "native C emission received a detached delay statement";
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
      || declaration.statements[index].labels.length < 1
      || declaration.statements[index].labels.length > 4
    ) {
      throw "native C emission received a malformed for statement";
    }
    const viewIterable = labelsContain(
      declaration.statements[index].labels,
      "view"
    );
    const fixedIterable = labelsContain(
      declaration.statements[index].labels,
      "fixed"
    );
    const mapIterable = labelsContain(
      declaration.statements[index].labels,
      "map"
    );
    if (
      fixedIterable
      && declaration.statements[index].labels.length < 3
    ) {
      throw "native C emission received a fixed-array loop without its length";
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
    output.append(" < ");
    if (fixedIterable) {
      output.append("(");
      output.append(declaration.statements[index].labels[2]);
      output.append(")");
    } else {
      output.append("(");
      if (viewIterable) output.append("(*(");
      match (in declaration.statements[index].expression) {
        some(iterable) => try appendExpression(
          inout output,
          declaration,
          iterable
        );
        none => throw "native C emission received a for without an iterable";
      }
      if (viewIterable) output.append("))");
      output.append(").length");
    }
    output.append("; ");
    output.append(position);
    output.append(" += 1) {\n");
    appendIndent(inout output, depth + 1);
    output.append("const ");
    output.append(elementType);
    output.append(" ");
    appendCBindingName(inout output, declaration.statements[index].name);
    if (mapIterable) {
      output.append(" = (");
      if (viewIterable) output.append("(*(");
      match (in declaration.statements[index].expression) {
        some(iterable) => try appendExpression(
          inout output,
          declaration,
          iterable
        );
        none => throw "native C emission received a for without an iterable";
      }
      if (viewIterable) output.append("))");
      output.append(").entries[");
      output.append(position);
      output.append("];\n");
    } else {
      output.append(" = *Z_");
      output.append(declaration.statements[index].labels[0]);
      output.append("_at(&(");
      if (viewIterable) output.append("(*(");
      match (in declaration.statements[index].expression) {
        some(iterable) => try appendExpression(
          inout output,
          declaration,
          iterable
        );
        none => throw "native C emission received a for without an iterable";
      }
      if (viewIterable) output.append("))");
      output.append("), ");
      output.append(position);
      output.append(");\n");
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
  in declaration: LoweredFunction,
  processArguments: boolean
): void throws String {
  const returnType = try cType(declaration.returnType);
  let method = false;
  match (in declaration.receiverType) {
    some(_) => method = true;
    none => {}
  }
  if (method) output.append("static __attribute__((unused)) ");
  else if (declaration.nativeCExportName.byteLength > 0) output.append("static ");
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
  match (in declaration.receiverType) {
    some(receiver) => {
      if (declaration.receiverMode == LoweredParameterMode.input) {
        output.append("const ");
      }
      output.append("Z_");
      output.append(receiver.name);
      if (declaration.receiverMode == LoweredParameterMode.value) {
        output.append(" self");
      } else output.append(" *self");
      first = false;
    }
    none => {}
  }
  for (const parameter of declaration.parameters) {
    if (!first) output.append(", ");
    first = false;
    const parameterType = try cType(parameter.type);
    if (
      parameter.mode == LoweredParameterMode.input
      && parameter.type.kind == LoweredTypeKind.foreignObjCType
    ) {
      output.append(parameterType);
      output.append(" ");
      appendCBindingName(inout output, parameter.name);
      continue;
    }
    if (
      parameter.mode == LoweredParameterMode.input
      && parameter.type.kind != LoweredTypeKind.classType
    ) output.append("const ");
    output.append(parameterType);
    if (
      parameter.mode == LoweredParameterMode.input
      && parameter.type.kind == LoweredTypeKind.classType
    ) output.append(" const *");
    else if (parameter.mode != LoweredParameterMode.value) output.append(" *");
    else output.append(" ");
    appendCBindingName(inout output, parameter.name);
  }
  if (first) output.append("void");
  output.append(")");
}

function appendFunctionTail(
  inout output: TextBuffer,
  in declaration: LoweredFunction
): void throws String {
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
}

function persistentAsyncParentShape(
  in program: LoweredProgram,
  in declaration: LoweredFunction
): Option<PersistentAsyncParentShape> {
  if (
    !declaration.asynchronous
    || declaration.name != "main"
    || declaration.parameters.length != 0
    || declaration.roots.length != 3
    || declaration.returnType.kind != LoweredTypeKind.i32Type
  ) return Option<PersistentAsyncParentShape>.none;
  match (in declaration.receiverType) {
    some(_) => return Option<PersistentAsyncParentShape>.none;
    none => {}
  }
  const localStatement = declaration.roots[0];
  const awaitStatement = declaration.roots[1];
  const returnStatement = declaration.roots[2];
  if (
    declaration.statements[localStatement].kind
      != LoweredStatementKind.localStatement
    || declaration.statements[awaitStatement].kind
      != LoweredStatementKind.expressionStatement
    || declaration.statements[returnStatement].kind
      != LoweredStatementKind.returnStatement
  ) return Option<PersistentAsyncParentShape>.none;
  let localTypeName = "";
  match (in declaration.statements[localStatement].type) {
    some(type) => {
      if (type.kind != LoweredTypeKind.functionType) {
        return Option<PersistentAsyncParentShape>.none;
      }
      localTypeName = type.name.copyBytes(0, type.name.byteLength);
    }
    none => return Option<PersistentAsyncParentShape>.none;
  }
  const localInitializer = match (
    in declaration.statements[localStatement].expression
  ) {
    some(expression) => expression;
    none => return Option<PersistentAsyncParentShape>.none;
  };
  const awaitExpression = match (
    in declaration.statements[awaitStatement].expression
  ) {
    some(expression) => expression;
    none => return Option<PersistentAsyncParentShape>.none;
  };
  const returnExpression = match (
    in declaration.statements[returnStatement].expression
  ) {
    some(expression) => expression;
    none => return Option<PersistentAsyncParentShape>.none;
  };
  if (
    declaration.expressions[awaitExpression].kind
      != LoweredExpressionKind.asyncFunctionAwait
    || declaration.expressions[awaitExpression].children.length != 1
    || declaration.expressions[returnExpression].kind
      != LoweredExpressionKind.integerValue
  ) return Option<PersistentAsyncParentShape>.none;
  const awaitedCallable = view declaration.expressions[
    declaration.expressions[awaitExpression].children[0]
  ];
  if (
    awaitedCallable.kind != LoweredExpressionKind.localValue
    || awaitedCallable.value != declaration.statements[localStatement].name
    || declaration.expressions[awaitExpression].value != localTypeName
  ) return Option<PersistentAsyncParentShape>.none;
  let matchingFunctionType = false;
  for (const functionType of program.functionTypes) {
    if (functionType.name != localTypeName) continue;
    matchingFunctionType = functionType.asynchronous
      && functionType.parameters.length == 0
      && functionType.returnType.kind == LoweredTypeKind.voidType;
  }
  if (!matchingFunctionType) {
    return Option<PersistentAsyncParentShape>.none;
  }
  if (declaration.statements[returnStatement].cleanups.length != 1) {
    return Option<PersistentAsyncParentShape>.none;
  }
  const cleanup = view declaration.statements[returnStatement].cleanups[0];
  if (
    cleanup.name != declaration.statements[localStatement].name
    || cleanup.type.kind != LoweredTypeKind.functionType
    || cleanup.type.name != localTypeName
  ) return Option<PersistentAsyncParentShape>.none;
  return Option.some(PersistentAsyncParentShape({
    localStatement,
    localInitializer,
    returnExpression,
  }));
}

function appendPersistentAsyncParentDriver(
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
    && processArguments
  ) {
    output.append("  z_stage1_process_argc = argc;\n");
    output.append("  z_stage1_process_argv = argv;\n");
  }
  output.append("  Z_AsyncExecutor executor = {0};\n  ");
  appendPersistentAsyncParentName(inout output, declaration);
  output.append(" *frame = ");
  appendPersistentAsyncParentName(inout output, declaration);
  output.append("_start(&executor);\n");
  output.append("  z_stage1_async_enqueue(&executor, &frame->task);\n");
  output.append("  while (!frame->task.completed) {\n");
  output.append("    if (!z_stage1_async_run_one(&executor)) abort();\n");
  output.append("  }\n  const int32_t result = frame->result;\n  ");
  appendPersistentAsyncParentName(inout output, declaration);
  output.append("_destroy(frame);\n  return result;\n}\n\n");
}

function appendFunction(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  processArguments: boolean
): void throws String {
  match (persistentAsyncParentShape(program, declaration)) {
    some(shape) => {
      try appendPersistentAsyncParentDriver(
        inout output,
        declaration,
        processArguments
      );
      return;
    }
    none => {}
  }
  try appendFunctionSignature(
    inout output,
    declaration,
    processArguments
  );
  output.append(" {\n");
  match (in declaration.receiverType) {
    some(_) => output.append("  (void)self;\n");
    none => {}
  }
  for (const parameter of declaration.parameters) {
    output.append("  (void)");
    appendCBindingName(inout output, parameter.name);
    output.append(";\n");
  }
  if (
    declaration.name == "main"
    && declaration.parameters.length == 0
    && processArguments
  ) {
    output.append("  z_stage1_process_argc = argc;\n");
    output.append("  z_stage1_process_argv = argv;\n");
  }
  if (
    declaration.mainDelaySegments.length > 0
    || declaration.mainDelayIfs.length > 0
    || declaration.mainDelayMatches.length > 0
    || declaration.mainDelayLoops.length > 0
  ) {
    for (const parameter of declaration.parameters) {
      output.append("  (void)");
      appendCBindingName(inout output, parameter.name);
      output.append(";\n");
    }
    output.append("  abort();\n}\n\n");
    return;
  }
  for (const flag of declaration.liveFlags) {
    if (flag.parameter) {
      appendIndent(inout output, 1);
      output.append("bool ");
      appendCBindingName(inout output, flag.name);
      output.append(" = true;\n");
    }
  }
  try appendFunctionTail(inout output, declaration);
  output.append("}\n\n");
}

function programUsesForeignCallbackType(
  in program: LoweredProgram,
  in name: String
): boolean {
  for (const declaration of program.functions) {
    for (const expression of declaration.expressions) {
      if (
        expression.kind == LoweredExpressionKind.foreignCallbackValue
        && expression.value == name
      ) return true;
    }
  }
  return false;
}

function appendForeignCallbackHelpers(
  inout output: TextBuffer,
  in declaration: LoweredFunctionType
): void throws String {
  const returnType = try cType(declaration.returnType);
  output.append("static __attribute__((unused)) ");
  output.append(returnType);
  output.append(" z_stage1_c_callback_Z_");
  output.append(declaration.name);
  output.append("(");
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    if (parameterIndex > 0) output.append(", ");
    try appendCallableParameterDeclaration(
      inout output,
      declaration.parameters[parameterIndex],
      declaration.parameters[parameterIndex].name
    );
    parameterIndex = parameterIndex + 1;
  }
  if (parameterIndex > 0) output.append(", ");
  output.append("void *callback_context) {\n  Z_");
  output.append(declaration.name);
  output.append(" *callback = (Z_");
  output.append(declaration.name);
  output.append(" *)callback_context;\n  ");
  if (declaration.returnType.kind != LoweredTypeKind.voidType) {
    output.append("return ");
  }
  output.append("Z_");
  output.append(declaration.name);
  output.append("_call(*callback");
  for (const parameter of declaration.parameters) {
    output.append(", ");
    appendCBindingName(inout output, parameter.name);
  }
  output.append(");\n}\n\n");
  output.append("static __attribute__((unused)) void *Z_");
  output.append(declaration.name);
  output.append("_c_escape_box(Z_");
  output.append(declaration.name);
  output.append(" value) {\n  Z_");
  output.append(declaration.name);
  output.append(" *box = (Z_");
  output.append(declaration.name);
  output.append(" *)malloc(sizeof(Z_");
  output.append(declaration.name);
  output.append("));\n  if (box == NULL) abort();\n  *box = value;\n  return box;\n}\n\n");
  output.append("static __attribute__((unused)) void Z_");
  output.append(declaration.name);
  output.append("_c_escape_box_release(void *context) {\n  Z_");
  output.append(declaration.name);
  output.append(" *box = (Z_");
  output.append(declaration.name);
  output.append(" *)context;\n  if (box == NULL) return;\n  Z_");
  output.append(declaration.name);
  output.append("_deinit(box);\n  free(box);\n}\n\n");
}

function appendCallableHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const owner of program.functions) {
    let expressionIndex: usize = 0;
    while (expressionIndex < owner.expressions.length) {
      const expression = view owner.expressions[expressionIndex];
      if (
        expression.kind != LoweredExpressionKind.directFunctionValue
        && expression.kind != LoweredExpressionKind.closureValue
      ) {
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (expression.labels.length == 0) {
        throw "native callable helper lost its function type";
      }
      let functionTypeIndex = program.functionTypes.length;
      let candidate: usize = 0;
      while (candidate < program.functionTypes.length) {
        if (program.functionTypes[candidate].name == expression.labels[0]) {
          functionTypeIndex = candidate;
        }
        candidate = candidate + 1;
      }
      if (functionTypeIndex >= program.functionTypes.length) {
        throw "native callable helper could not resolve its function type";
      }
      const functionType = view program.functionTypes[functionTypeIndex];
      const returnType = try cType(functionType.returnType);
      const parameterLabelStart: usize = 3;
      const captureLabelStart = parameterLabelStart
        + functionType.parameters.length;
      if (
        expression.kind == LoweredExpressionKind.closureValue
        && expression.labels.length
          != captureLabelStart + expression.captureTypes.length
      ) throw "native callable helper lost its closure labels";
      const contextName = callableContextParameterName(
        in functionType,
        in expression,
        parameterLabelStart
      );
      if (expression.captureTypes.length > 0) {
        output.append("typedef struct ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment {\n  size_t refcount;\n");
        let capture: usize = 0;
        while (capture < expression.captureTypes.length) {
          output.append("  ");
          const captureCType = try cType(expression.captureTypes[capture]);
          output.append(captureCType);
          output.append(" ");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          output.append(";\n");
          capture = capture + 1;
        }
        output.append("} ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment;\n\n");
        output.append("static void ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_retain(void *context) {\n  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *environment = (");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *)context;\n  ");
        if (expression.threadSafe) {
          output.append("(void)__atomic_add_fetch(&environment->refcount, 1, __ATOMIC_RELAXED);");
        } else {
          output.append("environment->refcount += 1;");
        }
        output.append("\n}\n\n");
        output.append("static void ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_release(void *context) {\n  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *environment = (");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *)context;\n  ");
        if (expression.threadSafe) {
          output.append("if (__atomic_sub_fetch(&environment->refcount, 1, __ATOMIC_ACQ_REL) != 0) return;");
        } else {
          output.append("environment->refcount -= 1;\n  if (environment->refcount != 0) return;");
        }
        output.append("\n");
        capture = expression.captureTypes.length;
        while (capture > 0) {
          capture = capture - 1;
          const captureType = view expression.captureTypes[capture];
          if (loweredTypeNeedsDeinit(program, captureType)) {
            output.append("  Z_");
            output.append(captureType.name);
            if (captureType.kind == LoweredTypeKind.classType) {
              output.append("_release(environment->");
              appendCBindingName(
                inout output,
                expression.labels[captureLabelStart + capture]
              );
              output.append(");\n");
            } else {
              output.append("_deinit(&environment->");
              appendCBindingName(
                inout output,
                expression.labels[captureLabelStart + capture]
              );
              output.append(");\n");
            }
          }
        }
        output.append("  free(environment);\n}\n\n");
      }
      if (functionType.asynchronous) {
        if (expression.kind != LoweredExpressionKind.closureValue) {
          throw "native async callable helper currently requires a contextual closure";
        }
        const resultNeedsDeinit = loweredTypeNeedsDeinit(
          program,
          functionType.returnType
        );
        output.append("typedef struct ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task {\n  Z_AsyncTask task;\n");
        if (functionType.returnType.kind != LoweredTypeKind.voidType) {
          output.append("  ");
          output.append(returnType);
          output.append(" result;\n");
          if (resultNeedsDeinit) output.append("  bool live_result;\n");
        }
        if (expression.value == "scheduler-yield") {
          output.append("  uint32_t state;\n");
        }
        output.append("} ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task;\n\n");
        if (expression.value == "scheduler-yield") {
          output.append("static void ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_poll(Z_AsyncTask *task) {\n  ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_task *frame = (");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_task *)task;\n");
          output.append("  if (frame->state == 0) {\n");
          output.append("    frame->state = 1;\n");
          output.append("    z_stage1_async_enqueue(task->executor, task);\n");
          output.append("    return;\n  }\n");
          output.append("  task->completed = true;\n}\n\n");
        }
        output.append("static bool ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_failed(Z_AsyncTask *task) {\n  (void)task;\n  return false;\n}\n\n");
        output.append("static void ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_take_result(Z_AsyncTask *task, void *destination) {\n");
        if (functionType.returnType.kind == LoweredTypeKind.voidType) {
          output.append("  (void)task;\n  (void)destination;\n");
        } else {
          output.append("  ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_task *frame = (");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_task *)task;\n  if (destination == NULL) abort();\n");
          if (resultNeedsDeinit) {
            output.append("  if (!frame->live_result) abort();\n");
          }
          output.append("  *((");
          output.append(returnType);
          output.append(" *)destination) = frame->result;\n");
          if (resultNeedsDeinit) {
            output.append("  frame->live_result = false;\n");
          }
        }
        output.append("}\n\n");
        output.append("static void ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_take_error(Z_AsyncTask *task, void *destination) {\n  (void)task;\n  (void)destination;\n}\n\n");
        output.append("static void ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_destroy(Z_AsyncTask *task) {\n  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task *frame = (");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task *)task;\n");
        if (resultNeedsDeinit) {
          output.append("  if (frame->live_result) ");
          if (functionType.returnType.kind == LoweredTypeKind.classType) {
            output.append("Z_");
            output.append(functionType.returnType.name);
            output.append("_release(frame->result);\n");
          } else {
            output.append("Z_");
            output.append(functionType.returnType.name);
            output.append("_deinit(&frame->result);\n");
          }
        }
        output.append("  free(frame);\n}\n\n");
        output.append("static Z_AsyncInvocation ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_start(void *");
        appendCBindingName(inout output, contextName);
        output.append(", Z_AsyncExecutor *executor");
        let parameter: usize = 0;
        while (parameter < functionType.parameters.length) {
          output.append(", ");
          try appendCallableParameterDeclaration(
            inout output,
            functionType.parameters[parameter],
            expression.labels[parameterLabelStart + parameter]
          );
          parameter = parameter + 1;
        }
        output.append(") {\n");
        if (expression.value != "scheduler-yield") {
          output.append("  (void)executor;\n");
        }
        if (expression.captureTypes.length == 0) {
          output.append("  (void)");
          appendCBindingName(inout output, contextName);
          output.append(";\n");
        } else {
          output.append("  ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_environment *environment = (");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_environment *)");
          appendCBindingName(inout output, contextName);
          output.append(";\n  ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_retain(");
          appendCBindingName(inout output, contextName);
          output.append(");\n");
          let capture: usize = 0;
          while (capture < expression.captureTypes.length) {
            output.append("  ");
            const captureCType = try cType(expression.captureTypes[capture]);
            output.append(captureCType);
            output.append(" const ");
            appendCBindingName(
              inout output,
              expression.labels[captureLabelStart + capture]
            );
            output.append(" = environment->");
            appendCBindingName(
              inout output,
              expression.labels[captureLabelStart + capture]
            );
            output.append(";\n");
            capture = capture + 1;
          }
        }
        output.append("  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task *frame = (");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_task *)calloc(1, sizeof(*frame));\n  if (frame == NULL) abort();\n");
        if (expression.value == "scheduler-yield") {
          output.append("  if (executor == NULL) abort();\n");
          output.append("  frame->task.poll = ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_poll;\n  frame->task.executor = executor;\n");
        } else output.append("  frame->task.completed = true;\n");
        if (expression.children.length == 0) {
          throw "native async closure helper lost its body";
        }
        if (functionType.returnType.kind != LoweredTypeKind.voidType) {
          output.append("  frame->result = ");
        } else if (expression.value != "scheduler-yield") output.append("  ");
        if (expression.value != "scheduler-yield") {
          try appendExpression(inout output, owner, expression.children[0]);
          output.append(";\n");
        }
        if (resultNeedsDeinit) output.append("  frame->live_result = true;\n");
        output.append("  return (Z_AsyncInvocation){\n    .task = &frame->task,\n    .failed = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_failed,\n    .take_result = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_take_result,\n    .take_error = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_take_error,\n    .destroy = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_destroy,\n    .callable_context = ");
        if (expression.captureTypes.length > 0) {
          appendCBindingName(inout output, contextName);
        } else output.append("NULL");
        output.append(",\n    .release_context = ");
        if (expression.captureTypes.length > 0) {
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_release");
        } else output.append("NULL");
        output.append(",\n  };\n}\n\n");
        if (expression.captureTypes.length > 0) {
          output.append("static Z_");
          output.append(functionType.name);
          output.append(" ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_make(");
          let capture: usize = 0;
          while (capture < expression.captureTypes.length) {
            if (capture > 0) output.append(", ");
            const captureCType = try cType(expression.captureTypes[capture]);
            output.append(captureCType);
            output.append(" ");
            appendCBindingName(
              inout output,
              expression.labels[captureLabelStart + capture]
            );
            capture = capture + 1;
          }
          output.append(") {\n  ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_environment *environment = malloc(sizeof(*environment));\n  if (environment == NULL) abort();\n  environment->refcount = 1;\n");
          capture = 0;
          while (capture < expression.captureTypes.length) {
            output.append("  environment->");
            appendCBindingName(
              inout output,
              expression.labels[captureLabelStart + capture]
            );
            output.append(" = ");
            appendCBindingName(
              inout output,
              expression.labels[captureLabelStart + capture]
            );
            output.append(";\n");
            capture = capture + 1;
          }
          output.append("  return (Z_");
          output.append(functionType.name);
          output.append("){ .start = ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_start, .context = environment, .retain = ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_retain, .release = ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_release };\n}\n\n");
        } else {
          output.append("static const Z_");
          output.append(functionType.name);
          output.append(" ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_value = { .start = ");
          appendCallableHelperName(inout output, owner, expressionIndex);
          output.append("_start, .context = NULL, .retain = NULL, .release = NULL };\n\n");
        }
        expressionIndex = expressionIndex + 1;
        continue;
      }
      output.append("static ");
      output.append(returnType);
      output.append(" ");
      appendCallableHelperName(inout output, owner, expressionIndex);
      output.append("_call(void *");
      appendCBindingName(inout output, contextName);
      let parameter: usize = 0;
      while (parameter < functionType.parameters.length) {
        output.append(", ");
        if (expression.kind == LoweredExpressionKind.closureValue) {
          try appendCallableParameterDeclaration(
            inout output,
            functionType.parameters[parameter],
            expression.labels[parameterLabelStart + parameter]
          );
        } else {
          try appendCallableParameterDeclaration(
            inout output,
            functionType.parameters[parameter],
            functionType.parameters[parameter].name
          );
        }
        parameter = parameter + 1;
      }
      output.append(") {\n");
      if (expression.captureTypes.length == 0) {
        output.append("  (void)");
        appendCBindingName(inout output, contextName);
        output.append(";\n");
      } else {
        output.append("  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *environment = (");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *)");
        appendCBindingName(inout output, contextName);
        output.append(";\n");
        let capture: usize = 0;
        while (capture < expression.captureTypes.length) {
          output.append("  ");
          const captureCType = try cType(expression.captureTypes[capture]);
          output.append(captureCType);
          output.append(" const ");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          output.append(" = environment->");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          output.append(";\n");
          capture = capture + 1;
        }
      }
      output.append("  return ");
      if (expression.kind == LoweredExpressionKind.directFunctionValue) {
        appendCBindingName(inout output, expression.value);
        output.append("(");
        parameter = 0;
        while (parameter < functionType.parameters.length) {
          if (parameter > 0) output.append(", ");
          appendCBindingName(
            inout output,
            functionType.parameters[parameter].name
          );
          parameter = parameter + 1;
        }
        output.append(")");
      } else {
        if (expression.children.length == 0) {
          throw "native closure helper lost its body";
        }
        if (expression.labels[2] == "throwing") {
          output.append("(");
          output.append(returnType);
          output.append("){ .tag = Z_");
          output.append(functionType.returnType.name);
          output.append("Tag_success, .payload.success = ");
        }
        const body = expression.children[0];
        try appendExpression(inout output, owner, body);
        if (expression.labels[2] == "throwing") output.append(" }");
      }
      output.append(";\n}\n\n");
      if (expression.captureTypes.length > 0) {
        output.append("static Z_");
        output.append(functionType.name);
        output.append(" ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_make(");
        let capture: usize = 0;
        while (capture < expression.captureTypes.length) {
          if (capture > 0) output.append(", ");
          const captureCType = try cType(expression.captureTypes[capture]);
          output.append(captureCType);
          output.append(" ");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          capture = capture + 1;
        }
        output.append(") {\n  ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_environment *environment = malloc(sizeof(*environment));\n  if (environment == NULL) abort();\n  environment->refcount = 1;\n");
        capture = 0;
        while (capture < expression.captureTypes.length) {
          output.append("  environment->");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          output.append(" = ");
          appendCBindingName(
            inout output,
            expression.labels[captureLabelStart + capture]
          );
          output.append(";\n");
          capture = capture + 1;
        }
        output.append("  return (Z_");
        output.append(functionType.name);
        output.append("){ .call = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_call, .context = environment, .retain = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_retain, .release = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_release };\n}\n\n");
      } else {
        output.append("static const Z_");
        output.append(functionType.name);
        output.append(" ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_value = { .call = ");
        appendCallableHelperName(inout output, owner, expressionIndex);
        output.append("_call, .context = NULL, .retain = NULL, .release = NULL };\n\n");
      }
      expressionIndex = expressionIndex + 1;
    }
  }
}

function appendAsyncCallableRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void {
  let required = false;
  for (const functionType of program.functionTypes) {
    if (functionType.asynchronous) required = true;
  }
  if (!required) return;
  output.append("static __attribute__((unused)) void z_stage1_async_enqueue(Z_AsyncExecutor *executor, Z_AsyncTask *task) {\n");
  output.append("  if (executor == NULL || task == NULL || task->completed || task->queued) abort();\n");
  output.append("  task->executor = executor;\n  task->queued = true;\n  task->next = NULL;\n");
  output.append("  if (executor->tail == NULL) executor->head = task;\n");
  output.append("  else executor->tail->next = task;\n");
  output.append("  executor->tail = task;\n}\n\n");
  output.append("typedef struct Z_AsyncAwaiter {\n");
  output.append("  Z_AsyncTask task;\n");
  output.append("  Z_AsyncTask *child;\n");
  output.append("} Z_AsyncAwaiter;\n\n");
  output.append("static __attribute__((unused)) void z_stage1_async_awaiter_poll(Z_AsyncTask *task) {\n");
  output.append("  Z_AsyncAwaiter *awaiter = (Z_AsyncAwaiter *)task;\n");
  output.append("  if (awaiter->child == NULL || !awaiter->child->completed) abort();\n");
  output.append("  task->completed = true;\n}\n\n");
  output.append("static __attribute__((unused)) bool z_stage1_async_run_one(Z_AsyncExecutor *executor) {\n");
  output.append("  if (executor == NULL || executor->head == NULL) return false;\n");
  output.append("  Z_AsyncTask *task = executor->head;\n");
  output.append("  executor->head = task->next;\n");
  output.append("  if (executor->head == NULL) executor->tail = NULL;\n");
  output.append("  task->next = NULL;\n  task->queued = false;\n");
  output.append("  if (!task->completed) {\n");
  output.append("    if (task->poll == NULL) abort();\n");
  output.append("    task->poll(task);\n  }\n");
  output.append("  if (task->completed && task->waiter != NULL) {\n");
  output.append("    Z_AsyncTask *waiter = task->waiter;\n");
  output.append("    task->waiter = NULL;\n");
  output.append("    z_stage1_async_enqueue(waiter->executor, waiter);\n");
  output.append("  }\n  return true;\n}\n\n");
}

function appendAsyncCallableAwaitHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const owner of program.functions) {
    let expressionIndex: usize = 0;
    while (expressionIndex < owner.expressions.length) {
      const expression = view owner.expressions[expressionIndex];
      if (
        expression.kind != LoweredExpressionKind.asyncFunctionAwait
      ) {
        expressionIndex = expressionIndex + 1;
        continue;
      }
      let functionTypeIndex = program.functionTypes.length;
      let candidate: usize = 0;
      while (candidate < program.functionTypes.length) {
        if (program.functionTypes[candidate].name == expression.value) {
          functionTypeIndex = candidate;
        }
        candidate = candidate + 1;
      }
      if (functionTypeIndex >= program.functionTypes.length) {
        throw "native async callable await helper could not resolve its function type";
      }
      const functionType = view program.functionTypes[functionTypeIndex];
      if (!functionType.asynchronous) {
        throw "native async callable await helper received a synchronous function type";
      }
      const returnType = try cType(functionType.returnType);
      output.append("static __attribute__((unused)) ");
      output.append(returnType);
      output.append(" ");
      appendAsyncCallableAwaitHelperName(
        inout output,
        owner,
        expressionIndex
      );
      output.append("(Z_");
      output.append(functionType.name);
      output.append(" callable");
      let parameter: usize = 0;
      while (parameter < functionType.parameters.length) {
        output.append(", ");
        try appendCallableParameterDeclaration(
          inout output,
          functionType.parameters[parameter],
          functionType.parameters[parameter].name
        );
        parameter = parameter + 1;
      }
      output.append(") {\n  Z_AsyncExecutor executor = {0};\n  Z_AsyncAwaiter awaiter = {0};\n  Z_AsyncInvocation invocation = Z_");
      output.append(functionType.name);
      output.append("_start(callable, &executor");
      for (const functionParameter of functionType.parameters) {
        output.append(", ");
        appendCBindingName(inout output, functionParameter.name);
      }
      output.append(");\n");
      output.append("  if (invocation.task == NULL) abort();\n");
      output.append("  if (!invocation.task->completed) {\n");
      output.append("    awaiter.task.poll = z_stage1_async_awaiter_poll;\n");
      output.append("    awaiter.task.executor = &executor;\n");
      output.append("    awaiter.child = invocation.task;\n");
      output.append("    invocation.task->waiter = &awaiter.task;\n");
      output.append("    z_stage1_async_enqueue(&executor, invocation.task);\n");
      output.append("    while (!awaiter.task.completed) {\n");
      output.append("      if (!z_stage1_async_run_one(&executor)) abort();\n");
      output.append("    }\n  }\n");
      output.append("  if (!invocation.task->completed) abort();\n");
      output.append("  if (invocation.failed != NULL && invocation.failed(invocation.task)) abort();\n");
      if (functionType.returnType.kind == LoweredTypeKind.voidType) {
        output.append("  if (invocation.take_result != NULL) invocation.take_result(invocation.task, NULL);\n");
      } else {
        output.append("  ");
        output.append(returnType);
        output.append(" result;\n");
        output.append("  if (invocation.take_result == NULL) abort();\n");
        output.append("  invocation.take_result(invocation.task, &result);\n");
      }
      output.append("  if (invocation.destroy != NULL) invocation.destroy(invocation.task);\n");
      output.append("  if (invocation.release_context != NULL) invocation.release_context(invocation.callable_context);\n");
      if (functionType.returnType.kind != LoweredTypeKind.voidType) {
        output.append("  return result;\n");
      }
      output.append("}\n\n");
      expressionIndex = expressionIndex + 1;
    }
  }
}

function appendPersistentAsyncParentHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.functions) {
    match (persistentAsyncParentShape(program, declaration)) {
      some(shape) => {
        const localCType = match (
          in declaration.statements[shape.localStatement].type
        ) {
          some(type) => try cType(type);
          none => throw "persistent async parent lost its callable local type";
        };
        const localTypeName = match (
          in declaration.statements[shape.localStatement].type
        ) {
          some(type) => type.name.copyBytes(0, type.name.byteLength);
          none => throw "persistent async parent lost its callable local type";
        };
        output.append("typedef struct ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" {\n  Z_AsyncTask task;\n  uint32_t state;\n  ");
        output.append(localCType);
        output.append(" local;\n  bool live_local;\n  Z_AsyncInvocation child;\n  int32_t result;\n} ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(";\n\nstatic void ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_release_child(");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *frame) {\n");
        output.append("  if (frame->child.task == NULL) return;\n");
        output.append("  if (frame->child.destroy != NULL) frame->child.destroy(frame->child.task);\n");
        output.append("  if (frame->child.release_context != NULL) frame->child.release_context(frame->child.callable_context);\n");
        output.append("  frame->child = (Z_AsyncInvocation){0};\n}\n\n");
        output.append("static void ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_poll(Z_AsyncTask *task) {\n  ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *frame = (");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *)task;\n");
        output.append("  if (frame->state == 0) {\n    frame->local = ");
        try appendExpression(
          inout output,
          declaration,
          shape.localInitializer
        );
        output.append(";\n    frame->live_local = true;\n    frame->child = Z_");
        output.append(localTypeName);
        output.append("_start(frame->local, task->executor);\n");
        output.append("    if (frame->child.task == NULL) abort();\n    frame->state = 1;\n");
        output.append("    if (frame->child.task->completed) {\n");
        output.append("      z_stage1_async_enqueue(task->executor, task);\n");
        output.append("    } else {\n");
        output.append("      if (frame->child.task->waiter != NULL) abort();\n");
        output.append("      frame->child.task->waiter = task;\n");
        output.append("      z_stage1_async_enqueue(task->executor, frame->child.task);\n");
        output.append("    }\n    return;\n  }\n");
        output.append("  if (frame->state != 1 || frame->child.task == NULL || !frame->child.task->completed) abort();\n");
        output.append("  if (frame->child.failed != NULL && frame->child.failed(frame->child.task)) abort();\n");
        output.append("  if (frame->child.take_result != NULL) frame->child.take_result(frame->child.task, NULL);\n  ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_release_child(frame);\n  frame->result = ");
        try appendExpression(
          inout output,
          declaration,
          shape.returnExpression
        );
        output.append(";\n  Z_");
        output.append(localTypeName);
        output.append("_deinit(&frame->local);\n  frame->live_local = false;\n  task->completed = true;\n}\n\n");
        output.append("static ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_start(Z_AsyncExecutor *executor) {\n  ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *frame = (");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *)calloc(1, sizeof(*frame));\n  if (frame == NULL || executor == NULL) abort();\n  frame->task.poll = ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_poll;\n  frame->task.executor = executor;\n  return frame;\n}\n\n");
        output.append("static void ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_destroy(");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append(" *frame) {\n  if (frame == NULL) return;\n  ");
        appendPersistentAsyncParentName(inout output, declaration);
        output.append("_release_child(frame);\n  if (frame->live_local) Z_");
        output.append(localTypeName);
        output.append("_deinit(&frame->local);\n  free(frame);\n}\n\n");
      }
      none => {}
    }
  }
}

function appendThreadTaskRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  const taskNames = programTaskTypeNames(program);
  const usesMainDelay = programUsesMainDelay(program);
  for (const taskName of taskNames) {
    const resultType = try taskResultType(program, taskName);
    const nativeResultType = try cType(resultType);
    const resultNeedsDeinit = loweredTypeNeedsDeinit(program, resultType);
    output.append("static void Z_");
    output.append(taskName);
    output.append("_lock(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n#if defined(_WIN32)\n  AcquireSRWLockExclusive(&storage->state_mutex);\n#else\n  if (pthread_mutex_lock(&storage->state_mutex) != 0) abort();\n#endif\n}\n\n");
    output.append("static void Z_");
    output.append(taskName);
    output.append("_unlock(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n#if defined(_WIN32)\n  ReleaseSRWLockExclusive(&storage->state_mutex);\n#else\n  if (pthread_mutex_unlock(&storage->state_mutex) != 0) abort();\n#endif\n}\n\n");
    output.append("static void Z_");
    output.append(taskName);
    output.append("_wait(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n#if defined(_WIN32)\n  if (!SleepConditionVariableSRW(&storage->state_condition, &storage->state_mutex, INFINITE, 0)) abort();\n#else\n  if (pthread_cond_wait(&storage->state_condition, &storage->state_mutex) != 0) abort();\n#endif\n}\n\n");
    output.append("static void Z_");
    output.append(taskName);
    output.append("_wake(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n#if defined(_WIN32)\n  WakeAllConditionVariable(&storage->state_condition);\n#else\n  if (pthread_cond_broadcast(&storage->state_condition) != 0) abort();\n#endif\n}\n\n");
    output.append("static bool Z_");
    output.append(taskName);
    output.append("_is_cancellation_requested(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n  Z_");
    output.append(taskName);
    output.append("_lock(storage);\n  const bool requested = storage->cancellation_requested;\n  Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n  return requested;\n}\n\n");
    if (usesMainDelay) {
      output.append("static __attribute__((unused)) bool Z_");
      output.append(taskName);
      output.append("_suspend_for(Z_");
      output.append(taskName);
      output.append("Storage *storage, size_t milliseconds) {\n  Z_");
      output.append(taskName);
      output.append("_lock(storage);\n#if defined(_WIN32)\n  ULONGLONG measured = GetTickCount64();\n  while (!storage->cancellation_requested && milliseconds > 0) {\n    const DWORD slice = milliseconds >= UINT32_MAX ? UINT32_MAX - 1u : (DWORD)milliseconds;\n    const BOOL awakened = SleepConditionVariableSRW(&storage->state_condition, &storage->state_mutex, slice, 0);\n    if (!awakened && GetLastError() != ERROR_TIMEOUT) abort();\n    const ULONGLONG now = GetTickCount64();\n    const ULONGLONG elapsed = now - measured;\n    milliseconds = elapsed >= milliseconds ? 0 : milliseconds - (size_t)elapsed;\n    measured = now;\n  }\n#else\n  struct timespec deadline;\n  if (clock_gettime(CLOCK_REALTIME, &deadline) != 0) abort();\n  deadline.tv_sec += (time_t)(milliseconds / 1000);\n  deadline.tv_nsec += (long)((milliseconds % 1000) * 1000000);\n  if (deadline.tv_nsec >= 1000000000L) { deadline.tv_sec += 1; deadline.tv_nsec -= 1000000000L; }\n  while (!storage->cancellation_requested) {\n    const int status = pthread_cond_timedwait(&storage->state_condition, &storage->state_mutex, &deadline);\n    if (status == ETIMEDOUT) break;\n    if (status != 0) abort();\n  }\n#endif\n  const bool completed = !storage->cancellation_requested;\n  if (!completed) storage->continuation_cancelled = true;\n  Z_");
      output.append(taskName);
      output.append("_unlock(storage);\n  return completed;\n}\n\n");
    }
    output.append("static __attribute__((unused)) void Z_");
    output.append(taskName);
    output.append("_run_on_main(Z_");
    output.append(taskName);
    output.append("Storage *storage, Z_MainThreadRequest request, void *context) {\n  Z_");
    output.append(taskName);
    output.append("_lock(storage);\n  if (storage->main_request_pending) abort();\n  storage->main_request = request;\n  storage->main_request_context = context;\n  storage->main_request_done = false;\n  storage->main_request_pending = true;\n  Z_");
    output.append(taskName);
    output.append("_wake(storage);\n  while (!storage->main_request_done) Z_");
    output.append(taskName);
    output.append("_wait(storage);\n  Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n}\n\n");
    output.append("static void Z_");
    output.append(taskName);
    output.append("_complete(Z_");
    output.append(taskName);
    output.append("Storage *storage) {\n  Z_");
    output.append(taskName);
    output.append("_lock(storage);\n  storage->finished = true;\n  Z_");
    output.append(taskName);
    output.append("_wake(storage);\n  Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n}\n\n");
    output.append("static void Z_");
    output.append(taskName);
    output.append("_join(Z_");
    output.append(taskName);
    output.append(" *task) {\n  if (task == NULL || task->storage == NULL) abort();\n  Z_");
    output.append(taskName);
    output.append("Storage *storage = task->storage;\n  if (!storage->joined) {\n#if defined(_WIN32)\n    if (GetCurrentThreadId() != storage->owner_thread) abort();\n#else\n    if (!pthread_equal(pthread_self(), storage->owner_thread)) abort();\n#endif\n    Z_");
    output.append(taskName);
    output.append("_lock(storage);\n    while (!storage->finished) {\n      if (!storage->main_request_pending) { Z_");
    output.append(taskName);
    output.append("_wait(storage); continue; }\n      Z_MainThreadRequest request = storage->main_request;\n      void *context = storage->main_request_context;\n      Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n      request(context);\n      Z_");
    output.append(taskName);
    output.append("_lock(storage);\n      storage->main_request_done = true;\n      storage->main_request_pending = false;\n      Z_");
    output.append(taskName);
    output.append("_wake(storage);\n    }\n    Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n#if defined(_WIN32)\n    if (WaitForSingleObject(storage->thread, INFINITE) != WAIT_OBJECT_0) abort();\n    if (!CloseHandle(storage->thread)) abort();\n#else\n    if (pthread_join(storage->thread, NULL) != 0) abort();\n#endif\n    storage->joined = true;\n  }\n}\n\n");
    output.append("static __attribute__((unused)) ");
    output.append(nativeResultType);
    output.append(" Z_");
    output.append(taskName);
    output.append("_await(Z_");
    output.append(taskName);
    output.append(" *task) {\n  Z_");
    output.append(taskName);
    output.append("_join(task);\n  Z_");
    output.append(taskName);
    output.append("Storage *storage = task->storage;\n");
    output.append("  if (!storage->result_live) abort();\n");
    if (resultNeedsDeinit) {
      output.append("  ");
      output.append(nativeResultType);
      output.append(" result = storage->result;\n  storage->result_live = false;\n  return result;\n}\n\n");
    } else {
      output.append("  return storage->result;\n}\n\n");
    }
    output.append("static __attribute__((unused)) void Z_");
    output.append(taskName);
    output.append("_deinit(Z_");
    output.append(taskName);
    output.append(" *task) {\n  if (task == NULL || task->storage == NULL) return;\n  Z_");
    output.append(taskName);
    output.append("_join(task);\n");
    if (resultNeedsDeinit) {
      output.append("  if (task->storage->result_live) {");
      if (resultType.kind == LoweredTypeKind.classType) {
        output.append(" Z_");
        output.append(resultType.name);
        output.append("_release(task->storage->result);");
      } else {
        output.append(" Z_");
        output.append(resultType.name);
        output.append("_deinit(&task->storage->result);");
      }
      output.append(" task->storage->result_live = false; }\n");
    }
    output.append("#if !defined(_WIN32)\n  if (pthread_cond_destroy(&task->storage->state_condition) != 0) abort();\n  if (pthread_mutex_destroy(&task->storage->state_mutex) != 0) abort();\n#endif\n  free(task->storage);\n  task->storage = NULL;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(taskName);
    output.append("_cancel(Z_");
    output.append(taskName);
    output.append(" *task) {\n  if (task == NULL || task->storage == NULL) return;\n  Z_");
    output.append(taskName);
    output.append("Storage *storage = task->storage;\n  Z_");
    output.append(taskName);
    output.append("_lock(storage);\n  storage->cancellation_requested = true;\n  Z_");
    output.append(taskName);
    output.append("_wake(storage);\n  Z_");
    output.append(taskName);
    output.append("_unlock(storage);\n  Z_");
    output.append(taskName);
    output.append("_deinit(task);\n}\n\n");
  }
}

function threadMainCallTarget(
  in declaration: LoweredFunction,
  in expression: LoweredExpression
): String throws String {
  if (expression.children.length == 0) {
    throw "native C emission received a thread.main call without a runner";
  }
  const runner = expression.children[0];
  if (
    declaration.expressions[runner].kind
      != LoweredExpressionKind.directCall
    || declaration.expressions[runner].children.length == 0
  ) throw "native C emission received a thread.main runner without a direct call";
  const callee = declaration.expressions[runner].children[0];
  if (
    declaration.expressions[callee].kind
      != LoweredExpressionKind.localValue
  ) throw "native C emission received a thread.main runner without a local target";
  return declaration.expressions[callee].value.copyBytes(
    0,
    declaration.expressions[callee].value.byteLength
  );
}

function threadMainCallTargetFunctionIndex(
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  in expression: LoweredExpression
): usize throws String {
  const target = try threadMainCallTarget(declaration, expression);
  let index: usize = 0;
  while (index < program.functions.length) {
    if (program.functions[index].name == target) return index;
    index = index + 1;
  }
  throw `native C emission could not resolve thread.main target ${target}`;
}

function threadMainCallIsTail(
  in declaration: LoweredFunction,
  expressionIndex: usize
): boolean {
  for (const statement of declaration.statements) {
    if (statement.kind != LoweredStatementKind.returnStatement) continue;
    match (in statement.expression) {
      some(value) => {
        if (value == expressionIndex) return true;
      }
      none => {}
    }
  }
  for (const expression of declaration.expressions) {
    if (
      expression.kind == LoweredExpressionKind.threadSpawn
      && expression.labels.length > 0
      && expression.labels[0] == "expression"
      && expression.children.length > 0
      && expression.children[0] == expressionIndex
    ) return true;
  }
  return false;
}

function appendMainFrameLocalFieldName(
  inout output: TextBuffer,
  statementIndex: usize
): void {
  output.append(`frame_local_${statementIndex}`);
}

function appendMainFrameLocalLiveFieldName(
  inout output: TextBuffer,
  statementIndex: usize
): void {
  output.append(`frame_local_${statementIndex}_live`);
}

function appendMainFrameRootFields(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  in roots: Array<usize>
): void throws String {
  for (const root of roots) {
    if (
      target.statements[root].kind != LoweredStatementKind.localStatement
    ) continue;
    const localType = match (in target.statements[root].type) {
      some(type) => LoweredType({
        kind: type.kind,
        name: type.name.copyBytes(0, type.name.byteLength),
      });
      none => throw "native main frame received an untyped local";
    };
    const nativeType = try cType(localType);
    output.append("  ");
    output.append(nativeType);
    output.append(" ");
    appendMainFrameLocalFieldName(inout output, root);
    output.append(";\n");
    if (loweredTypeNeedsDeinit(program, localType)) {
      output.append("  bool ");
      appendMainFrameLocalLiveFieldName(inout output, root);
      output.append(";\n");
    }
  }
}

function appendMainFrameRootRestores(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  in roots: Array<usize>,
  depth: usize
): void throws String {
  for (const root of roots) {
    if (
      target.statements[root].kind != LoweredStatementKind.localStatement
    ) continue;
    const localType = match (in target.statements[root].type) {
      some(type) => LoweredType({
        kind: type.kind,
        name: type.name.copyBytes(0, type.name.byteLength),
      });
      none => throw "native main frame received an untyped local";
    };
    const nativeType = try cType(localType);
    appendIndent(inout output, depth);
    output.append(nativeType);
    output.append(" ");
    appendCBindingName(inout output, target.statements[root].name);
    output.append(" __attribute__((unused)) = context->");
    appendMainFrameLocalFieldName(inout output, root);
    output.append(";\n");
    if (loweredTypeNeedsDeinit(program, localType)) {
      if (target.statements[root].liveFlag.byteLength > 0) {
        appendIndent(inout output, depth);
        output.append("bool ");
        appendCBindingName(inout output, target.statements[root].liveFlag);
        output.append(" __attribute__((unused)) = context->");
        appendMainFrameLocalLiveFieldName(inout output, root);
        output.append(";\n");
      }
      appendIndent(inout output, depth);
      output.append("context->");
      appendMainFrameLocalLiveFieldName(inout output, root);
      output.append(" = false;\n");
    }
  }
}

function appendMainFrameRootSaves(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  in roots: Array<usize>,
  depth: usize
): void throws String {
  for (const root of roots) {
    if (
      target.statements[root].kind != LoweredStatementKind.localStatement
    ) continue;
    const localType = match (in target.statements[root].type) {
      some(type) => LoweredType({
        kind: type.kind,
        name: type.name.copyBytes(0, type.name.byteLength),
      });
      none => throw "native main frame received an untyped local";
    };
    appendIndent(inout output, depth);
    output.append("context->");
    appendMainFrameLocalFieldName(inout output, root);
    output.append(" = ");
    appendCBindingName(inout output, target.statements[root].name);
    output.append(";\n");
    if (loweredTypeNeedsDeinit(program, localType)) {
      appendIndent(inout output, depth);
      output.append("context->");
      appendMainFrameLocalLiveFieldName(inout output, root);
      output.append(" = ");
      if (target.statements[root].liveFlag.byteLength > 0) {
        appendCBindingName(inout output, target.statements[root].liveFlag);
      } else output.append("true");
      output.append(";\n");
    }
  }
}

function appendMainFrameRootCleanups(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  in roots: Array<usize>,
  depth: usize
): void throws String {
  let rootIndex = roots.length;
  while (rootIndex > 0) {
    rootIndex = rootIndex - 1;
    const root = roots[rootIndex];
    if (
      target.statements[root].kind != LoweredStatementKind.localStatement
    ) continue;
    const localType = match (in target.statements[root].type) {
      some(type) => LoweredType({
        kind: type.kind,
        name: type.name.copyBytes(0, type.name.byteLength),
      });
      none => throw "native main frame received an untyped local";
    };
    if (!loweredTypeNeedsDeinit(program, localType)) continue;
    appendIndent(inout output, depth);
    output.append("if (context->");
    appendMainFrameLocalLiveFieldName(inout output, root);
    output.append(") { Z_");
    output.append(localType.name);
    if (localType.kind == LoweredTypeKind.classType) {
      output.append("_release(context->");
    } else {
      output.append("_deinit(&context->");
    }
    appendMainFrameLocalFieldName(inout output, root);
    output.append("); context->");
    appendMainFrameLocalLiveFieldName(inout output, root);
    output.append(" = false; }\n");
  }
}

function appendMainFrameRestores(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  segmentLimit: usize,
  depth: usize
): void throws String {
  let segmentIndex: usize = 0;
  while (
    segmentIndex < segmentLimit
    && segmentIndex < target.mainDelaySegments.length
  ) {
    try appendMainFrameRootRestores(
      inout output,
      program,
      target,
      target.mainDelaySegments[segmentIndex].roots,
      depth
    );
    segmentIndex = segmentIndex + 1;
  }
}

function appendMainFrameSaves(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  segmentLimit: usize,
  depth: usize
): void throws String {
  let segmentIndex: usize = 0;
  while (
    segmentIndex < segmentLimit
    && segmentIndex < target.mainDelaySegments.length
  ) {
    try appendMainFrameRootSaves(
      inout output,
      program,
      target,
      target.mainDelaySegments[segmentIndex].roots,
      depth
    );
    segmentIndex = segmentIndex + 1;
  }
}

function appendMainFrameLocalCleanups(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  depth: usize
): void throws String {
  let segmentIndex = target.mainDelaySegments.length;
  while (segmentIndex > 0) {
    segmentIndex = segmentIndex - 1;
    try appendMainFrameRootCleanups(
      inout output,
      program,
      target,
      target.mainDelaySegments[segmentIndex].roots,
      depth
    );
  }
}

function appendMainFrameMatchBinding(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  armIndex: usize,
  depth: usize
): void throws String {
  const arm = view target.statements[armIndex];
  match (in arm.type) {
    some(type) => {
      if (arm.labels.length != 1) {
        throw "native main frame received a payload arm without one binding";
      }
      const nativeType = try cType(type);
      const needsCleanup = loweredTypeNeedsDeinit(program, type);
      appendIndent(inout output, depth);
      if (!needsCleanup) output.append("const ");
      output.append(nativeType);
      output.append(" __attribute__((unused)) ");
      appendCBindingName(inout output, arm.labels[0]);
      output.append(" = context->match_subject.payload.");
      output.append(arm.name);
      output.append(";\n");
      if (needsCleanup) {
        if (arm.liveFlag.byteLength == 0) {
          throw "native main frame lost a cleanup-bearing match payload live flag";
        }
        appendIndent(inout output, depth);
        output.append("bool ");
        appendCBindingName(inout output, arm.liveFlag);
        output.append(" __attribute__((unused)) = context->match_subject_live;\n");
        appendIndent(inout output, depth);
        output.append("context->match_subject_live = false;\n");
      }
    }
    none => {}
  }
}

function appendMainFrameMatchBindingSave(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in target: LoweredFunction,
  armIndex: usize,
  depth: usize
): void throws String {
  const arm = view target.statements[armIndex];
  match (in arm.type) {
    some(type) => {
      if (!loweredTypeNeedsDeinit(program, type)) return;
      if (arm.labels.length != 1 || arm.liveFlag.byteLength == 0) {
        throw "native main frame lost a cleanup-bearing match payload binding";
      }
      appendIndent(inout output, depth);
      output.append("context->match_subject.payload.");
      output.append(arm.name);
      output.append(" = ");
      appendCBindingName(inout output, arm.labels[0]);
      output.append(";\n");
      appendIndent(inout output, depth);
      output.append("context->match_subject_live = ");
      appendCBindingName(inout output, arm.liveFlag);
      output.append(";\n");
    }
    none => {}
  }
}

function appendThreadMainBranchSegmentHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in target: LoweredFunction,
  in prefixRoots: Array<usize>,
  in segments: Array<LoweredMainDelaySegment>,
  in branchName: String,
  matchArm: Option<usize>
): void throws String {
  const parameterCount = target.parameters.length;
  let segmentIndex: usize = 0;
  while (segmentIndex < segments.length) {
    if (segments[segmentIndex].roots.length > 0) {
      output.append("static void ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append(`_${branchName}_segment_${segmentIndex}(void *raw_context) {\n`);
      appendThreadMainStructuredContextPointer(
        inout output,
        declaration,
        expressionIndex
      );
      try appendThreadMainStructuredParameterLocals(
        inout output,
        target,
        parameterCount,
        true
      );
      try appendMainFrameRootRestores(
        inout output,
        program,
        target,
        prefixRoots,
        1
      );
      output.append("  {\n");
      match (in matchArm) {
        some(arm) => try appendMainFrameMatchBinding(
          inout output,
          program,
          target,
          arm,
          2
        );
        none => {}
      }
      let prior: usize = 0;
      while (prior < segmentIndex) {
        try appendMainFrameRootRestores(
          inout output,
          program,
          target,
          segments[prior].roots,
          2
        );
        prior = prior + 1;
      }
      for (const root of segments[segmentIndex].roots) {
        try appendStatement(inout output, target, root, 2);
      }
      let saved: usize = 0;
      while (saved <= segmentIndex) {
        try appendMainFrameRootSaves(
          inout output,
          program,
          target,
          segments[saved].roots,
          2
        );
        saved = saved + 1;
      }
      match (in matchArm) {
        some(arm) => try appendMainFrameMatchBindingSave(
          inout output,
          program,
          target,
          arm,
          2
        );
        none => {}
      }
      output.append("  }\n");
      try appendMainFrameRootSaves(
        inout output,
        program,
        target,
        prefixRoots,
        1
      );
      output.append("}\n\n");
    }
    segmentIndex = segmentIndex + 1;
  }
}

function appendThreadMainStructuredCancellation(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in taskName: String,
  in nativeResultType: String
): void {
  output.append("    Z_");
  output.append(taskName);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("_cancel_suspended, context);\n    free(context);\n");
  if (nativeResultType == "void") {
    output.append("    return;\n");
  } else {
    output.append("    return (");
    output.append(nativeResultType);
    output.append("){0};\n");
  }
}

function appendThreadMainStructuredContextFields(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in expression: LoweredExpression,
  in resultType: LoweredType,
  in nativeResultType: String,
  trackArgumentLiveness: boolean
): void throws String {
  if (resultType.kind != LoweredTypeKind.voidType) {
    output.append("  ");
    output.append(nativeResultType);
    output.append(" result;\n");
  }
  let argument: usize = 0;
  while (argument + 1 < expression.labels.length) {
    const argumentType = try loweredTypeForIdentity(
      program,
      expression.labels[argument + 1]
    );
    const nativeArgumentType = try cType(argumentType);
    output.append("  ");
    output.append(nativeArgumentType);
    output.append(` argument_${argument};\n`);
    if (
      trackArgumentLiveness
      && loweredTypeNeedsDeinit(program, argumentType)
    ) output.append(`  bool argument_${argument}_live;\n`);
    argument = argument + 1;
  }
}

function appendThreadMainStructuredContextPointer(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  expressionIndex: usize
): void {
  output.append("  ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *context = (");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *)raw_context;\n");
}

function appendThreadMainStructuredParameterLocals(
  inout output: TextBuffer,
  in target: LoweredFunction,
  argumentCount: usize,
  immutable: boolean
): void throws String {
  let argument: usize = 0;
  while (argument < argumentCount) {
    const nativeParameterType = try cType(target.parameters[argument].type);
    output.append("  ");
    if (immutable) output.append("const ");
    output.append(nativeParameterType);
    output.append(" ");
    appendCBindingName(inout output, target.parameters[argument].name);
    output.append(` = context->argument_${argument};\n  (void)`);
    appendCBindingName(inout output, target.parameters[argument].name);
    output.append(";\n");
    argument = argument + 1;
  }
}

function appendThreadMainStructuredParameterLiveFlags(
  inout output: TextBuffer,
  in target: LoweredFunction,
  argumentCount: usize,
  restoreFromContext: boolean
): void throws String {
  for (const flag of target.liveFlags) {
    if (!flag.parameter) continue;
    let liveArgument = argumentCount;
    let parameterIndex: usize = 0;
    while (parameterIndex < target.parameters.length) {
      if (target.parameters[parameterIndex].name == flag.owner) {
        liveArgument = parameterIndex;
      }
      parameterIndex = parameterIndex + 1;
    }
    if (liveArgument == argumentCount) {
      throw "native main frame lost a cleanup-bearing parameter live field";
    }
    output.append("  bool ");
    appendCBindingName(inout output, flag.name);
    output.append(" = ");
    if (restoreFromContext) {
      output.append(`context->argument_${liveArgument}_live`);
    } else output.append("true");
    output.append(";\n");
  }
}

function appendThreadMainStructuredParameterLiveFlagSaves(
  inout output: TextBuffer,
  in target: LoweredFunction,
  argumentCount: usize
): void throws String {
  for (const flag of target.liveFlags) {
    if (!flag.parameter) continue;
    let liveArgument = argumentCount;
    let parameterIndex: usize = 0;
    while (parameterIndex < target.parameters.length) {
      if (target.parameters[parameterIndex].name == flag.owner) {
        liveArgument = parameterIndex;
      }
      parameterIndex = parameterIndex + 1;
    }
    if (liveArgument == argumentCount) {
      throw "native main frame lost a cleanup-bearing parameter live field";
    }
    output.append(`  context->argument_${liveArgument}_live = `);
    appendCBindingName(inout output, flag.name);
    output.append(";\n");
  }
}

function appendThreadMainStructuredArgumentCleanups(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in expression: LoweredExpression,
  guarded: boolean
): void throws String {
  let cleanup = expression.labels.length - 1;
  while (cleanup > 0) {
    cleanup = cleanup - 1;
    const argumentType = try loweredTypeForIdentity(
      program,
      expression.labels[cleanup + 1]
    );
    if (!loweredTypeNeedsDeinit(program, argumentType)) continue;
    if (guarded) output.append(`  if (context->argument_${cleanup}_live) { `);
    else output.append("  ");
    output.append("Z_");
    output.append(argumentType.name);
    if (argumentType.kind == LoweredTypeKind.classType) {
      output.append(`_release(context->argument_${cleanup});`);
    } else {
      output.append(`_deinit(&context->argument_${cleanup});`);
    }
    if (guarded) {
      output.append(` context->argument_${cleanup}_live = false; }`);
    }
    output.append("\n");
  }
}

function appendThreadMainStructuredWrapperPrefix(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in expression: LoweredExpression,
  in nativeResultType: String,
  trackArgumentLiveness: boolean
): void throws String {
  const argumentCount = expression.labels.length - 1;
  output.append("static ");
  output.append(nativeResultType);
  output.append(" ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("(Z_");
  output.append(expression.value);
  output.append("Storage *storage");
  let argument: usize = 0;
  while (argument < argumentCount) {
    const argumentType = try loweredTypeForIdentity(
      program,
      expression.labels[argument + 1]
    );
    const nativeArgumentType = try cType(argumentType);
    output.append(", ");
    output.append(nativeArgumentType);
    output.append(` argument_${argument}`);
    argument = argument + 1;
  }
  output.append(") {\n  ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *context = (");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *)calloc(1, sizeof(");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context));\n  if (context == NULL) abort();\n");
  argument = 0;
  while (argument < argumentCount) {
    output.append(`  context->argument_${argument} = argument_${argument};\n`);
    if (trackArgumentLiveness) {
      const argumentType = try loweredTypeForIdentity(
        program,
        expression.labels[argument + 1]
      );
      if (loweredTypeNeedsDeinit(program, argumentType)) {
        output.append(`  context->argument_${argument}_live = true;\n`);
      }
    }
    argument = argument + 1;
  }
}

function appendThreadMainStructuredWrapperResult(
  inout output: TextBuffer,
  in resultType: LoweredType,
  in nativeResultType: String
): void {
  if (resultType.kind != LoweredTypeKind.voidType) {
    output.append("  ");
    output.append(nativeResultType);
    output.append(" result = context->result;\n  free(context);\n  return result;\n");
  } else output.append("  free(context);\n");
  output.append("}\n\n");
}

function appendThreadMainLoopBranch(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize,
  in doneLabel: String
): void throws String {
  if (declaration.statements[index].kind == LoweredStatementKind.blockStatement) {
    for (const child of declaration.statements[index].children) {
      try appendThreadMainLoopStatement(
        inout output,
        declaration,
        child,
        depth,
        doneLabel
      );
    }
    appendCleanups(
      inout output,
      declaration.statements[index].cleanups,
      depth
    );
    return;
  }
  try appendThreadMainLoopStatement(
    inout output,
    declaration,
    index,
    depth,
    doneLabel
  );
}

function threadMainLoopStatementContainsControl(
  in declaration: LoweredFunction,
  index: usize
): boolean {
  if (
    declaration.statements[index].kind == LoweredStatementKind.breakStatement
    || declaration.statements[index].kind
      == LoweredStatementKind.continueStatement
    || declaration.statements[index].kind
      == LoweredStatementKind.returnStatement
    || declaration.statements[index].kind
      == LoweredStatementKind.tryStatement
  ) return true;
  for (const child of declaration.statements[index].children) {
    if (threadMainLoopStatementContainsControl(
      declaration,
      child
    )) return true;
  }
  return false;
}

function threadMainLoopRootsContainControl(
  in declaration: LoweredFunction,
  in roots: Array<usize>
): boolean {
  for (const root of roots) {
    if (threadMainLoopStatementContainsControl(
      declaration,
      root
    )) return true;
  }
  return false;
}

function threadMainLoopStatementContainsCompletion(
  in declaration: LoweredFunction,
  index: usize
): boolean {
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.returnStatement
    || declaration.statements[index].kind
      == LoweredStatementKind.tryStatement
  ) return true;
  for (const child of declaration.statements[index].children) {
    if (threadMainLoopStatementContainsCompletion(
      declaration,
      child
    )) return true;
  }
  return false;
}

function threadMainLoopRootsContainCompletion(
  in declaration: LoweredFunction,
  in roots: Array<usize>
): boolean {
  for (const root of roots) {
    if (threadMainLoopStatementContainsCompletion(
      declaration,
      root
    )) return true;
  }
  return false;
}

function appendThreadMainLoopStatement(
  inout output: TextBuffer,
  in declaration: LoweredFunction,
  index: usize,
  depth: usize,
  in doneLabel: String
): void throws String {
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.tryStatement
  ) {
    try appendTryStatement(
      inout output,
      declaration,
      index,
      depth,
      doneLabel
    );
    return;
  }
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.returnStatement
  ) {
    match (in declaration.statements[index].expression) {
      some(expression) => {
        try appendBorrowedTemporaryInitializers(
          inout output,
          declaration,
          expression,
          depth
        );
        let returnType = "";
        match (in declaration.statements[index].type) {
          some(type) => returnType = try cType(type);
          none => returnType = try cType(declaration.returnType);
        }
        appendIndent(inout output, depth);
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
        appendCleanups(
          inout output,
          declaration.statements[index].cleanups,
          depth
        );
        appendIndent(inout output, depth);
        output.append(`context->result = _z_stage1_return_${index};\n`);
      }
      none => appendCleanups(
        inout output,
        declaration.statements[index].cleanups,
        depth
      );
    }
    appendIndent(inout output, depth);
    output.append("context->loop_control = 3; goto ");
    output.append(doneLabel);
    output.append(";\n");
    return;
  }
  if (
    declaration.statements[index].kind == LoweredStatementKind.breakStatement
    || declaration.statements[index].kind
      == LoweredStatementKind.continueStatement
  ) {
    appendCleanups(
      inout output,
      declaration.statements[index].cleanups,
      depth
    );
    appendIndent(inout output, depth);
    output.append("context->loop_control = ");
    if (declaration.statements[index].kind == LoweredStatementKind.breakStatement) {
      output.append("2");
    } else output.append("1");
    output.append("; goto ");
    output.append(doneLabel);
    output.append(";\n");
    return;
  }
  if (
    declaration.statements[index].kind
      == LoweredStatementKind.localStatement
  ) {
    try appendLocalStatementStorage(
      inout output,
      declaration,
      index,
      depth
    );
    for (const child of declaration.statements[index].children) {
      try appendThreadMainLoopStatement(
        inout output,
        declaration,
        child,
        depth,
        doneLabel
      );
    }
    return;
  }
  if (declaration.statements[index].kind == LoweredStatementKind.blockStatement) {
    if (
      declaration.statements[index].labels.length == 1
      && declaration.statements[index].labels[0]
        == "nested-try-normalized"
    ) {
      for (const child of declaration.statements[index].children) {
        try appendThreadMainLoopStatement(
          inout output,
          declaration,
          child,
          depth,
          doneLabel
        );
      }
      appendCleanups(
        inout output,
        declaration.statements[index].cleanups,
        depth
      );
      return;
    }
    appendIndent(inout output, depth);
    output.append("{\n");
    for (const child of declaration.statements[index].children) {
      try appendThreadMainLoopStatement(
        inout output,
        declaration,
        child,
        depth + 1,
        doneLabel
      );
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
      some(condition) => try appendCondition(
        inout output,
        declaration,
        condition
      );
      none => throw "native loop segment received an if without a condition";
    }
    output.append(" {\n");
    if (declaration.statements[index].children.length == 0) {
      throw "native loop segment received an if without a branch";
    }
    const thenBranch = declaration.statements[index].children[0];
    try appendThreadMainLoopBranch(
      inout output,
      declaration,
      thenBranch,
      depth + 1,
      doneLabel
    );
    appendIndent(inout output, depth);
    if (declaration.statements[index].children.length > 1) {
      output.append("} else {\n");
      const elseBranch = declaration.statements[index].children[1];
      try appendThreadMainLoopBranch(
        inout output,
        declaration,
        elseBranch,
        depth + 1,
        doneLabel
      );
      appendIndent(inout output, depth);
    }
    output.append("}\n");
    return;
  }
  try appendStatement(inout output, declaration, index, depth);
}

function appendThreadMainLoopSegmentHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in target: LoweredFunction,
  in plan: LoweredMainDelayLoop
): void throws String {
  const parameterCount = target.parameters.length;
  let segmentIndex: usize = 0;
  while (segmentIndex < plan.segments.length) {
    if (plan.segments[segmentIndex].roots.length > 0) {
      output.append("static void ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append(`_loop_segment_${segmentIndex}(void *raw_context) {\n`);
      appendThreadMainStructuredContextPointer(
        inout output,
        declaration,
        expressionIndex
      );
      try appendThreadMainStructuredParameterLocals(
        inout output,
        target,
        parameterCount,
        true
      );
      try appendMainFrameRootRestores(
        inout output,
        program,
        target,
        plan.prefixRoots,
        1
      );
      output.append("  {\n");
      let prior: usize = 0;
      while (prior < segmentIndex) {
        try appendMainFrameRootRestores(
          inout output,
          program,
          target,
          plan.segments[prior].roots,
          2
        );
        prior = prior + 1;
      }
      const doneLabel = `_z_loop_segment_${segmentIndex}_done`;
      const hasControl = threadMainLoopRootsContainControl(
        target,
        plan.segments[segmentIndex].roots
      );
      for (const root of plan.segments[segmentIndex].roots) {
        try appendThreadMainLoopStatement(
          inout output,
          target,
          root,
          2,
          doneLabel
        );
      }
      if (hasControl) {
        appendIndent(inout output, 2);
        output.append(doneLabel);
        output.append(": ;\n");
        if (threadMainLoopRootsContainCompletion(
          target,
          plan.segments[segmentIndex].roots
        )) {
          appendIndent(inout output, 2);
          output.append("if (context->loop_control == 3) return;\n");
        }
      }
      let saved: usize = 0;
      while (saved <= segmentIndex) {
        try appendMainFrameRootSaves(
          inout output,
          program,
          target,
          plan.segments[saved].roots,
          2
        );
        saved = saved + 1;
      }
      output.append("  }\n");
      try appendMainFrameRootSaves(
        inout output,
        program,
        target,
        plan.prefixRoots,
        1
      );
      output.append("}\n\n");
    }
    segmentIndex = segmentIndex + 1;
  }
}

function appendThreadMainLoopCallHelper(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in expression: LoweredExpression,
  targetFunctionIndex: usize
): void throws String {
  const target = view program.functions[targetFunctionIndex];
  if (target.mainDelayLoops.length != 1) {
    throw "native structured main suspension requires exactly one while plan";
  }
  const plan = view target.mainDelayLoops[0];
  let hasFunctionExit = threadMainLoopRootsContainCompletion(
    target,
    plan.roots
  );
  for (const segment of plan.segments) {
    if (threadMainLoopRootsContainCompletion(
      target,
      segment.roots
    )) hasFunctionExit = true;
  }
  const resultType = try loweredTypeForIdentity(program, expression.labels[0]);
  const nativeResultType = try cType(resultType);
  const argumentCount = expression.labels.length - 1;
  if (!threadMainCallIsTail(declaration, expressionIndex)) {
    throw "native suspending thread.main calls must be the worker closure's tail return in the first tier";
  }
  if (target.parameters.length != argumentCount) {
    throw "native C emission received mismatched thread.main arguments";
  }

  output.append("typedef struct ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context {\n");
  try appendThreadMainStructuredContextFields(
    inout output,
    program,
    expression,
    resultType,
    nativeResultType,
    false
  );
  output.append("  bool loop_condition;\n  int loop_control;\n");
  try appendMainFrameRootFields(
    inout output,
    program,
    target,
    plan.prefixRoots
  );
  for (const segment of plan.segments) {
    try appendMainFrameRootFields(
      inout output,
      program,
      target,
      segment.roots
    );
  }
  output.append("} ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context;\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_initialize(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    true
  );
  for (const root of plan.prefixRoots) {
    try appendStatement(inout output, target, root, 1);
  }
  try appendMainFrameRootSaves(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_condition(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    true
  );
  try appendMainFrameRootRestores(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("  context->loop_control = 0;\n  context->loop_condition = ");
  try appendCondition(inout output, target, plan.condition);
  output.append(";\n");
  try appendMainFrameRootSaves(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("}\n\n");

  try appendThreadMainLoopSegmentHelpers(
    inout output,
    program,
    declaration,
    expressionIndex,
    target,
    plan
  );

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_finish_iteration(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    true
  );
  try appendMainFrameRootRestores(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("  {\n");
  for (const segment of plan.segments) {
    try appendMainFrameRootRestores(
      inout output,
      program,
      target,
      segment.roots,
      2
    );
  }
  const finishLabel = "_z_loop_iteration_done";
  const finishHasControl = threadMainLoopRootsContainControl(
    target,
    plan.roots
  );
  for (const root of plan.roots) {
    try appendThreadMainLoopStatement(
      inout output,
      target,
      root,
      2,
      finishLabel
    );
  }
  appendCleanups(
    inout output,
    target.statements[plan.block].cleanups,
    2
  );
  if (finishHasControl) {
    appendIndent(inout output, 2);
    output.append(finishLabel);
    output.append(": ;\n");
    if (threadMainLoopRootsContainCompletion(
      target,
      plan.roots
    )) {
      appendIndent(inout output, 2);
      output.append("if (context->loop_control == 3) return;\n");
    }
  }
  for (const segment of plan.segments) {
    try appendMainFrameRootSaves(
      inout output,
      program,
      target,
      segment.roots,
      2
    );
  }
  output.append("  }\n");
  try appendMainFrameRootSaves(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("}\n\n");

  output.append("static ");
  output.append(nativeResultType);
  output.append(" ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *context) {\n");
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    false
  );
  try appendMainFrameRootRestores(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredParameterLiveFlags(
    inout output,
    target,
    argumentCount,
    false
  );
  try appendFunctionTail(inout output, target);
  output.append("}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  ");
  if (resultType.kind != LoweredTypeKind.voidType) output.append("context->result = ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(context);\n}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_cancel_suspended(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  (void)context;\n");
  let cleanup = plan.segments.length;
  while (cleanup > 0) {
    cleanup = cleanup - 1;
    try appendMainFrameRootCleanups(
      inout output,
      program,
      target,
      plan.segments[cleanup].roots,
      1
    );
  }
  try appendMainFrameRootCleanups(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredArgumentCleanups(
    inout output,
    program,
    expression,
    false
  );
  output.append("}\n\n");

  try appendThreadMainStructuredWrapperPrefix(
    inout output,
    program,
    declaration,
    expressionIndex,
    expression,
    nativeResultType,
    false
  );
  output.append("  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_initialize, context);\n  while (true) {\n    Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_condition, context);\n    if (!context->loop_condition) break;\n");
  let segmentIndex: usize = 0;
  while (segmentIndex < plan.segments.length) {
    if (plan.segments[segmentIndex].roots.length > 0) {
      output.append("    Z_");
      output.append(expression.value);
      output.append("_run_on_main(storage, ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append(`_loop_segment_${segmentIndex}, context);\n`);
      if (hasFunctionExit) {
        output.append("    if (context->loop_control == 3) goto _z_thread_main_completed;\n");
      }
      output.append("    if (context->loop_control == 2) break;\n");
      output.append("    if (context->loop_control == 1) continue;\n");
    }
    output.append("    if (!Z_");
    output.append(expression.value);
    output.append("_suspend_for(storage, ");
    output.append(plan.segments[segmentIndex].milliseconds);
    output.append(")) {\n");
    appendThreadMainStructuredCancellation(
      inout output,
      declaration,
      expressionIndex,
      expression.value,
      nativeResultType
    );
    output.append("    }\n");
    segmentIndex = segmentIndex + 1;
  }
  output.append("    Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_finish_iteration, context);\n");
  if (hasFunctionExit) {
    output.append("    if (context->loop_control == 3) goto _z_thread_main_completed;\n");
  }
  output.append("    if (context->loop_control == 2) break;\n");
  output.append("  }\n  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run, context);\n");
  if (hasFunctionExit) {
    output.append("  _z_thread_main_completed: ;\n");
  }
  appendThreadMainStructuredWrapperResult(
    inout output,
    resultType,
    nativeResultType
  );
}

function appendThreadMainIfCallHelper(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in expression: LoweredExpression,
  targetFunctionIndex: usize
): void throws String {
  const target = view program.functions[targetFunctionIndex];
  if (target.mainDelayIfs.length != 1) {
    throw "native structured main suspension requires exactly one if plan";
  }
  const plan = view target.mainDelayIfs[0];
  const resultType = try loweredTypeForIdentity(program, expression.labels[0]);
  const nativeResultType = try cType(resultType);
  const argumentCount = expression.labels.length - 1;
  if (!threadMainCallIsTail(declaration, expressionIndex)) {
    throw "native suspending thread.main calls must be the worker closure's tail return in the first tier";
  }
  if (target.parameters.length != argumentCount) {
    throw "native C emission received mismatched thread.main arguments";
  }

  output.append("typedef struct ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context {\n");
  try appendThreadMainStructuredContextFields(
    inout output,
    program,
    expression,
    resultType,
    nativeResultType,
    false
  );
  output.append("  bool branch_0;\n");
  try appendMainFrameRootFields(
    inout output,
    program,
    target,
    plan.prefixRoots
  );
  for (const segment of plan.thenSegments) {
    try appendMainFrameRootFields(
      inout output,
      program,
      target,
      segment.roots
    );
  }
  for (const segment of plan.elseSegments) {
    try appendMainFrameRootFields(
      inout output,
      program,
      target,
      segment.roots
    );
  }
  output.append("} ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context;\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_choose(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    true
  );
  for (const root of plan.prefixRoots) {
    try appendStatement(inout output, target, root, 1);
  }
  output.append("  context->branch_0 = ");
  try appendCondition(inout output, target, plan.condition);
  output.append(";\n");
  try appendMainFrameRootSaves(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  output.append("}\n\n");

  try appendThreadMainBranchSegmentHelpers(
    inout output,
    program,
    declaration,
    expressionIndex,
    target,
    plan.prefixRoots,
    plan.thenSegments,
    "then",
    Option<usize>.none
  );
  try appendThreadMainBranchSegmentHelpers(
    inout output,
    program,
    declaration,
    expressionIndex,
    target,
    plan.prefixRoots,
    plan.elseSegments,
    "else",
    Option<usize>.none
  );

  output.append("static ");
  output.append(nativeResultType);
  output.append(" ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *context) {\n");
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    false
  );
  try appendMainFrameRootRestores(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredParameterLiveFlags(
    inout output,
    target,
    argumentCount,
    false
  );
  output.append("  if (context->branch_0) {\n");
  for (const segment of plan.thenSegments) {
    try appendMainFrameRootRestores(
      inout output,
      program,
      target,
      segment.roots,
      2
    );
  }
  for (const root of plan.thenRoots) {
    try appendStatement(inout output, target, root, 2);
  }
  appendCleanups(
    inout output,
    target.statements[plan.thenBlock].cleanups,
    2
  );
  output.append("  } else {\n");
  for (const segment of plan.elseSegments) {
    try appendMainFrameRootRestores(
      inout output,
      program,
      target,
      segment.roots,
      2
    );
  }
  for (const root of plan.elseRoots) {
    try appendStatement(inout output, target, root, 2);
  }
  match (in plan.elseBlock) {
    some(block) => appendCleanups(
      inout output,
      target.statements[block].cleanups,
      2
    );
    none => {}
  }
  output.append("  }\n");
  try appendFunctionTail(inout output, target);
  output.append("}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  ");
  if (resultType.kind != LoweredTypeKind.voidType) {
    output.append("context->result = ");
  }
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(context);\n}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_cancel_suspended(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  (void)context;\n");
  let cleanup = plan.elseSegments.length;
  while (cleanup > 0) {
    cleanup = cleanup - 1;
    try appendMainFrameRootCleanups(
      inout output,
      program,
      target,
      plan.elseSegments[cleanup].roots,
      1
    );
  }
  cleanup = plan.thenSegments.length;
  while (cleanup > 0) {
    cleanup = cleanup - 1;
    try appendMainFrameRootCleanups(
      inout output,
      program,
      target,
      plan.thenSegments[cleanup].roots,
      1
    );
  }
  try appendMainFrameRootCleanups(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredArgumentCleanups(
    inout output,
    program,
    expression,
    false
  );
  output.append("}\n\n");

  try appendThreadMainStructuredWrapperPrefix(
    inout output,
    program,
    declaration,
    expressionIndex,
    expression,
    nativeResultType,
    false
  );
  output.append("  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_choose, context);\n");
  output.append("  if (context->branch_0) {\n");
  let segmentIndex: usize = 0;
  while (segmentIndex < plan.thenSegments.length) {
    if (plan.thenSegments[segmentIndex].roots.length > 0) {
      output.append("    Z_");
      output.append(expression.value);
      output.append("_run_on_main(storage, ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append(`_then_segment_${segmentIndex}, context);\n`);
    }
    output.append("    if (!Z_");
    output.append(expression.value);
    output.append("_suspend_for(storage, ");
    output.append(plan.thenSegments[segmentIndex].milliseconds);
    output.append(")) {\n");
    appendThreadMainStructuredCancellation(
      inout output,
      declaration,
      expressionIndex,
      expression.value,
      nativeResultType
    );
    output.append("    }\n");
    segmentIndex = segmentIndex + 1;
  }
  output.append("  } else {\n");
  segmentIndex = 0;
  while (segmentIndex < plan.elseSegments.length) {
    if (plan.elseSegments[segmentIndex].roots.length > 0) {
      output.append("    Z_");
      output.append(expression.value);
      output.append("_run_on_main(storage, ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append(`_else_segment_${segmentIndex}, context);\n`);
    }
    output.append("    if (!Z_");
    output.append(expression.value);
    output.append("_suspend_for(storage, ");
    output.append(plan.elseSegments[segmentIndex].milliseconds);
    output.append(")) {\n");
    appendThreadMainStructuredCancellation(
      inout output,
      declaration,
      expressionIndex,
      expression.value,
      nativeResultType
    );
    output.append("    }\n");
    segmentIndex = segmentIndex + 1;
  }
  output.append("  }\n  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run, context);\n");
  appendThreadMainStructuredWrapperResult(
    inout output,
    resultType,
    nativeResultType
  );
}

function appendThreadMainMatchCallHelper(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  expressionIndex: usize,
  in expression: LoweredExpression,
  targetFunctionIndex: usize
): void throws String {
  const target = view program.functions[targetFunctionIndex];
  if (target.mainDelayMatches.length != 1) {
    throw "native structured main suspension requires exactly one match plan";
  }
  const plan = view target.mainDelayMatches[0];
  const matchStatement = view target.statements[plan.statement];
  const resultType = try loweredTypeForIdentity(program, expression.labels[0]);
  const nativeResultType = try cType(resultType);
  const nativeSubjectType = try cType(plan.subjectType);
  const argumentCount = expression.labels.length - 1;
  if (!threadMainCallIsTail(declaration, expressionIndex)) {
    throw "native suspending thread.main calls must be the worker closure's tail return in the first tier";
  }
  if (target.parameters.length != argumentCount) {
    throw "native C emission received mismatched thread.main arguments";
  }

  output.append("typedef struct ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context {\n");
  try appendThreadMainStructuredContextFields(
    inout output,
    program,
    expression,
    resultType,
    nativeResultType,
    true
  );
  output.append("  size_t arm_0;\n");
  output.append("  ");
  output.append(nativeSubjectType);
  output.append(" match_subject;\n");
  const subjectNeedsCleanup = loweredTypeNeedsDeinit(
    program,
    plan.subjectType
  );
  const computedSubject = labelsContain(
    matchStatement.labels,
    "computed-subject"
  );
  if (subjectNeedsCleanup) output.append("  bool match_subject_live;\n");
  try appendMainFrameRootFields(
    inout output,
    program,
    target,
    plan.prefixRoots
  );
  for (const arm of plan.arms) {
    for (const segment of arm.segments) {
      try appendMainFrameRootFields(
        inout output,
        program,
        target,
        segment.roots
      );
    }
  }
  output.append("} ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context;\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_choose(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    true
  );
  try appendThreadMainStructuredParameterLiveFlags(
    inout output,
    target,
    argumentCount,
    true
  );
  for (const root of plan.prefixRoots) {
    try appendStatement(inout output, target, root, 1);
  }
  output.append("  context->match_subject = ");
  try appendExpression(inout output, target, plan.subject);
  output.append(";\n");
  if (subjectNeedsCleanup) {
    if (
      !matchStatement.matchConsumesSubject
      || (!computedSubject && matchStatement.liveFlag.byteLength == 0)
    ) {
      throw "native main frame lost its consuming match subject live flag";
    }
    if (!computedSubject) {
      output.append("  ");
      appendCBindingName(inout output, matchStatement.liveFlag);
      output.append(" = false;\n");
    }
    output.append("  context->match_subject_live = false;\n");
  }
  output.append("  switch (context->match_subject");
  const taggedSubject = labelsContain(matchStatement.labels, "tagged");
  if (taggedSubject) output.append(".tag");
  output.append(") {\n");
  let armIndex: usize = 0;
  while (armIndex < plan.arms.length) {
    const arm = view target.statements[plan.arms[armIndex].arm];
    output.append("    case Z_");
    output.append(matchStatement.name);
    if (taggedSubject) output.append("Tag");
    output.append("_");
    output.append(arm.name);
    output.append(`: context->arm_0 = ${armIndex};`);
    if (subjectNeedsCleanup && arm.matchBindingNeedsCleanup) {
      output.append(" context->match_subject_live = true;");
    }
    output.append(" break;\n");
    armIndex = armIndex + 1;
  }
  output.append("    default: abort();\n  }\n");
  try appendMainFrameRootSaves(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredParameterLiveFlagSaves(
    inout output,
    target,
    argumentCount
  );
  output.append("}\n\n");

  armIndex = 0;
  while (armIndex < plan.arms.length) {
    const branchName = `arm_${armIndex}`;
    const matchArm = Option<usize>.some(plan.arms[armIndex].arm);
    try appendThreadMainBranchSegmentHelpers(
      inout output,
      program,
      declaration,
      expressionIndex,
      target,
      plan.prefixRoots,
      plan.arms[armIndex].segments,
      branchName,
      matchArm
    );
    armIndex = armIndex + 1;
  }

  output.append("static ");
  output.append(nativeResultType);
  output.append(" ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_Context *context) {\n");
  try appendThreadMainStructuredParameterLocals(
    inout output,
    target,
    argumentCount,
    false
  );
  try appendMainFrameRootRestores(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredParameterLiveFlags(
    inout output,
    target,
    argumentCount,
    true
  );
  output.append("  switch (context->arm_0) {\n");
  armIndex = 0;
  while (armIndex < plan.arms.length) {
    const armPlan = view plan.arms[armIndex];
    output.append(`    case ${armIndex}: {\n`);
    try appendMainFrameMatchBinding(
      inout output,
      program,
      target,
      armPlan.arm,
      3
    );
    for (const segment of armPlan.segments) {
      try appendMainFrameRootRestores(
        inout output,
        program,
        target,
        segment.roots,
        3
      );
    }
    for (const root of armPlan.roots) {
      try appendStatement(inout output, target, root, 3);
    }
    appendCleanups(
      inout output,
      target.statements[armPlan.block].cleanups,
      3
    );
    output.append("      break;\n    }\n");
    armIndex = armIndex + 1;
  }
  output.append("    default: abort();\n  }\n");
  try appendFunctionTail(inout output, target);
  output.append("}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  ");
  if (resultType.kind != LoweredTypeKind.voidType) output.append("context->result = ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_continue(context);\n}\n\n");

  output.append("static void ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_cancel_suspended(void *raw_context) {\n");
  appendThreadMainStructuredContextPointer(
    inout output,
    declaration,
    expressionIndex
  );
  output.append("  (void)context;\n");
  let cleanupArm = plan.arms.length;
  while (cleanupArm > 0) {
    cleanupArm = cleanupArm - 1;
    let cleanup = plan.arms[cleanupArm].segments.length;
    while (cleanup > 0) {
      cleanup = cleanup - 1;
      try appendMainFrameRootCleanups(
        inout output,
        program,
        target,
        plan.arms[cleanupArm].segments[cleanup].roots,
        1
      );
    }
  }
  if (subjectNeedsCleanup) {
    output.append("  if (context->match_subject_live) { Z_");
    output.append(plan.subjectType.name);
    output.append("_deinit(&context->match_subject); context->match_subject_live = false; }\n");
  }
  try appendMainFrameRootCleanups(
    inout output,
    program,
    target,
    plan.prefixRoots,
    1
  );
  try appendThreadMainStructuredArgumentCleanups(
    inout output,
    program,
    expression,
    true
  );
  output.append("}\n\n");

  try appendThreadMainStructuredWrapperPrefix(
    inout output,
    program,
    declaration,
    expressionIndex,
    expression,
    nativeResultType,
    true
  );
  output.append("  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_choose, context);\n  switch (context->arm_0) {\n");
  armIndex = 0;
  while (armIndex < plan.arms.length) {
    output.append(`    case ${armIndex}: {\n`);
    let segmentIndex: usize = 0;
    while (segmentIndex < plan.arms[armIndex].segments.length) {
      if (plan.arms[armIndex].segments[segmentIndex].roots.length > 0) {
        output.append("      Z_");
        output.append(expression.value);
        output.append("_run_on_main(storage, ");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append(`_arm_${armIndex}_segment_${segmentIndex}, context);\n`);
      }
      output.append("      if (!Z_");
      output.append(expression.value);
      output.append("_suspend_for(storage, ");
      output.append(plan.arms[armIndex].segments[segmentIndex].milliseconds);
      output.append(")) {\n");
      appendThreadMainStructuredCancellation(
        inout output,
        declaration,
        expressionIndex,
        expression.value,
        nativeResultType
      );
      output.append("      }\n");
      segmentIndex = segmentIndex + 1;
    }
    output.append("      break;\n    }\n");
    armIndex = armIndex + 1;
  }
  output.append("    default: abort();\n  }\n  Z_");
  output.append(expression.value);
  output.append("_run_on_main(storage, ");
  appendThreadMainCallHelperName(inout output, declaration, expressionIndex);
  output.append("_run, context);\n");
  appendThreadMainStructuredWrapperResult(
    inout output,
    resultType,
    nativeResultType
  );
}

function appendThreadMainCallHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.functions) {
    let expressionIndex: usize = 0;
    while (expressionIndex < declaration.expressions.length) {
      const expression = view declaration.expressions[expressionIndex];
      if (expression.kind != LoweredExpressionKind.threadMainCall) {
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (
        expression.value.byteLength == 0
        || expression.labels.length == 0
        || expression.children.length != expression.labels.length
      ) throw "native C emission received malformed thread.main call evidence";
      const resultType = try loweredTypeForIdentity(
        program,
        expression.labels[0]
      );
      const nativeResultType = try cType(resultType);
      const argumentCount = expression.labels.length - 1;
      const targetFunctionIndex = try threadMainCallTargetFunctionIndex(
        program,
        declaration,
        expression
      );
      if (
        program.functions[targetFunctionIndex].mainDelayLoops.length > 0
      ) {
        try appendThreadMainLoopCallHelper(
          inout output,
          program,
          declaration,
          expressionIndex,
          expression,
          targetFunctionIndex
        );
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (
        program.functions[targetFunctionIndex].mainDelayMatches.length > 0
      ) {
        try appendThreadMainMatchCallHelper(
          inout output,
          program,
          declaration,
          expressionIndex,
          expression,
          targetFunctionIndex
        );
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (
        program.functions[targetFunctionIndex].mainDelayIfs.length > 0
      ) {
        try appendThreadMainIfCallHelper(
          inout output,
          program,
          declaration,
          expressionIndex,
          expression,
          targetFunctionIndex
        );
        expressionIndex = expressionIndex + 1;
        continue;
      }
      const suspending = program.functions[targetFunctionIndex]
        .mainDelaySegments.length > 0;
      if (
        suspending
        && !threadMainCallIsTail(declaration, expressionIndex)
      ) {
        throw "native suspending thread.main calls must be the worker closure's tail return in the first tier";
      }
      if (
        program.functions[targetFunctionIndex].parameters.length
          != argumentCount
      ) throw "native C emission received mismatched thread.main arguments";
      output.append("typedef struct ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_Context {\n");
      let argument: usize = 0;
      if (resultType.kind != LoweredTypeKind.voidType) {
        output.append("  ");
        output.append(nativeResultType);
        output.append(" result;\n");
      }
      while (argument < argumentCount) {
        const argumentType = try loweredTypeForIdentity(
          program,
          expression.labels[argument + 1]
        );
        const nativeArgumentType = try cType(argumentType);
        output.append("  ");
        output.append(nativeArgumentType);
        output.append(` argument_${argument};\n`);
        argument = argument + 1;
      }
      if (suspending) {
        for (
          const segment of program.functions[targetFunctionIndex]
            .mainDelaySegments
        ) {
          for (const root of segment.roots) {
            if (
              program.functions[targetFunctionIndex].statements[root].kind
                != LoweredStatementKind.localStatement
            ) continue;
            const localType = match (
              in program.functions[targetFunctionIndex].statements[root].type
            ) {
              some(type) => LoweredType({
                kind: type.kind,
                name: type.name.copyBytes(0, type.name.byteLength),
              });
              none => throw "native main frame received an untyped local";
            };
            const nativeLocalType = try cType(localType);
            output.append("  ");
            output.append(nativeLocalType);
            output.append(" ");
            appendMainFrameLocalFieldName(inout output, root);
            output.append(";\n");
            if (loweredTypeNeedsDeinit(program, localType)) {
              output.append("  bool ");
              appendMainFrameLocalLiveFieldName(inout output, root);
              output.append(";\n");
            }
          }
        }
      }
      if (
        resultType.kind == LoweredTypeKind.voidType
        && argumentCount == 0
      ) output.append("  char unused;\n");
      output.append("} ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_Context;\n\n");
      let segmentIndex: usize = 0;
      while (
        segmentIndex
          < program.functions[targetFunctionIndex].mainDelaySegments.length
      ) {
        if (
          program.functions[targetFunctionIndex]
            .mainDelaySegments[segmentIndex].roots.length > 0
        ) {
          output.append("static void ");
          appendThreadMainCallHelperName(
            inout output,
            declaration,
            expressionIndex
          );
          output.append(`_segment_${segmentIndex}(void *raw_context) {\n  `);
          appendThreadMainCallHelperName(
            inout output,
            declaration,
            expressionIndex
          );
          output.append("_Context *context = (");
          appendThreadMainCallHelperName(
            inout output,
            declaration,
            expressionIndex
          );
          output.append("_Context *)raw_context;\n");
          argument = 0;
          while (argument < argumentCount) {
            const targetParameter = view program.functions[
              targetFunctionIndex
            ].parameters[argument];
            const nativeArgumentType = try cType(targetParameter.type);
            output.append("  const ");
            output.append(nativeArgumentType);
            output.append(" ");
            appendCBindingName(inout output, targetParameter.name);
            output.append(` = context->argument_${argument};\n  (void)`);
            appendCBindingName(inout output, targetParameter.name);
            output.append(";\n");
            argument = argument + 1;
          }
          try appendMainFrameRestores(
            inout output,
            program,
            program.functions[targetFunctionIndex],
            segmentIndex,
            1
          );
          for (
            const root of program.functions[targetFunctionIndex]
              .mainDelaySegments[segmentIndex].roots
          ) {
            try appendStatement(
              inout output,
              program.functions[targetFunctionIndex],
              root,
              1
            );
          }
          try appendMainFrameSaves(
            inout output,
            program,
            program.functions[targetFunctionIndex],
            segmentIndex + 1,
            1
          );
          output.append("}\n\n");
        }
        segmentIndex = segmentIndex + 1;
      }
      if (suspending) {
        output.append("static ");
        output.append(nativeResultType);
        output.append(" ");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_continue(");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *context) {\n");
        argument = 0;
        while (argument < argumentCount) {
          const targetParameter = view program.functions[
            targetFunctionIndex
          ].parameters[argument];
          const nativeParameterType = try cType(targetParameter.type);
          output.append("  ");
          output.append(nativeParameterType);
          output.append(" ");
          appendCBindingName(inout output, targetParameter.name);
          output.append(` = context->argument_${argument};\n  (void)`);
          appendCBindingName(inout output, targetParameter.name);
          output.append(";\n");
          argument = argument + 1;
        }
        const targetSegmentCount = program.functions[targetFunctionIndex]
          .mainDelaySegments.length;
        try appendMainFrameRestores(
          inout output,
          program,
          program.functions[targetFunctionIndex],
          targetSegmentCount,
          1
        );
        for (const flag of program.functions[targetFunctionIndex].liveFlags) {
          if (!flag.parameter) continue;
          output.append("  bool ");
          appendCBindingName(inout output, flag.name);
          output.append(" = true;\n");
        }
        try appendFunctionTail(
          inout output,
          program.functions[targetFunctionIndex]
        );
        output.append("}\n\n");
      }
      output.append("static void ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_run(void *raw_context) {\n  ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_Context *context = (");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_Context *)raw_context;\n");
      if (suspending) {
        output.append("  ");
        if (resultType.kind != LoweredTypeKind.voidType) {
          output.append("context->result = ");
        }
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_continue(context);\n");
      } else {
        argument = 0;
        while (argument < argumentCount) {
          const argumentType = try loweredTypeForIdentity(
            program,
            expression.labels[argument + 1]
          );
          const nativeArgumentType = try cType(argumentType);
          output.append("  const ");
          output.append(nativeArgumentType);
          output.append(` *_z_stage1_main_argument_${argument} = &context->argument_${argument};\n`);
          argument = argument + 1;
        }
        output.append("  ");
        if (resultType.kind != LoweredTypeKind.voidType) {
          output.append("context->result = ");
        }
        const runnerCall = expression.children[0];
        try appendExpression(inout output, declaration, runnerCall);
        output.append(";\n");
      }
      output.append("}\n\n");
      if (suspending) {
        output.append("static void ");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_cancel_suspended(void *raw_context) {\n  ");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *context = (");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *)raw_context;\n  (void)context;\n");
        try appendMainFrameLocalCleanups(
          inout output,
          program,
          program.functions[targetFunctionIndex],
          1
        );
        let cleanup = argumentCount;
        while (cleanup > 0) {
          cleanup = cleanup - 1;
          const argumentType = try loweredTypeForIdentity(
            program,
            expression.labels[cleanup + 1]
          );
          if (loweredTypeNeedsDeinit(program, argumentType)) {
            output.append("  Z_");
            output.append(argumentType.name);
            if (argumentType.kind == LoweredTypeKind.classType) {
              output.append(`_release(context->argument_${cleanup});\n`);
            } else {
              output.append(`_deinit(&context->argument_${cleanup});\n`);
            }
          }
        }
        output.append("}\n\n");
      }
      output.append("static ");
      output.append(nativeResultType);
      output.append(" ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("(Z_");
      output.append(expression.value);
      output.append("Storage *storage");
      argument = 0;
      while (argument < argumentCount) {
        const argumentType = try loweredTypeForIdentity(
          program,
          expression.labels[argument + 1]
        );
        const nativeArgumentType = try cType(argumentType);
        output.append(", ");
        output.append(nativeArgumentType);
        output.append(` argument_${argument}`);
        argument = argument + 1;
      }
      output.append(") {\n  ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      if (suspending) {
        output.append("_Context *context = (");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *)calloc(1, sizeof(");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context));\n  if (context == NULL) abort();\n");
        argument = 0;
        while (argument < argumentCount) {
          output.append(`  context->argument_${argument} = argument_${argument};\n`);
          argument = argument + 1;
        }
      } else {
        output.append("_Context context = { ");
        if (
          resultType.kind == LoweredTypeKind.voidType
          && argumentCount == 0
        ) output.append(".unused = 0");
        argument = 0;
        while (argument < argumentCount) {
          if (argument > 0) output.append(", ");
          output.append(`.argument_${argument} = argument_${argument}`);
          argument = argument + 1;
        }
        output.append(" };\n");
      }
      segmentIndex = 0;
      while (
        segmentIndex
          < program.functions[targetFunctionIndex].mainDelaySegments.length
      ) {
        if (
          program.functions[targetFunctionIndex]
            .mainDelaySegments[segmentIndex].roots.length > 0
        ) {
          output.append("  Z_");
          output.append(expression.value);
          output.append("_run_on_main(storage, ");
          appendThreadMainCallHelperName(
            inout output,
            declaration,
            expressionIndex
          );
          output.append(`_segment_${segmentIndex}, context);\n`);
        }
        output.append("  if (!Z_");
        output.append(expression.value);
        output.append("_suspend_for(storage, ");
        output.append(
          program.functions[targetFunctionIndex]
            .mainDelaySegments[segmentIndex].milliseconds
        );
        output.append(")) {\n    Z_");
        output.append(expression.value);
        output.append("_run_on_main(storage, ");
        appendThreadMainCallHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_cancel_suspended, context);\n    free(context);\n");
        if (resultType.kind == LoweredTypeKind.voidType) {
          output.append("    return;\n  }\n");
        } else {
          output.append("    return (");
          output.append(nativeResultType);
          output.append("){0};\n  }\n");
        }
        segmentIndex = segmentIndex + 1;
      }
      output.append("  Z_");
      output.append(expression.value);
      output.append("_run_on_main(storage, ");
      appendThreadMainCallHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      if (suspending) output.append("_run, context);\n");
      else output.append("_run, &context);\n");
      if (suspending) {
        if (resultType.kind != LoweredTypeKind.voidType) {
          output.append("  ");
          output.append(nativeResultType);
          output.append(" result = context->result;\n  free(context);\n  return result;\n");
        } else output.append("  free(context);\n");
      } else if (resultType.kind != LoweredTypeKind.voidType) {
        output.append("  return context.result;\n");
      }
      output.append("}\n\n");
      expressionIndex = expressionIndex + 1;
    }
  }
}

function threadSpawnOwnsCapture(
  in declaration: LoweredFunction,
  in expression: LoweredExpression,
  bodyChildCount: usize,
  captureIndex: usize
): boolean {
  const childIndex = bodyChildCount + captureIndex;
  if (childIndex >= expression.children.length) return false;
  const capture = expression.children[childIndex];
  return declaration.expressions[capture].kind
    == LoweredExpressionKind.moveValue;
}

function appendThreadSpawnHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.functions) {
    let expressionIndex: usize = 0;
    while (expressionIndex < declaration.expressions.length) {
      const expression = view declaration.expressions[expressionIndex];
      if (expression.kind != LoweredExpressionKind.threadSpawn) {
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (expression.labels.length < 5) {
        throw "native C emission received malformed thread.spawn evidence";
      }
      const blockBody = expression.labels[0] == "lowered-block";
      if ((expression.labels.length - 5) % 2 != 0) {
        throw "native C emission received malformed thread.spawn captures";
      }
      const captureCount = (expression.labels.length - 5) / 2;
      let bodyChildCount: usize = 0;
      if (!blockBody) bodyChildCount = 1;
      if (
        (!blockBody && expression.labels[0] != "expression")
        || expression.children.length != bodyChildCount + captureCount
      ) throw "native C emission received an unsupported thread.spawn closure body";
      const taskName = expression.value.copyBytes(
        0,
        expression.value.byteLength
      );
      const resultType = try taskResultType(program, taskName);
      const nativeResultType = try cType(resultType);
      if (captureCount > 0) {
        output.append("typedef struct ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context {\n");
        let captureLabel: usize = 5;
        let captureIndex: usize = 0;
        while (captureLabel + 1 < expression.labels.length) {
          const captureType = try loweredTypeForIdentity(
            program,
            expression.labels[captureLabel + 1]
          );
          const nativeCaptureType = try cType(captureType);
          output.append("  ");
          output.append(nativeCaptureType);
          output.append(" ");
          appendCBindingName(inout output, expression.labels[captureLabel]);
          output.append(";\n");
          if (threadSpawnOwnsCapture(
            declaration,
            expression,
            bodyChildCount,
            captureIndex
          )) output.append(`  bool _z_stage1_capture_live_${captureIndex};\n`);
          captureLabel = captureLabel + 2;
          captureIndex = captureIndex + 1;
        }
        output.append("} ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context;\n\nstatic void ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_destroy_context(");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *worker_context) {\n  if (worker_context == NULL) return;\n");
        let remaining = expression.labels.length;
        while (remaining > 5) {
          remaining = remaining - 2;
          const remainingCapture = (remaining - 5) / 2;
          const captureType = try loweredTypeForIdentity(
            program,
            expression.labels[remaining + 1]
          );
          if (loweredTypeNeedsDeinit(program, captureType)) {
            output.append("  ");
            if (threadSpawnOwnsCapture(
              declaration,
              expression,
              bodyChildCount,
              remainingCapture
            )) output.append(
              `if (worker_context->_z_stage1_capture_live_${remainingCapture}) `
            );
            output.append("Z_");
            output.append(captureType.name);
            if (captureType.kind == LoweredTypeKind.classType) {
              output.append("_release(worker_context->");
            } else {
              output.append("_deinit(&worker_context->");
            }
            appendCBindingName(
              inout output,
              expression.labels[remaining]
            );
            output.append(");\n");
          }
        }
        output.append("  free(worker_context);\n}\n\n");
      }
      output.append("static ");
      output.append(nativeResultType);
      output.append(" ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_body(");
      output.append("Z_");
      output.append(taskName);
      output.append("Storage *_z_stage1_task_storage");
      let captureLabel: usize = 5;
      while (captureLabel + 1 < expression.labels.length) {
        output.append(", ");
        const captureType = try loweredTypeForIdentity(
          program,
          expression.labels[captureLabel + 1]
        );
        const nativeCaptureType = try cType(captureType);
        if (captureType.kind == LoweredTypeKind.classType) {
          output.append(nativeCaptureType);
          output.append(" const *");
        } else {
          output.append("const ");
          output.append(nativeCaptureType);
          output.append(" *");
        }
        appendCBindingName(inout output, expression.labels[captureLabel]);
        const bodyCaptureIndex = (captureLabel - 5) / 2;
        if (threadSpawnOwnsCapture(
          declaration,
          expression,
          bodyChildCount,
          bodyCaptureIndex
        )) output.append(
          `, bool *_z_stage1_capture_live_${bodyCaptureIndex}`
        );
        captureLabel = captureLabel + 2;
      }
      output.append(") {\n");
      output.append("  (void)_z_stage1_task_storage;\n");
      captureLabel = 5;
      while (captureLabel + 1 < expression.labels.length) {
        const bodyCaptureIndex = (captureLabel - 5) / 2;
        if (threadSpawnOwnsCapture(
          declaration,
          expression,
          bodyChildCount,
          bodyCaptureIndex
        )) output.append(
          `  (void)_z_stage1_capture_live_${bodyCaptureIndex};\n`
        );
        captureLabel = captureLabel + 2;
      }
      if (blockBody) {
        for (const root of expression.statements) {
          try appendStatement(inout output, declaration, root, 1);
        }
        output.append("  abort();\n");
      } else {
        output.append("  return ");
        const body = expression.children[0];
        try appendExpression(inout output, declaration, body);
        output.append(";\n");
      }
      output.append("}\n\n");
      output.append("#if defined(_WIN32)\nstatic DWORD WINAPI ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_worker(LPVOID context) {\n#else\nstatic void *");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_worker(void *context) {\n#endif\n  Z_");
      output.append(taskName);
      output.append("Storage *storage = (Z_");
      output.append(taskName);
      output.append("Storage *)context;\n");
      if (captureCount > 0) {
        output.append("  ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *worker_context = (");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *)storage->context;\n");
      }
      output.append("  if (!Z_");
      output.append(taskName);
      output.append("_is_cancellation_requested(storage)) {\n    storage->result = ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_body(storage");
      captureLabel = 5;
      while (captureLabel + 1 < expression.labels.length) {
        output.append(", ");
        output.append("&worker_context->");
        appendCBindingName(inout output, expression.labels[captureLabel]);
        const workerCaptureIndex = (captureLabel - 5) / 2;
        if (threadSpawnOwnsCapture(
          declaration,
          expression,
          bodyChildCount,
          workerCaptureIndex
        )) output.append(
          `, &worker_context->_z_stage1_capture_live_${workerCaptureIndex}`
        );
        captureLabel = captureLabel + 2;
      }
      output.append(");\n");
      output.append("    if (!storage->continuation_cancelled) storage->result_live = true;\n  }\n");
      if (captureCount > 0) {
        output.append("  ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_destroy_context(worker_context);\n  storage->context = NULL;\n");
      }
      output.append("  Z_");
      output.append(taskName);
      output.append("_complete(storage);\n");
      output.append("#if defined(_WIN32)\n  return 0;\n#else\n  return NULL;\n#endif\n}\n\n");
      output.append("static Z_");
      output.append(taskName);
      output.append(" ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("(");
      captureLabel = 5;
      while (captureLabel + 1 < expression.labels.length) {
        if (captureLabel > 5) output.append(", ");
        const captureType = try loweredTypeForIdentity(
          program,
          expression.labels[captureLabel + 1]
        );
        const nativeCaptureType = try cType(captureType);
        output.append(nativeCaptureType);
        output.append(" ");
        appendCBindingName(inout output, expression.labels[captureLabel]);
        captureLabel = captureLabel + 2;
      }
      if (captureCount == 0) output.append("void");
      output.append(") {\n  Z_");
      output.append(taskName);
      output.append("Storage *storage = (Z_");
      output.append(taskName);
      output.append("Storage *)calloc(1, sizeof(Z_");
      output.append(taskName);
      output.append("Storage));\n  if (storage == NULL) abort();\n");
      output.append("#if defined(_WIN32)\n  InitializeSRWLock(&storage->state_mutex);\n  InitializeConditionVariable(&storage->state_condition);\n  storage->owner_thread = GetCurrentThreadId();\n#else\n  if (pthread_mutex_init(&storage->state_mutex, NULL) != 0) { free(storage); abort(); }\n  if (pthread_cond_init(&storage->state_condition, NULL) != 0) { pthread_mutex_destroy(&storage->state_mutex); free(storage); abort(); }\n  storage->owner_thread = pthread_self();\n#endif\n");
      if (captureCount > 0) {
        output.append("  ");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *worker_context = (");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context *)malloc(sizeof(");
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_Context));\n  if (worker_context == NULL) {\n#if !defined(_WIN32)\n    pthread_cond_destroy(&storage->state_condition);\n    pthread_mutex_destroy(&storage->state_mutex);\n#endif\n    free(storage);\n    abort();\n  }\n");
        captureLabel = 5;
        while (captureLabel + 1 < expression.labels.length) {
          const captureType = try loweredTypeForIdentity(
            program,
            expression.labels[captureLabel + 1]
          );
          output.append("  worker_context->");
          appendCBindingName(inout output, expression.labels[captureLabel]);
          output.append(" = ");
          appendCBindingName(inout output, expression.labels[captureLabel]);
          output.append(";\n");
          const initializedCapture = (captureLabel - 5) / 2;
          if (threadSpawnOwnsCapture(
            declaration,
            expression,
            bodyChildCount,
            initializedCapture
          )) output.append(
            `  worker_context->_z_stage1_capture_live_${initializedCapture} = true;\n`
          );
          if (captureType.kind == LoweredTypeKind.classType) {
            output.append("  Z_");
            output.append(captureType.name);
            output.append("_retain(worker_context->");
            appendCBindingName(
              inout output,
              expression.labels[captureLabel]
            );
            output.append(");\n");
          }
          captureLabel = captureLabel + 2;
        }
        output.append("  storage->context = worker_context;\n");
      }
      output.append("#if defined(_WIN32)\n  storage->thread = CreateThread(NULL, 0, ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_worker, storage, 0, NULL);\n  if (storage->thread == NULL) { ");
      if (captureCount > 0) {
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_destroy_context(worker_context); ");
      }
      output.append("free(storage); abort(); }\n#else\n  if (pthread_create(&storage->thread, NULL, ");
      appendThreadSpawnHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("_worker, storage) != 0) { ");
      if (captureCount > 0) {
        appendThreadSpawnHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_destroy_context(worker_context); ");
      }
      output.append("pthread_cond_destroy(&storage->state_condition); pthread_mutex_destroy(&storage->state_mutex); free(storage); abort(); }\n#endif\n  return (Z_");
      output.append(taskName);
      output.append("){ .storage = storage };\n}\n\n");
      expressionIndex = expressionIndex + 1;
    }
  }
}

function appendMutexWithLockHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.functions) {
    let expressionIndex: usize = 0;
    while (expressionIndex < declaration.expressions.length) {
      const expression = view declaration.expressions[expressionIndex];
      if (expression.kind != LoweredExpressionKind.mutexWithLock) {
        expressionIndex = expressionIndex + 1;
        continue;
      }
      if (
        expression.children.length == 0
        || expression.labels.length < 4
        || (expression.labels.length - 4) % 2 != 0
      ) throw "native C emission received malformed Mutex.withLock evidence";
      const resultType = try loweredTypeForIdentity(
        program,
        expression.labels[2]
      );
      const nativeResultType = try cType(resultType);
      const valueType = try mutexValueType(program, expression.value);
      const nativeValueType = try cType(valueType);
      const blockBody = expression.labels[3] == "lowered-block";
      if (blockBody) {
        output.append("static __attribute__((unused)) ");
        output.append(nativeResultType);
        output.append(" ");
        appendMutexWithLockHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_body(");
        if (expression.labels[1] == "in") output.append("const ");
        output.append(nativeValueType);
        output.append(" *");
        appendCBindingName(inout output, expression.labels[0]);
        let captureLabel: usize = 4;
        while (captureLabel + 1 < expression.labels.length) {
          const captureType = try loweredTypeForIdentity(
            program,
            expression.labels[captureLabel + 1]
          );
          const nativeCaptureType = try cType(captureType);
          output.append(", const ");
          output.append(nativeCaptureType);
          output.append(" *");
          appendCBindingName(
            inout output,
            expression.labels[captureLabel]
          );
          captureLabel = captureLabel + 2;
        }
        output.append(") {\n");
        for (const root of expression.statements) {
          try appendStatement(inout output, declaration, root, 1);
        }
        if (resultType.kind != LoweredTypeKind.voidType) {
          output.append("  abort();\n");
        }
        output.append("}\n\n");
      }
      output.append("static __attribute__((unused)) ");
      output.append(nativeResultType);
      output.append(" ");
      appendMutexWithLockHelperName(
        inout output,
        declaration,
        expressionIndex
      );
      output.append("(Z_");
      output.append(expression.value);
      output.append(" mutex");
      let captureLabel: usize = 4;
      while (captureLabel + 1 < expression.labels.length) {
        const captureType = try loweredTypeForIdentity(
          program,
          expression.labels[captureLabel + 1]
        );
        const nativeCaptureType = try cType(captureType);
        output.append(", const ");
        output.append(nativeCaptureType);
        output.append(" *");
        appendCBindingName(
          inout output,
          expression.labels[captureLabel]
        );
        captureLabel = captureLabel + 2;
      }
      output.append(") {\n");
      output.append("  if (mutex.storage == NULL) abort();\n");
      output.append("#if defined(_WIN32)\n  AcquireSRWLockExclusive(&mutex.storage->native);\n#else\n");
      output.append("  if (pthread_mutex_lock(&mutex.storage->native) != 0) abort();\n#endif\n");
      if (!blockBody) {
        output.append("  ");
        if (expression.labels[1] == "in") output.append("const ");
        output.append(nativeValueType);
        output.append(" *");
        appendCBindingName(inout output, expression.labels[0]);
        output.append(" = &mutex.storage->value;\n");
      }
      if (resultType.kind != LoweredTypeKind.voidType) {
        output.append("  ");
        output.append(nativeResultType);
        output.append(" result = ");
      } else output.append("  ");
      if (blockBody) {
        appendMutexWithLockHelperName(
          inout output,
          declaration,
          expressionIndex
        );
        output.append("_body(&mutex.storage->value");
        captureLabel = 4;
        while (captureLabel + 1 < expression.labels.length) {
          output.append(", ");
          appendCBindingName(
            inout output,
            expression.labels[captureLabel]
          );
          captureLabel = captureLabel + 2;
        }
        output.append(")");
      } else {
        try appendExpression(
          inout output,
          declaration,
          expression.children[1]
        );
      }
      output.append(";\n");
      output.append("#if defined(_WIN32)\n  ReleaseSRWLockExclusive(&mutex.storage->native);\n#else\n");
      output.append("  if (pthread_mutex_unlock(&mutex.storage->native) != 0) abort();\n#endif\n");
      if (resultType.kind != LoweredTypeKind.voidType) {
        output.append("  return result;\n");
      }
      output.append("}\n\n");
      expressionIndex = expressionIndex + 1;
    }
  }
}

function appendTestRunner(
  inout output: TextBuffer,
  in program: LoweredProgram,
  processArguments: boolean
): void throws String {
  const count = programTestCount(program);
  if (count == 0) return;
  output.append("int main(int argc, char **argv) {\n");
  if (processArguments) {
    output.append("  z_stage1_process_argc = argc;\n");
    output.append("  z_stage1_process_argv = argv;\n");
  } else {
    output.append("  (void)argc;\n");
    output.append("  (void)argv;\n");
  }
  output.append("  printf(\"running ");
  output.append(`${count}`);
  if (count == 1) output.append(" test\\n\");\n");
  else output.append(" tests\\n\");\n");
  output.append("  size_t passed = 0;\n");
  output.append("  size_t failed = 0;\n");
  let testIndex: usize = 0;
  for (const declaration of program.functions) {
    if (declaration.testName.byteLength == 0) continue;
    output.append("  printf(\"test %s ... \", ");
    appendCStringLiteral(inout output, declaration.testName);
    output.append(");\n");
    output.append("  fflush(stdout);\n");
    output.append("  Z_");
    output.append(declaration.returnType.name);
    output.append(` _z_test_result_${testIndex} = `);
    appendCBindingName(inout output, declaration.name);
    output.append("();\n");
    output.append(`  if (_z_test_result_${testIndex}.tag == Z_`);
    output.append(declaration.returnType.name);
    output.append("Tag_failure) {\n");
    output.append("    puts(\"FAILED\");\n");
    output.append(`    if (_z_test_result_${testIndex}.payload.failure.length > 0) fwrite(_z_test_result_${testIndex}.payload.failure.data, 1, _z_test_result_${testIndex}.payload.failure.length, stdout);\n`);
    output.append("    fputc('\\n', stdout);\n");
    output.append("    fflush(stdout);\n");
    output.append(`    Z_String_deinit(&_z_test_result_${testIndex}.payload.failure);\n`);
    output.append("    failed += 1;\n");
    output.append("  } else {\n");
    output.append("    puts(\"ok\");\n");
    output.append("    passed += 1;\n");
    output.append("  }\n");
    testIndex = testIndex + 1;
  }
  output.append("  printf(\"test result: %s. %zu passed; %zu failed\\n\", failed == 0 ? \"ok\" : \"FAILED\", passed, failed);\n");
  output.append("  return failed == 0 ? 0 : 1;\n");
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

function embeddedRuntimeSymbolPart(in targetName: String): String {
  let output = TextBuffer();
  let index: usize = 0;
  while (index < targetName.byteLength) {
    const byte = targetName.byteAt(index);
    if (byte == 45) output.appendAscii(95);
    else output.appendAscii(byte);
    index = index + 1;
  }
  return output.finish();
}

function embeddedRuntimeConstantPart(in targetName: String): String {
  let output = TextBuffer();
  let index: usize = 0;
  while (index < targetName.byteLength) {
    const byte = targetName.byteAt(index);
    if (byte == 45) output.appendAscii(95);
    else if (byte >= 97 && byte <= 122) output.appendAscii(byte - 32);
    else output.appendAscii(byte);
    index = index + 1;
  }
  return output.finish();
}

function appendForeignRuntimeEntrySupport(inout output: TextBuffer): void {
  output.append(`#if defined(__cplusplus)
#define Z_THREAD_LOCAL thread_local
#else
#define Z_THREAD_LOCAL _Thread_local
#endif
typedef void (*Z_ExecutorBoundReleaseEnqueue)(
  void *context,
  void *value,
  void (*finalize)(void *value)
);
typedef struct Z_ForeignThreadEntry {
  void *previous_context;
  Z_ExecutorBoundReleaseEnqueue previous_enqueue;
} Z_ForeignThreadEntry;
static Z_THREAD_LOCAL void *z_executor_bound_release_context = NULL;
static Z_THREAD_LOCAL Z_ExecutorBoundReleaseEnqueue z_executor_bound_release_enqueue = NULL;

static __attribute__((unused)) Z_ForeignThreadEntry z_foreign_thread_enter(
  void *context,
  Z_ExecutorBoundReleaseEnqueue enqueue
) {
  Z_ForeignThreadEntry entry = {
    .previous_context = z_executor_bound_release_context,
    .previous_enqueue = z_executor_bound_release_enqueue,
  };
  if (enqueue != NULL) {
    z_executor_bound_release_context = context;
    z_executor_bound_release_enqueue = enqueue;
  }
  return entry;
}

static __attribute__((unused)) void z_foreign_thread_leave(
  Z_ForeignThreadEntry entry
) {
  z_executor_bound_release_context = entry.previous_context;
  z_executor_bound_release_enqueue = entry.previous_enqueue;
}

`);
}

function appendEmbeddedRuntimeTypes(
  inout output: TextBuffer,
  in targetName: String,
  requiresReleaseEnqueue: boolean,
  requiresMainThread: boolean
): void {
  const prefix = embeddedRuntimeSymbolPart(targetName);
  const constant = embeddedRuntimeConstantPart(targetName);
  output.append("/* Initialize before any exported call; join native work before shutdown.\n");
  output.append(" * Calling an ordinary export before successful initialization, while shutdown\n");
  output.append(" * is draining, or after shutdown is a contract violation and terminates. */\n#define ");
  output.append(constant);
  if (requiresReleaseEnqueue) output.append("_RUNTIME_REQUIRES_ENQUEUE_RELEASE 1\n");
  else output.append("_RUNTIME_REQUIRES_ENQUEUE_RELEASE 0\n");
  output.append("#define ");
  output.append(constant);
  if (requiresMainThread) output.append("_RUNTIME_REQUIRES_MAIN_THREAD 1\n\n");
  else output.append("_RUNTIME_REQUIRES_MAIN_THREAD 0\n\n");
  output.append("typedef enum ");
  output.append(prefix);
  output.append("_runtime_status {\n  ");
  output.append(constant);
  output.append("_RUNTIME_OK = 0,\n  ");
  output.append(constant);
  output.append("_RUNTIME_ALREADY_INITIALIZED = 1,\n  ");
  output.append(constant);
  output.append("_RUNTIME_NOT_INITIALIZED = 2,\n  ");
  output.append(constant);
  output.append("_RUNTIME_BUSY = 3,\n  ");
  output.append(constant);
  output.append("_RUNTIME_INVALID_CONFIG = 4,\n  ");
  output.append(constant);
  output.append("_RUNTIME_SHUT_DOWN = 5,\n  ");
  output.append(constant);
  output.append("_RUNTIME_WRONG_THREAD = 6,\n  ");
  output.append(constant);
  output.append("_RUNTIME_DRAINING = 7\n} ");
  output.append(prefix);
  output.append("_runtime_status;\n\n");
  output.append("typedef void (*");
  output.append(prefix);
  output.append("_runtime_enqueue_release)(\n  void *context,\n  void *value,\n  void (*finalize)(void *value)\n);\n\n");
  output.append("typedef bool (*");
  output.append(prefix);
  output.append("_runtime_is_main_thread)(void *context);\n\n");
  output.append("typedef struct ");
  output.append(prefix);
  output.append("_runtime_config {\n  void *context;\n  ");
  output.append(prefix);
  output.append("_runtime_enqueue_release enqueue_release;\n  ");
  output.append(prefix);
  output.append("_runtime_is_main_thread is_main_thread;\n} ");
  output.append(prefix);
  output.append("_runtime_config;\n\n");
}

function appendEmbeddedRuntimeSignatures(
  inout output: TextBuffer,
  in targetName: String
): void {
  const prefix = embeddedRuntimeSymbolPart(targetName);
  output.append("Z_API ");
  output.append(prefix);
  output.append("_runtime_status ");
  output.append(prefix);
  output.append("_runtime_initialize(const ");
  output.append(prefix);
  output.append("_runtime_config *config);\n");
  output.append("Z_API ");
  output.append(prefix);
  output.append("_runtime_status ");
  output.append(prefix);
  output.append("_runtime_shutdown(void);\n");
}

function appendEmbeddedRuntimeDefinitions(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in targetName: String,
  in initializerName: String,
  initializerRequiresMain: boolean
): void throws String {
  const prefix = embeddedRuntimeSymbolPart(targetName);
  const constant = embeddedRuntimeConstantPart(targetName);
  const requiresBoundReleaseEnqueue = initializerRequiresMain
    || programUsesExecutorBoundClasses(program);
  const requiresMainThread = initializerRequiresMain
    || programUsesExecutorBoundClasses(program);
  let initializerIndex = program.functions.length;
  if (initializerName.byteLength > 0) {
    let index: usize = 0;
    while (index < program.functions.length) {
      if (program.functions[index].name == initializerName) {
        initializerIndex = index;
        break;
      }
      index = index + 1;
    }
    if (initializerIndex == program.functions.length) {
      throw `runtime initializer "${initializerName}" was not lowered from the target entry module`;
    }
    if (!loweredTypeNeedsDeinit(
      program,
      program.functions[initializerIndex].returnType
    )) {
      throw `runtime initializer "${initializerName}" must return one cleanup-bearing owner`;
    }
  }
  const hasRoot = initializerIndex < program.functions.length;
  let rootField = "";
  let rootInitializer = "";
  let rootHelpers = "";
  let initializeRoot = "";
  let shutdownRoot = "";
  let initializerValidation = "";
  if (hasRoot) {
    const initializer = view program.functions[initializerIndex];
    const rootType = try cType(initializer.returnType);
    rootField = `  ${rootType} *root;\n`;
    rootInitializer = "  .root = NULL,\n";
    let cleanup = "";
    if (initializer.returnType.kind == LoweredTypeKind.classType) {
      cleanup = `Z_${initializer.returnType.name}_release(*z_embedded_runtime_${prefix}.root);`;
    } else {
      cleanup = `Z_${initializer.returnType.name}_deinit(z_embedded_runtime_${prefix}.root);`;
    }
    let rootThreadProof = "";
    if (initializerRequiresMain) {
      rootThreadProof = `  if (z_embedded_runtime_${prefix}.is_main_thread == NULL
      || !z_embedded_runtime_${prefix}.is_main_thread(z_embedded_runtime_${prefix}.context)) abort();
`;
    }
    rootHelpers = `static void z_embedded_runtime_${prefix}_destroy_root(void) {
  if (z_embedded_runtime_${prefix}.root == NULL) return;
  ${cleanup}
  free(z_embedded_runtime_${prefix}.root);
  z_embedded_runtime_${prefix}.root = NULL;
}

static __attribute__((unused)) void z_embedded_runtime_${prefix}_complete_root_release(void *opaque) {
  (void)opaque;
${rootThreadProof}  z_embedded_runtime_${prefix}_destroy_root();
  z_embedded_runtime_${prefix}_release(&z_embedded_runtime_${prefix});
}

`;
    initializeRoot = `  z_embedded_runtime_${prefix}.root = (${rootType} *)malloc(sizeof(${rootType}));
  if (z_embedded_runtime_${prefix}.root == NULL) abort();
  *z_embedded_runtime_${prefix}.root = ${initializer.name}();
`;
    if (initializerRequiresMain) {
      shutdownRoot = `  if (z_embedded_runtime_${prefix}.root != NULL) {
    __atomic_add_fetch(&z_embedded_runtime_${prefix}.active_callbacks, 1, __ATOMIC_ACQ_REL);
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, 4, __ATOMIC_RELEASE);
    z_embedded_runtime_${prefix}.enqueue_release(
      z_embedded_runtime_${prefix}.context,
      &z_embedded_runtime_${prefix},
      z_embedded_runtime_${prefix}_complete_root_release
    );
    if (__atomic_load_n(&z_embedded_runtime_${prefix}.active_callbacks, __ATOMIC_ACQUIRE) != 0) {
      return ${constant}_RUNTIME_DRAINING;
    }
    uint8_t draining = 4;
    if (!__atomic_compare_exchange_n(
      &z_embedded_runtime_${prefix}.state,
      &draining,
      3,
      false,
      __ATOMIC_ACQ_REL,
      __ATOMIC_ACQUIRE
    )) return ${constant}_RUNTIME_DRAINING;
  }
`;
    } else {
      shutdownRoot = `  z_embedded_runtime_${prefix}_destroy_root();\n`;
    }
  }
  if (requiresBoundReleaseEnqueue) {
    initializerValidation = `  if (config == NULL || config->enqueue_release == NULL) {
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, 0, __ATOMIC_RELEASE);
    return ${constant}_RUNTIME_INVALID_CONFIG;
  }
`;
  }
  if (requiresMainThread) {
    initializerValidation = `${initializerValidation}  if (config == NULL || config->is_main_thread == NULL) {
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, 0, __ATOMIC_RELEASE);
    return ${constant}_RUNTIME_INVALID_CONFIG;
  }
  if (!config->is_main_thread(config->context)) {
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, 0, __ATOMIC_RELEASE);
    return ${constant}_RUNTIME_WRONG_THREAD;
  }
`;
  }
  let drainingState = "1";
  if (hasRoot) drainingState = "4";
  let activeCallbackStatus = `${constant}_RUNTIME_BUSY`;
  if (hasRoot) activeCallbackStatus = `${constant}_RUNTIME_DRAINING`;
  let pendingReleaseThreadProof = "";
  if (requiresMainThread) {
    pendingReleaseThreadProof = `  if (z_embedded_runtime_${prefix}.is_main_thread == NULL
      || !z_embedded_runtime_${prefix}.is_main_thread(z_embedded_runtime_${prefix}.context)) abort();
`;
  }
  appendEmbeddedRuntimeTypes(
    inout output,
    targetName,
    requiresBoundReleaseEnqueue,
    requiresMainThread
  );
  output.append(`typedef struct z_embedded_runtime_${prefix}_storage {
  void *context;
  ${prefix}_runtime_enqueue_release enqueue_release;
  ${prefix}_runtime_is_main_thread is_main_thread;
${rootField}  uintptr_t active_entries;
  uintptr_t active_callbacks;
  uint8_t state;
} z_embedded_runtime_${prefix}_storage;

static z_embedded_runtime_${prefix}_storage z_embedded_runtime_${prefix} = {
  .context = NULL,
  .enqueue_release = NULL,
  .is_main_thread = NULL,
${rootInitializer}  .active_entries = 0,
  .active_callbacks = 0,
  .state = 0,
};

static __attribute__((unused)) void z_embedded_runtime_${prefix}_retain(void *context) {
  (void)context;
  for (;;) {
    uint8_t state = __atomic_load_n(&z_embedded_runtime_${prefix}.state, __ATOMIC_ACQUIRE);
    if (state == 3) continue;
    if (state != 1 && state != 5) abort();
    __atomic_add_fetch(&z_embedded_runtime_${prefix}.active_callbacks, 1, __ATOMIC_ACQ_REL);
    state = __atomic_load_n(&z_embedded_runtime_${prefix}.state, __ATOMIC_ACQUIRE);
    if (state == 1 || state == 5) return;
    __atomic_sub_fetch(&z_embedded_runtime_${prefix}.active_callbacks, 1, __ATOMIC_ACQ_REL);
  }
}

static __attribute__((unused)) void z_embedded_runtime_${prefix}_release(void *context) {
  (void)context;
  if (__atomic_fetch_sub(&z_embedded_runtime_${prefix}.active_callbacks, 1, __ATOMIC_ACQ_REL) == 0) abort();
}

typedef struct z_embedded_runtime_${prefix}_pending_release {
  void *value;
  void (*finalize)(void *value);
} z_embedded_runtime_${prefix}_pending_release;

static void z_embedded_runtime_${prefix}_complete_release(void *opaque) {
  z_embedded_runtime_${prefix}_pending_release *pending = (z_embedded_runtime_${prefix}_pending_release *)opaque;
${pendingReleaseThreadProof}  pending->finalize(pending->value);
  free(pending);
  z_embedded_runtime_${prefix}_release(&z_embedded_runtime_${prefix});
}

static void z_embedded_runtime_${prefix}_enqueue_release(
  void *context,
  void *value,
  void (*finalize)(void *value)
) {
  (void)context;
  if (z_embedded_runtime_${prefix}.enqueue_release == NULL) abort();
  z_embedded_runtime_${prefix}_pending_release *pending =
    (z_embedded_runtime_${prefix}_pending_release *)malloc(
      sizeof(z_embedded_runtime_${prefix}_pending_release)
    );
  if (pending == NULL) abort();
  pending->value = value;
  pending->finalize = finalize;
  z_embedded_runtime_${prefix}_retain(&z_embedded_runtime_${prefix});
  z_embedded_runtime_${prefix}.enqueue_release(
    z_embedded_runtime_${prefix}.context,
    pending,
    z_embedded_runtime_${prefix}_complete_release
  );
}

${rootHelpers}

static Z_ForeignThreadEntry z_embedded_runtime_${prefix}_enter(void) {
  for (;;) {
    uint8_t state = __atomic_load_n(&z_embedded_runtime_${prefix}.state, __ATOMIC_ACQUIRE);
    if (state == 3 || state == 5) continue;
    if (state != 1) abort();
    __atomic_add_fetch(&z_embedded_runtime_${prefix}.active_entries, 1, __ATOMIC_ACQ_REL);
    if (__atomic_load_n(&z_embedded_runtime_${prefix}.state, __ATOMIC_ACQUIRE) == 1) break;
    __atomic_sub_fetch(&z_embedded_runtime_${prefix}.active_entries, 1, __ATOMIC_ACQ_REL);
  }
  return z_foreign_thread_enter(
    &z_embedded_runtime_${prefix},
    z_embedded_runtime_${prefix}.enqueue_release == NULL
      ? NULL
      : z_embedded_runtime_${prefix}_enqueue_release
  );
}

static void z_embedded_runtime_${prefix}_leave(Z_ForeignThreadEntry entry) {
  z_foreign_thread_leave(entry);
  if (__atomic_fetch_sub(&z_embedded_runtime_${prefix}.active_entries, 1, __ATOMIC_ACQ_REL) == 0) abort();
}

#if defined(__cplusplus)
extern "C" {
#endif

Z_API ${prefix}_runtime_status ${prefix}_runtime_initialize(const ${prefix}_runtime_config *config) {
  uint8_t expected = 0;
  if (!__atomic_compare_exchange_n(
    &z_embedded_runtime_${prefix}.state,
    &expected,
    5,
    false,
    __ATOMIC_ACQ_REL,
    __ATOMIC_ACQUIRE
  )) {
    if (expected == 1) return ${constant}_RUNTIME_ALREADY_INITIALIZED;
    if (expected == 2) return ${constant}_RUNTIME_SHUT_DOWN;
    if (expected == 4) return ${constant}_RUNTIME_DRAINING;
    return ${constant}_RUNTIME_BUSY;
  }
${initializerValidation}  z_embedded_runtime_${prefix}.context = config == NULL ? NULL : config->context;
  z_embedded_runtime_${prefix}.enqueue_release = config == NULL ? NULL : config->enqueue_release;
  z_embedded_runtime_${prefix}.is_main_thread = config == NULL ? NULL : config->is_main_thread;
${initializeRoot}  __atomic_store_n(&z_embedded_runtime_${prefix}.state, 1, __ATOMIC_RELEASE);
  return ${constant}_RUNTIME_OK;
}

Z_API ${prefix}_runtime_status ${prefix}_runtime_shutdown(void) {
  uint8_t previous;
  for (;;) {
    previous = __atomic_load_n(&z_embedded_runtime_${prefix}.state, __ATOMIC_ACQUIRE);
    if (previous == 0) return ${constant}_RUNTIME_NOT_INITIALIZED;
    if (previous == 2) return ${constant}_RUNTIME_SHUT_DOWN;
    if (previous == 3) return ${constant}_RUNTIME_BUSY;
    if (previous == 4
        && __atomic_load_n(&z_embedded_runtime_${prefix}.active_callbacks, __ATOMIC_ACQUIRE) != 0) {
      return ${constant}_RUNTIME_DRAINING;
    }
    uint8_t expected = previous;
    if (__atomic_compare_exchange_n(
      &z_embedded_runtime_${prefix}.state,
      &expected,
      3,
      false,
      __ATOMIC_ACQ_REL,
      __ATOMIC_ACQUIRE
    )) break;
  }
  if (__atomic_load_n(&z_embedded_runtime_${prefix}.active_entries, __ATOMIC_ACQUIRE) != 0) {
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, previous, __ATOMIC_RELEASE);
    return ${constant}_RUNTIME_BUSY;
  }
${shutdownRoot}  if (__atomic_load_n(&z_embedded_runtime_${prefix}.active_callbacks, __ATOMIC_ACQUIRE) != 0) {
    __atomic_store_n(&z_embedded_runtime_${prefix}.state, ${drainingState}, __ATOMIC_RELEASE);
    return ${activeCallbackStatus};
  }
  z_embedded_runtime_${prefix}.context = NULL;
  z_embedded_runtime_${prefix}.enqueue_release = NULL;
  z_embedded_runtime_${prefix}.is_main_thread = NULL;
  __atomic_store_n(&z_embedded_runtime_${prefix}.state, 2, __ATOMIC_RELEASE);
  return ${constant}_RUNTIME_OK;
}

#if defined(__cplusplus)
}
#endif

`);
}

function appendNativeCExportDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunction,
  in runtimeName: String
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
  if (runtimeName.byteLength > 0) {
    const prefix = embeddedRuntimeSymbolPart(runtimeName);
    output.append("  Z_ForeignThreadEntry _z_runtime_entry = z_embedded_runtime_");
    output.append(prefix);
    output.append("_enter();\n");
  }
  output.append("  ");
  if (declaration.returnType.kind != LoweredTypeKind.voidType) {
    if (runtimeName.byteLength > 0) {
      const resultType = try nativeCExportType(program, declaration.returnType);
      output.append(resultType);
      output.append(" _z_result = ");
    } else {
      output.append("return ");
    }
  }
  appendCBindingName(inout output, declaration.name);
  output.append("(");
  let first = true;
  for (const parameter of declaration.parameters) {
    if (!first) output.append(", ");
    first = false;
    if (parameter.type.kind == LoweredTypeKind.stringType) {
      output.append("z_stage1_string_from_cstring(");
      appendCBindingName(inout output, parameter.name);
      output.append(")");
    } else {
      appendCBindingName(inout output, parameter.name);
    }
  }
  output.append(");\n");
  if (runtimeName.byteLength > 0) {
    const prefix = embeddedRuntimeSymbolPart(runtimeName);
    output.append("  z_embedded_runtime_");
    output.append(prefix);
    output.append("_leave(_z_runtime_entry);\n");
    if (declaration.returnType.kind != LoweredTypeKind.voidType) {
      output.append("  return _z_result;\n");
    }
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
  if (
    type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.mapType
    || type.kind == LoweredTypeKind.setType
    || type.kind == LoweredTypeKind.stringType
    || type.kind == LoweredTypeKind.fsLockType
    || type.kind == LoweredTypeKind.classType
    || type.kind == LoweredTypeKind.weakType
    || type.kind == LoweredTypeKind.onceLifetimeType
    || type.kind == LoweredTypeKind.mutexType
    || type.kind == LoweredTypeKind.taskType
    || type.kind == LoweredTypeKind.arenaType
    || type.kind == LoweredTypeKind.functionType
  ) return true;
  if (type.kind == LoweredTypeKind.fixedArrayType) {
    match (loweredFixedArrayIndex(program, type.name)) {
      some(index) => return loweredTypeNeedsDeinit(
        program,
        program.fixedArrays[index].elementType
      );
      none => return false;
    }
  }
  if (type.kind == LoweredTypeKind.structType) {
    return loweredStructNeedsDeinit(program, type.name);
  }
  if (type.kind == LoweredTypeKind.enumType) {
    return loweredEnumNeedsDeinit(program, type.name);
  }
  if (
    type.kind == LoweredTypeKind.foreignStructType
    || type.kind == LoweredTypeKind.foreignHandleType
  ) {
    for (const resource of program.foreignResources) {
      if (
        resource.storageName == type.name
        && resource.releaseName.byteLength > 0
      ) return true;
    }
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

function loweredArrayIndex(
  in program: LoweredProgram,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < program.arrays.length) {
    if (program.arrays[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function loweredFixedArrayIndex(
  in program: LoweredProgram,
  in name: String
): Option<usize> {
  let index: usize = 0;
  while (index < program.fixedArrays.length) {
    if (program.fixedArrays[index].name == name) return Option.some(index);
    index = index + 1;
  }
  return Option<usize>.none;
}

function copyHelperTypePresent(
  in types: Array<LoweredType>,
  in name: String
): boolean {
  for (const type of types) {
    if (type.name == name) return true;
  }
  return false;
}

function collectCopyHelperType(
  in program: LoweredProgram,
  in type: LoweredType,
  inout types: Array<LoweredType>
): void throws String {
  if (
    type.kind != LoweredTypeKind.fixedArrayType
    && type.kind != LoweredTypeKind.arrayType
    && type.kind != LoweredTypeKind.structType
    && type.kind != LoweredTypeKind.enumType
  ) return;
  if (copyHelperTypePresent(types, type.name)) return;
  types.push(LoweredType({
    kind: type.kind,
    name: type.name.copyBytes(0, type.name.byteLength),
  }));
  if (type.kind == LoweredTypeKind.fixedArrayType) {
    match (loweredFixedArrayIndex(program, type.name)) {
      some(index) => try collectCopyHelperType(
        program,
        program.fixedArrays[index].elementType,
        inout types
      );
      none => throw `native copy emission lost fixed-array type ${type.name}`;
    }
    return;
  }
  if (type.kind == LoweredTypeKind.arrayType) {
    match (loweredArrayIndex(program, type.name)) {
      some(index) => try collectCopyHelperType(
        program,
        program.arrays[index].elementType,
        inout types
      );
      none => throw `native copy emission lost Array type ${type.name}`;
    }
    return;
  }
  if (type.kind == LoweredTypeKind.structType) {
    match (loweredStructIndex(program, type.name)) {
      some(index) => {
        if (program.structs[index].referenceType) {
          throw `native copy emission cannot copy class ${type.name}`;
        }
        for (const field of program.structs[index].fields) {
          try collectCopyHelperType(program, field.type, inout types);
        }
      }
      none => throw `native copy emission lost struct type ${type.name}`;
    }
    return;
  }
  match (loweredEnumIndex(program, type.name)) {
    some(index) => {
      for (const variant of program.enums[index].variants) {
        match (in variant.payload) {
          some(payload) => try collectCopyHelperType(
            program,
            payload,
            inout types
          );
          none => {}
        }
      }
    }
    none => throw `native copy emission lost enum type ${type.name}`;
  }
}

function programCopyHelperTypes(
  in program: LoweredProgram
): Array<LoweredType> throws String {
  let types = Array<LoweredType>();
  for (const declaration of program.functions) {
    for (const expression of declaration.expressions) {
      if (
        expression.kind != LoweredExpressionKind.copyValue
        || expression.value.byteLength == 0
        || expression.value == "String"
        || expression.value == "copy"
      ) continue;
      let found = Option<LoweredType>.none;
      match (loweredFixedArrayIndex(program, expression.value)) {
        some(_) => found = Option.some(LoweredType({
          kind: LoweredTypeKind.fixedArrayType,
          name: expression.value.copyBytes(0, expression.value.byteLength),
        }));
        none => {}
      }
      match (loweredArrayIndex(program, expression.value)) {
        some(_) => found = Option.some(LoweredType({
          kind: LoweredTypeKind.arrayType,
          name: expression.value.copyBytes(0, expression.value.byteLength),
        }));
        none => {}
      }
      match (loweredStructIndex(program, expression.value)) {
        some(_) => found = Option.some(LoweredType({
          kind: LoweredTypeKind.structType,
          name: expression.value.copyBytes(0, expression.value.byteLength),
        }));
        none => {}
      }
      match (loweredEnumIndex(program, expression.value)) {
        some(_) => found = Option.some(LoweredType({
          kind: LoweredTypeKind.enumType,
          name: expression.value.copyBytes(0, expression.value.byteLength),
        }));
        none => {}
      }
      match (found) {
        some(type) => try collectCopyHelperType(program, type, inout types);
        none => throw `native copy emission could not resolve ${expression.value}`;
      }
    }
  }
  return types;
}

function appendCopiedValue(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in type: LoweredType,
  in value: String
): void throws String {
  if (type.kind == LoweredTypeKind.stringType) {
    output.append("z_string_copy(");
    output.append(value);
    output.append(")");
    return;
  }
  if (
    type.kind == LoweredTypeKind.fixedArrayType
    || type.kind == LoweredTypeKind.arrayType
    || type.kind == LoweredTypeKind.structType
    || type.kind == LoweredTypeKind.enumType
  ) {
    output.append("z_stage1_copy_");
    output.append(type.name);
    output.append("(");
    output.append(value);
    output.append(")");
    return;
  }
  if (loweredTypeNeedsDeinit(program, type)) {
    throw `native copy emission cannot copy ownership-bearing type ${type.name}`;
  }
  output.append(value);
}

function appendCopyHelper(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in type: LoweredType
): void throws String {
  const storageType = try cType(type);
  output.append("static __attribute__((unused)) ");
  output.append(storageType);
  output.append(" z_stage1_copy_");
  output.append(type.name);
  output.append("(");
  output.append(storageType);
  output.append(" source) {\n");
  if (type.kind == LoweredTypeKind.fixedArrayType) {
    const index = match (loweredFixedArrayIndex(program, type.name)) {
      some(value) => value;
      none => throw `native copy emission lost fixed-array type ${type.name}`;
    };
    const elementType = LoweredType({
      kind: program.fixedArrays[index].elementType.kind,
      name: program.fixedArrays[index].elementType.name.copyBytes(
        0,
        program.fixedArrays[index].elementType.name.byteLength
      ),
    });
    output.append("  ");
    output.append(storageType);
    output.append(" result = {0};\n");
    output.append("  for (size_t index = 0; index < ");
    output.append(program.fixedArrays[index].length);
    output.append("; index += 1) {\n    result.data[index] = ");
    try appendCopiedValue(
      inout output,
      program,
      elementType,
      "source.data[index]"
    );
    output.append(";\n  }\n  return result;\n}\n\n");
    return;
  }
  if (type.kind == LoweredTypeKind.arrayType) {
    const index = match (loweredArrayIndex(program, type.name)) {
      some(value) => value;
      none => throw `native copy emission lost Array type ${type.name}`;
    };
    const elementType = LoweredType({
      kind: program.arrays[index].elementType.kind,
      name: program.arrays[index].elementType.name.copyBytes(
        0,
        program.arrays[index].elementType.name.byteLength
      ),
    });
    const elementStorage = try cType(elementType);
    output.append("  ");
    output.append(storageType);
    output.append(" result = { NULL, 0, 0 };\n");
    output.append("  if (source.length == 0) return result;\n");
    output.append("  if (source.length > SIZE_MAX / sizeof(");
    output.append(elementStorage);
    output.append(")) abort();\n  ");
    output.append(elementStorage);
    output.append(" *source_data = (");
    output.append(elementStorage);
    output.append(" *)source.data;\n  ");
    output.append(elementStorage);
    output.append(" *result_data = (");
    output.append(elementStorage);
    output.append(" *)malloc(sizeof(");
    output.append(elementStorage);
    output.append(") * source.length);\n");
    output.append("  if (result_data == NULL) abort();\n");
    output.append("  result.data = result_data;\n  result.length = source.length;\n  result.capacity = source.length;\n");
    output.append("  for (size_t index = 0; index < source.length; index += 1) {\n    result_data[index] = ");
    try appendCopiedValue(
      inout output,
      program,
      elementType,
      "source_data[index]"
    );
    output.append(";\n  }\n  return result;\n}\n\n");
    return;
  }
  if (type.kind == LoweredTypeKind.structType) {
    const index = match (loweredStructIndex(program, type.name)) {
      some(value) => value;
      none => throw `native copy emission lost struct type ${type.name}`;
    };
    output.append("  return (");
    output.append(storageType);
    output.append("){ ");
    let fieldIndex: usize = 0;
    while (fieldIndex < program.structs[index].fields.length) {
      if (fieldIndex > 0) output.append(", ");
      const fieldName = program.structs[index].fields[
        fieldIndex
      ].name.copyBytes(
        0,
        program.structs[index].fields[fieldIndex].name.byteLength
      );
      const fieldType = LoweredType({
        kind: program.structs[index].fields[fieldIndex].type.kind,
        name: program.structs[index].fields[fieldIndex].type.name.copyBytes(
          0,
          program.structs[index].fields[fieldIndex].type.name.byteLength
        ),
      });
      const borrowedView = program.structs[index].fields[
        fieldIndex
      ].borrowedView;
      output.append(".");
      output.append(fieldName);
      output.append(" = ");
      if (borrowedView) output.append(`source.${fieldName}`);
      else try appendCopiedValue(
          inout output,
          program,
          fieldType,
          `source.${fieldName}`
        );
      fieldIndex = fieldIndex + 1;
    }
    output.append(" };\n}\n\n");
    return;
  }
  const index = match (loweredEnumIndex(program, type.name)) {
    some(value) => value;
    none => throw `native copy emission lost enum type ${type.name}`;
  };
  if (
    program.enums[index].nativeCName.byteLength > 0
    || !program.enums[index].payloadBearing
  ) {
    output.append("  return source;\n}\n\n");
    return;
  }
  output.append("  ");
  output.append(storageType);
  output.append(" result = { 0 };\n  result.tag = source.tag;\n  switch (source.tag) {\n");
  for (const variant of program.enums[index].variants) {
    match (in variant.payload) {
      some(payload) => {
        output.append("    case Z_");
        output.append(type.name);
        output.append("Tag_");
        output.append(variant.name);
        output.append(":\n      result.payload.");
        output.append(variant.name);
        output.append(" = ");
        try appendCopiedValue(
          inout output,
          program,
          payload,
          `source.payload.${variant.name}`
        );
        output.append(";\n      break;\n");
      }
      none => {}
    }
  }
  output.append("    default:\n      break;\n  }\n  return result;\n}\n\n");
}

function appendCopyHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  const types = try programCopyHelperTypes(program);
  for (const type of types) {
    const storageType = try cType(type);
    output.append("static __attribute__((unused)) ");
    output.append(storageType);
    output.append(" z_stage1_copy_");
    output.append(type.name);
    output.append("(");
    output.append(storageType);
    output.append(" source);\n");
  }
  if (types.length > 0) output.append("\n");
  for (const type of types) {
    try appendCopyHelper(inout output, program, type);
  }
}

function appendFixedArrayDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  index: usize,
  inout fixedArrayStates: Array<u8>,
  inout structStates: Array<u8>,
  inout enumStates: Array<u8>
): void throws String {
  if (fixedArrayStates[index] == 2) return;
  if (fixedArrayStates[index] == 1) {
    throw `native C emission found a by-value type cycle through ${program.fixedArrays[index].name}`;
  }
  fixedArrayStates[index] = 1;
  const sourceElementType = view program.fixedArrays[index].elementType;
  const elementType = LoweredType({
    kind: sourceElementType.kind,
    name: sourceElementType.name.copyBytes(
      0,
      sourceElementType.name.byteLength
    ),
  });
  match (loweredFixedArrayIndex(program, elementType.name)) {
    some(dependency) => try appendFixedArrayDefinition(
      inout output,
      program,
      dependency,
      inout fixedArrayStates,
      inout structStates,
      inout enumStates
    );
    none => {}
  }
  match (loweredStructIndex(program, elementType.name)) {
    some(dependency) => try appendStructDefinition(
      inout output,
      program,
      dependency,
      inout fixedArrayStates,
      inout structStates,
      inout enumStates
    );
    none => {}
  }
  match (loweredEnumIndex(program, elementType.name)) {
    some(dependency) => try appendEnumDefinition(
      inout output,
      program,
      dependency,
      inout fixedArrayStates,
      inout structStates,
      inout enumStates
    );
    none => {}
  }
  const nativeElementType = try cType(elementType);
  output.append("typedef struct Z_");
  output.append(program.fixedArrays[index].name);
  output.append(" {\n  ");
  output.append(nativeElementType);
  output.append(" data[");
  output.append(program.fixedArrays[index].length);
  output.append("];\n} Z_");
  output.append(program.fixedArrays[index].name);
  output.append(";\n\n");
  fixedArrayStates[index] = 2;
}

function appendEnumDefinition(
  inout output: TextBuffer,
  in program: LoweredProgram,
  index: usize,
  inout fixedArrayStates: Array<u8>,
  inout structStates: Array<u8>,
  inout enumStates: Array<u8>
): void throws String {
  if (enumStates[index] == 2) return;
  if (enumStates[index] == 1) {
    throw `native C emission found a by-value type cycle through ${program.enums[index].name}`;
  }
  enumStates[index] = 1;
  if (isNicheViewOption(program.enums[index].name)) {
    let payload = Option<LoweredType>.none;
    for (const variant of program.enums[index].variants) {
      if (variant.name != "some") continue;
      match (in variant.payload) {
        some(type) => payload = Option.some(LoweredType({
          kind: type.kind,
          name: type.name.copyBytes(0, type.name.byteLength),
        }));
        none => {}
      }
    }
    const viewTarget = match (payload) {
      some(type) => type;
      none => throw "native C emission lost a niche Option view payload";
    };
    if (viewTarget.kind == LoweredTypeKind.structType) {
      output.append("typedef struct Z_");
      output.append(viewTarget.name);
      output.append(" Z_");
      output.append(viewTarget.name);
      output.append(";\n");
    }
    output.append("typedef ");
    const viewTargetType = try cType(viewTarget);
    output.append(viewTargetType);
    if (
      viewTarget.kind != LoweredTypeKind.cstringType
      && viewTarget.kind != LoweredTypeKind.foreignHandleType
    ) output.append(" const *");
    output.append(" Z_");
    output.append(program.enums[index].name);
    output.append(";\n\n");
    enumStates[index] = 2;
    return;
  }
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
            inout fixedArrayStates,
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
            inout fixedArrayStates,
            inout structStates,
            inout enumStates
          );
          none => {}
        }
        match (loweredFixedArrayIndex(program, type.name)) {
          some(dependency) => try appendFixedArrayDefinition(
            inout output,
            program,
            dependency,
            inout fixedArrayStates,
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
  inout fixedArrayStates: Array<u8>,
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
        inout fixedArrayStates,
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
        inout fixedArrayStates,
        inout structStates,
        inout enumStates
      );
      none => {}
    }
    match (loweredFixedArrayIndex(program, field.type.name)) {
      some(dependency) => try appendFixedArrayDefinition(
        inout output,
        program,
        dependency,
        inout fixedArrayStates,
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
  if (program.structs[index].referenceType) {
    output.append("  size_t _z_refcount;\n");
    output.append("  Z_WeakControl *_z_weak;\n");
  }
  for (const field of program.structs[index].fields) {
    const fieldType = try cType(field.type);
    output.append("  ");
    output.append(fieldType);
    if (
      field.borrowedView
      && field.type.kind != LoweredTypeKind.cstringType
    ) output.append(" const *");
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

function appendFunctionTypeLayout(
  inout output: TextBuffer,
  in declaration: LoweredFunctionType
): void throws String {
  const returnType = try cType(declaration.returnType);
  output.append("typedef struct Z_");
  output.append(declaration.name);
  output.append(" {\n  ");
  if (declaration.asynchronous) {
    output.append("Z_AsyncInvocation (*start)(void *context, Z_AsyncExecutor *executor");
  } else {
    output.append(returnType);
    output.append(" (*call)(void *context");
  }
  for (const parameter of declaration.parameters) {
    output.append(", ");
    const parameterType = try cType(parameter.type);
    if (
      parameter.mode == LoweredParameterMode.input
      && parameter.type.kind != LoweredTypeKind.classType
    ) output.append("const ");
    output.append(parameterType);
    if (
      parameter.mode == LoweredParameterMode.input
      && parameter.type.kind == LoweredTypeKind.classType
    ) output.append(" const *");
    else if (parameter.mode != LoweredParameterMode.value) output.append(" *");
  }
  output.append(");\n  void *context;\n  void (*retain)(void *context);\n  void (*release)(void *context);\n} Z_");
  output.append(declaration.name);
  output.append(";\n\n");
}

function appendFunctionTypeHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram,
  in declaration: LoweredFunctionType
): void throws String {
  const returnType = try cType(declaration.returnType);
  output.append("static inline __attribute__((unused)) Z_");
  output.append(declaration.name);
  output.append(" Z_");
  output.append(declaration.name);
  output.append("_retain(Z_");
  output.append(declaration.name);
  output.append(" value) {\n  if (value.retain != NULL) value.retain(value.context);\n  return value;\n}\n\n");
  output.append("static inline __attribute__((unused)) ");
  if (declaration.asynchronous) output.append("Z_AsyncInvocation");
  else output.append(returnType);
  output.append(" Z_");
  output.append(declaration.name);
  if (declaration.asynchronous) output.append("_start(Z_");
  else output.append("_call(Z_");
  output.append(declaration.name);
  output.append(" value");
  if (declaration.asynchronous) {
    output.append(", Z_AsyncExecutor *executor");
  }
  let parameterIndex: usize = 0;
  while (parameterIndex < declaration.parameters.length) {
    output.append(", ");
    try appendCallableParameterDeclaration(
      inout output,
      declaration.parameters[parameterIndex],
      declaration.parameters[parameterIndex].name
    );
    parameterIndex = parameterIndex + 1;
  }
  output.append(") {\n  ");
  if (
    declaration.asynchronous
    || declaration.returnType.kind != LoweredTypeKind.voidType
  ) {
    output.append("return ");
  }
  if (declaration.asynchronous) {
    output.append("value.start(value.context, executor");
  } else output.append("value.call(value.context");
  for (const parameter of declaration.parameters) {
    output.append(", ");
    appendCBindingName(inout output, parameter.name);
  }
  output.append(");\n}\n\n");
  output.append("static inline __attribute__((unused)) void Z_");
  output.append(declaration.name);
  output.append("_deinit(Z_");
  output.append(declaration.name);
  output.append(" *value) {\n  if (value == NULL) return;\n  if (value->release != NULL) value->release(value->context);\n");
  if (declaration.asynchronous) output.append("  value->start = NULL;\n");
  else output.append("  value->call = NULL;\n");
  output.append("  value->context = NULL;\n  value->retain = NULL;\n  value->release = NULL;\n}\n\n");
  if (programUsesForeignCallbackType(program, declaration.name)) {
    try appendForeignCallbackHelpers(inout output, declaration);
  }
}

function appendTypeDefinitions(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  const taskNames = programTaskTypeNames(program);
  if (taskNames.length > 0) {
    output.append("typedef void (*Z_MainThreadRequest)(void *context);\n\n");
  }
  let usesAsyncFunctionType = false;
  for (const declaration of program.functionTypes) {
    if (declaration.asynchronous) usesAsyncFunctionType = true;
  }
  if (usesAsyncFunctionType) {
    output.append("typedef struct Z_AsyncTask Z_AsyncTask;\n");
    output.append("typedef struct Z_AsyncExecutor Z_AsyncExecutor;\n");
    output.append("struct Z_AsyncTask {\n");
    output.append("  void (*poll)(Z_AsyncTask *task);\n");
    output.append("  bool completed;\n");
    output.append("  bool queued;\n");
    output.append("  Z_AsyncTask *waiter;\n");
    output.append("  Z_AsyncTask *next;\n");
    output.append("  Z_AsyncExecutor *executor;\n");
    output.append("};\n");
    output.append("struct Z_AsyncExecutor {\n");
    output.append("  Z_AsyncTask *head;\n");
    output.append("  Z_AsyncTask *tail;\n");
    output.append("};\n");
    output.append("typedef struct Z_AsyncInvocation {\n");
    output.append("  Z_AsyncTask *task;\n");
    output.append("  bool (*failed)(Z_AsyncTask *task);\n");
    output.append("  void (*take_result)(Z_AsyncTask *task, void *destination);\n");
    output.append("  void (*take_error)(Z_AsyncTask *task, void *destination);\n");
    output.append("  void (*destroy)(Z_AsyncTask *task);\n");
    output.append("  void *callable_context;\n");
    output.append("  void (*release_context)(void *context);\n");
    output.append("} Z_AsyncInvocation;\n\n");
  }
  for (const taskName of taskNames) {
    output.append("typedef struct Z_");
    output.append(taskName);
    output.append("Storage Z_");
    output.append(taskName);
    output.append("Storage;\n");
    output.append("typedef struct Z_");
    output.append(taskName);
    output.append(" {\n  Z_");
    output.append(taskName);
    output.append("Storage *storage;\n} Z_");
    output.append(taskName);
    output.append(";\n\n");
  }
  const mutexNames = programMutexTypeNames(program);
  for (const mutexName of mutexNames) {
    output.append("typedef struct Z_");
    output.append(mutexName);
    output.append("Storage Z_");
    output.append(mutexName);
    output.append("Storage;\n");
    output.append("typedef struct Z_");
    output.append(mutexName);
    output.append(" {\n  Z_");
    output.append(mutexName);
    output.append("Storage *storage;\n} Z_");
    output.append(mutexName);
    output.append(";\n\n");
  }
  const onceNames = programOnceTypeNames(program);
  for (const onceName of onceNames) {
    const prefix = "Once_";
    const valueName = onceName.copyBytes(
      prefix.byteLength,
      onceName.byteLength
    );
    output.append("typedef struct Z_");
    output.append(onceName);
    output.append(" Z_");
    output.append(onceName);
    output.append(";\ntypedef struct Z_OnceLifetime_");
    output.append(valueName);
    output.append(" Z_OnceLifetime_");
    output.append(valueName);
    output.append(";\n");
  }
  if (onceNames.length > 0) output.append("\n");
  for (const declaration of program.slices) {
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" {\n");
    output.append("  void *data;\n");
    output.append("  size_t length;\n");
    output.append("} Z_");
    output.append(declaration.name);
    output.append(";\n\n");
  }
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
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append("_Entry Z_");
    output.append(declaration.name);
    output.append("_Entry;\n");
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
    if (declaration.elementType.kind == LoweredTypeKind.structType) {
      output.append("typedef struct Z_");
      output.append(declaration.elementType.name);
      output.append(" Z_");
      output.append(declaration.elementType.name);
      output.append(";\n");
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
  if (
    program.arrays.length > 0
    || program.maps.length > 0
    || program.sets.length > 0
  ) output.append("\n");
  let fixedArrayStates = Array<u8>();
  let structStates = Array<u8>();
  let enumStates = Array<u8>();
  let stateIndex: usize = 0;
  while (stateIndex < program.fixedArrays.length) {
    fixedArrayStates.push(0);
    stateIndex = stateIndex + 1;
  }
  stateIndex = 0;
  while (stateIndex < program.structs.length) {
    structStates.push(0);
    stateIndex = stateIndex + 1;
  }
  stateIndex = 0;
  while (stateIndex < program.enums.length) {
    enumStates.push(0);
    stateIndex = stateIndex + 1;
  }
  for (const declaration of program.structs) {
    if (declaration.nativeCName.byteLength > 0) {
      output.append("typedef struct ");
      output.append(declaration.nativeCName);
      output.append(" ");
      output.append(declaration.nativeCName);
      output.append(";\ntypedef ");
      output.append(declaration.nativeCName);
      output.append(" Z_");
      output.append(declaration.name);
      output.append(";\n");
    } else {
      output.append("typedef struct Z_");
      output.append(declaration.name);
      output.append(" Z_");
      output.append(declaration.name);
      output.append(";\n");
    }
  }
  for (const declaration of program.fixedArrays) {
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" Z_");
    output.append(declaration.name);
    output.append(";\n");
  }
  for (const declaration of program.enums) {
    if (
      !declaration.payloadBearing
      || isNicheViewOption(declaration.name)
    ) continue;
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" Z_");
    output.append(declaration.name);
    output.append(";\n");
  }
  for (const declaration of program.functionTypes) {
    output.append("typedef struct Z_");
    output.append(declaration.name);
    output.append(" Z_");
    output.append(declaration.name);
    output.append(";\n");
  }
  if (
    program.structs.length > 0
    || program.fixedArrays.length > 0
    || program.enums.length > 0
    || program.functionTypes.length > 0
  ) output.append("\n");
  let enumIndex: usize = 0;
  while (enumIndex < program.enums.length) {
    if (!program.enums[enumIndex].payloadBearing) {
      try appendEnumDefinition(
        inout output,
        program,
        enumIndex,
        inout fixedArrayStates,
        inout structStates,
        inout enumStates
      );
    }
    enumIndex = enumIndex + 1;
  }
  for (const declaration of program.functionTypes) {
    try appendFunctionTypeLayout(inout output, declaration);
  }
  enumIndex = 0;
  while (enumIndex < program.enums.length) {
    if (program.enums[enumIndex].payloadBearing) {
      try appendEnumDefinition(
        inout output,
        program,
        enumIndex,
        inout fixedArrayStates,
        inout structStates,
        inout enumStates
      );
    }
    enumIndex = enumIndex + 1;
  }
  let structIndex: usize = 0;
  while (structIndex < program.structs.length) {
    try appendStructDefinition(
      inout output,
      program,
      structIndex,
      inout fixedArrayStates,
      inout structStates,
      inout enumStates
    );
    structIndex = structIndex + 1;
  }
  let fixedArrayIndex: usize = 0;
  while (fixedArrayIndex < program.fixedArrays.length) {
    try appendFixedArrayDefinition(
      inout output,
      program,
      fixedArrayIndex,
      inout fixedArrayStates,
      inout structStates,
      inout enumStates
    );
    fixedArrayIndex = fixedArrayIndex + 1;
  }
  for (const declaration of program.functionTypes) {
    try appendFunctionTypeHelpers(inout output, program, declaration);
  }
  for (const declaration of program.maps) {
    const keyType = try cType(declaration.keyType);
    const valueType = try cType(declaration.valueType);
    output.append("struct Z_");
    output.append(declaration.name);
    output.append("_Entry {\n  ");
    output.append(keyType);
    output.append(" key;\n  ");
    output.append(valueType);
    output.append(" value;\n};\n\n");
  }
  for (const taskName of taskNames) {
    const resultType = try taskResultType(program, taskName);
    const nativeResultType = try cType(resultType);
    output.append("struct Z_");
    output.append(taskName);
    output.append("Storage {\n#if defined(_WIN32)\n  HANDLE thread;\n  SRWLOCK state_mutex;\n  CONDITION_VARIABLE state_condition;\n  DWORD owner_thread;\n#else\n  pthread_t thread;\n  pthread_mutex_t state_mutex;\n  pthread_cond_t state_condition;\n  pthread_t owner_thread;\n#endif\n  bool joined;\n  bool finished;\n  bool result_live;\n  bool cancellation_requested;\n  bool continuation_cancelled;\n  bool main_request_pending;\n  bool main_request_done;\n  Z_MainThreadRequest main_request;\n  void *main_request_context;\n  void *context;\n  ");
    output.append(nativeResultType);
    output.append(" result;\n};\n\n");
  }
  for (const mutexName of mutexNames) {
    const valueType = try mutexValueType(program, mutexName);
    const nativeValueType = try cType(valueType);
    output.append("struct Z_");
    output.append(mutexName);
    output.append("Storage {\n#if defined(_WIN32)\n  SRWLOCK native;\n#else\n  pthread_mutex_t native;\n#endif\n  size_t refcount;\n  ");
    output.append(nativeValueType);
    output.append(" value;\n};\n\n");
  }
  for (const onceName of onceNames) {
    const prefix = "Once_";
    const valueName = onceName.copyBytes(
      prefix.byteLength,
      onceName.byteLength
    );
    output.append("typedef struct Z_");
    output.append(onceName);
    output.append(" {\n#if defined(_WIN32)\n  SRWLOCK native;\n#else\n  pthread_mutex_t native;\n#endif\n  Z_");
    output.append(valueName);
    output.append(" *value;\n  uint8_t state;\n} Z_");
    output.append(onceName);
    output.append(";\n\n");
    output.append("typedef struct Z_OnceLifetime_");
    output.append(valueName);
    output.append(" {\n  Z_");
    output.append(onceName);
    output.append(" *cell;\n} Z_OnceLifetime_");
    output.append(valueName);
    output.append(";\n\n");
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
  if (type.kind == LoweredTypeKind.stringType) return "String";
  if (type.kind == LoweredTypeKind.functionType) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  if (
    type.kind == LoweredTypeKind.structType
    || type.kind == LoweredTypeKind.enumType
  ) return type.name.copyBytes(0, type.name.byteLength);
  throw "native C emission cannot form an intrinsic identity for this type";
}

function appendMapRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.maps) {
    const keyType = try cType(declaration.keyType);
    const valueType = try cType(declaration.valueType);
    const valueIdentity = try loweredIntrinsicIdentity(declaration.valueType);
    const optionName = `__z_NicheViewOption_${valueIdentity}`;
    const ownedOptionName = `__z_Option_${valueIdentity}`;
    const ownedFunctionGet = declaration.valueType.kind
      == LoweredTypeKind.functionType;
    let supportsRemove = false;
    let hasViewOption = false;
    for (const enumeration of program.enums) {
      if (enumeration.name == ownedOptionName) supportsRemove = true;
      if (enumeration.name == optionName) hasViewOption = true;
    }
    if (!ownedFunctionGet && !hasViewOption) {
      output.append("typedef ");
      output.append(valueType);
      if (
        declaration.valueType.kind != LoweredTypeKind.cstringType
        && declaration.valueType.kind != LoweredTypeKind.foreignHandleType
      ) output.append(" const *");
      output.append(" Z_");
      output.append(optionName);
      output.append(";\n\n");
    }
    output.append("static inline __attribute__((unused)) size_t Z_");
    output.append(declaration.name);
    output.append("_hash(");
    output.append(keyType);
    output.append(" value) {\n");
    if (declaration.keyType.kind == LoweredTypeKind.structType) {
      output.append("  Z_Hasher hasher = z_hasher_new();\n  Z_");
      output.append(declaration.keyType.name);
      output.append("_hash(&value, &hasher);\n  return z_hasher_finish(hasher);\n");
    } else if (declaration.keyType.kind == LoweredTypeKind.stringType) {
      output.append("  Z_Hasher hasher = z_hasher_new();\n");
      output.append("  z_hasher_add_string(&hasher, value);\n");
      output.append("  return z_hasher_finish(hasher);\n");
    } else {
      output.append("  Z_Hasher hasher = z_hasher_new();\n");
      output.append("  z_hasher_add_u64(&hasher, (uint64_t)value);\n");
      output.append("  return z_hasher_finish(hasher);\n");
    }
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_equal(");
    output.append(keyType);
    output.append(" left, ");
    output.append(keyType);
    output.append(" right) {\n  return ");
    if (declaration.keyType.kind == LoweredTypeKind.structType) {
      output.append("Z_");
      output.append(declaration.keyType.name);
      output.append("_equals(&left, &right)");
    } else if (declaration.keyType.kind == LoweredTypeKind.stringType) {
      output.append("z_string_equal(left, right)");
    } else output.append("left == right");
    output.append(";\n}\n\n");
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
    output.append(" *self, ");
    output.append(keyType);
    output.append(" key) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && Z_");
    output.append(declaration.name);
    output.append("_equal(self->entries[stored - 1].key, key)) return true;\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return false;\n}\n\n");
    output.append("static inline __attribute__((unused)) Z_");
    if (ownedFunctionGet) output.append(ownedOptionName);
    else output.append(optionName);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_get(const Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(keyType);
    output.append(" key) {\n");
    if (ownedFunctionGet) {
      output.append("  if (self->bucketCount == 0) return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_none };\n");
    } else output.append("  if (self->bucketCount == 0) return NULL;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    if (ownedFunctionGet) {
      output.append("    if (stored == 0) return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_none };\n");
    } else output.append("    if (stored == 0) return NULL;\n");
    output.append("    if (stored != SIZE_MAX && Z_");
    output.append(declaration.name);
    output.append("_equal(self->entries[stored - 1].key, key)) return ");
    if (ownedFunctionGet) {
      output.append("(Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_some, .payload.some = Z_");
      output.append(declaration.valueType.name);
      output.append("_retain(self->entries[stored - 1].value) }");
    } else output.append("&(self->entries[stored - 1].value)");
    output.append(";\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    if (ownedFunctionGet) {
      output.append("  }\n  return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_none };\n}\n\n");
    } else output.append("  }\n  return NULL;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_set(Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(keyType);
    output.append(" key, ");
    output.append(valueType);
    output.append(" value) {\n");
    if (ownedFunctionGet) {
      output.append("  value = Z_");
      output.append(declaration.valueType.name);
      output.append("_retain(value);\n");
    }
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
    output.append("    } else if (Z_");
    output.append(declaration.name);
    output.append("_equal(self->entries[stored - 1].key, key)) {\n");
    if (loweredTypeNeedsDeinit(program, declaration.keyType)) {
      output.append("      Z_");
      output.append(declaration.keyType.name);
      output.append("_deinit(&key);\n");
    }
    if (loweredTypeNeedsDeinit(program, declaration.valueType)) {
      output.append("      Z_");
      output.append(declaration.valueType.name);
      output.append("_deinit(&self->entries[stored - 1].value);\n");
    }
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
    if (supportsRemove) {
      output.append("static __attribute__((unused)) Z_");
      output.append(ownedOptionName);
      output.append(" Z_");
      output.append(declaration.name);
      output.append("_remove(Z_");
      output.append(declaration.name);
      output.append(" *self, ");
      output.append(keyType);
      output.append(" key) {\n");
      output.append("  if (self->bucketCount == 0) return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_none };\n");
      output.append("  size_t slot = Z_");
      output.append(declaration.name);
      output.append("_hash(key) & (self->bucketCount - 1);\n");
      output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
      output.append("    const size_t stored = self->buckets[slot];\n");
      output.append("    if (stored == 0) break;\n");
      output.append("    if (stored != SIZE_MAX && Z_");
      output.append(declaration.name);
      output.append("_equal(self->entries[stored - 1].key, key)) {\n");
      output.append("      const size_t entry = stored - 1;\n");
      output.append("      const size_t last = self->length - 1;\n");
      if (loweredTypeNeedsDeinit(program, declaration.keyType)) {
        output.append("      Z_");
        output.append(declaration.keyType.name);
        output.append("_deinit(&self->entries[entry].key);\n");
      }
      output.append("      ");
      output.append(valueType);
      output.append(" value = self->entries[entry].value;\n");
      output.append("      self->buckets[slot] = SIZE_MAX;\n");
      output.append("      self->tombstones += 1;\n");
      output.append("      if (entry != last) {\n");
      output.append("        self->entries[entry] = self->entries[last];\n");
      output.append("        size_t movedSlot = Z_");
      output.append(declaration.name);
      output.append("_hash(self->entries[entry].key) & (self->bucketCount - 1);\n");
      output.append("        for (size_t movedProbe = 0; movedProbe < self->bucketCount; movedProbe += 1) {\n");
      output.append("          if (self->buckets[movedSlot] == self->length) {\n");
      output.append("            self->buckets[movedSlot] = entry + 1;\n");
      output.append("            break;\n");
      output.append("          }\n");
      output.append("          movedSlot = (movedSlot + 1) & (self->bucketCount - 1);\n");
      output.append("        }\n");
      output.append("      }\n");
      output.append("      self->length = last;\n");
      output.append("      return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_some, .payload.some = value };\n");
      output.append("    }\n");
      output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
      output.append("  }\n");
      output.append("  return (Z_");
      output.append(ownedOptionName);
      output.append("){ .tag = Z_");
      output.append(ownedOptionName);
      output.append("Tag_none };\n");
      output.append("}\n\n");
    }
    output.append("static __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_delete(Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(keyType);
    output.append(" key) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(key) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && Z_");
    output.append(declaration.name);
    output.append("_equal(self->entries[stored - 1].key, key)) {\n");
    output.append("      const size_t entry = stored - 1;\n");
    output.append("      const size_t last = self->length - 1;\n");
    if (loweredTypeNeedsDeinit(program, declaration.keyType)) {
      output.append("      Z_");
      output.append(declaration.keyType.name);
      output.append("_deinit(&self->entries[entry].key);\n");
    }
    if (loweredTypeNeedsDeinit(program, declaration.valueType)) {
      output.append("      Z_");
      output.append(declaration.valueType.name);
      output.append("_deinit(&self->entries[entry].value);\n");
    }
    output.append("      self->buckets[slot] = SIZE_MAX;\n");
    output.append("      self->tombstones += 1;\n");
    output.append("      if (entry != last) {\n");
    output.append("        self->entries[entry] = self->entries[last];\n");
    output.append("        size_t movedSlot = Z_");
    output.append(declaration.name);
    output.append("_hash(self->entries[entry].key) & (self->bucketCount - 1);\n");
    output.append("        for (size_t movedProbe = 0; movedProbe < self->bucketCount; movedProbe += 1) {\n");
    output.append("          if (self->buckets[movedSlot] == self->length) {\n");
    output.append("            self->buckets[movedSlot] = entry + 1;\n");
    output.append("            break;\n");
    output.append("          }\n");
    output.append("          movedSlot = (movedSlot + 1) & (self->bucketCount - 1);\n");
    output.append("        }\n");
    output.append("      }\n");
    output.append("      self->length = last;\n");
    output.append("      return true;\n");
    output.append("    }\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n");
    output.append("  return false;\n");
    output.append("}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_clear(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  while (self->length > 0) {\n");
    output.append("    self->length -= 1;\n");
    if (loweredTypeNeedsDeinit(program, declaration.keyType)) {
      output.append("    Z_");
      output.append(declaration.keyType.name);
      output.append("_deinit(&self->entries[self->length].key);\n");
    }
    if (loweredTypeNeedsDeinit(program, declaration.valueType)) {
      output.append("    Z_");
      output.append(declaration.valueType.name);
      output.append("_deinit(&self->entries[self->length].value);\n");
    }
    output.append("  }\n");
    output.append("  if (self->bucketCount > 0) memset(self->buckets, 0, self->bucketCount * sizeof(size_t));\n");
    output.append("  self->tombstones = 0;\n");
    output.append("}\n\n");
  }
}

function appendSetRuntime(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  for (const declaration of program.sets) {
    const elementType = try cType(declaration.elementType);
    const elementIdentity = try loweredIntrinsicIdentity(
      declaration.elementType
    );
    const optionName = `__z_Option_${elementIdentity}`;
    let supportsRemove = false;
    for (const enumeration of program.enums) {
      if (enumeration.name == optionName) supportsRemove = true;
    }
    output.append("static inline __attribute__((unused)) size_t Z_");
    output.append(declaration.name);
    output.append("_hash(");
    output.append(elementType);
    output.append(" value) {\n");
    if (declaration.elementType.kind == LoweredTypeKind.structType) {
      output.append("  Z_Hasher hasher = z_hasher_new();\n  Z_");
      output.append(declaration.elementType.name);
      output.append("_hash(&value, &hasher);\n  return z_hasher_finish(hasher);\n");
    } else if (declaration.elementType.kind == LoweredTypeKind.stringType) {
      output.append("  Z_Hasher hasher = z_hasher_new();\n");
      output.append("  z_hasher_add_string(&hasher, value);\n");
      output.append("  return z_hasher_finish(hasher);\n");
    } else {
      output.append("  Z_Hasher hasher = z_hasher_new();\n");
      output.append("  z_hasher_add_u64(&hasher, (uint64_t)value);\n");
      output.append("  return z_hasher_finish(hasher);\n");
    }
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_equal(");
    output.append(elementType);
    output.append(" left, ");
    output.append(elementType);
    output.append(" right) {\n  return ");
    if (declaration.elementType.kind == LoweredTypeKind.structType) {
      output.append("Z_");
      output.append(declaration.elementType.name);
      output.append("_equals(&left, &right)");
    } else if (declaration.elementType.kind == LoweredTypeKind.stringType) {
      output.append("z_string_equal(left, right)");
    } else output.append("left == right");
    output.append(";\n}\n\n");
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
    output.append(" *self, ");
    output.append(elementType);
    output.append(" value) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(value) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && Z_");
    output.append(declaration.name);
    output.append("_equal(self->values[stored - 1], value)) return true;\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return false;\n}\n\n");
    output.append("static __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_add(Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(elementType);
    output.append(" value) {\n");
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
    output.append("    } else if (Z_");
    output.append(declaration.name);
    output.append("_equal(self->values[stored - 1], value)) {\n");
    if (loweredTypeNeedsDeinit(program, declaration.elementType)) {
      output.append("      Z_");
      output.append(declaration.elementType.name);
      output.append("_deinit(&value);\n");
    }
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
    output.append("    if (next > SIZE_MAX / sizeof(");
    output.append(elementType);
    output.append(")) abort();\n");
    output.append("    void *storage = realloc(self->values, next * sizeof(");
    output.append(elementType);
    output.append("));\n");
    output.append("    if (storage == NULL) abort();\n");
    output.append("    self->values = (");
    output.append(elementType);
    output.append(" *)storage;\n");
    output.append("    self->capacity = next;\n  }\n");
    output.append("  self->values[self->length] = value;\n");
    output.append("  self->length += 1;\n");
    output.append("  self->buckets[slot] = self->length;\n");
    output.append("  return true;\n}\n\n");
    if (supportsRemove) {
      output.append("static __attribute__((unused)) Z_");
      output.append(optionName);
      output.append(" Z_");
      output.append(declaration.name);
      output.append("_remove(Z_");
      output.append(declaration.name);
      output.append(" *self, ");
      output.append(elementType);
      output.append(" value) {\n");
      output.append("  if (self->bucketCount == 0) return (Z_");
      output.append(optionName);
      output.append("){ .tag = Z_");
      output.append(optionName);
      output.append("Tag_none };\n");
      output.append("  size_t slot = Z_");
      output.append(declaration.name);
      output.append("_hash(value) & (self->bucketCount - 1);\n");
      output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
      output.append("    const size_t stored = self->buckets[slot];\n");
      output.append("    if (stored == 0) break;\n");
      output.append("    if (stored != SIZE_MAX && Z_");
      output.append(declaration.name);
      output.append("_equal(self->values[stored - 1], value)) {\n");
      output.append("      const size_t entry = stored - 1;\n");
      output.append("      const size_t last = self->length - 1;\n");
      output.append("      ");
      output.append(elementType);
      output.append(" removed = self->values[entry];\n");
      output.append("      self->buckets[slot] = SIZE_MAX;\n");
      output.append("      self->tombstones += 1;\n");
      output.append("      if (entry != last) {\n");
      output.append("        self->values[entry] = self->values[last];\n");
      output.append("        size_t movedSlot = Z_");
      output.append(declaration.name);
      output.append("_hash(self->values[entry]) & (self->bucketCount - 1);\n");
      output.append("        for (size_t movedProbe = 0; movedProbe < self->bucketCount; movedProbe += 1) {\n");
      output.append("          if (self->buckets[movedSlot] == self->length) { self->buckets[movedSlot] = entry + 1; break; }\n");
      output.append("          movedSlot = (movedSlot + 1) & (self->bucketCount - 1);\n");
      output.append("        }\n      }\n");
      output.append("      self->length = last;\n");
      output.append("      return (Z_");
      output.append(optionName);
      output.append("){ .tag = Z_");
      output.append(optionName);
      output.append("Tag_some, .payload.some = removed };\n");
      output.append("    }\n");
      output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
      output.append("  }\n");
      output.append("  return (Z_");
      output.append(optionName);
      output.append("){ .tag = Z_");
      output.append(optionName);
      output.append("Tag_none };\n}\n\n");
    }
    output.append("static __attribute__((unused)) bool Z_");
    output.append(declaration.name);
    output.append("_delete(Z_");
    output.append(declaration.name);
    output.append(" *self, ");
    output.append(elementType);
    output.append(" value) {\n");
    output.append("  if (self->bucketCount == 0) return false;\n");
    output.append("  size_t slot = Z_");
    output.append(declaration.name);
    output.append("_hash(value) & (self->bucketCount - 1);\n");
    output.append("  for (size_t probe = 0; probe < self->bucketCount; probe += 1) {\n");
    output.append("    const size_t stored = self->buckets[slot];\n");
    output.append("    if (stored == 0) return false;\n");
    output.append("    if (stored != SIZE_MAX && Z_");
    output.append(declaration.name);
    output.append("_equal(self->values[stored - 1], value)) {\n");
    output.append("      const size_t entry = stored - 1;\n");
    output.append("      const size_t last = self->length - 1;\n");
    if (loweredTypeNeedsDeinit(program, declaration.elementType)) {
      output.append("      Z_");
      output.append(declaration.elementType.name);
      output.append("_deinit(&self->values[entry]);\n");
    }
    output.append("      self->buckets[slot] = SIZE_MAX;\n");
    output.append("      self->tombstones += 1;\n");
    output.append("      if (entry != last) {\n");
    output.append("        self->values[entry] = self->values[last];\n");
    output.append("        size_t movedSlot = Z_");
    output.append(declaration.name);
    output.append("_hash(self->values[entry]) & (self->bucketCount - 1);\n");
    output.append("        for (size_t movedProbe = 0; movedProbe < self->bucketCount; movedProbe += 1) {\n");
    output.append("          if (self->buckets[movedSlot] == self->length) { self->buckets[movedSlot] = entry + 1; break; }\n");
    output.append("          movedSlot = (movedSlot + 1) & (self->bucketCount - 1);\n");
    output.append("        }\n      }\n");
    output.append("      self->length = last;\n      return true;\n    }\n");
    output.append("    slot = (slot + 1) & (self->bucketCount - 1);\n");
    output.append("  }\n  return false;\n}\n\n");
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_clear(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n");
    output.append("  while (self->length > 0) {\n    self->length -= 1;\n");
    if (loweredTypeNeedsDeinit(program, declaration.elementType)) {
      output.append("    Z_");
      output.append(declaration.elementType.name);
      output.append("_deinit(&self->values[self->length]);\n");
    }
    output.append("  }\n");
    output.append("  if (self->bucketCount > 0) memset(self->buckets, 0, self->bucketCount * sizeof(size_t));\n");
    output.append("  self->tombstones = 0;\n}\n\n");
  }
}

function appendArenaRuntime(inout output: TextBuffer): void {
  output.append("typedef void (*Z_ArenaCleanupFunction)(void *value);\n\n");
  output.append("typedef struct Z_ArenaPage {\n");
  output.append("  struct Z_ArenaPage *next;\n");
  output.append("  size_t used;\n");
  output.append("  size_t capacity;\n");
  output.append("  max_align_t alignment;\n");
  output.append("  unsigned char data[];\n");
  output.append("} Z_ArenaPage;\n\n");
  output.append("typedef struct Z_ArenaCleanup {\n");
  output.append("  struct Z_ArenaCleanup *next;\n");
  output.append("  void *value;\n");
  output.append("  Z_ArenaCleanupFunction function;\n");
  output.append("} Z_ArenaCleanup;\n\n");
  output.append("typedef struct Z_Arena {\n");
  output.append("  Z_ArenaPage *pages;\n");
  output.append("  Z_ArenaCleanup *cleanups;\n");
  output.append("  size_t initial_capacity;\n");
  output.append("} Z_Arena;\n\n");
  output.append("static inline __attribute__((unused)) Z_Arena z_stage1_arena_new(size_t initial_capacity) {\n");
  output.append("  return (Z_Arena){ NULL, NULL, initial_capacity };\n");
  output.append("}\n\n");
  output.append("static __attribute__((unused)) void *z_stage1_arena_allocate(Z_Arena *arena, size_t size, size_t alignment) {\n");
  output.append("  if (arena == NULL || alignment == 0 || (alignment & (alignment - 1)) != 0) abort();\n");
  output.append("  if (size == 0) size = 1;\n");
  output.append("  Z_ArenaPage *page = arena->pages;\n");
  output.append("  if (page != NULL) {\n");
  output.append("    if (page->used <= SIZE_MAX - (alignment - 1)) {\n");
  output.append("      const size_t aligned = (page->used + alignment - 1) & ~(alignment - 1);\n");
  output.append("      if (aligned <= page->capacity && size <= page->capacity - aligned) {\n");
  output.append("        void *result = page->data + aligned;\n");
  output.append("        page->used = aligned + size;\n");
  output.append("        return result;\n");
  output.append("      }\n");
  output.append("    }\n");
  output.append("  }\n");
  output.append("  size_t capacity = page == NULL && arena->initial_capacity > 0 ? arena->initial_capacity : 4096;\n");
  output.append("  if (capacity < size) capacity = size;\n");
  output.append("  if (capacity <= SIZE_MAX - (alignment - 1)) capacity += alignment - 1;\n");
  output.append("  else abort();\n");
  output.append("  if (capacity > SIZE_MAX - sizeof(Z_ArenaPage)) abort();\n");
  output.append("  Z_ArenaPage *created = (Z_ArenaPage *)malloc(sizeof(Z_ArenaPage) + capacity);\n");
  output.append("  if (created == NULL) abort();\n");
  output.append("  created->next = arena->pages;\n");
  output.append("  created->used = 0;\n");
  output.append("  created->capacity = capacity;\n");
  output.append("  arena->pages = created;\n");
  output.append("  return z_stage1_arena_allocate(arena, size, alignment);\n");
  output.append("}\n\n");
  output.append("static __attribute__((unused)) void z_stage1_arena_register_cleanup(Z_Arena *arena, void *value, Z_ArenaCleanupFunction function) {\n");
  output.append("  Z_ArenaCleanup *cleanup = (Z_ArenaCleanup *)z_stage1_arena_allocate(arena, sizeof(Z_ArenaCleanup), _Alignof(Z_ArenaCleanup));\n");
  output.append("  cleanup->next = arena->cleanups;\n");
  output.append("  cleanup->value = value;\n");
  output.append("  cleanup->function = function;\n");
  output.append("  arena->cleanups = cleanup;\n");
  output.append("}\n\n");
  output.append("static __attribute__((unused)) void z_stage1_arena_reset(Z_Arena *arena) {\n");
  output.append("  if (arena == NULL) return;\n");
  output.append("  Z_ArenaCleanup *cleanup = arena->cleanups;\n");
  output.append("  while (cleanup != NULL) {\n");
  output.append("    Z_ArenaCleanup *next = cleanup->next;\n");
  output.append("    cleanup->function(cleanup->value);\n");
  output.append("    cleanup = next;\n");
  output.append("  }\n");
  output.append("  Z_ArenaPage *page = arena->pages;\n");
  output.append("  while (page != NULL) {\n");
  output.append("    Z_ArenaPage *next = page->next;\n");
  output.append("    free(page);\n");
  output.append("    page = next;\n");
  output.append("  }\n");
  output.append("  arena->pages = NULL;\n");
  output.append("  arena->cleanups = NULL;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void Z_Arena_deinit(Z_Arena *arena) {\n");
  output.append("  z_stage1_arena_reset(arena);\n");
  output.append("}\n\n");
}

function appendArenaValueCleanup(
  inout output: TextBuffer,
  in type: LoweredType
): void throws String {
  if (type.kind == LoweredTypeKind.classType) {
    output.append("  Z_");
    output.append(type.name);
    output.append("_release(*((Z_");
    output.append(type.name);
    output.append(" **)value));\n");
    return;
  }
  output.append("  Z_");
  output.append(type.name);
  output.append("_deinit((");
  const nativeType = try cType(type);
  output.append(nativeType);
  output.append(" *)value);\n");
}

function arenaValueIdentity(in type: LoweredType): String throws String {
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
  if (type.kind == LoweredTypeKind.stringType) return "String";
  if (type.name.byteLength > 0) {
    return type.name.copyBytes(0, type.name.byteLength);
  }
  throw "native C emission cannot form an Arena value identity";
}

function appendArenaCreateHelpers(
  inout output: TextBuffer,
  in program: LoweredProgram
): void throws String {
  const valueTypes = try programArenaValueTypes(program);
  for (const type of valueTypes) {
    const nativeType = try cType(type);
    const identity = try arenaValueIdentity(type);
    const symbol = arenaTypeSymbol(identity);
    if (loweredTypeNeedsDeinit(program, type)) {
      output.append("static __attribute__((unused)) void z_stage1_arena_cleanup_");
      output.append(symbol);
      output.append("(void *value) {\n");
      try appendArenaValueCleanup(inout output, type);
      output.append("}\n\n");
    }
    output.append("static inline __attribute__((unused)) const ");
    output.append(nativeType);
    output.append(" *z_stage1_arena_create_");
    output.append(symbol);
    output.append("(Z_Arena *arena, ");
    output.append(nativeType);
    output.append(" value) {\n");
    output.append("  ");
    output.append(nativeType);
    output.append(" *stored = (");
    output.append(nativeType);
    output.append(" *)z_stage1_arena_allocate(arena, sizeof(");
    output.append(nativeType);
    output.append("), _Alignof(");
    output.append(nativeType);
    output.append("));\n");
    output.append("  *stored = value;\n");
    if (loweredTypeNeedsDeinit(program, type)) {
      output.append("  z_stage1_arena_register_cleanup(arena, stored, z_stage1_arena_cleanup_");
      output.append(symbol);
      output.append(");\n");
    }
    output.append("  return stored;\n");
    output.append("}\n\n");
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
  for (const aggregate of program.structs) {
    match (in aggregate.deinitializer) {
      some(deinitializer) => {
        for (const expression of deinitializer.expressions) {
          if (
            expression.kind == LoweredExpressionKind.localValue
            && expression.value == name
          ) return true;
        }
      }
      none => {}
    }
  }
  return false;
}

function programUsesMainDelay(in program: LoweredProgram): boolean {
  for (const declaration of program.functions) {
    if (
      declaration.mainDelaySegments.length > 0
      || declaration.mainDelayIfs.length > 0
      || declaration.mainDelayMatches.length > 0
      || declaration.mainDelayLoops.length > 0
    ) return true;
  }
  return false;
}

function programTestCount(in program: LoweredProgram): usize {
  let count: usize = 0;
  for (const declaration of program.functions) {
    if (declaration.testName.byteLength > 0) count = count + 1;
  }
  return count;
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
  const usesSleep = programUsesStandardCall(program, "time.sleep");
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
    output.append("static __attribute__((unused)) Z___z_Result_i32_String z_stage1_process_run(const Z_String *program, Z___z_Slice_String arguments) {\n");
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
  if (usesSleep) {
    output.append("static __attribute__((unused)) void z_stage1_sleep(size_t milliseconds) {\n#if defined(_WIN32)\n  while (milliseconds > UINT32_MAX) { Sleep(UINT32_MAX); milliseconds -= UINT32_MAX; }\n  Sleep((DWORD)milliseconds);\n#else\n  struct timespec remaining = { .tv_sec = (time_t)(milliseconds / 1000), .tv_nsec = (long)((milliseconds % 1000) * 1000000) };\n  while (nanosleep(&remaining, &remaining) == -1) { if (errno != EINTR) abort(); }\n#endif\n}\n\n");
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

function appendObjCMethodDeclaration(
  inout output: TextBuffer,
  in selector: String,
  in returnType: String,
  in parameterTypes: Array<String>
): void throws String {
  output.append("- (");
  if (returnType.byteLength > 0) output.append(returnType);
  else output.append("void");
  output.append(")");
  if (parameterTypes.length == 0) {
    output.append(selector);
    return;
  }
  let selectorStart: usize = 0;
  let parameterIndex: usize = 0;
  while (parameterIndex < parameterTypes.length) {
    let separator = selectorStart;
    while (
      separator < selector.byteLength
      && selector.byteAt(separator) != 58
    ) {
      separator = separator + 1;
    }
    if (separator >= selector.byteLength) {
      throw "native Objective-C adapter received a selector with too few parameters";
    }
    if (parameterIndex > 0) output.append(" ");
    output.append(selector.copyBytes(selectorStart, separator));
    output.append(":(");
    output.append(parameterTypes[parameterIndex]);
    output.append(")argument_");
    output.append(`${parameterIndex}`);
    selectorStart = separator + 1;
    parameterIndex = parameterIndex + 1;
  }
  if (selectorStart != selector.byteLength) {
    throw "native Objective-C adapter received a selector with too many parameters";
  }
}

function appendObjCMessageWithNames(
  inout output: TextBuffer,
  in receiver: String,
  in selector: String,
  in arguments: Array<String>
): void throws String {
  output.append("[");
  output.append(receiver);
  if (arguments.length == 0) {
    output.append(" ");
    output.append(selector);
    output.append("]");
    return;
  }
  let selectorStart: usize = 0;
  let argumentIndex: usize = 0;
  while (argumentIndex < arguments.length) {
    let separator = selectorStart;
    while (
      separator < selector.byteLength
      && selector.byteAt(separator) != 58
    ) {
      separator = separator + 1;
    }
    if (separator >= selector.byteLength) {
      throw "native Objective-C registration received a selector with too few parameters";
    }
    output.append(" ");
    output.append(selector.copyBytes(selectorStart, separator));
    output.append(":");
    output.append(arguments[argumentIndex]);
    selectorStart = separator + 1;
    argumentIndex = argumentIndex + 1;
  }
  if (selectorStart != selector.byteLength) {
    throw "native Objective-C registration received a selector with too many parameters";
  }
  output.append("]");
}

function appendObjCProtocolAdapter(
  inout output: TextBuffer,
  in adapter: LoweredObjCProtocolAdapter
): void throws String {
  output.append("@interface ");
  output.append(adapter.name);
  output.append(" : NSObject <");
  let protocolIndex: usize = 0;
  while (protocolIndex < adapter.protocolNativeNames.length) {
    if (protocolIndex > 0) output.append(", ");
    output.append(adapter.protocolNativeNames[protocolIndex]);
    protocolIndex = protocolIndex + 1;
  }
  output.append("> {\n@public\n  Z_");
  output.append(adapter.ownerType);
  output.append(" *_z_owner;\n}\n- (instancetype)initWithOwner:(Z_");
  output.append(adapter.ownerType);
  output.append(" *)owner;\n");
  for (const method of adapter.methods) {
    try appendObjCMethodDeclaration(
      inout output,
      method.selector,
      method.nativeReturnType,
      method.nativeParameterTypes
    );
    output.append(";\n");
  }
  output.append("@end\n\n@implementation ");
  output.append(adapter.name);
  output.append("\n- (instancetype)initWithOwner:(Z_");
  output.append(adapter.ownerType);
  output.append(" *)owner {\n  self = [super init];\n  if (self != nil) {\n    _z_owner = Z_");
  output.append(adapter.ownerType);
  output.append("_retain(owner);\n  }\n  return self;\n}\n\n");
  for (const method of adapter.methods) {
    try appendObjCMethodDeclaration(
      inout output,
      method.selector,
      method.nativeReturnType,
      method.nativeParameterTypes
    );
    output.append(" {\n  ");
    if (method.nativeReturnType != "void") output.append("return ");
    output.append(method.targetName);
    output.append("(_z_owner");
    let argumentIndex: usize = 0;
    while (argumentIndex < method.nativeParameterTypes.length) {
      output.append(", argument_");
      output.append(`${argumentIndex}`);
      argumentIndex = argumentIndex + 1;
    }
    output.append(");\n");
    if (method.nativeReturnType == "void") output.append("  return;\n");
    output.append("}\n\n");
  }
  output.append("- (void)dealloc {\n  Z_");
  output.append(adapter.ownerType);
  output.append("_release(_z_owner);\n}\n@end\n\n");
}

function containsUsize(in values: Array<usize>, candidate: usize): boolean {
  for (const value of values) {
    if (value == candidate) return true;
  }
  return false;
}

function appendObjCRegistration(
  inout output: TextBuffer,
  in registration: LoweredObjCRegistration
): void throws String {
  const className = `ZObjCRegistration_${registration.helperName}`;
  output.append("@interface ");
  output.append(className);
  output.append(" : ZObjCRegistration {\n@public\n  ");
  output.append(registration.receiverNativeType);
  output.append(" *_z_object;\n  ");
  output.append(registration.adapterName);
  output.append(" *_z_adapter;\n");
  let addIndex: usize = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (
      addIndex != registration.handlerParameter
      && containsUsize(registration.removeArgumentSources, addIndex)
    ) {
      output.append("  ");
      output.append(registration.addParameterNativeTypes[addIndex]);
      output.append(" _z_stored_");
      output.append(`${addIndex}`);
      output.append(";\n");
    }
    addIndex = addIndex + 1;
  }
  output.append("}\n- (instancetype)initWithObject:(");
  output.append(registration.receiverNativeType);
  output.append(" *)object owner:(Z_");
  output.append(registration.ownerType);
  output.append(" *)owner");
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (addIndex != registration.handlerParameter) {
      output.append(" argument_");
      output.append(`${addIndex}`);
      output.append(":(");
      output.append(registration.addParameterNativeTypes[addIndex]);
      output.append(")argument_");
      output.append(`${addIndex}`);
    }
    addIndex = addIndex + 1;
  }
  output.append(";\n@end\n\n@implementation ");
  output.append(className);
  output.append("\n- (instancetype)initWithObject:(");
  output.append(registration.receiverNativeType);
  output.append(" *)object owner:(Z_");
  output.append(registration.ownerType);
  output.append(" *)owner");
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (addIndex != registration.handlerParameter) {
      output.append(" argument_");
      output.append(`${addIndex}`);
      output.append(":(");
      output.append(registration.addParameterNativeTypes[addIndex]);
      output.append(")argument_");
      output.append(`${addIndex}`);
    }
    addIndex = addIndex + 1;
  }
  output.append(" {\n  self = [super init];\n  if (self != nil) {\n    _z_object = object;\n    _z_adapter = [[");
  output.append(registration.adapterName);
  output.append(" alloc] initWithOwner:owner];\n");
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (
      addIndex != registration.handlerParameter
      && containsUsize(registration.removeArgumentSources, addIndex)
    ) {
      output.append("    _z_stored_");
      output.append(`${addIndex}`);
      output.append(" = argument_");
      output.append(`${addIndex}`);
      output.append(";\n");
    }
    addIndex = addIndex + 1;
  }
  output.append("    (void)");
  let addArguments = Array<String>();
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (addIndex == registration.handlerParameter) {
      addArguments.push("_z_adapter");
    } else addArguments.push(`argument_${addIndex}`);
    addIndex = addIndex + 1;
  }
  try appendObjCMessageWithNames(
    inout output,
    "_z_object",
    registration.addSelector,
    addArguments
  );
  output.append(";\n  }\n  return self;\n}\n\n- (void)dealloc {\n  (void)");
  let removeArguments = Array<String>();
  for (const source of registration.removeArgumentSources) {
    removeArguments.push(`_z_stored_${source}`);
  }
  try appendObjCMessageWithNames(
    inout output,
    "_z_object",
    registration.removeSelector,
    removeArguments
  );
  output.append(";\n}\n@end\n\nstatic ZObjCRegistration *");
  output.append(registration.helperName);
  output.append("(");
  output.append(registration.receiverNativeType);
  output.append(" *object");
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    output.append(", ");
    if (addIndex == registration.handlerParameter) {
      output.append("Z_");
      output.append(registration.ownerType);
      output.append(" *owner");
    } else {
      output.append(registration.addParameterNativeTypes[addIndex]);
      output.append(" argument_");
      output.append(`${addIndex}`);
    }
    addIndex = addIndex + 1;
  }
  output.append(") {\n  return [[");
  output.append(className);
  output.append(" alloc] initWithObject:object owner:owner");
  addIndex = 0;
  while (addIndex < registration.addParameterNativeTypes.length) {
    if (addIndex != registration.handlerParameter) {
      output.append(" argument_");
      output.append(`${addIndex}`);
      output.append(":argument_");
      output.append(`${addIndex}`);
    }
    addIndex = addIndex + 1;
  }
  output.append("];\n}\n\n");
}

function emitLoweredC(
  in program: LoweredProgram,
  in embeddedRuntimeName: String,
  in runtimeInitializerName: String,
  runtimeInitializerRequiresMain: boolean
): String throws String {
  let output = TextBuffer();
  const testCount = programTestCount(program);
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
  const usesSleep = programUsesStandardCall(program, "time.sleep");
  const usesMainDelay = programUsesMainDelay(program);
  const mutexTypeNames = programMutexTypeNames(program);
  const usesMutex = mutexTypeNames.length > 0;
  const onceTypeNames = programOnceTypeNames(program);
  const usesOnce = onceTypeNames.length > 0;
  const taskTypeNames = programTaskTypeNames(program);
  const usesThreads = taskTypeNames.length > 0;
  const usesArena = programUsesArena(program);
  const usesExecutorBoundClasses = programUsesExecutorBoundClasses(program);
  let usesObjectiveCStringFromZ = false;
  let usesObjectiveCStringToZ = false;
  for (const declaration of program.functions) {
    for (const expression of declaration.expressions) {
      if (
        expression.kind == LoweredExpressionKind.objectiveCStringFromZ
      ) usesObjectiveCStringFromZ = true;
      if (
        expression.kind == LoweredExpressionKind.objectiveCStringToZ
      ) usesObjectiveCStringToZ = true;
    }
  }
  let usesCStringConversion =
    usesLock
    || usesReadBytes
    || usesReadText
    || usesWriteText
    || usesReplace
    || usesExists
    || usesIsDirectory
    || usesCreateDirectories
    || usesRealPath
    || usesProcessArguments
    || usesProcessRun;
  for (const declaration of program.functions) {
    if (declaration.nativeCExportName.byteLength == 0) continue;
    for (const parameter of declaration.parameters) {
      if (parameter.type.kind == LoweredTypeKind.stringType) {
        usesCStringConversion = true;
      }
    }
  }
  if (
    usesRealPath
    || usesCreateDirectories
    || usesProcessExecutablePath
    || usesSleep
    || usesMainDelay
  ) {
    output.append("#if !defined(_WIN32) && !defined(__APPLE__) && !defined(_POSIX_C_SOURCE)\n#define _POSIX_C_SOURCE 200809L\n#endif\n");
  }
  output.append("#include <stdbool.h>\n#include <stddef.h>\n#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n");
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
    || usesSleep
    || usesMainDelay
  ) {
    output.append("#include <errno.h>\n");
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
  if (usesMutex || usesOnce || usesThreads) {
    output.append("#if defined(_WIN32)\n#include <windows.h>\n#else\n#include <pthread.h>\n#endif\n");
  }
  if (usesSleep || usesMainDelay) {
    output.append("#include <time.h>\n");
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
  if (program.objectiveCRegistrations.length > 0) {
    output.append("@class ZObjCRegistration;\n\n");
  }
  if (
    embeddedRuntimeName.byteLength > 0
    || usesExecutorBoundClasses
  ) {
    appendForeignRuntimeEntrySupport(inout output);
  }
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
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_add_i64(int64_t left, int64_t right) {\n");
  output.append("  int64_t result;\n");
  output.append("  if (__builtin_add_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_subtract_i64(int64_t left, int64_t right) {\n");
  output.append("  int64_t result;\n");
  output.append("  if (__builtin_sub_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_multiply_i64(int64_t left, int64_t right) {\n");
  output.append("  int64_t result;\n");
  output.append("  if (__builtin_mul_overflow(left, right, &result)) abort();\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_divide_i64(int64_t left, int64_t right) {\n");
  output.append("  if (right == 0 || (left == INT64_MIN && right == -1)) abort();\n");
  output.append("  return left / right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_remainder_i64(int64_t left, int64_t right) {\n");
  output.append("  if (right == 0 || (left == INT64_MIN && right == -1)) abort();\n");
  output.append("  return left % right;\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) int64_t z_stage1_checked_negate_i64(int64_t value) {\n");
  output.append("  int64_t result;\n");
  output.append("  if (__builtin_sub_overflow((int64_t)0, value, &result)) abort();\n");
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
  output.append("static inline __attribute__((unused)) const char *z_stage1_string_cstring(Z_String value) {\n");
  output.append("  return value.data != NULL ? value.data : \"\";\n");
  output.append("}\n\n");
  output.append("typedef enum Z_TemplatePartKind {\n");
  output.append("  Z_TEMPLATE_STRING,\n");
  output.append("  Z_TEMPLATE_BOOLEAN,\n");
  output.append("  Z_TEMPLATE_I32,\n");
  output.append("  Z_TEMPLATE_I64,\n");
  output.append("  Z_TEMPLATE_U8,\n");
  output.append("  Z_TEMPLATE_U64,\n");
  output.append("  Z_TEMPLATE_USIZE,\n");
  output.append("  Z_TEMPLATE_F64\n");
  output.append("} Z_TemplatePartKind;\n\n");
  output.append("typedef struct Z_TemplatePart {\n");
  output.append("  Z_TemplatePartKind kind;\n");
  output.append("  union {\n");
  output.append("    Z_String string_value;\n");
  output.append("    bool boolean_value;\n");
  output.append("    int32_t i32_value;\n");
  output.append("    int64_t i64_value;\n");
  output.append("    uint8_t u8_value;\n");
  output.append("    uint64_t u64_value;\n");
  output.append("    size_t usize_value;\n");
  output.append("    double f64_value;\n");
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
  output.append("typedef struct Z_Hasher {\n  uint64_t state;\n} Z_Hasher;\n\n");
  output.append("static inline __attribute__((unused)) Z_Hasher z_hasher_new(void) {\n");
  output.append("  return (Z_Hasher){ .state = UINT64_C(14695981039346656037) };\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_hasher_add_bytes(Z_Hasher *self, const char *bytes, size_t length) {\n");
  output.append("  for (size_t index = 0; index < length; index += 1) {\n");
  output.append("    self->state ^= (unsigned char)bytes[index];\n");
  output.append("    self->state *= UINT64_C(1099511628211);\n");
  output.append("  }\n}\n\n");
  output.append("static inline __attribute__((unused)) void z_hasher_add_u64(Z_Hasher *self, uint64_t value) {\n");
  output.append("  unsigned char bytes[8];\n");
  output.append("  for (size_t index = 0; index < 8; index += 1) bytes[index] = (unsigned char)(value >> (index * 8));\n");
  output.append("  z_hasher_add_bytes(self, (const char *)bytes, 8);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) void z_hasher_add_string(Z_Hasher *self, Z_String value) {\n");
  output.append("  z_hasher_add_u64(self, (uint64_t)value.length);\n");
  output.append("  z_hasher_add_bytes(self, value.data != NULL ? value.data : \"\", value.length);\n");
  output.append("}\n\n");
  output.append("static inline __attribute__((unused)) size_t z_hasher_finish(Z_Hasher self) {\n");
  output.append("  uint64_t hash = self.state;\n");
  output.append("  hash ^= hash >> 33;\n");
  output.append("  hash *= UINT64_C(0xff51afd7ed558ccd);\n");
  output.append("  hash ^= hash >> 33;\n");
  output.append("  hash *= UINT64_C(0xc4ceb9fe1a85ec53);\n");
  output.append("  hash ^= hash >> 33;\n");
  output.append("  return (size_t)hash;\n");
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
  if (usesObjectiveCStringFromZ) {
    output.append("static inline __attribute__((unused)) NSString *z_stage1_nsstring_from_string(Z_String value) {\n");
    output.append("  const void *bytes = value.data != NULL ? (const void *)value.data : (const void *)\"\";\n");
    output.append("  NSString *result = [[NSString alloc] initWithBytes:bytes length:(unsigned long)value.length encoding:NSUTF8StringEncoding];\n");
    output.append("  if (result == (NSString *)0) abort();\n");
    output.append("  return result;\n");
    output.append("}\n\n");
  }
  if (usesObjectiveCStringToZ) {
    output.append("static inline __attribute__((unused)) Z_String z_stage1_string_from_nsstring(NSString *value) {\n");
    output.append("  if (value == (NSString *)0) abort();\n");
    output.append("  const unsigned long length = [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding];\n");
    output.append("  const char *bytes = [value UTF8String];\n");
    output.append("  if (bytes == NULL && length != 0) abort();\n");
    output.append("  Z_String result = { NULL, 0, 0 };\n");
    output.append("  z_string_append_bytes(&result, bytes != NULL ? bytes : \"\", (size_t)length);\n");
    output.append("  return result;\n");
    output.append("}\n\n");
  }
  if (usesCStringConversion) {
    output.append("static inline __attribute__((unused)) bool z_stage1_string_is_valid_utf8(const char *data, size_t length) {\n");
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
    output.append("static inline __attribute__((unused)) Z_String z_stage1_string_from_cstring(const char *value) {\n");
    output.append("  if (value == NULL) abort();\n");
    output.append("  const size_t length = strlen(value);\n");
    output.append("  if (!z_stage1_string_is_valid_utf8(value, length)) abort();\n");
    output.append("  Z_String result = { NULL, 0, 0 };\n");
    output.append("  z_string_append_bytes(&result, value, length);\n");
    output.append("  return result;\n");
    output.append("}\n\n");
  }
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
  output.append("static inline __attribute__((unused)) void z_text_buffer_append_code_point(Z_String *self, uint32_t code_point) {\n");
  output.append("  char bytes[4];\n");
  output.append("  size_t length = 0;\n");
  output.append("  if (code_point <= 0x7Fu) {\n");
  output.append("    bytes[0] = (char)code_point; length = 1;\n");
  output.append("  } else if (code_point <= 0x7FFu) {\n");
  output.append("    bytes[0] = (char)(0xC0u | (code_point >> 6));\n");
  output.append("    bytes[1] = (char)(0x80u | (code_point & 0x3Fu)); length = 2;\n");
  output.append("  } else if (code_point >= 0xD800u && code_point <= 0xDFFFu) {\n");
  output.append("    abort();\n");
  output.append("  } else if (code_point <= 0xFFFFu) {\n");
  output.append("    bytes[0] = (char)(0xE0u | (code_point >> 12));\n");
  output.append("    bytes[1] = (char)(0x80u | ((code_point >> 6) & 0x3Fu));\n");
  output.append("    bytes[2] = (char)(0x80u | (code_point & 0x3Fu)); length = 3;\n");
  output.append("  } else if (code_point <= 0x10FFFFu) {\n");
  output.append("    bytes[0] = (char)(0xF0u | (code_point >> 18));\n");
  output.append("    bytes[1] = (char)(0x80u | ((code_point >> 12) & 0x3Fu));\n");
  output.append("    bytes[2] = (char)(0x80u | ((code_point >> 6) & 0x3Fu));\n");
  output.append("    bytes[3] = (char)(0x80u | (code_point & 0x3Fu)); length = 4;\n");
  output.append("  } else {\n");
  output.append("    abort();\n");
  output.append("  }\n");
  output.append("  z_string_append_bytes(self, bytes, length);\n");
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
  output.append("    } else if (part.kind == Z_TEMPLATE_I64) {\n");
  output.append("      const int64_t value = part.value.i64_value;\n");
  output.append("      if (value < 0) {\n");
  output.append("        z_string_append_bytes(&result, \"-\", 1);\n");
  output.append("        z_string_append_unsigned_decimal(&result, (uint64_t)(-(value + 1)) + 1u);\n");
  output.append("      } else z_string_append_unsigned_decimal(&result, (uint64_t)value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_U8) {\n");
  output.append("      z_string_append_unsigned_decimal(&result, (uint64_t)part.value.u8_value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_U64) {\n");
  output.append("      z_string_append_unsigned_decimal(&result, part.value.u64_value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_USIZE) {\n");
  output.append("      z_string_append_unsigned_decimal(&result, (uint64_t)part.value.usize_value);\n");
  output.append("    } else if (part.kind == Z_TEMPLATE_F64) {\n");
  output.append("      char buffer[64];\n");
  output.append("      const int length = snprintf(buffer, sizeof(buffer), \"%.17g\", part.value.f64_value);\n");
  output.append("      if (length < 0) abort();\n");
  output.append("      z_string_append_bytes(&result, buffer, (size_t)length);\n");
  output.append("    }\n");
  output.append("  }\n");
  output.append("  return result;\n");
  output.append("}\n\n");
  output.append("typedef struct Z_FsLock {\n  intptr_t native;\n} Z_FsLock;\n\n");
  if (usesArena) appendArenaRuntime(inout output);
  for (const resource of program.foreignResources) {
    if (!resource.handle) continue;
    output.append("typedef ");
    output.append(resource.nativeTypeName);
    output.append(" ");
    output.append(resource.storageName);
    output.append(";\n");
  }
  if (program.foreignResources.length > 0) output.append("\n");
  appendWeakRuntime(inout output);
  try appendTypeDefinitions(inout output, program);
  try appendCopyHelpers(inout output, program);
  for (const declaration of program.enums) {
    let nullablePayload = Option<LoweredType>.none;
    let hasNone = false;
    for (const variant of declaration.variants) {
      if (variant.name == "none") hasNone = true;
      if (variant.name != "some") continue;
      match (in variant.payload) {
        some(type) => {
          if (type.kind == LoweredTypeKind.foreignHandleType) {
            nullablePayload = Option.some(LoweredType({
              kind: type.kind,
              name: type.name.copyBytes(0, type.name.byteLength),
            }));
          }
        }
        none => {}
      }
    }
    match (in nullablePayload) {
      some(payload) => {
        if (!hasNone) continue;
        const payloadType = try cType(payload);
        output.append("static inline __attribute__((unused)) Z_");
        output.append(declaration.name);
        output.append(" Z_");
        output.append(declaration.name);
        output.append("_from_nullable(");
        output.append(payloadType);
        if (isNicheViewOption(declaration.name)) {
          output.append(" value) {\n  return value;\n}\n\n");
          continue;
        }
        output.append(" value) {\n  if (value == NULL) return (Z_");
        output.append(declaration.name);
        output.append("){ .tag = Z_");
        output.append(declaration.name);
        output.append("Tag_none };\n  return (Z_");
        output.append(declaration.name);
        output.append("){ .tag = Z_");
        output.append(declaration.name);
        output.append("Tag_some, .payload.some = value };\n}\n\n");
      }
      none => {}
    }
  }
  for (const resource of program.foreignResources) {
    if (resource.releaseName.byteLength == 0) continue;
    output.append("static inline __attribute__((unused)) void Z_");
    output.append(resource.storageName);
    output.append("_deinit(");
    output.append(resource.storageName);
    output.append(" const *self) {\n");
    if (resource.handle) output.append("  if (self == NULL || *self == NULL) return;\n");
    output.append("  ");
    output.append(resource.releaseName);
    output.append("(*self);\n}\n\n");
  }
  for (const declaration of program.fixedArrays) {
    if (!loweredTypeNeedsDeinit(program, declaration.elementType)) continue;
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self);\n");
  }
  for (const aggregate of program.structs) {
    if (aggregate.needsDeinit && !aggregate.referenceType) {
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
  output.append("\n");
  try appendThreadTaskRuntime(inout output, program);
  try appendModuleConstants(inout output, program);
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
      if (
        parameterIndex < foreign.parameterModes.length
        && (
          foreign.parameterModes[parameterIndex] == "in"
          || foreign.parameterModes[parameterIndex] == "inout"
          || foreign.parameterModes[parameterIndex] == "out"
        )
        && foreign.parameterTypes[parameterIndex].kind
          != LoweredTypeKind.cstringType
      ) output.append(" *");
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
    if (foreign.arguments.length > 0) {
      let argumentIndex: usize = 0;
      while (argumentIndex < foreign.arguments.length) {
        if (argumentIndex > 0) output.append(", ");
        if (foreign.arguments[argumentIndex].kind == "fixed") {
          output.append(foreign.arguments[argumentIndex].value);
        } else {
          output.append("parameter_");
          output.append(`${foreign.arguments[argumentIndex].source}`);
        }
        argumentIndex = argumentIndex + 1;
      }
    } else {
      parameterIndex = 0;
      while (parameterIndex < foreign.parameterTypes.length) {
        if (parameterIndex > 0) output.append(", ");
        output.append("parameter_");
        output.append(`${parameterIndex}`);
        parameterIndex = parameterIndex + 1;
      }
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
  try appendClassAndOnceRuntime(inout output, program);
  for (const declaration of program.slices) {
    const elementType = try cType(declaration.elementType);
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" const *Z_");
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
    output.append(" const *Z_");
    output.append(declaration.name);
    output.append("_at_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  return &((");
    output.append(elementType);
    output.append(" *)self->data)[index];\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) Z_");
    output.append(declaration.name);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_slice_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  void *data = self->data == NULL ? NULL : &((");
    output.append(elementType);
    output.append(" *)self->data)[index];\n");
    output.append("  return (Z_");
    output.append(declaration.name);
    output.append("){ data, self->length - index };\n");
    output.append("}\n\n");
  }
  for (const declaration of program.fixedArrays) {
    const elementType = try cType(declaration.elementType);
    output.append("static inline __attribute__((unused)) Z_");
    output.append(declaration.sliceName);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_slice_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  return (Z_");
    output.append(declaration.sliceName);
    output.append("){ (void *)&(self->data[index]), ");
    output.append(declaration.length);
    output.append(" - index };\n}\n\n");
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" const *Z_");
    output.append(declaration.name);
    output.append("_at(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  if (index >= ");
    output.append(declaration.length);
    output.append(") abort();\n  return &(self->data[index]);\n}\n\n");
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" const *Z_");
    output.append(declaration.name);
    output.append("_at_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  return &(self->data[index]);\n}\n\n");
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" *Z_");
    output.append(declaration.name);
    output.append("_at_mut(Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  if (index >= ");
    output.append(declaration.length);
    output.append(") abort();\n  return &(self->data[index]);\n}\n\n");
  }
  for (const declaration of program.arrays) {
    const elementType = try cType(declaration.elementType);
    output.append("static inline __attribute__((unused)) Z_");
    output.append(declaration.name);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_from(const void *values, size_t length) {\n");
    output.append("  if (length == 0) return (Z_");
    output.append(declaration.name);
    output.append("){ NULL, 0, 0 };\n");
    output.append("  if (length > SIZE_MAX / sizeof(");
    output.append(elementType);
    output.append(")) abort();\n");
    output.append("  void *storage = malloc(length * sizeof(");
    output.append(elementType);
    output.append("));\n");
    output.append("  if (storage == NULL) abort();\n");
    output.append("  memcpy(storage, values, length * sizeof(");
    output.append(elementType);
    output.append("));\n");
    output.append("  return (Z_");
    output.append(declaration.name);
    output.append("){ storage, length, length };\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) Z_");
    output.append(declaration.sliceName);
    output.append(" Z_");
    output.append(declaration.name);
    output.append("_slice_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
    output.append("  void *data = self->data == NULL ? NULL : &((");
    output.append(elementType);
    output.append(" *)self->data)[index];\n");
    output.append("  return (Z_");
    output.append(declaration.sliceName);
    output.append("){ data, self->length - index };\n");
    output.append("}\n\n");
    output.append("static inline __attribute__((unused)) ");
    output.append(elementType);
    output.append(" const *Z_");
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
    output.append(" const *Z_");
    output.append(declaration.name);
    output.append("_at_unchecked(const Z_");
    output.append(declaration.name);
    output.append(" *self, size_t index) {\n");
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
  for (const declaration of program.functions) {
    try appendFunctionSignature(
      inout output,
      declaration,
      usesProcessArguments
    );
    output.append(";\n");
  }
  if (program.functions.length > 0) output.append("\n");
  try appendMapRuntime(inout output, program);
  try appendSetRuntime(inout output, program);
  appendAsyncCallableRuntime(inout output, program);
  try appendCallableHelpers(inout output, program);
  try appendAsyncCallableAwaitHelpers(inout output, program);
  try appendPersistentAsyncParentHelpers(inout output, program);
  if (program.objectiveCRegistrations.length > 0) {
    output.append("@interface ZObjCRegistration : NSObject\n@end\n\n@implementation ZObjCRegistration\n@end\n\n");
    for (const adapter of program.objectiveCProtocolAdapters) {
      try appendObjCProtocolAdapter(inout output, adapter);
    }
    for (const registration of program.objectiveCRegistrations) {
      try appendObjCRegistration(inout output, registration);
    }
  }
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
  if (usesArena) try appendArenaCreateHelpers(inout output, program);
  try appendThreadMainCallHelpers(inout output, program);
  try appendThreadSpawnHelpers(inout output, program);
  try appendMutexWithLockHelpers(inout output, program);
  for (const declaration of program.fixedArrays) {
    if (!loweredTypeNeedsDeinit(program, declaration.elementType)) continue;
    output.append("static __attribute__((unused)) void Z_");
    output.append(declaration.name);
    output.append("_deinit(Z_");
    output.append(declaration.name);
    output.append(" *self) {\n  if (self == NULL) return;\n");
    output.append("  size_t index = ");
    output.append(declaration.length);
    output.append(";\n  while (index > 0) {\n    index -= 1;\n    Z_");
    output.append(declaration.elementType.name);
    if (declaration.elementType.kind == LoweredTypeKind.classType) {
      output.append("_release(self->data[index]);\n");
    } else {
      output.append("_deinit(&self->data[index]);\n");
    }
    output.append("  }\n}\n\n");
  }
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
      if (declaration.elementType.kind == LoweredTypeKind.classType) {
        output.append("_release(items[self->length]);\n");
      } else {
        output.append("_deinit(&items[self->length]);\n");
      }
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
    if (loweredTypeNeedsDeinit(program, declaration.keyType)) {
      output.append("    Z_");
      output.append(declaration.keyType.name);
      if (declaration.keyType.kind == LoweredTypeKind.classType) {
        output.append("_release(self->entries[self->length].key);\n");
      } else {
        output.append("_deinit(&self->entries[self->length].key);\n");
      }
    }
    if (loweredTypeNeedsDeinit(program, declaration.valueType)) {
      output.append("    Z_");
      output.append(declaration.valueType.name);
      if (declaration.valueType.kind == LoweredTypeKind.classType) {
        output.append("_release(self->entries[self->length].value);\n");
      } else {
        output.append("_deinit(&self->entries[self->length].value);\n");
      }
    }
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
    if (loweredTypeNeedsDeinit(program, declaration.elementType)) {
      output.append("    Z_");
      output.append(declaration.elementType.name);
      if (declaration.elementType.kind == LoweredTypeKind.classType) {
        output.append("_release(self->values[self->length]);\n");
      } else {
        output.append("_deinit(&self->values[self->length]);\n");
      }
    }
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
              if (type.kind == LoweredTypeKind.classType) {
                output.append("_release(self->payload.");
                output.append(variant.name);
                output.append(");\n      break;\n");
              } else {
                output.append("_deinit(&self->payload.");
                output.append(variant.name);
                output.append(");\n      break;\n");
              }
            } else output.append(" break;\n");
          }
          none => output.append(" break;\n");
        }
      }
      output.append("  }\n}\n\n");
    }
  }
  for (const aggregate of program.structs) {
    if (aggregate.needsDeinit && !aggregate.referenceType) {
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
        if (aggregate.fields[fieldIndex].borrowedView) continue;
        if (aggregate.fields[fieldIndex].type.name == "Arena") continue;
        if (
          aggregate.fields[fieldIndex].type.kind
            == LoweredTypeKind.foreignObjCType
        ) {
          output.append("  self->");
          output.append(aggregate.fields[fieldIndex].name);
          output.append(" = nil;\n");
          continue;
        }
        if (loweredTypeNeedsDeinit(program, aggregate.fields[fieldIndex].type)) {
          output.append("  Z_");
          output.append(aggregate.fields[fieldIndex].type.name);
          if (
            aggregate.fields[fieldIndex].type.kind
              == LoweredTypeKind.classType
          ) {
            output.append("_release(self->");
            output.append(aggregate.fields[fieldIndex].name);
            output.append(");\n");
          } else {
            output.append("_deinit(&self->");
            output.append(aggregate.fields[fieldIndex].name);
            output.append(");\n");
          }
        }
      }
      fieldIndex = aggregate.fields.length;
      while (fieldIndex > 0) {
        fieldIndex = fieldIndex - 1;
        if (aggregate.fields[fieldIndex].type.name != "Arena") continue;
        if (loweredTypeNeedsDeinit(program, aggregate.fields[fieldIndex].type)) {
          output.append("  Z_Arena_deinit(&self->");
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
      program,
      declaration,
      usesProcessArguments
    );
  }
  try appendTestRunner(
    inout output,
    program,
    usesProcessArguments
  );
  let hasNativeCExports = false;
  for (const declaration of program.functions) {
    if (declaration.nativeCExportName.byteLength > 0) {
      hasNativeCExports = true;
    }
  }
  if (hasNativeCExports) {
    if (embeddedRuntimeName.byteLength > 0) {
      try appendEmbeddedRuntimeDefinitions(
        inout output,
        program,
        embeddedRuntimeName,
        runtimeInitializerName,
        runtimeInitializerRequiresMain
      );
    }
    output.append("#if defined(__cplusplus)\nextern \"C\" {\n#endif\n\n");
    for (const declaration of program.functions) {
      if (declaration.nativeCExportName.byteLength == 0) continue;
      try appendNativeCExportDefinition(
        inout output,
        program,
        declaration,
        embeddedRuntimeName
      );
    }
    output.append("#if defined(__cplusplus)\n}\n#endif\n");
  }
  return output.finish();
}

function emitLoweredCHeader(
  in program: LoweredProgram,
  in embeddedRuntimeName: String,
  runtimeInitializerRequiresMain: boolean
): String throws String {
  let output = TextBuffer();
  output.append("#pragma once\n\n");
  output.append("#include <stdbool.h>\n#include <stdint.h>\n\n");
  output.append("#ifndef Z_API\n#define Z_API\n#endif\n\n");
  if (embeddedRuntimeName.byteLength > 0) {
    const requiresExecutorRuntime = runtimeInitializerRequiresMain
      || programUsesExecutorBoundClasses(program);
    appendEmbeddedRuntimeTypes(
      inout output,
      embeddedRuntimeName,
      requiresExecutorRuntime,
      requiresExecutorRuntime
    );
  }
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
  if (embeddedRuntimeName.byteLength > 0) {
    appendEmbeddedRuntimeSignatures(inout output, embeddedRuntimeName);
    output.append("\n");
  }
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
  const outcome = attempt emitLoweredC(lowered, "", "", false);
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}

export function emitModulesC(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  const outcome = attempt emitLoweredC(lowered, "", "", false);
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}

export function emitLibraryModulesC(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in targetName: String,
  in runtimeInitializerName: String,
  runtimeInitializerRequiresMain: boolean
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  const outcome = attempt emitLoweredC(
    lowered,
    targetName,
    runtimeInitializerName,
    runtimeInitializerRequiresMain
  );
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}

export function emitTestModulesC(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  const lowered = try lowerTestModules(parsed, graph);
  if (programTestCount(lowered) == 0) {
    throw "no tests were found in this module or its imports";
  }
  const outcome = attempt emitLoweredC(lowered, "", "", false);
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}

export function emitModulesCHeader(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  const outcome = attempt emitLoweredCHeader(lowered, "", false);
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}

export function emitLibraryModulesCHeader(
  in parsed: Array<ParsedModule>,
  in graph: ModuleGraph,
  in targetName: String,
  runtimeInitializerRequiresMain: boolean
): String throws String {
  const lowered = try lowerModules(parsed, graph);
  const outcome = attempt emitLoweredCHeader(
    lowered,
    targetName,
    runtimeInitializerRequiresMain
  );
  return match (outcome) {
    success(emitted) => emitted;
    failure(message) => throw internalBackendFailure("C emission", message);
  };
}
